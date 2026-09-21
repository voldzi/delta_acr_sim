import { describe, expect, it } from "vitest";
import { ManagedResponseCache } from "../src/response-cache.js";

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

  it("serves stale data immediately while one background refresh runs", async () => {
    const cache = new ManagedResponseCache<string>({
      ttlMs: 0,
      staleIfErrorMs: 60_000,
      staleWhileRevalidateMs: 60_000,
      maxEntries: 2
    });
    await cache.getOrLoad("flight", async () => "v1");
    let resolveRefresh: ((value: string) => void) | undefined;
    let refreshCalls = 0;
    const loader = () => {
      refreshCalls += 1;
      return new Promise<string>((resolve) => {
        resolveRefresh = resolve;
      });
    };

    expect(await cache.getOrLoad("flight", loader)).toBe("v1");
    expect(await cache.getOrLoad("flight", loader)).toBe("v1");
    expect(refreshCalls).toBe(1);
    resolveRefresh?.("v2");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await cache.getOrLoad("flight", loader)).toBe("v2");
    expect(cache.stats().staleHits).toBe(3);
  });
});
