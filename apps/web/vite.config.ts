import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { fileURLToPath, URL as NodeURL } from "node:url";
import type { EventEmitter } from "node:events";
import type { ProxyOptions } from "vite";
import { secureDocument } from "./security-html.js";

const expectedCloseCodes = new Set(["EPIPE", "ECONNRESET", "ERR_STREAM_WRITE_AFTER_END"]);

export const configureSocketProxy: NonNullable<ProxyOptions["configure"]> = (proxy) => {
  const report = (source: string, error: unknown) => {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "UNKNOWN";
    if (!expectedCloseCodes.has(code)) {
      // Codes only: never log request headers, URLs, cookies or raw error objects.
      console.error(`[vite] /socket.io ${source} error: ${JSON.stringify(code)}`);
    }
  };
  const replaceViteLoggers = (emitter: EventEmitter) => {
    const retained = new Set(emitter.listeners("error"));
    // Vite synchronously installs its loggers after configure/proxyReqWs returns.
    // Keep existing handlers (including socket cleanup), replace only that batch.
    queueMicrotask(() => {
      for (const listener of emitter.listeners("error")) {
        if (!retained.has(listener)) {
          emitter.removeListener("error", listener as (...args: unknown[]) => void);
        }
      }
    });
  };
  proxy.on("error", (error, _request, response) => {
    report("proxy", error);
    // Preserve Vite's response cleanup when replacing its default error logger.
    if ("writeHead" in response) {
      if (!response.headersSent && !response.writableEnded) {
        response.writeHead(502, { "Content-Type": "text/plain" }).end();
      }
    } else if (!response.destroyed) response.end();
  });
  replaceViteLoggers(proxy);
  proxy.on("proxyReqWs", (_proxyRequest, _request, socket) => {
    socket.on("error", (error) => report("client socket", error));
    replaceViteLoggers(socket);
  });
};

export default defineConfig(({ command, isPreview }) => ({
  plugins: [
    {
      name: "security-document",
      transformIndexHtml: {
        order: "pre",
        handler: (html, context) => secureDocument(html, Boolean(context.server)),
      },
    },
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "@": fileURLToPath(new NodeURL("./src", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:3000", changeOrigin: false },
      "/socket.io": {
        target: "http://127.0.0.1:3000",
        ws: true,
        changeOrigin: false,
        ...(command === "serve" && !isPreview ? { configure: configureSocketProxy } : {}),
      },
    },
  },
  preview: { host: "127.0.0.1" },
  test: {
    // Each jsdom worker loads the full UI stack; serialize files to avoid CPU contention.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "security-html.ts"],
      reporter: ["text", "json-summary", "html"],
      thresholds: { lines: 80 },
    },
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
    environmentOptions: { jsdom: { url: "http://localhost:5173" } },
  },
}));
