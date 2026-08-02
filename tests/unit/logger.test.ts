import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/observability/logger";

function lastLine(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const call = spy.mock.calls.at(-1);
  expect(call).toBeDefined();
  expect(call).toHaveLength(1);
  return JSON.parse(call![0] as string);
}

describe("logger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes info to console.log with level and fields", () => {
    logger.info("article served", { cacheStatus: "HIT" });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    const parsed = lastLine(logSpy);
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("article served");
    expect(parsed.cacheStatus).toBe("HIT");
  });

  it("routes warn to console.warn, not console.log", () => {
    logger.warn("stale served past deadline");

    expect(logSpy).not.toHaveBeenCalled();
    const parsed = lastLine(warnSpy);
    expect(parsed.level).toBe("warn");
  });

  it("routes error to console.error, not console.log", () => {
    logger.error("upstream unavailable");

    expect(logSpy).not.toHaveBeenCalled();
    const parsed = lastLine(errorSpy);
    expect(parsed.level).toBe("error");
  });

  it("emits a valid ISO-8601 timestamp close to now", () => {
    const before = Date.now();
    logger.info("timestamp check");
    const after = Date.now();

    const parsed = lastLine(logSpy);
    const emitted = Date.parse(parsed.timestamp as string);
    expect(Number.isNaN(emitted)).toBe(false);
    expect(emitted).toBeGreaterThanOrEqual(before);
    expect(emitted).toBeLessThanOrEqual(after);
  });

  it("emits clean JSON with just the envelope when no fields are given", () => {
    logger.info("no fields here");

    const parsed = lastLine(logSpy);
    expect(Object.keys(parsed).sort()).toEqual(["level", "message", "timestamp"]);
  });

  it("round-trips mixed-type field values through JSON", () => {
    logger.info("mixed fields", {
      upstreamMs: 42,
      revalidated: true,
      nested: { articleVersion: 3 },
    });

    const parsed = lastLine(logSpy);
    expect(parsed.upstreamMs).toBe(42);
    expect(parsed.revalidated).toBe(true);
    expect(parsed.nested).toEqual({ articleVersion: 3 });
  });

  it("never lets caller fields clobber the envelope", () => {
    logger.info("real message", {
      message: "hacked",
      level: "error",
      timestamp: "bogus",
    });

    const parsed = lastLine(logSpy);
    expect(parsed.message).toBe("real message");
    expect(parsed.level).toBe("info");
    expect(Number.isNaN(Date.parse(parsed.timestamp as string))).toBe(false);
  });

  it("writes a single line with no embedded newlines", () => {
    logger.info("single line check", { note: "line one\nline two" });

    const call = logSpy.mock.calls.at(-1)!;
    const raw = call[0] as string;
    expect(raw.split("\n")).toHaveLength(1);
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
