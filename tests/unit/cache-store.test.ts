import { describe, expect, it, vi } from "vitest";

import {
  CACHE_MAX_ENTRIES,
  getCacheStore,
  InMemoryCacheStore,
} from "@/lib/cache/store";

describe("InMemoryCacheStore", () => {
  it("evicts the oldest untouched key on overflow", () => {
    const store = new InMemoryCacheStore<string>(3);
    store.set("a", "1");
    store.set("b", "2");
    store.set("c", "3");
    store.set("d", "4");

    expect(store.get("a")).toBeUndefined();
    expect(store.keys()).toEqual(["b", "c", "d"]);
  });

  it("promotes a key to most-recently-used on read", () => {
    const store = new InMemoryCacheStore<string>(3);
    store.set("a", "1");
    store.set("b", "2");
    store.set("c", "3");

    store.get("a"); // promote "a"; "b" is now the oldest
    store.set("d", "4");

    expect(store.get("b")).toBeUndefined();
    expect(store.get("a")).toBe("1");
    expect(store.keys()).toEqual(["c", "d", "a"]);
  });

  it("peekEntries() enumerates without perturbing LRU order", () => {
    const store = new InMemoryCacheStore<string>(3);
    store.set("a", "1");
    store.set("b", "2");
    store.set("c", "3");

    expect(store.peekEntries()).toEqual([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ]);

    // "a" is still the oldest — peeking must not have promoted it like get() would.
    store.set("d", "4");
    expect(store.get("a")).toBeUndefined();
    expect(store.keys()).toEqual(["b", "c", "d"]);
  });

  it("deletes entries", () => {
    const store = new InMemoryCacheStore<string>();
    store.set("a", "1");
    store.delete("a");

    expect(store.get("a")).toBeUndefined();
    expect(store.keys()).not.toContain("a");
  });

  it("defaults to CACHE_MAX_ENTRIES capacity", () => {
    const store = new InMemoryCacheStore<number>();
    for (let i = 0; i < CACHE_MAX_ENTRIES + 1; i++) {
      store.set(`key-${i}`, i);
    }

    expect(store.get("key-0")).toBeUndefined();
    expect(store.keys()).toHaveLength(CACHE_MAX_ENTRIES);
    expect(store.get(`key-${CACHE_MAX_ENTRIES}`)).toBe(CACHE_MAX_ENTRIES);
  });
});

describe("getCacheStore singleton", () => {
  it("returns the same store for repeated calls with the same namespace", () => {
    const first = getCacheStore<string>("same-namespace-test");
    const second = getCacheStore<string>("same-namespace-test");

    first.set("key", "value");
    expect(second.get("key")).toBe("value");
  });

  it("isolates stores by namespace", () => {
    const a = getCacheStore<string>("namespace-a");
    const b = getCacheStore<string>("namespace-b");

    a.set("key", "from-a");
    expect(b.get("key")).toBeUndefined();
  });

  it("survives a simulated module re-import via globalThis", async () => {
    vi.resetModules();
    const first = await import("@/lib/cache/store");
    first.getCacheStore<string>("hmr-test").set("key", "survives-hmr");

    vi.resetModules();
    const second = await import("@/lib/cache/store");

    expect(second.getCacheStore<string>("hmr-test").get("key")).toBe(
      "survives-hmr",
    );
  });
});
