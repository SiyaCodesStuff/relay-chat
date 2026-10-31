import { test, expect } from "@playwright/test";
import { e2eDatabaseUrl } from "./database.js";

test("E2E defaults to its own database while reusing test connection credentials", () => {
  const url = new URL(
    e2eDatabaseUrl({ DATABASE_URL_TEST: "postgres://localhost/relay_chat_test" }),
  );
  expect(url.pathname).toBe("/relay_chat_e2e");
});

test("E2E accepts an explicitly configured separate database", () => {
  expect(
    new URL(e2eDatabaseUrl({ DATABASE_URL_E2E: "postgresql://localhost/isolated_e2e" })).pathname,
  ).toBe("/isolated_e2e");
});

test("E2E rejects development, integration and administrative databases without exposing URLs", () => {
  for (const name of [
    "relay_chat",
    "relay_chat_test",
    "postgres",
    "template0",
    "template1",
    "%72elay_chat_test",
  ])
    expect(() =>
      e2eDatabaseUrl({
        DATABASE_URL: "postgres://localhost/relay_chat",
        DATABASE_URL_TEST: "postgres://localhost/relay_chat_test",
        DATABASE_URL_E2E: `postgres://127.0.0.1/${name}`,
      }),
    ).toThrow("E2E database must be separate from development and integration databases.");
  expect(() => e2eDatabaseUrl({ DATABASE_URL_E2E: "not-a-url" })).toThrow(
    "E2E database must be separate from development and integration databases.",
  );
  expect(() =>
    e2eDatabaseUrl({ DATABASE_URL_E2E: "postgres://localhost/e2e?dbname=relay_chat" }),
  ).toThrow("E2E database must be separate from development and integration databases.");
});
