import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

// Only the documented one-hop topology is supported. Nginx overwrites this header
// with the peer's literal IP; never accept a caller-supplied chain or Forwarded.
export function socketClientAddress(request: IncomingMessage, trustProxy: 0 | 1 = 0) {
  const forwarded = request.headers["x-forwarded-for"];
  if (trustProxy === 1 && typeof forwarded === "string" && isIP(forwarded)) return forwarded;
  return request.socket.remoteAddress ?? "unknown";
}
