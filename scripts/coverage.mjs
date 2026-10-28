import { spawnSync } from "node:child_process";

let failed = false;
for (const workspace of ["packages/shared", "apps/api", "apps/web"]) {
  const args =
    workspace === "apps/api"
      ? [
          "--env-file-if-exists=../../.env",
          "../../node_modules/vitest/vitest.mjs",
          "run",
          "--config",
          "vitest.coverage.config.ts",
          "--coverage",
        ]
      : ["../../node_modules/vitest/vitest.mjs", "run", "--coverage"];
  const result = spawnSync(process.execPath, args, { cwd: workspace, stdio: "inherit" });
  if (result.status !== 0) failed = true;
}
const report = spawnSync(process.execPath, ["scripts/coverage-report.mjs"], { stdio: "inherit" });
process.exitCode = failed || report.status !== 0 ? 1 : 0;
