import { getCacheStore } from "@/lib/cache/store";
import { CmsCaller, CmsClientResult, CmsOutcome, fetchArticle } from "@/lib/cms/cmsClient";
import { ArticleData } from "@/types/article";

export const FRESH_TTL_MS = 1000;
export const REVALIDATE_DEADLINE_MS = 400;

const NAMESPACE = "article";

export interface ArticleCacheEntry {
  article: ArticleData;
  cachedAt: number;
}

export type ArticleCacheStatus = "HIT" | "REVALIDATED" | "STALE" | "MISS" | "UNAVAILABLE";

export interface ArticleCacheResult {
  article: ArticleData | null;
  status: ArticleCacheStatus;
  // 0 for MISS/UNAVAILABLE — no prior entry existed, so age is not meaningful.
  ageMs: number;
  // Set whenever a client call completed; undefined for HIT (no call made)
  // and STALE-via-deadline (call still pending when we returned).
  upstreamOutcome?: CmsOutcome;
}

type CmsClientFn = typeof fetchArticle;

// Keyed per path. Plain module Map, not globalThis: it's transient in-flight
// state, not data that needs to survive HMR — the cached article itself
// already survives HMR via getCacheStore. Worst case of an HMR reset
// mid-flight is one duplicate upstream call in dev.
const inFlight = new Map<string, Promise<CmsClientResult>>();

function getStore() {
  return getCacheStore<ArticleCacheEntry>(NAMESPACE);
}

function getOrStartRefresh(
  path: string,
  caller: CmsCaller,
  source: string | undefined,
  client: CmsClientFn,
): Promise<CmsClientResult> {
  const existing = inFlight.get(path);
  if (existing) return existing;

  // Call the client synchronously (not via a `.then`-deferred wrapper) so
  // this stays within the same synchronous prefix that the single-flight
  // guarantee on getArticle depends on.
  let clientPromise: Promise<CmsClientResult>;
  try {
    clientPromise = client(path, caller, source);
  } catch {
    clientPromise = Promise.resolve({ outcome: "http_error", durationMs: 0 });
  }

  const promise = clientPromise
    // The real fetchArticle never rejects, but a client is out of contract
    // if it throws/rejects; normalize rather than crash the read path.
    .catch((): CmsClientResult => ({ outcome: "http_error", durationMs: 0 }))
    .then((result) => {
      // Non-negotiable: an entry is overwritten ONLY by an `ok` outcome.
      if (result.outcome === "ok" && result.article) {
        getStore().set(path, { article: result.article, cachedAt: Date.now() });
      }
      return result;
    })
    .finally(() => {
      // MUST run on both success and failure, or a dead promise poisons
      // every later read for this path.
      inFlight.delete(path);
    });

  inFlight.set(path, promise);
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

// LOAD-BEARING: no `await` of any kind may run before the call into
// getOrStartRefresh below. Single-flight relies on every concurrent
// getArticle() call for the same path completing its synchronous prefix
// (store.get + branch selection + inFlight.set) before any of them suspend.
// One added `await` here (logging, a future breaker check, etc.) silently
// breaks that guarantee.
export async function getArticle(
  path: string,
  options: { caller: CmsCaller; source?: string; client?: CmsClientFn },
): Promise<ArticleCacheResult> {
  const { caller, source, client = fetchArticle } = options;
  const store = getStore();
  const entry = store.get(path);

  if (!entry) {
    const result = await getOrStartRefresh(path, caller, source, client);
    if (result.outcome === "ok" && result.article) {
      const stored = store.get(path)!;
      return {
        article: stored.article,
        status: "MISS",
        ageMs: Date.now() - stored.cachedAt,
        upstreamOutcome: "ok",
      };
    }
    return { article: null, status: "UNAVAILABLE", ageMs: 0, upstreamOutcome: result.outcome };
  }

  const ageMs = Date.now() - entry.cachedAt;
  if (ageMs < FRESH_TTL_MS) {
    return { article: entry.article, status: "HIT", ageMs, upstreamOutcome: undefined };
  }

  const raced = await withDeadline(
    getOrStartRefresh(path, caller, source, client),
    REVALIDATE_DEADLINE_MS,
  );

  if (raced.landed && raced.value.outcome === "ok" && raced.value.article) {
    // Defensive: LRU (CACHE_MAX_ENTRIES) could theoretically evict between write and read.
    const updated = store.get(path) ?? entry;
    return {
      article: updated.article,
      status: "REVALIDATED",
      ageMs: Date.now() - updated.cachedAt,
      upstreamOutcome: "ok",
    };
  }

  const current = store.get(path) ?? entry;
  return {
    article: current.article,
    status: "STALE",
    ageMs: Date.now() - current.cachedAt,
    upstreamOutcome: raced.landed ? raced.value.outcome : undefined,
  };
}
