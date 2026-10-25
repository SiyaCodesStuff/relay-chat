import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { count, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createClient } from "redis";
import request from "supertest";
import { io as createSocketClient, type Socket, type ManagerOptions } from "socket.io-client";
import type {
  ChannelSyncAcknowledgement,
  ClientToServerEvents,
  MessageNew,
  MessageSendAcknowledgement,
  ServerToClientEvents,
} from "@relay-chat/shared";
import { createApp } from "../src/app.js";
import { createDatabase, type Database } from "../src/db/client.js";
import { channels, messages, users } from "../src/db/schema.js";
import { createSocketServer } from "../src/socket.js";
import { createPresenceStore } from "../src/presence.js";
import { attachRedisAdapter } from "../src/socket-adapter.js";
import { createReliableChatClient } from "@relay-chat/shared";
import { measureFixture, reportFixtureTimings } from "./helpers/fixture-timing.js";
import { createAuthFixture } from "./helpers/auth-fixture.js";

const origin = "http://localhost:5173";
const csrfHeaders = { origin, "x-csrf-request": "1" };
const ownedChannelIds: string[] = [];
const ownedUserIds: string[] = [];
const redisPrefixes: string[] = [];
let db: Database;
let closeDatabase: () => Promise<void>;
let redis: ReturnType<typeof createClient>;

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const testReconnection = {
  reconnectionDelay: 1,
  reconnectionDelayMax: 5,
  randomizationFactor: 0,
};
const realSetTimeout = setTimeout;
const realClearTimeout = clearTimeout;

function waitFor<T = void>(
  label: string,
  subscribe: (resolve: (value: T) => void, reject: (error: Error) => void) => void | (() => void),
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let cleanup: () => void = () => {};
    const timer = realSetTimeout(() => {
      cleanup?.();
      reject(new Error(`Timed out waiting for ${label}`));
    }, 2_000);
    const finish = (action: () => void) => {
      realClearTimeout(timer);
      cleanup?.();
      action();
    };
    cleanup =
      subscribe(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      ) ?? (() => {});
  });
}

function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function waitForGate<T>(label: string, barrier: ReturnType<typeof gate<T>>) {
  return waitFor<T>(label, (resolve, reject) => {
    void barrier.promise.then(resolve, reject);
  });
}

async function startSocketServer(redisKeyPrefix = `relay:test:socket:${randomUUID()}:`) {
  redisPrefixes.push(redisKeyPrefix);
  const app = createApp({
    db,
    redis,
    allowedOrigins: [origin],
    nodeEnv: "test",
    sessionTtlSeconds: 60,
    sessionAbsoluteTtlSeconds: 60,
    redisKeyPrefix,
  });
  const httpServer = createServer(app);
  const io = createSocketServer({
    typingTtlMs: 100,
    httpServer,
    db,
    redis,
    allowedOrigins: [origin],
    sessionTtlSeconds: 60,
    sessionAbsoluteTtlSeconds: 60,
    redisKeyPrefix,
  });
  const closeAdapter = await attachRedisAdapter(io, redis, `${redisKeyPrefix}socket.io`);
  await waitFor("test HTTP server listening", (resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Could not start Socket.IO test server.");

  return {
    app,
    io,
    redisKeyPrefix,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await io.close();
      await closeAdapter();
    },
  };
}

async function createUserFixture(server: Awaited<ReturnType<typeof startSocketServer>>) {
  return measureFixture("sockets:user-session", () =>
    createAuthFixture({
      app: server.app,
      db,
      redis,
      redisKeyPrefix: server.redisKeyPrefix,
      ownedUserIds,
    }),
  );
}
afterAll(reportFixtureTimings);

function connect(
  url: string,
  cookie: string,
  connectionOrigin = origin,
  reconnection: Partial<ManagerOptions> = {},
) {
  const socket: ClientSocket = createSocketClient(url, {
    reconnection: false,
    ...reconnection,
    transports: ["websocket"],
    extraHeaders: { Cookie: cookie, Origin: connectionOrigin },
  });
  return waitFor<ClientSocket>("socket connect (or connect_error)", (resolve, reject) => {
    const connected = () => resolve(socket);
    const failed = (error: Error) => {
      socket.disconnect();
      reject(error);
    };
    socket.once("connect", connected);
    socket.once("connect_error", failed);
    return () => {
      socket.off("connect", connected);
      socket.off("connect_error", failed);
    };
  });
}

function sendMessage(
  socket: ClientSocket,
  payload: {
    channelId: string;
    body: string;
    clientMessageId: string;
  },
) {
  return waitFor<MessageSendAcknowledgement>("message:send acknowledgement", (resolve) => {
    socket.emit("message:send", payload, resolve);
  });
}

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL_TEST;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl) throw new Error("Set DATABASE_URL_TEST to a dedicated test database.");
  if (!redisUrl) throw new Error("Set REDIS_URL for socket integration tests.");

  const connection = createDatabase(databaseUrl);
  db = connection.db;
  closeDatabase = () => connection.pool.end();
  await migrate(db, { migrationsFolder: "./drizzle" });

  redis = createClient({ url: redisUrl });
  await redis.connect();
});

