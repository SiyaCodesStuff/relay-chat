import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { composeEnvironment } from "./compose.mjs";
import {
  parseCompose,
  parseContainers,
  verifyCompose,
  verifyProxySources,
  verifyRunning,
  verifyWebsocket,
} from "./verify.mjs";

function configuration() {
  const env = composeEnvironment({
    POSTGRES_USER: "fixture-user",
    POSTGRES_PASSWORD: "fixture-only",
    SESSION_SECRET: "fixture-placeholder-with-at-least-32-characters",
  });
  const api = {
    image: "relay-chat-api:local",
    environment: {
      HOST: "0.0.0.0",
      TRUST_PROXY: "1",
      NODE_ENV: "production",
      API_PORT: "3000",
      DATABASE_URL: env.DOCKER_DATABASE_URL,
      REDIS_URL: "redis://redis:6379",
      SESSION_SECRET: env.SESSION_SECRET,
      ALLOWED_ORIGINS: env.DOCKER_ALLOWED_ORIGINS,
    },
    depends_on: {
      postgres: { condition: "service_healthy" },
      redis: { condition: "service_healthy" },
      migrate: { condition: "service_completed_successfully" },
    },
  };
  return {
    networks: { backend: { internal: true } },
    services: {
      postgres: {
        environment: {
          POSTGRES_USER: env.POSTGRES_USER,
          POSTGRES_PASSWORD: env.POSTGRES_PASSWORD,
          POSTGRES_DB: "relay_chat",
        },
        healthcheck: { test: ["CMD", "pg_isready"] },
        volumes: [{ type: "volume" }],
      },
      redis: { healthcheck: { test: ["CMD", "redis-cli", "ping"] }, volumes: [{ type: "volume" }] },
      migrate: {
        image: api.image,
        command: ["node", "dist/db/migrate.js", "dev"],
        environment: { DATABASE_URL: env.DOCKER_DATABASE_URL },
        restart: "no",
        depends_on: { postgres: { condition: "service_healthy" } },
      },
      "api-1": structuredClone(api),
      "api-2": structuredClone(api),
      nginx: {
        ports: [{ target: 8080, host_ip: "127.0.0.1" }],
        depends_on: {
          "api-1": { condition: "service_healthy" },
          "api-2": { condition: "service_healthy" },
        },
      },
    },
  };
}
function containers() {
  return ["postgres", "redis", "migrate", "api-1", "api-2", "nginx"].map((name) => ({
    Service: name,
    ID: `fixture-${name}`,
    State: name === "migrate" ? "exited" : "running",
    ExitCode: 0,
    Health: "healthy",
    Publishers: name === "nginx" ? [{ PublishedPort: 8080, URL: "127.0.0.1" }] : [],
  }));
}

