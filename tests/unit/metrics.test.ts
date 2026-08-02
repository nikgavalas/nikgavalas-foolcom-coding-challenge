import { beforeEach, describe, expect, it, vi } from "vitest";

import { metrics } from "@/lib/observability/metrics";

beforeEach(() => {
  metrics.reset();
});

describe("metrics counters", () => {
  it("increments from zero on first call", () => {
    metrics.increment("cache_reads");
    expect(metrics.getCounter("cache_reads")).toBe(1);
  });

  it("accumulates across calls", () => {
    metrics.increment("cache_reads");
    metrics.increment("cache_reads");
    metrics.increment("cache_reads");
    expect(metrics.getCounter("cache_reads")).toBe(3);
  });

  it("bumps by a custom value", () => {
    metrics.increment("cache_reads", {}, 5);
    expect(metrics.getCounter("cache_reads")).toBe(5);
  });

  it("tracks distinct tag sets as independent series", () => {
    metrics.increment("upstream_calls", { outcome: "ok" });
    metrics.increment("upstream_calls", { outcome: "timeout" });
    metrics.increment("upstream_calls", { outcome: "timeout" });

    expect(metrics.getCounter("upstream_calls", { outcome: "ok" })).toBe(1);
    expect(metrics.getCounter("upstream_calls", { outcome: "timeout" })).toBe(2);
  });

  it("treats tag key order as the same series", () => {
    metrics.increment("upstream_calls", { outcome: "ok", caller: "read" });
    metrics.increment("upstream_calls", { caller: "read", outcome: "ok" });

    expect(metrics.getCounter("upstream_calls", { outcome: "ok", caller: "read" })).toBe(2);
  });

  it("returns undefined for a series that was never recorded", () => {
    expect(metrics.getCounter("never_recorded")).toBeUndefined();
  });

  it("snapshots all tracked series with the right shape", () => {
    metrics.increment("a", { caller: "read" });
    metrics.increment("b", { caller: "push" }, 2);

    const snapshot = metrics.snapshotCounters();
    expect(snapshot).toContainEqual({ name: "a", tags: { caller: "read" }, value: 1 });
    expect(snapshot).toContainEqual({ name: "b", tags: { caller: "push" }, value: 2 });
  });

  it("clears on reset", () => {
    metrics.increment("cache_reads");
    metrics.reset();
    expect(metrics.getCounter("cache_reads")).toBeUndefined();
    expect(metrics.snapshotCounters()).toEqual([]);
  });

  it("does not let a mutated snapshot affect subsequent reads", () => {
    metrics.increment("cache_reads");
    const snapshot = metrics.snapshotCounters();
    snapshot[0].value = 999;
    snapshot[0].tags.injected = "yes";

    expect(metrics.getCounter("cache_reads")).toBe(1);
  });
});

describe("metrics histogram", () => {
  it("summarizes a single observation", () => {
    metrics.histogram("upstream_ms", 100);
    expect(metrics.getHistogramSummary("upstream_ms")).toEqual({
      count: 1,
      sum: 100,
      min: 100,
      max: 100,
      mean: 100,
      p50: 100,
      p95: 100,
      p99: 100,
    });
  });

  it("aggregates count/sum/min/max/mean across observations", () => {
    for (const value of [50, 100, 150]) {
      metrics.histogram("upstream_ms", value);
    }

    const summary = metrics.getHistogramSummary("upstream_ms")!;
    expect(summary.count).toBe(3);
    expect(summary.sum).toBe(300);
    expect(summary.min).toBe(50);
    expect(summary.max).toBe(150);
    expect(summary.mean).toBe(100);
  });

  it("computes exact nearest-rank percentiles under the reservoir cap", () => {
    for (let value = 1; value <= 100; value += 1) {
      metrics.histogram("upstream_ms", value);
    }

    const summary = metrics.getHistogramSummary("upstream_ms")!;
    expect(summary.count).toBe(100);
    expect(summary.p50).toBe(51);
    expect(summary.p95).toBe(96);
    expect(summary.p99).toBe(100);
  });

  it("keeps the reservoir bounded while running aggregates stay exact", () => {
    const observations = 10_000;
    for (let i = 1; i <= observations; i += 1) {
      metrics.histogram("upstream_ms", i);
    }

    const summary = metrics.getHistogramSummary("upstream_ms")!;
    expect(summary.count).toBe(observations);
    expect(summary.sum).toBe((observations * (observations + 1)) / 2);
    expect(summary.min).toBe(1);
    expect(summary.max).toBe(observations);
  });

  it("tracks distinct tag sets as independent series", () => {
    metrics.histogram("upstream_ms", 10, { caller: "read" });
    metrics.histogram("upstream_ms", 20, { caller: "refresher" });

    expect(metrics.getHistogramSummary("upstream_ms", { caller: "read" })?.mean).toBe(10);
    expect(metrics.getHistogramSummary("upstream_ms", { caller: "refresher" })?.mean).toBe(20);
  });

  it("treats tag key order as the same series", () => {
    metrics.histogram("upstream_ms", 10, { caller: "read", outcome: "ok" });
    metrics.histogram("upstream_ms", 20, { outcome: "ok", caller: "read" });

    const summary = metrics.getHistogramSummary("upstream_ms", { caller: "read", outcome: "ok" });
    expect(summary?.count).toBe(2);
  });

  it("returns undefined for a series that was never recorded", () => {
    expect(metrics.getHistogramSummary("never_recorded")).toBeUndefined();
  });

  it("snapshots all tracked series with the full summary shape", () => {
    metrics.histogram("upstream_ms", 42, { caller: "read" });

    const snapshot = metrics.snapshotHistograms();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      name: "upstream_ms",
      tags: { caller: "read" },
      count: 1,
      sum: 42,
      min: 42,
      max: 42,
      mean: 42,
    });
  });

  it("clears on reset", () => {
    metrics.histogram("upstream_ms", 42);
    metrics.reset();
    expect(metrics.getHistogramSummary("upstream_ms")).toBeUndefined();
    expect(metrics.snapshotHistograms()).toEqual([]);
  });
});

describe("metrics singleton", () => {
  it("survives a simulated module re-import via globalThis", async () => {
    metrics.increment("cache_reads");
    expect(metrics.getCounter("cache_reads")).toBe(1);

    vi.resetModules();
    const reimported = await import("@/lib/observability/metrics");

    expect(reimported.metrics.getCounter("cache_reads")).toBe(1);
  });
});
