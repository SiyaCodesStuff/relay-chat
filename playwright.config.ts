import { defineConfig } from "@playwright/test";

process.env.NODE_ENV = "test";

// Opt-in only. No retries, persisted authentication state, traces or videos.
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { browserName: "chromium", trace: "off", video: "off", screenshot: "off" },
});
