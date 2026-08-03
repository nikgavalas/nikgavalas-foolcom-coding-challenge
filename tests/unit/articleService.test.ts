import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cache/articleCache", () => ({
  getArticle: vi.fn(),
}));
vi.mock("@/lib/cache/articleIndexCache", () => ({
  getArticleIndex: vi.fn(),
}));

import { ArticleCacheResult } from "@/lib/cache/articleCache";
import { getArticle as getCachedArticle } from "@/lib/cache/articleCache";
import { ArticleIndexCacheResult } from "@/lib/cache/articleIndexCache";
import { getArticleIndex as getCachedArticleIndex } from "@/lib/cache/articleIndexCache";
import { getArticle, getArticleIndex } from "@/services/articleService";
import { ArticleData, ArticleIndexData } from "@/types/article";

let pathCounter = 0;
function makePath(): string {
  pathCounter += 1;
  return `test-article/${pathCounter}`;
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

describe("articleService.getArticle", () => {
  beforeEach(() => {
    vi.mocked(getCachedArticle).mockReset();
  });

  it("returns kind ok when the cache resolves an article", async () => {
    const path = makePath();
    const article = makeArticle(path);
    const cacheResult: ArticleCacheResult = { article, status: "HIT", ageMs: 0 };
    vi.mocked(getCachedArticle).mockResolvedValue(cacheResult);

    const result = await getArticle(path);

    expect(result).toEqual({ article, kind: "ok", cacheStatus: "HIT", ageMs: 0 });
    expect(getCachedArticle).toHaveBeenCalledWith(path, { caller: "read", source: undefined });
  });

  it("treats a stale-served article as ok even if upstreamOutcome is not_found", async () => {
    const path = makePath();
    const article = makeArticle(path);
    const cacheResult: ArticleCacheResult = {
      article,
      status: "STALE",
      ageMs: 5000,
      upstreamOutcome: "not_found",
    };
    vi.mocked(getCachedArticle).mockResolvedValue(cacheResult);

    const result = await getArticle(path);

    expect(result).toEqual({ article, kind: "ok", cacheStatus: "STALE", ageMs: 5000 });
  });

  it("returns kind not_found on a genuine 404 and negative-caches it", async () => {
    const path = makePath();
    const cacheResult: ArticleCacheResult = {
      article: null,
      status: "UNAVAILABLE",
      ageMs: 0,
      upstreamOutcome: "not_found",
    };
    vi.mocked(getCachedArticle).mockResolvedValue(cacheResult);

    const result = await getArticle(path);

    expect(result).toEqual({ article: null, kind: "not_found" });
  });

  it("skips the cache entirely on a repeat call within the negative-cache TTL", async () => {
    const path = makePath();
    const cacheResult: ArticleCacheResult = {
      article: null,
      status: "UNAVAILABLE",
      ageMs: 0,
      upstreamOutcome: "not_found",
    };
    vi.mocked(getCachedArticle).mockResolvedValue(cacheResult);

    await getArticle(path);
    vi.mocked(getCachedArticle).mockClear();

    const second = await getArticle(path);

    expect(second).toEqual({ article: null, kind: "not_found" });
    expect(getCachedArticle).not.toHaveBeenCalled();
  });

  it("returns kind unavailable and never negative-caches a non-not-found failure", async () => {
    const path = makePath();
    const cacheResult: ArticleCacheResult = {
      article: null,
      status: "UNAVAILABLE",
      ageMs: 0,
      upstreamOutcome: "timeout",
    };
    vi.mocked(getCachedArticle).mockResolvedValue(cacheResult);

    const first = await getArticle(path);
    const second = await getArticle(path);

    expect(first).toEqual({ article: null, kind: "unavailable" });
    expect(second).toEqual({ article: null, kind: "unavailable" });
    expect(getCachedArticle).toHaveBeenCalledTimes(2);
  });

  it("forwards source to the cache layer", async () => {
    const path = makePath();
    const article = makeArticle(path);
    vi.mocked(getCachedArticle).mockResolvedValue({ article, status: "HIT", ageMs: 0 });

    await getArticle(path, "down");

    expect(getCachedArticle).toHaveBeenCalledWith(path, { caller: "read", source: "down" });
  });
});

describe("articleService.getArticleIndex", () => {
  it("passes through the cached index", async () => {
    const index: ArticleIndexData = { articles: [] };
    const cacheResult: ArticleIndexCacheResult = { index, status: "HIT", ageMs: 0 };
    vi.mocked(getCachedArticleIndex).mockResolvedValue(cacheResult);

    const result = await getArticleIndex();

    expect(result).toEqual(index);
  });

  it("returns null when the index cache is unavailable", async () => {
    const cacheResult: ArticleIndexCacheResult = {
      index: null,
      status: "UNAVAILABLE",
      ageMs: 0,
      upstreamOutcome: "http_error",
    };
    vi.mocked(getCachedArticleIndex).mockResolvedValue(cacheResult);

    const result = await getArticleIndex();

    expect(result).toBeNull();
  });
});
