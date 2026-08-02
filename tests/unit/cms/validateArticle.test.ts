import { describe, expect, it } from "vitest";

import { validateArticle } from "@/lib/cms/validateArticle";
import { CORRUPT_ARTICLE_PAYLOAD, listArticles } from "@/lib/cmsMock";
import type { ArticleData } from "@/types/article";

function samplePayload(
  overrides: Partial<ArticleData> = {},
): Record<string, unknown> {
  const [base] = listArticles();
  return { ...base, body: [...base.body], ...overrides };
}

describe("validateArticle", () => {
  it("accepts every seeded article for its own path", () => {
    for (const article of listArticles()) {
      expect(validateArticle(article, article.path)).toEqual({
        ok: true,
        article,
      });
    }
  });

  it("rejects the real corrupt fixture", () => {
    const requestedPath = listArticles()[0].path;
    expect(validateArticle(CORRUPT_ARTICLE_PAYLOAD, requestedPath)).toEqual({
      ok: false,
      reason: "placeholder",
    });
  });

  it("rejects a placeholder buried inside body[]", () => {
    const [base] = listArticles();
    const payload = samplePayload({
      body: [base.body[0], "{{article.body.blocks}}", base.body[2]],
    });
    expect(validateArticle(payload, base.path)).toEqual({
      ok: false,
      reason: "placeholder",
    });
  });

  it("rejects a non-positive version", () => {
    const [base] = listArticles();
    expect(validateArticle(samplePayload({ version: 0 }), base.path)).toEqual(
      { ok: false, reason: "bad_version" },
    );
  });

  it("rejects a non-integer version", () => {
    const [base] = listArticles();
    expect(
      validateArticle(samplePayload({ version: 1.5 }), base.path),
    ).toEqual({ ok: false, reason: "bad_version" });
  });

  it("rejects an unparseable date", () => {
    const [base] = listArticles();
    expect(
      validateArticle(samplePayload({ publishedAt: "not-a-date" }), base.path),
    ).toEqual({ ok: false, reason: "bad_date" });
  });

  it("rejects an empty body array", () => {
    const [base] = listArticles();
    expect(validateArticle(samplePayload({ body: [] }), base.path)).toEqual({
      ok: false,
      reason: "bad_body",
    });
  });

  it("rejects an empty required string field", () => {
    const [base] = listArticles();
    expect(
      validateArticle(samplePayload({ headline: "" }), base.path),
    ).toEqual({ ok: false, reason: "missing_field" });
  });

  it("rejects a missing required field", () => {
    const [base] = listArticles();
    const payload = samplePayload();
    delete payload.headline;
    expect(validateArticle(payload, base.path)).toEqual({
      ok: false,
      reason: "missing_field",
    });
  });

  it("rejects a path that doesn't match the requested path", () => {
    const [first, second] = listArticles();
    expect(validateArticle(samplePayload(), second.path)).toEqual({
      ok: false,
      reason: "path_mismatch",
    });
    expect(first.path).not.toBe(second.path);
  });

  it.each([null, "just a string", ["not", "an", "object"], 42])(
    "rejects a non-object payload: %p",
    (payload) => {
      expect(validateArticle(payload, "any/path")).toEqual({
        ok: false,
        reason: "missing_field",
      });
    },
  );
});
