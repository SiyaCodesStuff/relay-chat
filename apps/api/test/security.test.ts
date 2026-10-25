import { describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import request from "supertest";
import { createApp, type AuthAppOptions } from "../src/app.js";
import { originAllowlist } from "../src/security.js";
import { readCookie } from "../src/auth/session.js";
import { browserContentSecurityPolicy } from "@relay-chat/shared";
import { createDatabase } from "../src/db/client.js";

const origin = "http://localhost:5173";
function app(production = false, unavailable = false) {
  return createApp({
    db: {} as AuthAppOptions["db"],
    redis: {
      sendCommand: async () => {
        if (unavailable) throw new Error("private-password-cookie-query-marker");
        return 1;
      },
      get: async () => null,
      set: async () => undefined,
      del: async () => undefined,
      expire: async () => undefined,
    },
    nodeEnv: production ? "production" : "test",
    allowedOrigins: [origin],
    sessionTtlSeconds: 60,
    sessionAbsoluteTtlSeconds: 60,
  });
}
describe("HTTP security boundary", () => {
  it("logs only a fixed message for idle database connection errors", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const connection = createDatabase("postgres://localhost/unused-security-unit-test");
    try {
      connection.pool.emit("error", new Error("private-driver-cookie-query-marker"));
      expect(error).toHaveBeenCalledExactlyOnceWith("Database connection error.");
    } finally {
      error.mockRestore();
      await connection.pool.end();
    }
  });
  it("sets Helmet, CSP, no-store, permissions and production HSTS headers", async () => {
    const response = await request(app(true)).get("/healthz").expect(200);
    expect(response.headers["content-security-policy"]).toBe(
      `${browserContentSecurityPolicy}; frame-ancestors 'none'`,
    );
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["strict-transport-security"]).toContain("max-age=31536000");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["permissions-policy"]).toContain("camera=()");
    expect(response.headers["x-powered-by"]).toBeUndefined();
    const local = await request(app()).get("/healthz");
    expect(local.headers["strict-transport-security"]).toBeUndefined();
  });
  it("rejects cross-origin reads and forged forwarded origins", async () => {
    for (const forbidden of [
      "https://evil.example",
      `${origin}.evil.example`,
      `${origin}/`,
      "null",
      `${origin}, https://evil.example`,
    ]) {
      await request(app())
        .get("/api/v1/auth/me")
        .set("Origin", forbidden)
        .set("X-Forwarded-Origin", origin)
        .expect(403)
        .expect({ error: "ORIGIN_REJECTED" });
    }
    // A non-browser client can forge an allowed Origin; it still needs a real session.
    await request(app()).get("/api/v1/auth/me").set("Origin", origin).expect(401);
  });
  it("bounds bodies, URLs, cookies and rejects malformed JSON and unknown fields", async () => {
    await request(app())
      .post("/api/v1/auth/logout")
      .set("Content-Type", "text/plain")
      .send("x".repeat(17_000))
      .expect(413);
    await request(app())
      .post("/api/v1/auth/logout")
      .set("Content-Type", "text/plain")
      .send("unsupported body")
      .expect(415)
      .expect({ error: "INVALID_REQUEST" });
    await request(app())
      .post("/api/v1/auth/register")
      .set({ "Content-Type": "application/json", "Content-Encoding": "gzip" })
      .send(gzipSync('{"padding":"compressed"}'))
      .expect(400)
      .expect({ error: "INVALID_REQUEST" });
    await request(app())
      .post("/api/v1/auth/register")
      .set({ Origin: origin, "x-csrf-request": "1" })
      .send({ padding: "x".repeat(17_000) })
      .expect(413)
      .expect({ error: "INPUT_TOO_LARGE" });
    await request(app())
      .post("/api/v1/auth/register")
      .set("Content-Type", "application/json")
      .send('{"password":"private-malformed-value"')
      .expect(400)
      .expect({ error: "INVALID_REQUEST" });
    await request(app())
      .get(`/api/v1/auth/me?x=${"x".repeat(2050)}`)
      .expect(413);
    await request(app())
      .get("/api/v1/auth/me")
      .set("Cookie", `padding=${"x".repeat(4100)}`)
      .expect(413);
    await request(app()).get("/api/v1/auth/me?unexpected=value").expect(400);
    await request(app()).post("/api/v1/auth/logout").send({ unexpected: true }).expect(400);
    await request(app())
      .post("/api/v1/auth/register")
      .set({ Origin: origin, "x-csrf-request": "1" })
      .send({
        email: "test@example.test",
        displayName: "Test",
        password: "long-enough-test-password",
        role: "admin",
      })
      .expect(400);
  });
  it("fails closed with a generic response and fixed log message when Redis fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await request(app(false, true))
        .get("/api/v1/auth/me")
        .expect(500)
        .expect({ error: "INTERNAL_SERVER_ERROR" });
      expect(error).toHaveBeenCalledExactlyOnceWith("Unexpected API error.");
    } finally {
      error.mockRestore();
    }
  });
  it("validates allowlists and rejects ambiguous session cookies", () => {
    for (const origins of [
      [],
      ["*"],
      ["null"],
      ["https://user:password@example.test"],
      ["https://example.test/path"],
    ])
      expect(() => originAllowlist(origins)).toThrow(/Invalid ALLOWED_ORIGINS/);
    expect(
      readCookie("relay_session=first; relay_session=second", "relay_session"),
    ).toBeUndefined();
    expect(readCookie(`relay_session=${"x".repeat(4100)}`, "relay_session")).toBeUndefined();
  });
});
