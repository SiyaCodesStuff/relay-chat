import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { authApi } from "../src/lib/api.js";
import { apiOrigin, server } from "./server.js";

describe("typed REST client", () => {
  it("includes credentials and mutation CSRF headers on same-origin fetch calls", async () => {
    // MSW reconstructs Request objects; inspect credentials at the actual fetch boundary.
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(authApi.me()).rejects.toMatchObject({ status: 401 });
    await authApi.login({ email: "member@example.test", password: "test-password-long" });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(`${apiOrigin}/api/v1/auth/me`);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: "include", method: "GET" });
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      credentials: "include",
      method: "POST",
      headers: { "x-csrf-request": "1", "Content-Type": "application/json" },
    });
  });
  it("parses error envelopes and handles malformed responses safely", async () => {
    server.use(
      http.get(`${apiOrigin}/api/v1/auth/me`, () =>
        HttpResponse.json({ error: "RATE_LIMITED" }, { status: 429 }),
      ),
    );
    await expect(authApi.me()).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
    server.use(
      http.get(
        `${apiOrigin}/api/v1/auth/me`,
        () => new HttpResponse("Internal details", { status: 502 }),
      ),
    );
    await expect(authApi.me()).rejects.toMatchObject({ status: 502, code: "HTTP_ERROR" });
    server.use(
      http.get(`${apiOrigin}/api/v1/auth/me`, () => HttpResponse.json({ user: { invalid: true } })),
    );
    await expect(authApi.me()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("surfaces network errors", async () => {
    server.use(http.get(`${apiOrigin}/api/v1/auth/me`, () => HttpResponse.error()));
    await expect(authApi.me()).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });
  });
});
