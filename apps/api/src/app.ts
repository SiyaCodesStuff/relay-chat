import argon2 from "argon2";
import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  channelIdParamsSchema,
  createChannelRequestSchema,
  listMessagesQuerySchema,
  loginRequestSchema,
  markChannelReadRequestSchema,
  registerRequestSchema,
} from "@relay-chat/shared";
import { createRedisRateLimiter } from "./auth/rate-limit.js";
import { createSessionStore, sessionCookieName, type RedisConnection } from "./auth/session.js";
import type { Database } from "./db/client.js";
import { channelMembers, channels, messages, users } from "./db/schema.js";

const csrfHeader = "x-csrf-request";
const authFailure = { error: "AUTHENTICATION_FAILED" };

export type AuthAppOptions = {
  db: Database;
  redis: RedisConnection;
  allowedOrigins: readonly string[];
  nodeEnv: "development" | "test" | "production";
  sessionTtlSeconds: number;
  sessionAbsoluteTtlSeconds: number;
  redisKeyPrefix?: string;
  loginRateLimit?: { limit: number; windowSeconds: number };
  registerRateLimit?: { limit: number; windowSeconds: number };
};

function readCookie(request: Request, name: string) {
  const cookies = request.header("cookie");
  if (!cookies) return undefined;
  for (const entry of cookies.split(";")) {
    const [key, ...value] = entry.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function setSessionCookie(response: Response, id: string, secure: boolean) {
  response.cookie(sessionCookieName, id, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
  });
}

function clearSessionCookie(response: Response, secure: boolean) {
  response.clearCookie(sessionCookieName, { httpOnly: true, sameSite: "lax", secure, path: "/" });
}

function identity(user: {
  id: string;
  email: string;
  displayName: string;
  role: "user" | "admin";
}) {
  return { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
}

function invalidRequest(response: Response) {
  response.status(400).json({ error: "INVALID_REQUEST" });
}

function notFound(response: Response) {
  response.status(404).json({ error: "NOT_FOUND" });
}

export function createApp(options: AuthAppOptions) {
  const app = express();
  const secureCookie = options.nodeEnv === "production";
  const allowedOrigins = new Set(options.allowedOrigins);
  const redisPrefix = options.redisKeyPrefix ? { keyPrefix: options.redisKeyPrefix } : {};
  const sessions = createSessionStore({
    redis: options.redis,
    ttlSeconds: options.sessionTtlSeconds,
    absoluteTtlSeconds: options.sessionAbsoluteTtlSeconds,
    ...redisPrefix,
  });
  const isRateAllowed = createRedisRateLimiter({
    redis: options.redis,
    ...redisPrefix,
  });
  const loginRateLimit = options.loginRateLimit ?? { limit: 10, windowSeconds: 600 };
  const registerRateLimit = options.registerRateLimit ?? { limit: 5, windowSeconds: 600 };

  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));
  app.get("/healthz", (_request, response) => response.status(200).json({ status: "ok" }));

  function requireCsrf(request: Request, response: Response, next: NextFunction) {
    if (request.header(csrfHeader) !== "1" || !allowedOrigins.has(request.header("origin") ?? "")) {
      response.status(403).json({ error: "CSRF_REJECTED" });
      return;
    }
    next();
  }

  async function requireSession(request: Request, response: Response, next: NextFunction) {
    const sessionId = readCookie(request, sessionCookieName);
    const session = await sessions.read(sessionId ?? "");
    if (!session) {
      clearSessionCookie(response, secureCookie);
      response.status(401).json(authFailure);
      return;
    }

    const [user] = await options.db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        bannedAt: users.bannedAt,
      })
      .from(users)
      .where(eq(users.id, session.userId));

    if (!user || user.bannedAt !== null) {
      await sessions.destroy(sessionId);
      clearSessionCookie(response, secureCookie);
      response.status(401).json(authFailure);
      return;
    }

    response.locals.authenticatedUser = user;
    next();
  }

  async function findAccessibleChannel(channelId: string, userId: string) {
    const [channel] = await options.db
      .select({
        id: channels.id,
        name: channels.name,
        isPrivate: channels.isPrivate,
        createdBy: channels.createdBy,
        memberUserId: channelMembers.userId,
        memberRole: channelMembers.role,
      })
      .from(channels)
      .leftJoin(
        channelMembers,
        and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, userId)),
      )
      .where(eq(channels.id, channelId));

    if (!channel || (channel.isPrivate && channel.memberUserId === null)) return undefined;
    return channel;
  }

  app.post("/api/v1/auth/register", requireCsrf, async (request, response, next) => {
    try {
      const payload = registerRequestSchema.safeParse(request.body);
      if (!payload.success) {
        response.status(400).json({ error: "INVALID_REQUEST" });
        return;
      }
      if (
        !(await isRateAllowed(
          request.ip ?? "unknown",
          "register",
          registerRateLimit.limit,
          registerRateLimit.windowSeconds,
        ))
      ) {
        response.status(429).json({ error: "RATE_LIMITED" });
        return;
      }

      const passwordHash = await argon2.hash(payload.data.password, { type: argon2.argon2id });
      const [user] = await options.db
        .insert(users)
        .values({
          email: payload.data.email,
          displayName: payload.data.displayName,
          passwordHash,
        })
        .returning({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          role: users.role,
        });
      if (!user) throw new Error("User creation did not return a user.");

      await sessions.destroy(readCookie(request, sessionCookieName));
      setSessionCookie(response, await sessions.create(user.id), secureCookie);
      response.status(201).json({ user: identity(user) });
    } catch (error) {
      const cause = error instanceof Error && "cause" in error ? error.cause : error;
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "23505"
      ) {
        response.status(409).json({ error: "REGISTRATION_FAILED" });
        return;
      }
      next(error);
    }
  });

  app.post("/api/v1/auth/login", requireCsrf, async (request, response, next) => {
    try {
      const payload = loginRequestSchema.safeParse(request.body);
      if (!payload.success) {
        response.status(400).json({ error: "INVALID_REQUEST" });
        return;
      }
      if (
        !(await isRateAllowed(
          request.ip ?? "unknown",
          "login",
          loginRateLimit.limit,
          loginRateLimit.windowSeconds,
        ))
      ) {
        response.status(429).json({ error: "RATE_LIMITED" });
        return;
      }

      const [user] = await options.db
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          passwordHash: users.passwordHash,
          role: users.role,
          bannedAt: users.bannedAt,
        })
        .from(users)
        .where(eq(users.email, payload.data.email));
      const passwordMatches = user
        ? await argon2.verify(user.passwordHash, payload.data.password)
        : false;

      if (!user || !passwordMatches || user.bannedAt !== null) {
        response.status(401).json(authFailure);
        return;
      }

      await sessions.destroy(readCookie(request, sessionCookieName));
      setSessionCookie(response, await sessions.create(user.id), secureCookie);
      response.status(200).json({ user: identity(user) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/v1/auth/logout", requireCsrf, async (request, response, next) => {
    try {
      await sessions.destroy(readCookie(request, sessionCookieName));
      clearSessionCookie(response, secureCookie);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/auth/me", requireSession, (_request, response) => {
    response.status(200).json({ user: identity(response.locals.authenticatedUser) });
  });

  app.post("/api/v1/channels", requireSession, requireCsrf, async (request, response, next) => {
    try {
      const payload = createChannelRequestSchema.safeParse(request.body);
      if (!payload.success) {
        invalidRequest(response);
        return;
      }

      const userId = response.locals.authenticatedUser.id as string;
      const channel = await options.db.transaction(async (transaction) => {
        const [created] = await transaction
          .insert(channels)
          .values({
            name: payload.data.name,
            isPrivate: payload.data.isPrivate,
            createdBy: userId,
          })
          .returning({
            id: channels.id,
            name: channels.name,
            isPrivate: channels.isPrivate,
            createdBy: channels.createdBy,
          });
        if (!created) throw new Error("Channel creation did not return a channel.");
        await transaction
          .insert(channelMembers)
          .values({ channelId: created.id, userId, role: "admin" });
        return created;
      });

      response.status(201).json({ channel: { ...channel, unreadCount: 0 } });
    } catch (error) {
      const cause = error instanceof Error && "cause" in error ? error.cause : error;
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "23505"
      ) {
        response.status(409).json({ error: "CHANNEL_EXISTS" });
        return;
      }
      next(error);
    }
  });

  app.get("/api/v1/channels", requireSession, async (_request, response, next) => {
    try {
      const userId = response.locals.authenticatedUser.id as string;
      const unreadCount = sql<number>`
        CASE
          WHEN ${channelMembers.userId} IS NULL THEN 0
          ELSE (
            SELECT count(*)::int
            FROM ${messages}
            WHERE ${messages.channelId} = ${channels.id}
              AND ${messages.deletedAt} IS NULL
              AND (
                ${channelMembers.lastReadMessageId} IS NULL
                OR ${messages.id} > ${channelMembers.lastReadMessageId}
              )
          )
        END
      `;
      const listedChannels = await options.db
        .select({
          id: channels.id,
          name: channels.name,
          isPrivate: channels.isPrivate,
          createdBy: channels.createdBy,
          unreadCount,
        })
        .from(channels)
        .leftJoin(
          channelMembers,
          and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, userId)),
        )
        .where(or(eq(channels.isPrivate, false), eq(channelMembers.userId, userId)))
        .orderBy(asc(channels.name));

      response.status(200).json({
        channels: listedChannels.map((channel) => ({
          ...channel,
          unreadCount: Number(channel.unreadCount),
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/api/v1/channels/:channelId/join",
    requireSession,
    requireCsrf,
    async (request, response, next) => {
      try {
        const params = channelIdParamsSchema.safeParse(request.params);
        if (!params.success) {
          invalidRequest(response);
          return;
        }
        const userId = response.locals.authenticatedUser.id as string;
        const channel = await findAccessibleChannel(params.data.channelId, userId);
        if (!channel || channel.isPrivate) {
          notFound(response);
          return;
        }

        await options.db
          .insert(channelMembers)
          .values({ channelId: channel.id, userId })
          .onConflictDoNothing();
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/channels/:channelId/leave",
    requireSession,
    requireCsrf,
    async (request, response, next) => {
      try {
        const params = channelIdParamsSchema.safeParse(request.params);
        if (!params.success) {
          invalidRequest(response);
          return;
        }
        const userId = response.locals.authenticatedUser.id as string;
        const channel = await findAccessibleChannel(params.data.channelId, userId);
        if (!channel || channel.memberUserId === null) {
          notFound(response);
          return;
        }

        await options.db
          .delete(channelMembers)
          .where(and(eq(channelMembers.channelId, channel.id), eq(channelMembers.userId, userId)));
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/api/v1/channels/:channelId/messages",
    requireSession,
    async (request, response, next) => {
      try {
        const params = channelIdParamsSchema.safeParse(request.params);
        const query = listMessagesQuerySchema.safeParse(request.query);
        if (!params.success || !query.success) {
          invalidRequest(response);
          return;
        }
        const userId = response.locals.authenticatedUser.id as string;
        const channel = await findAccessibleChannel(params.data.channelId, userId);
        if (!channel) {
          notFound(response);
          return;
        }

        const conditions = [eq(messages.channelId, channel.id), isNull(messages.deletedAt)];
        if (query.data.before) conditions.push(lt(messages.id, query.data.before));
        const page = await options.db
          .select({
            id: messages.id,
            channelId: messages.channelId,
            userId: messages.userId,
            body: messages.body,
            createdAt: messages.createdAt,
            editedAt: messages.editedAt,
          })
          .from(messages)
          .where(and(...conditions))
          .orderBy(desc(messages.id))
          .limit(query.data.limit + 1);
        const hasMore = page.length > query.data.limit;
        const pageMessages = hasMore ? page.slice(0, query.data.limit) : page;

        response.status(200).json({
          messages: pageMessages,
          nextCursor: hasMore ? (pageMessages.at(-1)?.id ?? null) : null,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/api/v1/channels/:channelId/read",
    requireSession,
    requireCsrf,
    async (request, response, next) => {
      try {
        const params = channelIdParamsSchema.safeParse(request.params);
        const payload = markChannelReadRequestSchema.safeParse(request.body);
        if (!params.success || !payload.success) {
          invalidRequest(response);
          return;
        }
        const userId = response.locals.authenticatedUser.id as string;
        const channel = await findAccessibleChannel(params.data.channelId, userId);
        if (!channel || channel.memberUserId === null) {
          notFound(response);
          return;
        }
        const [message] = await options.db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.id, payload.data.messageId),
              eq(messages.channelId, channel.id),
              isNull(messages.deletedAt),
            ),
          );
        if (!message) {
          notFound(response);
          return;
        }

        await options.db
          .update(channelMembers)
          .set({ lastReadMessageId: message.id })
          .where(
            and(
              eq(channelMembers.channelId, channel.id),
              eq(channelMembers.userId, userId),
              or(
                isNull(channelMembers.lastReadMessageId),
                lt(channelMembers.lastReadMessageId, message.id),
              ),
            ),
          );
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    },
  );

  app.use((_request, response) => response.status(404).json({ error: "NOT_FOUND" }));
  app.use((_error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    // Database errors may include query parameter values, including a password hash.
    void _next;
    console.error("Unexpected API error.");
    response.status(500).json({ error: "INTERNAL_SERVER_ERROR" });
  });

  return app;
}

export const app = express();
app.disable("x-powered-by");
app.get("/healthz", (_request, response) => response.status(200).json({ status: "ok" }));
