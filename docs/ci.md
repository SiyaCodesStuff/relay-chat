# CI and image publishing

## Automatic CI

`.github/workflows/ci.yml` runs for pull requests targeting `main`, pushes to
`main`, and pushes of tags matching `v*`. It uses `.nvmrc` (Node 24, bundled npm 11) and `npm ci --ignore-scripts`; it never approves install scripts. Existing
native prebuilds are used, as in the Dockerfiles. Checkout credentials are not
persisted. Tests have read-only repository permission and no registry token.

The quality job runs these existing commands:

- `npm run format:check`
- `npm run typecheck`
- `npm run lint` plus linting of `scripts/ci`
- `npm test` (workspace unit tests and Docker configuration tests)
- `node --test scripts/ci/*.test.mjs scripts/load/*.test.mjs`
- `npm run db:migrate:test --workspace=@relay-chat/api`
- `npm run test:integration`
- `npm run test:coverage`
- `npm run build`
- `node scripts/docker/compose.mjs verify --static`

Drizzle-generated metadata and the generated `docs/coverage.md` report retain
their generators' formatting and are ignored only by Prettier. Coverage source
selection and the existing 80% line thresholds are unchanged. Coverage tables
appear in the job summary; HTML/JSON reports and the table are retained as an
artifact for seven days. No external coverage service is used.

`npm audit --omit=dev --audit-level=high` blocks CI. A separate full `npm audit`
step is explicitly non-blocking but its findings remain in the log and step
status. Neither command changes the lockfile. See `SECURITY.md` for the known
Drizzle development-tool advisories; reporting them does not waive production
audit failures.

### Integration services

The automatic job uses the same digest-pinned PostgreSQL 17 and Redis 8 images
as Compose, with health checks and ports bound to runner loopback only. PostgreSQL
starts with a passwordless bootstrap connection solely on this disposable runner.
`scripts/ci/environment.mjs integration` creates a random-password, non-superuser
`relay_ci` role and its own `relay_chat_ci_test` database. The next step changes
host authentication to SCRAM and reloads PostgreSQL **before any tests run**.
Migrations connect as `relay_ci`, which owns only the dedicated CI database.
There are no developer connection strings or repository database secrets.
Generated passwords, session secrets and credential-bearing URLs are masked
before being exported through GitHub's environment file. Existing random Redis
key prefixes and fixture cleanup are preserved.

## Manual Docker E2E

`.github/workflows/e2e.yml` runs only through `workflow_dispatch`; browser tests
are not added to automatic CI. After this workflow exists on the default branch,
open **Actions → Manual Docker E2E → Run workflow** and select the desired ref.
The equivalent GitHub CLI command is:

```bash
gh workflow run e2e.yml --ref main
```

The workflow installs Chromium and its Linux dependencies, builds the application
and the existing Prompt 14 images, then starts `compose.production.yml` with
`up -d --wait`. A unique `relay-ci-<run>-<attempt>` Compose project gets fresh
volumes, generated credentials and `relay_chat_ci_e2e`. The existing verifier
checks migration exit status, both healthy replicas, headers, HTTP and WebSocket
routing for both local origins before Playwright starts.

On native Linux runners the fixture connects directly to the private bridge IPs
of PostgreSQL and Redis, discovered with narrow Docker inspections. No database
or Redis ports are added to production Compose. Browser traffic goes through
`http://localhost:8080` and Nginx; APIs remain production-mode with their original
cookie, Origin, CSRF, rate-limit and Argon2 controls.

`E2E_BASE_URL` enables an explicitly guarded CI-only mode in the existing fixture.
The fixture creates unique database users, logs in once per user per test and
keeps each user's storageState in a separate browser context in memory. A Redis
adapter observer waits for actual channel room membership across both replicas.
The disconnect scenario closes the browser's forwarded WebSocket transport,
without a server namespace disconnect that would disable automatic reconnect.
The original messaging, typing, reconnect, XSS and HttpOnly assertions remain.
The fixture closes clients and removes its users, channel and sessions. The
workflow's `always()` cleanup additionally removes only that run's Compose
containers, networks and volumes, including after an earlier failure.

Local `npm run test:e2e` keeps its existing in-process API/Vite fixture mode; do
not set the CI-only environment variables locally. No browser storageState,
traces, videos, cookies or database dumps are uploaded.

## Version-tag image publishing

Only the automatic workflow's `publish` job has `packages: write`. It runs after
the quality job succeeds, only on a pushed `v*` tag, using `GITHUB_TOKEN` via
Docker's password-stdin login. It builds the existing Dockerfiles and publishes:

- `ghcr.io/<lowercase-owner>/relay-chat-api:<exact-git-tag>`
- `ghcr.io/<lowercase-owner>/relay-chat-web:<exact-git-tag>`

For example, `v1.2.3` produces two distinct packages tagged `v1.2.3`; there is no
mutable `latest` alias. OCI labels include repository source, version and a
package description. PRs and ordinary branches never publish. Ref values are
validated and passed as process arguments, not interpolated shell code. Registry
login is removed on exit. Tag runs do not cancel active publication.

Set the optional repository Actions variable `PUBLIC_ORIGIN` to the exact HTTPS
browser origin before publishing a deployable web image. Without it, the web
image retains Prompt 14's local-loopback default. CSP is baked into the web image;
see [Docker deployment notes](docker.md) before changing origins.

The first GHCR publication may create private packages. An owner may need to open
each package's settings and change visibility to **public**, and confirm repository
Actions access to the package. No PAT or registry credentials need to be stored.
No tag or GitHub release is created by these workflows. Release creation belongs
to the next phase.

## Action pins and diagnosing failures

All used actions are pinned to commit SHAs verified against the official GitHub
repository tag API when this change was prepared:

| Action                  | Version | Commit                                     |
| ----------------------- | ------- | ------------------------------------------ |
| actions/checkout        | v4.2.2  | `11bd71901bbe5b1630ceea73d27597364c9af683` |
| actions/setup-node      | v4.4.0  | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| actions/upload-artifact | v4.6.2  | `ea165f8d65b6e75b540449e92b4886f43607fa02` |

Concurrency cancels obsolete branch/PR checks but does not cancel tag releases.
The manual workflow queues another run for the same ref instead of interrupting
cleanup. Actions must be enabled in repository settings; configure branch
protection to require **Quality, integration and coverage** if desired.

Inspect the first failed named step. A database authentication failure points to
the generated-credential/bootstrap step; a migration failure points to the
isolated database or committed migration files. Coverage failures keep their
original thresholds; inspect the per-file table instead of excluding files.
Docker startup failures should be diagnosed from container state and migration
exit status using the safe commands in `docs/docker.md`; avoid expanded Compose
config, unrestricted inspection or logs that might contain credentials. Browser
failures retain their assertions and have no retries. A GHCR denial usually means
package access/visibility or repository Actions policy needs attention.

Workflow YAML and expressions can be checked locally with `actionlint` if
available. Static checks and local tests do not prove GitHub execution: confirm
both workflows in Actions after pushing. GHCR publication remains unverified
until a future authorized version-tag push.
