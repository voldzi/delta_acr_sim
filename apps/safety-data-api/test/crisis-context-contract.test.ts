import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig, type SafetyDataConfig } from "../src/config.js";
import { MEDIA_NEWS_FEEDS } from "../src/media-news.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "../src/response-cache.js";
import type { SafetyFeature, SafetyFeatureCollection } from "../src/types.js";

const NOW = "2026-10-10T12:00:00.000Z";
const NEWS_HEADLINE = "Požár v Ostravě, hasiči evakuují obyvatele";

describe("Crisis-context HTTP boundary and notification input readiness", () => {
  let dataDir: string;
  let config: SafetyDataConfig;
  let configured: Awaited<ReturnType<typeof createApp>>;
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    dataDir = await mkdtemp(join(tmpdir(), "csm-crisis-context-contract-"));
    vi.stubEnv("SAFETY_DATA_DIR", dataDir);
    vi.stubEnv("SAFETY_DATA_ENABLED_SOURCES", "mock");
    vi.stubEnv("SAFETY_DATA_CACHE_TTL_SECONDS", "60");
    vi.stubEnv("SAFETY_DATA_ADMIN_BOUNDARY_DATABASE_URL", "");
    vi.stubEnv("OSM_POSTGIS_DATABASE_URL", "");
    vi.stubEnv("MEDIA_NEWS_ENABLED", "false");
    fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error("Unexpected upstream request in isolated HTTP contract test.");
    });
    vi.stubGlobal("fetch", fetcher);
    config = await loadConfig();
    configured = await createApp(config);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("returns disabled news and health metadata without any upstream access", async () => {
    const news = await request(configured.app).get("/api/v1/context/news").expect(200);
    const health = await request(configured.app).get("/health/ready").expect(200);

    expectNoHttpCache(news);
    expect(news.body).toMatchObject({
      contractVersion: "sim-crisis-media-context-v1",
      status: "disabled",
      informationalOnly: true,
      notificationEligible: false,
      items: []
    });
    expect(news.body.sources).toHaveLength(3);
    expect(news.body.sources.every((source: { status: string; fetchedAt: unknown }) => source.status === "disabled" && source.fetchedAt === null)).toBe(true);
    expect(health.body.mediaNews).toEqual({ enabled: false, informationalOnly: true, notificationEligible: false });
    expect(config.dataDir).toBe(dataDir);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "/api/v1/context/news?feeds=unknown",
    "/api/v1/context/news?limit=101",
    "/api/v1/context/news?feedUrl=https%3A%2F%2Finternal.example%2Fprivate",
    "/api/v1/context/news?bbox=14,49,15,50"
  ])("returns a correlation-preserving 400 for invalid news query %s", async (url) => {
    const response = await request(configured.app).get(url).set("X-Correlation-Id", "crisis-contract-validation").expect(400);

    expect(response.body.error).toMatchObject({ code: "INVALID_MEDIA_NEWS_QUERY", correlationId: "crisis-contract-validation" });
    expectNoHttpCache(response);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns enabled headline-only context without introducing a map layer or notification source", async () => {
    vi.stubEnv("MEDIA_NEWS_ENABLED", "true");
    fetcher.mockResolvedValue(new Response(newsRss(), { headers: { "content-type": "application/rss+xml" } }));
    configured = await createApp(await loadConfig());

    const news = await request(configured.app).get("/api/v1/context/news?feeds=ct24-ostrava&limit=5").expect(200);
    const health = await request(configured.app).get("/health/ready").expect(200);
    const features = await request(configured.app).get("/api/v1/features?layers=weather_alerts&source=mock&limit=10").expect(200);
    const notifications = await request(configured.app).get("/api/v1/notifications/candidates?layers=weather_alerts&source=mock&limit=10").expect(200);
    const sources = await request(configured.app).get("/api/v1/sources").expect(200);

    expectNoHttpCache(news);
    expectNoHttpCache(notifications);
    expect(news.body).toMatchObject({ status: "ok", informationalOnly: true, notificationEligible: false });
    expect(news.body.items).toHaveLength(1);
    expect(news.body.items[0]).toMatchObject({
      title: NEWS_HEADLINE,
      publishedAt: "2026-10-10T11:59:00.000Z",
      eventAt: null,
      location: null,
      locationStatus: "unresolved",
      regionCode: "CZ080",
      regionScope: "feed",
      informationalOnly: true,
      notificationEligible: false
    });
    expect(news.body.sources[0]).toMatchObject({ id: "ct24-ostrava", status: "ok", stale: false, errorCode: null });
    expect(JSON.stringify(news.body)).not.toMatch(/FULL_ARTICLE_SENTINEL|image-sentinel|coordinates|geometry/);
    expect(health.body.mediaNews).toEqual({ enabled: true, informationalOnly: true, notificationEligible: false });
    expect(features.body.features.every((feature: SafetyFeature) => feature.properties.sourceId === "mock")).toBe(true);
    expect(notifications.body.candidates.every((candidate: { feature: { sourceId: string } }) => candidate.feature.sourceId === "mock")).toBe(true);
    expect(JSON.stringify(sources.body)).not.toContain("ct24");
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(MEDIA_NEWS_FEEDS[1]?.url, expect.objectContaining({ redirect: "error" }));
  });

  it("disables HTTP news caching while preserving the bounded shared backend feed cache", async () => {
    vi.stubEnv("MEDIA_NEWS_ENABLED", "true");
    fetcher.mockResolvedValue(new Response(newsRss(), { headers: { "content-type": "application/rss+xml" } }));
    configured = await createApp(await loadConfig());
    const first = await request(configured.app).get("/api/v1/context/news?feeds=ct24-ostrava&limit=5").expect(200);

    vi.setSystemTime(new Date("2026-10-10T12:01:00.000Z"));
    const reread = await request(configured.app).get("/api/v1/context/news?limit=1&feeds=ct24-ostrava").expect(200);

    expectNoHttpCache(first);
    expectNoHttpCache(reread);
    expect(first.body.generatedAt).toBe(NOW);
    expect(reread.body.generatedAt).toBe("2026-10-10T12:01:00.000Z");
    expect(reread.body.items[0].fetchedAt).toBe(NOW);
    expect(reread.body.sources[0].fetchedAt).toBe(NOW);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    "/api/v1/notifications/candidates?layers=invalid",
    "/api/v1/notifications/candidates?source=invalid",
    "/api/v1/notifications/candidates?minSeverity=urgent"
  ])("disables HTTP caching for candidate validation errors on %s", async (url) => {
    const response = await request(configured.app).get(url).expect(400);

    expectNoHttpCache(response);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves ready synthetic candidates and accounts for input rejection separately", async () => {
    const response = await request(configured.app).get("/api/v1/notifications/candidates?layers=weather_alerts&source=mock&limit=10").expect(200);

    expectNoHttpCache(response);
    expect(response.body.inputReadiness).toEqual({ status: "ready", snapshotGeneratedAt: NOW, snapshotAgeSeconds: 0, reasons: [] });
    expect(response.body.summary).toMatchObject({ featureCount: 1, candidateCount: 1, skippedCount: 0, inputRejectedCount: 0 });
    expect(response.body.candidates[0].candidateId).toContain("weather_alerts:mock:wind-prague-west");
  });

  it("recomputes snapshot age on every read, rejects stale-if-error fallback, and accepts only actual recovery", async () => {
    configured = await createApp({ ...config, cacheTtlSeconds: 300, staleIfErrorSeconds: 600 });
    let unavailable = false;
    const responseCache = new ManagedResponseCache<SafetyFeatureCollection>({ ttlMs: 300_000, staleIfErrorMs: 600_000, maxEntries: 10 });
    const loadSnapshot = vi.fn(async () => {
      if (unavailable) throw new Error("Isolated upstream refresh failure.");
      const generatedAt = new Date().toISOString();
      return snapshot({ generatedAt, source: { sourceId: "safety-data-api", sourceType: "PUBLIC_SAFETY_AGGREGATE", generatedAt } });
    });
    vi.spyOn(configured.context.aggregation, "getFeatures").mockImplementation(() => responseCache.getOrLoad("isolated-candidate-query", loadSnapshot));
    vi.spyOn(configured.context.aggregation, "cacheStats").mockImplementation(() => responseCache.stats());
    vi.spyOn(configured.context.aggregation, "sourceCacheStats").mockReturnValue([]);

    const first = await candidateRequest();
    expectActualReadySnapshot(first.body, 300);
    expect(first.body.inputReadiness.snapshotAgeSeconds).toBe(0);

    vi.setSystemTime(new Date("2026-10-10T12:04:56.000Z"));
    const cached = await candidateRequest();
    expectActualReadySnapshot(cached.body, 300);
    expect(cached.body.generatedAt).toBe("2026-10-10T12:04:56.000Z");
    expect(cached.body.inputReadiness).toMatchObject({ snapshotGeneratedAt: NOW, snapshotAgeSeconds: 296 });
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    unavailable = true;
    vi.setSystemTime(new Date("2026-10-10T12:05:01.000Z"));
    const failed = await candidateRequest();
    expect(failed.body.inputReadiness).toMatchObject({ status: "unavailable", snapshotGeneratedAt: NOW, snapshotAgeSeconds: 301 });
    expect(failed.body.inputReadiness.reasons).toContain("snapshot_expired");
    expect(failed.body.inputReadiness.reasons).toContain("response_cache_error_unrecovered");
    expect(failed.body.candidates).toEqual([]);

    vi.setSystemTime(new Date("2026-10-10T12:08:40.000Z"));
    const stale = await request(configured.app)
      .get("/api/v1/notifications/candidates?layers=weather_alerts&source=mock&limit=10")
      .set("X-COP-Snapshot-Generated-At", "2026-10-10T12:08:40.000Z")
      .set("X-COP-Snapshot-Age-Seconds", "0")
      .set("X-COP-Input-Readiness", "ready")
      .expect(200);
    expect(stale.body.generatedAt).toBe("2026-10-10T12:08:40.000Z");
    expect(stale.body.inputReadiness).toMatchObject({ status: "unavailable", snapshotGeneratedAt: NOW, snapshotAgeSeconds: 520 });
    expect(stale.body.candidates).toEqual([]);
    expect(stale.body.summary.inputRejectedCount).toBe(1);

    unavailable = false;
    vi.setSystemTime(new Date("2026-10-10T12:08:41.000Z"));
    const recovered = await candidateRequest();
    expectActualReadySnapshot(recovered.body, 300);
    expect(recovered.body.inputReadiness).toMatchObject({ snapshotGeneratedAt: "2026-10-10T12:08:41.000Z", snapshotAgeSeconds: 0 });
    expect(recovered.body.candidates).toHaveLength(1);
    expect(recovered.body.summary.inputRejectedCount).toBe(0);
    for (const response of [first, cached, failed, stale, recovered]) expectNoHttpCache(response);
  });

  it("fails closed on warnings while leaving the feature and summary surfaces available", async () => {
    const input = snapshot({ warnings: ["Sensitive upstream URL https://private.example/feed?token=secret"] });
    installSnapshot(input);
    const response = await candidateRequest();
    const map = await request(configured.app).get("/api/v1/features?layers=weather_alerts&source=mock&limit=10").expect(200);
    const summary = await request(configured.app).get("/api/v1/features/summary?layers=weather_alerts&source=mock&limit=10").expect(200);

    expect(response.body.candidates).toEqual([]);
    expect(response.body.inputReadiness).toMatchObject({ status: "unavailable", reasons: ["source_warnings_present"] });
    expect(response.body.summary).toMatchObject({ featureCount: 1, candidateCount: 0, skippedCount: 1, inputRejectedCount: 1 });
    expect(JSON.stringify(response.body.inputReadiness)).not.toContain("private.example");
    expect(map.body.features).toEqual(input.features);
    expect(summary.body.features).toHaveLength(1);
  });

  it("reports incomplete when the candidate input hits its known limit", async () => {
    const response = await request(configured.app).get("/api/v1/notifications/candidates?layers=weather_alerts&source=mock&limit=1").expect(200);
    const map = await request(configured.app).get("/api/v1/features?layers=weather_alerts&source=mock&limit=1").expect(200);

    expect(response.body.inputReadiness).toMatchObject({ status: "incomplete", reasons: ["input_limit_reached"] });
    expect(response.body.candidates).toEqual([]);
    expect(response.body.summary).toMatchObject({ featureCount: 1, candidateCount: 0, skippedCount: 1, inputRejectedCount: 1 });
    expect(map.body.features).toHaveLength(1);
  });

  it("does not promote an aged cached snapshot to fresh notification input", async () => {
    const old = new Date(Date.parse(NOW) - 61_000).toISOString();
    installSnapshot(snapshot({ generatedAt: old }));
    const response = await candidateRequest();

    expect(response.body.inputReadiness).toMatchObject({
      status: "unavailable",
      snapshotGeneratedAt: old,
      snapshotAgeSeconds: 61,
      reasons: ["snapshot_expired"]
    });
    expect(response.body.candidates).toEqual([]);
    expect(response.body.summary.inputRejectedCount).toBe(1);
  });

  it("blocks unresolved response-cache errors, then accepts strictly newer recovery", async () => {
    installSnapshot(snapshot());
    const stats = vi.spyOn(configured.context.aggregation, "cacheStats");
    stats.mockReturnValue(cache({ lastSuccessAt: "2026-10-10T11:59:40.000Z", lastErrorAt: "2026-10-10T11:59:50.000Z" }));
    const failed = await candidateRequest();
    stats.mockReturnValue(cache({ lastSuccessAt: NOW, lastErrorAt: "2026-10-10T11:59:50.000Z", errors: 1, staleHits: 1 }));
    const recovered = await candidateRequest();

    expect(failed.body.inputReadiness).toMatchObject({ status: "unavailable", reasons: ["response_cache_error_unrecovered"] });
    expect(failed.body.candidates).toEqual([]);
    expect(failed.body.summary.inputRejectedCount).toBe(1);
    expect(recovered.body.inputReadiness.status).toBe("ready");
    expect(recovered.body.candidates).toHaveLength(1);
  });

  it("blocks errors only from sources requested by this snapshot", async () => {
    installSnapshot(snapshot());
    const sourceStats = vi.spyOn(configured.context.aggregation, "sourceCacheStats");
    sourceStats.mockReturnValue([{ ...cache({ lastErrorAt: NOW }), sourceId: "mock" }]);
    const failed = await candidateRequest();
    sourceStats.mockReturnValue([{ ...cache({ lastErrorAt: NOW }), sourceId: "chmi_hydro" }]);
    const unaffected = await candidateRequest();

    expect(failed.body.inputReadiness).toMatchObject({ status: "unavailable", reasons: ["requested_source_cache_error_unrecovered"] });
    expect(failed.body.candidates).toEqual([]);
    expect(unaffected.body.inputReadiness.status).toBe("ready");
    expect(unaffected.body.candidates).toHaveLength(1);
  });

  it("rechecks expired event validity even when a cached feature still says stale=false", async () => {
    const input = snapshot();
    input.features[0]!.properties.validUntil = "2026-10-10T11:59:59.000Z";
    installSnapshot(input);
    const response = await candidateRequest();

    expect(response.body.inputReadiness.status).toBe("ready");
    expect(response.body.candidates).toEqual([]);
    expect(response.body.summary).toMatchObject({ staleSkippedCount: 1, inputRejectedCount: 0, skippedCount: 1 });
  });

  it("rechecks event expiry on later reads of the same still-fresh snapshot", async () => {
    const input = snapshot();
    input.features[0]!.properties.validUntil = "2026-10-10T12:00:20.000Z";
    installSnapshot(input);
    const first = await candidateRequest();
    expect(first.body.candidates).toHaveLength(1);
    expectActualReadySnapshot(first.body, 300);

    vi.setSystemTime(new Date("2026-10-10T12:00:21.000Z"));
    const expired = await candidateRequest();
    expectActualReadySnapshot(expired.body, 300);
    expect(expired.body.inputReadiness.snapshotAgeSeconds).toBe(21);
    expect(expired.body.candidates).toEqual([]);
    expect(expired.body.summary).toMatchObject({ staleSkippedCount: 1, inputRejectedCount: 0 });
    expectNoHttpCache(first);
    expectNoHttpCache(expired);
  });

  function installSnapshot(input: SafetyFeatureCollection): void {
    vi.spyOn(configured.context.aggregation, "getFeatures").mockResolvedValue(input);
    vi.spyOn(configured.context.aggregation, "cacheStats").mockReturnValue(cache());
    vi.spyOn(configured.context.aggregation, "sourceCacheStats").mockReturnValue([]);
  }

  function candidateRequest() {
    return request(configured.app).get("/api/v1/notifications/candidates?layers=weather_alerts&source=mock&limit=10").expect(200);
  }
});

