import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FRESH_TTL_MS, REVALIDATE_DEADLINE_MS } from "@/lib/cache/articleCache";
import {
  ArticleIndexCacheEntry,
  getArticleIndex,
} from "@/lib/cache/articleIndexCache";
import { CircuitBreaker } from "@/lib/cache/circuitBreaker";
import { getCacheStore } from "@/lib/cache/store";
import { CmsIndexClientResult } from "@/lib/cms/cmsClient";
import { ArticleIndexData } from "@/types/article";

const INDEX_KEY = "index";

function makeIndex(version = 1): ArticleIndexData {
  return {
    articles: [
      { path: `article-${version}`, headline: `Headline v${version}`, summary: "Summary", author: "Author" },
    ],
  };
}

function indexStore() {
  return getCacheStore<ArticleIndexCacheEntry>("article-index");
}

function seedStale(index: ArticleIndexData) {
  indexStore().set(INDEX_KEY, { index, cachedAt: Date.now() - FRESH_TTL_MS - 1 });
}

function deferredClient() {
  let resolveClient!: (result: CmsIndexClientResult) => void;
  const client = vi.fn(
    () =>
      new Promise<CmsIndexClientResult>((resolve) => {
        resolveClient = resolve;
      }),
  );
  return { client, resolve: (result: CmsIndexClientResult) => resolveClient(result) };
}

describe("getArticleIndex", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    indexStore().delete(INDEX_KEY);
    // Fresh per test: the exported singleton is shared, and this suite's own
    // failure-outcome tests would otherwise cumulatively trip it across
    // tests (BREAKER_FAIL_THRESHOLD = 3), making later tests order-dependent.
    breaker = new CircuitBreaker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a fresh hit without calling the client", async () => {
    const index = makeIndex();
    indexStore().set(INDEX_KEY, { index, cachedAt: Date.now() });
    const client = vi.fn();

    const result = await getArticleIndex({ caller: "read", client, breaker });

    expect(result.status).toBe("HIT");
    expect(result.index).toEqual(index);
    expect(result.upstreamOutcome).toBeUndefined();
    expect(result.ageMs).toBeLessThan(FRESH_TTL_MS);
    expect(client).not.toHaveBeenCalled();
  });

  it("serves stale when the refresh fails and lands within the deadline", async () => {
    const stale = makeIndex(1);
    seedStale(stale);
    const client = vi.fn(
      async (): Promise<CmsIndexClientResult> => ({ outcome: "http_error", durationMs: 5 }),
    );

    const result = await getArticleIndex({ caller: "read", client, breaker });

    expect(result.status).toBe("STALE");
    expect(result.index).toEqual(stale);
    expect(result.upstreamOutcome).toBe("http_error");
    expect(indexStore().get(INDEX_KEY)?.index).toEqual(stale);
  });

  it("revalidates and serves REVALIDATED when the refresh succeeds within the deadline", async () => {
    const stale = makeIndex(1);
    const updated = makeIndex(2);
    seedStale(stale);
    const { client, resolve } = deferredClient();

    const pending = getArticleIndex({ caller: "read", client, breaker });
    resolve({ outcome: "ok", index: updated, durationMs: 5 });
    const result = await pending;

    expect(result.status).toBe("REVALIDATED");
    expect(result.index).toEqual(updated);
    expect(result.upstreamOutcome).toBe("ok");
    expect(client).toHaveBeenCalledTimes(1);
    expect(indexStore().get(INDEX_KEY)?.index).toEqual(updated);
  });

  it("falls back to STALE when the refresh doesn't land within the deadline, and still updates the cache when it later resolves", async () => {
    const stale = makeIndex(1);
    const updated = makeIndex(2);
    seedStale(stale);
    const { client, resolve } = deferredClient();

    const pending = getArticleIndex({ caller: "read", client, breaker });
    await vi.advanceTimersByTimeAsync(REVALIDATE_DEADLINE_MS);
    const result = await pending;

    expect(result.status).toBe("STALE");
    expect(result.index).toEqual(stale);
    expect(result.upstreamOutcome).toBeUndefined();

    resolve({ outcome: "ok", index: updated, durationMs: 500 });
    await vi.advanceTimersByTimeAsync(0);
    expect(indexStore().get(INDEX_KEY)?.index).toEqual(updated);
  });

  it("leaves the entry intact on an error outcome", async () => {
    const stale = makeIndex(1);
    seedStale(stale);
    const client = vi.fn(
      async (): Promise<CmsIndexClientResult> => ({ outcome: "timeout", durationMs: 2000 }),
    );

    await getArticleIndex({ caller: "read", client, breaker });

    expect(indexStore().get(INDEX_KEY)?.index).toEqual(stale);
  });

  it("produces exactly one upstream call for N concurrent cold-miss readers", async () => {
    const index = makeIndex();
    const client = vi.fn(
      async (): Promise<CmsIndexClientResult> => ({ outcome: "ok", index, durationMs: 5 }),
    );

    const results = await Promise.all([
      getArticleIndex({ caller: "read", client, breaker }),
      getArticleIndex({ caller: "read", client, breaker }),
      getArticleIndex({ caller: "read", client, breaker }),
    ]);

    expect(client).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.status).toBe("MISS");
      expect(result.index).toEqual(index);
    }
  });

  it("returns null on a cold miss with a failed fetch", async () => {
    const client = vi.fn(
      async (): Promise<CmsIndexClientResult> => ({ outcome: "http_error", durationMs: 5 }),
    );

    const result = await getArticleIndex({ caller: "read", client, breaker });

    expect(result.status).toBe("UNAVAILABLE");
    expect(result.index).toBeNull();
    expect(result.upstreamOutcome).toBe("http_error");
    expect(indexStore().get(INDEX_KEY)).toBeUndefined();
  });

  it("skips the bounded wait and serves stale immediately when the circuit is open", async () => {
    const stale = makeIndex(1);
    seedStale(stale);
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe("open");

    const client = vi.fn(() => new Promise<CmsIndexClientResult>(() => {}));

    const result = await getArticleIndex({ caller: "read", client, breaker });

    expect(result.status).toBe("STALE");
    expect(result.index).toEqual(stale);
    expect(client).not.toHaveBeenCalled();
  });
});
