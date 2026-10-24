# Web app

## Chat workspace

The signed-in route shows channels with unread badges and online-member dots. Channel responses include the caller's `isMember` state and an `onlineUserIds` snapshot calculated from unexpired Redis presence leases. Live presence events refresh that snapshot. Public non-members can preview history and explicitly join before sending.

History uses TanStack Query's upward infinite pagination with the API's exclusive `before` cursor. The message viewport renders a measured window with overscan; older-page insertion and row-height changes preserve the visible message anchor. New messages follow the bottom only when the reader was already there. A keyboard-accessible older-history button and jump-to-latest button complement automatic upward loading. The scroll region itself is focusable for native keyboard scrolling.

`SocketProvider` opens the same-origin WebSocket and creates an instance of the shared reliability module for each visited member channel. Its checkpoint starts at the newest message in the initial history page, so reconnect catches up without downloading all older history. Queued sends retain one `clientMessageId` through pending, timeout/failure and explicit retry states. History, broadcast and acknowledgement data merge by stored ID and sender-scoped client ID. Queues and drafts are in memory; reloading the page loses unsent drafts and pending sends.

Enter sends; Shift+Enter inserts a newline, and IME composition is respected. Typing is throttled, stopped on blur/send, and expires locally even if a stop event is lost. Read markers advance only while the selected channel is at the bottom and the document is visible. Message bodies are React text nodes with HTTP(S)-only autolinks; no HTML is interpreted. Incoming-message counts are announced in a separate polite live region at most once per two seconds. The full message list is not live.

Chat tests inject a dropping fake Socket.IO client while keeping the real reliability module and MSW-backed REST client. They cover optimistic confirmation, same-ID retry, offline queueing, typing expiry, history cursors, windowing, row-height anchoring, bottom-follow rules, announcement batching and unsafe message content.

Run `npm run dev` from the repository root, then open `http://127.0.0.1:5173`. Vite is bound to localhost with a fixed port. It proxies `/api` and WebSocket-only `/socket.io` to the API at `http://127.0.0.1:3000`, preserving the browser Origin. The API origin allowlist must include the URL used to open the web app. Browser API calls use relative paths and do not use `VITE_API_URL`.

The web app uses React Router, TanStack Query and an `AuthProvider` which checks `/api/v1/auth/me` before displaying protected routes. A 401 means signed out; network and server failures display a retry screen. Login, registration and logout update the session query and remove cached private data. Credentials are included in every REST request; state-changing requests include `x-csrf-request: 1`. The browser sends Origin automatically. Passwords and session cookies are never stored in local storage or query data. Only a theme preference is stored locally.

`public/theme.js` runs as a blocking head script before React or the first paint. It uses the saved light/dark choice, falling back to the system preference when unset or storage is unavailable. Theme colors are CSS variables in `src/style.css`.

The [shadcn/ui manual installation](https://ui.shadcn.com/docs/installation/manual) is configured in `components.json`; editable Button and Input source lives in `src/components/ui`. React Router follows the [declarative installation](https://reactrouter.com/start/declarative/installation). The form integration uses `@hookform/resolvers` v5 because v6's optional peer dependency graph fails npm dependency resolution in this workspace.

Run `npm run test --workspace=@relay-chat/web` for Testing Library tests backed by MSW. Unhandled network frames fail tests. No service worker registration or mocking code is included in the production entry point.

Production hosting must serve `index.html` for client-side routes and route `/api` and `/socket.io` to the API on the same origin. Configure the API origin allowlist for that origin and use HTTPS for production session cookies.
