import { describe, expect, it, vi } from "vitest";

import type { ArticleData } from "@/types/article";

describe("test harness sanity", () => {
  it("resolves the @/* path alias", () => {
    const article: Pick<ArticleData, "path" | "version"> = {
      path: "sanity-check",
      version: 1,
    };

    expect(article.path).toBe("sanity-check");
  });

  it("supports fake timers for TTL/cooldown-style assertions", () => {
    vi.useFakeTimers();
    try {
      let fired = false;
      setTimeout(() => {
        fired = true;
      }, 1000);

      expect(fired).toBe(false);
      vi.advanceTimersByTime(1000);
      expect(fired).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
