import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SafetyAggregationService } from "../src/aggregation.js";
import type { SafetyDataConfig } from "../src/config.js";
import { evaluateNotificationInput } from "../src/notification-input-health.js";
import { buildSafetyNotificationCandidateCollection } from "../src/notification-candidates.js";
import { collectManagedResponseCacheEvidence, ManagedResponseCache } from "../src/response-cache.js";
import { createSafetyDataSources, type SafetyDataSource } from "../src/sources.js";
import type { SafetyQuery } from "../src/types.js";

const INITIAL_NOW = Date.parse("2026-10-10T10:00:00.000Z");
const MAX_AGE_SECONDS = 300;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CHMI hydro observation validity", () => {
  it("does not classify a newly fetched old observation or its hot snapshot as live", async () => {
    useClock();
    const observedAt = new Date(INITIAL_NOW - 3 * 60 * 60_000).toISOString();
    await withHydroFixture(observedAt, async (aggregation, requests) => {
      const first = await aggregation.getFeatures(hydroQuery());
      expect(first.generatedAt).toBe(new Date(INITIAL_NOW).toISOString());
      expect(first.features).toHaveLength(1);
      const feature = first.features[0]!;
      expect(feature.properties.observedAt).toBe(observedAt);
      expect(feature.properties.expiresAt).toBe(new Date(INITIAL_NOW - 60 * 60_000).toISOString());
      expect(feature.properties.validUntil).toBe(feature.properties.expiresAt);
      expect(feature.properties.stale).toBe(true);
      const result = buildSafetyNotificationCandidateCollection(first, { minSeverity: "advisory", includeStale: false });
      expect(result.candidates).toEqual([]);
      expect(result.summary.staleSkippedCount).toBe(1);

      vi.setSystemTime(INITIAL_NOW + 30_000);
      const hot = await aggregation.getFeatures(hydroQuery());
      expect(hot.features[0]?.properties.stale).toBe(true);
      expect(hot.features[0]?.properties.expiresAt).toBe(feature.properties.expiresAt);
      expect(buildSafetyNotificationCandidateCollection(hot, { minSeverity: "advisory", includeStale: false }).candidates).toEqual([]);
      expect(requests.get("/now/synthetic-station.json")).toBe(1);
    });
  });

  it("does not extend validity when the same observation is remapped from hot cache or downloaded again", async () => {
    useClock();
    const observedAt = new Date(INITIAL_NOW - 60 * 60_000).toISOString();
    const expectedExpiry = new Date(INITIAL_NOW + 60 * 60_000).toISOString();
    await withHydroFixture(observedAt, async (aggregation, requests) => {
      const first = await aggregation.getFeatures(hydroQuery());
      expect(first.features[0]?.properties.stale).toBe(false);
      expect(first.features[0]?.properties.expiresAt).toBe(expectedExpiry);

      // Different aggregate key forces a source remap, while the station
      // payload remains a hot cache hit. Its newer wrapper time is not validity.
      vi.setSystemTime(INITIAL_NOW + 120_000);
      const remapped = await aggregation.getFeatures(hydroQuery(true));
      expect(remapped.features[0]?.properties.observedAt).toBe(observedAt);
      expect(remapped.features[0]?.properties.expiresAt).toBe(expectedExpiry);
      expect(requests.get("/now/synthetic-station.json")).toBe(1);

      // Even another successful upstream retrieval cannot renew an unchanged
      // measurement after its observation-based validity has expired.
      vi.setSystemTime(INITIAL_NOW + 60 * 60_000 + 1);
      const downloadedAgain = await aggregation.getFeatures(hydroQuery(true));
      expect(downloadedAgain.features[0]?.properties.observedAt).toBe(observedAt);
      expect(downloadedAgain.features[0]?.properties.expiresAt).toBe(expectedExpiry);
      expect(downloadedAgain.features[0]?.properties.stale).toBe(true);
      expect(requests.get("/now/synthetic-station.json")).toBe(2);
      const result = buildSafetyNotificationCandidateCollection(downloadedAgain, { minSeverity: "advisory", includeStale: false });
      expect(result.candidates).toEqual([]);
      expect(result.summary.staleSkippedCount).toBe(1);
    });
  });
});

