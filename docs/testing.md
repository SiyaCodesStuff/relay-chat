# Coverage and browser tests

`npm run test:coverage` builds shared types and runs coverage for each workspace.
API coverage includes both unit tests and the real Postgres/Redis integration suite;
set `DATABASE_URL_TEST` to a dedicated, migrated test database and `REDIS_URL` to
your local Redis in your existing environment. The command does not start containers.
Each workspace independently requires **80% lines**, including unexecuted source
files. It writes HTML and JSON reports to that workspace's ignored `coverage/`
directory and a complete filename table and three weakest files to
[coverage.md](coverage.md). Thresholds apply to workspace totals, not individual files.

Install Chromium once with `npx playwright install chromium`, then run
`npm run test:e2e`. On Linux, Playwright may also require system browser libraries
(`npx playwright install-deps chromium`). Start Postgres and Redis yourself first.
The command builds the application and starts temporary API and web preview
servers on loopback ephemeral ports against `DATABASE_URL_TEST` and `REDIS_URL`.
It refuses to use the configured development database as its test database.

The browser test seeds two unique database users using test-only Argon2 costs,
logs in **once per user through the real API**, and reuses each login's
`storageState` in its own independent browser context. State remains in memory:
no session cookies or passwords are written to authentication fixtures, traces,
videos or screenshots. Requests keep the normal Origin, CSRF, session and rate
limit checks. Test rows and namespaced Redis keys are removed on completion.

Both users join a public channel in the UI and exchange live messages. Typing
must appear in the other context. One context goes offline while the other sends
two messages; on reconnect, both histories must contain all four messages once,
in order. The harness also closes that user's real Engine.IO transport because
Chromium's offline emulation can retain an established websocket. It does not
inject events or mock the network, database, Redis or browser socket client.

E2E is deliberately opt-in: it is not called by `npm test` or any default CI job.
There are no Playwright retries or increased test/expect timeouts.
