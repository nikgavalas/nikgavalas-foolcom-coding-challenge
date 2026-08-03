import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cache/articleCache", () => ({
  getArticle: vi.fn(),
  getWarmArticlePaths: vi.fn(),
}));
vi.mock("@/lib/cache/articleIndexCache", () => ({
  getArticleIndex: vi.fn(),
}));

import { getArticle, getWarmArticlePaths } from "@/lib/cache/articleCache";
import { getArticleIndex } from "@/lib/cache/articleIndexCache";
import { metrics } from "@/lib/observability/metrics";
import {
  REFRESH_INTERVAL_MS,
  prewarm,
  refreshWarmArticles,
  register,
} from "@/instrumentation";

const mockGetArticle = vi.mocked(getArticle);
const mockGetWarmArticlePaths = vi.mocked(getWarmArticlePaths);
const mockGetArticleIndex = vi.mocked(getArticleIndex);

const indexEntry = (path: string) => ({
  path,
  headline: `headline-${path}`,
  summary: `summary-${path}`,
  author: "author",
});

describe("prewarm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metrics.reset();
  });

  it("warms every article from the index with caller 'prewarm' and no source", async () => {
    mockGetArticleIndex.mockResolvedValue({
      index: { articles: [indexEntry("a"), indexEntry("b")] },
      status: "MISS",
      ageMs: 0,
    });
    mockGetArticle.mockResolvedValue({ article: null, status: "MISS", ageMs: 0 });

    await prewarm();

    expect(mockGetArticleIndex).toHaveBeenCalledWith({ caller: "prewarm" });
    expect(mockGetArticle).toHaveBeenCalledTimes(2);
    expect(mockGetArticle).toHaveBeenCalledWith("a", { caller: "prewarm" });
    expect(mockGetArticle).toHaveBeenCalledWith("b", { caller: "prewarm" });
    for (const call of mockGetArticle.mock.calls) {
      expect(call[1]).not.toHaveProperty("source");
    }
    // Cycle-level, not per-article: exactly one increment regardless of article count.
    expect(metrics.getCounter("prewarm_runs", { outcome: "ok" })).toBe(1);
  });

  it("resolves without throwing when getArticleIndex rejects", async () => {
    mockGetArticleIndex.mockRejectedValue(new Error("unreachable"));

    await expect(prewarm()).resolves.toBeUndefined();
    expect(mockGetArticle).not.toHaveBeenCalled();
  });

  it("resolves without throwing when the index is null", async () => {
    mockGetArticleIndex.mockResolvedValue({ index: null, status: "UNAVAILABLE", ageMs: 0 });

    await expect(prewarm()).resolves.toBeUndefined();
    expect(mockGetArticle).not.toHaveBeenCalled();
  });

  it("still warms the other paths when one getArticle call rejects", async () => {
    mockGetArticleIndex.mockResolvedValue({
      index: { articles: [indexEntry("a"), indexEntry("b")] },
      status: "MISS",
      ageMs: 0,
    });
    mockGetArticle.mockImplementation((path) =>
      path === "a"
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ article: null, status: "MISS", ageMs: 0 }),
    );

    await expect(prewarm()).resolves.toBeUndefined();
    expect(mockGetArticle).toHaveBeenCalledWith("a", { caller: "prewarm" });
    expect(mockGetArticle).toHaveBeenCalledWith("b", { caller: "prewarm" });
  });
});

describe("refreshWarmArticles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metrics.reset();
    mockGetArticle.mockResolvedValue({ article: null, status: "MISS", ageMs: 0 });
  });

  it("revalidates each path with caller 'refresher' and no source", async () => {
    await refreshWarmArticles(["a", "b"]);

    expect(mockGetArticle).toHaveBeenCalledTimes(2);
    expect(mockGetArticle).toHaveBeenCalledWith("a", { caller: "refresher" });
    expect(mockGetArticle).toHaveBeenCalledWith("b", { caller: "refresher" });
    // Cycle-level, not per-path: exactly one increment regardless of path count.
    expect(metrics.getCounter("refresh_cycles", { caller: "refresher" })).toBe(1);
  });
});

describe("register", () => {
  const originalRuntime = process.env.NEXT_RUNTIME;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetArticleIndex.mockResolvedValue({ index: { articles: [] }, status: "MISS", ageMs: 0 });
    mockGetWarmArticlePaths.mockReturnValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalRuntime === undefined) {
      delete process.env.NEXT_RUNTIME;
    } else {
      process.env.NEXT_RUNTIME = originalRuntime;
    }
  });

  it("does nothing outside the node runtime", () => {
    process.env.NEXT_RUNTIME = "edge";

    register();

    expect(mockGetArticleIndex).not.toHaveBeenCalled();
    expect(mockGetArticle).not.toHaveBeenCalled();
  });

  it("prewarms immediately and refreshes on each interval tick under the node runtime", async () => {
    process.env.NEXT_RUNTIME = "nodejs";
    vi.useFakeTimers();
    mockGetWarmArticlePaths.mockReturnValue(["a"]);

    register();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetArticleIndex).toHaveBeenCalledWith({ caller: "prewarm" });

    await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    expect(mockGetArticle).toHaveBeenCalledWith("a", { caller: "refresher" });
  });

  it("unrefs the refresh interval so it cannot hold the process open", () => {
    process.env.NEXT_RUNTIME = "nodejs";
    const unref = vi.fn();
    const setIntervalSpy = vi.fn(() => ({ unref }));
    vi.stubGlobal("setInterval", setIntervalSpy);

    register();

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), REFRESH_INTERVAL_MS);
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
