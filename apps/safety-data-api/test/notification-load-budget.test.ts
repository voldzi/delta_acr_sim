import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { SafetyDataConfig } from "../src/config.js";
import {
  loadSafetyNotificationInputWithinBudget,
  SAFETY_NOTIFICATION_LOAD_BUDGET_MS,
  SafetyNotificationLoadBudgetExceededError
} from "../src/notification-load-budget.js";
import { ManagedResponseCache } from "../src/response-cache.js";
import type { SafetyFeatureCollection } from "../src/types.js";

const CANDIDATE_PATH =
  "/api/v1/notifications/candidates?bbox=14.2,49.9,14.7,50.2&layers=fire,flood,warnings,weather_alerts&limit=100&minSeverity=warning&includeStale=false";
const NOW = Date.parse("2026-10-10T20:00:00.000Z");
const dataDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(dataDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Safety notification input load budget", () => {
  it("returns a cold result inside the fixed budget and clears its timer", async () => {
    vi.useFakeTimers();
    const input = deferred<string>();
    const result = loadSafetyNotificationInputWithinBudget(() => input.promise);
    await vi.advanceTimersByTimeAsync(SAFETY_NOTIFICATION_LOAD_BUDGET_MS - 1);
    input.resolve("fresh");

    expect(await result).toBe("fresh");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns a hot cached result without starting a new refresh or retaining a timer", async () => {
    vi.useFakeTimers();
    const cache = new ManagedResponseCache<string>({ ttlMs: 300_000, staleIfErrorMs: 0, maxEntries: 1 });
    await cache.getOrLoad("query", async () => "fresh");
    const load = vi.fn(async () => "unexpected");

    expect(await loadSafetyNotificationInputWithinBudget(() => cache.getOrLoad("query", load))).toBe("fresh");
    expect(load).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a hung loader at eight seconds, before the COP fifteen-second deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const settled = loadSafetyNotificationInputWithinBudget(() => new Promise<never>(() => undefined)).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(SAFETY_NOTIFICATION_LOAD_BUDGET_MS);

    expect(await settled).toBeInstanceOf(SafetyNotificationLoadBudgetExceededError);
    expect(Date.now() - NOW).toBe(8_000);
    expect(SAFETY_NOTIFICATION_LOAD_BUDGET_MS).toBeLessThan(15_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps timed-out concurrent callers coalesced until the background cache warm completes", async () => {
    vi.useFakeTimers();
    const cache = new ManagedResponseCache<string>({ ttlMs: 300_000, staleIfErrorMs: 0, maxEntries: 1 });
    const input = deferred<string>();
    const load = vi.fn(() => input.promise);
    const read = () => cache.getOrLoad("query", load);
    const first = loadSafetyNotificationInputWithinBudget(read).catch((error: unknown) => error);
    const second = loadSafetyNotificationInputWithinBudget(read).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(SAFETY_NOTIFICATION_LOAD_BUDGET_MS);

    expect(await first).toBeInstanceOf(SafetyNotificationLoadBudgetExceededError);
    expect(await second).toBeInstanceOf(SafetyNotificationLoadBudgetExceededError);
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ inflight: 1, coalescedHits: 1 });

    input.resolve("fresh after timeout");
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.stats()).toMatchObject({ inflight: 0, entries: 1 });
    expect(await loadSafetyNotificationInputWithinBudget(read)).toBe("fresh after timeout");
    expect(load).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes an eventual background rejection after its caller times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const input = deferred<string>();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const settled = loadSafetyNotificationInputWithinBudget(() => input.promise).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(SAFETY_NOTIFICATION_LOAD_BUDGET_MS);
      expect(await settled).toBeInstanceOf(SafetyNotificationLoadBudgetExceededError);
      input.reject(new Error("late provider failure"));
      await vi.advanceTimersByTimeAsync(0);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(unhandled).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it.each(["rejection", "synchronous throw"])("propagates an immediate load %s while clearing the deadline", async (kind) => {
    vi.useFakeTimers();
    const failure = new Error("synthetic load failure");
    const result = loadSafetyNotificationInputWithinBudget(() => {
      if (kind === "synchronous throw") throw failure;
      return Promise.reject(failure);
    });

    await expect(result).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Safety candidate bounded HTTP contract", () => {
  it("returns sanitized no-store HTTP 503 with correlationId on a load failure", async () => {
    const { app, context } = await fixture();
    vi.spyOn(context.aggregation, "getFeatures").mockRejectedValue(new Error("https://private.example.test/?token=secret provider payload"));
    const response = await request(app).get(CANDIDATE_PATH).set("x-correlation-id", "budget-test-correlation").expect(503);

    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(response.headers.pragma).toBe("no-cache");
    expect(response.body).toEqual({
      error: {
        code: "SAFETY_NOTIFICATION_INPUT_UNAVAILABLE",
        message: "Safety notification input is temporarily unavailable.",
        correlationId: "budget-test-correlation"
      }
    });
    expect(JSON.stringify(response.body)).not.toMatch(/private|secret|provider payload/);
  });

  it("returns HTTP 503 at eight seconds for a hung load without waiting for COP's deadline", async () => {
    const { app, context } = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    const started = deferred<void>();
    vi.spyOn(context.aggregation, "getFeatures").mockImplementation(() => {
      started.resolve(undefined);
      return new Promise<never>(() => undefined);
    });
    const responsePromise = request(app)
      .get(CANDIDATE_PATH)
      .set("x-correlation-id", "budget-timeout-correlation")
      .then((response) => response);
    await started.promise;
    await vi.advanceTimersByTimeAsync(SAFETY_NOTIFICATION_LOAD_BUDGET_MS);
    const response = await responsePromise;

    expect(response.status).toBe(503);
    expect(Date.now() - NOW).toBe(8_000);
    expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(response.body.error).toMatchObject({ code: "SAFETY_NOTIFICATION_INPUT_UNAVAILABLE", correlationId: "budget-timeout-correlation" });
    expect(response.body).not.toHaveProperty("candidates");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a successfully loaded fresh input HTTP 200 and ready", async () => {
    const { app, context } = await fixture();
    vi.spyOn(context.aggregation, "getFeatures").mockResolvedValue(collection());
    const response = await request(app).get(CANDIDATE_PATH).expect(200);

    expect(response.body.inputReadiness.status).toBe("ready");
    expect(response.body.inputReadiness.reasons).toEqual([]);
    expect(response.body.summary.inputRejectedCount).toBe(0);
    expect(context.config.cacheTtlSeconds).toBe(300);
  });

  it("does not apply the candidate-only deadline to ordinary feature requests", async () => {
    const { app, context } = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    const started = deferred<void>();
    const input = deferred<SafetyFeatureCollection>();
    vi.spyOn(context.aggregation, "getFeatures").mockImplementation(() => {
      started.resolve(undefined);
      return input.promise;
    });
    let completed = false;
    const responsePromise = request(app)
      .get("/api/v1/features?bbox=14.2,49.9,14.7,50.2&layers=flood&limit=100")
      .then((response) => {
        completed = true;
        return response;
      });
    await started.promise;
    await vi.advanceTimersByTimeAsync(SAFETY_NOTIFICATION_LOAD_BUDGET_MS);

    expect(completed).toBe(false);
    input.resolve(collection());
    expect((await responsePromise).status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["expired snapshot", "stale cache success"])("preserves HTTP 200 unavailable for loaded %s instead of promoting it to ready", async (kind) => {
    const { app, context } = await fixture();
    const old = new Date(Date.now() - 301_000).toISOString();
    vi.spyOn(context.aggregation, "getFeatures").mockResolvedValue(collection(kind === "expired snapshot" ? old : undefined));
    if (kind === "stale cache success") {
      vi.spyOn(context.aggregation, "cacheStats").mockReturnValue({ ...context.aggregation.cacheStats(), lastSuccessAt: old });
    }
    const response = await request(app).get(CANDIDATE_PATH).expect(200);

    expect(response.body.inputReadiness.status).toBe("unavailable");
    expect(response.body.inputReadiness.reasons).toContain(kind === "expired snapshot" ? "snapshot_expired" : "response_cache_success_stale");
    expect(response.body.candidates).toEqual([]);
    expect(response.body.summary.candidateCount).toBe(0);
    expect(context.config.cacheTtlSeconds).toBe(300);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function collection(generatedAt = new Date().toISOString()): SafetyFeatureCollection {
  return {
    contractVersion: "cop-safety-source-v1",
    type: "FeatureCollection",
    generatedAt,
    source: { sourceId: "safety-data-api", sourceType: "PUBLIC_SAFETY_AGGREGATE", generatedAt },
    query: {
      bbox: { west: 14.2, south: 49.9, east: 14.7, north: 50.2 },
      layers: ["warnings", "weather_alerts", "fire", "flood"],
      limit: 100,
      sources: ["mock"]
    },
    summary: { featureCount: 0, sourceCount: 0, staleFeatureCount: 0, advisoryCount: 0, warningCount: 0, criticalCount: 0 },
    features: [],
    sources: [],
    warnings: []
  };
}

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "csm-sim-notification-budget-"));
  dataDirs.push(dataDir);
  const config: SafetyDataConfig = {
    port: 0,
    dataDir,
    enabledSources: ["mock"],
    defaultBbox: { west: 14.2, south: 49.9, east: 14.7, north: 50.2 },
    requestTimeoutMs: 1000,
    cacheTtlSeconds: 300,
    staleIfErrorSeconds: 3600,
    cacheMaxEntries: 128,
    staleAfterSeconds: 3600,
    chmiAlertsCapBaseUrl: "https://example.invalid/cap/",
    chmiOrpCodelistUrl: "https://example.invalid/orp",
    chmiHydroMetadataUrl: "https://example.invalid/hydro",
    chmiHydroNowBaseUrl: "https://example.invalid/now",
    chmiHydroRecentBaseUrl: "https://example.invalid/recent",
    chmiHydroMaxStations: 20,
    chmiHydroStationCacheMaxEntries: 148,
    chmiHydroCurrentSnapshotCacheTtlSeconds: 300,
    chmiHydroDetailDefaultPastHours: 168,
    chmiHydroDetailForecastHours: 72,
    chmiHydroDetailBackfillDays: 0,
    nasaFirmsAreaBaseUrl: "https://example.invalid/firms",
    nasaFirmsSource: "VIIRS_SNPP_NRT",
    nasaFirmsDayRange: 1,
    gdacsRssUrl: "https://example.invalid/rss",
    gdacsCacheTtlSeconds: 900,
    hzsIncidentFeeds: [],
    hzsIncidentsCacheTtlSeconds: 180,
    hzsIncidentsDetailCacheTtlSeconds: 1800,
    hzsIncidentsMaxActiveDetails: 50,
    municipalAlertFeeds: [],
    municipalAlertsCacheTtlSeconds: 300,
    roadSrtiLodSparqlUrl: "https://example.invalid/sparql",
    roadSrtiLodCacheTtlSeconds: 60,
    roadSrtiLodMaxRecords: 1500,
    adminBoundaryTable: "public.osm_admin_boundary",
    adminBoundaryCacheTtlSeconds: 86_400
  };
  return createApp(config);
}
