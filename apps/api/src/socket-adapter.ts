import { createAdapter } from "@socket.io/redis-adapter";
import type { createClient } from "redis";
import type { createSocketServer } from "./socket.js";

export async function attachRedisAdapter(
  io: ReturnType<typeof createSocketServer>,
  redis: ReturnType<typeof createClient>,
  key = "relay:socket.io",
) {
  const publisher = redis.duplicate();
  const subscriber = redis.duplicate();
  publisher.on("error", () => console.error("Socket Redis connection error."));
  subscriber.on("error", () => console.error("Socket Redis connection error."));
  try {
    await Promise.all([publisher.connect(), subscriber.connect()]);
    io.adapter(createAdapter(publisher, subscriber, { key }));
  } catch (error) {
    if (publisher.isOpen) publisher.destroy();
    if (subscriber.isOpen) subscriber.destroy();
    throw error;
  }
  return async () => {
    await Promise.all([publisher.quit(), subscriber.quit()]);
  };
}
