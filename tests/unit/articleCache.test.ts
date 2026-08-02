import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ArticleCacheEntry,
  FRESH_TTL_MS,
  REVALIDATE_DEADLINE_MS,
  getArticle,
  revalidatePath,
} from "@/lib/cache/articleCache";
import { CircuitBreaker } from "@/lib/cache/circuitBreaker";
import { getCacheStore } from "@/lib/cache/store";
import { CmsClientResult } from "@/lib/cms/cmsClient";
import { ArticleData } from "@/types/article";

let pathCounter = 0;
function makePath(): string {
  pathCounter += 1;
  return `test-article/${pathCounter}`;
}

function makeArticle(path: string, version = 1): ArticleData {
  return {
    path,
    headline: `Headline v${version}`,
    summary: "Summary",
    author: "Author",
    publishedAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    version,
    body: ["Paragraph"],
  };
}

function articleStore() {
  return getCacheStore<ArticleCacheEntry>("article");
}

function seedStale(path: string, article: ArticleData) {
  articleStore().set(path, {
    article,
    cachedAt: Date.now() - FRESH_TTL_MS - 1,
  });
}

function deferredClient() {
  let resolveClient!: (result: CmsClientResult) => void;
  const client = vi.fn(
    () =>
      new Promise<CmsClientResult>((resolve) => {
        resolveClient = resolve;
      }),
  );
  return { client, resolve: (result: CmsClientResult) => resolveClient(result) };
}

describe("getArticle", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    // Fresh per test: the exported singleton is shared, and this suite's own
    // failure-outcome tests would otherwise cumulatively trip it across
    // tests (BREAKER_FAIL_THRESHOLD = 3), making later tests order-dependent.
    breaker = new CircuitBreaker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a fresh hit without calling the client", async () => {
    const path = makePath();
    const article = makeArticle(path);
    articleStore().set(path, { article, cachedAt: Date.now() });
    const client = vi.fn();

    const result = await getArticle(path, { caller: "read", client, breaker });

    expect(result.status).toBe("HIT");
    expect(result.article).toEqual(article);
    expect(result.upstreamOutcome).toBeUndefined();
    expect(result.ageMs).toBeLessThan(FRESH_TTL_MS);
    expect(client).not.toHaveBeenCalled();
  });

  it("serves stale when the refresh fails and lands within the deadline", async () => {
    const path = makePath();
    const stale = makeArticle(path, 1);
    seedStale(path, stale);
    const client = vi.fn(
      async (): Promise<CmsClientResult> => ({ outcome: "http_error", durationMs: 5 }),
    );

    const result = await getArticle(path, { caller: "read", client, breaker });

    expect(result.status).toBe("STALE");
    expect(result.article).toEqual(stale);
    expect(result.upstreamOutcome).toBe("http_error");
    expect(articleStore().get(path)?.article).toEqual(stale);
  });

  it("revalidates and serves REVALIDATED when the refresh succeeds within the deadline", async () => {
    const path = makePath();
    const stale = makeArticle(path, 1);
    const updated = makeArticle(path, 2);
    seedStale(path, stale);
    const { client, resolve } = deferredClient();

    const pending = getArticle(path, { caller: "read", client, breaker });
    resolve({ outcome: "ok", article: updated, durationMs: 5 });
    const result = await pending;

    expect(result.status).toBe("REVALIDATED");
    expect(result.article).toEqual(updated);
    expect(result.upstreamOutcome).toBe("ok");
    expect(client).toHaveBeenCalledTimes(1);
    expect(articleStore().get(path)?.article).toEqual(updated);
  });

  it("falls back to STALE when the refresh doesn't land within the deadline, and still updates the cache when it later resolves", async () => {
    const path = makePath();
    const stale = makeArticle(path, 1);
    const updated = makeArticle(path, 2);
    seedStale(path, stale);
    const { client, resolve } = deferredClient();

    const pending = getArticle(path, { caller: "read", client, breaker });
    await vi.advanceTimersByTimeAsync(REVALIDATE_DEADLINE_MS);
    const result = await pending;

    expect(result.status).toBe("STALE");
    expect(result.article).toEqual(stale);
    expect(result.upstreamOutcome).toBeUndefined();

    // background refresh keeps running after the deadline expires
    resolve({ outcome: "ok", article: updated, durationMs: 500 });
    await vi.advanceTimersByTimeAsync(0);
    expect(articleStore().get(path)?.article).toEqual(updated);
  });

  it("leaves the entry intact on an error outcome", async () => {
    const path = makePath();
    const stale = makeArticle(path, 1);
    seedStale(path, stale);
    const client = vi.fn(
      async (): Promise<CmsClientResult> => ({ outcome: "timeout", durationMs: 2000 }),
    );

    await getArticle(path, { caller: "read", client, breaker });

    expect(articleStore().get(path)?.article).toEqual(stale);
  });

  it("leaves the entry intact on an invalid payload outcome", async () => {
    const path = makePath();
    const stale = makeArticle(path, 1);
    seedStale(path, stale);
    const client = vi.fn(
      async (): Promise<CmsClientResult> => ({ outcome: "invalid", durationMs: 5 }),
    );

    const result = await getArticle(path, { caller: "read", client, breaker });

    expect(result.status).toBe("STALE");
    expect(result.upstreamOutcome).toBe("invalid");
    expect(articleStore().get(path)?.article).toEqual(stale);
  });

  it("produces exactly one upstream call for N concurrent cold-miss readers", async () => {
    const path = makePath();
    const article = makeArticle(path);
    const client = vi.fn(
      async (): Promise<CmsClientResult> => ({ outcome: "ok", article, durationMs: 5 }),
    );

    const results = await Promise.all([
      getArticle(path, { caller: "read", client, breaker }),
      getArticle(path, { caller: "read", client, breaker }),
      getArticle(path, { caller: "read", client, breaker }),
    ]);

    expect(client).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.status).toBe("MISS");
      expect(result.article).toEqual(article);
    }
  });

  it("produces exactly one upstream call for N concurrent stale readers", async () => {
    const path = makePath();
    const stale = makeArticle(path, 1);
    const updated = makeArticle(path, 2);
    seedStale(path, stale);
    const client = vi.fn(
      async (): Promise<CmsClientResult> => ({ outcome: "ok", article: updated, durationMs: 5 }),
    );

    const results = await Promise.all([
      getArticle(path, { caller: "read", client, breaker }),
      getArticle(path, { caller: "read", client, breaker }),
      getArticle(path, { caller: "read", client, breaker }),
    ]);

    expect(client).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result.status).toBe("REVALIDATED");
      expect(result.article).toEqual(updated);
    }
  });

  it("returns null on a cold miss with a failed fetch", async () => {
    const path = makePath();
    const client = vi.fn(
      async (): Promise<CmsClientResult> => ({ outcome: "http_error", durationMs: 5 }),
    );

    const result = await getArticle(path, { caller: "read", client, breaker });

    expect(result.status).toBe("UNAVAILABLE");
    expect(result.article).toBeNull();
    expect(result.upstreamOutcome).toBe("http_error");
    expect(articleStore().get(path)).toBeUndefined();
  });

  it("doesn't let an aborted fetch poison the next read for the same path", async () => {
    const path = makePath();
    const article = makeArticle(path);
    const { client: hangingClient, resolve } = deferredClient();

    const first = getArticle(path, { caller: "read", client: hangingClient, breaker });
    resolve({ outcome: "timeout", durationMs: 2000 });
    const firstResult = await first;

    expect(firstResult.status).toBe("UNAVAILABLE");

    const secondClient = vi.fn(
      async (): Promise<CmsClientResult> => ({ outcome: "ok", article, durationMs: 5 }),
    );
    const secondResult = await getArticle(path, { caller: "read", client: secondClient, breaker });

    expect(secondClient).toHaveBeenCalledTimes(1);
    expect(secondResult.status).toBe("MISS");
    expect(secondResult.article).toEqual(article);
  });
});

