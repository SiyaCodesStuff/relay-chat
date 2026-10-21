import { describe, expect, it } from "vitest";
import { chatMessageSchema } from "../src/index.js";

describe("shared package smoke test", () => {
  it("validates a bounded chat message", () => {
    expect(
      chatMessageSchema.safeParse({
        roomId: "f87c45b0-3382-4bcb-83e7-f84653e3e454",
        content: "hello",
      }).success,
    ).toBe(true);
    expect(
      chatMessageSchema.safeParse({
        roomId: "f87c45b0-3382-4bcb-83e7-f84653e3e454",
        content: "x".repeat(2_001),
      }).success,
    ).toBe(false);
  });
});
