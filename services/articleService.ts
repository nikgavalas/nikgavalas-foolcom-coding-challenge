import { getArticle as getCachedArticle } from "@/lib/cache/articleCache";
import { getArticleIndex as getCachedArticleIndex } from "@/lib/cache/articleIndexCache";
import { isRecentlyNotFound, markNotFound } from "@/lib/cache/notFoundCache";
import { ArticleData, ArticleIndexData } from "@/types/article";

export interface GetArticleResult {
  article: ArticleData | null;
  kind: "ok" | "not_found" | "unavailable";
}

export async function getArticle(
  path: string,
  source?: string,
): Promise<GetArticleResult> {
  if (isRecentlyNotFound(path)) {
    return { article: null, kind: "not_found" };
  }

  const result = await getCachedArticle(path, { caller: "read", source });

  if (result.article) {
    return { article: result.article, kind: "ok" };
  }

  if (result.upstreamOutcome === "not_found") {
    markNotFound(path);
    return { article: null, kind: "not_found" };
  }

  return { article: null, kind: "unavailable" };
}

export async function getArticleIndex(): Promise<ArticleIndexData | null> {
  const result = await getCachedArticleIndex({ caller: "read" });
  return result.index;
}
