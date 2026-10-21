import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const shell = process.platform === "win32";
const workspaces = ["@relay-chat/api", "@relay-chat/web"];
let stopping = false;

const children = workspaces.map((workspace) => {
  const child = spawn(npm, ["run", "dev", `--workspace=${workspace}`], {
    stdio: "inherit",
    shell,
  });

  child.on("error", (error) => {
    console.error(`Could not start ${workspace}: ${error.message}`);
    stop("SIGTERM", 1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop("SIGTERM", code ?? 1);
  });

  return child;
});

function stop(signal, exitCode) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) {
    if (child.exitCode === null) child.kill(signal);
  }
}

process.on("SIGINT", () => stop("SIGINT", 130));
process.on("SIGTERM", () => stop("SIGTERM", 143));
