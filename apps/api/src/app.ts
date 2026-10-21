import argon2 from "argon2";
import { eq } from "drizzle-orm";
import express, { type NextFunction, type Request, type Response } from "express";
import { loginRequestSchema, registerRequestSchema } from "@relay-chat/shared";
import { createRedisRateLimiter } from "./auth/rate-limit.js";
import { createSessionStore, sessionCookieName, type RedisConnection } from "./auth/session.js";
import type { Database } from "./db/client.js";
import { users } from "./db/schema.js";

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
