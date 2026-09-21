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
});
