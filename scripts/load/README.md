# Authenticated Socket.IO load test

This is an opt-in **local** k6 benchmark against two separate API processes,
real PostgreSQL and Redis, and the production Socket.IO Redis adapter. It does
not run in `npm test` or CI, start containers, change application code, disable
security controls, or install npm dependencies.

## Run

Use WSL's Node 24 (`nvm use`), install the normal workspace dependencies, and
build the shared workspace once:

```bash
nvm use
npm run build --workspace=@relay-chat/shared
```

Install a Linux [k6 release](https://github.com/grafana/k6/releases) outside this
repository; verify its archive against the release's SHA-256 checksums. This
benchmark was developed with **k6 2.3.0**. Set `K6_BIN` to its executable if it is
not on your WSL PATH. k6 is a standalone Go executable, not an npm package.

Start your existing PostgreSQL 17 and Redis containers yourself. Your existing
environment must supply `DATABASE_URL_TEST` and `REDIS_URL`. The runner loads
the root `.env` without editing it, rejects the configured development database,
applies existing migrations to the test database, and creates disposable users,
private channels, memberships and server-side sessions. No registration/login
requests or password hashing are part of the measured workload. Authentication
still uses the real session cookie, Redis lookup, Origin check and per-event
authorization. Test user passwords are disabled.

Single stated load: **8 concurrent users, 1 message/user/s for 20 seconds,
up to 8 members per channel; p95 delivery <500 ms and zero lost deliveries**:

```bash
K6_BIN=k6 node --env-file-if-exists=.env --import tsx scripts/load/run.mjs
```

Increasing load with unchanged rate, duration and thresholds:

```bash
K6_BIN=k6 LOAD_STEPS=2,4,8,16,32,64 LOAD_CONTINUE=1 \
  node --env-file-if-exists=.env --import tsx scripts/load/run.mjs
```

By default the campaign stops at the first failed stage and exits nonzero.
`LOAD_CONTINUE=1` proceeds to the **next, higher** load after a failure. It never
repeats a failed stage, suppresses its result or makes the campaign exit zero.
Do not run typechecking, tests or other intentional CPU load during measurements.

| Variable            | Default                            | Meaning                                                                 |
| ------------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| `LOAD_CONNECTIONS`  | `8`                                | Even concurrent connection count; 2–4096                                |
| `LOAD_STEPS`        | one `LOAD_CONNECTIONS` value       | Strictly increasing, comma-separated connection counts                  |
| `LOAD_RATE`         | `1`                                | Offered messages/second **per connection**; 0.1–2                       |
| `LOAD_SECONDS`      | `20`                               | Fixed send window, 5–600 seconds                                        |
| `LOAD_CHANNEL_SIZE` | `8`                                | Even membership group size; 2–512; final group may be smaller           |
| `LOAD_P95_MS`       | `500`                              | Predeclared latency SLO in milliseconds; keep fixed when comparing runs |
| `LOAD_OUTPUT`       | `scripts/load/results/latest.json` | Credential-free campaign report                                         |
| `K6_BIN`            | `k6`                               | Path to the installed Linux k6 executable                               |

The readiness deadline is 20 seconds, with a common start one second after all
clients join and a fixed 5-second drain after the send window. There are no
connection, message or test retries. Changing the duration or SLO defines a new
load, not a passing rerun of a failed load.

## Workload and authentication

Each k6 VU holds one websocket, alternating between API A and API B. Every group
has users on both instances. The workload implements the text-only default
namespace subset of the [Socket.IO protocol](https://socket.io/docs/v4/socket-io-protocol/)
over Engine.IO v4: CONNECT, EVENT, ACK and ping/pong. It uses native
[`k6/websockets`](https://grafana.com/docs/k6/latest/javascript-api/k6-websockets/websocket/),
not a plain echo socket or a mocked Socket.IO server.

Each VU retrieves its fixture through a loopback-only, run-key-protected control
server. The cookie is delivered as an HttpOnly `Set-Cookie` header and kept in
memory; cookies, hashes, connection strings and control keys are never written
to result files or logged. The control server is a test fixture, not an API route.
All owned rows, session keys, clients and API processes are cleaned up afterward.

The real handshake limit is 30/source-IP/minute. The runner uses k6's
[local IP option](https://grafana.com/docs/k6/latest/using-k6/k6-options/reference/#local-ips)
to assign each VU an actual distinct `127.43.x.y` source address within Linux's
loopback network. It does not forge forwarded headers or disable limits. This
models independent users; it does **not** measure a many-user NAT with one IP.
The configured rate also stays below the per-socket and per-user event limits.

Every client must receive its successful `channel:join` ack before the shared
barrier opens. Send times are staggered deterministically over each rate period.
Every message has a unique `(run, sender, sequence)` client ID and a send timestamp
in its plain-text body. All expected recipients, including the sender, maintain
their own exact receipt ledger. Duplicates cannot compensate for a missing ID.

## Read results

k6 prints p95 delivery latency, cross-instance p95, lost deliveries and send
error rate. The runner prints each stage's exit status and database reconciliation.
It also saves the raw k6 metrics under ignored `results/`, and the campaign JSON
at `LOAD_OUTPUT`. See the checked-in measurement files and results below for the
actual local runs. A nonzero exit is the expected result when a threshold fails.

| Metric                                                      | Interpretation / threshold                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `delivery_latency_ms`, `cross_instance_delivery_latency_ms` | Actual send invocation to `message:new` receipt on the k6 host, not ack or database `created_at`; both p95 < configured SLO     |
| `lost_deliveries`                                           | Sum of each recipient's exact missing identities at the drain deadline; must be 0                                               |
| `received_deliveries`                                       | Must equal the planned per-channel fanout, including self-delivery                                                              |
| `duplicate_deliveries`                                      | Repeated server ID or client ID at a recipient; must be 0                                                                       |
| `send_error_rate`                                           | Failed, unsent or unacknowledged planned sends / all planned sends; must be 0                                                   |
| `protocol_errors`                                           | Transport, handshake, join, server error, malformed packet or invalid ack; must be 0                                            |
| `connected_clients`, `joined_clients`                       | Both must equal N; failed setup cannot produce a false zero-loss pass                                                           |
| `submitted_messages`, `acked_messages`                      | Both must equal N × floor(rate × send seconds)                                                                                  |
| `generator_lag_ms`                                          | Difference between planned send time and actual invocation; p95 <100 ms, otherwise the load generator did not hold its schedule |
| `reconciled`                                                | All N terminal reports agree, and every planned client ID exists exactly once in PostgreSQL                                     |

Loss is counted per **expected delivery**, not just per write. Losing one broadcast
to an eight-member channel can produce eight lost deliveries. A rejected send is
both a send error and a missing planned delivery; it is not silently removed from
the denominator. The parent independently checks persisted identities after k6.
Delivered p95 alone cannot pass a run that loses its slowest messages.

Latency uses one machine's clock. This is a local benchmark, not a distributed
clock-synchronization solution or an internet RTT measurement.

## Bottleneck evidence

During the send/drain window, the harness collects:

- Per API: process CPU (100% = one CPU core), event-loop utilization/delay and
  PostgreSQL pool waiters. Only the harness entry point is instrumented.
- PostgreSQL: actual client query/transaction durations, separate advisory lock,
  INSERT and COMMIT timing, plus `pg_stat_activity` active/wait categories sampled
  every 250 ms. No SQL text or parameters are stored.
- Redis: server CPU deltas, command throughput, read durations and ping latency.
- PostgreSQL/Redis container CPU from read-only `docker stats`, when available.
- Generator CPU and send-scheduling lag. k6 runs on the same host as the APIs.

Query `avgMs` is weighted by query count. `p95OfIntervalP95Ms` is the p95 of
one-second interval p95s, **not** the exact percentile of all individual SQL calls.
End-to-end delivery p95 is k6's actual receipt distribution. Initialization and
fixture cleanup are excluded from API/query samples. Redis CPU delta spans the
barrier through the end of the drain, including the one-second start lead-in.
Other users of the same PostgreSQL/Redis services can affect server-wide CPU.

Interpret CPU/loop saturation together, not from latency alone. High advisory
waits with low API loop utilization point to serialized PostgreSQL writes; high
Redis CPU and RTT suggest Redis; high API CPU and loop utilization suggest API
work. High generator lag or host memory pressure makes server-capacity attribution
inconclusive. No production optimization is implemented by this benchmark.

## Tests

```bash
node --test --test-reporter=tap scripts/load/*.test.mjs
npx eslint scripts/load
npm run typecheck && npm run lint && npm test
```

The pure tests cover partial channel groups, exact loss/duplicate accounting,
invalid identities, protocol framing and malformed frames, rate bounds, and
instrumentation transparency for both callback queries and async transactions.

## Measured results — 28 October 2026

The controlled campaign in [increasing-load.json](increasing-load.json) used k6
2.3.0, Node 24.22.0, an Intel i5-10210U / eight logical CPUs, two API processes,
the existing Postgres 17/Redis Docker services, and the generator on the same WSL2
host. Each user offered **1 message/s for 20 seconds**; each channel had at most
eight members, split across both APIs. Every stage retained the same **500 ms p95**
and **zero-loss** thresholds, plus the fixed five-second drain.

| Concurrent users | Offered messages/s | Delivery p95 ms | Cross-instance p95 ms | Received / expected | Send errors | Lost | Result        |
| ---------------: | -----------------: | --------------: | --------------------: | ------------------: | ----------: | ---: | ------------- |
|                2 |                  2 |          133.55 |                133.55 |             80 / 80 |          0% |    0 | PASS          |
|                4 |                  4 |          143.60 |                143.95 |           320 / 320 |          0% |    0 | PASS          |
|                8 |                  8 |          110.00 |                111.00 |         1280 / 1280 |          0% |    0 | PASS          |
|               16 |                 16 |          248.15 |                256.45 |         2560 / 2560 |          0% |    0 | PASS          |
|               32 |                 32 |          206.25 |                212.05 |         5120 / 5120 |          0% |    0 | PASS          |
|               64 |                 64 |         5141.05 |               5143.00 |       10240 / 10240 |          0% |    0 | FAIL: latency |

There were **zero duplicates**, every planned send was acknowledged, and all
persisted client IDs reconciled exactly at every stage. The 64-user campaign exit
was nonzero because delivery latency failed; it is not reported as a passing run
merely because nothing was lost.

An earlier exploratory eight-user run also failed latency: **812.20 ms p95**, zero
loss/errors. It is retained in [measurements.json](measurements.json), not discarded.
The later controlled eight-user result was 110 ms without an application change.
This variance, the short window and the shared laptop mean these results are
observations, not a production capacity guarantee. The initial functional pilot
also caught and corrected a benchmark-only transaction instrumentation bug;
return-value/error-propagation tests now protect that instrumentation.

### First bottleneck and one proposed fix

The first failed stage in the controlled series was **64 concurrent users /
64 sends per second**, and the evidence points to **PostgreSQL write
serialization at the global advisory lock**, not Redis or API event-loop
saturation:

- **1662 of 1730 active database wait samples (96.1%)** were `Lock:advisory`.
  Mean advisory-lock acquisition was **326 ms**, compared with **4.04 ms** for
  INSERT and **9.70 ms** for COMMIT. Mean transaction duration, including pool
  acquisition, reached **894 ms**.
- Pool waiters reached interval p95s of **132 and 136** across the two APIs.
  Per-API p95 CPU was **76.2% / 72.5% of one core**, and p95 event-loop utilization
  was **0.683 / 0.653**. Interval p95 loop delay was **21.6 / 26.0 ms**, far below
  five-second delivery latency.
- Redis mean server CPU was **14.0% of one core** and ping p95 **12.9 ms**.
  Generator scheduling lag p95 was only **4.38 ms**. Neither explains the growing
  PostgreSQL queue. PostgreSQL container CPU p95 was 88.0% of one core.

**Proposed fix, not implemented:** replace the single global transaction advisory
lock in `apps/api/src/socket.ts` with a transaction lock derived from the channel
ID, and scope the latest-ID query to that same channel using the existing
`(channel_id, id DESC)` index. This lets unrelated channels commit concurrently
while retaining commit ordering within each channel, the unit used by history
and reconnect cursors. Keep persist-before-broadcast and `(user_id,
client_message_id)` uniqueness. A global sequence alone is insufficient: sequence
allocation order can differ from commit order and make cursor catch-up skip a
late commit. Validate the per-channel design with ordering, idempotency and
reconnect integration tests before applying it.

At 64 users there were eight independent channels, all contending on the same
current lock. The proposed change targets that observed queue directly; it does
not promise to eliminate single-channel disk/COMMIT stalls, which also explain
some low-load variability. No fix or production configuration change is included.
