import { logger } from "@/lib/observability/logger";
import { metrics } from "@/lib/observability/metrics";

export const BREAKER_FAIL_THRESHOLD = 3;
export const BREAKER_COOLDOWN_MS = 5000;

export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  failThreshold?: number;
  cooldownMs?: number;
}

/**
 * Global closed -> open -> half-open breaker for the upstream CMS.
 *
 * Callers must call isAllowed() before attempting the upstream call, and
 * only call onSuccess()/onFailure() if isAllowed() returned true for that
 * attempt. A caller that never reports back leaves the half-open probe
 * claimed forever; this is not guarded against here since every real caller
 * (lib/cms/cmsClient.ts) reports within UPSTREAM_TIMEOUT_MS.
 */
export class CircuitBreaker {
  private readonly failThreshold: number;
  private readonly cooldownMs: number;
  private state: "closed" | "open" = "closed";
  private failureCount = 0;
  private openedAt: number | null = null;
  private probeInFlight = false;

  constructor(config?: CircuitBreakerConfig) {
    this.failThreshold = config?.failThreshold ?? BREAKER_FAIL_THRESHOLD;
    this.cooldownMs = config?.cooldownMs ?? BREAKER_COOLDOWN_MS;
  }

  getState(): CircuitState {
    if (this.state === "closed") return "closed";
    return this.cooldownElapsed() ? "half-open" : "open";
  }

  isAllowed(): boolean {
    if (this.state === "closed") return true;
    if (!this.cooldownElapsed()) return false;
    if (this.probeInFlight) return false;

    this.probeInFlight = true;
    return true;
  }

  onSuccess(): void {
    const from = this.getState();
    if (this.state === "open") {
      this.state = "closed";
      this.openedAt = null;
      this.probeInFlight = false;
    }
    this.failureCount = 0;
    this.recordTransition(from, this.getState());
  }

  onFailure(): void {
    const from = this.getState();
    if (this.state === "open") {
      this.openedAt = Date.now();
      this.probeInFlight = false;
      this.recordTransition(from, this.getState());
      return;
    }

    this.failureCount += 1;
    if (this.failureCount >= this.failThreshold) {
      this.state = "open";
      this.openedAt = Date.now();
      this.probeInFlight = false;
    }
    this.recordTransition(from, this.getState());
  }

  private recordTransition(from: CircuitState, to: CircuitState): void {
    if (from === to) return;
    metrics.increment("circuit_transitions", { from, to });
    const log = to === "open" ? logger.warn : logger.info;
    log("circuit_transition", { from, to, failureCount: this.failureCount });
  }

  private cooldownElapsed(): boolean {
    return this.openedAt !== null && Date.now() - this.openedAt >= this.cooldownMs;
  }
}

export const circuitBreaker = new CircuitBreaker();
