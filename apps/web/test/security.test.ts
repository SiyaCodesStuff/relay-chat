import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { secureDocument } from "../security-html.js";
import { browserContentSecurityPolicy, themeScriptHash } from "@relay-chat/shared";

describe("production browser CSP", () => {
  it("hashes the exact pre-paint script, puts policy before it, and forbids inline script attributes", () => {
    const html = secureDocument(
      readFileSync(new NodeURL("../index.html", import.meta.url), "utf8"),
    );
    const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(inline).toBeDefined();
    expect(`sha256-${createHash("sha256").update(inline!).digest("base64")}`).toBe(themeScriptHash);
    expect(html.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(
      html.indexOf("<script>"),
    );
    const scripts =
      browserContentSecurityPolicy
        .split("; ")
        .find((directive) => directive.startsWith("script-src ")) ?? "";
    expect(scripts).toContain(`'${themeScriptHash}'`);
    expect(scripts).not.toContain("unsafe-inline");
    expect(scripts).not.toContain("unsafe-eval");
    expect(browserContentSecurityPolicy).toContain("script-src-attr 'none'");
    expect(browserContentSecurityPolicy).toContain("base-uri 'none'");
    expect(html).not.toContain('<script src="/theme.js">');
  });
  it("keeps Vite HMR development-only without relaxing the production policy", () => {
    const html = secureDocument('<head><script src="/theme.js"></script></head>', true);
    expect(html).not.toContain("Content-Security-Policy");
    expect(html).toContain("<script>");
  });
});
