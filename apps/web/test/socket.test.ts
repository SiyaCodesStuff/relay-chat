import { describe, expect, it, vi } from "vitest";
import { createChatSocket } from "../src/chat/socket.js";

vi.unmock("socket.io-client");

describe("chat socket reconnection configuration", () => {
  it("injects tiny deterministic backoff without opening a connection", () => {
    const socket = createChatSocket({
      reconnectionDelay: 1,
      reconnectionDelayMax: 5,
      randomizationFactor: 0,
    });
    try {
      expect(socket.connected).toBe(false);
      expect(socket.io.reconnectionDelay()).toBe(1);
      expect(socket.io.reconnectionDelayMax()).toBe(5);
      expect(socket.io.randomizationFactor()).toBe(0);
    } finally {
      socket.disconnect();
    }
  });
});
