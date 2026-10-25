import type { Server as HttpServer } from "node:http";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import {
  channelJoinEventSchema,
  channelSyncSchema,
  type ClientToServerEvents,
  type MessageNew,
  messageSendSchema,
  type PresenceUpdate,
  type ServerToClientEvents,
  type SocketActionAcknowledgement,
  type SocketError,
  type TypingEvent,
  typingEventSchema,
} from "@relay-chat/shared";
import { Server } from "socket.io";
import {
  createSessionStore,
  readCookie,
  sessionCookieName,
  type RedisConnection,
} from "./auth/session.js";
import type { Database } from "./db/client.js";
import { channelMembers, messages, users } from "./db/schema.js";
import { createPresenceStore } from "./presence.js";
import { createRedisRateLimiter } from "./auth/rate-limit.js";
import { originAllowlist } from "./security.js";

const maxSocketPayloadBytes = 16 * 1024;
const socketEventLimit = 30;

type SocketData = {
  userId: string;
};

export type SocketServerOptions = {
  httpServer: HttpServer;
  db: Database;
  redis: RedisConnection;
  allowedOrigins: readonly string[];
  sessionTtlSeconds: number;
  sessionAbsoluteTtlSeconds: number;
  redisKeyPrefix?: string;
  presenceTtlMs?: number;
  heartbeatIntervalMs?: number;
  typingTtlMs?: number;
};

function channelRoom(channelId: string) {
  return `channel:${channelId}`;
}

function nextMessageId(previous: string | undefined) {
  const candidate = ulid();
  if (!previous || candidate > previous) return candidate;
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const digits = previous.split("");
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const digit = alphabet.indexOf(digits[index] ?? "");
    if (digit < 31) {
      digits[index] = alphabet[digit + 1] ?? "0";
      return digits.join("");
    }
    digits[index] = "0";
  }
  throw new Error("Message id space exhausted.");
}

function messageForClient(message: {
  id: string;
  channelId: string;
  userId: string;
  clientMessageId: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
}): MessageNew {
  return {
    id: message.id,
    channelId: message.channelId,
    userId: message.userId,
    clientMessageId: message.clientMessageId,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
  };
}

