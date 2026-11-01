import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicOrigin } from "../docker/origins.mjs";

export function releaseMetadata(source) {
  if (source.GITHUB_EVENT_NAME !== "push" || !source.GITHUB_REF?.startsWith("refs/tags/v"))
    throw new Error("Publishing requires a version-tag push.");
  const version = source.GITHUB_REF.slice("refs/tags/".length);
  const owner = source.GITHUB_REPOSITORY_OWNER?.toLowerCase();
  if (
    !/^v[A-Za-z0-9_.-]{0,127}$/.test(version) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(owner ?? "") ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.GITHUB_REPOSITORY ?? "")
  )
    throw new Error("Invalid release image metadata.");
  return {
    version,
    source: `https://github.com/${source.GITHUB_REPOSITORY}`,
    origin: publicOrigin(source.PUBLIC_ORIGIN || "http://localhost:8080").origin,
    images: ["api", "web"].map((name) => ({
      name,
      tag: `ghcr.io/${owner}/relay-chat-${name}:${version}`,
    })),
  };
}
function docker(args, input) {
  const result = spawnSync("docker", args, {
    input,
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
  });
  if (result.error || result.status !== 0) throw new Error("Registry build or publication failed.");
}
function main() {
  const metadata = releaseMetadata(process.env);
  if (!process.env.GHCR_TOKEN) throw new Error("Missing registry authentication.");
  try {
    docker(
      ["login", "ghcr.io", "--username", process.env.GITHUB_REPOSITORY_OWNER, "--password-stdin"],
      process.env.GHCR_TOKEN,
    );
    for (const image of metadata.images) {
      docker([
        "build",
        "--file",
        `docker/${image.name}.Dockerfile`,
        "--tag",
        image.tag,
        "--label",
        `org.opencontainers.image.source=${metadata.source}`,
        "--label",
        `org.opencontainers.image.version=${metadata.version}`,
        "--label",
        `org.opencontainers.image.description=Relay Chat ${image.name === "api" ? "API" : "web client and Nginx ingress"}`,
        ...(image.name === "web" ? ["--build-arg", `PUBLIC_ORIGIN=${metadata.origin}`] : []),
        ".",
      ]);
      docker(["push", image.tag]);
    }
  } finally {
    docker(["logout", "ghcr.io"]);
  }
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  try {
    main();
  } catch {
    console.error("Image publication failed; registry credentials were not logged.");
    process.exitCode = 1;
  }
