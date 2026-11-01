import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp, type AuthAppOptions } from "../src/app.js";
import { parseEnvironment } from "../src/environment.js";
import { socketClientAddress } from "../src/proxy.js";

function fixture(trustProxy: 0 | 1 = 0) {
  const execute = vi.fn(async () => undefined);
  const sendCommand = vi.fn(async (command: string[]) => (command[0] === "PING" ? "PONG" : 1));
  const app = createApp({
    db: { execute } as unknown as AuthAppOptions["db"],
    redis: {
      sendCommand,
      get: async () => null,
      set: async () => undefined,
      expire: async () => undefined,
      del: async () => undefined,
    },
    nodeEnv: "test",
    trustProxy,
    allowedOrigins: ["http://localhost:8080"],
    sessionTtlSeconds: 60,
    sessionAbsoluteTtlSeconds: 60,
  });
  return { app, execute, sendCommand };
}

describe("container readiness and bounded proxy trust", () => {
  it("requires both Postgres and Redis and keeps liveness independent", async () => {
    const { app, execute, sendCommand } = fixture();
    await request(app).get("/readyz").expect(200).expect({ status: "ready" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledExactlyOnceWith(["PING"]);
    await request(app)
      .get("/readyz?unexpected=value")
      .expect(400)
      .expect({ error: "INVALID_REQUEST" });
    expect(execute).toHaveBeenCalledTimes(1);
    execute.mockRejectedValueOnce(new Error("private-connection-details"));
    await request(app).get("/readyz").expect(503).expect({ status: "unavailable" });
    sendCommand.mockRejectedValueOnce(new Error("private-connection-details"));
    await request(app).get("/readyz").expect(503).expect({ status: "unavailable" });
    sendCommand.mockResolvedValueOnce(1);
    await request(app).get("/readyz").expect(503).expect({ status: "unavailable" });
    await request(app).get("/healthz").expect(200).expect({ status: "ok" });
  });
  it("ignores forwarded client IPs by default and trusts exactly one configured hop", async () => {
    for (const trust of [0, 1] as const) {
      const { app, sendCommand } = fixture(trust);
      await request(app)
        .get("/api/v1/auth/me")
        .set("X-Forwarded-For", "198.51.100.8")
        .expect(401)
        .expect({ error: "AUTHENTICATION_FAILED" });
      const key = sendCommand.mock.calls[0]?.[0][3];
      expect(key?.endsWith(":198.51.100.8")).toBe(trust === 1);
    }
  });
  it("defaults to loopback/no proxy and rejects unbounded or unsupported proxy settings", () => {
    const source = {
      DATABASE_URL: "postgres://localhost/example",
      REDIS_URL: "redis://localhost",
      SESSION_SECRET: "test-placeholder-with-at-least-32-characters",
    };
    expect(parseEnvironment(source).HOST).toBe("127.0.0.1");
    expect(parseEnvironment(source).TRUST_PROXY).toBe(0);
    expect(parseEnvironment({ ...source, HOST: "0.0.0.0", TRUST_PROXY: "1" }).TRUST_PROXY).toBe(1);
    for (const value of ["true", "false", "2", "-1", "1.5", "private-invalid-value"])
      expect(() => parseEnvironment({ ...source, TRUST_PROXY: value })).toThrow(
        "Invalid environment configuration. Check these fields: TRUST_PROXY",
      );
  });
  it("uses only a literal single-hop websocket forwarding address when explicitly trusted", () => {
    for (const forwarded of [
      "198.51.100.8",
      "2001:db8::8",
      "198.51.100.8, 10.0.0.2",
      "invalid",
      ["198.51.100.8"],
    ]) {
      const req = {
        headers: { "x-forwarded-for": forwarded },
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as IncomingMessage;
      expect(socketClientAddress(req)).toBe("127.0.0.1");
      expect(socketClientAddress(req, 1)).toBe(
        typeof forwarded === "string" && ["198.51.100.8", "2001:db8::8"].includes(forwarded)
          ? forwarded
          : "127.0.0.1",
      );
    }
  });
});
