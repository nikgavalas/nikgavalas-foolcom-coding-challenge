import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isRecentlyNotFound, markNotFound, NOT_FOUND_TTL_MS } from "@/lib/cache/notFoundCache";

let pathCounter = 0;
function makePath(): string {
  pathCounter += 1;
  return `missing-article/${pathCounter}`;
}

describe("notFoundCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports not recently not-found for a path that was never marked", () => {
    expect(isRecentlyNotFound(makePath())).toBe(false);
  });

  it("reports recently not-found immediately after marking", () => {
    const path = makePath();
    markNotFound(path);

    expect(isRecentlyNotFound(path)).toBe(true);
  });

  it("expires after NOT_FOUND_TTL_MS", async () => {
    const path = makePath();
    markNotFound(path);

    await vi.advanceTimersByTimeAsync(NOT_FOUND_TTL_MS - 1);
    expect(isRecentlyNotFound(path)).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(isRecentlyNotFound(path)).toBe(false);
  });
});
