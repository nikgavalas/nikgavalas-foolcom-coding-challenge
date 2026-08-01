import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BREAKER_COOLDOWN_MS,
  CircuitBreaker,
  circuitBreaker,
} from "@/lib/cache/circuitBreaker";

describe("CircuitBreaker", () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    breaker = new CircuitBreaker();
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
    breaker.onFailure();

    expect(breaker.getState()).toBe("open");
    expect(breaker.isAllowed()).toBe(false);
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

    breaker.onFailure();
    breaker.onFailure();
    expect(breaker.getState()).toBe("closed");
  });

  it("reopens with a fresh cooldown when the probe fails", () => {
    breaker.onFailure();
    breaker.onFailure();
    breaker.onFailure();
    vi.advanceTimersByTime(BREAKER_COOLDOWN_MS);
    breaker.isAllowed();

    breaker.onFailure();
    expect(breaker.getState()).toBe("open");

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
