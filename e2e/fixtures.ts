import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { test as base, expect, request, type Page } from "@playwright/test";
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
import { e2eDatabaseUrl } from "./database.js";

export const markupDisplayName = "<img src=x onerror=alert(1)>";

async function closeResources(cleanups: (() => Promise<unknown>)[]) {
  let failures = 0;
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      failures += 1;
    }
  }
  if (failures) throw new Error(`E2E cleanup failed in ${failures} resource(s).`);
}

type ChatFixture = {
  alice: Page;
  bob: Page;
  pages: Page[];
  dialogs: { count: number };
  selectChannel: (page: Page) => Promise<void>;
  draft: (page: Page) => ReturnType<Page["getByRole"]>;
  send: (page: Page, body: string) => Promise<void>;
  disconnectBob: () => Promise<void>;
  reconnectBob: () => Promise<void>;
};

export const test = base.extend<{ chat: ChatFixture }>({
  chat: async ({ browser }, use) => {
    const databaseUrl = e2eDatabaseUrl(process.env);
    if (!process.env.REDIS_URL) throw new Error("E2E requires REDIS_URL.");
    const cleanups: (() => Promise<unknown>)[] = [];
    const { db, pool } = createDatabase(databaseUrl);
    cleanups.push(() => pool.end());
    const redis = createClient({ url: process.env.REDIS_URL });
    redis.on("error", () => console.error("E2E Redis connection error."));
    cleanups.push(async () => {
      if (redis.isOpen) await redis.quit();
    });
    const prefix = `e2e:${randomUUID()}:`;
    const ownedUsers: string[] = [];
    let channelId: string | undefined;
    try {
      await redis.connect();
      cleanups.push(async () => {
        for await (const keys of redis.scanIterator({ MATCH: `${prefix}*` }))
          if (keys.length) await redis.del(keys);
      });
      try {
        await migrate(db, {
          migrationsFolder: fileURLToPath(new URL("../apps/api/drizzle", import.meta.url)),
        });
      } catch {
        throw new Error(
          "E2E migration failed. Create the dedicated database; see docs/testing.md.",
        );
      }
      cleanups.push(async () => {
        if (channelId) await db.delete(channels).where(eq(channels.id, channelId));
        if (ownedUsers.length) await db.delete(users).where(inArray(users.id, ownedUsers));
      });
      const options = {
        db,
        redis,
        allowedOrigins: [],
        redisKeyPrefix: prefix,
        sessionTtlSeconds: 1800,
        sessionAbsoluteTtlSeconds: 86400,
      };
      // Reserve the API port before creating middleware, which copies the Origin allowlist.
      const server = createServer();
      cleanups.push(
        () =>
          new Promise<void>((resolve, reject) => {
            if (!server.listening) return resolve();
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      );
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
      cleanups.push(
        () =>
          new Promise<void>((resolve, reject) =>
            web.httpServer.close((error) => (error ? reject(error) : resolve())),
          ),
      );
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
      // Register IO cleanup even if adapter setup fails; close sockets before its Redis clients.
      const adapter: { close?: () => Promise<void> } = {};
      cleanups.push(async () => {
        await adapter.close?.();
      });
      cleanups.push(() => new Promise<void>((resolve) => io.close(() => resolve())));
      adapter.close = await attachRedisAdapter(io, redis, `${prefix}adapter`);
      const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
      const password = randomBytes(24).toString("base64url");
      const passwordHash = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 1024,
        timeCost: 1,
        parallelism: 1,
      });
      for (const displayName of ["E2E Alice", markupDisplayName]) {
        const [user] = await db
          .insert(users)
          .values({
            email: `${randomUUID()}@example.test`,
            displayName,
            passwordHash,
          })
          .returning({ id: users.id, email: users.email })
          .catch(() => {
            throw new Error("E2E user fixture creation failed.");
          });
        if (!user) throw new Error("E2E user fixture creation failed.");
        ownedUsers.push(user.id);
        const api = await request.newContext({
          baseURL: origin,
          extraHTTPHeaders: { Origin: origin, "x-csrf-request": "1" },
        });
        try {
          // Login once per user per test; storageState is only ever kept in memory.
          const login = await api.post("/api/v1/auth/login", {
            data: { email: user.email, password },
          });
          expect(login.status()).toBe(200);
          const context = await browser.newContext({
            baseURL: origin,
            storageState: await api.storageState(),
          });
          contexts.push(context);
          cleanups.push(() => context.close());
        } finally {
          await api.dispose();
        }
      }
      const [channel] = await db
        .insert(channels)
        .values({
          name: `e2e-${randomUUID()}`,
          createdBy: ownedUsers[0]!,
        })
        .returning()
        .catch(() => {
          throw new Error("E2E channel creation failed.");
        });
      if (!channel) throw new Error("E2E channel creation failed.");
      channelId = channel.id;
      const pages = await Promise.all(contexts.map((context) => context.newPage()));
      const [alice, bob] = pages;
      if (!alice || !bob) throw new Error("Two independent contexts are required.");
      const dialogs = { count: 0 };
      for (const page of pages)
        page.on("dialog", async (dialog) => {
          dialogs.count += 1;
          await dialog.dismiss();
        });
      const draft = (page: Page) =>
        page.getByRole("textbox", {
          name: `Message #${channel.name}`,
          exact: true,
        });
      const selectChannel = async (page: Page) => {
        await page
          .getByRole("navigation", { name: "Channels" })
          .getByRole("button", { name: new RegExp(channel.name) })
          .click();
      };
      await Promise.all(
        pages.map(async (page, index) => {
          await page.goto("/");
          await expect(
            page.getByRole("heading", {
              name: `Welcome, ${index === 0 ? "E2E Alice" : markupDisplayName}.`,
              exact: true,
            }),
          ).toBeVisible();
          await selectChannel(page);
          await page.getByRole("button", { name: "Join channel", exact: true }).click();
          await expect(draft(page)).toBeEnabled();
          await expect(page.getByText("You’re online", { exact: true })).toBeVisible();
        }),
      );
      // UI membership can finish before the client's channel sync joins its live room.
      // Wait on the real adapter state so the first typing/message event cannot race it.
      await expect
        .poll(() =>
          [...io.sockets.sockets.values()]
            .filter((socket) => socket.rooms.has(`channel:${channel.id}`))
            .map((socket) => socket.data.userId)
            .sort(),
        )
        .toEqual([...ownedUsers].sort());
      await use({
        alice,
        bob,
        pages,
        dialogs,
        selectChannel,
        draft,
        send: async (page, body) => {
          await draft(page).fill(body);
          await draft(page).press("Enter");
          await expect(page.getByText(body, { exact: true })).toHaveCount(1);
          await expect(
            page.getByText("Pending · waiting for confirmation", { exact: true }),
          ).toHaveCount(0);
          await expect(page.getByText("Message failed to send", { exact: true })).toHaveCount(0);
        },
        disconnectBob: async () => {
          await bob.context().setOffline(true);
          // Chromium can retain established WS connections while offline. Closing Engine.IO
          // preserves Socket.IO reconnect; a server-side Socket.IO disconnect would not.
          for (const socket of io.sockets.sockets.values())
            if (socket.data.userId === ownedUsers[1]) socket.conn.close();
          await expect(bob.getByText("You’re offline", { exact: true })).toBeVisible();
        },
        reconnectBob: async () => {
          await bob.context().setOffline(false);
          await expect(bob.getByText("You’re online", { exact: true })).toBeVisible();
        },
      });
    } finally {
      // Run every cleanup even when setup, an assertion, or another cleanup fails.
      await closeResources(cleanups);
    }
  },
});

export { expect };
