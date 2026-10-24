import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createClient } from "redis";
import request from "supertest";
import { ulid } from "ulid";
import { createApp } from "../src/app.js";
import { createDatabase, type Database } from "../src/db/client.js";
import { channelMembers, channels, messages, users } from "../src/db/schema.js";
import { createPresenceStore } from "../src/presence.js";

const origin = "http://localhost:5173";
const csrfHeaders = { origin, "x-csrf-request": "1" };
const password = "this-is-a-test-password";
const ownedChannelIds: string[] = [];
const ownedUserIds: string[] = [];
const redisPrefixes: string[] = [];
let db: Database;
let closeDatabase: () => Promise<void>;
let redis: ReturnType<typeof createClient>;

function createTestApp(redisKeyPrefix = `relay:test:channels:${randomUUID()}:`) {
  redisPrefixes.push(redisKeyPrefix);
  return createApp({
    db,
    redis,
    allowedOrigins: [origin],
    nodeEnv: "test",
    sessionTtlSeconds: 60,
    sessionAbsoluteTtlSeconds: 60,
    redisKeyPrefix,
  });
}

function email() {
  return `channels-${randomUUID()}@example.test`;
}

async function register(app: ReturnType<typeof createTestApp>) {
  const agent = request.agent(app);
  const response = await agent
    .post("/api/v1/auth/register")
    .set(csrfHeaders)
    .send({ email: email(), displayName: "Channel test", password })
    .expect(201);
  ownedUserIds.push(response.body.user.id as string);
  return { agent, userId: response.body.user.id as string };
}

async function createChannel(
  agent: ReturnType<typeof request.agent>,
  name: string,
  isPrivate = false,
) {
  const response = await agent
    .post("/api/v1/channels")
    .set(csrfHeaders)
    .send({ name, isPrivate })
    .expect(201);
  ownedChannelIds.push(response.body.channel.id as string);
  return response.body.channel as { id: string; name: string; isPrivate: boolean };
}

async function insertMessages(channelId: string, userId: string, count: number) {
  const entries = Array.from({ length: count }, (_value, index) => {
    const id = ulid(1_700_000_000_000 + index);
    return {
      id,
      channelId,
      userId,
      body: `Message ${index + 1}`,
      clientMessageId: `channel-test-${randomUUID()}`,
    };
  });
  await db.insert(messages).values(entries);
  return entries;
}

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL_TEST;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl) throw new Error("Set DATABASE_URL_TEST to a dedicated test database.");
  if (!redisUrl) throw new Error("Set REDIS_URL for channel integration tests.");

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

