import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { browserContentSecurityPolicy, themeScriptHash } from "@relay-chat/shared";
import {
  configuredHeaders,
  deploymentOrigins,
  expectedHeaders,
  inlineThemeHash,
  prepareWeb,
  publicOrigin,
  verifySecurity,
} from "./security.mjs";

const theme = readFileSync(new URL("../../apps/web/public/theme.js", import.meta.url), "utf8");
const html = `<head><meta http-equiv="Content-Security-Policy" content="${browserContentSecurityPolicy}" /><script>${theme}</script><script type="module" src="/assets/app-123.js"></script></head>`;
const origin = "http://localhost:8080";

test("hashes actual built script bytes and emits a strict same-origin websocket policy", () => {
  const result = prepareWeb(html, origin);
  assert.equal(inlineThemeHash(result.html), themeScriptHash);
  const headers = configuredHeaders(result.config);
  assert.equal(verifySecurity(result.html, headers, origin), true);
  assert.match(
    headers["content-security-policy"],
    /connect-src 'self' ws:\/\/localhost:8080 ws:\/\/127\.0\.0\.1:8080;/,
  );
  assert.match(headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.doesNotMatch(
    headers["content-security-policy"],
    /script-src[^;]*unsafe-inline|ws: |wss: /,
  );
  assert.equal(headers["strict-transport-security"], undefined);
  assert.match(result.html, /<script type="module" src="\/assets\/app-123.js">/);
});
test("HTTPS uses only its corresponding WSS origin without implicitly enabling HSTS", () => {
  const headers = expectedHeaders(html, "https://chat.example.test");
  assert.match(headers["content-security-policy"], /connect-src 'self' wss:\/\/chat.example.test;/);
  assert.equal(headers["strict-transport-security"], undefined);
});
test("rejects changed, missing and extra inline scripts", () => {
  for (const altered of [
    html.replace(theme, `${theme} `),
    html.replace(`<script>${theme}</script>`, ""),
    `${html}<script>alert(1)</script>`,
  ])
    assert.throws(() => prepareWeb(altered, origin), /inline theme|reviewed SHA-256/);
});
test("fails closed for missing, duplicate or changed build meta policies", () => {
  for (const altered of [
    html.replace(/<meta[^>]*>/, ""),
    html + html,
    html.replace("default-src 'none'", "default-src *"),
  ])
    assert.throws(() => prepareWeb(altered, origin));
});
test("verification detects missing headers, a stale hash and a second meta policy", () => {
  const result = prepareWeb(html, origin);
  const headers = configuredHeaders(result.config);
  for (const name of Object.keys(headers)) {
    const altered = { ...headers };
    delete altered[name];
    assert.throws(() => verifySecurity(result.html, altered, origin), /security header/);
  }
  assert.throws(() =>
    verifySecurity(
      result.html,
      { ...headers, "content-security-policy": "script-src 'unsafe-inline'" },
      origin,
    ),
  );
  assert.throws(
    () => verifySecurity(result.html.replace(theme, "changed"), headers, origin),
    /SHA-256/,
  );
  assert.throws(() => verifySecurity(html, headers, origin), /meta policy/);
});
test("rejects public HTTP, credentials, paths, wildcards and header injection", () => {
  for (const value of [
    "http://chat.example.test",
    "https://user:password@example.test",
    "https://example.test/",
    "*",
    "https://example.test\r\nx-header: injected",
    "javascript:alert(1)",
    "https://*.example.test",
    "https://$host",
  ])
    assert.throws(() => publicOrigin(value), /PUBLIC_ORIGIN/);
});

test("both HTTP loopback origins generate identical CSP with only the same-port websocket pair", () => {
  for (const port of ["", ":8080", ":9090"]) {
    const localhost = `http://localhost${port}`;
    const loopback = `http://127.0.0.1${port}`;
    assert.deepEqual(deploymentOrigins(loopback), [localhost, loopback]);
    assert.deepEqual(expectedHeaders(html, localhost), expectedHeaders(html, loopback));
    const policy = expectedHeaders(html, localhost)["content-security-policy"];
    assert.equal(
      policy
        .split(";")
        .find((part) => part.trim().startsWith("connect-src"))
        ?.trim(),
      `connect-src 'self' ws://localhost${port} ws://127.0.0.1${port}`,
    );
  }
  for (const exact of ["https://chat.example.test", "https://localhost:8080", "http://[::1]:8080"])
    assert.deepEqual(deploymentOrigins(exact), [exact]);
  assert.throws(() => deploymentOrigins("http://localhost.evil.example:8080"), /PUBLIC_ORIGIN/);
});
