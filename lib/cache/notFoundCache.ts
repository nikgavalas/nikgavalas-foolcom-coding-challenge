import { getCacheStore } from "@/lib/cache/store";

export const NOT_FOUND_TTL_MS = 30_000;

const NAMESPACE = "article-not-found";

function getStore() {
  return getCacheStore<number>(NAMESPACE);
}

export function isRecentlyNotFound(path: string): boolean {
  const markedAt = getStore().get(path);
  return markedAt !== undefined && Date.now() - markedAt < NOT_FOUND_TTL_MS;
}

export function markNotFound(path: string): void {
  getStore().set(path, Date.now());
}
