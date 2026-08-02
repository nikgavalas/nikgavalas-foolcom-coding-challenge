import { spawn, type ChildProcess } from "node:child_process";

import { expect, test } from "@playwright/test";

import { listArticles } from "@/lib/cmsMock";

// Distinct from the shared webServer's PORT (playwright.config.ts) — this
// spec needs a genuinely cold server, which the shared long-lived webServer
// can't provide once the suite is underway.
const PORT = "3100";
const BASE_URL = `http://localhost:${PORT}`;
const [seedArticle] = listArticles();

let serverProcess: ChildProcess;

async function waitForReady(deadlineMs = 30_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE_URL);
      if (res.status < 500) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`server on ${BASE_URL} did not become ready in time`);
}

test.describe("cold start prewarm", () => {
  test.beforeAll(async () => {
    serverProcess = spawn("npx", ["next", "start", "-p", PORT], {
      env: { ...process.env, PORT },
      stdio: "pipe",
    });
    await waitForReady();
    // instrumentation.ts's prewarm() is fire-and-forget (never blocks server
    // startup), so "accepting connections" isn't the same as "cache warm."
    // There's no readiness signal to poll for yet (that's step 10's stats
    // endpoint), and the mocked CMS is a same-process route with a handful
    // of seed articles, so prewarm finishes in low tens of ms — a short
    // fixed wait is the simplest thing that reliably works here.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  test.afterAll(() => {
    serverProcess?.kill();
  });

  test("cold server serves real content on the very first ?source=down request", async ({
    request,
  }) => {
    const response = await request.get(
      `${BASE_URL}/articles/${seedArticle.path}?source=down`,
    );

    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toContain(seedArticle.headline);
    expect(html).toContain('data-testid="article-version"');
  });
});
