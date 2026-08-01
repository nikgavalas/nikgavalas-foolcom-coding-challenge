import { ArticleData, ArticleIndexData } from "@/types/article";

const CMS_BASE_URL =
  process.env.CMS_BASE_URL ?? "http://localhost:3000/api/cms";

export async function getArticle(
  path: string,
  source?: string,
): Promise<ArticleData> {
  const url = new URL(`${CMS_BASE_URL}/content/${path}`);
  if (source) url.searchParams.set("source", source);

  const response = await fetch(url, { cache: "no-store" });
  return response.json();
}

export async function getArticleIndex(): Promise<ArticleIndexData> {
  const response = await fetch(`${CMS_BASE_URL}/content`, {
    cache: "no-store",
  });
  return response.json();
}
