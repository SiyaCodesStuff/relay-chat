import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createClient } from "redis";
import { io as client, type Socket } from "socket.io-client";
import { createApp } from "../src/app.js";
import { createDatabase } from "../src/db/client.js";
import { channelMembers, channels, messages, users } from "../src/db/schema.js";
import { createSocketServer, type SocketScheduler } from "../src/socket.js";
import { attachRedisAdapter } from "../src/socket-adapter.js";
import { createAuthFixture } from "./helpers/auth-fixture.js";

const origin = "http://localhost:5173";
const filePrefix = `relay:test:socket-security:${randomUUID()}:`;
const failure = () => new Error("private-driver-cookie-password-marker");
const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

// Only failure bounds use a real timer. Success always waits for an actual event/ack.
function wait<T>(label: string, subscribe: (resolve: (value: T) => void) => () => void) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Missing ${label}`));
    }, 2000);
    const cleanup = subscribe((value) => {
      clearTimeout(timer);
      cleanup();
      resolve(value);
    });
  });
}
function event(socket: Socket, name: string) {
  return wait<unknown[]>(name, (resolve) => {
    const handler = (...args: unknown[]) => {
      // Transport Error objects retain request headers. Never give them to an assertion/reporter.
      if (name === "connect_error") {
        const error = args[0] as {
          message: string;
          type?: string;
          description?: { message?: string };
        };
        const status = error.description?.message?.match(
          /^Unexpected server response: (\d{3})$/,
        )?.[1];
        resolve([
          {
            message: ["websocket error", "Unauthorized socket connection."].includes(error.message)
              ? error.message
              : "Unexpected connection error",
            type: error.type,
            status: status ? Number(status) : undefined,
          },
        ]);
      } else if (name === "disconnect") {
        const details = args[1] as
          { description?: string; context?: { code?: number } } | undefined;
        resolve([args[0], { description: details?.description, code: details?.context?.code }]);
      } else resolve(args);
    };
    socket.once(name, handler);
    return () => {
      socket.off(name, handler);
    };
  });
}
function ack(socket: Socket, name: string, payload: unknown) {
  return wait<unknown>(`${name} ack`, (resolve) => {
    socket.emit(name, payload, resolve);
    return () => {};
  });
}
function clock() {
  let now = 0;
  const intervals = new Set<() => void | Promise<void>>();
  const expiries = new Set<() => void | Promise<void>>();
  const scheduler: SocketScheduler = {
    now: () => now,
    interval(task) {
      intervals.add(task);
      return () => {
        intervals.delete(task);
      };
    },
    timeout(task) {
      expiries.add(task);
      return () => {
        expiries.delete(task);
      };
    },
  };
  return {
    scheduler,
    advance: (ms: number) => {
      now += ms;
    },
    tick: () => Promise.all([...intervals].map((task) => task())),
    expire: () => Promise.all([...expiries].map((task) => task())),
    pending: () => expiries.size,
  };
}

let connection: ReturnType<typeof createDatabase>;
let redis: ReturnType<typeof createClient>;
let fixture: Awaited<ReturnType<typeof setup>>;
const ownedUsers: string[] = [];
const ownedChannels: string[] = [];
const prefixes: string[] = [];
const pendingClosers = new Set<() => Promise<void>>();

async function setup() {
  const prefix = `${filePrefix}${randomUUID()}:`;
  prefixes.push(prefix);
  const manual = clock();
  const options = {
    db: connection.db,
    redis,
    allowedOrigins: [origin],
    redisKeyPrefix: prefix,
    sessionTtlSeconds: 60,
    sessionAbsoluteTtlSeconds: 60,
  };
  const app = createApp({ ...options, nodeEnv: "test" });
  const http = createServer(app);
  const io = createSocketServer({ ...options, httpServer: http, scheduler: manual.scheduler });
  const sockets: Socket[] = [];
  let closeAdapter: (() => Promise<void>) | undefined;
  let closed: Promise<void> | undefined;
  const close = () =>
    (closed ??= (async () => {
      for (const socket of sockets) socket.disconnect();
      await io.close();
      await closeAdapter?.();
    })());
  // Register before opening resources, so an incomplete beforeEach is cleaned too.
  pendingClosers.add(close);
  const duplicates: ReturnType<typeof redis.duplicate>[] = [];
  const duplicate = redis.duplicate.bind(redis);
  const capture = vi.spyOn(redis, "duplicate").mockImplementation(() => {
    const result = duplicate();
    duplicates.push(result);
    return result;
  });
  try {
    closeAdapter = await attachRedisAdapter(io, redis, `${prefix}adapter`);
  } finally {
    capture.mockRestore();
  }
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("No test listener.");
  const url = `http://127.0.0.1:${address.port}`;
  const people = [];
  for (let i = 0; i < 3; i++)
    people.push(
      await createAuthFixture({
        app,
        db: connection.db,
        redis,
        redisKeyPrefix: prefix,
        ownedUserIds: ownedUsers,
      }),
    );
  const [owner, member, outsider] = people;
  if (!owner || !member || !outsider) throw new Error("Missing fixture users.");
  const [channel] = await connection.db
    .insert(channels)
    .values({ name: `security-${randomUUID()}`, createdBy: owner.userId })
    .returning();
  if (!channel) throw new Error("Missing fixture channel.");
  ownedChannels.push(channel.id);
  await connection.db.insert(channelMembers).values([
    { channelId: channel.id, userId: owner.userId, role: "admin" },
    { channelId: channel.id, userId: member.userId },
  ]);
  const makeClient = (headers: Record<string, string>) => {
    const socket = client(url, {
      autoConnect: false,
      reconnection: false,
      transports: ["websocket"],
      extraHeaders: headers,
    });
    sockets.push(socket);
    return socket;
  };
  const connect = async (person = owner) => {
    const socket = makeClient({ Origin: origin, Cookie: person.cookie });
    const connected = event(socket, "connect");
    socket.connect();
    await connected;
    if (person !== outsider)
      expect(await ack(socket, "channel:join", { channelId: channel.id })).toEqual({ ok: true });
    return socket;
  };
  const actor = await connect();
  const observer = await connect(member);
  const delivered: unknown[] = [];
  observer.on("message:new", (value) => delivered.push(value));
  const typing: unknown[] = [];
  observer.on("typing:start", (value) => typing.push({ event: "typing:start", value }));
  observer.on("typing:stop", (value) => typing.push({ event: "typing:stop", value }));
  return {
    ...options,
    io,
    url,
    channel,
    owner,
    member,
    outsider,
    makeClient,
    connect,
    actor,
    observer,
    delivered,
    typing,
    duplicates,
    manual,
    prefix,
    sockets,
    close,
  };
}

