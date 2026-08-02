// Tags are for bounded-cardinality dimensions only (outcome, cache status, caller, circuit
// state, ...). Never tag a metric with an article path — at hundreds of thousands of
// articles that's a cardinality bomb. Path belongs in logs, not metric tags.
export type MetricTags = Record<string, string>;

export interface HistogramSummary {
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface CounterSnapshot {
  name: string;
  tags: MetricTags;
  value: number;
}

export interface HistogramSnapshot extends HistogramSummary {
  name: string;
  tags: MetricTags;
}

interface CounterState {
  tags: MetricTags;
  value: number;
}

// Reservoir sampling (Algorithm R) caps memory per series regardless of how long the
// process runs. count/sum/min/max stay exact running aggregates; only percentiles are
// estimated from the capped sample.
const HISTOGRAM_RESERVOIR_CAP = 200;

interface HistogramState {
  tags: MetricTags;
  count: number;
  sum: number;
  min: number;
  max: number;
  samples: number[];
}

interface MetricsGlobalState {
  counters: Map<string, CounterState>;
  histograms: Map<string, HistogramState>;
}

declare global {
  var __appMetricsState: MetricsGlobalState | undefined;
}

// globalThis singleton so state survives Next dev-mode HMR re-evaluation, matching the
// cache store's singleton pattern (lib/cache/store.ts).
function getState(): MetricsGlobalState {
  if (!globalThis.__appMetricsState) {
    globalThis.__appMetricsState = { counters: new Map(), histograms: new Map() };
  }
  return globalThis.__appMetricsState;
}

function seriesKey(name: string, tags: MetricTags): string {
  const pairs = Object.keys(tags)
    .sort()
    .map((key) => `${key}=${tags[key]}`);
  return pairs.length > 0 ? `${name}{${pairs.join(",")}}` : name;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function summarize(histogram: HistogramState): HistogramSummary {
  const sorted = [...histogram.samples].sort((a, b) => a - b);
  return {
    count: histogram.count,
    sum: histogram.sum,
    min: histogram.min,
    max: histogram.max,
    mean: histogram.count > 0 ? histogram.sum / histogram.count : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

export const metrics = {
  increment(name: string, tags: MetricTags = {}, value = 1): void {
    const { counters } = getState();
    const key = seriesKey(name, tags);
    const existing = counters.get(key);
    if (existing) {
      existing.value += value;
    } else {
      counters.set(key, { tags, value });
    }
  },

  histogram(name: string, valueMs: number, tags: MetricTags = {}): void {
    const { histograms } = getState();
    const key = seriesKey(name, tags);
    let entry = histograms.get(key);
    if (!entry) {
      entry = { tags, count: 0, sum: 0, min: valueMs, max: valueMs, samples: [] };
      histograms.set(key, entry);
    }

    entry.count += 1;
    entry.sum += valueMs;
    entry.min = Math.min(entry.min, valueMs);
    entry.max = Math.max(entry.max, valueMs);

    if (entry.samples.length < HISTOGRAM_RESERVOIR_CAP) {
      entry.samples.push(valueMs);
    } else {
      const r = Math.floor(Math.random() * entry.count);
      if (r < HISTOGRAM_RESERVOIR_CAP) entry.samples[r] = valueMs;
    }
  },

  getCounter(name: string, tags: MetricTags = {}): number | undefined {
    return getState().counters.get(seriesKey(name, tags))?.value;
  },

  getHistogramSummary(name: string, tags: MetricTags = {}): HistogramSummary | undefined {
    const entry = getState().histograms.get(seriesKey(name, tags));
    return entry ? summarize(entry) : undefined;
  },

  snapshotCounters(): CounterSnapshot[] {
    return [...getState().counters.entries()].map(([key, { tags, value }]) => ({
      name: nameFromKey(key),
      tags: { ...tags },
      value,
    }));
  },

  snapshotHistograms(): HistogramSnapshot[] {
    return [...getState().histograms.entries()].map(([key, entry]) => ({
      name: nameFromKey(key),
      tags: { ...entry.tags },
      ...summarize(entry),
    }));
  },

  reset(): void {
    const state = getState();
    state.counters.clear();
    state.histograms.clear();
  },
};

function nameFromKey(key: string): string {
  const braceIndex = key.indexOf("{");
  return braceIndex === -1 ? key : key.slice(0, braceIndex);
}
