import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { browserContentSecurityPolicy, themeScriptHash } from "@relay-chat/shared";

const theme = readFileSync(new NodeURL("./public/theme.js", import.meta.url), "utf8");
export function secureDocument(html: string, development = false) {
  const hash = `sha256-${createHash("sha256").update(theme).digest("base64")}`;
  if (hash !== themeScriptHash)
    throw new Error("Theme bootstrap changed: update its reviewed CSP hash.");
  const document = html.replace(
    '<script src="/theme.js"></script>',
    () => `<script>${theme}</script>`,
  );
  if (development) return document;
  return document.replace(
    "<head>",
    `<head>\n    <meta http-equiv="Content-Security-Policy" content="${browserContentSecurityPolicy}" />`,
  );
}