async function barrier() {
  const name = `test:barrier:${randomUUID()}`;
  const received = event(fixture.observer, name);
  const socket = fixture.io.sockets.sockets.get(fixture.observer.id ?? "");
  if (!socket) throw new Error("Observer not connected.");
  // Same outbound websocket as message:new; all preceding frames must arrive first.
  (socket as unknown as { emit(name: string): void }).emit(name);
  await received;
}
async function snapshot() {
  const rows = await connection.db
    .select()
    .from(messages)
    .where(eq(messages.channelId, fixture.channel.id));
  const memberships = await connection.db
    .select()
    .from(channelMembers)
    .where(eq(channelMembers.channelId, fixture.channel.id));
  return { rows, memberships };
}
const payload = () => ({
  channelId: fixture.channel.id,
  body: "Must not escape",
  clientMessageId: randomUUID(),
});
async function rejection(name: string, value: unknown, code: string, socket = fixture.actor) {
  const before = await snapshot();
  const delivered = fixture.delivered.length;
  const typing = fixture.typing.length;
  const error = event(socket, "error");
  expect(await ack(socket, name, value)).toEqual({ ok: false, error: { code } });
  expect(await error).toEqual([{ code }]);
  await barrier();
  expect(await snapshot()).toEqual(before);
  expect(fixture.delivered).toHaveLength(delivered);
  expect(fixture.typing).toHaveLength(typing);
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL_TEST || !process.env.REDIS_URL)
    throw new Error("Dedicated test Postgres and Redis are required.");
  connection = createDatabase(process.env.DATABASE_URL_TEST);
  await migrate(connection.db, { migrationsFolder: "./drizzle" });
  redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false } });
  redis.on("error", () => {});
  await redis.connect();
});
beforeEach(async () => {
  fixture = await setup();
});
afterEach(async () => {
  vi.restoreAllMocks();
  try {
    await Promise.all([...pendingClosers].map((close) => close()));
  } finally {
    pendingClosers.clear();
  }
});
afterAll(async () => {
  try {
    for (const prefix of prefixes)
      for await (const keys of redis.scanIterator({ MATCH: `${prefix}*` }))
        if (keys.length) await redis.del(keys);
    if (ownedChannels.length)
      await connection.db.delete(channels).where(inArray(channels.id, ownedChannels));
    if (ownedUsers.length) await connection.db.delete(users).where(inArray(users.id, ownedUsers));
  } finally {
    await redis?.quit();
    await connection?.pool.end();
  }
});

