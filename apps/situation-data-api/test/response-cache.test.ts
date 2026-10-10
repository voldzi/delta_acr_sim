import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedResponseCache, ResponseCacheValueExpiredError, type SharedResponseCacheStore } from "../src/response-cache.js";

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
      ttlMs: 5000,
      staleIfErrorMs: 60_000,
      maxEntries: 2,
      usableUntilMs: (value) => value.deadline
    });
    await cache.getOrLoad("generation-a", async () => ({ eta: 60, deadline: 2000 }));
    vi.setSystemTime(1999);
    expect(
      (
        await cache.getOrLoad("generation-a", async () => {
          throw new Error("offline");
        })
      ).eta
    ).toBe(60);
    vi.setSystemTime(2000);
    await expect(
      cache.getOrLoad("generation-a", async () => {
        throw new Error("offline");
      })
    ).rejects.toThrow("offline");
    expect(cache.stats().staleHits).toBe(0);
  });

  it("rejects a newly calculated result when its source expires during the loader", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const cache = new ManagedResponseCache<number>({ ttlMs: 5000, staleIfErrorMs: 60_000, maxEntries: 2 });
    await expect(
      cache.getOrLoad(
        "generation-a",
        async () => {
          vi.setSystemTime(2000);
          return 60;
        },
        { usableUntilMs: 2000 }
      )
    ).rejects.toBeInstanceOf(ResponseCacheValueExpiredError);
    expect(cache.stats().entries).toBe(0);
  });

  it("does not trust a shared cache's longer expiry or stale window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    const cache = new ManagedResponseCache<{ deadline: number }>({
      ttlMs: 5000,
      staleIfErrorMs: 60_000,
      maxEntries: 2,
      usableUntilMs: (value) => value.deadline,
      sharedStore: {
        isAvailable: () => true,
        get: async () => JSON.stringify({ value: { deadline: 1500 }, expiresAtMs: 50_000, staleUntilMs: 100_000 }),
        set: async () => undefined
      }
    });
    await expect(
      cache.getOrLoad("generation-a", async () => {
        throw new Error("offline");
      })
    ).rejects.toThrow("offline");
    expect(cache.stats().sharedHits).toBe(0);
    expect(cache.stats().sharedStaleHits).toBe(0);
  });

  it("preserves stale-on-error for responses without a source deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const cache = new ManagedResponseCache<number>({ ttlMs: 500, staleIfErrorMs: 5000, maxEntries: 2 });
    await cache.getOrLoad("ordinary", async () => 42);
    vi.setSystemTime(2000);
    expect(
      await cache.getOrLoad("ordinary", async () => {
        throw new Error("offline");
      })
    ).toBe(42);
  });
});

