# Socket integration timeout investigation

The reported target timeout was reproduced before changing repository code. The reproduction waited for the **initial `channel:sync` acknowledgement / `onSynced`**, before the first send or disconnect. It was not waiting for a reconnect event.

In loaded baseline trial 4, request/socket instrumentation recorded:

| Operation                                           | Duration or timestamp (Unix milliseconds)                           |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| Owner registration, including real Argon2 hashing   | 2,208 ms                                                            |
| Reader registration, including real Argon2 hashing  | 1,260 ms                                                            |
| Channel creation                                    | 195 ms                                                              |
| Membership join                                     | 116 ms                                                              |
| Initial `channel:sync` emitted                      | 1792847156464                                                       |
| Vitest reports target timeout                       | Between sync emission and acknowledgement; test duration 5,076.9 ms |
| Initial `channel:sync` acknowledged successfully    | 1792847156898                                                       |
| Subsequent reconnect sync acknowledged successfully | 1792847158074                                                       |
| Subsequent repeat sync acknowledged successfully    | 1792847158215                                                       |

The two registration requests alone consumed 3,468 ms of the default five-second **test-body** budget. Server setup, channel setup, handshakes, and the initial sync consumed the remainder under CPU contention. The acknowledgement eventually arrived and the protocol proceeded successfully. This identifies a fixture/setup budget overrun in the reproduced failure; it does not establish what happened in the original historical run without that run's trace.

The unchanged whole-file trials also exposed a separate shutdown race: asynchronous presence setup/disconnect work continued after Socket.IO's HTTP close callback, while `closeAdapter()` had already quit the publisher. This produced `Error: The client is closed` from `RedisAdapter.broadcast` through `emitPresence`, sometimes after every assertion passed. Process exit status, rather than only the JSON report's `success` field, is required to count these failures.

The original baseline log and per-run reports are under `/tmp/relay-socket-investigation/before/`. The specific target reproduction is `load-04.log`; teardown rejections also occur in trials 3, 7, 9, 13, and 14. Trial 15 had multiple further timeouts under load and is included in the totals.

## Implemented reconnect protocol, in order

1. A transport disconnect increments the reliable client's generation, marks it unsynced, clears in-flight send acknowledgement timers, and requeues eligible unacknowledged sends. Replies from a stale generation cannot apply. A deliberate `socket.disconnect()` requires `socket.connect()`; an unexpected transport close uses Socket.IO Manager's reconnect backoff.
2. The server authenticates the new socket's Origin, Redis session, and current database user/ban state. Its connection setup reads current channel memberships and **awaits joining all corresponding rooms**, then registers presence. Event handlers are registered immediately, but packet middleware waits for this setup promise before processing client events.
3. On `connect`, the reliable client marks itself unsynced, buffers `message:new` events, and sends `channel:sync` per tracked channel with `after` (the confirmed history checkpoint) and `lastSeen` (the highest observed live/history ID). These can differ: live Redis Pub/Sub delivery may arrive out of order, so using only the highest live ID could skip an earlier message. Starting from the confirmed checkpoint deliberately fetches overlap.
4. For each `channel:sync`, the server applies rate/payload checks, rechecks membership, and **awaits joining the channel room before querying PostgreSQL**. The query selects non-deleted messages with ID strictly greater than `after`, ordered ascending, with a 101-row lookahead. It returns up to 100 messages and `hasMore`; the client fetches successive pages using the last returned ID. The server uses `after`, not `lastSeen`, for the query.
5. The client validates and applies ordered history pages, advancing its confirmed checkpoint. After all channels/pages complete, it sorts buffered live messages by ID and merges them with history. Stored message ID and `(userId, clientMessageId)` suppress duplicates. Only history advances the confirmed checkpoint; live messages and send acknowledgements update the observed ID without advancing that safe checkpoint. `getMessages()` returns the merged collection sorted by ID.
6. The client marks itself synced, calls `onSynced`, and flushes queued sends. Each logical send retains its original client message ID; the server's persisted idempotency key prevents duplicate storage.

The production join-before-fetch order was already correct and is preserved. No ordering bug was invented to explain the timeout.

## Changes and deterministic evidence