it.each([
  ["message:send", null],
  ["message:send", { body: 7 }],
  ["message:send", { body: " " }],
  ["message:send", { body: "x".repeat(4001) }],
  ["message:send", { clientMessageId: "x".repeat(129) }],
  ["message:send", { extra: true }],
  ["channel:join", null],
  ["channel:join", { channelId: "invalid" }],
  ["channel:sync", null],
  ["channel:sync", { after: "not-a-cursor" }],
])(
  "rejects malformed %s payload %# with the exact error and no write/delivery",
  async (name, override) => {
    const value = override === null ? null : { ...payload(), ...override };
    const clean =
      name === "message:send"
        ? value
        : override === null
          ? null
          : {
              channelId: fixture.channel.id,
              ...(name === "channel:sync" ? { after: null } : {}),
              ...override,
            };
    await rejection(name, clean, "INVALID_PAYLOAD");
  },
);

it.each(["message:send", "channel:join", "channel:sync"])(
  "rejects a non-member's %s",
  async (name) => {
    const outsider = await fixture.connect(fixture.outsider);
    await rejection(
      name,
      name === "message:send"
        ? payload()
        : { channelId: fixture.channel.id, ...(name === "channel:sync" ? { after: null } : {}) },
      "NOT_A_MEMBER",
      outsider,
    );
    expect(
      fixture.io.sockets.sockets.get(outsider.id ?? "")?.rooms.has(`channel:${fixture.channel.id}`),
    ).toBe(false);
  },
);

it("removes a mid-session member from delivery and rejects subsequent send, join and sync", async () => {
  await connection.db.delete(channelMembers).where(eq(channelMembers.userId, fixture.owner.userId));
  const removed = fixture.actor;
  const received: unknown[] = [];
  removed.on("message:new", (value) => received.push(value));
  const observerLive = event(fixture.observer, "message:new");
  const sent = await ack(fixture.observer, "message:send", payload());
  expect(sent).toMatchObject({ ok: true });
  await observerLive;
  expect(
    fixture.io.sockets.sockets.get(removed.id ?? "")?.rooms.has(`channel:${fixture.channel.id}`),
  ).toBe(false);
  // The removed recipient's own transport is drained before checking non-delivery.
  const marker = event(removed, "test:removed-barrier");
  (
    fixture.io.sockets.sockets.get(removed.id ?? "") as unknown as { emit(name: string): void }
  ).emit("test:removed-barrier");
  await marker;
  expect(received).toEqual([]);
  for (const name of ["message:send", "channel:join", "channel:sync"])
    await rejection(
      name,
      name === "message:send"
        ? payload()
        : { channelId: fixture.channel.id, ...(name === "channel:sync" ? { after: null } : {}) },
      "NOT_A_MEMBER",
      removed,
    );
});

it.each(["message:send", "channel:sync"])(
  "rejects %s at the socket and per-user Redis rate limits",
  async (name) => {
    const value =
      name === "message:send" ? payload() : { channelId: fixture.channel.id, after: null };
    await redis.set(`${fixture.prefix}rate-limit:socket:${fixture.actor.id}`, "30", { EX: 10 });
    await rejection(name, value, "RATE_LIMITED");
    await redis.del(`${fixture.prefix}rate-limit:socket:${fixture.actor.id}`);
    await redis.set(`${fixture.prefix}rate-limit:socket-user:${fixture.owner.userId}`, "120", {
      EX: 10,
    });
    await rejection(name, value, "RATE_LIMITED");
  },
);

it("rejects unknown events and ignores required-ack events without an ack", async () => {
  await rejection("unknown:event", {}, "INVALID_PAYLOAD");
  for (const name of ["message:send", "channel:join", "channel:sync"]) {
    const socket = fixture.io.sockets.sockets.get(fixture.actor.id ?? "");
    if (!socket) throw new Error("Missing actor.");
    const dispatched = deferred();
    socket.once(name as "message:send", () => dispatched.resolve());
    fixture.actor.emit(name, payload());
    await dispatched.promise;
  }
  await barrier();
  expect((await snapshot()).rows).toEqual([]);
  expect(fixture.delivered).toEqual([]);
});

it.each(["channel:join", "channel:sync"])(
  "returns a sanitized ack if %s cannot join its room",
  async (name) => {
    const socket = fixture.io.sockets.sockets.get(fixture.actor.id ?? "");
    if (!socket) throw new Error("Missing actor.");
    vi.spyOn(socket, "join").mockRejectedValueOnce(failure());
    await rejection(
      name,
      { channelId: fixture.channel.id, ...(name === "channel:sync" ? { after: null } : {}) },
      "INTERNAL_ERROR",
    );
  },
);

it("returns a sanitized ack on transaction failure without storing or broadcasting", async () => {
  vi.spyOn(connection.db, "transaction").mockRejectedValueOnce(failure());
  await rejection("message:send", payload(), "INTERNAL_ERROR");
});