test("constructs a correctly encoded internal database URL without changing development settings", () => {
  const source = {
    POSTGRES_USER: "fixture@user",
    POSTGRES_PASSWORD: "fixture@:/?#%",
    SESSION_SECRET: "fixture-placeholder-with-at-least-32-characters",
    DATABASE_URL: "postgres://localhost/dev",
  };
  const result = composeEnvironment(source);
  const url = new URL(result.DOCKER_DATABASE_URL);
  assert.equal(decodeURIComponent(url.username), source.POSTGRES_USER);
  assert.equal(decodeURIComponent(url.password), source.POSTGRES_PASSWORD);
  assert.equal(url.hostname, "postgres");
  assert.equal(result.DATABASE_URL, source.DATABASE_URL);
  assert.equal(source.DOCKER_DATABASE_URL, undefined);
  assert.throws(
    () => composeEnvironment({}),
    /Missing environment variables: POSTGRES_USER, POSTGRES_PASSWORD, SESSION_SECRET/,
  );
  assert.throws(
    () => composeEnvironment({ ...source, SESSION_SECRET: "short" }),
    /SESSION_SECRET must/,
  );
});
test("accepts the six-service topology and rejects exposed ports, unsafe trust and migration races", () => {
  assert.equal(verifyCompose(configuration()), "http://localhost:8080");
  const mutations = [
    (config) => {
      config.services["api-1"].ports = [{ target: 3000 }];
    },
    (config) => {
      config.services["api-1"].environment.TRUST_PROXY = "true";
    },
    (config) => {
      config.services["api-2"].depends_on.migrate.condition = "service_started";
    },
    (config) => {
      config.services.nginx.depends_on["api-2"].condition = "service_started";
    },
    (config) => {
      config.services["api-1"].environment.DATABASE_URL = "postgres://localhost/relay_chat";
    },
    (config) => {
      config.services.postgres.environment.POSTGRES_DB = "other";
    },
    (config) => {
      config.services.migrate.environment.DATABASE_URL = "postgres://localhost/other";
    },
    (config) => {
      config.services["api-1"].environment.ALLOWED_ORIGINS = "http://localhost:5173";
    },
    (config) => {
      config.networks.backend.internal = false;
    },
  ];
  for (const mutate of mutations) {
    const config = configuration();
    mutate(config);
    assert.throws(() => verifyCompose(config));
  }
});
test("compares runtime credentials after Compose's literal dollar serialization", () => {
  const config = configuration();
  const password = "fixture$dollar$$value";
  const url = new URL(config.services["api-1"].environment.DATABASE_URL);
  url.password = encodeURIComponent(password);
  config.services.postgres.environment.POSTGRES_PASSWORD = password.replaceAll("$", () => "$$");
  for (const name of ["api-1", "api-2", "migrate"])
    config.services[name].environment.DATABASE_URL = url.href;
  assert.equal(verifyCompose(parseCompose(JSON.stringify(config))), "http://localhost:8080");
});
test("running-state checks require both distinct healthy APIs, migration success and only one ingress port", () => {
  assert.doesNotThrow(() => verifyRunning(containers()));
  for (const mutate of [
    (rows) => {
      rows.find((row) => row.Service === "api-2").Health = "unhealthy";
    },
    (rows) => {
      rows.find((row) => row.Service === "api-2").ID = "fixture-api-1";
    },
    (rows) => {
      rows.find((row) => row.Service === "migrate").ExitCode = 1;
    },
    (rows) => {
      rows.find((row) => row.Service === "postgres").Publishers = [{ PublishedPort: 5432 }];
    },
  ]) {
    const rows = containers();
    mutate(rows);
    assert.throws(() => verifyRunning(rows));
  }
});
test("parses both Compose JSON formats without exposing raw configuration", () => {
  const rows = containers();
  assert.deepEqual(parseContainers(JSON.stringify(rows)), rows);
  assert.deepEqual(parseContainers(rows.map((row) => JSON.stringify(row)).join("\n")), rows);
});
test("checks the actual proxy and transports and rejects forwarding-chain append or missing upgrades", () => {
  const paths = [
    "docker/nginx/nginx.conf",
    "docker/nginx/proxy.conf",
    "apps/web/src/chat/socket.ts",
    "apps/api/src/socket.ts",
    ".dockerignore",
  ];
  const sources = paths.map((path) =>
    readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"),
  );
  assert.doesNotThrow(() => verifyProxySources(...sources));
  for (const [before, after] of [
    ["$remote_addr", "$proxy_add_x_forwarded_for"],
    ["proxy_set_header Upgrade $http_upgrade;", ""],
  ]) {
    const changed = [...sources];
    changed[1] = changed[1].replaceAll(before, after);
    assert.throws(() => verifyProxySources(...changed));
  }
});

test("derives only the exact local pair and preserves remote HTTPS isolation", () => {
  const source = {
    POSTGRES_USER: "fixture",
    POSTGRES_PASSWORD: "fixture",
    SESSION_SECRET: "x".repeat(32),
  };
  for (const PUBLIC_ORIGIN of ["http://localhost:9090", "http://127.0.0.1:9090"]) {
    assert.equal(
      composeEnvironment({ ...source, PUBLIC_ORIGIN }).DOCKER_ALLOWED_ORIGINS,
      "http://localhost:9090,http://127.0.0.1:9090",
    );
  }
  const config = configuration();
  config.services.nginx.build = { args: { PUBLIC_ORIGIN: "https://chat.example.test" } };
  for (const name of ["api-1", "api-2"])
    config.services[name].environment.ALLOWED_ORIGINS = "https://chat.example.test";
  assert.equal(verifyCompose(config), "https://chat.example.test");
  for (const origins of [
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "*",
    "http://localhost:8080,http://127.0.0.1:8080,https://evil.example",
    "http://localhost:8081,http://127.0.0.1:8081",
  ]) {
    const altered = configuration();
    altered.services["api-1"].environment.ALLOWED_ORIGINS = origins;
    assert.throws(() => verifyCompose(altered), /ALLOWED_ORIGINS/);
  }
});

test("websocket verification cleans up the client on success and failure without Manager.close", async () => {
  for (const outcome of ["unauthorized", "forbidden", "accepted"]) {
    const socket = new EventEmitter();
    socket.io = new EventEmitter();
    socket.io.engine = { transport: { name: "websocket" } };
    let disconnected = false;
    socket.disconnect = () => {
      disconnected = true;
    };
    socket.connect = () => {
      if (outcome !== "forbidden") socket.io.emit("open");
      if (outcome === "accepted") socket.emit("connect");
      else
        socket.emit(
          "connect_error",
          new Error(outcome === "unauthorized" ? "Unauthorized socket connection." : "Forbidden"),
        );
    };
    const result = verifyWebsocket("http://127.0.0.1:8080", (origin, options) => {
      assert.equal(options.extraHeaders.Origin, origin);
      assert.equal(options.reconnection, false);
      assert.deepEqual(options.transports, ["websocket"]);
      return socket;
    });
    if (outcome === "unauthorized") await result;
    else await assert.rejects(result, /Unauthenticated socket was accepted|WebSocket upgrade/);
    assert.equal(disconnected, true);
    assert.deepEqual(socket.eventNames(), []);
    assert.deepEqual(socket.io.eventNames(), []);
  }
});
