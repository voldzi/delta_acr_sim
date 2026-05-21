import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SituationAggregationService } from "../src/aggregation.js";
import { createApp } from "../src/app.js";
import type { SituationDataConfig } from "../src/config.js";
import type { SituationDataSource } from "../src/sources.js";

describe("Situation Data API contract", () => {
  let dataDir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let config: SituationDataConfig;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "delta-acr-situation-data-"));
    config = {
      port: 0,
      dataDir,
      enabledSources: ["mock"],
      defaultBbox: { west: 13.85, south: 49.65, east: 15.35, north: 50.45 },
      requestTimeoutMs: 1000,
      cacheTtlSeconds: 1,
      staleIfErrorSeconds: 600,
      cacheMaxEntries: 128,
      bboxCachePaddingDegrees: 0.18,
      staleAfterSeconds: 900,
      openMeteoBaseUrl: "https://api.open-meteo.com",
      openMeteoCacheTtlSeconds: 600,
      openMeteoGridDegrees: 0.05,
      osmPostgisConnectionString: undefined,
      osmPostgisBackend: "unconfigured",
      osmPostgisTable: "public.osm_poi",
      osmPostgisCacheTtlSeconds: 21600,
      overpassBaseUrl: "https://overpass-api.de/api/interpreter",
      overpassCacheTtlSeconds: 21600,
      overpassMaxBboxDegrees: 1.6,
      ctuNettestUrl: "https://nettest.ctu.gov.cz/RMBTStatisticServer/export/nettest-opendata_hours-048.zip",
      pidGtfsRtVehiclePositionsUrl: "https://api.golemio.cz/v2/vehiclepositions/gtfsrt/vehicle_positions.pb",
      safetyDataBaseUrl: "http://127.0.0.1:4030",
      safetyDataCacheTtlSeconds: 300,
      aviationWeatherBaseUrl: "https://aviationweather.gov",
      aviationWeatherCacheTtlSeconds: 600,
      ardosPartnerBaseUrl: undefined,
      ardosPartnerToken: undefined,
      ardosPartnerCacheTtlSeconds: 15
    };
    ({ app } = await createApp(config));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("exposes health, layers and source metadata", async () => {
    const health = await request(app).get("/health/ready").expect(200);
    expect(health.body.status).toBe("ok");
    expect(health.body.enabledSources).toEqual(["mock"]);

    const layers = await request(app).get("/api/v1/layers").expect(200);
    expect(layers.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layerId: "weather", defaultVisible: true }),
        expect.objectContaining({ layerId: "mobile", defaultVisible: false })
      ])
    );

    const sources = await request(app).get("/api/v1/sources").expect(200);
    expect(sources.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "mock",
          enabled: true,
          layers: expect.arrayContaining(["weather", "ground", "mobile", "traffic"])
        }),
        expect.objectContaining({
          sourceId: "open_meteo",
          license: expect.objectContaining({ name: "CC BY 4.0 / Open-Meteo Terms" })
        }),
        expect.objectContaining({
          sourceId: "osm_postgis",
          license: expect.objectContaining({ name: "ODbL 1.0" })
        }),
        expect.objectContaining({
          sourceId: "osm_overpass",
          license: expect.objectContaining({ name: "ODbL 1.0" })
        }),
        expect.objectContaining({
          sourceId: "ctu_nettest",
          license: expect.objectContaining({ name: "CC BY 4.0" })
        }),
        expect.objectContaining({
          sourceId: "pid_gtfs_rt",
          layers: expect.arrayContaining(["traffic"])
        }),
        expect.objectContaining({
          sourceId: "safety_data",
          layers: expect.arrayContaining(["warnings", "flood"])
        }),
        expect.objectContaining({
          sourceId: "aviation_weather",
          layers: expect.arrayContaining(["weather"])
        }),
        expect.objectContaining({
          sourceId: "ardos_partner",
          license: expect.objectContaining({ name: "ARDOS partner data under MoU" })
        })
      ])
    );
  });

  it("exposes non-secret runtime configuration", async () => {
    const response = await request(app).get("/api/v1/config").expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        enabledSources: ["mock"],
        defaultBbox: { west: 13.85, south: 49.65, east: 15.35, north: 50.45 },
        cacheTtlSeconds: 1,
        staleIfErrorSeconds: 600,
        cacheMaxEntries: 128,
        bboxCachePaddingDegrees: 0.18,
        staleAfterSeconds: 900,
        sourceCacheTtlSeconds: {
          openMeteo: 600,
          osmPostgis: 21600,
          osmOverpass: 21600,
          safetyData: 300,
          aviationWeather: 600,
          ardosPartner: 15
        },
        providers: expect.arrayContaining([
          expect.objectContaining({ sourceId: "mock", authConfigured: true }),
          expect.objectContaining({ sourceId: "open_meteo", authConfigured: true }),
          expect.objectContaining({ sourceId: "osm_postgis", authConfigured: false, backend: "unconfigured" }),
          expect.objectContaining({ sourceId: "ctu_nettest", authConfigured: true }),
          expect.objectContaining({ sourceId: "pid_gtfs_rt", authConfigured: true }),
          expect.objectContaining({ sourceId: "safety_data", authConfigured: true }),
          expect.objectContaining({ sourceId: "aviation_weather", authConfigured: true }),
          expect.objectContaining({ sourceId: "ardos_partner", authConfigured: false })
        ])
      })
    );
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });

  it("exposes cache metrics", async () => {
    const response = await request(app).get("/metrics").expect(200);
    expect(response.text).toContain("situation_data_cache_entries");
    expect(response.text).toContain("situation_data_cache_coalesced_hits");

    const cachedSources = await createApp({
      ...config,
      enabledSources: ["open_meteo", "osm_postgis", "osm_overpass", "ctu_nettest", "pid_gtfs_rt", "safety_data", "aviation_weather", "ardos_partner"]
    });
    const cachedSourceMetrics = await request(cachedSources.app).get("/metrics").expect(200);
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_hits{source="open_meteo"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_misses{source="osm_postgis"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_health{source="osm_postgis",backend="unconfigured"} 0');
    expect(cachedSourceMetrics.text).toContain('situation_data_osm_postgis_backend_info{backend="unconfigured"} 1');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_misses{source="osm_overpass"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_stale_hits{source="ctu_nettest"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_errors{source="pid_gtfs_rt"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_hits{source="safety_data"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_hits{source="aviation_weather"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_misses{source="ardos_partner"}');
  });

  it("returns the COP GeoJSON projection", async () => {
    const response = await request(app)
      .get("/api/v1/cop/features?bbox=13.85,49.65,15.35,50.45&layers=weather,ground,mobile,traffic&source=mock&limit=20")
      .expect(200);

    expect(response.body.contractVersion).toBe("cop-situation-source-v1");
    expect(response.body.type).toBe("FeatureCollection");
    expect(response.body.source.sourceType).toBe("PUBLIC_SITUATION_AGGREGATE");
    expect(response.body.summary.featureCount).toBeGreaterThan(0);
    expect(response.body.features[0]).toEqual(
      expect.objectContaining({
        type: "Feature",
        id: expect.any(String),
        geometry: expect.objectContaining({ type: "Point" }),
        properties: expect.objectContaining({
          featureId: expect.any(String),
          sourceId: "mock",
          confidence: expect.any(Number),
          stale: false,
          license: expect.objectContaining({ attribution: "DELTA ACR SIM" })
        })
      })
    );
  });

  it("filters by layer", async () => {
    const response = await request(app).get("/api/v1/features?layers=mobile&source=mock").expect(200);

    expect(response.body.features.length).toBeGreaterThan(0);
    expect(response.body.features.every((feature: { properties: { layer: string } }) => feature.properties.layer === "mobile")).toBe(true);
  });

  it("projects NOAA AWC METAR and TAF aviation weather as weather features", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.includes("/api/data/metar")) {
          return new Response(
            JSON.stringify([
              {
                icaoId: "LKPR",
                reportTime: "2026-05-20T18:00:00.000Z",
                temp: 18,
                dewp: 8,
                wdir: 290,
                wspd: 11,
                altim: 1022,
                rawOb: "METAR LKPR 201800Z 29011KT CAVOK 18/08 Q1022 NOSIG",
                lat: 50.101,
                lon: 14.26,
                elev: 364,
                name: "Prague/Havel Arpt",
                cover: "CAVOK",
                fltCat: "VFR"
              }
            ]),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.includes("/api/data/taf")) {
          return new Response(
            JSON.stringify([
              {
                icaoId: "LKPR",
                issueTime: "2026-05-20T17:00:00.000Z",
                validTimeFrom: 1779300000,
                validTimeTo: 1779408000,
                rawTAF: "TAF LKPR 201700Z 2018/2124 25010KT CAVOK",
                lat: 50.101,
                lon: 14.26,
                name: "Prague/Havel Arpt"
              }
            ]),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response("not found", { status: 404 });
      })
    );
    const aviationApp = await createApp({ ...config, enabledSources: ["aviation_weather"] });

    const response = await request(aviationApp.app)
      .get("/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=weather&source=aviation_weather&limit=20")
      .expect(200);

    expect(response.body.features[0]).toEqual(
      expect.objectContaining({
        id: "weather:aviation_weather:LKPR",
        properties: expect.objectContaining({
          sourceId: "aviation_weather",
          category: "aviation_weather_station",
          severity: "info",
          metrics: expect.objectContaining({ temperatureC: 18, windSpeedMps: 5.66 }),
          tags: expect.objectContaining({ icaoId: "LKPR", flightCategory: "VFR", tafAvailable: "true" })
        })
      })
    );
  });

  it("surfaces ARDOS partner configuration warnings without leaking calls", async () => {
    const ardosApp = await createApp({ ...config, enabledSources: ["ardos_partner"] });

    const response = await request(ardosApp.app)
      .get("/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=ground,traffic,mobile&source=ardos_partner&limit=20")
      .expect(200);

    expect(response.body.features).toHaveLength(0);
    expect(response.body.warnings[0]).toContain("ARDOS_PARTNER_BASE_URL");
  });

  it("surfaces OSM PostGIS configuration warnings without opening a database connection", async () => {
    const osmPostgisApp = await createApp({ ...config, enabledSources: ["osm_postgis"] });

    const response = await request(osmPostgisApp.app)
      .get("/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=ground,mobile&source=osm_postgis&limit=20")
      .expect(200);

    expect(response.body.features).toHaveLength(0);
    expect(response.body.warnings[0]).toContain("OSM_POSTGIS_DATABASE_URL");

    const health = await request(osmPostgisApp.app).get("/health/ready").expect(200);
    expect(health.body.status).toBe("degraded");
    expect(health.body.sourceHealth[0]).toEqual(
      expect.objectContaining({
        sourceId: "osm_postgis",
        backend: "unconfigured",
        status: "degraded"
      })
    );
  });

  it("keeps layers represented when a low limit is requested", async () => {
    const response = await request(app)
      .get("/api/v1/features?layers=weather,ground,mobile,traffic&source=mock&limit=4")
      .expect(200);

    const layers = new Set(response.body.features.map((feature: { properties: { layer: string } }) => feature.properties.layer));
    expect(layers).toEqual(new Set(["weather", "ground", "mobile", "traffic"]));
  });

  it("validates bbox and layers", async () => {
    const bbox = await request(app).get("/api/v1/features?bbox=bad").expect(400);
    expect(bbox.body.error.code).toBe("VALIDATION_ERROR");

    const layers = await request(app).get("/api/v1/features?layers=unknown").expect(400);
    expect(layers.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("coalesces concurrent cache misses into one source fetch", async () => {
    let calls = 0;
    const descriptor: SituationDataSource["descriptor"] = {
      sourceId: "mock",
      label: "test",
      enabled: true,
      mode: "mock",
      priority: 10,
      layers: ["weather"],
      license: {
        name: "test",
        attribution: "test",
        commercialUse: "allowed",
        operationalUse: "allowed",
        notes: []
      }
    };
    const source: SituationDataSource = {
      descriptor,
      async fetchFeatures() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        const fetchedAt = new Date().toISOString();
        return {
          source: descriptor,
          fetchedAt,
          warnings: [],
          features: [
            {
              type: "Feature",
              id: "weather:test",
              geometry: { type: "Point", coordinates: [14.4, 50.1] },
              properties: {
                featureId: "weather:test",
                layer: "weather",
                category: "weather_observation",
                label: "test",
                sourceId: "mock",
                observedAt: fetchedAt,
                confidence: 1,
                stale: false,
                severity: "info",
                license: { name: "test", attribution: "test" }
              }
            }
          ]
        };
      }
    };
    const service = new SituationAggregationService(config, [source]);
    const query = {
      bbox: { west: 13.85, south: 49.65, east: 15.35, north: 50.45 },
      layers: ["weather" as const],
      sourceIds: ["mock" as const],
      limit: 10,
      includeRaw: false
    };

    await Promise.all(Array.from({ length: 8 }, () => service.getFeatures(query)));

    expect(calls).toBe(1);
    expect(service.cacheStats().coalescedHits).toBe(7);
  });

  it("canonicalizes nearby bbox requests into the same aggregate cache key", async () => {
    let calls = 0;
    const descriptor: SituationDataSource["descriptor"] = {
      sourceId: "mock",
      label: "test",
      enabled: true,
      mode: "mock",
      priority: 10,
      layers: ["weather"],
      license: {
        name: "test",
        attribution: "test",
        commercialUse: "allowed",
        operationalUse: "allowed",
        notes: []
      }
    };
    const source: SituationDataSource = {
      descriptor,
      async fetchFeatures() {
        calls += 1;
        const fetchedAt = new Date().toISOString();
        return {
          source: descriptor,
          fetchedAt,
          warnings: [],
          features: [
            {
              type: "Feature",
              id: "weather:test",
              geometry: { type: "Point", coordinates: [14.4, 50.1] },
              properties: {
                featureId: "weather:test",
                layer: "weather",
                category: "weather_observation",
                label: "test",
                sourceId: "mock",
                observedAt: fetchedAt,
                confidence: 1,
                stale: false,
                severity: "info",
                license: { name: "test", attribution: "test" }
              }
            }
          ]
        };
      }
    };
    const service = new SituationAggregationService(config, [source]);
    const query = {
      bbox: { west: 13.85, south: 49.65, east: 15.35, north: 50.45 },
      layers: ["weather" as const],
      sourceIds: ["mock" as const],
      limit: 10,
      includeRaw: false
    };
    const shiftedQuery = {
      ...query,
      bbox: { west: 13.86, south: 49.66, east: 15.36, north: 50.46 }
    };

    await service.getFeatures(query);
    await service.getFeatures(shiftedQuery);

    expect(calls).toBe(1);
    expect(service.cacheStats().hits).toBe(1);
  });
});
