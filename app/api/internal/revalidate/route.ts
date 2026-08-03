import { timingSafeEqual } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { revalidatePath } from "@/lib/cache/articleCache";
import { purgeEdge } from "@/lib/cache/purgeEdge";
import { logger } from "@/lib/observability/logger";
import { metrics } from "@/lib/observability/metrics";

// Every call here triggers a real upstream fetch, so an unauthenticated
// endpoint is a request-amplification vector. Missing/misconfigured secret
// means deny-by-default, not "auth disabled".
function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.REVALIDATE_SECRET;
  if (!expected) return false;

  const provided = request.headers.get("x-revalidate-secret") ?? "";
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(request)) {
    metrics.increment("revalidate_requests", { status: "unauthorized" });
    logger.warn("revalidate_request", { outcome: "unauthorized" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const path = request.nextUrl.searchParams.get("path");
  if (!path) {
    metrics.increment("revalidate_requests", { status: "bad_request" });
    logger.warn("revalidate_request", { outcome: "bad_request" });
    return NextResponse.json(
      { error: "Missing path=<article path> query param" },
      { status: 400 },
    );
  }

  const result = await revalidatePath(path, { caller: "push" });

  // Purge only AFTER the origin refresh succeeds: purging first would make
  // the CDN re-fetch and re-cache the stale version, needing a second purge.
  if (result.article && result.upstreamOutcome === "ok") {
    purgeEdge(path);
  }

  metrics.increment("revalidate_requests", { status: result.status });
  logger.info("revalidate_request", {
    path,
    status: result.status,
    version: result.article?.version,
    upstreamOutcome: result.upstreamOutcome,
  });

  return NextResponse.json({
    path,
    status: result.status,
    version: result.article?.version,
  });
}
