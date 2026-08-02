import { FRESH_TTL_MS, REVALIDATE_DEADLINE_MS } from "@/lib/cache/articleCache";
import { CircuitBreaker, circuitBreaker } from "@/lib/cache/circuitBreaker";
import { getCacheStore } from "@/lib/cache/store";
import { CmsCaller, CmsIndexClientResult, CmsOutcome, fetchArticleIndex } from "@/lib/cms/cmsClient";
import { ArticleIndexData } from "@/types/article";

const NAMESPACE = "article-index";
const INDEX_KEY = "index";

export interface ArticleIndexCacheEntry {
  index: ArticleIndexData;
  cachedAt: number;
}

export type ArticleIndexCacheStatus = "HIT" | "REVALIDATED" | "STALE" | "MISS" | "UNAVAILABLE";

export interface ArticleIndexCacheResult {
  index: ArticleIndexData | null;
  status: ArticleIndexCacheStatus;
  ageMs: number;
  upstreamOutcome?: CmsOutcome;
}

type CmsIndexClientFn = typeof fetchArticleIndex;

// Single implicit key, so single-flight coordination is just one promise
// slot rather than a Map. Plain module-level, not globalThis: transient
// in-flight state, not data that needs to survive HMR — the cached index
// itself already survives HMR via getCacheStore.
let inFlight: Promise<CmsIndexClientResult> | null = null;

function getStore() {
  return getCacheStore<ArticleIndexCacheEntry>(NAMESPACE);
}

function getOrStartRefresh(
  caller: CmsCaller,
  client: CmsIndexClientFn,
  breaker: CircuitBreaker,
): Promise<CmsIndexClientResult> {
  if (inFlight) return inFlight;

  if (!breaker.isAllowed()) {
    return Promise.resolve({ outcome: "http_error", durationMs: 0 });
  }

  let clientPromise: Promise<CmsIndexClientResult>;
  try {
    clientPromise = client(caller);
  } catch {
    clientPromise = Promise.resolve({ outcome: "http_error", durationMs: 0 });
  }

  const promise = clientPromise
    .catch((): CmsIndexClientResult => ({ outcome: "http_error", durationMs: 0 }))
    .then((result) => {
      if (result.outcome === "ok" || result.outcome === "not_found") {
        breaker.onSuccess();
      } else {
        breaker.onFailure();
      }
      if (result.outcome === "ok" && result.index) {
        getStore().set(INDEX_KEY, { index: result.index, cachedAt: Date.now() });
      }
      return result;
    })
    .finally(() => {
      inFlight = null;
    });

  inFlight = promise;
  return promise;
}

async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ landed: true; value: T } | { landed: false }> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<{ landed: false }>((resolve) => {
    timer = setTimeout(() => resolve({ landed: false }), ms);
  });
  const result = await Promise.race([
    promise.then((value) => ({ landed: true, value }) as const),
    timeout,
  ]);
  clearTimeout(timer);
  return result;
}

export async function getArticleIndex(options: {
  caller: CmsCaller;
  client?: CmsIndexClientFn;
  breaker?: CircuitBreaker;
}): Promise<ArticleIndexCacheResult> {
  const { caller, client = fetchArticleIndex, breaker = circuitBreaker } = options;
  const store = getStore();
  const entry = store.get(INDEX_KEY);

  if (!entry) {
    const result = await getOrStartRefresh(caller, client, breaker);
    if (result.outcome === "ok" && result.index) {
      const stored = store.get(INDEX_KEY)!;
      return {
        index: stored.index,
        status: "MISS",
        ageMs: Date.now() - stored.cachedAt,
        upstreamOutcome: "ok",
      };
    }
    return { index: null, status: "UNAVAILABLE", ageMs: 0, upstreamOutcome: result.outcome };
  }

  const ageMs = Date.now() - entry.cachedAt;
  if (ageMs < FRESH_TTL_MS) {
    return { index: entry.index, status: "HIT", ageMs, upstreamOutcome: undefined };
  }

  const raced = await withDeadline(
    getOrStartRefresh(caller, client, breaker),
    REVALIDATE_DEADLINE_MS,
  );

  if (raced.landed && raced.value.outcome === "ok" && raced.value.index) {
    const updated = store.get(INDEX_KEY) ?? entry;
    return {
      index: updated.index,
      status: "REVALIDATED",
      ageMs: Date.now() - updated.cachedAt,
      upstreamOutcome: "ok",
    };
  }

  const current = store.get(INDEX_KEY) ?? entry;
  return {
    index: current.index,
    status: "STALE",
    ageMs: Date.now() - current.cachedAt,
    upstreamOutcome: raced.landed ? raced.value.outcome : undefined,
  };
}
