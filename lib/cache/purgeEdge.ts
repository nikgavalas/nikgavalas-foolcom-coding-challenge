import { toSurrogateKey } from "@/lib/cache/surrogateKey";
import { logger } from "@/lib/observability/logger";
import { metrics } from "@/lib/observability/metrics";

// No real CDN in this exercise. Kept as a seam so the "purge only after the
// origin refresh succeeds" ordering (see app/api/internal/revalidate) is
// explicit, and swapping in a real CDN purge-by-tag call later is a
// one-function change rather than a design change.
export function purgeEdge(path: string): void {
  toSurrogateKey(path);
  metrics.increment("purge_edge");
  logger.info("purge_edge", { path });
}
