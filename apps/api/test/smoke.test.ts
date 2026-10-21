import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { parseEnvironment } from "../src/environment.js";

describe("API smoke test", () => {
  it("serves a health check", async () => {
    const response = await request(app).get("/healthz");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });

  it("reports invalid environment field names without values", () => {
    expect(() =>
      parseEnvironment({
        DATABASE_URL: "not-a-url-private-value",
        REDIS_URL: "also-not-a-url-private-value",
        SESSION_SECRET: "short-private-value",
      }),
    ).toThrow(/DATABASE_URL, REDIS_URL, SESSION_SECRET/);
    expect(() =>
      parseEnvironment({
        DATABASE_URL: "not-a-url-private-value",
        REDIS_URL: "also-not-a-url-private-value",
        SESSION_SECRET: "short-private-value",
      }),
    ).toThrow(/^(?!.*private-value)/);
  });
});
