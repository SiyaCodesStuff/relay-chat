import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { io } from "socket.io-client";
import { deploymentOrigins, publicOrigin, verifySecurity } from "./security.mjs";

const execute = promisify(execFile);
class VerificationError extends Error {}
const services = ["postgres", "redis", "migrate", "api-1", "api-2", "nginx"];
function requireCheck(condition, message) {
  if (!condition) throw new VerificationError(message);
}

export function verifyCompose(config) {
  requireCheck(
    services.every((name) => config.services?.[name]),
    "Missing required Compose service.",
  );
  requireCheck(
    Object.keys(config.services).length === services.length,
    "Unexpected service in production stack.",
  );
  requireCheck(config.networks?.backend?.internal === true, "Backend network must be internal.");
  for (const name of services.filter((name) => name !== "nginx"))
    requireCheck(!config.services[name].ports?.length, "Only Nginx may publish a host port.");
  const ingress = config.services.nginx;
  requireCheck(
    ingress.ports?.length === 1 &&
      ingress.ports[0].target === 8080 &&
      ingress.ports[0].host_ip === "127.0.0.1",
    "Nginx must publish exactly one loopback HTTP port.",
  );
  const origin = publicOrigin(ingress.build?.args?.PUBLIC_ORIGIN ?? "http://localhost:8080").origin;
  const postgres = config.services.postgres.environment;
  for (const name of ["postgres", "redis"])
    requireCheck(
      config.services[name].healthcheck?.test?.length &&
        config.services[name].volumes?.some((volume) => volume.type === "volume"),
      "Data services require healthchecks and named volumes.",
    );
  for (const name of ["api-1", "api-2"]) {
    const service = config.services[name];
    const env = service.environment;
    requireCheck(
      env.HOST === "0.0.0.0" &&
        env.TRUST_PROXY === "1" &&
        env.NODE_ENV === "production" &&
        env.API_PORT === "3000",
      "Invalid API binding or proxy settings.",
    );
    requireCheck(
      env.ALLOWED_ORIGINS === deploymentOrigins(origin).join(","),
      "ALLOWED_ORIGINS must match the exact origins derived from the web image PUBLIC_ORIGIN.",
    );
    requireCheck(env.SESSION_SECRET?.length >= 32, "Missing or invalid SESSION_SECRET.");
    requireCheck(
      env.REDIS_URL === "redis://redis:6379",
      "REDIS_URL must use the internal Redis service.",
    );
    let database;
    try {
      database = new URL(env.DATABASE_URL);
    } catch {
      throw new Error("Invalid DOCKER_DATABASE_URL.");
    }
    requireCheck(
      ["postgres:", "postgresql:"].includes(database.protocol) &&
        database.hostname === "postgres" &&
        (database.port || "5432") === "5432" &&
        !database.search,
      "DOCKER_DATABASE_URL must use the internal postgres service without URL options.",
    );
    requireCheck(
      decodeURIComponent(database.pathname.slice(1)) === postgres.POSTGRES_DB &&
        decodeURIComponent(database.username) === postgres.POSTGRES_USER &&
        decodeURIComponent(database.password) === postgres.POSTGRES_PASSWORD,
      "DOCKER_DATABASE_URL database/credentials must match the Postgres environment.",
    );
    requireCheck(
      service.depends_on?.postgres?.condition === "service_healthy" &&
        service.depends_on?.redis?.condition === "service_healthy" &&
        service.depends_on?.migrate?.condition === "service_completed_successfully",
      "API dependencies must be healthy and migrations must complete first.",
    );
    requireCheck(
      ingress.depends_on?.[name]?.condition === "service_healthy",
      "Nginx must depend on both healthy API instances.",
    );
  }
  requireCheck(
    JSON.stringify(config.services.migrate.command) ===
      JSON.stringify(["node", "dist/db/migrate.js", "dev"]) &&
      config.services.migrate.restart === "no" &&
      config.services.migrate.depends_on?.postgres?.condition === "service_healthy",
    "Migration service must be one-shot and wait for healthy Postgres.",
  );
  requireCheck(
    config.services.migrate.image === config.services["api-1"].image &&
      config.services["api-1"].image === config.services["api-2"].image,
    "Migration and replicas must use the same API image.",
  );
  requireCheck(
    config.services.migrate.environment.DATABASE_URL ===
      config.services["api-1"].environment.DATABASE_URL &&
      config.services["api-1"].environment.DATABASE_URL ===
        config.services["api-2"].environment.DATABASE_URL,
    "Migration and replicas must use the same database.",
  );
  return origin;
}

