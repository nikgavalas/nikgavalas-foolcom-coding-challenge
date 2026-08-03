import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BREAKER_COOLDOWN_MS,
  CircuitBreaker,
  circuitBreaker,
} from "@/lib/cache/circuitBreaker";
import { metrics } from "@/lib/observability/metrics";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    breaker = new CircuitBreaker();
    metrics.reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts closed", () => {
    expect(breaker.getState()).toBe("closed");
    expect(breaker.isAllowed()).toBe(true);
  });

  it("stays closed below the failure threshold", () => {
    breaker.onFailure();
    breaker.onFailure();

    expect(breaker.getState()).toBe("closed");
    expect(breaker.isAllowed()).toBe(true);
  });

  it("opens once the failure threshold is reached", () => {
    breaker.onFailure();
    breaker.onFailure();
    expect(metrics.getCounter("circuit_transitions", { from: "closed", to: "open" })).toBeUndefined();

    breaker.onFailure();

    expect(breaker.getState()).toBe("open");
    expect(breaker.isAllowed()).toBe(false);
    expect(metrics.getCounter("circuit_transitions", { from: "closed", to: "open" })).toBe(1);
  });

  it("keeps rejecting until the cooldown elapses", () => {
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();

    vi.advanceTimersByTime(BREAKER_COOLDOWN_MS - 1);

    expect(breaker.getState()).toBe("open");
    expect(breaker.isAllowed()).toBe(false);
  });

  it("transitions to half-open once the cooldown elapses", () => {
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();

    vi.advanceTimersByTime(BREAKER_COOLDOWN_MS);

    expect(breaker.getState()).toBe("half-open");
  });

  it("admits exactly one probe under concurrent callers", () => {
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();
    vi.advanceTimersByTime(BREAKER_COOLDOWN_MS);

    expect(breaker.isAllowed()).toBe(true);
    expect(breaker.isAllowed()).toBe(false);
    expect(breaker.isAllowed()).toBe(false);
    expect(breaker.getState()).toBe("half-open");
  });

  it("closes and resets the failure count when the probe succeeds", () => {
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();
    vi.advanceTimersByTime(BREAKER_COOLDOWN_MS);
    breaker.isAllowed();

    breaker.onSuccess();
    expect(breaker.getState()).toBe("closed");
    expect(
      metrics.getCounter("circuit_transitions", { from: "half-open", to: "closed" }),
    ).toBe(1);

    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe("closed");
    // Repeated failures below threshold while already closed: no re-emitted transition.
    expect(metrics.getCounter("circuit_transitions", { from: "closed", to: "closed" })).toBeUndefined();
  });

  it("reopens with a fresh cooldown when the probe fails", () => {
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();
    vi.advanceTimersByTime(BREAKER_COOLDOWN_MS);
    breaker.isAllowed();

    breaker.onFailure();
    expect(breaker.getState()).toBe("open");
    expect(
      metrics.getCounter("circuit_transitions", { from: "half-open", to: "open" }),
    ).toBe(1);

    // Repeated onFailure() calls while fully open (cooldown not yet elapsed again)
    // must not re-emit a transition, since from === to === "open" in that window.
    metrics.reset();
    breaker.onFailure();
    expect(metrics.getCounter("circuit_transitions", { from: "open", to: "open" })).toBeUndefined();
    expect(metrics.snapshotCounters().filter((c) => c.name === "circuit_transitions")).toHaveLength(0);

    vi.advanceTimersByTime(BREAKER_COOLDOWN_MS - 1);
    expect(breaker.getState()).toBe("open");

    vi.advanceTimersByTime(1);
    expect(breaker.getState()).toBe("half-open");
  });

  it("resets the consecutive-failure streak on success while closed", () => {
    breaker.onFailure();
    breaker.onSuccess();
    breaker.onFailure();
    breaker.onFailure();

    expect(breaker.getState()).toBe("closed");
  });

  it("exports a ready-to-use singleton that starts closed", () => {
    expect(circuitBreaker.getState()).toBe("closed");
  });
});
