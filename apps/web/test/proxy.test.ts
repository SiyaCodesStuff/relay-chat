import { EventEmitter } from "node:events";
import type { ProxyOptions } from "vite";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tailwindcss/vite", () => ({ default: () => ({ name: "test-tailwind" }) }));
vi.mock("@vitejs/plugin-react", () => ({ default: () => ({ name: "test-react" }) }));
import viteConfig, { configureSocketProxy } from "../vite.config.js";

type Proxy = Parameters<NonNullable<ProxyOptions["configure"]>>[0];
async function setup() {
  const proxy = new EventEmitter();
  const socket = Object.assign(new EventEmitter(), { destroyed: false, end: vi.fn() });
  const cleanup = vi.fn();
  socket.on("error", cleanup);
  configureSocketProxy(proxy as Proxy, {});
  // Match Vite's ordering: its loggers are added after the configure hook and
  // after each proxyReqWs handler. Existing transport cleanup must remain.
  const viteProxyLogger = vi.fn();
  const viteSocketLogger = vi.fn();
  proxy.on("error", viteProxyLogger);
  proxy.on("proxyReqWs", (_proxyRequest, _request, client) => client.on("error", viteSocketLogger));
  proxy.emit("proxyReqWs", {}, {}, socket, {}, Buffer.alloc(0));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  return { proxy, socket, cleanup, viteProxyLogger, viteSocketLogger };
}

describe("development Socket.IO proxy logging", () => {
  it.each([
    { command: "serve" as const, mode: "development", isPreview: false, enabled: true },
    { command: "serve" as const, mode: "production", isPreview: true, enabled: false },
    { command: "build" as const, mode: "production", isPreview: false, enabled: false },
  ])(
    "changes only development proxy logging ($command, preview=$isPreview)",
    ({ enabled, ...env }) => {
      const proxy = viteConfig(env).server?.proxy?.["/socket.io"];
      if (!proxy || typeof proxy === "string")
        throw new Error("Expected configured Socket.IO proxy.");
      expect(proxy.target).toBe("http://127.0.0.1:3000");
      expect(proxy.ws).toBe(true);
      expect(proxy.changeOrigin).toBe(false);
      expect(proxy.configure).toBe(enabled ? configureSocketProxy : undefined);
    },
  );
  it.each(["EPIPE", "ECONNRESET", "ERR_STREAM_WRITE_AFTER_END"])(
    "silences only expected %s errors on both paths",
    async (code) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const { proxy, socket, cleanup, viteProxyLogger, viteSocketLogger } = await setup();
      const error = Object.assign(new Error("must not print a stack"), { code });
      proxy.emit("error", error, {}, socket);
      socket.emit("error", error);
      expect(log).not.toHaveBeenCalled();
      expect(viteProxyLogger).not.toHaveBeenCalled();
      expect(viteSocketLogger).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledWith(error);
      expect(socket.end).toHaveBeenCalledOnce();
    },
  );
  it.each([
    "ECONNREFUSED",
    "ENOTFOUND",
    "ETIMEDOUT",
    "EACCES",
    "UNRECOGNIZED",
    "EPIPE\nother",
    undefined,
  ])("logs unexpected code %s once per path without raw details", async (code) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { proxy, socket, viteProxyLogger, viteSocketLogger } = await setup();
    const error = Object.assign(new Error("private-cookie-and-stack-marker"), code ? { code } : {});
    proxy.emit("error", error, {}, socket);
    socket.emit("error", error);
    expect(log.mock.calls).toEqual([
      [`[vite] /socket.io proxy error: ${JSON.stringify(code ?? "UNKNOWN")}`],
      [`[vite] /socket.io client socket error: ${JSON.stringify(code ?? "UNKNOWN")}`],
    ]);
    expect(
      log.mock.calls
        .flat()
        .every(
          (line) =>
            typeof line === "string" && !line.includes("\n") && !line.includes("private-cookie"),
        ),
    ).toBe(true);
    expect(viteProxyLogger).not.toHaveBeenCalled();
    expect(viteSocketLogger).not.toHaveBeenCalled();
  });
  it("preserves HTTP 502 cleanup and avoids writing ended responses", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { proxy } = await setup();
    const response = { headersSent: false, writableEnded: false, end: vi.fn(), writeHead: vi.fn() };
    response.writeHead.mockReturnValue(response);
    proxy.emit("error", Object.assign(new Error(), { code: "ECONNREFUSED" }), {}, response);
    expect(response.writeHead).toHaveBeenCalledWith(502, { "Content-Type": "text/plain" });
    expect(response.end).toHaveBeenCalledOnce();
    response.writableEnded = true;
    proxy.emit("error", new Error(), {}, response);
    expect(response.end).toHaveBeenCalledOnce();
  });
});