it("acknowledges middleware Redis failure before closing and does not leak driver details", async () => {
  vi.spyOn(redis, "get").mockRejectedValueOnce(failure());
  await rejection("message:send", payload(), "INTERNAL_ERROR");
});

it("fails closed if the Redis packet rate limiter fails", async () => {
  vi.spyOn(redis, "sendCommand").mockRejectedValueOnce(failure());
  await rejection("channel:sync", { channelId: fixture.channel.id, after: null }, "INTERNAL_ERROR");
});

it("reports a no-ack middleware failure before disconnecting without broadcasting", async () => {
  const before = await snapshot();
  const error = event(fixture.actor, "error");
  const disconnected = event(fixture.actor, "disconnect");
  vi.spyOn(redis, "get").mockRejectedValueOnce(failure());
  fixture.actor.emit("typing:start", { channelId: fixture.channel.id });
  expect(await error).toEqual([{ code: "INTERNAL_ERROR" }]);
  expect((await disconnected)[0]).toBe("io server disconnect");
  await barrier();
  expect(await snapshot()).toEqual(before);
  expect(fixture.delivered).toEqual([]);
  expect(fixture.typing).toEqual([]);
});

it("returns a sanitized sync-query error after successfully rejoining", async () => {
  const socket = fixture.io.sockets.sockets.get(fixture.actor.id ?? "");
  if (!socket) throw new Error("Missing actor.");
  const join = socket.join.bind(socket);
  vi.spyOn(socket, "join").mockImplementationOnce(async (rooms) => {
    await join(rooms);
    vi.spyOn(connection.db, "select").mockImplementationOnce(() => {
      throw failure();
    });
  });
  await rejection("channel:sync", { channelId: fixture.channel.id, after: null }, "INTERNAL_ERROR");
});

it.each(["revoke", "ban"])("rechecks %s state on every packet", async (action) => {
  if (action === "ban")
    await connection.db
      .update(users)
      .set({ bannedAt: new Date() })
      .where(eq(users.id, fixture.owner.userId));
  else
    await redis.del(
      `${fixture.prefix}session:${fixture.owner.cookie.slice("relay_session=".length)}`,
    );
  await rejection("message:send", payload(), "NOT_AUTHENTICATED");
});

it("returns the identical stored ack for a duplicate ID with no second write or broadcast", async () => {
  const value = payload();
  const live = event(fixture.observer, "message:new");
  const first = await ack(fixture.actor, "message:send", value);
  expect(first).toMatchObject({ ok: true });
  await live;
  const before = await snapshot();
  expect(await ack(fixture.actor, "message:send", { ...value, body: "ignored retry" })).toEqual(
    first,
  );
  await barrier();
  expect(await snapshot()).toEqual(before);
  expect(fixture.delivered).toHaveLength(1);
});

it("keeps a committed message recoverable if delivery fails after commit", async () => {
  const value = payload();
  vi.spyOn(fixture.io, "in").mockImplementationOnce(() => {
    throw failure();
  });
  const error = event(fixture.actor, "error");
  expect(await ack(fixture.actor, "message:send", value)).toEqual({
    ok: false,
    error: { code: "INTERNAL_ERROR" },
  });
  expect(await error).toEqual([{ code: "INTERNAL_ERROR" }]);
  await barrier();
  expect(fixture.delivered).toEqual([]);
  const before = await snapshot();
  expect(before.rows).toHaveLength(1);
  const retry = await ack(fixture.actor, "message:send", value);
  expect(retry).toMatchObject({ ok: true, message: { id: before.rows[0]?.id } });
  const catchup = await ack(fixture.observer, "channel:sync", {
    channelId: fixture.channel.id,
    after: null,
  });
  expect(catchup).toMatchObject({
    ok: true,
    messages: [{ id: before.rows[0]?.id }],
    hasMore: false,
  });
  expect(await snapshot()).toEqual(before);
  expect(fixture.delivered).toEqual([]);
});

it("rejects a transport-sized frame with no application ack, write or broadcast", async () => {
  const before = await snapshot();
  let acknowledgements = 0;
  const disconnected = event(fixture.actor, "disconnect");
  fixture.actor.emit("message:send", { ...payload(), body: "x".repeat(20000) }, () => {
    acknowledgements++;
  });
  const [reason, details] = await disconnected;
  expect(reason).toBe("transport close");
  expect(details).toEqual({ description: "websocket connection closed", code: 1009 });
  await barrier();
  expect(acknowledgements).toBe(0);
  expect(await snapshot()).toEqual(before);
  expect(fixture.delivered).toEqual([]);
});

