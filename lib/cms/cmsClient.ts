import { validateArticle } from "@/lib/cms/validateArticle";
import { ArticleData, ArticleIndexData } from "@/types/article";

export const UPSTREAM_TIMEOUT_MS = 2000;

const PORT = process.env.PORT ?? "3000";
const CMS_BASE_URL =
  process.env.CMS_BASE_URL ?? `http://localhost:${PORT}/api/cms`;

/**
 * Distinguishes background traffic from real reads so later observability
 * (step 10) doesn't let the refresher/prewarm/push callers skew the
 * user-facing latency and health signal.
 */
export type CmsCaller = "read" | "refresher" | "push" | "prewarm";

export type CmsOutcome = "ok" | "timeout" | "http_error" | "invalid" | "not_found";

export interface CmsClientResult {
  outcome: CmsOutcome;
  article?: ArticleData;
  durationMs: number;
}

/**
 * Single choke point for all CMS I/O. Wraps the upstream fetch with a hard
 * timeout (the old services/articleService.ts fetch had none, so `?source=hang`
 * leaked one open socket per request) and classifies the result so callers
 * never have to inspect status codes or catch fetch errors themselves.
 */
export async function fetchArticle(
  path: string,
  // Unused until step 10 instruments call sites by caller.
  caller: CmsCaller,
  source?: string,
): Promise<CmsClientResult> {
  const url = new URL(`${CMS_BASE_URL}/content/${path}`);
  if (source) url.searchParams.set("source", source);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const startedAt = Date.now();
  const durationMs = () => Date.now() - startedAt;

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        signal: controller.signal,
      });
    } catch {
      const outcome: CmsOutcome = controller.signal.aborted
        ? "timeout"
        : "http_error";
      return { outcome, durationMs: durationMs() };
    }

    if (response.status === 404) {
      return { outcome: "not_found", durationMs: durationMs() };
    }
    if (!response.ok) {
      return { outcome: "http_error", durationMs: durationMs() };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { outcome: "invalid", durationMs: durationMs() };
    }

    const result = validateArticle(payload, path);
    return result.ok
      ? { outcome: "ok", article: result.article, durationMs: durationMs() }
      : { outcome: "invalid", durationMs: durationMs() };
  } finally {
    clearTimeout(timer);
  }
}

export interface CmsIndexClientResult {
  outcome: CmsOutcome;
  index?: ArticleIndexData;
  durationMs: number;
}

function isValidIndexPayload(payload: unknown): payload is ArticleIndexData {
  return (
    typeof payload === "object" &&
    payload !== null &&
    Array.isArray((payload as { articles?: unknown }).articles)
  );
}

/**
 * Same choke point as fetchArticle, for the article index. The index route
 * has no `?source=` failure-mode support (see app/api/cms/content/route.ts),
 * so there's no structurally-plausible-but-wrong payload to defend against —
 * a shape check is enough, unlike the per-field validateArticle rules.
 */
export async function fetchArticleIndex(
  // Unused until step 10 instruments call sites by caller.
  caller: CmsCaller,
): Promise<CmsIndexClientResult> {
  const url = new URL(`${CMS_BASE_URL}/content`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const startedAt = Date.now();
  const durationMs = () => Date.now() - startedAt;

  try {
    let response: Response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        signal: controller.signal,
      });
    } catch {
      const outcome: CmsOutcome = controller.signal.aborted
        ? "timeout"
        : "http_error";
      return { outcome, durationMs: durationMs() };
    }

    if (!response.ok) {
      return { outcome: "http_error", durationMs: durationMs() };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { outcome: "invalid", durationMs: durationMs() };
    }

    return isValidIndexPayload(payload)
      ? { outcome: "ok", index: payload, durationMs: durationMs() }
      : { outcome: "invalid", durationMs: durationMs() };
  } finally {
    clearTimeout(timer);
  }
}
