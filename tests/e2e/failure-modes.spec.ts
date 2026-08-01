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

  // Target behavior for later steps: an app-level cache must survive a slow,
  // down, hanging, or corrupt upstream by serving the last-known-good article.
  test.fixme("slow", async ({ request }) => {
    await assertServesArticle(request, "slow");
  });

  test.fixme("down", async ({ request }) => {
    await assertServesArticle(request, "down");
  });

  test.fixme("hang", async ({ request }) => {
    await assertServesArticle(request, "hang");
  });

  test.fixme("corrupt", async ({ request }) => {
    await assertServesArticle(request, "corrupt");
  });
});
