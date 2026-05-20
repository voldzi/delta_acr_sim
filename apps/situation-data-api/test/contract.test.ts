import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
      staleAfterSeconds: 900,
      openMeteoBaseUrl: "https://api.open-meteo.com",
      overpassBaseUrl: "https://overpass-api.de/api/interpreter",
      overpassMaxBboxDegrees: 1.6,
      ctuNettestUrl: "https://nettest.ctu.gov.cz/RMBTStatisticServer/export/nettest-opendata_hours-048.zip",
      pidGtfsRtVehiclePositionsUrl: "https://api.golemio.cz/v2/vehiclepositions/gtfsrt/vehicle_positions.pb"
    };
    ({ app } = await createApp(config));
  });

  afterEach(async () => {
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
        staleAfterSeconds: 900,
        providers: expect.arrayContaining([
          expect.objectContaining({ sourceId: "mock", authConfigured: true }),
          expect.objectContaining({ sourceId: "open_meteo", authConfigured: true }),
          expect.objectContaining({ sourceId: "ctu_nettest", authConfigured: true }),
          expect.objectContaining({ sourceId: "pid_gtfs_rt", authConfigured: true })
        ])
      })
    );
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });

  it("exposes cache metrics", async () => {
    const response = await request(app).get("/metrics").expect(200);
    expect(response.text).toContain("situation_data_cache_entries");
    expect(response.text).toContain("situation_data_cache_coalesced_hits");
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
});
