# Security

## Browser boundary

| Control               | Implementation                                                                                                                                                                                                                                              | Tests                                                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP security headers | `apps/api/src/security.ts`: Helmet, `nosniff`, referrer policy, framing protection, cross-origin resource/opener policies, disabled browser permissions, `Cache-Control: no-store`; HSTS only in production.                                                | `apps/api/test/security.test.ts`: “sets Helmet, CSP, no-store, permissions and production HSTS headers”.                                                                                       |
| CSP                   | Default deny; scripts only from this origin or the reviewed SHA-256 theme hash, no script `unsafe-inline`/`unsafe-eval`, no event-handler attributes, objects, or base URLs; same-origin connections/forms/images/fonts. API adds `frame-ancestors 'none'`. | API header test and `apps/web/test/security.test.ts`: exact theme bytes/hash and policy placement.                                                                                             |
| Pre-paint theme       | Vite inlines the blocking head bootstrap from `apps/web/public/theme.js` and fails the build if its hash differs from `packages/shared/src/security.ts`. Production HTML receives a CSP meta tag before the script.                                         | Web CSP tests plus `apps/web/test/theme.test.ts` for theme behavior.                                                                                                                           |
| Text and links        | React text nodes for messages, display names and channel names; no HTML injection. Autolinks allow only HTTP/HTTPS, exclude embedded credentials, and set `target="_blank" rel="noopener noreferrer"`.                                                      | `apps/web/test/chat.test.tsx`: stored XSS message/display name rendering, dangerous-protocol cases, safe links. Auth/socket integration tests persist and return attack strings as plain data. |
| HTTP Origin/CSRF      | Every supplied Origin must exactly match a validated HTTP(S) allowlist. Every state-changing route additionally requires an allowed Origin and `x-csrf-request: 1`. No wildcard/suffix/reflected Origin acceptance, no trust in forwarded Origin headers.   | API security tests: cross-origin reads and forged forwarded origins; auth integration: CSRF rejection and forged allowed Origin with tampered cookies.                                         |
| Socket Origin         | Origin required and checked both before the Engine.IO upgrade and during Socket.IO authentication; websocket-only transport.                                                                                                                                | `apps/api/test/socket.integration.test.ts`: cross-origin, missing/null Origin, suffix spoof, tampered/duplicate cookies, forged allowed Origin without a valid session; polling rejection.     |

The canonical CSP is exported as `browserContentSecurityPolicy` by the shared
package. `style-src 'unsafe-inline'` is intentionally limited to styles because
virtualized message positioning and the theme use dynamic styles. It never
permits inline scripts. Same-origin script files remain trusted: do not serve
user-controlled executable files from this origin. Stored HTML-like text is
allowed as bounded data, rather than stripped; every rendering surface must keep
escaping it.

## Authentication and authorization

| Control             | Implementation                                                                                                                                                                                                                                    | Tests                                                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passwords           | Argon2id; validated costs; unchanged defaults and hard non-test floors of 65536 KiB, 3 iterations, 4 lanes. Only `NODE_ENV=test` permits lower settings. Emails normalized lowercase; unknown email and incorrect password return the same error. | `password-parameters.test.ts`; auth integration: Argon2id storage/cost, normalization, identical login errors.                                           |
| Session identifiers | Random 256-bit opaque IDs; only user ID and creation time stored in Redis; malformed, unknown, oversized and duplicate session cookies rejected. Login rotates the ID and destroys the old session. Logout deletes it server-side.                | Auth integration: login/logout, fixation, tampered/duplicate/forged cookies; API cookie parser tests.                                                    |
| Cookie flags        | HttpOnly, SameSite=Lax, host-only, Path=/; Secure in production for both creation and clearing. No credentials/session identifiers returned in JSON.                                                                                              | Auth integration: production cookie flags, cleared flags, response identity field allowlist.                                                             |
| Expiry/revocation   | Redis idle TTL slides on authenticated activity; absolute maximum caps it. Each socket packet rechecks the session and current ban state. Passive broadcasts recheck the session without sliding expiry.                                          | Auth integration: sliding and absolute expiry, ban changes; socket integration: revoked session pruned before passive delivery and next action rejected. |
| Authorization       | HTTP reads current role/ban state from Postgres. Channel access/membership enforced server-side; private channels return 404 to outsiders. Socket actions recheck current membership/ban state; recipients are pruned before broadcasts.          | `channels.integration.test.ts`: membership, private visibility, history/read rules; socket integration: removed member stops receiving.                  |
| SQL/data invariants | Drizzle parameter binding, foreign keys, case-insensitive email uniqueness, message body checks and per-user client-message-id uniqueness. Persist before broadcasting.                                                                           | `database.integration.test.ts`; socket integration: stored broadcast and idempotent retry.                                                               |

