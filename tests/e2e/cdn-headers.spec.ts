import { expect, test } from "@playwright/test";

import { listArticles } from "@/lib/cmsMock";

const [seedArticle] = listArticles();

test.describe("CDN response headers", () => {
  test("healthy article response carries public caching directives", async ({
    request,
  }) => {
    const response = await request.get(`/articles/${seedArticle.path}`);

    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe(
      "public, s-maxage=60, stale-while-revalidate=300, stale-if-error=86400",
    );
    expect(response.headers()["surrogate-key"]).toBe(
      `article-${seedArticle.path.replace(/\//g, "-")}`,
    );
  });

  // A path that has never been cached and whose upstream call fails must
  // render degraded rather than serve stale content it doesn't have — and
  // that degraded response must be a 503 with no-store, or a CDN would cache
  // the outage and serve it to every reader for the full TTL.
  test("cold miss against a failing upstream returns 503 with no-store", async ({
    request,
  }) => {
    const path = `cdn-headers-test/never-cached-${Date.now()}`;
    const response = await request.get(`/articles/${path}?source=down`);

    expect(response.status()).toBe(503);
    expect(response.headers()["cache-control"]).toBe("no-store");
  });
});
