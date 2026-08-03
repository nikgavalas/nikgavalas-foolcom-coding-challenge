import { APIRequestContext, expect, test } from "@playwright/test";

import { listArticles } from "@/lib/cmsMock";

import { noWebhookBaseURL } from "../../playwright.config";

const articles = listArticles();
const RESPONSE_BUDGET_MS = 1000;
const REFRESH_INTERVAL_MS = 2000;
const FRESH_TTL_MS = 1000;

function correctionText(version: number): string {
  return `Correction (v${version})`;
}

async function publishCorrection(
  request: APIRequestContext,
  path: string,
): Promise<number> {
  const response = await request.post(
    `/api/cms/admin?publish-correction=${path}`,
  );
  expect(response.status()).toBe(200);
  const { version } = await response.json();
  return version as number;
}

/** Polls the cache-stats snapshot (no upstream I/O, so this is never "traffic"
 * against the article read path) until the given path's cached entry reaches
 * `version`, or the deadline passes. */
async function waitForCachedVersion(
  request: APIRequestContext,
  path: string,
  version: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await request.get("/api/_internal/cache-stats");
    const stats = await response.json();
    const entry = stats.articleCache.entries.find(
      (e: { path: string; version: number }) => e.path === path,
    );
    if (entry?.version >= version) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${path} to reach cached version ${version}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// How long after crossing into the stale window we're still willing to call
// it "just went stale" — wide enough to tolerate poll jitter, narrow enough
// to leave a safe margin before the background refresher's next tick
// (REFRESH_INTERVAL_MS) would refresh it back to fresh under us.
const STALE_CATCH_WINDOW_MS = 300;

/** Polls cache-stats until the path's entry has *just* crossed from fresh
 * into stale, so a read against it is guaranteed to trigger the stale-read
 * single-flight revalidate — with enough margin before the next background
 * refresh tick to rule that trigger out too. Background refreshes reset an
 * entry's age on a fixed cycle unrelated to when this starts polling, so a
 * catch outside the early part of the stale window is discarded and the next
 * cycle is awaited instead. */
async function waitForFreshlyStaleEntry(
  request: APIRequestContext,
  path: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await request.get("/api/_internal/cache-stats");
    const stats = await response.json();
    const entry = stats.articleCache.entries.find(
      (e: { path: string; ageMs: number }) => e.path === path,
    );
    if (
      entry &&
      entry.ageMs > FRESH_TTL_MS &&
      entry.ageMs < FRESH_TTL_MS + STALE_CATCH_WINDOW_MS
    ) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${path}'s entry to go stale`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function assertServesCorrectedArticle(
  request: APIRequestContext,
  path: string,
  version: number,
  source?: string,
): Promise<void> {
  const url = source ? `/articles/${path}?source=${source}` : `/articles/${path}`;
  const start = Date.now();
  const response = await request.get(url);
  const elapsedMs = Date.now() - start;

  expect(response.status()).toBe(200);
  expect(elapsedMs).toBeLessThan(RESPONSE_BUDGET_MS);

  const html = await response.text();
  expect(html).toContain(correctionText(version));
}

// Mirrors the grading flow: publish a correction, then confirm every failure
// mode still serves the corrected content, fast. Uses the same seed article as
// failure-modes.spec.ts — safe, since a correction only touches `body`,
// `version` and `updatedAt`, never the `headline` that spec asserts on.
test.describe("correction propagation — full matrix", () => {
  const [seedArticle] = articles;

  test("every failure mode serves the corrected version after a publish", async ({
    request,
  }) => {
    // Warm the cache first so the webhook-driven revalidate has an existing
    // entry to overwrite.
    await request.get(`/articles/${seedArticle.path}`);

    const version = await publishCorrection(request, seedArticle.path);
    await waitForCachedVersion(request, seedArticle.path, version, RESPONSE_BUDGET_MS);

    for (const source of [undefined, "down", "hang", "corrupt", "slow"]) {
      await assertServesCorrectedArticle(request, seedArticle.path, version, source);
    }
  });
});

// One test per propagation trigger — the redundancy is the point, so each is
// shown working alone. Every trigger uses its own seed article to stay
// independent of the others and of the other spec files.
test.describe("correction propagation — triggers", () => {
  test("webhook enabled: corrected version on the very next request", async ({
    request,
  }) => {
    const article = articles[1];

    await request.get(`/articles/${article.path}`);
    const version = await publishCorrection(request, article.path);

    // Fire-and-forget webhook from the admin route; give it a brief moment.
    await new Promise((resolve) => setTimeout(resolve, 200));

    await assertServesCorrectedArticle(request, article.path, version);
  });

  test.describe("webhook disabled", () => {
    test.use({ baseURL: noWebhookBaseURL });

    test("zero traffic: the background refresher delivers the correction on its own", async ({
      request,
    }) => {
      const article = articles[0];

      const version = await publishCorrection(request, article.path);

      // No CMS_WEBHOOK_URL on this server, so nothing pushes this. Poll
      // cache-stats (not the article route) until the refresher's next tick
      // has picked it up, proving the read below isn't what caused it.
      await waitForCachedVersion(
        request,
        article.path,
        version,
        REFRESH_INTERVAL_MS + RESPONSE_BUDGET_MS,
      );

      await assertServesCorrectedArticle(request, article.path, version);
    });

    test("refresher cold: the read-path bounded revalidate delivers the correction", async ({
      request,
    }) => {
      const article = articles[1];

      // A freshly (re)warmed entry is served as an immediate HIT regardless
      // of what was just published — wait until it's past the fresh window
      // so the read below is forced onto the stale-read revalidate path
      // instead of masking the trigger under test.
      await waitForFreshlyStaleEntry(request, article.path, 3 * REFRESH_INTERVAL_MS);

      const version = await publishCorrection(request, article.path);

      // Read immediately, well inside one refresh interval, so only the
      // request's own stale-read single-flight revalidate can have done this.
      await assertServesCorrectedArticle(request, article.path, version);
    });
  });
});
