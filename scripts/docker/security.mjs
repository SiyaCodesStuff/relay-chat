import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserContentSecurityPolicy, themeScriptHash } from "@relay-chat/shared";

export { publicOrigin, deploymentOrigins } from "./origins.mjs";
import { publicOrigin, deploymentOrigins } from "./origins.mjs";

export function inlineThemeHash(html) {
  const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(
    (match) => !/\bsrc\s*=/i.test(match[1]),
  );
  if (inline.length !== 1)
    throw new Error("Expected exactly one inline theme bootstrap in built HTML.");
  const hash = `sha256-${createHash("sha256").update(inline[0][2]).digest("base64")}`;
  if (hash !== themeScriptHash)
    throw new Error("Built theme script does not match its reviewed SHA-256.");
  return hash;
}

export function expectedHeaders(html, origin) {
  const hash = inlineThemeHash(html);
  const websockets = deploymentOrigins(origin).map((allowed) => {
    const url = publicOrigin(allowed);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.origin;
  });
  const policy = browserContentSecurityPolicy.replace(
    "connect-src 'self'",
    `connect-src 'self' ${websockets.join(" ")}`,
  );
  if (!policy.includes(`'${hash}'`)) throw new Error("Theme hash missing from script policy.");
  return {
    "content-security-policy": `${policy}; frame-ancestors 'none'`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "cross-origin-opener-policy": "same-origin",
    "x-frame-options": "DENY",
  };
}

export function prepareWeb(html, origin) {
  const policyMeta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?\s*>/gi;
  const matches = [...html.matchAll(policyMeta)];
  if (matches.length !== 1 || matches[0][1] !== browserContentSecurityPolicy)
    throw new Error("Expected the existing build CSP meta policy exactly once.");
  // The ingress supplies one authoritative HTTP policy, including framing and an
  // explicit allowed WS sources. A second meta policy would intersect it.
  const document = html.replace(policyMeta, "");
  const headers = expectedHeaders(document, origin);
  const config =
    Object.entries(headers)
      .map(([name, value]) => `add_header ${name} ${JSON.stringify(value)} always;`)
      .join("\n") + "\n";
  return { html: document, config };
}

export function verifySecurity(html, headers, origin) {
  if (/<meta\s+http-equiv="Content-Security-Policy"/i.test(html))
    throw new Error(
      "Container HTML must rely on the generated HTTP CSP, not a second meta policy.",
    );
  for (const [name, expected] of Object.entries(expectedHeaders(html, origin)))
    if (headers[name] !== expected)
      throw new Error(`Missing or incorrect security header: ${name}`);
  if (
    headers["content-security-policy"]
      .split(";")
      .find((part) => part.trim().startsWith("script-src "))
      ?.includes("unsafe-inline")
  )
    throw new Error("Inline script permission is forbidden.");
  return true;
}

export function configuredHeaders(config) {
  return Object.fromEntries(
    [...config.matchAll(/^add_header ([\w-]+) (".*") always;$/gm)].map((match) => [
      match[1].toLowerCase(),
      JSON.parse(match[2]),
    ]),
  );
}

async function main() {
  const origin = process.env.PUBLIC_ORIGIN ?? "http://localhost:8080";
  const output = new URL("../../docker/generated/", import.meta.url);
  if (process.argv[2] === "generate") {
    const html = await readFile(new URL("../../apps/web/dist/index.html", import.meta.url), "utf8");
    const result = prepareWeb(html, origin);
    await mkdir(output, { recursive: true });
    await writeFile(new URL("index.html", output), result.html);
    await writeFile(new URL("security-headers.conf", output), result.config);
  } else if (process.argv[2] !== "verify") {
    throw new Error("Use security.mjs generate or verify.");
  }
  const html = await readFile(new URL("index.html", output), "utf8");
  const config = await readFile(new URL("security-headers.conf", output), "utf8");
  verifySecurity(html, configuredHeaders(config), origin);
  console.log("PASS built theme SHA-256 and generated Nginx security headers");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