it.each([
  "missing",
  "forged",
  "oversized-cookie",
  "banned",
  "deleted",
  "session-redis",
  "user-db",
  "handshake-redis",
])("rejects %s handshakes without joining or delivery", async (kind) => {
  const before = await snapshot();
  const headers: Record<string, string> = { Origin: origin, Cookie: fixture.outsider.cookie };
  if (kind === "missing") delete headers.Cookie;
  if (kind === "forged") {
    headers.Origin = `${origin}.evil.example`;
    headers["X-Forwarded-Origin"] = origin;
  }
  if (kind === "oversized-cookie") headers.Cookie = "x".repeat(4097);
  if (kind === "banned")
    await connection.db
      .update(users)
      .set({ bannedAt: new Date() })
      .where(eq(users.id, fixture.outsider.userId));
  if (kind === "deleted")
    await connection.db.delete(users).where(eq(users.id, fixture.outsider.userId));
  if (kind === "session-redis") vi.spyOn(redis, "get").mockRejectedValueOnce(failure());
  if (kind === "user-db")
    vi.spyOn(connection.db, "select").mockImplementationOnce(() => {
      throw failure();
    });
  if (kind === "handshake-redis") vi.spyOn(redis, "sendCommand").mockRejectedValueOnce(failure());
  const socket = fixture.makeClient(headers);
  const rejected = event(socket, "connect_error");
  socket.connect();
  const [error] = await rejected;
  if (["forged", "oversized-cookie", "handshake-redis"].includes(kind))
    expect(error).toEqual({
      message: "websocket error",
      type: "TransportError",
      status: 400,
    });
  else expect(error).toMatchObject({ message: "Unauthorized socket connection." });
  expect(fixture.io.sockets.sockets.size).toBe(2);
  await barrier();
  expect(await snapshot()).toEqual(before);
  expect(fixture.delivered).toEqual([]);
});

it.each(["typing:start", "typing:stop"])(
  "rejects malformed, unauthorized and failed %s",
  async (name) => {
    for (const [value, code] of [
      [null, "INVALID_PAYLOAD"],
      [{ channelId: randomUUID() }, "NOT_A_MEMBER"],
    ] as const) {
      const error = event(fixture.actor, "error");
      fixture.actor.emit(name, value);
      expect(await error).toEqual([{ code }]);
    }
    const serverSocket = fixture.io.sockets.sockets.get(fixture.actor.id ?? "");
    if (!serverSocket) throw new Error("Missing actor.");
    // Inject after real packet authentication so the relay handler's own catch is exercised.
    let injected = false;
    serverSocket.use((packet, next) => {
      if (packet[0] === name && !injected) {
        injected = true;
        vi.spyOn(connection.db, "select").mockImplementationOnce(() => {
          throw failure();
        });
      }
      next();
    });
    const error = event(fixture.actor, "error");
    fixture.actor.emit(name, { channelId: fixture.channel.id });
    expect(await error).toEqual([{ code: "INTERNAL_ERROR" }]);
    await barrier();
    expect((await snapshot()).rows).toEqual([]);
    expect(fixture.delivered).toEqual([]);
    expect(fixture.typing).toEqual([]);
  },
);

it("throttles typing, cancels explicit stops and expires using the injected scheduler", async () => {
  const started = event(fixture.observer, "typing:start");
  fixture.actor.emit("typing:start", { channelId: fixture.channel.id });
  expect(await started).toEqual([{ channelId: fixture.channel.id, userId: fixture.owner.userId }]);
  const updates: unknown[] = [];
  fixture.observer.on("typing:start", (value) => updates.push(value));
  // A following ack on the sender orders the event handling without waiting for a clock.
  fixture.actor.emit("typing:start", { channelId: fixture.channel.id });
  await ack(fixture.actor, "channel:join", { channelId: fixture.channel.id });
  await barrier();
  expect(updates).toEqual([]);
  fixture.manual.advance(1000);
  const again = event(fixture.observer, "typing:start");
  fixture.actor.emit("typing:start", { channelId: fixture.channel.id });
  await again;
  const stopped = event(fixture.observer, "typing:stop");
  fixture.actor.emit("typing:stop", { channelId: fixture.channel.id });
  await stopped;
  expect(fixture.manual.pending()).toBe(0);
  const restart = event(fixture.observer, "typing:start");
  fixture.actor.emit("typing:start", { channelId: fixture.channel.id });
  await restart;
  const expired = event(fixture.observer, "typing:stop");
  await fixture.manual.expire();
  await expired;
  expect(fixture.manual.pending()).toBe(0);
  expect((await snapshot()).rows).toEqual([]);
});

