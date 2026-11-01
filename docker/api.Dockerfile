# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS manifests
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

FROM manifests AS build
# Bundled native prebuilds/optional platform packages avoid executing install scripts.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src
COPY apps/api/tsconfig.json ./apps/api/
COPY apps/api/src ./apps/api/src
RUN npm run build --workspace=@relay-chat/shared && npm run build --workspace=@relay-chat/api

FROM manifests AS production-dependencies
RUN npm ci --omit=dev --workspace=@relay-chat/api --workspace=@relay-chat/shared --include-workspace-root=false --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/ ./
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --chown=node:node apps/api/drizzle ./apps/api/drizzle
USER node
WORKDIR /app/apps/api
# Exercise the real ESM workspace graph and native Argon2 binding during the build.
RUN node --input-type=module -e 'await import("argon2"); await import("./dist/app.js"); await import("./dist/socket.js")'
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=4s --start-period=10s --retries=3 CMD ["node", "--input-type=module", "-e", "try { const r = await fetch('http://127.0.0.1:' + (process.env.API_PORT || '3000') + '/readyz', { signal: AbortSignal.timeout(3000) }); process.exit(r.ok && (await r.json()).status === 'ready' ? 0 : 1); } catch { process.exit(1); }"]
CMD ["node", "dist/server.js"]
