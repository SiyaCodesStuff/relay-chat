# Integration fixture setup

Password hashing remains Argon2id. `ARGON2_MEMORY_COST` (KiB), `ARGON2_TIME_COST`,
and `ARGON2_PARALLELISM` default to 65536, 3, and 4, respectively: the previous
argon2 library defaults. These are also hard minimums in production and development.
Only `NODE_ENV=test` may go below them. Startup validates integers, upper bounds
(1048576 KiB, 10 iterations, 16 lanes), and memory of at least eight times the lane
count. Direct app-factory options pass the same validation. Invalid configuration
errors contain field names or rules, never supplied values.

Auth integration apps explicitly select test costs of 1024 KiB, one iteration,
and one lane. Production defaults never depend on the test runner or fixtures.
Registration and password verification still use the real Argon2 implementation.

`apps/api/test/helpers/auth-fixture.ts` creates isolated users in Postgres and
256-bit sessions through the real Redis session store, then seeds the test agent's
cookie jar. The jar accepts a replacement cookie during login rotation. Users
that never need password login get a deliberately unusable password hash; login
fixtures explicitly request a real test-cost hash. The helper rejects use outside
`NODE_ENV=test`. Callers track user IDs and Redis prefixes for existing cleanup.
Only auth tests call the registration endpoint; channel and socket tests exercise
their real authorization paths using direct fixtures.

## Measurement method

Fixture timers encompass the complete user/session setup operation. Aggregate
fixture durations can overlap across Vitest workers and are not suite wall time.
The baseline was one complete integration run before changing costs or fixtures.
It passed all 22 tests in 29.663 seconds wall time. Eight channel fixtures took
5572.332 ms (696.541 ms/user), and twelve socket fixtures took 5214.901 ms
(434.575 ms/user): 10787.233 ms aggregate. Four auth registration fixtures took
2228.677 ms (557.169 ms each).

Run the complete integration matrix against already-running test Postgres and Redis:

```sh
node scripts/integration-matrix.mjs --idle=10 --load=5 --workers=6
```

This executes independent complete suites sequentially, without retries. Loaded
runs use six continuously busy worker threads on the measured eight-CPU host.
No timeout, test skip, service restart, or container lifecycle change is involved.
The runner records numeric timings, test counts, and failing test names only; it
does not persist raw test output that could include credentials or query values.
The default metrics destination is `/tmp/relay-integration-after.json`.

## Results

All 15 complete suites passed: 10 idle and 5 under CPU load, each with 22 tests
(330 test executions total), zero failures and zero skips. Typecheck and lint
passed; the regular workspace test command passed 50 unit/UI tests.

| Measurement                          | Before (one idle run) | After (10 idle runs, mean) | After (5 loaded runs, mean) |
| ------------------------------------ | --------------------: | -------------------------: | --------------------------: |
| Channel user/session, ms each        |               696.541 |                     25.300 |                      46.836 |
| Socket user/session, ms each         |               434.575 |                     16.555 |                      32.707 |
| All 20 non-auth fixtures, ms per run |             10787.233 |                    401.060 |                     767.171 |
| Real auth registration, ms each      |               557.169 |                    169.613 |                     652.724 |
| Complete suite wall time, seconds    |                29.663 |                      9.885 |                      43.852 |

Idle direct fixture setup decreased by 96.3%. Real registration timing includes
HTTP, database, and Redis work in addition to hashing. The baseline registered
four auth users; after the change it registers one and directly creates the other
three auth users. Auth fixture creation needing login still hashes a real password.

| Mode     | Run | Wall time (s) | Direct fixture setup (ms) | Result    |
| -------- | --- | ------------: | ------------------------: | --------- |
| idle     | 1   |        17.574 |                   478.546 | 22 passed |
| idle     | 2   |        11.938 |                   864.743 | 22 passed |
| idle     | 3   |         7.433 |                   215.060 | 22 passed |
| idle     | 4   |         9.076 |                  1012.784 | 22 passed |
| idle     | 5   |         9.269 |                   290.789 | 22 passed |
| idle     | 6   |         8.987 |                   191.887 | 22 passed |
| idle     | 7   |         8.166 |                   189.889 | 22 passed |
| idle     | 8   |         9.557 |                   192.418 | 22 passed |
| idle     | 9   |         7.893 |                   285.088 | 22 passed |
| idle     | 10  |         8.952 |                   289.394 | 22 passed |
| cpu-load | 1   |        47.439 |                   834.028 | 22 passed |
| cpu-load | 2   |        48.926 |                   739.613 | 22 passed |
| cpu-load | 3   |        45.307 |                   724.921 | 22 passed |
| cpu-load | 4   |        44.205 |                   835.363 | 22 passed |
| cpu-load | 5   |        33.384 |                   701.930 | 22 passed |

Exact sanitized timings and CPU consumption are in [test-setup-results.json](./test-setup-results.json).
A single baseline is indicative rather than a statistically controlled benchmark;
host load and database/Redis scheduling can affect suite wall time. No loaded
baseline was collected, so loaded suite wall time has no before/after comparison.
