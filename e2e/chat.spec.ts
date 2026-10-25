import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { test, expect, request } from "@playwright/test";
import { preview } from "vite";
import { createClient } from "redis";
import argon2 from "argon2";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createApp } from "../apps/api/src/app.js";
import { createDatabase } from "../apps/api/src/db/client.js";
import { channels, users } from "../apps/api/src/db/schema.js";
import { createSocketServer } from "../apps/api/src/socket.js";
import { attachRedisAdapter } from "../apps/api/src/socket-adapter.js";

test("two users join, exchange live messages and typing, and catch up after a network loss", async ({
  browser,
}, testInfo) => {
  const databaseUrl = process.env.DATABASE_URL_TEST;
  if (!databaseUrl || databaseUrl === process.env.DATABASE_URL || !process.env.REDIS_URL)
    throw new Error("E2E requires a dedicated DATABASE_URL_TEST and REDIS_URL.");
  const { db, pool } = createDatabase(databaseUrl);
  const redis = createClient({ url: process.env.REDIS_URL });
  redis.on("error", () => console.error("E2E Redis connection error."));
  const prefix = `e2e:${randomUUID()}:`;
  const ownedUsers: string[] = [];
  let channelId: string | undefined;
  await redis.connect();
  const options = {
    db,
    redis,
    allowedOrigins: [],
    redisKeyPrefix: prefix,
    sessionTtlSeconds: 1800,
    sessionAbsoluteTtlSeconds: 86400,
  };
  // Reserve a port before creating middleware: the app copies its Origin allowlist.
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("E2E API did not bind.");
  const target = `http://127.0.0.1:${address.port}`;
  const web = await preview({
    root: fileURLToPath(new URL("../apps/web", import.meta.url)),
    preview: {
      host: "127.0.0.1",
      port: 0,
      proxy: {
        "/api": { target, changeOrigin: false },
        "/socket.io": { target, ws: true, changeOrigin: false },
      },
    },
  });
  const webAddress = web.httpServer.address();
  if (!webAddress || typeof webAddress === "string") throw new Error("E2E web did not bind.");
  const origin = `http://127.0.0.1:${webAddress.port}`;
  server.on(
    "request",
    createApp({
      ...options,
      allowedOrigins: [origin],
      nodeEnv: "test",
      passwordCosts: { memoryCost: 1024, timeCost: 1, parallelism: 1 },
    }),
  );
  const io = createSocketServer({ ...options, allowedOrigins: [origin], httpServer: server });
  const closeAdapter = await attachRedisAdapter(io, redis, `${prefix}adapter`);
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  try {
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../apps/api/drizzle", import.meta.url)),
    });
    const password = randomBytes(24).toString("base64url");
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 1024,
      timeCost: 1,
      parallelism: 1,
    });
    for (const displayName of ["E2E Alice", "E2E Bob"]) {
      const [user] = await db
        .insert(users)
        .values({ email: `${randomUUID()}@example.test`, displayName, passwordHash })
        .returning({ id: users.id, email: users.email });
      if (!user) throw new Error("E2E fixture creation failed.");
      ownedUsers.push(user.id);
      const api = await request.newContext({
        baseURL: origin,
        extraHTTPHeaders: {
          Origin: origin,
          "x-csrf-request": "1",
        },
      });
      try {
        // Exactly one API login per user; reuse its cookie state in a separate browser context.
        const login = await api.post("/api/v1/auth/login", {
          data: { email: user.email, password },
        });
        expect(login.status()).toBe(200);
        const storageState = await api.storageState();
        contexts.push(await browser.newContext({ baseURL: origin, storageState }));
      } finally {
        await api.dispose();
      }
    }
    const [channel] = await db
      .insert(channels)
      .values({ name: `e2e-${randomUUID()}`, createdBy: ownedUsers[0]! })
      .returning();
    if (!channel) throw new Error("E2E channel creation failed.");
    channelId = channel.id;
    const pages = await Promise.all(contexts.map((context) => context.newPage()));
    const [alice, bob] = pages;
    if (!alice || !bob) throw new Error("Two independent contexts are required.");
    await Promise.all(
      pages.map(async (page) => {
        await page.goto("/");
        await page
          .getByRole("navigation", { name: "Channels" })
          .getByRole("button", { name: new RegExp(channel.name) })
          .click();
        await page.getByRole("button", { name: "Join channel", exact: true }).click();
        await expect(
          page.getByRole("textbox", { name: `Message #${channel.name}`, exact: true }),
        ).toBeEnabled();
        await expect(page.getByText("You’re online", { exact: true })).toBeVisible();
      }),
    );
    const draft = (page: typeof alice) =>
      page.getByRole("textbox", { name: `Message #${channel.name}`, exact: true });
    const send = async (page: typeof alice, body: string) => {
      await draft(page).fill(body);
      await draft(page).press("Enter");
      await expect(page.getByText(body, { exact: true })).toHaveCount(1);
      await expect(
        page.getByText("Pending · waiting for confirmation", { exact: true }),
      ).toHaveCount(0);
    };
    await draft(alice).fill("Live from Alice");
    await expect(bob.getByLabel("Typing indicator")).toContainText("Someone is typing");
    await draft(alice).press("Enter");
    for (const page of pages)
      await expect(page.getByText("Live from Alice", { exact: true })).toHaveCount(1);
    await send(bob, "Live from Bob");
    await expect(alice.getByText("Live from Bob", { exact: true })).toHaveCount(1);
    await contexts[1]!.setOffline(true);
    // Close the real transport too: Chromium can retain established websockets when offline.
    // Engine.IO close preserves Socket.IO's automatic reconnect (server disconnect does not).
    for (const socket of io.sockets.sockets.values())
      if (socket.data.userId === ownedUsers[1]) socket.conn.close();
    await expect(bob.getByText("You’re offline", { exact: true })).toBeVisible();
    await send(alice, "Missed one");
    await send(alice, "Missed two");
    await expect(bob.getByText("Missed one", { exact: true })).toHaveCount(0);
    await contexts[1]!.setOffline(false);
    await expect(bob.getByText("You’re online", { exact: true })).toBeVisible();
    for (const page of pages) {
      for (const body of ["Live from Alice", "Live from Bob", "Missed one", "Missed two"])
        await expect(page.getByText(body, { exact: true })).toHaveCount(1);
      await expect(
        page.getByRole("list", { name: "Message history" }).locator("p.whitespace-pre-wrap"),
      ).toHaveText(["Live from Alice", "Live from Bob", "Missed one", "Missed two"]);
    }
  } finally {
    const closed = await Promise.allSettled(contexts.map((context) => context.close()));
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await closeAdapter();
    await new Promise<void>((resolve, reject) =>
      web.httpServer.close((error) => (error ? reject(error) : resolve())),
    );
    if (channelId) await db.delete(channels).where(eq(channels.id, channelId));
    if (ownedUsers.length) await db.delete(users).where(inArray(users.id, ownedUsers));
    for await (const keys of redis.scanIterator({ MATCH: `${prefix}*` }))
      if (keys.length) await redis.del(keys);
    await redis.quit();
    await pool.end();
    if (testInfo.status === "passed")
      expect(closed.map((result) => result.status)).toEqual(contexts.map(() => "fulfilled"));
  }
});
