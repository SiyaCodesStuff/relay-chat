import test from "node:test";
import assert from "node:assert/strict";
import { ciEnvironment, composeAddresses } from "./environment.mjs";
import { releaseMetadata } from "./publish.mjs";

const runner = {
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
};
test("CI setup refuses developer and self-hosted environments", () => {
  for (const source of [
    {},
    { ...runner, RUNNER_ENVIRONMENT: "self-hosted" },
    { ...runner, GITHUB_RUN_ID: "../local" },
  ])
    assert.throws(() => ciEnvironment("integration", source), /GitHub-hosted/);
  assert.throws(() => ciEnvironment("production", runner), /supported mode/);
});
test("CI generates fresh credentials and separate integration/E2E databases", () => {
  const integration = ciEnvironment("integration", runner);
  const e2e = ciEnvironment("e2e", runner);
  assert.equal(integration.POSTGRES_PASSWORD === e2e.POSTGRES_PASSWORD, false);
  assert.equal(/^[a-f0-9]{64}$/.test(integration.POSTGRES_PASSWORD), true);
  assert.equal(/^[a-f0-9]{64}$/.test(e2e.SESSION_SECRET), true);
  assert.equal(new URL(integration.DATABASE_URL_TEST).pathname, "/relay_chat_ci_test");
  assert.equal(new URL(e2e.DATABASE_URL_E2E).pathname, "/relay_chat_ci_e2e");
  assert.notEqual(new URL(e2e.DATABASE_URL_E2E).pathname, new URL(e2e.DATABASE_URL_TEST).pathname);
  assert.equal(e2e.COMPOSE_PROJECT_NAME, "relay-ci-123-2");
});
const release = {
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/tags/v1.2.3",
  GITHUB_REPOSITORY_OWNER: "SiyaCodesStuff",
  GITHUB_REPOSITORY: "SiyaCodesStuff/relay-chat",
};
test("release images have distinct lowercase packages and exact version tags", () => {
  assert.deepEqual(
    releaseMetadata(release).images.map((image) => image.tag),
    [
      "ghcr.io/siyacodesstuff/relay-chat-api:v1.2.3",
      "ghcr.io/siyacodesstuff/relay-chat-web:v1.2.3",
    ],
  );
  assert.equal(
    releaseMetadata({ ...release, PUBLIC_ORIGIN: "https://chat.example.test" }).origin,
    "https://chat.example.test",
  );
});
test("publication refuses PRs, branches, unsafe tags and wildcard origins", () => {
  for (const source of [
    { ...release, GITHUB_EVENT_NAME: "pull_request" },
    { ...release, GITHUB_REF: "refs/heads/main" },
    { ...release, GITHUB_REF: "refs/tags/v$(id)" },
    { ...release, PUBLIC_ORIGIN: "*" },
  ])
    assert.throws(() => releaseMetadata(source));
});

test("bridge discovery uses derived Compose settings and rejects non-private addresses", async () => {
  const source = { ...runner, ...ciEnvironment("e2e", runner) };
  const inspect = async (command, args, options) => {
    assert.equal(command, "docker");
    if (args[0] === "compose") {
      assert.equal(Boolean(options.env.DOCKER_DATABASE_URL), true);
      assert.equal(
        options.env.DOCKER_ALLOWED_ORIGINS,
        "http://localhost:8080,http://127.0.0.1:8080",
      );
      assert.equal(options.env.COMPOSE_PROJECT_NAME, source.COMPOSE_PROJECT_NAME);
      return { stdout: `fixture-${args.at(-1)}` };
    }
    return { stdout: args.at(-1) === "fixture-postgres" ? "172.18.0.2\n" : "172.18.0.3\n" };
  };
  const addresses = await composeAddresses(source, inspect);
  assert.equal(new URL(addresses.DATABASE_URL_E2E).hostname, "172.18.0.2");
  assert.equal(new URL(addresses.DATABASE_URL_E2E).pathname, "/relay_chat_ci_e2e");
  assert.equal(addresses.REDIS_URL, "redis://172.18.0.3:6379");
  await assert.rejects(
    composeAddresses({ ...source, COMPOSE_PROJECT_NAME: "relay-chat-production" }, inspect),
    /isolated CI/,
  );
  await assert.rejects(
    composeAddresses(source, async (command, args, options) =>
      args[0] === "inspect" ? { stdout: "203.0.113.1" } : inspect(command, args, options),
    ),
    /private Compose bridge/,
  );
});
