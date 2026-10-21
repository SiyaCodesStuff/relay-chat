import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "../src/db/schema.js";

const ownedUserIds: string[] = [];
const ownedChannelIds: string[] = [];
let pool: Pool | undefined;
let db: ReturnType<typeof drizzle>;

async function createUser(email: string) {
  const [user] = await db
    .insert(schema.users)
    .values({ email, displayName: "Constraint test", passwordHash: "test-only-hash" })
    .returning({ id: schema.users.id });

  if (!user) throw new Error("Could not create integration-test user.");
  ownedUserIds.push(user.id);
  return user.id;
}

async function createChannel(createdBy: string, name: string) {
  const [channel] = await db
    .insert(schema.channels)
    .values({ name, createdBy })
    .returning({ id: schema.channels.id });

  if (!channel) throw new Error("Could not create integration-test channel.");
  ownedChannelIds.push(channel.id);
  return channel.id;
}

async function expectPostgresConstraint(
  operation: Promise<unknown>,
  code: "23505" | "23514",
  constraint: string,
) {
  const outcome = await operation.then(
    () => ({ error: undefined }),
    (error: unknown) => ({ error }),
  );

  expect(outcome.error).toBeDefined();
  const cause =
    outcome.error instanceof Error && "cause" in outcome.error ? outcome.error.cause : outcome.error;

  expect(cause).toMatchObject({ code, constraint });
}

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL_TEST;
  if (!databaseUrl) throw new Error("Set DATABASE_URL_TEST to a dedicated test database.");

  pool = new Pool({ connectionString: databaseUrl });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: "./drizzle" });
});

afterAll(async () => {
  try {
    if (ownedChannelIds.length > 0) {
      await db.delete(schema.channels).where(inArray(schema.channels.id, ownedChannelIds));
    }
    if (ownedUserIds.length > 0) {
      await db.delete(schema.users).where(inArray(schema.users.id, ownedUserIds));
    }
  } finally {
    await pool?.end();
  }
});

describe("PostgreSQL schema constraints", () => {
  const suffix = randomUUID();

  it("enforces email uniqueness without regard to case", async () => {
    const email = `Case-${suffix}@example.test`;
    await createUser(email);

    await expectPostgresConstraint(
      db.insert(schema.users).values({
        email: email.toLowerCase(),
        displayName: "Duplicate email",
        passwordHash: "test-only-hash",
      }),
      "23505",
      "users_email_lower_unique",
    );
  });

  it("enforces unique channel names", async () => {
    const ownerId = await createUser(`channel-${suffix}@example.test`);
    const name = `unique-${suffix}`;
    await createChannel(ownerId, name);

    await expectPostgresConstraint(
      db.insert(schema.channels).values({ name, createdBy: ownerId }),
      "23505",
      "channels_name_unique",
    );
  });

  it("allows only one membership for each channel and user", async () => {
    const userId = await createUser(`member-${suffix}@example.test`);
    const channelId = await createChannel(userId, `member-channel-${suffix}`);
    const membership = { channelId, userId };
    await db.insert(schema.channelMembers).values(membership);

    await expectPostgresConstraint(
      db.insert(schema.channelMembers).values(membership),
      "23505",
      "channel_members_pkey",
    );
  });

  it("rejects blank and overlong message bodies", async () => {
    const userId = await createUser(`body-${suffix}@example.test`);
    const channelId = await createChannel(userId, `body-channel-${suffix}`);

    await expectPostgresConstraint(
      db.insert(schema.messages).values({
        channelId,
        userId,
        body: " \t\n ",
        clientMessageId: `blank-${suffix}`,
      }),
      "23514",
      "messages_body_nonempty_max_length_check",
    );
    await expectPostgresConstraint(
      db.insert(schema.messages).values({
        channelId,
        userId,
        body: "x".repeat(4_001),
        clientMessageId: `long-${suffix}`,
      }),
      "23514",
      "messages_body_nonempty_max_length_check",
    );
  });

  it("enforces per-user client message idempotency across channels", async () => {
    const userId = await createUser(`idempotency-${suffix}@example.test`);
    const firstChannelId = await createChannel(userId, `first-${suffix}`);
    const secondChannelId = await createChannel(userId, `second-${suffix}`);
    const clientMessageId = `client-${suffix}`;
    await db.insert(schema.messages).values({
      channelId: firstChannelId,
      userId,
      body: "first send",
      clientMessageId,
    });

    await expectPostgresConstraint(
      db.insert(schema.messages).values({
        channelId: secondChannelId,
        userId,
        body: "duplicate send",
        clientMessageId,
      }),
      "23505",
      "messages_user_client_message_unique",
    );
  });
});