describe("getArticle circuit breaker interaction", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    breaker = new CircuitBreaker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips the bounded wait and serves stale immediately when the circuit is open", async () => {
    const path = makePath();
    const stale = makeArticle(path, 1);
    seedStale(path, stale);
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe("open");

    const client = vi.fn(() => new Promise<CmsClientResult>(() => {}));

    const result = await getArticle(path, { caller: "read", client, breaker });

    expect(result.status).toBe("STALE");
    expect(result.article).toEqual(stale);
    expect(client).not.toHaveBeenCalled();
  });

  it("opens the circuit from real read-path failures, then skips the wait on the next stale read", async () => {
    const failingClient = vi.fn(
      async (): Promise<CmsClientResult> => ({ outcome: "http_error", durationMs: 5 }),
    );

    for (let i = 0; i < 3; i += 1) {
      const path = makePath();
      seedStale(path, makeArticle(path, 1));
      await getArticle(path, { caller: "read", client: failingClient, breaker });
    }

    expect(breaker.getState()).toBe("open");

    const nextPath = makePath();
    const stale = makeArticle(nextPath, 1);
    seedStale(nextPath, stale);
    const hangingClient = vi.fn(() => new Promise<CmsClientResult>(() => {}));

    const result = await getArticle(nextPath, { caller: "read", client: hangingClient, breaker });

    expect(result.status).toBe("STALE");
    expect(result.article).toEqual(stale);
    expect(hangingClient).not.toHaveBeenCalled();
  });
});

describe("revalidatePath", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    breaker = new CircuitBreaker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves the existing entry intact and servable when the upstream is down", async () => {
    const path = makePath();
    const fresh = makeArticle(path, 1);
    // Fresh, not stale — revalidatePath must force revalidation regardless.
    articleStore().set(path, { article: fresh, cachedAt: Date.now() });
    const client = vi.fn(
      async (): Promise<CmsClientResult> => ({ outcome: "http_error", durationMs: 5 }),
    );

    const result = await revalidatePath(path, { caller: "push", client, breaker });

    expect(client).toHaveBeenCalledTimes(1);
    expect(result.article).toEqual(fresh);
    expect(articleStore().get(path)?.article).toEqual(fresh);
  });

  it("overwrites the entry when the upstream succeeds", async () => {
    const path = makePath();
    const original = makeArticle(path, 1);
    const corrected = makeArticle(path, 2);
    articleStore().set(path, { article: original, cachedAt: Date.now() });
    const client = vi.fn(
      async (): Promise<CmsClientResult> => ({ outcome: "ok", article: corrected, durationMs: 5 }),
    );

    const result = await revalidatePath(path, { caller: "push", client, breaker });

    expect(result.article).toEqual(corrected);
    expect(articleStore().get(path)?.article).toEqual(corrected);
  });

  it("performs a cold fetch for a path that was never cached", async () => {
    const path = makePath();
    const article = makeArticle(path);
    const client = vi.fn(
      async (): Promise<CmsClientResult> => ({ outcome: "ok", article, durationMs: 5 }),
    );

    const result = await revalidatePath(path, { caller: "push", client, breaker });

    expect(client).toHaveBeenCalledTimes(1);
    expect(result.article).toEqual(article);
  });
});
