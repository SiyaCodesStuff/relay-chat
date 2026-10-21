import type { RedisConnection } from "./session.js";

export type RateLimitOptions = {
  redis: RedisConnection;
  keyPrefix?: string;
};

const incrementScript = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
return count
`;

export function createRedisRateLimiter(options: RateLimitOptions) {
  const keyPrefix = options.keyPrefix ?? "relay:";

  return async function isAllowed(
    subject: string,
    scope: string,
    limit: number,
    windowSeconds: number,
  ) {
    const key = `${keyPrefix}rate-limit:${scope}:${subject}`;
    const count = Number(
      await options.redis.sendCommand(["EVAL", incrementScript, "1", key, String(windowSeconds)]),
    );
    return count <= limit;
  };
}
