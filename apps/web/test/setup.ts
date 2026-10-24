import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { server } from "./server.js";
import { FakeChatSocket } from "./fake-socket.js";
vi.mock("socket.io-client", () => ({ io: () => new FakeChatSocket() }));
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});
afterAll(() => server.close());
