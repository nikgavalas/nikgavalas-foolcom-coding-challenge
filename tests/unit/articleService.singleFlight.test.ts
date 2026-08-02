import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks only the upstream client, leaving the real articleCache.getArticle
// (and its single-flight logic) in place. This proves the "≤1 upstream call
// per page render" requirement: Next invokes generateMetadata and the page
// component concurrently, each calling articleService.getArticle once, and
// relies on the cache's single-flight (not React's fetch memoization, which
// this cache replaces) to collapse that into one upstream call.
vi.mock("@/lib/cms/cmsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cms/cmsClient")>();
  return { ...actual, fetchArticle: vi.fn() };
});

import { fetchArticle } from "@/lib/cms/cmsClient";
import { getArticle } from "@/services/articleService";
import { ArticleData } from "@/types/article";

let pathCounter = 0;
function makePath(): string {
  pathCounter += 1;
  return `single-flight-article/${pathCounter}`;
}

function makeArticle(path: string): ArticleData {
  return {
    path,
    headline: "Headline",
    summary: "Summary",
    author: "Author",
    publishedAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    version: 1,
    body: ["Paragraph"],
  };
}

describe("articleService.getArticle single-flight", () => {
  beforeEach(() => {
    vi.mocked(fetchArticle).mockReset();
  });

  it("makes at most one upstream call for two concurrent reads of the same path, mirroring generateMetadata + the page component", async () => {
    const path = makePath();
    const article = makeArticle(path);
    vi.mocked(fetchArticle).mockResolvedValue({ outcome: "ok", article, durationMs: 5 });

    const [metadataCall, pageCall] = await Promise.all([
      getArticle(path, undefined),
      getArticle(path, undefined),
    ]);

    expect(fetchArticle).toHaveBeenCalledTimes(1);
    expect(metadataCall).toEqual({ article, kind: "ok" });
    expect(pageCall).toEqual({ article, kind: "ok" });
  });
});