## Input and flood controls

| Boundary        | Limit/control                                                                                                                                                                                                                                                                                                                                                                                | Tests                                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST            | Shared Zod schemas, strict auth/channel payloads, empty-body/query validation for endpoints with no inputs, history limit 1–100/default 50; 16 KiB JSON body, 2048-character URL, 4096-character cookie header. Oversize returns a generic 413, malformed/unsupported JSON a generic 400, non-JSON bodies 415. JSON inflation is disabled. Node's HTTP parser also imposes its header limit. | API security input-boundary tests; auth display-name length test; channel history pagination tests.                                                                             |
| HTTP flood      | Atomic Redis fixed windows: 120 `/api/v1` requests/IP/minute across instances, including malformed requests before body parsing; registration 5/IP/10 minutes; login 10/IP/10 minutes. Express does not trust spoofed forwarding addresses. Redis errors fail closed.                                                                                                                        | Auth integration: shared HTTP/login limits across two apps, forged `X-Forwarded-For`; API test: Redis failure gives fixed log and generic error.                                |
| Handshake flood | Redis-backed 30 allowed-Origin handshake attempts/IP/minute, shared across instances, before upgrade/session lookup. Invalid Origin rejected before Redis/session work.                                                                                                                                                                                                                      | Socket integration: Redis handshake budget shared across two listening API instances.                                                                                           |
| Socket packets  | 16 KiB transport frame cap; shared Zod event schemas, 4000-character messages and 128-character client IDs. Packet middleware counts unknown/malformed/no-ack packets too: 30/socket/10 seconds plus 120/user/10 seconds across tabs/instances. Errors are typed; new connections do not reset the user budget.                                                                              | Socket integration: 4001-character rejection, oversized frame disconnect, no-ack flood, shared user budget on a new tab, no extra persisted messages.                           |
| Typing/presence | Typing throttled and auto-expiring; no message persistence for typing. Redis connection leases expire crashed sockets; counts cover tabs and instances.                                                                                                                                                                                                                                      | Socket integration: typing expiry, two tabs, crash lease expiry, multi-instance presence/delivery.                                                                              |
| Logs/errors     | Fixed server and idle database-pool log messages; no raw exception, SQL parameters, bodies, hashes, cookies or tokens. Environment errors contain field names/rules only. REST/socket errors are generic envelopes/codes.                                                                                                                                                                    | API security tests inject sensitive-looking Redis and idle database exceptions and assert fixed logs/envelopes; smoke/environment tests ensure supplied values are not printed. |

## Deployment and known limitations

- Deploy browser assets, `/api`, and `/socket.io` on one HTTPS origin. The Vite dev
  proxy preserves that model. Cross-origin CORS access is not enabled. Use only
  exact public browser origins in `ALLOWED_ORIGINS`; invalid configuration fails
  startup without printing its values.
- An Origin header is a browser CSRF boundary, not proof of identity. A native
  client can forge an allowed Origin and must still authenticate. Read-only HTTP
  requests without an Origin are supported; mutations and socket handshakes must
  supply one. The integration tests deliberately send forged headers.