it("renews presence, sweeps offline leases and disconnects revoked sessions on a heartbeat", async () => {
  await redis.zRem(`${fixture.prefix}presence:users`, fixture.owner.userId);
  const online = event(fixture.observer, "presence:update");
  await fixture.manual.tick();
  expect(await online).toEqual([{ userId: fixture.owner.userId, status: "online" }]);
  await redis.zAdd(`${fixture.prefix}presence:users`, { score: 0, value: fixture.outsider.userId });
  await fixture.manual.tick();
  expect(await redis.zScore(`${fixture.prefix}presence:users`, fixture.outsider.userId)).toBeNull();
  await redis.del(
    `${fixture.prefix}session:${fixture.owner.cookie.slice("relay_session=".length)}`,
  );
  const disconnected = event(fixture.actor, "disconnect");
  await fixture.manual.tick();
  expect((await disconnected)[0]).toBe("io server disconnect");
  expect((await snapshot()).rows).toEqual([]);
  expect(fixture.delivered).toEqual([]);
});

it("does not overlap heartbeats and sanitizes heartbeat failures", async () => {
  const entered = deferred();
  const release = deferred();
  const get = redis.get.bind(redis);
  const spy = vi.spyOn(redis, "get").mockImplementationOnce(async (key) => {
    entered.resolve();
    await release.promise;
    return get(key);
  });
  const running = fixture.manual.tick();
  try {
    await entered.promise;
    await fixture.manual.tick();
  } finally {
    release.resolve();
    await running;
  }
  spy.mockRestore();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(redis, "get").mockRejectedValueOnce(failure());
  await fixture.manual.tick();
  expect(log).toHaveBeenCalledExactlyOnceWith("Presence heartbeat failed.");
  await barrier();
  expect((await snapshot()).rows).toEqual([]);
  expect(fixture.delivered).toEqual([]);
});

it("logs Redis adapter error events without exposing client details or broadcasting", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const before = await snapshot();
  for (const duplicate of fixture.duplicates) duplicate.emit("error", failure());
  expect(log.mock.calls).toEqual([
    ["Socket Redis connection error."],
    ["Socket Redis connection error."],
  ]);
  await barrier();
  expect(await snapshot()).toEqual(before);
  expect(fixture.delivered).toEqual([]);
});

it("closes both real Redis adapter clients after disconnect cleanup", async () => {
  const clients = fixture.duplicates;
  const quits = clients.map((duplicate) => vi.spyOn(duplicate, "quit"));
  const before = await snapshot();
  await fixture.close();
  for (const quit of quits) expect(quit).toHaveBeenCalledOnce();
  expect(clients.map((duplicate) => duplicate.isOpen)).toEqual([false, false]);
  expect(await snapshot()).toEqual(before);
  expect(fixture.delivered).toEqual([]);
});

it("destroys an opened publisher on subscriber startup failure and preserves the original error", async () => {
  const clients: ReturnType<typeof redis.duplicate>[] = [];
  const duplicate = redis.duplicate.bind(redis);
  const published = deferred();
  const cause = failure();
  vi.spyOn(redis, "duplicate").mockImplementation(() => {
    const result = duplicate();
    clients.push(result);
    const connect = result.connect.bind(result);
    vi.spyOn(result, "connect").mockImplementation(async () => {
      if (clients.indexOf(result) === 0) {
        const connected = await connect();
        published.resolve();
        return connected;
      }
      await published.promise;
      throw cause;
    });
    return result;
  });
  const before = await snapshot();
  try {
    await expect(
      attachRedisAdapter(fixture.io, redis, `${fixture.prefix}failed-adapter`),
    ).rejects.toBe(cause);
    expect(clients.map((value) => value.isOpen)).toEqual([false, false]);
    await barrier();
    expect(await snapshot()).toEqual(before);
    expect(fixture.delivered).toEqual([]);
  } finally {
    for (const value of clients) if (value.isOpen) value.destroy();
  }
});

it("rejects a changed Origin again at the Socket.IO middleware boundary", async () => {
  const before = await snapshot();
  fixture.io.engine.once("connection", (transport) => {
    // Model a downstream request-header mutation after Engine.IO's upgrade check.
    transport.request.headers.origin = "https://forged.example";
  });
  const socket = fixture.makeClient({ Origin: origin, Cookie: fixture.outsider.cookie });
  const rejected = event(socket, "connect_error");
  socket.connect();
  expect(await rejected).toEqual([
    { message: "Unauthorized socket connection.", type: undefined, status: undefined },
  ]);
  await barrier();
  expect(await snapshot()).toEqual(before);
  expect(fixture.delivered).toEqual([]);
});