describe("Notification current-source freshness", () => {
  it("retains nested stale evidence on a hot parent hit after the child entry is evicted", async () => {
    useClock();
    const child = currentCache<string>({ ttlMs: 1_000, maxEntries: 1 });
    const parent = currentCache<string>({ ttlMs: 600_000, maxEntries: 1 });
    await child.getOrLoad("feed-a", async () => "original source value");
    vi.setSystemTime(INITIAL_NOW + 2_000);

    const first = await collectManagedResponseCacheEvidence(() =>
      parent.getOrLoad("snapshot", async () =>
        child.getOrLoad("feed-a", async () => {
          throw new Error("synthetic upstream failure");
        })
      )
    );
    expect(first.staleFallbackUsed).toBe(true);

    vi.setSystemTime(INITIAL_NOW + 2_001);
    await child.getOrLoad("feed-b", async () => "unrelated new value");
    expect(child.stats().unresolvedStaleEntries).toBe(0);
    const hot = await collectManagedResponseCacheEvidence(() => parent.getOrLoad("snapshot", async () => "must not load"));

    expect(hot.value).toBe("original source value");
    expect(hot.staleFallbackUsed).toBe(true);
    expect(parent.stats().hits).toBe(1);
  });

  it("delivers nested stale evidence separately to coalesced parent callers", async () => {
    useClock();
    const child = currentCache<string>({ ttlMs: 1_000 });
    const parent = currentCache<string>({ ttlMs: 600_000 });
    await child.getOrLoad("feed-a", async () => "original source value");
    vi.setSystemTime(INITIAL_NOW + 2_000);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let loads = 0;
    const loader = async () => {
      loads += 1;
      const value = await child.getOrLoad("feed-a", async () => {
        throw new Error("synthetic upstream failure");
      });
      await gate;
      return value;
    };
    const first = collectManagedResponseCacheEvidence(() => parent.getOrLoad("snapshot", loader));
    const second = collectManagedResponseCacheEvidence(() => parent.getOrLoad("snapshot", async () => "must not load"));
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(loads).toBe(1);
    expect(firstResult.staleFallbackUsed).toBe(true);
    expect(secondResult.staleFallbackUsed).toBe(true);
    expect(parent.stats().coalescedHits).toBe(1);
  });

  it("does not rejuvenate an old current payload through a fresh wrapper or another-key success", async () => {
    useClock();
    const current = currentCache<string>({ ttlMs: 900_000 });
    await current.getOrLoad("used-feed", async () => "old current payload");
    vi.setSystemTime(INITIAL_NOW + 301_000);
    await current.getOrLoad("other-feed", async () => "new unrelated payload");
    const source = fixtureSource(async () => {
      await current.getOrLoad("used-feed", async () => "must not load");
    }, current);
    const aggregation = new SafetyAggregationService(config(), [source]);
    const collection = await aggregation.getFeatures(query());

    expect(current.stats().lastSuccessAt).toBe(new Date(INITIAL_NOW + 301_000).toISOString());
    expect(collection.generatedAt).toBe(new Date(INITIAL_NOW).toISOString());
    expect(collection.source.generatedAt).toBe(collection.generatedAt);
    const readiness = evaluateNotificationInput(collection, aggregation.cacheStats(), aggregation.sourceCacheStats(), MAX_AGE_SECONDS);
    expect(readiness.status).toBe("unavailable");
    expect(readiness.reasons).toContain("snapshot_expired");
  });

  it("keeps old reference metadata neutral when the actual current payload is newly loaded", async () => {
    useClock();
    const reference = new ManagedResponseCache<string>({ ttlMs: 24 * 60 * 60_000, staleIfErrorMs: 60_000, maxEntries: 1 });
    const current = currentCache<string>({ ttlMs: 900_000 });
    await reference.getOrLoad("station-metadata", async () => "reference station list");
    vi.setSystemTime(INITIAL_NOW + 301_000);
    const source = fixtureSource(async () => {
      await reference.getOrLoad("station-metadata", async () => "must not load");
      await current.getOrLoad("used-feed", async () => "new current payload");
    }, current);
    const aggregation = new SafetyAggregationService(config(), [source]);
    const collection = await aggregation.getFeatures(query());

    expect(collection.generatedAt).toBe(new Date(INITIAL_NOW + 301_000).toISOString());
    expect(evaluateNotificationInput(collection, aggregation.cacheStats(), aggregation.sourceCacheStats(), MAX_AGE_SECONDS).status).toBe("ready");
  });

  it("preserves the original timestamp on hot aggregate reuse and expires exactly after 300 seconds", async () => {
    useClock();
    const current = currentCache<string>({ ttlMs: 900_000 });
    let loads = 0;
    const source = fixtureSource(async () => {
      await current.getOrLoad("used-feed", async () => {
        loads += 1;
        return "current payload";
      });
    }, current);
    const aggregation = new SafetyAggregationService(config(), [source]);
    const first = await aggregation.getFeatures(query());

    vi.setSystemTime(INITIAL_NOW + 300_000);
    const boundary = await aggregation.getFeatures(query());
    expect(boundary.generatedAt).toBe(first.generatedAt);
    expect(evaluateNotificationInput(boundary, aggregation.cacheStats(), aggregation.sourceCacheStats(), MAX_AGE_SECONDS).status).toBe("ready");
    vi.setSystemTime(INITIAL_NOW + 300_001);
    const expired = await aggregation.getFeatures(query());
    expect(expired.generatedAt).toBe(first.generatedAt);
    expect(loads).toBe(1);
    expect(evaluateNotificationInput(expired, aggregation.cacheStats(), aggregation.sourceCacheStats(), MAX_AGE_SECONDS).status).toBe("unavailable");
  });

  it("starts aggregate freshness before a slow cold source has completed", async () => {
    useClock();
    const current = currentCache<string>({ ttlMs: 900_000 });
    const source = fixtureSource(async () => {
      await current.getOrLoad("used-feed", async () => {
        vi.setSystemTime(INITIAL_NOW + 301_000);
        return "slow newly retrieved current payload";
      });
    }, current);
    const aggregation = new SafetyAggregationService(config(), [source]);
    const collection = await aggregation.getFeatures(query());

    expect(collection.generatedAt).toBe(new Date(INITIAL_NOW).toISOString());
    expect(evaluateNotificationInput(collection, aggregation.cacheStats(), aggregation.sourceCacheStats(), MAX_AGE_SECONDS).status).toBe("unavailable");
  });

  it.each(["invalid source timestamp", "2026-10-10T10:00:05.001Z"])(
    "does not hide an invalid/future source timestamp behind a new wrapper: %s",
    async (fetchedAt) => {
      useClock();
      const current = currentCache<string>({ ttlMs: 900_000 });
      const source = fixtureSource(
        async () => {
          await current.getOrLoad("used-feed", async () => "current payload");
        },
        current,
        fetchedAt
      );
      const aggregation = new SafetyAggregationService(config(), [source]);
      const collection = await aggregation.getFeatures(query());

      expect(collection.warnings).toHaveLength(1);
      expect(collection.warnings[0]).not.toContain(fetchedAt);
      const readiness = evaluateNotificationInput(collection, aggregation.cacheStats(), aggregation.sourceCacheStats(), MAX_AGE_SECONDS);
      expect(readiness.status).toBe("unavailable");
      expect(readiness.reasons).toContain("source_warnings_present");
    }
  );
});