- Helmet headers cover Express responses, not separately hosted HTML or raw
  websocket upgrade responses. The built HTML carries its CSP in a meta tag, but
  framing protection, HSTS and other HTTP-only directives must also be configured
  on the production static host/reverse proxy. Set `frame-ancestors 'none'` there;
  copy the production CSP from `packages/shared/src/security.ts`. Check the final
  browser-facing response headers after deployment.
- Vite HMR needs development inline code; the strict HTML policy is emitted for
  production builds/preview, not the dev server. No production policy is weakened
  for HMR. CSP tests verify exact source/hash/policy bytes and output structure;
  jsdom does not enforce CSP like a real browser.
- Serve production only over TLS. Secure cookies cannot protect plain HTTP. Do
  not cache authenticated responses, log Cookie/Set-Cookie/Authorization headers,
  or enable raw database/request logging in an upstream proxy or service.
- Rate limits are fixed-window application controls, not volumetric DDoS
  protection. Add connection/body/header controls at the ingress. The app does not
  trust proxy forwarding headers; behind a proxy, all users may share its IP
  budget until a narrowly scoped proxy-trust policy is configured. Do not simply
  enable unrestricted `trust proxy`. The health endpoint is outside the Redis
  request budget. Redis/database availability remains necessary.
- Socket recipients are checked for current membership/ban and a valid session
  before broadcasts, including remote-instance sockets. Passive delivery does not
  extend idle expiry. The existing heartbeat disconnects expired/revoked sessions;
  the next action rejects immediately. These are checks at an action/delivery
  boundary, not a transaction spanning authorization and network transmission.
- Generic incorrect-login responses do not equalize lookup/hash timing and
  registration reports an existing email with 409. Account enumeration via timing
  or registration remains possible within rate limits.

## Known issues

- `npm audit` reports 4 moderate advisories ([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)) reached through `drizzle-kit` → `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils` → `esbuild <=0.24.2`. Scope: development tooling only; these four findings are absent with `--omit=dev`. The advisory concerns esbuild's development server, which `drizzle-kit` does not start. The automated "fix" would downgrade `drizzle-kit` to 0.18.1 and is deliberately declined. Action: recheck when `drizzle-kit` ships a release that no longer depends on `@esbuild-kit`.
- The audit on 2026-10-25 additionally reports 1 high production advisory in
  `express -> body-parser@2.3.0`: [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828), denial of service from trailing bytes in compressed request bodies.
  Both full audit and `npm audit --omit=dev` exit 1; production audit now reports
  this one finding, not zero. This application disables JSON inflation and tests
  compressed-input rejection, blocking that parser path. The dependency advisory
  remains unresolved; upgrade the affected dependency through a separately
  authorized dependency update. No automated audit fixes were applied.

Development servers, including Vite and `tsx --watch`, must be bound only to localhost and must never be exposed to other machines.

## Verification

The integration-only Vitest configuration explicitly selects `NODE_ENV=test`,
even when the local environment file selects development. This does not change
startup validation, production settings, fixture guards, retries, or timeouts.
Run against already-running local Postgres and Redis and a dedicated test database:

```sh
npm run typecheck && npm run lint && npm test
npm run test:integration
npm run build
npm audit --omit=dev
```

The security review's sequential checks passed typecheck, lint, 65 unit/UI tests,
and 30 integration tests (including real sockets and two API instances). The web
production build passed; its output was checked for exact inline theme bytes,
matching SHA-256, and policy placement before scripts. The audit exits 1 for the
production advisory above.

Initial validation found a CSP test asset-URL loader error (fixed), two existing
UI readiness assertion failures during overlapping build/test execution (passed
in the full sequential checks), and fixture safety-guard failures when the plain
integration command inherited a non-test environment (test-only config corrected).
No failing tests were skipped, retried automatically, or given longer timeouts.