it("reports setup failure before disconnecting and drains the rejected background task", async () => {
  const before = await snapshot();
  fixture.io.prependOnceListener("connection", (socket) => {
    vi.spyOn(socket, "join").mockRejectedValueOnce(failure());
  });
  const socket = fixture.makeClient({ Origin: origin, Cookie: fixture.outsider.cookie });
  const error = event(socket, "error");
  const disconnected = event(socket, "disconnect");
  socket.connect();
  expect(await error).toEqual([{ code: "INTERNAL_ERROR" }]);
  expect((await disconnected)[0]).toBe("io server disconnect");
  await barrier();
  expect(await snapshot()).toEqual(before);
  expect(fixture.delivered).toEqual([]);
});

it.each(["join", "presence"])(
  "cleans up a connection closed while initial %s is paused",
  async (stage) => {
    const entered = deferred();
    const release = deferred();
    const disconnectedOnServer = deferred();
    fixture.io.prependOnceListener("connection", (socket) => {
      socket.once("disconnect", () => disconnectedOnServer.resolve());
      if (stage === "join") {
        const join = socket.join.bind(socket);
        vi.spyOn(socket, "join").mockImplementationOnce(async (rooms) => {
          entered.resolve();
          await release.promise;
          await join(rooms);
        });
      }
    });
    if (stage === "presence") {
      const send = redis.sendCommand.bind(redis);
      let paused = false;
      vi.spyOn(redis, "sendCommand").mockImplementation(async (...args) => {
        if (!paused && args[0].at(-2) === "touch" && args[0].at(-4) === fixture.outsider.userId) {
          paused = true;
          entered.resolve();
          await release.promise;
        }
        return send(...args);
      });
    }
    const before = await snapshot();
    const socket = fixture.makeClient({ Origin: origin, Cookie: fixture.outsider.cookie });
    const connected = event(socket, "connect");
    socket.connect();
    try {
      await connected;
      await entered.promise;
      const closed = event(socket, "disconnect");
      socket.disconnect();
      expect((await closed)[0]).toBe("io client disconnect");
      await disconnectedOnServer.promise;
    } finally {
      release.resolve();
    }
    await fixture.close();
    expect(
      await redis.zCard(`${fixture.prefix}presence:connections:${fixture.outsider.userId}`),
    ).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(fixture.delivered).toEqual([]);
  },
);

it.each(["expiry", "disconnect"])("sanitizes typing %s cleanup failures", async (stage) => {
  const before = await snapshot();
  const started = event(fixture.observer, "typing:start");
  fixture.actor.emit("typing:start", { channelId: fixture.channel.id });
  await started;
  const logged = deferred();
  const calls: unknown[] = [];
  vi.spyOn(console, "error").mockImplementation((message) => {
    calls.push(message);
    logged.resolve();
  });
  vi.spyOn(fixture.io, "in").mockImplementationOnce(() => {
    throw failure();
  });
  if (stage === "expiry") await fixture.manual.expire();
  else {
    const closed = event(fixture.actor, "disconnect");
    fixture.actor.disconnect();
    expect((await closed)[0]).toBe("io client disconnect");
  }
  await logged.promise;
  expect(calls).toEqual([stage === "expiry" ? "Typing expiry failed." : "Typing cleanup failed."]);
  await barrier();
  expect(fixture.manual.pending()).toBe(0);
  expect(await snapshot()).toEqual(before);
  expect(fixture.delivered).toEqual([]);
  expect(fixture.typing).toHaveLength(1); // failed cleanup must not invent a stop broadcast
});

it("sanitizes disconnect presence errors and relies on its Redis lease for expiry", async () => {
  const before = await snapshot();
  const logged = deferred();
  const calls: unknown[] = [];
  vi.spyOn(console, "error").mockImplementation((message) => {
    calls.push(message);
    logged.resolve();
  });
  const send = redis.sendCommand.bind(redis);
  vi.spyOn(redis, "sendCommand").mockImplementation(async (...args) => {
    if (args[0].at(-2) === "remove" && args[0].at(-4) === fixture.owner.userId) throw failure();
    return send(...args);
  });
  const closed = event(fixture.actor, "disconnect");
  fixture.actor.disconnect();
  expect((await closed)[0]).toBe("io client disconnect");
  await logged.promise;
  expect(calls).toEqual(["Presence cleanup failed."]);
  expect(
    await redis.pTTL(`${fixture.prefix}presence:connections:${fixture.owner.userId}`),
  ).toBeGreaterThan(0);
  await barrier();
  expect(await snapshot()).toEqual(before);
  expect(fixture.delivered).toEqual([]);
});