export function verifyRunning(rows) {
  for (const name of services) {
    const matching = rows.filter((row) => row.Service === name);
    requireCheck(
      matching.length === 1,
      "Expected exactly one container for each production service.",
    );
    const row = matching[0];
    if (name === "migrate")
      requireCheck(
        row.State === "exited" && row.ExitCode === 0,
        "Migration container did not complete successfully.",
      );
    else
      requireCheck(
        row.State === "running" && row.Health === "healthy",
        "A required production service is not healthy.",
      );
    const published = row.Publishers?.filter((port) => Number(port.PublishedPort) > 0) ?? [];
    requireCheck(
      name === "nginx"
        ? published.length === 1 && published[0].URL === "127.0.0.1"
        : published.length === 0,
      "Unexpected host-published container port.",
    );
  }
  requireCheck(
    rows.find((row) => row.Service === "api-1").ID !==
      rows.find((row) => row.Service === "api-2").ID,
    "API replicas must be independent containers.",
  );
}

export function verifyProxySources(nginx, proxy, client, server, dockerignore) {
  requireCheck(
    /server api-1:3000 resolve;/.test(nginx) && /server api-2:3000 resolve;/.test(nginx),
    "Nginx must route to both resolvable replicas.",
  );
  requireCheck(
    /location \^~ \/api\//.test(nginx) &&
      /location \^~ \/socket\.io/.test(nginx) &&
      /try_files \$uri \$uri\/ \/index\.html;/.test(nginx),
    "Missing separate API/socket routes or SPA fallback.",
  );
  requireCheck(
    proxy.includes("proxy_set_header X-Forwarded-For $remote_addr;") &&
      !proxy.includes("$proxy_add_x_forwarded_for") &&
      proxy.includes("proxy_set_header X-Forwarded-Proto $scheme;"),
    "Ingress must overwrite untrusted forwarding headers.",
  );
  requireCheck(
    proxy.includes("proxy_set_header Upgrade $http_upgrade;") &&
      proxy.includes("proxy_set_header Connection $connection_upgrade;") &&
      proxy.includes("proxy_next_upstream off;"),
    "Missing upgrade headers or unsafe upstream retries.",
  );
  for (const source of [client, server])
    requireCheck(
      /transports:\s*\["websocket"\]/.test(source),
      "Both Socket.IO peers must remain websocket-only.",
    );
  requireCheck(
    dockerignore.split("\n").includes(".env") && dockerignore.includes("**/node_modules"),
    "Docker context must exclude environment files and host modules.",
  );
}

export function parseContainers(text) {
  return text.trim().startsWith("[")
    ? JSON.parse(text)
    : text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

export function parseCompose(text) {
  const config = JSON.parse(text);
  // Compose escapes literal dollars for round-tripping even in JSON output.
  // Compare runtime values, not the serialized double-dollar representation.
  for (const service of Object.values(config.services ?? {}))
    for (const [name, value] of Object.entries(service.environment ?? {}))
      if (typeof value === "string") service.environment[name] = value.replaceAll("$$", "$");
  return config;
}

async function docker(args) {
  try {
    return (
      await execute("docker", ["compose", "-f", "compose.production.yml", ...args], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        maxBuffer: 2 * 1024 * 1024,
      })
    ).stdout;
  } catch {
    throw new Error(
      "Docker Compose inspection failed. Check Docker access and required environment variable names in docs/docker.md.",
    );
  }
}

export async function verifyWebsocket(origin, createSocket = io) {
  const socket = createSocket(origin, {
    transports: ["websocket"],
    extraHeaders: { Origin: origin },
    reconnection: false,
    autoConnect: false,
    timeout: 5000,
  });
  try {
    await new Promise((resolve, reject) => {
      let upgraded = false;
      socket.io.on("open", () => {
        upgraded = socket.io.engine.transport.name === "websocket";
      });
      socket.once("connect", () => reject(new Error("Unauthenticated socket was accepted.")));
      socket.once("connect_error", (error) => {
        if (upgraded && error.message === "Unauthorized socket connection.") resolve();
        else reject(new Error("WebSocket upgrade/routing or unauthenticated rejection failed."));
      });
      socket.connect();
    });
  } finally {
    socket.disconnect();
    socket.removeAllListeners();
    socket.io.removeAllListeners();
  }
}

