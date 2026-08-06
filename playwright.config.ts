import { defineConfig } from "@playwright/test";

const PORT = process.env.PORT ?? "3000";
const baseURL = `http://localhost:${PORT}`;
const REVALIDATE_SECRET =
  process.env.REVALIDATE_SECRET ?? "test-revalidate-secret";

// A second server with no CMS_WEBHOOK_URL, so tests/e2e/corrections.spec.ts can
// exercise push-invalidation-disabled propagation (background refresher, read-path
// bounded revalidate) honestly — CMS_WEBHOOK_URL is fixed for a server process's
// whole lifetime, so a single server can't be toggled per test. Its in-memory CMS
// store, cache and circuit breaker are fully isolated from the main server.
const NO_WEBHOOK_PORT = String(Number(PORT) + 1);
export const noWebhookBaseURL = `http://localhost:${NO_WEBHOOK_PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  // The mocked CMS store is per-process, in-memory, and shared by every test
  // (publishing a correction mutates it permanently) — parallel workers would
  // corrupt each other's state.
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
  },
  webServer: [
    {
      // Dev-mode timing (on-demand compilation, no minification) is not
      // representative of the latency behavior under test — always build.
      command: "npm run build && npm run start",
      url: baseURL,
      env: {
        PORT,
        REVALIDATE_SECRET,
        REFRESH_INTERVAL_MS: "2000",
        CMS_WEBHOOK_URL: `${baseURL}/api/internal/revalidate`,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // webServer entries are started sequentially (each is awaited before the
      // next begins), so by the time this one runs, the entry above has already
      // finished `npm run build` — reuse that .next output instead of building
      // (and racing) a second time.
      command: "npm run start",
      url: noWebhookBaseURL,
      env: {
        PORT: NO_WEBHOOK_PORT,
        REFRESH_INTERVAL_MS: "2000",
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
