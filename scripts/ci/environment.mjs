import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { composeEnvironment } from "../docker/compose.mjs";

const execute = promisify(execFile);
export function ciEnvironment(mode, source) {
  if (
    source.GITHUB_ACTIONS !== "true" ||
    source.RUNNER_ENVIRONMENT !== "github-hosted" ||
    !/^\d+$/.test(source.GITHUB_RUN_ID ?? "") ||
    !/^\d+$/.test(source.GITHUB_RUN_ATTEMPT ?? "") ||
    !["integration", "e2e"].includes(mode)
  )
    throw new Error("CI setup requires a GitHub-hosted workflow and a supported mode.");
  const password = randomBytes(32).toString("hex");
  const database = mode === "integration" ? "relay_chat_ci_test" : "relay_chat_ci_e2e";
  const url = `postgresql://relay_ci:${password}@127.0.0.1:5432/${database}`;
  return {
    NODE_ENV: "test",
    POSTGRES_USER: "relay_ci",
    POSTGRES_PASSWORD: password,
    POSTGRES_DB: database,
    SESSION_SECRET: randomBytes(32).toString("hex"),
    DATABASE_URL_TEST: mode === "integration" ? url : url.replace(database, "relay_chat_ci_test"),
    ...(mode === "e2e"
      ? {
          DATABASE_URL_E2E: url,
          E2E_BASE_URL: "http://localhost:8080",
          PUBLIC_ORIGIN: "http://localhost:8080",
          COMPOSE_PROJECT_NAME: `relay-ci-${source.GITHUB_RUN_ID}-${source.GITHUB_RUN_ATTEMPT}`,
        }
      : {}),
    REDIS_URL: "redis://127.0.0.1:6379",
  };
}

async function exportEnvironment(values) {
  if (!process.env.GITHUB_ENV) throw new Error("Missing GitHub environment file.");
  for (const name of [
    "POSTGRES_PASSWORD",
    "SESSION_SECRET",
    "DATABASE_URL_TEST",
    "DATABASE_URL_E2E",
  ])
    if (values[name]) console.log(`::add-mask::${values[name]}`);
  await appendFile(
    process.env.GITHUB_ENV,
    Object.entries(values)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(""),
  );
}

export async function composeAddresses(source, inspect = execute) {
  // Native Linux runners can reach bridge IPs without publishing data-service ports.
  ciEnvironment("e2e", source); // Reject local/developer execution.
  if (!/^relay-ci-\d+-\d+$/.test(source.COMPOSE_PROJECT_NAME ?? ""))
    throw new Error("Expected the isolated CI Compose project.");
  const addresses = {};
  const env = composeEnvironment(source);
  for (const service of ["postgres", "redis"]) {
    const { stdout: id } = await inspect(
      "docker",
      ["compose", "-f", "compose.production.yml", "ps", "-q", service],
      { env },
    );
    const { stdout: address } = await inspect("docker", [
      "inspect",
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      id.trim(),
    ]);
    if (
      isIP(address.trim()) !== 4 ||
      !/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(address.trim())
    )
      throw new Error("Expected a private Compose bridge address.");
    addresses[service] = address.trim();
  }
  const database = new URL(source.DATABASE_URL_E2E);
  if (database.pathname !== "/relay_chat_ci_e2e")
    throw new Error("Expected the dedicated E2E database.");
  database.hostname = addresses.postgres;
  return {
    DATABASE_URL_E2E: database.href,
    REDIS_URL: `redis://${addresses.redis}:6379`,
  };
}

async function main() {
  const mode = process.argv[2];
  if (mode === "compose-addresses") {
    await exportEnvironment(await composeAddresses(process.env));
    return;
  }
  const values = ciEnvironment(mode, process.env);
  // Mask before database operations so even an unexpected tool failure cannot expose them.
  await exportEnvironment(values);
  if (mode === "integration") {
    const pool = new Pool({
      host: "127.0.0.1",
      port: 5432,
      user: "postgres",
      database: "postgres",
    });
    try {
      // Both identifiers are constants, and the password is generated hexadecimal only.
      await pool.query(`CREATE ROLE relay_ci LOGIN PASSWORD '${values.POSTGRES_PASSWORD}'`);
      await pool.query("CREATE DATABASE relay_chat_ci_test OWNER relay_ci");
    } finally {
      await pool.end();
    }
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error("CI environment setup failed; credentials were not logged.");
    process.exitCode = 1;
  });
