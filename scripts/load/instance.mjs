// Isolated benchmark entry point. Uses the unchanged application and Redis adapter.
import { createServer } from "node:http";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createClient } from "redis";
import { createApp } from "../../apps/api/src/app.ts";
import { createDatabase } from "../../apps/api/src/db/client.ts";
import { createSocketServer } from "../../apps/api/src/socket.ts";
import { attachRedisAdapter } from "../../apps/api/src/socket-adapter.ts";
import { instrument } from "./instrument.mjs";

const measurements = new Map();
function record(name, ms) {
  const data = measurements.get(name) ?? { count: 0, sum: 0, max: 0, samples: [] };
  data.count++;
  data.sum += ms;
  data.max = Math.max(data.max, ms);
  if (data.samples.length < 5000) data.samples.push(ms);
  measurements.set(name, data);
}
const redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false } });
redis.on("error", () => console.error("Load instance Redis error."));
await redis.connect();
for (const name of ["get", "expire", "sendCommand"])
  instrument(redis, name, record, () => `redis_${name}`);
const { db, pool } = createDatabase(process.env.LOAD_DATABASE_URL);
pool.on("connect", (client) => {
  instrument(client, "query", record, (args) => {
    const text = typeof args[0] === "string" ? args[0] : (args[0]?.text ?? "");
    if (text.includes("pg_advisory_xact_lock")) return "pg_advisory_lock";
    if (/^commit/i.test(text)) return "pg_commit";
    if (/^insert into "messages"/i.test(text)) return "pg_message_insert";
    if (/^select/i.test(text)) return "pg_select";
    return "pg_other";
  });
});
instrument(db, "transaction", record);
const options = {
  db,
  redis,
  allowedOrigins: [process.env.LOAD_ORIGIN],
  redisKeyPrefix: process.env.LOAD_PREFIX,
  sessionTtlSeconds: 1800,
  sessionAbsoluteTtlSeconds: 3600,
};
const http = createServer(createApp({ ...options, nodeEnv: "development" }));
const io = createSocketServer({ ...options, httpServer: http });
const closeAdapter = await attachRedisAdapter(io, redis, `${process.env.LOAD_PREFIX}adapter`);
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
let cpu = process.cpuUsage();
let elapsed = performance.now();
let utilization = performance.eventLoopUtilization();
const sampler = setInterval(() => {
  const now = performance.now();
  const currentCpu = process.cpuUsage();
  const currentUtilization = performance.eventLoopUtilization();
  const stats = Object.fromEntries(
    [...measurements].map(([name, data]) => {
      data.samples.sort((a, b) => a - b);
      return [
        name,
        {
          count: data.count,
          avg: data.sum / data.count,
          max: data.max,
          p95: data.samples[Math.ceil(data.samples.length * 0.95) - 1] ?? 0,
        },
      ];
    }),
  );
  measurements.clear();
  process.send?.({
    type: "sample",
    at: Date.now(),
    cpuPercent:
      (currentCpu.user - cpu.user + (currentCpu.system - cpu.system)) / ((now - elapsed) * 10),
    loopUtilization: performance.eventLoopUtilization(currentUtilization, utilization).utilization,
    loopP95Ms: delay.percentile(95) / 1e6,
    loopMaxMs: delay.max / 1e6,
    poolWaiting: pool.waitingCount,
    poolTotal: pool.totalCount,
    sockets: io.sockets.sockets.size,
    stats,
  });
  cpu = currentCpu;
  elapsed = now;
  utilization = currentUtilization;
  delay.reset();
}, 1000);
sampler.unref();
await new Promise((resolve, reject) => {
  http.once("error", reject);
  http.listen(0, "127.0.0.1", resolve);
});
process.send?.({ type: "ready", port: http.address().port });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(sampler);
  delay.disable();
  try {
    await io.close();
    await closeAdapter();
    await redis.quit();
    await pool.end();
  } finally {
    process.disconnect?.();
  }
}
process.once("SIGTERM", () => {
  void close();
});
process.once("SIGINT", () => {
  void close();
});
