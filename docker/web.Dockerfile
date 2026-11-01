# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src
COPY apps/web/tsconfig.json apps/web/vite.config.ts apps/web/security-html.ts apps/web/index.html ./apps/web/
COPY apps/web/src ./apps/web/src
COPY apps/web/public ./apps/web/public
COPY scripts/docker/security.mjs scripts/docker/origins.mjs ./scripts/docker/
ARG PUBLIC_ORIGIN=http://localhost:8080
RUN npm run build --workspace=@relay-chat/shared && npm run build --workspace=@relay-chat/web
RUN PUBLIC_ORIGIN="$PUBLIC_ORIGIN" node scripts/docker/security.mjs generate && PUBLIC_ORIGIN="$PUBLIC_ORIGIN" node scripts/docker/security.mjs verify

FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03 AS runtime
COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
COPY docker/nginx/proxy.conf /etc/nginx/proxy.conf
COPY --from=build /app/apps/web/dist/ /usr/share/nginx/html/
COPY --from=build /app/docker/generated/index.html /usr/share/nginx/html/index.html
COPY --from=build /app/docker/generated/security-headers.conf /etc/nginx/security-headers.conf
USER 101:101
RUN nginx -t
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=4s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/nginx-health || exit 1
STOPSIGNAL SIGQUIT
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
