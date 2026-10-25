import helmet from "helmet";
import type { RequestHandler } from "express";
import { browserContentSecurityPolicy } from "@relay-chat/shared";

export function originAllowlist(origins: readonly string[]) {
  if (
    origins.length === 0 ||
    origins.some((origin) => {
      try {
        const url = new URL(origin);
        return !["http:", "https:"].includes(url.protocol) || url.origin !== origin;
      } catch {
        return true;
      }
    })
  )
    throw new Error(
      "Invalid ALLOWED_ORIGINS. Use exact HTTP(S) origins without paths or credentials.",
    );
  return new Set(origins);
}

export function securityHeaders(production: boolean): RequestHandler[] {
  return [
    helmet({
      contentSecurityPolicy: false,
      strictTransportSecurity: production ? { maxAge: 31_536_000 } : false,
    }),
    (_request, response, next) => {
      response.setHeader(
        "Content-Security-Policy",
        `${browserContentSecurityPolicy}; frame-ancestors 'none'`,
      );
      response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      response.setHeader("Cache-Control", "no-store");
      next();
    },
  ];
}
