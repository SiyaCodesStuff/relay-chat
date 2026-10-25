import { act, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { Root } from "react-dom/client";

const mounted = vi.hoisted(() => ({ root: undefined as Root | undefined }));
vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...actual,
    createRoot: (...args: Parameters<typeof actual.createRoot>) => {
      mounted.root = actual.createRoot(...args);
      return mounted.root;
    },
  };
});

it("boots the real application entry point and sends an unauthenticated visitor to login", async () => {
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  window.history.replaceState(null, "", "/");
  try {
    await act(async () => {
      await import("../src/main.js");
    });
    expect(await screen.findByRole("heading", { name: "Sign in to Relay Chat" })).toBeDefined();
    expect(window.location.pathname).toBe("/login");
  } finally {
    await act(async () => mounted.root?.unmount());
    container.remove();
    window.history.replaceState(null, "", "/");
  }
});
