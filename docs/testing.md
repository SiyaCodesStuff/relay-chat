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
Create the dedicated browser-test database once (do not drop or reuse an existing
development/integration database):

```bash
docker compose exec postgres sh -c 'createdb -U "$POSTGRES_USER" relay_chat_e2e'
```

The command builds the application and starts temporary API and web preview
servers on loopback ephemeral ports against `relay_chat_e2e` and `REDIS_URL`.
By default it reuses the connection credentials/server from `DATABASE_URL_TEST`
and replaces only the database name with `relay_chat_e2e`. For a different
dedicated database, supply `DATABASE_URL_E2E` in your shell; no `.env` edit is
needed. The fixture applies existing migrations, but never creates or drops a
database. It rejects development/integration database names, including encoded
names and host aliases, administrative databases, and URL query options that
could override the database selection. Connection strings are never printed.

Each browser test seeds two unique database users using test-only Argon2 costs,
logs in **once per user through the real API**, and reuses each login's
`storageState` in its own independent browser context. State remains in memory:
no session cookies or passwords are written to authentication fixtures, traces,
videos or screenshots. Requests keep the normal Origin, CSRF, session and rate
limit checks. Every test gets fresh users, sessions, channel, contexts and Redis
prefix; authentication is never shared between tests. Contexts, sockets, preview
servers, Redis clients and database pools close even after a setup/assertion
failure. Only fixture-owned rows and namespaced Redis keys are removed.

The independently runnable live-message test has both users join a public
channel in the UI and exchange live messages. Typing must appear in the other
context. The separate reconnect test takes one context offline while the other
sends two messages; on reconnect, both histories must contain all four messages once,
in order. The harness also closes that user's real Engine.IO transport because
Chromium's offline emulation can retain an established websocket. It does not
inject events or mock the network, database, Redis or browser socket client.

`e2e/security.spec.ts` sends the literal message payloads
`<img src=x onerror=alert(1)>`, `<script>alert(1)</script>` and
`[x](javascript:alert(1))` from Alice to Bob. It checks exact message text and
absence of injected images, alert scripts, JavaScript links and dialogs, then
repeats the checks after Bob reloads the persisted history. A separate test checks
an HTML-markup display name in its owner's welcome heading before/after reload
(message authors currently display generic member labels). Both contexts' session
cookies must be distinct, HttpOnly and SameSite=Lax, and absent from
`document.cookie` before/after reload; assertions never print their values.

Run all tests, one file, or one named scenario:

```bash
npm run test:e2e
npm run test:e2e -- e2e/security.spec.ts
npm run test:e2e -- e2e/chat.spec.ts --grep 'reconnect catches up'
```

For five consecutive executions, stop on any failure rather than retrying it:

```bash
(
  set -e
  for run in 1 2 3 4 5; do
    printf 'E2E run %s/5\n' "$run"
    npm run test:e2e
  done
)
```

E2E is deliberately opt-in: it is not called by `npm test` or any default CI job.
There are no Playwright retries or increased test/expect timeouts.
