import { fork, spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { availableParallelism, cpus, freemem } from "node:os";
import { performance } from "node:perf_hooks";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { once } from "node:events";
import { z } from "zod";
import { createClient } from "redis";
import { inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "../../apps/api/src/db/client.ts";
import { users, channels, channelMembers, messages } from "../../apps/api/src/db/schema.ts";
import { createSessionStore } from "../../apps/api/src/auth/session.ts";
import { configuration, group, expectedDeliveries, reconcile, DRAIN_MS } from "./protocol.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const execute = promisify(execFile);
const k6 = process.env.K6_BIN ?? "k6";
const origin = "http://localhost:5173";
const output = fileURLToPath(new URL("./results/", import.meta.url));
const databaseUrl = process.env.DATABASE_URL_TEST;
if (!databaseUrl || !process.env.REDIS_URL)
  throw new Error("Set DATABASE_URL_TEST and REDIS_URL for a dedicated local test stack.");
if (
  !z.string().url().safeParse(databaseUrl).success ||
  !z.string().url().safeParse(process.env.REDIS_URL).success
)
  throw new Error("Invalid test connection configuration.");
if (process.env.DATABASE_URL) {
  const test = new URL(databaseUrl);
  const dev = new URL(process.env.DATABASE_URL);
  if (test.host === dev.host && test.pathname === dev.pathname)
    throw new Error("Load tests require a database distinct from development.");
}
const steps = (process.env.LOAD_STEPS ?? process.env.LOAD_CONNECTIONS ?? "8")
  .split(",")
  .map(Number);
const configs = steps.map((n) => configuration({ ...process.env, LOAD_CONNECTIONS: String(n) }));
if (steps.some((n, i) => i && n <= steps[i - 1]))
  throw new Error("LOAD_STEPS must increase strictly.");
await mkdir(output, { recursive: true });
const version = (await execute(k6, ["version"])).stdout.trim();
const redis = createClient({ url: process.env.REDIS_URL, socket: { reconnectStrategy: false } });
redis.on("error", () => console.error("Load controller Redis error."));
await redis.connect();
const { db, pool } = createDatabase(databaseUrl);
try {
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../apps/api/drizzle", import.meta.url)),
  });
} catch {
  await Promise.allSettled([redis.quit(), pool.end()]);
  throw new Error("The dedicated test database is unavailable or migrations failed.");
}
const children = new Set();
let interrupted = false;
const stop = () => {
  interrupted = true;
  for (const child of children) child.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
let containers = [];
try {
  for (const service of ["postgres", "redis"]) {
    const id = (
      await execute("docker", ["compose", "ps", "-q", service], { cwd: root })
    ).stdout.trim();
    if (id) containers.push({ service, id });
  }
} catch {
  console.info("Container CPU metrics unavailable; database/cache timing will still be collected.");
}

const percentile = (values, fraction = 0.95) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null;
};
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
function info(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => line.includes(":") && !line.startsWith("#"))
      .map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon), line.slice(colon + 1)];
      }),
  );
}
async function redisStats() {
  return {
    ...info(await redis.info("cpu")),
    ...info(await redis.info("stats")),
    commands: info(await redis.info("commandstats")),
    at: Date.now(),
  };
}
async function startInstance(prefix, index, samples) {
  const url = new URL(databaseUrl);
  url.searchParams.set("application_name", `${prefix}${index}`);
  const child = fork(fileURLToPath(new URL("./instance.mjs", import.meta.url)), [], {
    execArgv: ["--import", "tsx"],
    env: { ...process.env, LOAD_DATABASE_URL: url.href, LOAD_PREFIX: prefix, LOAD_ORIGIN: origin },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  children.add(child);
  const exited = once(child, "exit");
  const port = await new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error("Load instance failed to launch.")));
    child.once("exit", () => reject(new Error("Load instance exited before readiness.")));
    child.on("message", (message) => {
      if (message.type === "ready") resolve(message.port);
      else if (message.type === "sample") samples.push({ ...message, instance: index });
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      child.kill("SIGTERM");
      await exited;
      children.delete(child);
    },
  };
}

