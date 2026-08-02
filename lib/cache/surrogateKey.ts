// Derives a CDN surrogate key from an article path. There is no separate
// article `id` in this codebase — `path` is already the unique identifier
// (it's the cache key throughout lib/cache/articleCache.ts) — so the key is
// just a sanitized form of it. Step 9's purgeEdge(surrogateKey) seam will
// need to compute this same value to purge the right tag.
export function toSurrogateKey(path: string): string {
  return `article-${path.replace(/\//g, "-")}`;
}
