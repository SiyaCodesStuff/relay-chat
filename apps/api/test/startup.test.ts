import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  migrate: vi.fn(),
  end: vi.fn(),
  connect: vi.fn(),
  quit: vi.fn(),
  redisOn: vi.fn(),
  listen: vi.fn(),
  closeAdapter: vi.fn(),
  ioClose: vi.fn((callback: () => void) => callback()),
}));
vi.mock("pg", () => ({
  Pool: class {
    end = mocks.end;
  },
}));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock("drizzle-orm/node-postgres/migrator", () => ({ migrate: mocks.migrate }));
vi.mock("redis", () => ({
  createClient: () => ({ on: mocks.redisOn, connect: mocks.connect, quit: mocks.quit }),
}));
vi.mock("../src/db/client.js", () => ({
  createDatabase: () => ({ db: {}, pool: { end: mocks.end } }),
}));
vi.mock("../src/app.js", () => ({ createApp: vi.fn(() => ({})) }));
vi.mock("../src/socket.js", () => ({ createSocketServer: () => ({ close: mocks.ioClose }) }));
vi.mock("../src/socket-adapter.js", () => ({ attachRedisAdapter: async () => mocks.closeAdapter }));
vi.mock("node:http", () => ({ createServer: () => ({ listen: mocks.listen }) }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.resetModules();
});

function environment() {
  vi.stubEnv("DATABASE_URL", "postgres://test:test@localhost/test");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  vi.stubEnv("SESSION_SECRET", "startup-test-placeholder-32-characters");
  vi.stubEnv("NODE_ENV", "test");
}

it("starts only after Redis connects and closes every resource on termination", async () => {
  environment();
  const signals = new Map<string, () => Promise<void>>();
  vi.spyOn(process, "once").mockImplementation(((event: string, handler: () => Promise<void>) => {
    signals.set(event, handler);
    return process;
  }) as typeof process.once);
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  mocks.listen.mockImplementation((_port: number, _host: string, ready: () => void) => ready());
  await import("../src/server.js");
  expect(mocks.connect).toHaveBeenCalledOnce();
  expect(info).toHaveBeenCalledWith("API listening on 127.0.0.1:3000");
  expect(signals.has("SIGINT")).toBe(true);
  const stopped = new Promise<void>((resolve) => mocks.end.mockImplementationOnce(resolve));
  signals.get("SIGTERM")?.();
  await stopped;
  expect(mocks.end).toHaveBeenCalledOnce();
  expect(mocks.ioClose).toHaveBeenCalledOnce();
  expect(mocks.closeAdapter).toHaveBeenCalledOnce();
  expect(mocks.quit).toHaveBeenCalledOnce();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const onError = mocks.redisOn.mock.calls[0]?.[1] as () => void;
  onError();
  expect(error).toHaveBeenCalledWith("Redis connection error.");
});

it("fails startup with field names and no environment values", async () => {
  environment();
  vi.stubEnv("DATABASE_URL", "private-invalid-database-value");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("startup stopped");
  });
  await expect(import("../src/env.js")).rejects.toThrow("startup stopped");
  expect(error).toHaveBeenCalledWith(
    "Invalid environment configuration. Check these fields: DATABASE_URL",
  );
});

it.each(["dev", "test"])("migrates the %s database and closes its pool", async (target) => {
  environment();
  vi.stubEnv("DATABASE_URL_TEST", "postgres://test:test@localhost/test_only");
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "migrate.ts", target]);
  await import("../src/db/migrate.js");
  expect(mocks.migrate).toHaveBeenCalledWith({}, { migrationsFolder: "./drizzle" });
  expect(mocks.end).toHaveBeenCalledOnce();
});

it("sanitizes migration failures and still closes the pool", async () => {
  environment();
  const originalExitCode = process.exitCode;
  mocks.migrate.mockRejectedValueOnce(new Error("private-driver-details"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await import("../src/db/migrate.js");
    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith("Database migration failed.");
    expect(mocks.end).toHaveBeenCalledOnce();
  } finally {
    process.exitCode = originalExitCode;
  }
});
