import { randomBytes } from "node:crypto";

export const sessionCookieName = "relay_session";

export type RedisConnection = {
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  expire(key: string, seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sendCommand(command: string[]): Promise<unknown>;
};

type StoredSession = {
  userId: string;
  createdAt: number;
};

export type SessionOptions = {
  redis: RedisConnection;
  ttlSeconds: number;
  absoluteTtlSeconds: number;
  keyPrefix?: string;
};

function sessionKey(sessionId: string, keyPrefix: string) {
  return `${keyPrefix}session:${sessionId}`;
}

function parseStoredSession(value: string | null): StoredSession | undefined {
  if (!value) return undefined;
  try {
    const session: unknown = JSON.parse(value);
    if (
      typeof session === "object" &&
      session !== null &&
      "userId" in session &&
      "createdAt" in session &&
      typeof session.userId === "string" &&
      typeof session.createdAt === "number"
    ) {
      return { userId: session.userId, createdAt: session.createdAt };
    }
  } catch {
    // A malformed server-side value is treated as an invalid session.
  }
  return undefined;
}

export function createSessionStore(options: SessionOptions) {
  const keyPrefix = options.keyPrefix ?? "relay:";

  async function create(userId: string) {
    const id = randomBytes(32).toString("base64url");
    const session: StoredSession = { userId, createdAt: Date.now() };
    await options.redis.set(sessionKey(id, keyPrefix), JSON.stringify(session), {
      EX: options.ttlSeconds,
    });
    return id;
  }

  async function read(id: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return undefined;
    const key = sessionKey(id, keyPrefix);
    const session = parseStoredSession(await options.redis.get(key));
    if (!session) return undefined;

    const remainingAbsoluteSeconds = Math.floor(
      (session.createdAt + options.absoluteTtlSeconds * 1_000 - Date.now()) / 1_000,
    );
    if (remainingAbsoluteSeconds <= 0) {
      await options.redis.del(key);
      return undefined;
    }

    await options.redis.expire(key, Math.min(options.ttlSeconds, remainingAbsoluteSeconds));
    return session;
  }

  async function destroy(id: string | undefined) {
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return;
    await options.redis.del(sessionKey(id, keyPrefix));
  }

  return { create, read, destroy };
}
