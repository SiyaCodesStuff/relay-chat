# Docker deployment

This is the standalone `compose.production.yml` stack. The existing
`docker-compose.yml` remains the local development Postgres/Redis setup. Do not
combine the files as overlays. The production project has its own named volumes.

## Prerequisites and configuration

Use WSL2, Docker Desktop with Compose v2/BuildKit, and Node 24 (`nvm use`). The
repository's existing npm dependencies are needed for the host-side tests and
verification script. No additional packages or install-script approvals are
required. Build shared exports once for the verification script:

```bash
npm run build --workspace=@relay-chat/shared
```

Supply these through your existing local environment or shell; do not commit
secret values. The commands below read the existing `.env` without modifying it.

| Variable                                                       | Requirement                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `POSTGRES_USER`                                                | Required database role                                                                     |
| `POSTGRES_PASSWORD`                                            | Required strong database password                                                          |
| `SESSION_SECRET`                                               | Required, at least 32 characters; retain existing API validation                           |
| `POSTGRES_DB`                                                  | Database name, defaults to `relay_chat`                                                    |
| `PUBLIC_ORIGIN`                                                | Exact browser origin, defaults to `http://localhost:8080`; HTTPS required outside loopback |
| `WEB_PORT`                                                     | Published loopback port, defaults to `8080`; match the port in `PUBLIC_ORIGIN`             |
| `SESSION_TTL_SECONDS`                                          | Existing idle lifetime, defaults to `1800`                                                 |
| `SESSION_ABSOLUTE_TTL_SECONDS`                                 | Existing maximum lifetime, defaults to `86400`                                             |
| `ARGON2_MEMORY_COST`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM` | Existing production defaults/minimums: `65536`, `3`, `4`; weaker settings fail startup     |

The helper constructs `DOCKER_DATABASE_URL` in process memory using the
`postgres` service hostname and percent-encodes the supplied credentials. It
leaves the host's development/test URLs alone. Compose sets the APIs' existing
`DATABASE_URL` to that internal URL, `REDIS_URL=redis://redis:6379`,
`ALLOWED_ORIGINS` derived from `PUBLIC_ORIGIN`, `NODE_ENV=production`, `HOST=0.0.0.0`,
`API_PORT=3000` and `TRUST_PROXY=1`. No secret is passed as a build argument.

Use `config --quiet`: expanded Compose configuration and unrestricted container
inspection include credentials. The helper refuses ordinary `config` output;
the verifier captures the expanded model in memory and prints only checks.

## First build and startup

```bash
nvm use
node --env-file-if-exists=.env scripts/docker/compose.mjs config --quiet
node --env-file-if-exists=.env scripts/docker/compose.mjs build
node --env-file-if-exists=.env scripts/docker/compose.mjs up -d
node --env-file-if-exists=.env scripts/docker/compose.mjs ps --all
```

Open `http://localhost:8080`. Only Nginx publishes a host port, bound to
`127.0.0.1`. Postgres, Redis and both APIs communicate on an internal network;
there are no host-published database, Redis or API ports. Existing development
containers/volumes can remain in place.

The Node and Nginx base images, and Postgres/Redis images, are digest-pinned.
Dependencies come from the unchanged lockfile via `npm ci --ignore-scripts`.
Native bundled prebuilds are used; the API build checks actual Argon2 and compiled
workspace imports. The API runtime contains production workspace dependencies,
compiled API/shared outputs and migrations. It runs as `node`; Nginx runs as
UID/GID 101. Both use read-only root filesystems and writable `/tmp`, dropped
capabilities and no-new-privileges. The API uses an exec-form Node command and an
init process; SIGTERM still drains sockets/adapter work before closing clients.
Nginx uses graceful SIGQUIT. Compose allows 30 seconds for service shutdown.

## Migrations, readiness and routing

Startup order is healthy Postgres/Redis, the one-shot migration, both healthy
APIs, then Nginx. The migration uses the **same API image and database** and runs
`node dist/db/migrate.js dev` from `/app/apps/api`, where the existing migrator
finds `./drizzle`. It applies existing migrations only. A failed migration blocks
both APIs; inspect `logs migrate` and correct the cause before continuing.

For subsequent deployments, build the new images and recreate the migration and
application services so the migration is evaluated for that release:

```bash
node --env-file-if-exists=.env scripts/docker/compose.mjs build
node --env-file-if-exists=.env scripts/docker/compose.mjs up -d --force-recreate migrate api-1 api-2 nginx
```

`/healthz` is liveness. `/readyz` returns `200 {"status":"ready"}` only after
Postgres `SELECT 1` and Redis `PING` succeed, or a generic 503 on a dependency
error. The API checks Postgres before listening, after connecting Redis and before
attaching the adapter. Its image healthcheck probes readiness with a bounded
request. Nginx healthchecks its own static listener at `/nginx-health`; Compose
also requires both API healthchecks before starting it. Healthchecks describe
current health; Compose does not automatically restart a merely unhealthy
process or provide a full scheduler/failover system.

Nginx round-robins `/api`, `/healthz`, `/readyz` and `/socket.io` across `api-1`
and `api-2`, refreshing service addresses through Docker DNS. API/socket requests
never enter SPA fallback. WebSocket upgrades use HTTP/1.1 with Upgrade/Connection
headers and a 75-second read timeout, exceeding the existing heartbeat interval.
Both actual Socket.IO peers already require `transports: ["websocket"]`; no
transport changed. Each connection stays on one replica, while Redis sessions,
rate limits, presence and the Socket.IO Redis adapter span both replicas. No
sticky routing is required. Enabling long-polling later would require revisiting
routing affinity; the existing integration tests reject polling.

