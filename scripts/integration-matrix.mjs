import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const argument = (name, fallback) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const phase = argument("phase", "after");
const idleRuns = Number(argument("idle", "10"));
const loadedRuns = Number(argument("load", "5"));
const loadWorkers = Number(
  argument("workers", String(Math.min(6, Math.max(1, availableParallelism() - 2)))),
);
if (!Number.isInteger(loadWorkers) || loadWorkers < 1)
  throw new Error("Worker count must be a positive integer.");
if (!Number.isInteger(idleRuns) || idleRuns < 0 || !Number.isInteger(loadedRuns) || loadedRuns < 0)
  throw new Error("Run counts must be nonnegative integers.");
const output = argument("output", `/tmp/relay-integration-${phase}.json`);
const results = [];
const root = fileURLToPath(new URL("../", import.meta.url));
const clean = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");

async function run(mode, index, loadWorkers) {
  const started = performance.now();
  const cpu = process.cpuUsage();
  let captured = "";
  const child = spawn(
    "npm",
    ["run", "test:integration", "--workspace=@relay-chat/api", "--", "--reporter=dot"],
    {
      cwd: root,
      env: { ...process.env, NODE_ENV: "test", NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      captured += chunk.toString();
    });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const text = clean(captured);
  const fixtures = [...text.matchAll(/\[fixture-timing\] (\{[^\n]+\})/g)].map((match) =>
    JSON.parse(match[1]),
  );
  const summary = text.match(/^\s*Tests\s+([^\n]+)/m)?.[1]?.trim() ?? "No test summary";
  const failures = [...text.matchAll(/^\s*FAIL\s+(test\/[^\n]+)/gm)].map((match) =>
    match[1].trim(),
  );
  const usedCpu = process.cpuUsage(cpu);
  const result = {
    phase,
    mode,
    index,
    exitCode,
    wallMs: performance.now() - started,
    loadWorkers,
    loadProcessCpuMs: (usedCpu.user + usedCpu.system) / 1000,
    summary,
    failures,
    fixtures,
  };
  results.push(result);
  // Persist only aggregate metrics and test names, never raw test output or failure values.
  await writeFile(
    output,
    `${JSON.stringify({ phase, availableParallelism: availableParallelism(), results }, null, 2)}\n`,
  );
  console.log(JSON.stringify(result));
}

const workers = [];
const stop = new Int32Array(new SharedArrayBuffer(4));
try {
  for (let index = 1; index <= idleRuns; index += 1) await run("idle", index, 0);
  if (loadedRuns) {
    for (let index = 0; index < loadWorkers; index += 1) {
      const worker = new Worker(
        `
        const { parentPort, workerData } = require('node:worker_threads');
        const stop = new Int32Array(workerData);
        parentPort.postMessage('ready');
        let value = 1;
        while (!Atomics.load(stop, 0)) {
          for (let i = 0; i < 100000; i++) value = Math.sqrt(value + i + 1);
        }
      `,
        { eval: true, workerData: stop.buffer },
      );
      workers.push(worker);
      await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
    }
    for (let index = 1; index <= loadedRuns; index += 1)
      await run("cpu-load", index, workers.length);
  }
} finally {
  Atomics.store(stop, 0, 1);
  await Promise.all(workers.map((worker) => worker.terminate()));
}
console.log(`Metrics written to ${output}`);
if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1;