function useClock(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(INITIAL_NOW);
}

function currentCache<T>(options: { ttlMs: number; maxEntries?: number }): ManagedResponseCache<T> {
  return new ManagedResponseCache<T>({ ...options, staleIfErrorMs: 600_000, maxEntries: options.maxEntries ?? 3, trackCurrentFreshness: true });
}

function fixtureSource(read: () => Promise<void>, cache: ManagedResponseCache<string>, fetchedAt?: string): SafetyDataSource {
  const source: SafetyDataSource = {
    descriptor: {
      sourceId: "municipal_alerts",
      label: "Synthetic freshness fixture",
      enabled: true,
      mode: "live",
      priority: 1,
      layers: ["warnings"],
      license: { name: "Synthetic", attribution: "Synthetic", commercialUse: "allowed", operationalUse: "allowed", notes: [] }
    },
    fetchFeatures: async () => {
      await read();
      return { source: source.descriptor, fetchedAt: fetchedAt ?? new Date().toISOString(), features: [], warnings: [] };
    },
    cacheStats: () => [{ ...cache.stats(), sourceId: "municipal_alerts" }]
  };
  return source;
}

function config(): SafetyDataConfig {
  return { cacheTtlSeconds: 900, staleIfErrorSeconds: 600, cacheMaxEntries: 4, staleAfterSeconds: 3_600 } as SafetyDataConfig;
}

function query(): SafetyQuery {
  return {
    bbox: { west: 12, south: 48, east: 19, north: 52 },
    layers: ["warnings"],
    sourceIds: ["municipal_alerts"],
    limit: 100,
    includeRaw: false
  };
}

function hydroQuery(includeRaw = false): SafetyQuery {
  return { ...query(), layers: ["flood"], sourceIds: ["chmi_hydro"], includeRaw };
}

async function withHydroFixture(
  observedAt: string,
  operation: (aggregation: SafetyAggregationService, requests: Map<string, number>) => Promise<void>
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "csm-sim-hydro-freshness-fixture-"));
  const requests = new Map<string, number>();
  const hydroConfig = {
    ...config(),
    dataDir,
    enabledSources: ["chmi_hydro"],
    requestTimeoutMs: 1_000,
    chmiHydroMetadataUrl: "https://synthetic.fixture.test/meta.json",
    chmiHydroNowBaseUrl: "https://synthetic.fixture.test/now",
    chmiHydroMaxStations: 1,
    chmiHydroStationCacheMaxEntries: 64,
    chmiHydroCurrentSnapshotCacheTtlSeconds: 300,
    hzsIncidentFeeds: [],
    municipalAlertFeeds: []
  } as SafetyDataConfig;
  const metadata = {
    data: {
      data: {
        header: "objID,STATION_NAME,GEOGR1,GEOGR2,SPA1H,SPA2H,SPA3H",
        values: [["synthetic-station", "Synthetic station", 50.0, 14.5, 100, 150, 200]]
      }
    }
  };
  const payload = {
    objList: [
      {
        objID: "synthetic-station",
        tsList: [
          {
            tsConID: "H",
            unit: "cm",
            tsData: [{ dt: observedAt, value: 160 }]
          }
        ]
      }
    ]
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== "https://synthetic.fixture.test" || !["/meta.json", "/now/synthetic-station.json"].includes(url.pathname)) {
        throw new Error("Unexpected URL in offline synthetic fixture");
      }
      requests.set(url.pathname, (requests.get(url.pathname) ?? 0) + 1);
      return new Response(JSON.stringify(url.pathname === "/meta.json" ? metadata : payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    })
  );
  try {
    await operation(new SafetyAggregationService(hydroConfig, createSafetyDataSources(hydroConfig)), requests);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}
