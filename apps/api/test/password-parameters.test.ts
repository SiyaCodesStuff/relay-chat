import { describe, expect, it } from "vitest";
import { parseEnvironment } from "../src/environment.js";
import { defaultPasswordCosts, resolvePasswordCosts } from "../src/auth/password-parameters.js";
import { createApp, type AuthAppOptions } from "../src/app.js";

const environment = {
  DATABASE_URL: "postgres://localhost/test",
  REDIS_URL: "redis://localhost",
  SESSION_SECRET: "test-placeholder-with-at-least-32-characters",
};
describe("Argon2 security parameters", () => {
  it("also rejects weak settings injected directly into the production app factory", () => {
    expect(() =>
      createApp({ nodeEnv: "production", passwordCosts: { timeCost: 1 } } as AuthAppOptions),
    ).toThrow(/Only NODE_ENV=test/);
  });
  it.each(["production", "development", "test"])("preserves defaults in %s", (mode) => {
    expect(resolvePasswordCosts(mode)).toEqual({ memoryCost: 65536, timeCost: 3, parallelism: 4 });
  });
  it.each(["production", "development", undefined])(
    "rejects each weakened minimum at startup in %s",
    (NODE_ENV) => {
      for (const weak of [
        { ARGON2_MEMORY_COST: "1024" },
        { ARGON2_TIME_COST: "1" },
        { ARGON2_PARALLELISM: "1" },
      ]) {
        expect(() => parseEnvironment({ ...environment, NODE_ENV, ...weak })).toThrow(
          /Only NODE_ENV=test/,
        );
      }
    },
  );
  it("allows low cost only in tests and accepts stronger production settings", () => {
    expect(
      parseEnvironment({
        ...environment,
        NODE_ENV: "test",
        ARGON2_MEMORY_COST: "1024",
        ARGON2_TIME_COST: "1",
        ARGON2_PARALLELISM: "1",
      }).ARGON2_MEMORY_COST,
    ).toBe(1024);
    expect(
      resolvePasswordCosts("production", { ...defaultPasswordCosts, timeCost: 4 }).timeCost,
    ).toBe(4);
  });
  it.each(["0", "-1", "1.5", "NaN", "1048577", "private-invalid-value"])(
    "rejects invalid memory parameters without printing values",
    (value) => {
      expect(() =>
        parseEnvironment({ ...environment, NODE_ENV: "test", ARGON2_MEMORY_COST: value }),
      ).toThrow(/ARGON2_MEMORY_COST/);
      expect(() =>
        parseEnvironment({ ...environment, NODE_ENV: "test", ARGON2_MEMORY_COST: value }),
      ).not.toThrow(/private-invalid-value/);
    },
  );
  it("enforces legal Argon2 bounds even in tests", () => {
    expect(() => resolvePasswordCosts("test", { memoryCost: 8, parallelism: 2 })).toThrow(
      /eight times/,
    );
    for (const costs of [
      { timeCost: 0 },
      { timeCost: 11 },
      { parallelism: 0 },
      { parallelism: 17 },
    ])
      expect(() => resolvePasswordCosts("test", costs)).toThrow(/Invalid Argon2/);
  });
});