describe("ManagedResponseCache per-value cache windows", () => {
  type Feed = { warnings: string[]; generation: string };
  const partial: Feed = { warnings: ["Source temporarily unavailable."], generation: "partial" };
  const complete: Feed = { warnings: [], generation: "complete" };
  const policy = {
    ttlMs: 300_000,
    staleIfErrorMs: 1_800_000,
    maxEntries: 2,
    ttlMsForValue: (value: Feed) => (value.warnings.length ? 30_000 : undefined),
    staleIfErrorMsForValue: (value: Feed) => (value.warnings.length ? 0 : undefined)
  };

  function sharedStore() {
    const values = new Map<string, string>();
    const store: SharedResponseCacheStore = {
      get: vi.fn(async (key) => values.get(key)),
      set: vi.fn(async (key, value) => {
        values.set(key, value);
      }),
      isAvailable: () => true
    };
    return { store, values };
  }

  it("retries a partial feed after 30 seconds and does not serve it stale on failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const cache = new ManagedResponseCache<Feed>(policy);
    await cache.getOrLoad("feed", async () => partial);
    vi.setSystemTime(30_999);
    expect(await cache.getOrLoad("feed", async () => complete)).toEqual(partial);
    vi.setSystemTime(31_000);
    await expect(
      cache.getOrLoad("feed", async () => {
        throw new Error("offline");
      })
    ).rejects.toThrow("offline");
    expect(cache.stats().staleHits).toBe(0);
    expect(await cache.getOrLoad("feed", async () => complete)).toEqual(complete);
    vi.setSystemTime(330_999);
    expect(await cache.getOrLoad("feed", async () => partial)).toEqual(complete);
    vi.setSystemTime(331_000);
    expect(
      await cache.getOrLoad("feed", async () => {
        throw new Error("offline");
      })
    ).toEqual(complete);
    expect(cache.stats().staleHits).toBe(1);
  });

  it("persists the shortened TTL to a shared store and preserves recovery across readers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { store, values } = sharedStore();
    const writer = new ManagedResponseCache<Feed>({ ...policy, sharedStore: store });
    await writer.getOrLoad("feed", async () => partial);
    expect(store.set).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), 30_000);
    const payload = JSON.parse([...values.values()][0]!);
    expect(payload).toMatchObject({ storedAtMs: 1000, expiresAtMs: 31_000, staleUntilMs: 31_000 });
    vi.setSystemTime(30_999);
    const hotReader = new ManagedResponseCache<Feed>({ ...policy, sharedStore: store });
    expect(await hotReader.getOrLoad("feed", async () => complete)).toEqual(partial);
    expect(hotReader.stats().sharedHits).toBe(1);
    vi.setSystemTime(31_000);
    const expiredReader = new ManagedResponseCache<Feed>({ ...policy, sharedStore: store });
    await expect(
      expiredReader.getOrLoad("feed", async () => {
        throw new Error("offline");
      })
    ).rejects.toThrow("offline");
    expect(expiredReader.stats().sharedStaleHits).toBe(0);
    expect(await expiredReader.getOrLoad("feed", async () => complete)).toEqual(complete);
    expect(store.set).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), 2_100_000);
  });

  it("shortens a shared feed written by a reader without the per-value policy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { store } = sharedStore();
    const oldWriter = new ManagedResponseCache<Feed>({ ttlMs: 300_000, staleIfErrorMs: 1_800_000, maxEntries: 2, sharedStore: store });
    await oldWriter.getOrLoad("feed", async () => partial);
    vi.setSystemTime(31_000);
    const restrictedReader = new ManagedResponseCache<Feed>({ ...policy, sharedStore: store });
    await expect(
      restrictedReader.getOrLoad("feed", async () => {
        throw new Error("offline");
      })
    ).rejects.toThrow("offline");
    expect(restrictedReader.stats().sharedHits).toBe(0);
    expect(restrictedReader.stats().sharedStaleHits).toBe(0);
  });

  it("invalid shared-read policies cannot accept a longer producer window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { store } = sharedStore();
    const writer = new ManagedResponseCache<Feed>({ ttlMs: 300_000, staleIfErrorMs: 1_800_000, maxEntries: 2, sharedStore: store });
    await writer.getOrLoad("feed", async () => partial);
    const reader = new ManagedResponseCache<Feed>({
      ...policy,
      sharedStore: store,
      ttlMsForValue: () => Number.NaN,
      staleIfErrorMsForValue: () => Number.POSITIVE_INFINITY
    });
    await expect(
      reader.getOrLoad("feed", async () => {
        throw new Error("offline");
      })
    ).rejects.toThrow("offline");
    expect(reader.stats().sharedHits).toBe(0);
    expect(reader.stats().sharedStaleHits).toBe(0);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 2000])(
    "reloads a legacy or invalid shared origin (%s) rather than renewing its freshness",
    async (storedAtMs) => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const cache = new ManagedResponseCache<Feed>({
        ...policy,
        sharedStore: {
          isAvailable: () => true,
          get: async () => JSON.stringify({ value: partial, storedAtMs, expiresAtMs: 300_000, staleUntilMs: 2_100_000 }),
          set: async () => undefined
        }
      });
      await expect(
        cache.getOrLoad("feed", async () => {
          throw new Error("offline");
        })
      ).rejects.toThrow("offline");
      expect(cache.stats().sharedHits).toBe(0);
      expect(cache.stats().sharedStaleHits).toBe(0);
    }
  );

  it("still accepts legacy shared entries when no new policy is configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const cache = new ManagedResponseCache<Feed>({
      ttlMs: 300_000,
      staleIfErrorMs: 1_800_000,
      maxEntries: 2,
      sharedStore: {
        isAvailable: () => true,
        get: async () => JSON.stringify({ value: complete, expiresAtMs: 300_000, staleUntilMs: 2_100_000 }),
        set: async () => undefined
      }
    });
    expect(await cache.getOrLoad("feed", async () => partial)).toEqual(complete);
    expect(cache.stats().sharedHits).toBe(1);
  });

  it("does not let a per-value policy extend configured or per-load TTLs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const cache = new ManagedResponseCache<string>({
      ttlMs: 500,
      staleIfErrorMs: 0,
      maxEntries: 2,
      ttlMsForValue: () => 10_000
    });
    await cache.getOrLoad("default", async () => "old");
    await cache.getOrLoad("override", async () => "old", { ttlMs: 100 });
    vi.setSystemTime(1100);
    expect(await cache.getOrLoad("override", async () => "new", { ttlMs: 100 })).toBe("new");
    expect(await cache.getOrLoad("default", async () => "new")).toBe("old");
    vi.setSystemTime(1500);
    expect(await cache.getOrLoad("default", async () => "new")).toBe("new");
  });

  it("does not let a per-value stale policy extend the configured error window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const cache = new ManagedResponseCache<string>({
      ttlMs: 100,
      staleIfErrorMs: 500,
      maxEntries: 2,
      staleIfErrorMsForValue: () => 10_000
    });
    await cache.getOrLoad("feed", async () => "old");
    vi.setSystemTime(1599);
    expect(
      await cache.getOrLoad("feed", async () => {
        throw new Error("offline");
      })
    ).toBe("old");
    vi.setSystemTime(1600);
    await expect(
      cache.getOrLoad("feed", async () => {
        throw new Error("offline");
      })
    ).rejects.toThrow("offline");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    "invalid or negative TTL policy (%s) does not retain a fresh value",
    async (duration) => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const cache = new ManagedResponseCache<string>({
        ttlMs: 300_000,
        staleIfErrorMs: 0,
        maxEntries: 2,
        ttlMsForValue: () => duration
      });
      await cache.getOrLoad("feed", async () => "old");
      expect(await cache.getOrLoad("feed", async () => "new")).toBe("new");
      expect(cache.stats().hits).toBe(0);
    }
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    "invalid or negative stale policy (%s) cannot serve an expired value",
    async (duration) => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const cache = new ManagedResponseCache<string>({
        ttlMs: 100,
        staleIfErrorMs: 1_800_000,
        maxEntries: 2,
        staleIfErrorMsForValue: () => duration
      });
      await cache.getOrLoad("feed", async () => "old");
      vi.setSystemTime(1100);
      await expect(
        cache.getOrLoad("feed", async () => {
          throw new Error("offline");
        })
      ).rejects.toThrow("offline");
      expect(cache.stats().staleHits).toBe(0);
    }
  );

  it("treats a throwing policy as a zero-length cache window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const cache = new ManagedResponseCache<string>({
      ttlMs: 300_000,
      staleIfErrorMs: 1_800_000,
      maxEntries: 2,
      ttlMsForValue: () => {
        throw new Error("Invalid policy.");
      },
      staleIfErrorMsForValue: () => {
        throw new Error("Invalid policy.");
      }
    });
    expect(await cache.getOrLoad("feed", async () => "old")).toBe("old");
    await expect(
      cache.getOrLoad("feed", async () => {
        throw new Error("offline");
      })
    ).rejects.toThrow("offline");
    expect(cache.stats().hits).toBe(0);
    expect(cache.stats().staleHits).toBe(0);
  });

  it("coalesces the expired partial feed's recovery without reusing the partial value", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const cache = new ManagedResponseCache<Feed>(policy);
    await cache.getOrLoad("feed", async () => partial);
    vi.setSystemTime(31_000);
    let resolve!: (value: Feed) => void;
    const pending = new Promise<Feed>((accept) => {
      resolve = accept;
    });
    const loader = vi.fn(async () => pending);
    const first = cache.getOrLoad("feed", loader);
    const second = cache.getOrLoad("feed", loader);
    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);
    resolve(complete);
    expect(await first).toEqual(complete);
    expect(await second).toEqual(complete);
    expect(cache.stats().coalescedHits).toBe(1);
    expect(cache.stats().staleHits).toBe(0);
  });

  it("rejects all coalesced callers when an expired partial feed's refresh fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const cache = new ManagedResponseCache<Feed>(policy);
    await cache.getOrLoad("feed", async () => partial);
    vi.setSystemTime(31_000);
    let reject!: (error: Error) => void;
    const pending = new Promise<Feed>((_accept, decline) => {
      reject = decline;
    });
    const loader = vi.fn(async () => pending);
    const first = cache.getOrLoad("feed", loader);
    const second = cache.getOrLoad("feed", loader);
    const assertions = Promise.all([expect(first).rejects.toThrow("offline"), expect(second).rejects.toThrow("offline")]);
    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);
    reject(new Error("offline"));
    await assertions;
    expect(cache.stats().coalescedHits).toBe(1);
    expect(cache.stats().staleHits).toBe(0);
    expect(await cache.getOrLoad("feed", async () => complete)).toEqual(complete);
  });
});
