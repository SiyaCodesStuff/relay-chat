import type { RedisConnection } from "./auth/session.js";

// Redis TIME keeps leases consistent across instances with different host clocks.
const updateScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + tonumber(time[2]) / 1000
local wasOnline = redis.call('ZSCORE', KEYS[1], ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if ARGV[3] == 'remove' then
  redis.call('ZREM', KEYS[2], ARGV[2])
else
  redis.call('ZADD', KEYS[2], now + tonumber(ARGV[4]), ARGV[2])
end
local count = redis.call('ZCARD', KEYS[2])
if count == 0 then
  redis.call('DEL', KEYS[2])
  redis.call('ZREM', KEYS[1], ARGV[1])
  if wasOnline then return -1 end
else
  local latest = redis.call('ZRANGE', KEYS[2], -1, -1, 'WITHSCORES')
  redis.call('ZADD', KEYS[1], latest[2], ARGV[1])
  redis.call('PEXPIRE', KEYS[2], ARGV[4])
  if not wasOnline then return 1 end
end
return 0
`;

const sweepScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + tonumber(time[2]) / 1000
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, 100)
for _, user in ipairs(expired) do redis.call('ZREM', KEYS[1], user) end
return expired
`;

export function createPresenceStore(redis: RedisConnection, prefix: string, ttlMs = 30_000) {
  const usersKey = `${prefix}presence:users`;
  async function update(userId: string, connectionId: string, action: "touch" | "remove") {
    return Number(
      await redis.sendCommand([
        "EVAL",
        updateScript,
        "2",
        usersKey,
        `${prefix}presence:connections:${userId}`,
        userId,
        connectionId,
        action,
        String(ttlMs),
      ]),
    );
  }
  return {
    touch: (userId: string, connectionId: string) => update(userId, connectionId, "touch"),
    remove: (userId: string, connectionId: string) => update(userId, connectionId, "remove"),
    async sweep() {
      return (await redis.sendCommand(["EVAL", sweepScript, "1", usersKey])) as string[];
    },
  };
}
