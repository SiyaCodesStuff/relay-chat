// SHA-256 of the exact UTF-8 bytes in apps/web/public/theme.js. The web build
// verifies this before inlining the blocking bootstrap; update both intentionally.
export const themeScriptHash = "sha256-YWaGTsLigbjweSCwJMAEl/n6haK+3rnOQtKdU5G5eDY=";
export const browserContentSecurityPolicy = [
  "default-src 'none'",
  `script-src 'self' '${themeScriptHash}'`,
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");