Nginx overwrites `X-Forwarded-For` with the peer address and
`X-Forwarded-Proto` with its own scheme, clears alternate forwarding headers and
preserves the browser's actual Origin and Host. Express trusts exactly one hop;
socket handshake budgets use the validated literal forwarded IP only with the
same explicit setting. Development defaults remain `HOST=127.0.0.1` and
`TRUST_PROXY=0`. Keep the APIs private: hop-count trust assumes every ingress path
passes through this Nginx. Additional proxies require a reviewed topology change.

Upstream mutation retries and proxy caching are disabled. Authentication and
CSRF/Origin checks remain on the server. Index/SPA responses use `no-store`;
fingerprinted `/assets/` files use immutable one-year caching. Missing assets
return 404. Access logging is disabled; no cookie/token/header logging is enabled.

## CSP, HTTPS and verification

During the web image build, `scripts/docker/security.mjs` hashes the **actual
inline script in built `index.html`**, verifies its reviewed shared hash, and
writes Nginx's headers. The container HTML uses that HTTP policy instead of a
second intersecting meta policy. A build-time verification checks the prepared
HTML and generated header file together. The policy permits same-origin scripts
plus the exact theme SHA-256, forbids script attributes, uses
`frame-ancestors 'none'`, and adds only the explicitly derived WS/WSS origins to
`connect-src 'self'`. Inline styles remain necessary for the existing virtual
message list; scripts receive neither `unsafe-inline` nor `unsafe-eval`.

Every response receives CSP, nosniff, strict-origin-when-cross-origin referrer
policy, restrictive camera/microphone/geolocation permissions, same-origin COOP
and framing denial. Upstream duplicate security headers are hidden. The local
HTTP stack sets **no HSTS**. Production API HSTS is also conditional on trusted
HTTPS, rather than NODE_ENV alone.

Production session cookies retain HttpOnly, SameSite=Lax and **Secure**. Secure
cookies require HTTPS outside localhost; loopback browser exceptions vary, so
use HTTPS for reliable authenticated production deployment. The local HTTP smoke
checks deliberately exercise unauthenticated routing without relaxing cookies.
For public deployment, configure TLS on the Nginx ingress, use the matching
HTTPS `PUBLIC_ORIGIN` and rebuild the web image. Add HSTS only to the actual HTTPS
server/security-header locations, never the HTTP listener. TLS provisioning and
extra TLS services are outside this stack. Changing `PUBLIC_ORIGIN` requires a
web rebuild because its WS/WSS CSP source is generated at build time.

Static checks require no running application containers:

```bash
npm run build
node --test scripts/docker/*.test.mjs
node --env-file-if-exists=.env scripts/docker/security.mjs generate
node --env-file-if-exists=.env scripts/docker/security.mjs verify
node --env-file-if-exists=.env scripts/docker/compose.mjs verify --static
```

The generated local files live in ignored `docker/generated/`; the ordinary Vite
build is not modified. Docker builds run generation/verification internally and
also run `nginx -t` without starting the Nginx daemon.

After `ps --all` shows both APIs and the other long-running services healthy and
`migrate` exited 0, verify the running stack:

```bash
node --env-file-if-exists=.env scripts/docker/compose.mjs verify
node --env-file-if-exists=.env scripts/docker/compose.mjs images
```

The script checks the Compose topology and actual container health/published
ports, then HTTP headers/hash, web response, SPA fallback, asset caching, API
readiness/401/404/CSRF contracts and a real WebSocket upgrade followed by expected
unauthenticated Socket.IO rejection. It uses no sessions or persisted test data,
prints no credentials, performs no retries and exits nonzero on failure. Full
authenticated cross-instance delivery remains covered by the existing integration
suite; this smoke test does not claim to replace it.

## Stopping and data preservation

```bash
node --env-file-if-exists=.env scripts/docker/compose.mjs down
```

This stops/removes the production containers and networks, preserving the named
Postgres and Redis volumes. Reusing volumes retains database roles/passwords:
changing `POSTGRES_PASSWORD` does not rotate an already initialized database role.
Back up data before intentional removal. **Only when you explicitly intend to
delete all production-stack database/session data**, use `down --volumes` instead.
It does not remove the separate development project's volumes.

References: [Compose startup ordering](https://docs.docker.com/compose/how-tos/startup-order/),
[Nginx WebSocket proxying](https://nginx.org/en/docs/http/websocket.html),
[Express proxy trust](https://expressjs.com/en/guide/behind-proxies.html), and
[unprivileged Nginx](https://github.com/nginx/docker-nginx-unprivileged).

### Local browser origins

For an HTTP `PUBLIC_ORIGIN` on `localhost` or `127.0.0.1`, the Compose helper
allows exactly both hostnames at that same port. It supplies the same allowlist
to HTTP, CSRF and Socket.IO checks; the generated CSP allows the corresponding
two explicit `ws://` origins. HTTPS deployments retain only their exact configured
origin. No wildcard, other port or external hostname is added.

Use `scripts/docker/compose.mjs` to derive `DOCKER_ALLOWED_ORIGINS`; do not set it
manually. Verification checks HTTP and WebSocket routing for both local origins.
After this configuration changes, rebuild the Nginx image and recreate both API
replicas and Nginx. Cookies remain host-specific: switching between the two browser
hostnames requires logging in separately, and production cookie flags are unchanged.
