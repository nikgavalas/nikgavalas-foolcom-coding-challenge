import { toSurrogateKey } from "@/lib/cache/surrogateKey";

// No real CDN in this exercise. Kept as a seam so the "purge only after the
// origin refresh succeeds" ordering (see app/api/internal/revalidate) is
// explicit, and swapping in a real CDN purge-by-tag call later is a
// one-function change rather than a design change.
export function purgeEdge(path: string): void {
  toSurrogateKey(path);
}
