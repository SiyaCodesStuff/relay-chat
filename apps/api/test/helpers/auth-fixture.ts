import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import request from "supertest";
import type { createApp } from "../../src/app.js";
import type { Database } from "../../src/db/client.js";
import { users } from "../../src/db/schema.js";
import { createSessionStore, type RedisConnection } from "../../src/auth/session.js";
import { resolvePasswordCosts } from "../../src/auth/password-parameters.js";

export const testPasswordCosts = resolvePasswordCosts("test", {
  memoryCost: 1024,
  timeCost: 1,
  parallelism: 1,
});

export async function createAuthFixture(options: {
  app: ReturnType<typeof createApp>;
  db: Database;
  redis: RedisConnection;
  redisKeyPrefix: string;
  password?: string;
  ownedUserIds: string[];
}) {
  if (process.env.NODE_ENV !== "test") throw new Error("Auth fixtures require NODE_ENV=test.");
  const passwordHash = options.password
    ? await argon2.hash(options.password, { type: argon2.argon2id, ...testPasswordCosts })
    : "!disabled-password-auth-for-test-fixture";
  const [user] = await options.db
    .insert(users)
    .values({
      email: `fixture-${randomUUID()}@example.test`,
      displayName: "Test user",
      passwordHash,
    })
    .returning({ id: users.id, email: users.email });
  if (!user) throw new Error("Could not create test user.");
  options.ownedUserIds.push(user.id);
  const sessionId = await createSessionStore({
    redis: options.redis,
    keyPrefix: options.redisKeyPrefix,
    ttlSeconds: 60,
    absoluteTtlSeconds: 60,
  }).create(user.id);
  const cookie = `relay_session=${sessionId}`;
  const agent = request.agent(options.app);
  agent.jar.setCookie(`${cookie}; Path=/; HttpOnly; SameSite=Lax`, "127.0.0.1", "/");
  return { agent, cookie, userId: user.id, email: user.email };
}
