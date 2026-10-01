import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedResponseCache, ResponseCacheValueExpiredError } from "../src/response-cache.js";

afterEach(() => vi.useRealTimers());

describe("ManagedResponseCache LRU", () => {
  it("evicts the least recently used entry in constant-time queue order", async () => {
    const cache = new ManagedResponseCache<string>({ ttlMs: 60_000, staleIfErrorMs: 0, maxEntries: 2 });
    await cache.getOrLoad("a", async () => "a1");
    await cache.getOrLoad("b", async () => "b1");
    await cache.getOrLoad("a", async () => "unexpected");
    await cache.getOrLoad("c", async () => "c1");

    let reloads = 0;
    expect(await cache.getOrLoad("b", async () => `b${++reloads + 1}`)).toBe("b2");
    expect(reloads).toBe(1);
    expect(cache.stats().evictions).toBe(2);
  });
});

describe("ManagedResponseCache source deadlines", () => {
  it("bounds fresh and stale-on-error entries by the source's absolute deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const cache = new ManagedResponseCache<{ eta: number; deadline: number }>({
      ttlMs: 5000, staleIfErrorMs: 60_000, maxEntries: 2, usableUntilMs: (value) => value.deadline
    });
    await cache.getOrLoad("generation-a", async () => ({ eta: 60, deadline: 2000 }));
    vi.setSystemTime(1999);
    expect((await cache.getOrLoad("generation-a", async () => { throw new Error("offline"); })).eta).toBe(60);
    vi.setSystemTime(2000);
    await expect(cache.getOrLoad("generation-a", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(cache.stats().staleHits).toBe(0);
  });

  it("rejects a newly calculated result when its source expires during the loader", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const cache = new ManagedResponseCache<number>({ ttlMs: 5000, staleIfErrorMs: 60_000, maxEntries: 2 });
    await expect(cache.getOrLoad("generation-a", async () => {
      vi.setSystemTime(2000);
      return 60;
    }, { usableUntilMs: 2000 })).rejects.toBeInstanceOf(ResponseCacheValueExpiredError);
    expect(cache.stats().entries).toBe(0);
  });

  it("does not trust a shared cache's longer expiry or stale window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    const cache = new ManagedResponseCache<{ deadline: number }>({
      ttlMs: 5000, staleIfErrorMs: 60_000, maxEntries: 2, usableUntilMs: (value) => value.deadline,
      sharedStore: {
        isAvailable: () => true,
        get: async () => JSON.stringify({ value: { deadline: 1500 }, expiresAtMs: 50_000, staleUntilMs: 100_000 }),
        set: async () => undefined
      }
    });
    await expect(cache.getOrLoad("generation-a", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(cache.stats().sharedHits).toBe(0);
    expect(cache.stats().sharedStaleHits).toBe(0);
  });

  it("preserves stale-on-error for responses without a source deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const cache = new ManagedResponseCache<number>({ ttlMs: 500, staleIfErrorMs: 5000, maxEntries: 2 });
    await cache.getOrLoad("ordinary", async () => 42);
    vi.setSystemTime(2000);
    expect(await cache.getOrLoad("ordinary", async () => { throw new Error("offline"); })).toBe(42);
  });
});
