import { afterEach, describe, expect, it, vi } from "vitest";
import { SafetyAggregationService } from "../src/aggregation.js";
import type { SafetyDataConfig } from "../src/config.js";
import { evaluateNotificationInput } from "../src/notification-input-health.js";
import { collectManagedResponseCacheEvidence, ManagedResponseCache } from "../src/response-cache.js";
import type { SafetyDataSource } from "../src/sources.js";
import type { SafetyFeatureCollection, SafetyQuery } from "../src/types.js";

const INITIAL_NOW = Date.parse("2026-10-10T10:00:00.000Z");

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Notification cache evidence", () => {
  it("does not treat success for another key as recovery of a stale source entry", async () => {
    let now = INITIAL_NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const cache = new ManagedResponseCache<string>({ ttlMs: 1000, staleIfErrorMs: 60_000, maxEntries: 3 });
    await cache.getOrLoad("feed-a", async () => "old source value");
    now += 2000;
    const stale = await collectManagedResponseCacheEvidence(() =>
      cache.getOrLoad("feed-a", async () => {
        throw new Error("upstream unavailable");
      })
    );
    now += 1;
    await cache.getOrLoad("feed-b", async () => "other fresh source");

    expect(stale).toEqual({ value: "old source value", staleFallbackUsed: true });
    expect(cache.stats().unresolvedStaleEntries).toBe(1);
    const result = evaluateNotificationInput(
      collection(now),
      { ...cache.stats(), lastErrorAt: undefined },
      [{ ...cache.stats(), sourceId: "municipal_alerts" }],
      300,
      now
    );
    expect(result.status).toBe("unavailable");
    expect(result.reasons).toContain("requested_source_cache_stale_cache_entry_unrecovered");

    now += 1;
    const recovered = await collectManagedResponseCacheEvidence(() => cache.getOrLoad("feed-a", async () => "same-key fresh replacement"));
    expect(recovered.staleFallbackUsed).toBe(false);
    expect(cache.stats().unresolvedStaleEntries).toBe(0);
  });

  it("records stale evidence separately for every coalesced caller", async () => {
    let now = INITIAL_NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const cache = new ManagedResponseCache<string>({ ttlMs: 1000, staleIfErrorMs: 60_000, maxEntries: 2 });
    await cache.getOrLoad("feed-a", async () => "old source value");
    now += 2000;
    let rejectLoad: (error: Error) => void = () => {
      throw new Error("load did not start");
    };
    const loader = () =>
      new Promise<string>((_resolve, reject) => {
        rejectLoad = reject;
      });
    const first = collectManagedResponseCacheEvidence(() => cache.getOrLoad("feed-a", loader));
    const second = collectManagedResponseCacheEvidence(() => cache.getOrLoad("feed-a", async () => "must not run"));
    rejectLoad(new Error("upstream unavailable"));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.staleFallbackUsed).toBe(true);
    expect(secondResult.staleFallbackUsed).toBe(true);
    expect(cache.stats().coalescedHits).toBe(1);
    const unrelated = await collectManagedResponseCacheEvidence(() => cache.getOrLoad("feed-b", async () => "new source value"));
    expect(unrelated.staleFallbackUsed).toBe(false);
  });

  it("keeps exact stale-read evidence available when the underlying failed entry is evicted", async () => {
    let now = INITIAL_NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const cache = new ManagedResponseCache<string>({ ttlMs: 1000, staleIfErrorMs: 60_000, maxEntries: 1 });
    await cache.getOrLoad("feed-a", async () => "old source value");
    now += 2000;
    const stale = await collectManagedResponseCacheEvidence(() =>
      cache.getOrLoad("feed-a", async () => {
        throw new Error("upstream unavailable");
      })
    );
    now += 1;
    await cache.getOrLoad("feed-b", async () => "other fresh source");
    expect(cache.stats().unresolvedStaleEntries).toBe(0);
    expect(stale.staleFallbackUsed).toBe(true);
    const snapshot = collection(now);
    if (stale.staleFallbackUsed) snapshot.warnings.push("Source cache fallback is unavailable for automatic delivery.");
    const result = evaluateNotificationInput(
      snapshot,
      { ...cache.stats(), lastErrorAt: undefined },
      [{ ...cache.stats(), sourceId: "municipal_alerts" }],
      300,
      now
    );
    expect(result.status).toBe("unavailable");
    expect(result.reasons).toContain("source_warnings_present");
  });

  it("persists source fallback warnings in cached aggregate snapshots after source-key eviction", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(INITIAL_NOW);
    const sourceCache = new ManagedResponseCache<string>({ ttlMs: 1000, staleIfErrorMs: 60_000, maxEntries: 1 });
    await sourceCache.getOrLoad("feed-a", async () => "old source value");
    vi.setSystemTime(INITIAL_NOW + 2000);
    const source: SafetyDataSource = {
      descriptor: {
        sourceId: "municipal_alerts",
        label: "Fixture",
        enabled: true,
        mode: "live",
        priority: 1,
        layers: ["warnings"],
        license: { name: "Fixture", attribution: "Fixture", commercialUse: "allowed", operationalUse: "allowed", notes: [] }
      },
      fetchFeatures: async () => {
        await sourceCache.getOrLoad("feed-a", async () => {
          throw new Error("upstream unavailable");
        });
        return { source: source.descriptor, fetchedAt: new Date().toISOString(), features: [], warnings: [] };
      },
      cacheStats: () => [{ ...sourceCache.stats(), sourceId: "municipal_alerts" }]
    };
    const config = { cacheTtlSeconds: 300, staleIfErrorSeconds: 60, cacheMaxEntries: 3, staleAfterSeconds: 300 } as SafetyDataConfig;
    const aggregation = new SafetyAggregationService(config, [source]);
    const query: SafetyQuery = {
      bbox: { west: 12, south: 48, east: 19, north: 52 },
      layers: ["warnings"],
      sourceIds: ["municipal_alerts"],
      limit: 100,
      includeRaw: false
    };
    const first = await aggregation.getFeatures(query);
    expect(first.warnings).toEqual(["Source data reused stale cache after an upstream failure; automatic delivery is unavailable."]);
    vi.setSystemTime(INITIAL_NOW + 2001);
    await sourceCache.getOrLoad("feed-b", async () => "other fresh source");
    expect(sourceCache.stats().unresolvedStaleEntries).toBe(0);
    const cached = await aggregation.getFeatures(query);
    expect(cached).toBe(first);
    expect(aggregation.cacheStats().hits).toBe(1);
    const result = evaluateNotificationInput(cached, aggregation.cacheStats(), aggregation.sourceCacheStats(), 300, Date.now());
    expect(result.status).toBe("unavailable");
    expect(result.reasons).toContain("source_warnings_present");
  });
});

function collection(now: number): SafetyFeatureCollection {
  const generatedAt = new Date(now).toISOString();
  return {
    contractVersion: "cop-safety-source-v1",
    type: "FeatureCollection",
    generatedAt,
    source: { sourceId: "safety-data-api", sourceType: "PUBLIC_SAFETY_AGGREGATE", generatedAt },
    query: { bbox: { west: 12, south: 48, east: 19, north: 52 }, layers: ["warnings"], limit: 100, sources: ["municipal_alerts"] },
    summary: { featureCount: 0, sourceCount: 1, staleFeatureCount: 0, advisoryCount: 0, warningCount: 0, criticalCount: 0 },
    features: [],
    sources: [],
    warnings: []
  };
}