const reportSchema = z
  .object({
    submitted: z.number().int().nonnegative(),
    acknowledged: z.number().int().nonnegative(),
    expected: z.number().int().positive(),
    received: z.number().int().nonnegative(),
    lost: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    connected: z.boolean(),
    joined: z.boolean(),
    failed: z.boolean(),
  })
  .strict();
async function body(request) {
  let value = "";
  for await (const chunk of request) {
    value += chunk;
    if (value.length > 2048) throw new Error("Oversized control request");
  }
  return JSON.parse(value);
}

async function run(config) {
  const runId = randomUUID();
  const prefix = `relay:load:${runId}:`;
  const key = randomBytes(32).toString("base64url");
  const userIds = [];
  const channelIds = [];
  const sessions = [];
  const instances = [];
  const samples = [];
  const databaseSamples = [];
  const dockerSamples = [];
  const generatorCPU = [];
  const reports = new Map();
  const ready = new Map();
  let broker;
  let sampler;
  let stats;
  let schedule;
  let before;
  let probeBusy = false;
  const pendingProbes = new Set();
  try {
    const seeded = await db
      .insert(users)
      .values(
        Array.from({ length: config.connections }, () => ({
          email: `${randomUUID()}@load.example.test`,
          displayName: "Disposable load user",
          passwordHash: "!load-fixture-password-disabled",
        })),
      )
      .returning({ id: users.id });
    userIds.push(...seeded.map((row) => row.id));
    const rooms = await db
      .insert(channels)
      .values(
        Array.from({ length: Math.ceil(config.connections / config.channelSize) }, (_, i) => ({
          name: `load-${runId}-${i}`,
          createdBy: userIds[0],
          isPrivate: true,
        })),
      )
      .returning({ id: channels.id });
    channelIds.push(...rooms.map((row) => row.id));
    await db
      .insert(channelMembers)
      .values(
        userIds.map((userId, i) => ({ userId, channelId: channelIds[group(config, i + 1).index] })),
      );
    const store = createSessionStore({
      redis,
      keyPrefix: prefix,
      ttlSeconds: 1800,
      absoluteTtlSeconds: 3600,
    });
    for (const userId of userIds) sessions.push(await store.create(userId));
    for (let index = 0; index < 2; index++) {
      if (interrupted) throw new Error("Load campaign interrupted.");
      instances.push(await startInstance(prefix, index, samples));
    }
    broker = createServer((request, response) => {
      void (async () => {
        const provided = request.headers["x-load-key"];
        if (
          typeof provided !== "string" ||
          provided.length !== key.length ||
          !timingSafeEqual(Buffer.from(provided), Buffer.from(key))
        ) {
          response.writeHead(401).end();
          return;
        }
        const match = /^\/(identity|ready|report)\/([1-9]\d*)$/.exec(request.url ?? "");
        const vu = Number(match?.[2]);
        if (!match || vu > config.connections) {
          response.writeHead(404).end();
          return;
        }
        response.setHeader("Cache-Control", "no-store");
        if (request.method === "GET" && match[1] === "identity") {
          response.setHeader(
            "Set-Cookie",
            `relay_session=${sessions[vu - 1]}; Path=/; HttpOnly; SameSite=Lax`,
          );
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              channelId: channelIds[group(config, vu).index],
              channelIndex: group(config, vu).index,
              api: instances[(vu - 1) % 2].url,
              origin,
            }),
          );
        } else if (request.method === "POST" && match[1] === "ready") {
          if (ready.has(vu)) {
            response.writeHead(409).end();
            return;
          }
          ready.set(vu, response);
          if (ready.size === config.connections) {
            before = redisStats();
            schedule = {
              startAt: Date.now() + 1000,
              stopAt: Date.now() + 1000 + config.seconds * 1000,
            };
            for (const waiting of ready.values()) {
              waiting.setHeader("Content-Type", "application/json");
              waiting.end(JSON.stringify(schedule));
            }
          }
        } else if (request.method === "POST" && match[1] === "report") {
          const parsed = reportSchema.safeParse(await body(request));
          if (!parsed.success || reports.has(vu)) {
            response.writeHead(400).end();
            return;
          }
          reports.set(vu, parsed.data);
          response.writeHead(204).end();
        } else response.writeHead(405).end();
      })().catch(() => {
        if (!response.headersSent) response.writeHead(400);
        response.end();
      });
    });
    await new Promise((resolve, reject) => {
      broker.once("error", reject);
      broker.listen(0, "127.0.0.1", resolve);
    });
    const brokerURL = `http://127.0.0.1:${broker.address().port}`;
    if (containers.length) {
      stats = spawn(
        "docker",
        [
          "stats",
          "--format",
          "{{json .}}",
          "--no-trunc",
          ...containers.map((container) => container.id),
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      children.add(stats);
      let buffer = "";
      stats.on("error", () => {});
      stats.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          try {
            const data = JSON.parse(line.slice(line.indexOf("{"), line.lastIndexOf("}") + 1));
            const container = containers.find(
              (item) => item.id.startsWith(data.ID) || data.ID.startsWith(item.id),
            );
            if (container)
              dockerSamples.push({
                at: Date.now(),
                service: container.service,
                cpu: parseFloat(data.CPUPerc),
              });
          } catch {
            /* docker can print an initial terminal-control line */
          }
        }
      });
    }
    const summaryPath = `${output}${runId}-k6.json`;
    const addresses = Array.from(
      { length: config.connections },
      (_, i) => `127.43.${Math.floor(i / 250)}.${(i % 250) + 1}`,
    );
    if (interrupted) throw new Error("Load campaign interrupted.");
    const generator = spawn(
      k6,
      ["run", "--quiet", fileURLToPath(new URL("./chat.k6.js", import.meta.url))],
      {
        cwd: root,
        env: {
          ...process.env,
          K6_LOCAL_IPS: addresses.join(","),
          LOAD_BROKER: brokerURL,
          LOAD_CONTROL_KEY: key,
          LOAD_RUN: runId,
          LOAD_SUMMARY: summaryPath,
          LOAD_CONNECTIONS: String(config.connections),
          LOAD_RATE: String(config.rate),
          LOAD_SECONDS: String(config.seconds),
          LOAD_CHANNEL_SIZE: String(config.channelSize),
          LOAD_P95_MS: String(config.p95),
        },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    children.add(generator);
    let previousTicks;
    let previousAt;
    const clockTicks = Number((await execute("getconf", ["CLK_TCK"])).stdout.trim());
    sampler = setInterval(() => {
      if (probeBusy) return;
      probeBusy = true;
      const task = (async () => {
        const at = Date.now();
        const pingAt = performance.now();
        await redis.ping();
        const ping = performance.now() - pingAt;
        const activity = await pool.query(
          `SELECT wait_event_type, wait_event, count(*)::int AS count FROM pg_stat_activity
          WHERE application_name = ANY($1) AND state = 'active' GROUP BY wait_event_type, wait_event`,
          [[`${prefix}0`, `${prefix}1`]],
        );
        databaseSamples.push({ at, redisPingMs: ping, activity: activity.rows });
        try {
          const stat = await readFile(`/proc/${generator.pid}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          const ticks = Number(fields[11]) + Number(fields[12]);
          if (previousAt)
            generatorCPU.push({
              at,
              cpu: ((ticks - previousTicks) / clockTicks / ((at - previousAt) / 1000)) * 100,
            });
          previousAt = at;
          previousTicks = ticks;
        } catch {
          /* process exited between samples */
        }
      })()
        .catch(() => {
          databaseSamples.push({ at: Date.now(), probeFailed: true });
        })
        .finally(() => {
          probeBusy = false;
        });
      pendingProbes.add(task);
      void task.then(() => pendingProbes.delete(task));
    }, 250);
    const exit = await new Promise((resolve, reject) => {
      generator.once("error", () => reject(new Error("Could not launch k6.")));
      generator.once("exit", resolve);
    });
    children.delete(generator);
    clearInterval(sampler);
    await Promise.all(pendingProbes);
    const after = await redisStats();
    const baseline = before ? await before : after;
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    const persisted = await db
      .select({ clientMessageId: messages.clientMessageId })
      .from(messages)
      .where(inArray(messages.channelId, channelIds));
    const ids = new Set(persisted.map((row) => row.clientMessageId));
    const inWindow = (sample) =>
      schedule && sample.at >= schedule.startAt && sample.at <= schedule.stopAt + DRAIN_MS;
    const apiSamples = samples.filter(inWindow);
    const probes = databaseSamples.filter(inWindow);
    const sqlStats = (name) => {
      const points = apiSamples.flatMap((sample) =>
        sample.stats[name] ? [sample.stats[name]] : [],
      );
      const count = points.reduce((sum, point) => sum + point.count, 0);
      return {
        count,
        avgMs: count
          ? points.reduce((sum, point) => sum + point.avg * point.count, 0) / count
          : null,
        p95OfIntervalP95Ms: percentile(points.map((point) => point.p95)),
        maxMs: points.length ? Math.max(...points.map((point) => point.max)) : null,
      };
    };
    const elapsed = Math.max(1, after.at - baseline.at) / 1000;
    const metrics = summary.metrics;
    const value = (name, stat = "count") => metrics[name]?.values?.[stat] ?? null;
    const runReport = {
      runId,
      config,
      exitCode: exit,
      at: new Date().toISOString(),
      plannedMessages: config.connections * config.messages,
      expectedDeliveries: expectedDeliveries(config),
      connected: value("connected_clients"),
      joined: value("joined_clients"),
      submitted: value("submitted_messages"),
      acknowledged: value("acked_messages"),
      received: value("received_deliveries"),
      lost: value("lost_deliveries"),
      duplicates: value("duplicate_deliveries"),
      sendErrorRate: value("send_error_rate", "rate"),
      p95DeliveryMs: value("delivery_latency_ms", "p(95)"),
      p99DeliveryMs: value("delivery_latency_ms", "p(99)"),
      p95CrossInstanceMs: value("cross_instance_delivery_latency_ms", "p(95)"),
      p95AckMs: value("ack_latency_ms", "p(95)"),
      p95GeneratorLagMs: value("generator_lag_ms", "p(95)"),
      terminalReports: reports.size,
      persisted: persisted.length,
      uniquePersisted: ids.size,
      reconciled: reconcile(config, runId, reports, persisted),
      api: [0, 1].map((instance) => {
        const points = apiSamples.filter((sample) => sample.instance === instance);
        return {
          instance,
          samples: points.length,
          averageCpuPercent: mean(points.map((sample) => sample.cpuPercent)),
          p95CpuPercent: percentile(points.map((sample) => sample.cpuPercent)),
          peakCpuPercent: points.length
            ? Math.max(...points.map((sample) => sample.cpuPercent))
            : null,
          p95EventLoopDelayMs: percentile(points.map((sample) => sample.loopP95Ms)),
          p95EventLoopUtilization: percentile(points.map((sample) => sample.loopUtilization)),
          p95PoolWaiting: percentile(points.map((sample) => sample.poolWaiting)),
        };
      }),
      database: {
        waits: Object.fromEntries(
          [
            ...new Set(
              probes.flatMap((probe) =>
                (probe.activity ?? []).map(
                  (row) => `${row.wait_event_type ?? "CPU"}:${row.wait_event ?? "running"}`,
                ),
              ),
            ),
          ].map((key) => [
            key,
            probes.reduce(
              (sum, probe) =>
                sum +
                (probe.activity ?? [])
                  .filter(
                    (row) =>
                      `${row.wait_event_type ?? "CPU"}:${row.wait_event ?? "running"}` === key,
                  )
                  .reduce((n, row) => n + row.count, 0),
              0,
            ),
          ]),
        ),
        advisoryWaitSamples: probes.reduce(
          (sum, probe) =>
            sum +
            (probe.activity ?? [])
              .filter((row) => row.wait_event === "advisory")
              .reduce((n, row) => n + row.count, 0),
          0,
        ),
        activeSamples: probes.reduce(
          (sum, probe) => sum + (probe.activity ?? []).reduce((n, row) => n + row.count, 0),
          0,
        ),
        cpuP95Percent: percentile(
          dockerSamples
            .filter((sample) => sample.service === "postgres" && inWindow(sample))
            .map((sample) => sample.cpu),
        ),
        advisory: sqlStats("pg_advisory_lock"),
        insert: sqlStats("pg_message_insert"),
        commit: sqlStats("pg_commit"),
        select: sqlStats("pg_select"),
        transaction: sqlStats("transaction"),
      },
      redis: {
        cpuPercent:
          ((Number(after.used_cpu_sys) +
            Number(after.used_cpu_user) -
            (Number(baseline.used_cpu_sys) + Number(baseline.used_cpu_user))) /
            elapsed) *
          100,
        cpuP95Percent: percentile(
          dockerSamples
            .filter((sample) => sample.service === "redis" && inWindow(sample))
            .map((sample) => sample.cpu),
        ),
        commandsPerSecond:
          (Number(after.total_commands_processed) - Number(baseline.total_commands_processed)) /
          elapsed,
        pingP95Ms: percentile(probes.map((probe) => probe.redisPingMs)),
        reads: sqlStats("redis_get"),
      },
      generator: {
        cpuP95Percent: percentile(generatorCPU.filter(inWindow).map((sample) => sample.cpu)),
      },
      monitoring: {
        dockerSamples: dockerSamples.filter(inWindow).length,
        databaseSamples: probes.length,
        probeFailures: probes.filter((probe) => probe.probeFailed).length,
      },
    };
    console.log(
      JSON.stringify({
        connections: config.connections,
        rate: config.rate,
        p95: runReport.p95DeliveryMs,
        lost: runReport.lost,
        reconciled: runReport.reconciled,
        exit,
      }),
    );
    return runReport;
  } finally {
    clearInterval(sampler);
    await Promise.all(pendingProbes);
    if (stats) {
      stats.kill("SIGTERM");
      children.delete(stats);
    }
    for (const response of ready.values())
      if (!response.writableEnded) response.writeHead(503).end();
    if (broker) {
      broker.closeAllConnections();
      await new Promise((resolve) => broker.close(resolve));
    }
    for (const instance of instances.reverse()) await instance.close();
    for await (const keys of redis.scanIterator({ MATCH: `${prefix}*` }))
      if (keys.length) await redis.del(keys);
    if (channelIds.length) await db.delete(channels).where(inArray(channels.id, channelIds));
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  }
}

const campaign = {
  environment: {
    date: new Date().toISOString(),
    node: process.version,
    k6: version,
    logicalCPUs: availableParallelism(),
    cpu: cpus()[0]?.model,
    freeMemoryGiB: freemem() / 1024 ** 3,
    sameHostGenerator: true,
    apiInstances: 2,
    fixtureDatabase: "dedicated test database",
    productionLimitsEnabled: true,
  },
  runs: [],
};
try {
  for (const config of configs) {
    if (interrupted) {
      process.exitCode = 130;
      break;
    }
    console.log(
      `Load: ${config.connections} sockets, ${config.rate} messages/socket/s, channel size ${config.channelSize}, ${config.seconds}s, p95 < ${config.p95}ms.`,
    );
    const result = await run(config);
    campaign.runs.push(result);
    await writeFile(
      process.env.LOAD_OUTPUT ?? `${output}latest.json`,
      JSON.stringify(campaign, null, 2) + "\n",
    );
    if (result.exitCode || !result.reconciled) {
      process.exitCode = 1;
      if (process.env.LOAD_CONTINUE !== "1") break;
    }
  }
} catch {
  console.error(
    "Load run failed. Check local services, dedicated test configuration and k6 installation; no connection values are logged.",
  );
  process.exitCode = 1;
} finally {
  stop();
  await redis.quit();
  await pool.end();
}
