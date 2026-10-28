# Socket rejection and error coverage

The baseline is the saved API coverage report before this change, including the
existing real-stack integration tests. Original source line numbers below refer
to that baseline; the scheduler and error fixes shift the current line numbers.

| File                           |     Lines before |    Lines after | Branches before |   Branches after |
| ------------------------------ | ---------------: | -------------: | --------------: | ---------------: |
| apps/api/src/socket.ts         | 74.77% (166/222) | 100% (230/230) | 69.53% (89/128) | 92.42% (122/132) |
| apps/api/src/socket-adapter.ts |       75% (9/12) |   100% (12/12) |      100% (1/1) |       100% (5/5) |

Verification: `npm run typecheck && npm run lint && npm test` passed (93 default
tests). `npm run test:integration` passed all 88 integration tests, including 58
new cases. API coverage ran all 116 API unit/integration tests with the original
80% line threshold. Both files also have 100% function coverage.

| Original uncovered range                                | What it does                                                                                                         | Verification added                                                                                                            |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| socket.ts 57–67                                         | Carries a message ID forward when the clock-generated ID is behind the database; rejects exhaustion                  | Injected high-water metadata and insert faults inside a real PostgreSQL transaction; no globally invalid IDs are written      |
| 122                                                     | Denies an upgrade if the Redis handshake limiter fails                                                               | Exact client transport rejection; no connection, message or delivery                                                          |
| 132                                                     | Removes a rejected background task from the shutdown tracking set                                                    | Setup failure and shutdown completion                                                                                         |
| 205–227                                                 | Prevents overlapping heartbeats, renews leases, disconnects revoked sessions, sweeps expired users, sanitizes errors | Explicit scheduler ticks, a deferred Redis read, revoked session, expired Redis score and Redis fault                         |
| 250–251                                                 | Rechecks Origin in Socket.IO after Engine.IO's upgrade check                                                         | Header mutation at the downstream Engine.IO boundary; a normal client cannot change this header after upgrade                 |
| 264–265                                                 | Denies a valid session for a missing or banned database user                                                         | Real deleted/banned users                                                                                                     |
| 270                                                     | Fails handshake authentication closed on Redis/database errors                                                       | One-operation Redis and database faults                                                                                       |
| 295                                                     | Logs a failed disconnect presence cleanup without secrets                                                            | Scoped remove fault; verifies a TTL still bounds the remaining lease                                                          |
| 344–345                                                 | Rejects unsupported event names                                                                                      | Exact INVALID_PAYLOAD ack and error event                                                                                     |
| 349–350                                                 | Reports a packet middleware error and disconnects                                                                    | Redis read/limiter failures with and without an ack                                                                           |
| 373–374                                                 | Rejects malformed sync input                                                                                         | Malformed/null cursor payloads                                                                                                |
| 377–378                                                 | Rejects sync without current membership                                                                              | Outsider and mid-session removal                                                                                              |
| 400                                                     | Reports sync room/history failures                                                                                   | Room-join and database query faults                                                                                           |
| 409–410                                                 | Rejects malformed room joins                                                                                         | Null and invalid channel IDs                                                                                                  |
| 413–414                                                 | Rejects room joins without membership                                                                                | Outsider and mid-session removal                                                                                              |
| 419                                                     | Reports room-join failures                                                                                           | Injected room operation failure after real authentication                                                                     |
| 432–433                                                 | Rejects sends without membership                                                                                     | Outsider and mid-session removal                                                                                              |
| 492                                                     | Reports send failures                                                                                                | Transaction failure, allocation failure, concurrent hard deletion during idempotent lookup, and delivery failure after commit |
| 499–500                                                 | Rejects malformed typing input                                                                                       | Both start and stop events                                                                                                    |
| 503–504                                                 | Rejects typing without membership                                                                                    | Both start and stop events                                                                                                    |
| 508–509                                                 | Cancels an explicit typing stop                                                                                      | Real start/stop events and controlled expiry                                                                                  |
| 535                                                     | Reports typing-stop relay errors                                                                                     | Database fault after packet authentication; start relay errors are tested too                                                 |
| socket-adapter.ts 18–20                                 | Destroys duplicate Redis clients and preserves startup errors                                                        | Publisher connect, subscriber connect, and adapter installation failures                                                      |
| socket-adapter.ts 12–13 (uncovered callback bodies)     | Sanitizes Redis client error events                                                                                  | Error events on both real connected duplicate clients                                                                         |
| socket-adapter.ts 22–23 (already covered; strengthened) | Closes both duplicate clients                                                                                        | Success and rejected QUIT; both clients must close                                                                            |

