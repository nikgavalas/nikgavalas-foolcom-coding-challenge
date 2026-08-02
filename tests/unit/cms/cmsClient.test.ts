import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchArticle, fetchArticleIndex, UPSTREAM_TIMEOUT_MS } from "@/lib/cms/cmsClient";
import { CORRUPT_ARTICLE_PAYLOAD, listArticles } from "@/lib/cmsMock";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("fetchArticle", () => {
  const [article] = listArticles();

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns ok with the validated article on a healthy 200", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(article));

    const result = await fetchArticle(article.path, "read");

    expect(result.outcome).toBe("ok");
    expect(result.article).toEqual(article);
    expect(typeof result.durationMs).toBe("number");
  });

  it("returns not_found on a 404", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ error: "Not Found" }, 404),
    );

    const result = await fetchArticle("missing/path", "read");

    expect(result.outcome).toBe("not_found");
    expect(result.article).toBeUndefined();
  });

  it("returns http_error on a 500", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ error: "Internal Server Error" }, 500),
    );

    const result = await fetchArticle(article.path, "read");

    expect(result.outcome).toBe("http_error");
    expect(result.article).toBeUndefined();
  });

  it("returns invalid on a structurally corrupt payload", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(CORRUPT_ARTICLE_PAYLOAD));

    const result = await fetchArticle(article.path, "read");

    expect(result.outcome).toBe("invalid");
    expect(result.article).toBeUndefined();
  });

  it("aborts and reports timeout when the upstream hangs past UPSTREAM_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | null | undefined;

    vi.mocked(fetch).mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          capturedSignal = init?.signal;
          capturedSignal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const pending = fetchArticle(article.path, "read");
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS);
    const result = await pending;

    expect(result.outcome).toBe("timeout");
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("forwards the source query param when provided, and omits it otherwise", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(article));

    await fetchArticle(article.path, "read", "down");
    const withSource = vi.mocked(fetch).mock.calls[0][0] as URL;
    expect(withSource.searchParams.get("source")).toBe("down");

    await fetchArticle(article.path, "read");
    const withoutSource = vi.mocked(fetch).mock.calls[1][0] as URL;
    expect(withoutSource.searchParams.has("source")).toBe(false);
  });
});

describe("fetchArticleIndex", () => {
  const articles = listArticles();

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns ok with the index on a healthy 200", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ articles }));

    const result = await fetchArticleIndex("read");

    expect(result.outcome).toBe("ok");
    expect(result.index).toEqual({ articles });
  });

  it("returns invalid when articles is not an array", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ articles: "nope" }));

    const result = await fetchArticleIndex("read");

    expect(result.outcome).toBe("invalid");
    expect(result.index).toBeUndefined();
  });

  it("returns http_error on a 500", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ error: "Internal Server Error" }, 500),
    );

    const result = await fetchArticleIndex("read");

    expect(result.outcome).toBe("http_error");
  });

  it("aborts and reports timeout when the upstream hangs past UPSTREAM_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | null | undefined;

    vi.mocked(fetch).mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          capturedSignal = init?.signal;
          capturedSignal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );

    const pending = fetchArticleIndex("read");
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS);
    const result = await pending;

    expect(result.outcome).toBe("timeout");
    expect(capturedSignal?.aborted).toBe(true);
  });
});