function expectNoHttpCache(response: { headers: Record<string, string> }): void {
  expect(response.headers["cache-control"]).toBe("no-store, max-age=0");
  expect(response.headers.pragma).toBe("no-cache");
}

function expectActualReadySnapshot(
  body: { inputReadiness: { status: string; snapshotGeneratedAt: string; snapshotAgeSeconds: number | null } },
  maxAgeSeconds: number
): void {
  expect(body.inputReadiness.status).toBe("ready");
  const actualAge = Math.max(0, (Date.now() - Date.parse(body.inputReadiness.snapshotGeneratedAt)) / 1_000);
  expect(body.inputReadiness.snapshotAgeSeconds).toBe(actualAge);
  expect(actualAge).toBeLessThanOrEqual(maxAgeSeconds);
}

function cache(overrides: Partial<ManagedResponseCacheStats> = {}): ManagedResponseCacheStats {
  return {
    entries: 1,
    inflight: 0,
    maxEntries: 10,
    hits: 0,
    misses: 1,
    coalescedHits: 0,
    staleHits: 0,
    refreshes: 1,
    errors: 0,
    evictions: 0,
    lastSuccessAt: NOW,
    ...overrides
  };
}

function snapshot(overrides: Partial<SafetyFeatureCollection> = {}): SafetyFeatureCollection {
  const feature: SafetyFeature = {
    type: "Feature",
    id: "weather_alerts:mock:fixture",
    geometry: { type: "Point", coordinates: [14.4, 50.1] },
    properties: {
      featureId: "weather_alerts:mock:fixture",
      layer: "weather_alerts",
      category: "weather_warning",
      hazardType: "wind",
      headline: "Synthetic warning",
      sourceId: "mock",
      source: "mock",
      sourceName: "Synthetic",
      observedAt: NOW,
      validFrom: NOW,
      validUntil: "2026-10-10T13:00:00.000Z",
      updatedAt: NOW,
      confidence: 1,
      stale: false,
      severity: "warning",
      status: "active",
      urgency: "immediate",
      certainty: "observed",
      basis: ["fixture"],
      license: { name: "Synthetic", attribution: "Synthetic" }
    }
  };
  return {
    contractVersion: "cop-safety-source-v1",
    type: "FeatureCollection",
    generatedAt: NOW,
    source: { sourceId: "safety-data-api", sourceType: "PUBLIC_SAFETY_AGGREGATE", generatedAt: NOW },
    query: { bbox: { west: 12, south: 48, east: 19, north: 52 }, layers: ["weather_alerts"], limit: 10, sources: ["mock"] },
    summary: { featureCount: 1, sourceCount: 1, staleFeatureCount: 0, advisoryCount: 0, warningCount: 1, criticalCount: 0 },
    features: [feature],
    sources: [],
    warnings: [],
    ...overrides
  };
}

function newsRss(): string {
  return `<?xml version="1.0"?><rss version="2.0" xmlns:georss="http://www.georss.org/georss"><channel><item><title>${NEWS_HEADLINE}</title><link>https://ct24.ceskatelevize.cz/clanek/domaci/test-pozar</link><pubDate>Sat, 10 Oct 2026 11:59:00 GMT</pubDate><description>FULL_ARTICLE_SENTINEL</description><georss:point>49.8 18.2</georss:point><enclosure url="https://example.test/image-sentinel.jpg"/></item></channel></rss>`;
}
