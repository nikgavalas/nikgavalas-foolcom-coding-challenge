import { getArticle, getWarmArticlePaths } from "@/lib/cache/articleCache";
import { getArticleIndex } from "@/lib/cache/articleIndexCache";
import { CmsCaller } from "@/lib/cms/cmsClient";
import { logger } from "@/lib/observability/logger";
import { metrics } from "@/lib/observability/metrics";

export const REFRESH_INTERVAL_MS = 2000;

/**
 * Fetches the CMS index and warms the article cache for everything it lists,
 * through the same read-through getArticle() the request path uses. Never
 * throws: a cold start with an unreachable CMS must not crash the server —
 * it should just leave the cache empty and let the request path populate it
 * (or degrade) as usual.
 */
export async function prewarm(): Promise<void> {
  const startedAt = Date.now();
  try {
    const { index } = await getArticleIndex({ caller: "prewarm" });
    if (!index) {
      metrics.increment("prewarm_runs", { outcome: "empty_index" });
      logger.warn("prewarm_run", { outcome: "empty_index", durationMs: Date.now() - startedAt });
      return;
    }

    await Promise.all(
      index.articles.map((article) =>
        getArticle(article.path, { caller: "prewarm" }).catch(() => undefined),
      ),
    );
    metrics.increment("prewarm_runs", { outcome: "ok" });
    metrics.histogram("prewarm_duration_ms", Date.now() - startedAt);
    logger.info("prewarm_run", {
      outcome: "ok",
      articleCount: index.articles.length,
      durationMs: Date.now() - startedAt,
    });
  } catch {
    // Tolerate total failure (index fetch itself threw/rejected).
    metrics.increment("prewarm_runs", { outcome: "error" });
    logger.warn("prewarm_run", { outcome: "error", durationMs: Date.now() - startedAt });
  }
}

/**
 * Revalidates already-warm article paths through the same single-flight
 * getArticle() path a real request uses. Never sends `source` — this probes
 * the real upstream, not a simulated failure mode.
 */
export async function refreshWarmArticles(
  paths: string[],
  caller: CmsCaller = "refresher",
): Promise<void> {
  const startedAt = Date.now();
  await Promise.all(
    paths.map((path) => getArticle(path, { caller }).catch(() => undefined)),
  );
  metrics.increment("refresh_cycles", { caller });
  metrics.histogram("refresh_cycle_duration_ms", Date.now() - startedAt, { caller });
  logger.info("refresh_cycle", { caller, pathCount: paths.length, durationMs: Date.now() - startedAt });
}

export function register(): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Fire-and-forget: not awaited, so it can never delay the server accepting
  // traffic. prewarm() already swallows its own errors.
  void prewarm();

  const timer = setInterval(() => {
    void refreshWarmArticles(getWarmArticlePaths());
  }, REFRESH_INTERVAL_MS);

  // Must not hold the process open.
  timer.unref();
}