it("returns an internal ack if an idempotent message is concurrently hard-deleted", async () => {
  const value = payload();
  const live = event(fixture.observer, "message:new");
  expect(await ack(fixture.actor, "message:send", value)).toMatchObject({ ok: true });
  await live;
  const transaction = connection.db.transaction.bind(connection.db);
  vi.spyOn(connection.db, "transaction").mockImplementationOnce(async (...args) => {
    const result = await transaction(...args);
    await connection.db.delete(messages).where(eq(messages.channelId, fixture.channel.id));
    return result;
  });
  const error = event(fixture.actor, "error");
  expect(await ack(fixture.actor, "message:send", value)).toEqual({
    ok: false,
    error: { code: "INTERNAL_ERROR" },
  });
  expect(await error).toEqual([{ code: "INTERNAL_ERROR" }]);
  await barrier();
  expect((await snapshot()).rows).toEqual([]);
  expect(fixture.delivered).toHaveLength(1);
});

it.each(["carry", "exhausted"])(
  "fails safely in the %s allocation path without changing the shared database high-water mark",
  async (mode) => {
    const previous = mode === "carry" ? `7${"Z".repeat(22)}YZZ` : "Z".repeat(26);
    let allocated: string | undefined;
    const transaction = connection.db.transaction.bind(connection.db);
    vi.spyOn(connection.db, "transaction").mockImplementationOnce((callback) =>
      transaction(async (tx) => {
        // Inject only the high-water query result and an insert fault. The transaction and
        // advisory lock are real; no impossible/future IDs can poison other files' sends.
        const faulted = new Proxy(tx, {
          get(target, property) {
            if (property === "select")
              return () => ({
                from: () => ({ orderBy: () => ({ limit: async () => [{ id: previous }] }) }),
              });
            if (property === "insert")
              return () => ({
                values(value: { id: string }) {
                  allocated = value.id;
                  throw failure();
                },
              });
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return callback(faulted);
      }),
    );
    await rejection("message:send", payload(), "INTERNAL_ERROR");
    expect(allocated).toBe(mode === "carry" ? `7${"Z".repeat(23)}00` : undefined);
  },
);

it.each(["connect", "install"])(
  "cleans both adapter clients on publisher %s failure",
  async (stage) => {
    const before = await snapshot();
    const clients: ReturnType<typeof redis.duplicate>[] = [];
    const duplicate = redis.duplicate.bind(redis);
    const cause = failure();
    vi.spyOn(redis, "duplicate").mockImplementation(() => {
      const value = duplicate();
      clients.push(value);
      if (stage === "connect") vi.spyOn(value, "connect").mockRejectedValue(cause);
      return value;
    });
    if (stage === "install")
      vi.spyOn(fixture.io, "adapter").mockImplementationOnce(() => {
        throw cause;
      });
    try {
      await expect(
        attachRedisAdapter(fixture.io, redis, `${fixture.prefix}failed-start`),
      ).rejects.toBe(cause);
      expect(clients.map((value) => value.isOpen)).toEqual([false, false]);
      await barrier();
      expect(await snapshot()).toEqual(before);
      expect(fixture.delivered).toEqual([]);
    } finally {
      for (const value of clients) if (value.isOpen) value.destroy();
    }
  },
);

it("attempts both adapter QUITs and preserves a close failure after both clients close", async () => {
  const before = await snapshot();
  const isolated = createSocketServer({
    ...fixture,
    httpServer: createServer(),
    scheduler: fixture.manual.scheduler,
  });
  const duplicate = redis.duplicate.bind(redis);
  const clients: ReturnType<typeof redis.duplicate>[] = [];
  vi.spyOn(redis, "duplicate").mockImplementation(() => {
    const value = duplicate();
    clients.push(value);
    return value;
  });
  const close = await attachRedisAdapter(isolated, redis, `${fixture.prefix}close-error`);
  const cause = failure();
  const publisher = clients[0];
  const subscriber = clients[1];
  if (!publisher || !subscriber) throw new Error("Missing Redis duplicates.");
  const quit = publisher.quit.bind(publisher);
  vi.spyOn(publisher, "quit").mockImplementation(async () => {
    await quit();
    throw cause;
  });
  const subscriberQuit = vi.spyOn(subscriber, "quit");
  const ended = deferred();
  subscriber.once("end", () => ended.resolve());
  try {
    await expect(close()).rejects.toBe(cause);
    await ended.promise;
    expect(subscriberQuit).toHaveBeenCalledOnce();
    expect(clients.map((value) => value.isOpen)).toEqual([false, false]);
    await barrier();
    expect(await snapshot()).toEqual(before);
    expect(fixture.delivered).toEqual([]);
  } finally {
    await isolated.close();
    for (const value of clients) if (value.isOpen) value.destroy();
  }
});
