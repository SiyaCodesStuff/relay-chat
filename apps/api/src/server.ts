import { createServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import { env } from "./env.js";
import { createClient } from "redis";
import { createApp } from "./app.js";
import { createDatabase } from "./db/client.js";
import { createSocketServer } from "./socket.js";

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
const socketPublisher = redis.duplicate();
const socketSubscriber = redis.duplicate();
socketPublisher.on("error", () => console.error("Socket Redis connection error."));
socketSubscriber.on("error", () => console.error("Socket Redis connection error."));
await Promise.all([socketPublisher.connect(), socketSubscriber.connect()]);
io.adapter(createAdapter(socketPublisher, socketSubscriber));

const server = httpServer.listen(env.API_PORT, env.HOST, () => {
  console.info(`API listening on ${env.HOST}:${env.API_PORT}`);
});

async function shutdown() {
  server.close();
  io.close();
  await Promise.all([socketPublisher.quit(), socketSubscriber.quit(), redis.quit()]);
  await pool.end();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
