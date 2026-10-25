import { createServer } from "node:http";
import { env } from "./env.js";
import { createClient } from "redis";
import { createApp } from "./app.js";
import { createDatabase } from "./db/client.js";
import { createSocketServer } from "./socket.js";
import { attachRedisAdapter } from "./socket-adapter.js";

const redis = createClient({ url: env.REDIS_URL });
redis.on("error", () => {
  console.error("Redis connection error.");
});
await redis.connect();

const { db, pool } = createDatabase(env.DATABASE_URL);
const allowedOrigins = env.ALLOWED_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const app = createApp({
  db,
  redis,
  allowedOrigins,
  nodeEnv: env.NODE_ENV,
  passwordCosts: {
    memoryCost: env.ARGON2_MEMORY_COST,
    timeCost: env.ARGON2_TIME_COST,
    parallelism: env.ARGON2_PARALLELISM,
  },
  sessionTtlSeconds: env.SESSION_TTL_SECONDS,
  sessionAbsoluteTtlSeconds: env.SESSION_ABSOLUTE_TTL_SECONDS,
});
const httpServer = createServer(app);
const io = createSocketServer({
  httpServer,
  db,
  redis,
  allowedOrigins,
  sessionTtlSeconds: env.SESSION_TTL_SECONDS,
  sessionAbsoluteTtlSeconds: env.SESSION_ABSOLUTE_TTL_SECONDS,
});
const closeAdapter = await attachRedisAdapter(io, redis);

httpServer.listen(env.API_PORT, env.HOST, () => {
  console.info(`API listening on ${env.HOST}:${env.API_PORT}`);
});

async function shutdown() {
  await new Promise<void>((resolve) => io.close(() => resolve()));
  await closeAdapter();
  await redis.quit();
  await pool.end();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
