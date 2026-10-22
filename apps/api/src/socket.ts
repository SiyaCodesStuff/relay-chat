import type { Server as HttpServer } from "node:http";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  channelJoinEventSchema,
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

const maxSocketPayloadBytes = 16 * 1024;
const socketEventLimit = 30;
const socketEventWindowMs = 10_000;

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
};

function channelRoom(channelId: string) {
  return `channel:${channelId}`;
}

function messageForClient(message: {
  id: string;
  channelId: string;
  userId: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
}): MessageNew {
  return {
    id: message.id,
    channelId: message.channelId,
    userId: message.userId,
    body: message.body,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
  };
}

function createSocketRateLimiter() {
  let windowStartedAt = Date.now();
  let count = 0;

  return () => {
    const now = Date.now();
    if (now - windowStartedAt >= socketEventWindowMs) {
      windowStartedAt = now;
      count = 0;
    }
    count += 1;
    return count <= socketEventLimit;
  };
}

export function createSocketServer(options: SocketServerOptions) {
  const allowedOrigins = new Set(options.allowedOrigins);
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
  >(options.httpServer, { maxHttpBufferSize: maxSocketPayloadBytes });

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
      connectedSockets
        .filter((socket) => !authorisedUserIds.has(socket.data.userId))
        .map((socket) => socket.leave(room)),
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

  io.on("connection", async (socket) => {
    const initialChannels = await userChannelIds(socket.data.userId);
    await socket.join(initialChannels.map(channelRoom));
    await emitPresence(initialChannels, { userId: socket.data.userId, status: "online" });

    const isRateAllowed = createSocketRateLimiter();
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

    socket.on("channel:join", async (payload, acknowledgement) => {
      if (!isRateAllowed()) {
        reject({ code: "RATE_LIMITED" }, acknowledgement);
        return;
      }
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
    });

    socket.on("message:send", async (payload, acknowledgement) => {
      if (!isRateAllowed()) {
        reject({ code: "RATE_LIMITED" }, acknowledgement);
        return;
      }
      const parsed = messageSendSchema.safeParse(payload);
      if (!parsed.success) {
        reject({ code: "INVALID_PAYLOAD" }, acknowledgement);
        return;
      }
      if (!(await reauthorise(parsed.data.channelId))) {
        reject({ code: "NOT_A_MEMBER" }, acknowledgement);
        return;
      }

      try {
        const [inserted] = await options.db
          .insert(messages)
          .values({
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
            body: messages.body,
            createdAt: messages.createdAt,
            editedAt: messages.editedAt,
          });
        const [stored] = inserted
          ? [inserted]
          : await options.db
              .select({
                id: messages.id,
                channelId: messages.channelId,
                userId: messages.userId,
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
      if (!isRateAllowed()) {
        reject({ code: "RATE_LIMITED" });
        return;
      }
      const parsed = typingEventSchema.safeParse(payload);
      if (!parsed.success) {
        reject({ code: "INVALID_PAYLOAD" });
        return;
      }
      if (!(await reauthorise(parsed.data.channelId))) {
        reject({ code: "NOT_A_MEMBER" });
        return;
      }
      await pruneChannelRoom(parsed.data.channelId);
      socket.to(channelRoom(parsed.data.channelId)).emit(eventName, parsed.data);
    };

    socket.on("typing:start", (payload) => void relayTyping("typing:start", payload));
    socket.on("typing:stop", (payload) => void relayTyping("typing:stop", payload));

    socket.on("disconnect", () => {
      void userChannelIds(socket.data.userId).then((channelIds) =>
        emitPresence(channelIds, { userId: socket.data.userId, status: "offline" }),
      );
    });
  });

  return io;
}