- Real server startup and the two authenticated users now belong to `beforeEach` fixture setup. The existing hook timeout and five-second test timeout are unchanged; the test body still performs channel setup, handshakes, initial sync, live delivery, offline catch-up, repeat sync, and automatic transport reconnection.
- Production `createChatSocket` and `SocketProvider` accept `reconnectionDelay`, `reconnectionDelayMax`, and `randomizationFactor`. Production defaults remain Socket.IO's defaults. Integration tests inject 1 ms / 5 ms / zero jitter and wait for `reconnect_attempt` followed by `onSynced` after closing the underlying transport.
- Acknowledgement deadlines were already injectable; the catch-up tests use 1,000 ms. Named event waits reject with the awaited event/stage after 2,000 ms. The 150 ms Redis-expiry sleep is replaced by polling for the actual offline transition. Server-side disconnect events act as barriers where later assertions depend on disconnect processing.
- `io.close()` now waits for tracked setup, heartbeat, typing-expiry, and disconnect cleanup before invoking its callback/resolving. Callers can then close adapter Redis clients without racing those operations.
- The catch-up regression explicitly removes the receiver's automatically joined room, pauses the next room join, and sends a message during that pause. After joining it sends an overlapping live/history message, pauses history acknowledgement delivery, and sends a message after the snapshot. All four messages must arrive exactly once. Gates and a predicate for the specific post-snapshot message control ordering; sleeps do not. The regression uses a paused fake acknowledgement clock so intentionally gated delivery cannot expire a client timeout. Named event waits and the unchanged five-second test-body deadline retain real clocks.
- A separate shutdown regression pauses `presence.remove`, observes ordinary HTTP closure, drains its promise continuations through an event-loop barrier, and verifies socket shutdown remains pending until removal is released.

Mutation checks temporarily changed the production source and restored it automatically:

| Mutation                                 | Result                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| Move sync query before awaited room join | Regression fails: `committed while room join is paused` is missing (3 of 4 messages) |
| Remove cleanup drain from shutdown       | Regression fails: shutdown completed while presence removal was paused               |

The original source already used the safe join order, so the first mutation demonstrates the regression that the test guards against, rather than a historical production-order change. Mutation logs are `/tmp/relay-socket-investigation/mutation-fetch-before-join.log` and `mutation-close-before-cleanup.log`.

## Stability validation

Each trial invokes Vitest on the **entire** `apps/api/test/socket.integration.test.ts` file in a fresh process. There are no retries, timeout increases, or test skips in the stability runs. Before each idle/load group, `docker compose restart postgres redis` is followed by `docker compose up -d --wait postgres redis`. Loaded trials keep six separate Node CPU workers busy on an eight-CPU host. Both baseline and final trials use external socket/request instrumentation, without recording cookies or payloads.

| Group                           | Target before | Target after | Whole file before | Whole file after |
| ------------------------------- | ------------- | ------------ | ----------------- | ---------------- |
| Idle, 30 invocations            | 30/30         | 30/30        | 30/30             | 30/30            |
| Six CPU workers, 15 invocations | 14/15         | 15/15        | 8/15              | 15/15            |

All 315 test executions in the final seven-test file passed, with no unhandled errors or cleanup failures. The final runner exited successfully and awaited termination of its CPU workers. Final raw logs and JSON reports are under `/tmp/relay-socket-verified-97bOA1/`. [Recorded per-run results and verified source hashes](./socket-stability-results.json) preserve the before/after counts and timings in the repository. The final result uses a fresh complete 30+15 batch; interrupted/development trials are excluded.

Both ordering mutations failed with the intended assertions after the fake acknowledgement clock was added, and the restored implementation passed the whole file. Shared tests (5), API smoke tests (2), and web tests (28), TypeScript checks, ESLint, and formatting checks passed. No test or hook timeout configuration was increased.

Reproduce the stability procedure from the repository root:

```sh
node scripts/socket-stability.mjs --label=verification --idle=30 --loaded=15 --workers=6
```

The runner prints its temporary artifact directory, retains a verbose log and JSON report per whole-file invocation, updates `summary.json` after every trial, and reports a failing exit status if any invocation fails. CPU workers are terminated at the end of the load group and on interruption. The optional external diagnostic preload used in this investigation is not required to use the runner.
