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
      strictTransportSecurity: false,
    }),
    (request, response, next) => {
      if (production && request.secure)
        response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
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
