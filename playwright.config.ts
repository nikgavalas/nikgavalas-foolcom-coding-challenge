import { defineConfig } from "@playwright/test";

const PORT = process.env.PORT ?? "3000";
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // The mocked CMS store is per-process, in-memory, and shared by every test
  // (publishing a correction mutates it permanently) — parallel workers would
  // corrupt each other's state.
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : "list",
  use: {
    baseURL,
  },
  webServer: {
    // Dev-mode timing (on-demand compilation, no minification) is not
    // representative of the latency behavior under test — always build.
    command: "npm run build && npm run start",
    url: baseURL,
    env: { PORT },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
