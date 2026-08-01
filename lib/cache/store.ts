export const CACHE_MAX_ENTRIES = 500;

export interface CacheStore<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  delete(key: string): void;
  keys(): string[];
}

/**
 * Map iteration order == insertion order, so LRU is implemented by deleting
 * and re-setting a key whenever it's touched (read or write) to push it to
 * the end; the first key in iteration order is always the oldest.
 */
export class InMemoryCacheStore<T> implements CacheStore<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly maxEntries: number = CACHE_MAX_ENTRIES) {}

  get(key: string): T | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as T;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  keys(): string[] {
    return Array.from(this.entries.keys());
  }
}

// Next's dev-mode HMR re-evaluates modules on every edit, which would reset a
// plain module-level const on every save. Stashing the registry on globalThis
// keeps a single set of stores alive across re-evaluation, so local behavior
// matches production. Keyed by namespace so different callers (article cache,
// article index, etc.) each get their own isolated store from one registry.
const GLOBAL_REGISTRY_KEY = "__foolcom_cache_store_registry__";

type GlobalWithCacheRegistry = typeof globalThis & {
  [GLOBAL_REGISTRY_KEY]?: Map<string, InMemoryCacheStore<unknown>>;
};

function getRegistry(): Map<string, InMemoryCacheStore<unknown>> {
  const g = globalThis as GlobalWithCacheRegistry;
  if (!g[GLOBAL_REGISTRY_KEY]) {
    g[GLOBAL_REGISTRY_KEY] = new Map();
  }
  return g[GLOBAL_REGISTRY_KEY];
}

export function getCacheStore<T>(namespace: string): CacheStore<T> {
  const registry = getRegistry();
  if (!registry.has(namespace)) {
    registry.set(namespace, new InMemoryCacheStore<unknown>());
  }
  return registry.get(namespace) as unknown as CacheStore<T>;
}
