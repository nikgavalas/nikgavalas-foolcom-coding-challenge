import { NextResponse } from "next/server";

import { getArticleCacheSnapshot } from "@/lib/cache/articleCache";
import { getArticleIndexCacheSnapshot } from "@/lib/cache/articleIndexCache";
import { circuitBreaker } from "@/lib/cache/circuitBreaker";
import { metrics } from "@/lib/observability/metrics";

// Read-only diagnostics view of already-cached state — no upstream I/O, so
// unlike /api/internal/revalidate this isn't a request-amplification vector
// and needs no auth gate.
export async function GET(): Promise<NextResponse> {
  const entries = getArticleCacheSnapshot();

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    circuitBreaker: { state: circuitBreaker.getState() },
    articleCache: {
      entryCount: entries.length,
      maxAgeMs: entries.reduce((max, entry) => Math.max(max, entry.ageMs), 0),
      entries,
    },
    articleIndexCache: getArticleIndexCacheSnapshot(),
    metrics: {
      counters: metrics.snapshotCounters(),
      histograms: metrics.snapshotHistograms(),
    },
  });
}