describe("channel REST API", () => {
  it("returns caller membership, live presence snapshots, and client message ids in history", async () => {
    const prefix = `relay:test:channel-presence:${randomUUID()}:`;
    const app = createTestApp(prefix);
    const owner = await register(app);
    const outsider = await register(app);
    const channel = await createChannel(owner.agent, `presence-${randomUUID()}`);
    const presence = createPresenceStore(redis, prefix);
    await presence.touch(owner.userId, "presence-test-connection");
    const listed = await outsider.agent.get("/api/v1/channels").expect(200);
    expect(
      listed.body.channels.find((value: { id: string }) => value.id === channel.id),
    ).toMatchObject({ isMember: false, onlineUserIds: [owner.userId] });
    const own = await owner.agent.get("/api/v1/channels").expect(200);
    expect(
      own.body.channels.find((value: { id: string }) => value.id === channel.id).isMember,
    ).toBe(true);
    const inserted = await insertMessages(channel.id, owner.userId, 1);
    const history = await owner.agent.get(`/api/v1/channels/${channel.id}/messages`).expect(200);
    expect(history.body.messages[0].clientMessageId).toBe(inserted[0]?.clientMessageId);
    await presence.remove(owner.userId, "presence-test-connection");
    const offline = await owner.agent.get("/api/v1/channels").expect(200);
    expect(
      offline.body.channels.find((value: { id: string }) => value.id === channel.id).onlineUserIds,
    ).toEqual([]);
  });

  it("enforces membership rules and hides private channels from non-members", async () => {
    const app = createTestApp();
    const owner = await register(app);
    const member = await register(app);
    const outsider = await register(app);
    const privateChannel = await createChannel(owner.agent, `private-${randomUUID()}`, true);
    const publicChannel = await createChannel(owner.agent, `public-${randomUUID()}`);

    const outsiderChannels = await outsider.agent.get("/api/v1/channels").expect(200);
    expect(
      outsiderChannels.body.channels.map((channel: { id: string }) => channel.id),
    ).not.toContain(privateChannel.id);
    expect(outsiderChannels.body.channels.map((channel: { id: string }) => channel.id)).toContain(
      publicChannel.id,
    );
    await outsider.agent
      .post(`/api/v1/channels/${privateChannel.id}/join`)
      .set(csrfHeaders)
      .expect(404);
    await outsider.agent.get(`/api/v1/channels/${privateChannel.id}/messages`).expect(404);

    await db.insert(channelMembers).values({
      channelId: privateChannel.id,
      userId: member.userId,
    });
    await member.agent.get(`/api/v1/channels/${privateChannel.id}/messages`).expect(200);
    await member.agent
      .post(`/api/v1/channels/${privateChannel.id}/leave`)
      .set(csrfHeaders)
      .expect(204);
    await member.agent.get(`/api/v1/channels/${privateChannel.id}/messages`).expect(404);

    await outsider.agent
      .post(`/api/v1/channels/${publicChannel.id}/join`)
      .set(csrfHeaders)
      .expect(204);
    await outsider.agent
      .post(`/api/v1/channels/${publicChannel.id}/leave`)
      .set(csrfHeaders)
      .expect(204);
    await outsider.agent
      .post(`/api/v1/channels/${publicChannel.id}/leave`)
      .set(csrfHeaders)
      .expect(404);
  });

  it("returns newest-first stable message pages at empty and boundary cursors", async () => {
    const app = createTestApp();
    const owner = await register(app);
    const channel = await createChannel(owner.agent, `history-${randomUUID()}`);

    await owner.agent
      .get(`/api/v1/channels/${channel.id}/messages`)
      .expect(200)
      .expect({ messages: [], nextCursor: null });

    const inserted = await insertMessages(channel.id, owner.userId, 3);
    const firstPage = await owner.agent
      .get(`/api/v1/channels/${channel.id}/messages?limit=2`)
      .expect(200);
    expect(firstPage.body.messages.map((message: { id: string }) => message.id)).toEqual([
      inserted[2]?.id,
      inserted[1]?.id,
    ]);
    expect(firstPage.body.nextCursor).toBe(inserted[1]?.id);

    const secondPage = await owner.agent
      .get(`/api/v1/channels/${channel.id}/messages?before=${firstPage.body.nextCursor}&limit=2`)
      .expect(200);
    expect(secondPage.body.messages.map((message: { id: string }) => message.id)).toEqual([
      inserted[0]?.id,
    ]);
    expect(secondPage.body.nextCursor).toBeNull();

    const exactBoundary = await owner.agent
      .get(`/api/v1/channels/${channel.id}/messages?limit=3`)
      .expect(200);
    expect(exactBoundary.body.messages).toHaveLength(3);
    expect(exactBoundary.body.nextCursor).toBeNull();

    await owner.agent
      .get(`/api/v1/channels/${channel.id}/messages?before=${inserted[0]?.id}&limit=2`)
      .expect(200)
      .expect({ messages: [], nextCursor: null });
  });

  it("updates unread counts when a member marks a channel message as read", async () => {
    const app = createTestApp();
    const owner = await register(app);
    const reader = await register(app);
    const channel = await createChannel(owner.agent, `unread-${randomUUID()}`);
    await reader.agent.post(`/api/v1/channels/${channel.id}/join`).set(csrfHeaders).expect(204);
    const inserted = await insertMessages(channel.id, owner.userId, 3);

    const beforeRead = await reader.agent.get("/api/v1/channels").expect(200);
    expect(
      beforeRead.body.channels.find((listed: { id: string }) => listed.id === channel.id)
        .unreadCount,
    ).toBe(3);

    await reader.agent
      .post(`/api/v1/channels/${channel.id}/read`)
      .set(csrfHeaders)
      .send({ messageId: inserted[1]?.id })
      .expect(204);

    const afterRead = await reader.agent.get("/api/v1/channels").expect(200);
    expect(
      afterRead.body.channels.find((listed: { id: string }) => listed.id === channel.id)
        .unreadCount,
    ).toBe(1);
  });
});