afterAll(async () => {
  try {
    for (const prefix of redisPrefixes) {
      for await (const keys of redis.scanIterator({ MATCH: `${prefix}*` })) {
        if (keys.length > 0) await redis.del(keys);
      }
    }
    if (ownedChannelIds.length > 0) {
      await db.delete(channels).where(inArray(channels.id, ownedChannelIds));
    }
    if (ownedUserIds.length > 0) {
      await db.delete(users).where(inArray(users.id, ownedUserIds));
    }
  } finally {
    await redis.quit();
    await closeDatabase();
  }
});

describe("Socket.IO chat events", () => {
  let fixtureServer: Awaited<ReturnType<typeof startSocketServer>>;
  let fixtureOwner: Awaited<ReturnType<typeof createUserFixture>>;
  let fixtureMember: Awaited<ReturnType<typeof createUserFixture>>;

  // Create users/sessions directly; auth hashing is tested by the auth suite.
  beforeEach(async () => {
    fixtureServer = await startSocketServer();
    fixtureOwner = await createUserFixture(fixtureServer);
    fixtureMember = await createUserFixture(fixtureServer);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixtureServer?.close();
  });

  it("rejects cross-origin, missing-origin and tampered-session handshakes, including forged allowed Origins", async () => {
    const server = fixtureServer;
    const cookie = fixtureOwner.cookie;
    const tampered = cookie.slice(0, -1) + (cookie.at(-1) === "A" ? "B" : "A");
    for (const headers of [
      { Cookie: cookie, Origin: "https://evil.example", "X-Forwarded-Origin": origin },
      { Cookie: cookie, Origin: `${origin}.evil.example` },
      { Cookie: cookie, Origin: "null" },
      { Cookie: cookie },
      { Cookie: tampered, Origin: origin },
      { Cookie: `${cookie}; ${cookie}`, Origin: origin },
      { Origin: origin },
    ]) {
      const rejected = createSocketClient(server.url, {
        reconnection: false,
        transports: ["websocket"],
        extraHeaders: headers,
      });
      try {
        await waitFor("security handshake rejection", (resolve, reject) => {
          rejected.once("connect_error", () => resolve());
          rejected.once("connect", () => reject(new Error("Unauthorized socket connected.")));
        });
      } finally {
        rejected.disconnect();
      }
    }
    expect(server.io.sockets.sockets.size).toBe(0);
  });

  it("stores XSS as text, bounds message input, and rate-limits no-ack floods and new tabs", async () => {
    const server = fixtureServer;
    const sockets: ClientSocket[] = [];
    try {
      const created = await fixtureOwner.agent
        .post("/api/v1/channels")
        .set(csrfHeaders)
        .send({ name: `security-${randomUUID()}` })
        .expect(201);
      const channelId = created.body.channel.id as string;
      ownedChannelIds.push(channelId);
      const sender = await connect(server.url, fixtureOwner.cookie);
      sockets.push(sender);
      const xss = '<img src=x onerror="alert(document.cookie)"><script>alert(1)</script>';
      const stored = await sendMessage(sender, {
        channelId,
        body: xss,
        clientMessageId: randomUUID(),
      });
      expect(stored.ok && stored.message.body === xss).toBe(true);
      const history = await fixtureOwner.agent
        .get(`/api/v1/channels/${channelId}/messages`)
        .expect(200);
      expect(history.body.messages[0].body).toBe(xss);
      const invalid = await sendMessage(sender, {
        channelId,
        body: "x".repeat(4001),
        clientMessageId: randomUUID(),
      });
      expect(invalid).toEqual({ ok: false, error: { code: "INVALID_PAYLOAD" } });
      const flood = waitFor("no-ack socket flood rejection", (resolve) => {
        sender.on("error", (error) => {
          if (error.code === "RATE_LIMITED") resolve();
        });
      });
      for (let index = 0; index < 31; index += 1) sender.emit("typing:start", { channelId });
      await flood;
      expect(
        Number(await redis.get(`${server.redisKeyPrefix}rate-limit:socket:${sender.id}`)),
      ).toBeGreaterThanOrEqual(31);
      // A new connection has a new socket budget, but shares its user's Redis budget.
      await redis.set(
        `${server.redisKeyPrefix}rate-limit:socket-user:${fixtureOwner.userId}`,
        "120",
        { EX: 10 },
      );
      const tab = await connect(server.url, fixtureOwner.cookie);
      sockets.push(tab);
      expect(
        await sendMessage(tab, { channelId, body: "blocked", clientMessageId: randomUUID() }),
      ).toEqual({ ok: false, error: { code: "RATE_LIMITED" } });
      const oversized = await connect(server.url, fixtureOwner.cookie);
      sockets.push(oversized);
      const disconnected = waitFor("oversized transport frame rejection", (resolve) => {
        oversized.once("disconnect", () => resolve());
      });
      oversized.emit(
        "message:send",
        { channelId, body: "x".repeat(20_000), clientMessageId: randomUUID() },
        () => {},
      );
      await disconnected;
      const [persisted] = await db
        .select({ count: count() })
        .from(messages)
        .where(eq(messages.channelId, channelId));
      expect(Number(persisted?.count)).toBe(1);
    } finally {
      for (const socket of sockets) socket.disconnect();
    }
  });

  it("shares the Redis handshake flood limit across API instances", async () => {
    const server = fixtureServer;
    const second = await startSocketServer(server.redisKeyPrefix);
    try {
      await redis.set(`${server.redisKeyPrefix}rate-limit:handshake:127.0.0.1`, "30", { EX: 60 });
      for (const url of [server.url, second.url]) {
        const rejected = createSocketClient(url, {
          reconnection: false,
          transports: ["websocket"],
          extraHeaders: { Origin: origin, Cookie: fixtureOwner.cookie },
        });
        try {
          await waitFor("shared handshake flood rejection", (resolve, reject) => {
            rejected.once("connect_error", () => resolve());
            rejected.once("connect", () => reject(new Error("Handshake flood limit bypassed.")));
          });
        } finally {
          rejected.disconnect();
        }
      }
    } finally {
      await second.close();
    }
  });

  it("prunes a revoked session before passive delivery and rejects its next action", async () => {
    const server = fixtureServer;
    const sockets: ClientSocket[] = [];
    try {
      const created = await fixtureOwner.agent
        .post("/api/v1/channels")
        .set(csrfHeaders)
        .send({ name: `revoked-${randomUUID()}` })
        .expect(201);
      const channelId = created.body.channel.id as string;
      ownedChannelIds.push(channelId);
      await fixtureMember.agent
        .post(`/api/v1/channels/${channelId}/join`)
        .set(csrfHeaders)
        .expect(204);
      const sender = await connect(server.url, fixtureOwner.cookie);
      const receiver = await connect(server.url, fixtureMember.cookie);
      sockets.push(sender, receiver);
      await waitFor("revocation join barrier", (resolve) => {
        receiver.emit("channel:join", { channelId }, () => resolve());
      });
      const receiverId = receiver.id ?? "";
      await redis.del(
        `${server.redisKeyPrefix}session:${fixtureMember.cookie.slice("relay_session=".length)}`,
      );
      const sent = await sendMessage(sender, {
        channelId,
        body: "Active sessions only",
        clientMessageId: randomUUID(),
      });
      expect(sent.ok).toBe(true);
      expect(server.io.sockets.sockets.get(receiverId)?.rooms.has(`channel:${channelId}`)).toBe(
        false,
      );
      expect(
        await sendMessage(receiver, { channelId, body: "revoked", clientMessageId: randomUUID() }),
      ).toEqual({ ok: false, error: { code: "NOT_AUTHENTICATED" } });
    } finally {
      for (const socket of sockets) socket.disconnect();
    }
  });

  it("catches up after a disconnect without missing or duplicating messages", async () => {
    const server = fixtureServer;
    const sockets: ClientSocket[] = [];
    let client: ReturnType<typeof createReliableChatClient> | undefined;
    try {
      const owner = fixtureOwner;
      const reader = fixtureMember;
      const created = await owner.agent
        .post("/api/v1/channels")
        .set(csrfHeaders)
        .send({ name: `reconnect-${randomUUID()}` })
        .expect(201);
      const channelId = created.body.channel.id as string;
      ownedChannelIds.push(channelId);
      await reader.agent.post(`/api/v1/channels/${channelId}/join`).set(csrfHeaders).expect(204);
      const sender = await connect(server.url, owner.cookie);
      const receiver = await connect(server.url, reader.cookie, origin, {
        reconnection: true,
        ...testReconnection,
      });
      sockets.push(sender, receiver);
      let onSynced = () => {};
      let onSyncFailure: (error: Error) => void = () => {};
      const initialSync = waitFor("initial channel:sync / onSynced", (resolve, reject) => {
        onSyncFailure = reject;
        onSynced = resolve;
      });
      const received: MessageNew[] = [];
      const errors: string[] = [];
      client = createReliableChatClient({
        socket: receiver,
        channels: { [channelId]: null },
        onMessage: (message) => received.push(message),
        onSendState: () => {},
        acknowledgementTimeoutMs: 1_000,
        onSyncError: (_channel, error) => {
          errors.push(error);
          onSyncFailure(new Error(`channel:sync failed: ${error}`));
        },
        onSynced: () => onSynced(),
      });
      await initialSync;
      const stored: MessageNew[] = [];
      const send = async () => {
        const result = await sendMessage(sender, {
          channelId,
          body: `Message ${stored.length}`,
          clientMessageId: randomUUID(),
        });
        if (!result.ok) throw new Error(result.error.code);
        stored.push(result.message);
      };
      const firstLive = waitFor("first live message:new", (resolve) => {
        receiver.once("message:new", () => resolve());
      });
      await send();
      await firstLive;
      expect(client.getLastSeen()[channelId]).toBe(stored[0]?.id);
      receiver.disconnect();
      await send();
      await send();
      await send();
      const resynced = waitFor("reconnect channel:sync / onSynced", (resolve, reject) => {
        onSyncFailure = reject;
        onSynced = resolve;
      });
      receiver.connect();
      await resynced;
      expect(errors).toEqual([]);
      expect(received).toEqual(stored);
      expect(new Set(received.map((message) => message.id)).size).toBe(stored.length);
      // A repeated reconnect with the same cursor must not re-deliver history.
      const repeat = waitFor("repeat channel:sync / onSynced", (resolve, reject) => {
        onSyncFailure = reject;
        onSynced = resolve;
      });
      await client.reconnect();
      await repeat;
      expect(received).toEqual(stored);

      const automatic = waitFor(
        "automatic reconnect channel:sync / onSynced",
        (resolve, reject) => {
          onSynced = resolve;
          onSyncFailure = reject;
        },
      );
      const reconnectAttempt = waitFor("Manager reconnect_attempt", (resolve) => {
        receiver.io.once("reconnect_attempt", () => resolve());
      });
      receiver.io.engine.close();
      await reconnectAttempt;
      await automatic;
      expect(received).toEqual(stored);
    } finally {
      client?.dispose();
      for (const socket of sockets) socket.disconnect();
    }
  });

  it("rejoins before fetching and merges messages sent across both catch-up boundaries", async () => {
    const server = fixtureServer;
    const sockets: ClientSocket[] = [];
    const allowJoin = gate();
    const joining = gate();
    const snapshot = gate<() => void>();
    let client: ReturnType<typeof createReliableChatClient> | undefined;
    try {
      const created = await fixtureOwner.agent
        .post("/api/v1/channels")
        .set(csrfHeaders)
        .send({ name: `sync-race-${randomUUID()}` })
        .expect(201);
      const channelId = created.body.channel.id as string;
      ownedChannelIds.push(channelId);
      await fixtureMember.agent
        .post(`/api/v1/channels/${channelId}/join`)
        .set(csrfHeaders)
        .expect(204);
      const sender = await connect(server.url, fixtureOwner.cookie);
      const receiver = await connect(server.url, fixtureMember.cookie);
      sockets.push(sender, receiver);
      // Intentionally paused delivery must not consume the client's acknowledgement budget.
      // Socket transports already captured their real timers; named waits and Vitest's
      // unchanged test deadline also remain real. Only the client's timeout clock is paused.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const received: MessageNew[] = [];
      const stored: MessageNew[] = [];
      let onSynced = () => {};
      let onSyncFailure: (error: Error) => void = () => {};
      const initial = waitFor("race test initial channel:sync", (resolve, reject) => {
        onSynced = resolve;
        onSyncFailure = reject;
      });
      client = createReliableChatClient({
        socket: receiver,
        channels: { [channelId]: null },
        acknowledgementTimeoutMs: 1_000,
        onMessage: (message) => received.push(message),
        onSendState: () => {},
        onSyncError: (_channel, error) => onSyncFailure(new Error(error)),
        onSynced: () => onSynced(),
      });
      await initial;
      const send = async (body: string) => {
        const result = await sendMessage(sender, {
          channelId,
          body,
          clientMessageId: randomUUID(),
        });
        if (!result.ok) throw new Error(result.error.code);
        stored.push(result.message);
        return result.message;
      };
      const serverSocket = server.io.sockets.sockets.get(receiver.id ?? "");
      if (!serverSocket) throw new Error("Race test receiver missing on server.");
      // Remove the automatic connection-time room join so it cannot mask a bad sync order.
      await serverSocket.leave(`channel:${channelId}`);
      await send("offline before sync");
      const join = serverSocket.join.bind(serverSocket);
      vi.spyOn(serverSocket, "join").mockImplementation(async (rooms) => {
        joining.resolve();
        await allowJoin.promise;
        await join(rooms);
        // This one must appear in both live delivery and the subsequent history snapshot.
        await send("live and history overlap");
      });
      serverSocket.use((packet, next) => {
        if (packet[0] === "channel:sync") {
          const acknowledge = packet[2] as (result: ChannelSyncAcknowledgement) => void;
          packet[2] = (result: ChannelSyncAcknowledgement) => {
            snapshot.resolve(() => acknowledge(result));
          };
        }
        next();
      });
      const synced = waitFor("gated catch-up onSynced", (resolve, reject) => {
        onSynced = resolve;
        onSyncFailure = reject;
      });
      const syncing = client.reconnect();
      await waitForGate("sync room join starting", joining);
      // A fetch-before-join implementation has already taken its snapshot and loses this one.
      await send("committed while room join is paused");
      allowJoin.resolve();
      const deliverHistory = await waitForGate("history snapshot acknowledgement", snapshot);
      const live = waitFor("live message after history snapshot", (resolve) => {
        const listener = (message: MessageNew) => {
          if (message.body === "committed after history snapshot") resolve();
        };
        receiver.on("message:new", listener);
        return () => {
          receiver.off("message:new", listener);
        };
      });
      await send("committed after history snapshot");
      await live;
      deliverHistory();
      await synced;
      await syncing;
      expect(received).toEqual(stored);
      expect(client.getMessages()).toEqual(stored);
      expect(new Set(received.map((message) => message.id)).size).toBe(stored.length);
    } finally {
      allowJoin.resolve();
      client?.dispose();
      vi.useRealTimers();
      for (const socket of sockets) socket.disconnect();
    }
  });

  it("awaits disconnect cleanup before allowing the Redis adapter to close", async () => {
    const server = fixtureServer;
    const socket = await connect(server.url, fixtureOwner.cookie);
    const removeStarted = gate();
    const allowRemove = gate();
    const sendCommand = redis.sendCommand.bind(redis);
    const commandSpy = vi.spyOn(redis, "sendCommand").mockImplementation(async (...args) => {
      if (args[0][0] === "EVAL" && args[0].at(-2) === "remove") {
        removeStarted.resolve();
        await allowRemove.promise;
      }
      return sendCommand(...args);
    });
    let closed = false;
    const httpClosed = waitFor("HTTP server close", (resolve) => {
      server.io.httpServer.once("close", () => resolve());
    });
    const closing = server.io.close().then(() => {
      closed = true;
    });
    try {
      await waitForGate("presence.remove during shutdown", removeStarted);
      // The ordinary HTTP close callback must have completed too, making this independent of timing.
      await httpClosed;
      await waitFor("HTTP close promise continuations", (resolve) => {
        setImmediate(resolve);
      });
      expect(closed, "Socket shutdown must await the paused presence removal").toBe(false);
    } finally {
      allowRemove.resolve();
      await closing;
      commandSpy.mockRestore();
      socket.disconnect();
    }
    expect(
      await redis.zCard(`${server.redisKeyPrefix}presence:connections:${fixtureOwner.userId}`),
    ).toBe(0);
  });

  it("delivers across two instances and counts one user's tabs across both", async () => {
    const prefix = fixtureServer.redisKeyPrefix;
    const first = fixtureServer;
    const second = await startSocketServer(prefix);
    const sockets: ClientSocket[] = [];
    try {
      expect(first.url).not.toBe(second.url);
      const owner = fixtureOwner;
      const member = fixtureMember;
      await request(second.app).get("/api/v1/auth/me").set("Cookie", owner.cookie).expect(200);
      const created = await owner.agent
        .post("/api/v1/channels")
        .set(csrfHeaders)
        .send({ name: `cluster-${randomUUID()}` })
        .expect(201);
      const channelId = created.body.channel.id as string;
      ownedChannelIds.push(channelId);
      await member.agent.post(`/api/v1/channels/${channelId}/join`).set(csrfHeaders).expect(204);
      const observer = await connect(second.url, member.cookie);
      sockets.push(observer);
      const join = (socket: ClientSocket) =>
        waitFor("channel:join acknowledgement", (resolve, reject) => {
          socket.emit("channel:join", { channelId }, (result) =>
            result.ok ? resolve() : reject(new Error(result.error.code)),
          );
        });
      await join(observer);
      const online = waitFor<unknown>("online presence:update", (resolve) => {
        observer.once("presence:update", resolve);
      });
      const ownerA = await connect(first.url, owner.cookie);
      sockets.push(ownerA);
      await join(ownerA);
      expect(await online).toEqual({ userId: owner.userId, status: "online" });
      const ownerB = await connect(second.url, owner.cookie);
      sockets.push(ownerB);
      await join(ownerB);
      expect(await redis.zCard(`${prefix}presence:connections:${owner.userId}`)).toBe(2);

      const received = waitFor<MessageNew>("cross-instance message:new", (resolve) => {
        observer.once("message:new", resolve);
      });
      const result = await sendMessage(ownerA, {
        channelId,
        body: "Across instances",
        clientMessageId: randomUUID(),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Message send failed.");
      expect(await received).toEqual(result.message);

      // Observe server-side disconnect completion before issuing the next Redis barrier.
      const serverSocket = first.io.sockets.sockets.get(ownerA.id ?? "");
      if (!serverSocket) throw new Error("First instance socket missing.");
      const disconnected = waitFor("server disconnect", (resolve) => {
        serverSocket.once("disconnect", () => resolve());
      });
      ownerA.disconnect();
      await disconnected;
      await join(ownerB);
      expect(await redis.zCard(`${prefix}presence:connections:${owner.userId}`)).toBe(1);
      expect(await redis.zScore(`${prefix}presence:users`, owner.userId)).not.toBeNull();
      const offline = waitFor<unknown>("offline presence:update", (resolve) => {
        observer.once("presence:update", resolve);
      });
      ownerB.disconnect();
      expect(await offline).toEqual({ userId: owner.userId, status: "offline" });
      expect(await redis.zCard(`${prefix}presence:connections:${owner.userId}`)).toBe(0);
      expect(await redis.zScore(`${prefix}presence:users`, owner.userId)).toBeNull();
      const polling = await fetch(`${first.url}/socket.io/?EIO=4&transport=polling`);
      expect(polling.status).toBe(400);
    } finally {
      for (const socket of sockets) socket.disconnect();
      await second.close();
    }
  });

  it("authenticates two clients, persists once, and broadcasts a stored message", async () => {
    const server = fixtureServer;
    let ownerSocket: ClientSocket | undefined;
    let memberSocket: ClientSocket | undefined;
    let secondTab: ClientSocket | undefined;
    try {
      const owner = fixtureOwner;
      const member = fixtureMember;
      const channelResponse = await owner.agent
        .post("/api/v1/channels")
        .set(csrfHeaders)
        .send({ name: `socket-${randomUUID()}`, isPrivate: false })
        .expect(201);
      const channelId = channelResponse.body.channel.id as string;
      ownedChannelIds.push(channelId);
      await member.agent.post(`/api/v1/channels/${channelId}/join`).set(csrfHeaders).expect(204);

      ownerSocket = await connect(server.url, owner.cookie);
      memberSocket = await connect(server.url, member.cookie);
      // The join acknowledgement is a barrier for asynchronous connection setup.
      await waitFor("member channel:join acknowledgement", (resolve) => {
        memberSocket?.emit("channel:join", { channelId }, () => resolve());
      });
      const typingStarted = waitFor<unknown>("typing:start", (resolve) => {
        memberSocket?.once("typing:start", resolve);
      });
      const typingStopped = waitFor<unknown>("typing:stop expiry", (resolve) => {
        memberSocket?.once("typing:stop", resolve);
      });
      ownerSocket.emit("typing:start", { channelId });
      expect(await typingStarted).toEqual({ channelId, userId: owner.userId });
      expect(await typingStopped).toEqual({ channelId, userId: owner.userId });
      secondTab = await connect(server.url, owner.cookie);
      await waitFor("second tab channel:join acknowledgement", (resolve) => {
        secondTab?.emit("channel:join", { channelId }, () => resolve());
      });
      expect(
        await redis.zCard(`${server.redisKeyPrefix}presence:connections:${owner.userId}`),
      ).toBe(2);
      const secondTabOnServer = server.io.sockets.sockets.get(secondTab.id ?? "");
      if (!secondTabOnServer) throw new Error("Second tab missing on server.");
      const secondTabDisconnected = waitFor("second tab server disconnect", (resolve) => {
        secondTabOnServer.once("disconnect", () => resolve());
      });
      secondTab.disconnect();
      await secondTabDisconnected;
      const received = waitFor<MessageNew>("member message:new", (resolve) => {
        memberSocket?.once("message:new", resolve);
      });
      const clientMessageId = `socket-message-${randomUUID()}`;
      const first = await sendMessage(ownerSocket, {
        channelId,
        body: "Stored before broadcast",
        clientMessageId,
      });

      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("Expected successful message acknowledgement.");
      expect(await received).toEqual(first.message);
      expect(
        await redis.zCard(`${server.redisKeyPrefix}presence:connections:${owner.userId}`),
      ).toBe(1);
      expect(
        await redis.zScore(`${server.redisKeyPrefix}presence:users`, owner.userId),
      ).not.toBeNull();

      const duplicate = await sendMessage(ownerSocket, {
        channelId,
        body: "Different body is ignored for an idempotent retry",
        clientMessageId,
      });
      expect(duplicate).toEqual(first);
      const [storedCount] = await db
        .select({ count: count() })
        .from(messages)
        .where(eq(messages.clientMessageId, clientMessageId));
      expect(Number(storedCount?.count)).toBe(1);
    } finally {
      ownerSocket?.disconnect();
      secondTab?.disconnect();
      memberSocket?.disconnect();
    }
  });

  it("rejects an invalid origin and removes a departed member before the next broadcast", async () => {
    const server = fixtureServer;
    let ownerSocket: ClientSocket | undefined;
    let memberSocket: ClientSocket | undefined;
    try {
      const owner = fixtureOwner;
      const member = fixtureMember;
      const channelResponse = await owner.agent
        .post("/api/v1/channels")
        .set(csrfHeaders)
        .send({ name: `socket-removal-${randomUUID()}`, isPrivate: false })
        .expect(201);
      const channelId = channelResponse.body.channel.id as string;
      ownedChannelIds.push(channelId);
      await member.agent.post(`/api/v1/channels/${channelId}/join`).set(csrfHeaders).expect(204);

      const rejected = createSocketClient(server.url, {
        transports: ["websocket"],
        extraHeaders: { Cookie: member.cookie, Origin: "https://untrusted.example" },
      });
      await waitFor("invalid-origin connect_error", (resolve) => {
        rejected.once("connect_error", () => resolve());
      });
      rejected.disconnect();

      ownerSocket = await connect(server.url, owner.cookie);
      memberSocket = await connect(server.url, member.cookie);
      await member.agent.post(`/api/v1/channels/${channelId}/leave`).set(csrfHeaders).expect(204);

      const acknowledgement = await sendMessage(ownerSocket, {
        channelId,
        body: "Members only",
        clientMessageId: `socket-removal-${randomUUID()}`,
      });
      expect(acknowledgement.ok).toBe(true);
      if (!memberSocket) throw new Error("Member socket did not connect.");
      const memberSocketId = memberSocket.id;
      if (!memberSocketId) throw new Error("Member socket has no id.");
      expect(server.io.sockets.sockets.get(memberSocketId)?.rooms.has(`channel:${channelId}`)).toBe(
        false,
      );
    } finally {
      ownerSocket?.disconnect();
      memberSocket?.disconnect();
    }
  });
});

describe("Redis presence leases", () => {
  it("counts two tabs and expires a crashed connection lease in Redis", async () => {
    const prefix = `relay:test:presence:${randomUUID()}:`;
    redisPrefixes.push(prefix);
    const presence = createPresenceStore(redis, prefix, 100);
    const userId = randomUUID();
    expect(await presence.touch(userId, "tab-one")).toBe(1);
    expect(await presence.touch(userId, "tab-two")).toBe(0);
    expect(await presence.remove(userId, "tab-one")).toBe(0);
    expect(await presence.sweep()).toEqual([]);
    // No disconnect cleanup or heartbeat: simulate a crashed instance.
    await expect
      .poll(() => presence.sweep(), {
        message: "Redis must expire the crashed connection lease and report the offline transition",
      })
      .toEqual([userId]);
    expect(await presence.sweep()).toEqual([]);
    expect(await redis.exists(`${prefix}presence:connections:${userId}`)).toBe(0);
  });
});
