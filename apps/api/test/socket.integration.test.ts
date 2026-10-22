import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { count, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createClient } from "redis";
import request, { type Response } from "supertest";
import { io as createSocketClient, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  MessageNew,
  MessageSendAcknowledgement,
  ServerToClientEvents,
} from "@relay-chat/shared";
import { createApp } from "../src/app.js";
import { createDatabase, type Database } from "../src/db/client.js";
import { channels, messages, users } from "../src/db/schema.js";
import { createSocketServer } from "../src/socket.js";

const origin = "http://localhost:5173";
const csrfHeaders = { origin, "x-csrf-request": "1" };
const password = "this-is-a-test-password";
const ownedChannelIds: string[] = [];
const ownedUserIds: string[] = [];
const redisPrefixes: string[] = [];
let db: Database;
let closeDatabase: () => Promise<void>;
let redis: ReturnType<typeof createClient>;

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

function sessionCookie(response: Response) {
  const setCookie = response.get("set-cookie");
  const cookie = Array.isArray(setCookie)
    ? setCookie.find((value) => value.startsWith("relay_session="))
    : setCookie;
  const match = cookie?.match(/^(relay_session=[^;]+)/);
  if (!match) throw new Error("Response did not set a session cookie.");
  return match[1];
}

async function startSocketServer() {
  const redisKeyPrefix = `relay:test:socket:${randomUUID()}:`;
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
    httpServer,
    db,
    redis,
    allowedOrigins: [origin],
    sessionTtlSeconds: 60,
    sessionAbsoluteTtlSeconds: 60,
    redisKeyPrefix,
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Could not start Socket.IO test server.");

  return {
    app,
    io,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      io.close();
    },
  };
}

async function register(app: Awaited<ReturnType<typeof startSocketServer>>["app"]) {
  const agent = request.agent(app);
  const response = await agent
    .post("/api/v1/auth/register")
    .set(csrfHeaders)
    .send({
      email: `socket-${randomUUID()}@example.test`,
      displayName: "Socket test",
      password,
    })
    .expect(201);
  ownedUserIds.push(response.body.user.id as string);
  return { agent, cookie: sessionCookie(response), userId: response.body.user.id as string };
}

function connect(url: string, cookie: string, connectionOrigin = origin) {
  const socket: ClientSocket = createSocketClient(url, {
    transports: ["websocket"],
    extraHeaders: { Cookie: cookie, Origin: connectionOrigin },
  });
  return new Promise<ClientSocket>((resolve, reject) => {
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
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
  return new Promise<MessageSendAcknowledgement>((resolve) => {
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
  it("authenticates two clients, persists once, and broadcasts a stored message", async () => {
    const server = await startSocketServer();
    let ownerSocket: ClientSocket | undefined;
    let memberSocket: ClientSocket | undefined;
    try {
      const owner = await register(server.app);
      const member = await register(server.app);
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
      const received = new Promise<MessageNew>((resolve) =>
        memberSocket?.once("message:new", resolve),
      );
      const clientMessageId = `socket-message-${randomUUID()}`;
      const first = await sendMessage(ownerSocket, {
        channelId,
        body: "Stored before broadcast",
        clientMessageId,
      });

      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("Expected successful message acknowledgement.");
      expect(await received).toEqual(first.message);

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
      memberSocket?.disconnect();
      await server.close();
    }
  });

  it("rejects an invalid origin and removes a departed member before the next broadcast", async () => {
    const server = await startSocketServer();
    let ownerSocket: ClientSocket | undefined;
    let memberSocket: ClientSocket | undefined;
    try {
      const owner = await register(server.app);
      const member = await register(server.app);
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
      await new Promise<void>((resolve) => rejected.once("connect_error", () => resolve()));
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
      expect(
        server.io.sockets.sockets.get(memberSocketId)?.rooms.has(`channel:${channelId}`),
      ).toBe(false);
    } finally {
      ownerSocket?.disconnect();
      memberSocket?.disconnect();
      await server.close();
    }
  });
});
