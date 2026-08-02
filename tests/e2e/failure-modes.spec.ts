import { expect, test } from "@playwright/test";

import { listArticles } from "@/lib/cmsMock";

const [seedArticle] = listArticles();
const articleUrl = (source?: string): string =>
  source
    ? `/articles/${seedArticle.path}?source=${source}`
    : `/articles/${seedArticle.path}`;

const RESPONSE_BUDGET_MS = 1000;

async function assertServesArticle(
  request: import("@playwright/test").APIRequestContext,
  source?: string,
): Promise<void> {
  const start = Date.now();
  const response = await request.get(articleUrl(source));
  const elapsedMs = Date.now() - start;

  expect(response.status()).toBe(200);
  expect(elapsedMs).toBeLessThan(RESPONSE_BUDGET_MS);

  const html = await response.text();
  expect(html).toContain(seedArticle.headline);
  expect(html).toContain('data-testid="article-version"');
}

test.describe("failure modes", () => {
  test("healthy", async ({ request }) => {
    await assertServesArticle(request);
  });

  // An app-level cache survives a down, hanging, or corrupt upstream by
  // serving the last-known-good article (warmed by the "healthy" test above).
  test("down", async ({ request }) => {
    await assertServesArticle(request, "down");
  });

  test("hang", async ({ request }) => {
    await assertServesArticle(request, "hang");
  });

  test("corrupt", async ({ request }) => {
    await assertServesArticle(request, "corrupt");
  });

  // Runs last: the single-flight refresh it triggers is keyed by path only
  // (not path+source) and keeps running in the background past the 400ms
  // deadline, so an earlier `slow` run could still be in flight when
  // down/hang/corrupt fire right after it — they'd join its promise instead
  // of exercising their own named mode. Every test still passes regardless
  // (stale-serve is guaranteed either way), but ordering `slow` last lets
  // each of the others genuinely hit its own upstream mode.
  test("slow", async ({ request }) => {
    await assertServesArticle(request, "slow");
  });
});