async function verifyHttp(origin) {
  const get = (path, options = {}) =>
    fetch(new URL(path, origin), {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
  const root = await get("/");
  requireCheck(root.status === 200, "Web app did not return 200.");
  const html = await root.text();
  verifySecurity(html, Object.fromEntries(root.headers), origin);
  requireCheck(root.headers.get("cache-control")?.includes("no-store"), "HTML must not be cached.");
  if (new URL(origin).protocol === "http:")
    requireCheck(!root.headers.has("strict-transport-security"), "HTTP stack must not set HSTS.");
  const spa = await get("/login");
  requireCheck(spa.status === 200 && (await spa.text()) === html, "SPA fallback failed.");
  const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
  requireCheck(Boolean(asset), "Built fingerprinted JavaScript asset not found.");
  const assetResponse = await get(asset);
  await assetResponse.body?.cancel();
  requireCheck(
    assetResponse.status === 200 &&
      assetResponse.headers.get("cache-control")?.includes("immutable"),
    "Fingerprinted asset caching failed.",
  );
  const missingAsset = await get("/assets/missing.js");
  await missingAsset.body?.cancel();
  requireCheck(missingAsset.status === 404, "Missing assets must not receive the SPA document.");
  for (const [path, status] of [
    ["/healthz", "ok"],
    ["/readyz", "ready"],
  ]) {
    const response = await get(path);
    requireCheck(
      response.status === 200 && (await response.json()).status === status,
      "API health/readiness routing failed.",
    );
  }
  const me = await get("/api/v1/auth/me", { headers: { Origin: origin } });
  requireCheck(
    me.status === 401 && (await me.json()).error === "AUTHENTICATION_FAILED",
    "Protected API must return its unauthenticated 401 envelope.",
  );
  const unknown = await get("/api/v1/not-a-route");
  requireCheck(
    unknown.status === 404 && (await unknown.json()).error === "NOT_FOUND",
    "API requests must not receive SPA fallback.",
  );
  const csrf = await get("/api/v1/auth/logout", { method: "POST", headers: { Origin: origin } });
  requireCheck(
    csrf.status === 403 && (await csrf.json()).error === "CSRF_REJECTED",
    "CSRF protection failed behind proxy.",
  );
}

async function main() {
  requireCheck(
    process.argv.slice(2).every((arg) => arg === "--static"),
    "Usage: verify.mjs [--static]",
  );
  // Config contains credentials: capture and inspect it in memory; never echo it.
  const origin = verifyCompose(parseCompose(await docker(["config", "--format", "json"])));
  const paths = [
    "docker/nginx/nginx.conf",
    "docker/nginx/proxy.conf",
    "apps/web/src/chat/socket.ts",
    "apps/api/src/socket.ts",
    ".dockerignore",
  ];
  verifyProxySources(
    ...(await Promise.all(
      paths.map((path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8")),
    )),
  );
  console.log(
    "PASS static Compose isolation, migration ordering, proxy headers and websocket-only routing",
  );
  if (process.argv.includes("--static")) return;
  verifyRunning(parseContainers(await docker(["ps", "--all", "--format", "json"])));
  console.log(
    "PASS both API instances and other services healthy; only Nginx publishes a host port",
  );
  for (const allowed of deploymentOrigins(origin)) await verifyHttp(allowed);
  console.log(
    "PASS built theme CSP, headers, SPA/assets caching, API routing, readiness, 401 and CSRF rejection",
  );
  for (const allowed of deploymentOrigins(origin)) await verifyWebsocket(allowed);
  console.log(
    "PASS real WebSocket upgrade through Nginx and session-required rejection for every allowed origin",
  );
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(
      error instanceof VerificationError
        ? `FAIL ${error.message}`
        : "FAIL stack verification. Check configuration, running service health and docs/docker.md; no credentials were logged.",
    );
    process.exitCode = 1;
  });
