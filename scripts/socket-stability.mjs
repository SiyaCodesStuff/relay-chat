import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const api = join(root, "apps/api");
const flags = Object.fromEntries(
  process.argv.slice(2).map((flag) => flag.replace(/^--/, "").split("=")),
);
const idleRuns = Number(flags.idle ?? 30);
const loadedRuns = Number(flags.loaded ?? 15);
const workerCount = Number(flags.workers ?? 6);
for (const count of [idleRuns, loadedRuns, workerCount]) {
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error("Counts must be non-negative integers.");
}
const output = await mkdtemp(join(tmpdir(), `relay-socket-${flags.label ?? "stability"}-`));
const children = new Set();
let interrupted = false;
function launch(command, args, options) {
  if (interrupted) throw new Error(`Stability run interrupted; partial results: ${output}`);
  const child = spawn(command, args, options);
  children.add(child);
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      children.delete(child);
      resolve(code);
    });
  });
  return { child, done };
}
function stop() {
  interrupted = true;
  for (const child of children) child.kill("SIGTERM");
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const results = [];
console.log(`Logs and reports: ${output}`);
try {
  for (const [mode, count] of [
    ["idle", idleRuns],
    ["load", loadedRuns],
  ]) {
    if (!count) continue;
    for (const args of [
      ["compose", "restart", "postgres", "redis"],
      ["compose", "up", "-d", "--wait", "postgres", "redis"],
    ]) {
      const { done } = launch("docker", args, { cwd: root, stdio: "inherit" });
      if ((await done) !== 0) throw new Error(`docker ${args.join(" ")} failed`);
    }
    const workers =
      mode === "load"
        ? Array.from({ length: workerCount }, () =>
            launch(process.execPath, ["-e", "while (true) Math.sqrt(Math.random())"], {
              stdio: "ignore",
            }),
          )
        : [];
    try {
      for (let run = 1; run <= count; run += 1) {
        const label = `${mode}-${String(run).padStart(2, "0")}`;
        const report = join(output, `${label}.json`);
        const log = await open(join(output, `${label}.log`), "w");
        const started = performance.now();
        const { done } = launch(
          process.execPath,
          [
            "--env-file-if-exists=../../.env",
            "--import",
            "tsx",
            "../../node_modules/vitest/vitest.mjs",
            "run",
            "--config",
            "vitest.integration.config.ts",
            "test/socket.integration.test.ts",
            "--reporter=verbose",
            "--reporter=json",
            `--outputFile.json=${report}`,
          ],
          { cwd: api, stdio: ["ignore", log.fd, log.fd] },
        );
        const exit = await done;
        await log.close();
        if (interrupted) throw new Error(`Stability run interrupted; partial results: ${output}`);
        const data = JSON.parse(await readFile(report, "utf8"));
        const tests = data.testResults.flatMap((file) => file.assertionResults);
        const target = tests.find((test) => test.title.includes("catches up after a disconnect"));
        const row = {
          mode,
          run,
          exit,
          seconds: Math.round((performance.now() - started) / 10) / 100,
          target: target?.status ?? "missing",
          duration: target?.duration,
          failures: tests
            .filter((test) => test.status === "failed")
            .map((test) => ({
              title: test.title,
              messages: test.failureMessages,
            })),
        };
        results.push(row);
        await writeFile(join(output, "summary.json"), JSON.stringify(results, null, 2) + "\n");
        console.log(JSON.stringify(row));
      }
    } finally {
      for (const { child } of workers) child.kill("SIGTERM");
      await Promise.all(workers.map(({ done }) => done));
    }
  }
} finally {
  stop();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
if (results.some((result) => result.exit !== 0 || result.target !== "passed")) process.exitCode = 1;
