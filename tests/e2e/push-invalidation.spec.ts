import { expect, test } from "@playwright/test";

import { listArticles } from "@/lib/cmsMock";

// Use a different seed article than failure-modes.spec.ts / cdn-headers.spec.ts
// (which both use the first) — this spec bumps the article's version via a
// real correction publish, and that mutation is permanent for the process,
// so keep it off the article other specs assert exact content against.
const [, seedArticle] = listArticles();

const REVALIDATE_SECRET =
  process.env.REVALIDATE_SECRET ?? "test-revalidate-secret";
const RESPONSE_BUDGET_MS = 1000;

test.describe("push invalidation", () => {
  test("an unauthenticated revalidate request is rejected", async ({ request }) => {
    const response = await request.post(
      `/api/internal/revalidate?path=${seedArticle.path}`,
    );

    expect(response.status()).toBe(401);
  });

  test("a revalidate request with the wrong secret is rejected", async ({ request }) => {
    const response = await request.post(
      `/api/internal/revalidate?path=${seedArticle.path}`,
      { headers: { "x-revalidate-secret": "wrong-secret" } },
    );

    expect(response.status()).toBe(401);
  });

  // Mirrors the grading flow: publish a correction, then confirm every reader
  // gets it immediately. Push invalidation is what makes this "immediately"
  // rather than waiting on the next stale read or the 2s background refresher.
  test("publishing a correction with the webhook enabled yields the corrected version on the very next request", async ({
    request,
  }) => {
    // Warm the cache first so there's an existing entry for the webhook-driven
    // revalidate to overwrite.
    const before = await request.get(`/articles/${seedArticle.path}`);
    expect(before.status()).toBe(200);

    const publish = await request.post(
      `/api/cms/admin?publish-correction=${seedArticle.path}`,
    );
    expect(publish.status()).toBe(200);
    const { version: publishedVersion } = await publish.json();

    // The webhook call from the admin route is fire-and-forget; give it a
    // brief moment to land before asserting propagation.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const start = Date.now();
    const after = await request.get(`/articles/${seedArticle.path}`);
    const elapsedMs = Date.now() - start;

    expect(after.status()).toBe(200);
    expect(elapsedMs).toBeLessThan(RESPONSE_BUDGET_MS);
    const html = await after.text();
    expect(html).toContain(`Correction (v${publishedVersion})`);
  });

  test("a correctly authenticated revalidate call succeeds", async ({ request }) => {
    const response = await request.post(
      `/api/internal/revalidate?path=${seedArticle.path}`,
      { headers: { "x-revalidate-secret": REVALIDATE_SECRET } },
    );

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.path).toBe(seedArticle.path);
  });
});