## Assertions and isolation

`test/socket-security.integration.test.ts` uses real Socket.IO clients, PostgreSQL,
Redis and the Redis adapter. Users and sessions are database/Redis fixtures, not
registration requests. A unique per-file Redis namespace contains unique
per-test namespaces. Every socket, server, database pool and duplicate client is
closed. Fixtures delete only their owned rows and Redis keys.

Negative request tests compare the complete ack and error envelopes, unchanged
message/membership rows, and zero additional message/typing delivery. A marker
sent on the observer's **same websocket** drains preceding outbound frames before
negative assertions. There are no sleeps, retries, skipped tests or increased
timeouts. The existing 2-second event bound and Vitest's default deadline remain.
Heartbeat/typing scheduling is injectable; production delays remain unchanged.

Faults are operation-scoped: database transactions/queries, Redis commands, room
operations and adapter clients. Corrupt allocation metadata is injected inside a
real transaction, followed by an insert fault/rollback, so a parallel test file's
global message-ID high-water mark cannot be poisoned. Successful idempotent
retries still use actual database conflict handling.

Transport errors retain request headers internally. Tests project only safe
scalar error fields before assertions, so a failure report cannot dump cookies.

## Necessary distinctions

- A malformed application payload receives `INVALID_PAYLOAD`. A frame over the
  16 KiB transport bound never reaches an application handler: the client receives
  `transport close`, `websocket connection closed`, and WebSocket code **1009**;
  there is no application ack. No message is written or broadcast.
- Rejected upgrades produce client `TransportError`, `websocket error`, HTTP
  **400** in this installed Engine.IO version. A missing/invalid session, missing
  user, banned user or authentication backend failure rejected by Socket.IO
  produces `Unauthorized socket connection.`. These pre-connection rejections
  have no application ack or shared SocketError code; tests assert the exact
  existing wire contract rather than inventing an application code.
- A fault **after commit** must leave the original message durable. That test
  expects one row, `INTERNAL_ERROR`, no live broadcast, then the identical stored
  ack on retry and one message in sync. Requiring zero rows here would contradict
  persist-before-broadcast and lose acknowledged retry identity.
- The concurrent-hard-delete case deliberately deletes the original fixture
  between conflict handling and lookup. It verifies `INTERNAL_ERROR`, no second
  write, and no second broadcast.
- Adapter startup/close and background maintenance have no active client request
  to acknowledge. Tests assert the original infrastructure error or sanitized
  log, resource closure, and no unexpected message write/delivery. Normal Redis
  rate counters, session TTLs and presence leases are expected server-side state;
  “no persistence” refers to rejected chat writes and membership mutations.

## Error-path fixes

Packet middleware now acknowledges `INTERNAL_ERROR` before disconnecting, instead
of forcing the reliability client to wait for an ack timeout. Failed connection
setup emits the same typed error before closing. Failed adapter startup checks
`isOpen` before destroying each duplicate, so cleanup of an unopened subscriber
cannot replace the original connection error with `ClientClosedError`.

## Remaining defensive branches

No coverage exclusions or lower thresholds are used. The two nullish fallbacks
inside ID carry allocation cannot be taken: the loop indexes within `split()`'s
bounds, and `digit < 31` keeps `alphabet[digit + 1]` within its bounds (including
the invalid-character case of -1). Propose replacing these guarded array reads
with `previous.charAt(index)` and `alphabet.charAt(digit + 1)` in a separate cleanup,
rather than fabricating impossible arrays or excluding the code.

Other residual branches are harmless stop-without-active-typing, optional/default
configuration, and fallbacks for framework-owned connection/header state. A real
TCP connection has a remote address; an already authenticated connection retains
its handshake cookie. Exercising absent metadata would require internal mutation
rather than a network request. Keep these defensive guards until the boundary
contract is explicitly tightened; they are not untested rejection/error handlers.