export function createSocketServer(options: SocketServerOptions) {
  const presence = createPresenceStore(
    options.redis,
    options.redisKeyPrefix ?? "relay:",
    options.presenceTtlMs ?? 30_000,
  );
  const allowedOrigins = originAllowlist(options.allowedOrigins);
  const redisPrefix = options.redisKeyPrefix ? { keyPrefix: options.redisKeyPrefix } : {};
  const sessions = createSessionStore({
    redis: options.redis,
    ttlSeconds: options.sessionTtlSeconds,
    absoluteTtlSeconds: options.sessionAbsoluteTtlSeconds,
    ...redisPrefix,
  });
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(options.httpServer, {
    maxHttpBufferSize: maxSocketPayloadBytes,
    transports: ["websocket"],
    allowRequest: (request, callback) => {
      void (async () => {
        if (
          !allowedOrigins.has(request.headers.origin ?? "") ||
          (request.headers.cookie?.length ?? 0) > 4096
        )
          return false;
        return rateLimit(request.socket.remoteAddress ?? "unknown", "handshake", 30, 60);
      })().then(
        (allowed) => callback(null, allowed),
        () => callback("Unauthorized socket connection.", false),
      );
    },
  });
  const rateLimit = createRedisRateLimiter({ redis: options.redis, ...redisPrefix });
  const backgroundTasks = new Set<Promise<unknown>>();
  function track<T>(task: Promise<T>) {
    backgroundTasks.add(task);
    void task.then(
      () => backgroundTasks.delete(task),
      () => backgroundTasks.delete(task),
    );
    return task;
  }

  async function isCurrentMember(userId: string, channelId: string) {
    const [membership] = await options.db
      .select({ userId: channelMembers.userId })
      .from(channelMembers)
      .innerJoin(users, eq(users.id, channelMembers.userId))
      .where(
        and(
          eq(channelMembers.userId, userId),
          eq(channelMembers.channelId, channelId),
          isNull(users.bannedAt),
        ),
      );
    return membership !== undefined;
  }

  async function pruneChannelRoom(channelId: string) {
    const room = channelRoom(channelId);
    const connectedSockets = await io.in(room).fetchSockets();
    const userIds = [...new Set(connectedSockets.map((socket) => socket.data.userId))];
    if (userIds.length === 0) return;

    const memberships = await options.db
      .select({ userId: channelMembers.userId })
      .from(channelMembers)
      .innerJoin(users, eq(users.id, channelMembers.userId))
      .where(
        and(
          eq(channelMembers.channelId, channelId),
          inArray(channelMembers.userId, userIds),
          isNull(users.bannedAt),
        ),
      );
    const authorisedUserIds = new Set(memberships.map((membership) => membership.userId));
    await Promise.all(
      connectedSockets.map(async (socket) => {
        const session = authorisedUserIds.has(socket.data.userId)
          ? await sessions.read(
              readCookie(socket.handshake.headers.cookie, sessionCookieName) ?? "",
              false,
            )
          : undefined;
        if (session?.userId !== socket.data.userId) await socket.leave(room);
      }),
    );
  }

  async function emitPresence(channelIds: readonly string[], presence: PresenceUpdate) {
    for (const channelId of channelIds) {
      await pruneChannelRoom(channelId);
      io.to(channelRoom(channelId)).emit("presence:update", presence);
    }
  }

  async function userChannelIds(userId: string) {
    const memberships = await options.db
      .select({ channelId: channelMembers.channelId })
      .from(channelMembers)
      .innerJoin(users, eq(users.id, channelMembers.userId))
      .where(and(eq(channelMembers.userId, userId), isNull(users.bannedAt)));
    return memberships.map((membership) => membership.channelId);
  }

  async function announcePresence(userId: string, status: "online" | "offline") {
    await emitPresence(await userChannelIds(userId), { userId, status });
  }

  let heartbeatRunning = false;
  const heartbeat = setInterval(() => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    void track(
      (async () => {
        for (const socket of io.sockets.sockets.values()) {
          const connectionId = socket.id;
          const userId = socket.data.userId;
          const session = await sessions.read(
            readCookie(socket.handshake.headers.cookie, sessionCookieName) ?? "",
            false,
          );
          if (session?.userId !== userId) {
            socket.disconnect(true);
            continue;
          }
          if ((await presence.touch(userId, connectionId)) === 1)
            await announcePresence(userId, "online");
        }
        for (const userId of await presence.sweep()) await announcePresence(userId, "offline");
      })()
        .catch(() => console.error("Presence heartbeat failed."))
        .finally(() => {
          heartbeatRunning = false;
        }),
    );
  }, options.heartbeatIntervalMs ?? 10_000);
  heartbeat.unref();
  options.httpServer.once("close", () => clearInterval(heartbeat));

  // Socket.IO closes transports synchronously, but our disconnect handlers do Redis/DB work.
  // Keep the adapter's Redis clients alive until that work (including setup) has settled.
  const close = io.close.bind(io);
  io.close = async (callback) => {
    clearInterval(heartbeat);
    let closeError: Error | undefined;
    await close((error) => {
      closeError = error;
    });
    while (backgroundTasks.size > 0) await Promise.allSettled([...backgroundTasks]);
    callback?.(closeError);
  };

  io.use(async (socket, next) => {
    try {
      if (!allowedOrigins.has(socket.handshake.headers.origin ?? "")) {
        next(new Error("Unauthorized socket connection."));
        return;
      }
      const sessionId = readCookie(socket.handshake.headers.cookie, sessionCookieName);
      const session = await sessions.read(sessionId ?? "");
      if (!session) {
        next(new Error("Unauthorized socket connection."));
        return;
      }
      const [user] = await options.db
        .select({ id: users.id, bannedAt: users.bannedAt })
        .from(users)
        .where(eq(users.id, session.userId));
      if (!user || user.bannedAt !== null) {
        next(new Error("Unauthorized socket connection."));
        return;
      }
      socket.data.userId = user.id;
      next();
    } catch {
      next(new Error("Unauthorized socket connection."));
    }
  });

  io.on("connection", (socket) => {
    const typing = new Map<string, { timer: ReturnType<typeof setTimeout>; lastEmitted: number }>();
    const stopTyping = async (channelId: string) => {
      const state = typing.get(channelId);
      if (!state) return;
      clearTimeout(state.timer);
      typing.delete(channelId);
      await pruneChannelRoom(channelId);
      socket
        .to(channelRoom(channelId))
        .emit("typing:stop", { channelId, userId: socket.data.userId });
    };
    socket.once("disconnect", () => {
      for (const channelId of typing.keys())
        void track(stopTyping(channelId).catch(() => console.error("Typing cleanup failed.")));
      void track(
        presence
          .remove(socket.data.userId, socket.id)
          .then(async (transition) => {
            if (transition === -1) await announcePresence(socket.data.userId, "offline");
          })
          .catch(() => console.error("Presence cleanup failed.")),
      );
    });
    const ready = track(
      (async () => {
        const initialChannels = await userChannelIds(socket.data.userId);
        await socket.join(initialChannels.map(channelRoom));
        if (!socket.connected) return;
        if ((await presence.touch(socket.data.userId, socket.id)) === 1)
          await announcePresence(socket.data.userId, "online");
        if (!socket.connected) await presence.remove(socket.data.userId, socket.id);
      })(),
    );
    // Register handlers immediately; queue packets until asynchronous setup finishes.
    socket.use((packet, next) => {
      void (async () => {
        await ready;
        const candidate = packet.at(-1);
        const acknowledgement =
          typeof candidate === "function"
            ? (candidate as (result: SocketActionAcknowledgement) => void)
            : undefined;
        if (
          !(await rateLimit(socket.id, "socket", socketEventLimit, 10)) ||
          !(await rateLimit(socket.data.userId, "socket-user", 120, 10))
        ) {
          reject({ code: "RATE_LIMITED" }, acknowledgement);
          return;
        }
        const session = await sessions.read(
          readCookie(socket.handshake.headers.cookie, sessionCookieName) ?? "",
        );
        const [user] =
          session?.userId === socket.data.userId
            ? await options.db
                .select({ id: users.id })
                .from(users)
                .where(and(eq(users.id, session.userId), isNull(users.bannedAt)))
            : [];
        if (!user) {
          reject({ code: "NOT_AUTHENTICATED" }, acknowledgement);
          socket.disconnect(true);
          return;
        }
        if (
          !["channel:sync", "channel:join", "message:send", "typing:start", "typing:stop"].includes(
            String(packet[0]),
          )
        ) {
          reject({ code: "INVALID_PAYLOAD" }, acknowledgement);
          return;
        }
        next();
      })().catch(() => {
        socket.emit("error", { code: "INTERNAL_ERROR" });
        socket.disconnect(true);
      });
    });
    void ready.catch(() => socket.disconnect(true));

    const reject = <T extends SocketActionAcknowledgement | undefined>(
      error: SocketError,
      acknowledgement?: (result: T) => void,
    ) => {
      socket.emit("error", error);
      if (acknowledgement) acknowledgement({ ok: false, error } as T);
    };
    const reauthorise = async (channelId: string) => {
      const allowed = await isCurrentMember(socket.data.userId, channelId);
      if (!allowed) await socket.leave(channelRoom(channelId));
      return allowed;
    };

    socket.on("channel:sync", async (payload, acknowledgement) => {
      if (typeof acknowledgement !== "function") return;
      try {
        const parsed = channelSyncSchema.safeParse(payload);
        if (!parsed.success) {
          reject({ code: "INVALID_PAYLOAD" }, acknowledgement);
          return;
        }
        if (!(await reauthorise(parsed.data.channelId))) {
          reject({ code: "NOT_A_MEMBER" }, acknowledgement);
          return;
        }
        // Join before taking the history snapshot: overlap is deduped by the client;
        // fetching first could lose a message committed between the query and the join.
        await socket.join(channelRoom(parsed.data.channelId));
        const conditions = [
          eq(messages.channelId, parsed.data.channelId),
          isNull(messages.deletedAt),
        ];
        if (parsed.data.after) conditions.push(gt(messages.id, parsed.data.after));
        const page = await options.db
          .select()
          .from(messages)
          .where(and(...conditions))
          .orderBy(asc(messages.id))
          .limit(101);
        acknowledgement({
          ok: true,
          messages: page.slice(0, 100).map(messageForClient),
          hasMore: page.length > 100,
        });
      } catch {
        reject({ code: "INTERNAL_ERROR" }, acknowledgement);
      }
    });

    socket.on("channel:join", async (payload, acknowledgement) => {
      if (typeof acknowledgement !== "function") return;
      try {
        const parsed = channelJoinEventSchema.safeParse(payload);
        if (!parsed.success) {
          reject({ code: "INVALID_PAYLOAD" }, acknowledgement);
          return;
        }
        if (!(await reauthorise(parsed.data.channelId))) {
          reject({ code: "NOT_A_MEMBER" }, acknowledgement);
          return;
        }
        await socket.join(channelRoom(parsed.data.channelId));
        acknowledgement({ ok: true });
      } catch {
        reject({ code: "INTERNAL_ERROR" }, acknowledgement);
      }
    });

    socket.on("message:send", async (payload, acknowledgement) => {
      if (typeof acknowledgement !== "function") return;
      try {
        const parsed = messageSendSchema.safeParse(payload);
        if (!parsed.success) {
          reject({ code: "INVALID_PAYLOAD" }, acknowledgement);
          return;
        }
        if (!(await reauthorise(parsed.data.channelId))) {
          reject({ code: "NOT_A_MEMBER" }, acknowledgement);
          return;
        }

        // Allocate in commit order across instances, including within one millisecond.
        const [inserted] = await options.db.transaction(async (transaction) => {
          await transaction.execute(sql`SELECT pg_advisory_xact_lock(732194821)`);
          const [latest] = await transaction
            .select({ id: messages.id })
            .from(messages)
            .orderBy(desc(messages.id))
            .limit(1);
          return transaction
            .insert(messages)
            .values({
              id: nextMessageId(latest?.id),
              channelId: parsed.data.channelId,
              userId: socket.data.userId,
              body: parsed.data.body,
              clientMessageId: parsed.data.clientMessageId,
            })
            .onConflictDoNothing({ target: [messages.userId, messages.clientMessageId] })
            .returning({
              id: messages.id,
              channelId: messages.channelId,
              userId: messages.userId,
              clientMessageId: messages.clientMessageId,
              body: messages.body,
              createdAt: messages.createdAt,
              editedAt: messages.editedAt,
            });
        });
        const [stored] = inserted
          ? [inserted]
          : await options.db
              .select({
                id: messages.id,
                channelId: messages.channelId,
                userId: messages.userId,
                clientMessageId: messages.clientMessageId,
                body: messages.body,
                createdAt: messages.createdAt,
                editedAt: messages.editedAt,
              })
              .from(messages)
              .where(
                and(
                  eq(messages.userId, socket.data.userId),
                  eq(messages.clientMessageId, parsed.data.clientMessageId),
                ),
              );
        if (!stored) throw new Error("Stored message was not found.");

        const message = messageForClient(stored);
        if (inserted) {
          await pruneChannelRoom(message.channelId);
          io.to(channelRoom(message.channelId)).emit("message:new", message);
        }
        acknowledgement({ ok: true, message });
      } catch {
        reject({ code: "INTERNAL_ERROR" }, acknowledgement);
      }
    });

    const relayTyping = async (eventName: "typing:start" | "typing:stop", payload: TypingEvent) => {
      const parsed = typingEventSchema.safeParse(payload);
      if (!parsed.success) {
        reject({ code: "INVALID_PAYLOAD" });
        return;
      }
      if (!(await reauthorise(parsed.data.channelId))) {
        reject({ code: "NOT_A_MEMBER" });
        return;
      }
      const channelId = parsed.data.channelId;
      if (eventName === "typing:stop") {
        await stopTyping(channelId);
        return;
      }
      const previous = typing.get(channelId);
      if (previous) clearTimeout(previous.timer);
      const now = Date.now();
      const shouldEmit = !previous || now - previous.lastEmitted >= 1_000;
      const timer = setTimeout(() => {
        void track(stopTyping(channelId).catch(() => console.error("Typing expiry failed.")));
      }, options.typingTtlMs ?? 3_000);
      timer.unref();
      typing.set(channelId, { timer, lastEmitted: shouldEmit ? now : previous.lastEmitted });
      if (!shouldEmit) return;
      await pruneChannelRoom(parsed.data.channelId);
      socket
        .to(channelRoom(parsed.data.channelId))
        .emit(eventName, { ...parsed.data, userId: socket.data.userId });
    };

    socket.on(
      "typing:start",
      (payload) =>
        void relayTyping("typing:start", payload).catch(() => reject({ code: "INTERNAL_ERROR" })),
    );
    socket.on(
      "typing:stop",
      (payload) =>
        void relayTyping("typing:stop", payload).catch(() => reject({ code: "INTERNAL_ERROR" })),
    );
  });

  return io;
}
