import { ArticleData } from "@/types/article";

/**
 * Bounded set of reasons a payload can fail validation. This feeds a metric
 * tag in step 10 (lib/observability/metrics.ts), so it must stay a small,
 * closed set of string literals rather than free text — see
 * docs/DESIGN_OPTIONS.md section C and the cardinality-discipline note in
 * docs/IMPLEMENTATION_PLAN.md step 10.
 */
export type ArticleValidationReason =
  | "missing_field"
  | "bad_version"
  | "bad_date"
  | "bad_body"
  | "placeholder"
  | "path_mismatch";

export type ArticleValidationResult =
  | { ok: true; article: ArticleData }
  | { ok: false; reason: ArticleValidationReason };

const REQUIRED_STRING_FIELDS = [
  "path",
  "headline",
  "summary",
  "author",
  "publishedAt",
  "updatedAt",
] as const satisfies readonly (keyof ArticleData)[];

// Matches any `{{...}}` template placeholder left unresolved by the CMS.
const PLACEHOLDER_PATTERN = /\{\{[^}]*\}\}/;

function containsPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERN.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidDateString(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/**
 * Validates an unknown upstream payload as a real ArticleData record for the
 * requested path.
 *
 * This is content validation, not just shape validation: the CMS's `corrupt`
 * failure mode returns structurally valid JSON with every field present, so a
 * type guard checking only "does the field exist" would let it through. See
 * docs/DESIGN_OPTIONS.md section C.
 */
export function validateArticle(
  payload: unknown,
  requestedPath: string,
): ArticleValidationResult {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "missing_field" };
  }

  const candidate = payload as Record<string, unknown>;

  // Required strings: present, non-empty, and placeholder-free. This loop
  // (including `path`) runs BEFORE the path-equality check below on purpose:
  // the corrupt fixture's own `path` value is a placeholder string
  // ("{{article.path}}"), and that must be classified as "placeholder" (a
  // CMS-corruption signal), not "path_mismatch" (a routing/cache-key
  // signal) — those mean different things operationally.
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = candidate[field];
    if (!isNonEmptyString(value)) {
      return { ok: false, reason: "missing_field" };
    }
    if (containsPlaceholder(value)) {
      return { ok: false, reason: "placeholder" };
    }
  }

  const path = candidate.path as string;
  const headline = candidate.headline as string;
  const summary = candidate.summary as string;
  const author = candidate.author as string;
  const publishedAt = candidate.publishedAt as string;
  const updatedAt = candidate.updatedAt as string;

  if (!isValidDateString(publishedAt) || !isValidDateString(updatedAt)) {
    return { ok: false, reason: "bad_date" };
  }

  const version = candidate.version;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version <= 0
  ) {
    return { ok: false, reason: "bad_version" };
  }

  const body = candidate.body;
  if (!Array.isArray(body) || body.length === 0) {
    return { ok: false, reason: "bad_body" };
  }
  for (const paragraph of body) {
    if (!isNonEmptyString(paragraph)) {
      return { ok: false, reason: "bad_body" };
    }
    if (containsPlaceholder(paragraph)) {
      return { ok: false, reason: "placeholder" };
    }
  }

  // The payload must actually be the article that was requested. Only
  // reached by structurally sound, non-corrupt articles that are simply the
  // wrong one.
  if (path !== requestedPath) {
    return { ok: false, reason: "path_mismatch" };
  }

  return {
    ok: true,
    article: {
      path,
      headline,
      summary,
      author,
      publishedAt,
      updatedAt,
      version,
      body: body as string[],
    },
  };
}
