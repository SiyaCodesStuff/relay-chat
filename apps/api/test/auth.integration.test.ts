import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createClient } from "redis";
import request, { type Response } from "supertest";
import { createApp } from "../src/app.js";
import { createDatabase, type Database } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";

const origin = "http://localhost:5173";
const csrfHeaders = { origin, "x-csrf-request": "1" };
const password = "this-is-a-test-password";
const ownedUserIds: string[] = [];
const prefixes: string[] = [];
let db: Database;
let closeDatabase: () => Promise<void>;
let redis: ReturnType<typeof createClient>;

function newPrefix() {
  const prefix = `relay:test:auth:${randomUUID()}:`;
  prefixes.push(prefix);
  return prefix;
}

function authApp(
  prefix = newPrefix(),
  limits?: { login?: { limit: number; windowSeconds: number } },
) {
  return createApp({
    db,
    redis,
    allowedOrigins: [origin],
    nodeEnv: "test",
    sessionTtlSeconds: 60,
    sessionAbsoluteTtlSeconds: 60,
    redisKeyPrefix: prefix,
    ...(limits?.login ? { loginRateLimit: limits.login } : {}),
  });
}

function email() {
  return `auth-${randomUUID()}@example.test`;
}

function sessionId(response: Response) {
  const setCookie = response.get("set-cookie");
  const cookie = Array.isArray(setCookie)
    ? setCookie.find((value) => value.startsWith("relay_session="))
    : setCookie;
  const match = cookie?.match(/^relay_session=([^;]+)/);
  if (!match) throw new Error("Response did not set a session cookie.");
  return match[1];
}

async function register(agent: ReturnType<typeof request.agent>, address = email()) {
  const response = await agent
    .post("/api/v1/auth/register")
    .set(csrfHeaders)
    .send({ email: address, displayName: "Auth test", password })
    .expect(201);
  ownedUserIds.push(response.body.user.id as string);
  return response;
}

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL_TEST;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl) throw new Error("Set DATABASE_URL_TEST to a dedicated test database.");
  if (!redisUrl) throw new Error("Set REDIS_URL for auth integration tests.");

  const connection = createDatabase(databaseUrl);
  db = connection.db;
  closeDatabase = () => connection.pool.end();
  await migrate(db, { migrationsFolder: "./drizzle" });

  redis = createClient({ url: redisUrl });
  await redis.connect();
});

afterAll(async () => {
  try {
    for (const prefix of prefixes) {
      for await (const keys of redis.scanIterator({ MATCH: `${prefix}*` })) {
        if (keys.length > 0) await redis.del(keys);
      }
    }
    if (ownedUserIds.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, ownedUserIds));
    }
  } finally {
    await redis.quit();
    await closeDatabase();
  }
});

describe("authentication", () => {
  it("registers, logs in, reports the current user, and logs out", async () => {
    const app = authApp();
    const agent = request.agent(app);
    const address = email();
    const registration = await register(agent, address.toUpperCase());

    expect(registration.body.user).toMatchObject({
      email: address,
      displayName: "Auth test",
      role: "user",
    });
    await agent.get("/api/v1/auth/me").expect(200).expect({ user: registration.body.user });

    await agent.post("/api/v1/auth/logout").set(csrfHeaders).expect(204);
    await agent.get("/api/v1/auth/me").expect(401).expect(authFailure());

    const loggedIn = await agent
      .post("/api/v1/auth/login")
      .set(csrfHeaders)
      .send({ email: address, password })
      .expect(200);
    expect(loggedIn.body.user).toEqual(registration.body.user);
  });

  it("invalidates the pre-login session when login rotates its id", async () => {
    const app = authApp();
    const agent = request.agent(app);
    const address = email();
    const registration = await register(agent, address);
    const oldSessionId = sessionId(registration);

    const login = await agent
      .post("/api/v1/auth/login")
      .set(csrfHeaders)
      .send({ email: address, password })
      .expect(200);
    expect(sessionId(login)).not.toBe(oldSessionId);

    await request(app)
      .get("/api/v1/auth/me")
      .set("Cookie", `relay_session=${oldSessionId}`)
      .expect(401)
      .expect(authFailure());
    await agent.get("/api/v1/auth/me").expect(200);
  });

  it("slides idle expiry but rejects sessions beyond their absolute lifetime", async () => {
    const prefix = newPrefix();
    const app = authApp(prefix);
    const agent = request.agent(app);
    const registration = await register(agent);
    const currentSessionId = sessionId(registration);
    const currentKey = `${prefix}session:${currentSessionId}`;

    await redis.expire(currentKey, 1);
    await agent.get("/api/v1/auth/me").expect(200);
    expect(await redis.ttl(currentKey)).toBeGreaterThan(55);

    const expiredId = randomBytes(32).toString("base64url");
    await redis.set(
      `${prefix}session:${expiredId}`,
      JSON.stringify({ userId: registration.body.user.id, createdAt: Date.now() - 61_000 }),
      { EX: 60 },
    );
    await request(app)
      .get("/api/v1/auth/me")
      .set("Cookie", `relay_session=${expiredId}`)
      .expect(401)
      .expect(authFailure());
    expect(await redis.get(`${prefix}session:${expiredId}`)).toBeNull();
  });

  it("rejects state-changing requests without both the CSRF header and an allowed origin", async () => {
    const app = authApp();
    const body = { email: email(), displayName: "CSRF test", password };

    await request(app)
      .post("/api/v1/auth/register")
      .send(body)
      .expect(403)
      .expect({ error: "CSRF_REJECTED" });
    await request(app)
      .post("/api/v1/auth/register")
      .set("x-csrf-request", "1")
      .set("origin", "https://untrusted.example")
      .send(body)
      .expect(403)
      .expect({ error: "CSRF_REJECTED" });
  });

  it("shares Redis-backed login limits across app instances", async () => {
    const prefix = newPrefix();
    const limits = { login: { limit: 2, windowSeconds: 60 } };
    const first = authApp(prefix, limits);
    const second = authApp(prefix, limits);
    const body = { email: email(), password };

    await request(first)
      .post("/api/v1/auth/login")
      .set(csrfHeaders)
      .send(body)
      .expect(401)
      .expect(authFailure());
    await request(second)
      .post("/api/v1/auth/login")
      .set(csrfHeaders)
      .send(body)
      .expect(401)
      .expect(authFailure());
    await request(first)
      .post("/api/v1/auth/login")
      .set(csrfHeaders)
      .send(body)
      .expect(429)
      .expect({ error: "RATE_LIMITED" });
  });

  it("reads a ban made after login before authorising the next request", async () => {
    const app = authApp();
    const agent = request.agent(app);
    const registration = await register(agent);

    await db
      .update(schema.users)
      .set({ bannedAt: new Date() })
      .where(eq(schema.users.id, registration.body.user.id));

    await agent.get("/api/v1/auth/me").expect(401).expect(authFailure());
  });
});

function authFailure() {
  return { error: "AUTHENTICATION_FAILED" };
}
