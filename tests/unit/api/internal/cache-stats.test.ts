import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/cache/articleCache", () => ({
  getArticleCacheSnapshot: vi.fn(),
}));
vi.mock("@/lib/cache/articleIndexCache", () => ({
  getArticleIndexCacheSnapshot: vi.fn(),
}));
vi.mock("@/lib/cache/circuitBreaker", () => ({
  circuitBreaker: { getState: vi.fn() },
}));

import { getArticleCacheSnapshot } from "@/lib/cache/articleCache";
import { getArticleIndexCacheSnapshot } from "@/lib/cache/articleIndexCache";
import { circuitBreaker } from "@/lib/cache/circuitBreaker";
import { metrics } from "@/lib/observability/metrics";
import { GET } from "@/app/api/%5Finternal/cache-stats/route";

const mockGetArticleCacheSnapshot = vi.mocked(getArticleCacheSnapshot);
const mockGetArticleIndexCacheSnapshot = vi.mocked(getArticleIndexCacheSnapshot);
const mockGetState = vi.mocked(circuitBreaker.getState);

describe("GET /api/_internal/cache-stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metrics.reset();
    mockGetState.mockReturnValue("closed");
    mockGetArticleIndexCacheSnapshot.mockReturnValue({
      present: true,
      ageMs: 10,
      articleCount: 2,
    });
  });

  it("reports circuit state, per-article entries, max age, and metric snapshots", async () => {
    mockGetArticleCacheSnapshot.mockReturnValue([
      { path: "a", ageMs: 100, version: 1 },
      { path: "b", ageMs: 500, version: 3 },
    ]);
    metrics.increment("upstream_calls", { outcome: "ok", caller: "read" });
    metrics.histogram("upstream_latency_ms", 42, { outcome: "ok", caller: "read" });

    const response = await GET();
    const body = await response.json();

    expect(body.circuitBreaker).toEqual({ state: "closed" });
    expect(body.articleCache).toEqual({
      entryCount: 2,
      maxAgeMs: 500,
      entries: [
        { path: "a", ageMs: 100, version: 1 },
        { path: "b", ageMs: 500, version: 3 },
      ],
    });
    expect(body.articleIndexCache).toEqual({ present: true, ageMs: 10, articleCount: 2 });
    expect(body.metrics.counters).toEqual([
      { name: "upstream_calls", tags: { outcome: "ok", caller: "read" }, value: 1 },
    ]);
    expect(body.metrics.histograms).toHaveLength(1);
    expect(body.metrics.histograms[0].name).toBe("upstream_latency_ms");
    expect(typeof body.generatedAt).toBe("string");
  });

  it("reports zero entries and zero max age when the cache is empty", async () => {
    mockGetArticleCacheSnapshot.mockReturnValue([]);

    const response = await GET();
    const body = await response.json();

    expect(body.articleCache).toEqual({ entryCount: 0, maxAgeMs: 0, entries: [] });
  });
});
