import { deploymentOrigins } from "./origins.mjs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function composeEnvironment(source) {
  const missing = ["POSTGRES_USER", "POSTGRES_PASSWORD", "SESSION_SECRET"].filter(
    (name) => !source[name],
  );
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);
  if (source.SESSION_SECRET.length < 32)
    throw new Error("SESSION_SECRET must have at least 32 characters.");
  const url = new URL("postgresql://postgres:5432/");
  url.username = encodeURIComponent(source.POSTGRES_USER);
  url.password = encodeURIComponent(source.POSTGRES_PASSWORD);
  url.pathname = `/${encodeURIComponent(source.POSTGRES_DB || "relay_chat")}`;
  return {
    ...source,
    DOCKER_DATABASE_URL: url.href,
    DOCKER_ALLOWED_ORIGINS: deploymentOrigins(source.PUBLIC_ORIGIN).join(","),
  };
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length) throw new Error("Usage: compose.mjs <Compose command> or verify [--static]");
  if (args[0] === "config" && (args.length !== 2 || !["--quiet", "-q"].includes(args[1])))
    throw new Error("Use config --quiet; expanded Compose config contains secrets.");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const verifying = args[0] === "verify";
  const result = spawnSync(
    verifying ? process.execPath : "docker",
    verifying
      ? [fileURLToPath(new URL("./verify.mjs", import.meta.url)), ...args.slice(1)]
      : ["compose", "-f", "compose.production.yml", ...args],
    { cwd: root, env: composeEnvironment(process.env), stdio: "inherit" },
  );
  if (result.error) throw new Error("Could not launch Docker Compose or the verification script.");
  process.exitCode = result.status ?? 1;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
