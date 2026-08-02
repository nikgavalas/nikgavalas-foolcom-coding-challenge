import { getArticle, getWarmArticlePaths } from "@/lib/cache/articleCache";
import { getArticleIndex } from "@/lib/cache/articleIndexCache";
import { CmsCaller } from "@/lib/cms/cmsClient";

export const REFRESH_INTERVAL_MS = 2000;

/**
 * Fetches the CMS index and warms the article cache for everything it lists,
 * through the same read-through getArticle() the request path uses. Never
 * throws: a cold start with an unreachable CMS must not crash the server —
 * it should just leave the cache empty and let the request path populate it
 * (or degrade) as usual.
 */
export async function prewarm(): Promise<void> {
  try {
    const { index } = await getArticleIndex({ caller: "prewarm" });
    if (!index) return;

    await Promise.all(
      index.articles.map((article) =>
        getArticle(article.path, { caller: "prewarm" }).catch(() => undefined),
      ),
    );
  } catch {
    // Tolerate total failure (index fetch itself threw/rejected).
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
  await Promise.all(
    paths.map((path) => getArticle(path, { caller }).catch(() => undefined)),
  );
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
