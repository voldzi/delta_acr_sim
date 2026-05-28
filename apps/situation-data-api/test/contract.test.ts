import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import gtfsRealtime from "gtfs-realtime-bindings";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SituationAggregationService } from "../src/aggregation.js";
import { createApp } from "../src/app.js";
import type { SituationDataConfig } from "../src/config.js";
import { MobileCoverageSource } from "../src/mobile-coverage-source.js";
import type { SharedResponseCacheStore } from "../src/response-cache.js";
import { MobileNetworkSource, type SituationDataSource } from "../src/sources.js";

describe("Situation Data API contract", () => {
  let dataDir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let config: SituationDataConfig;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "csm-sim-situation-data-"));
    config = {
      port: 0,
      dataDir,
      enabledSources: ["mock"],
      defaultBbox: { west: 13.85, south: 49.65, east: 15.35, north: 50.45 },
      requestTimeoutMs: 1000,
      cacheTtlSeconds: 1,
      staleIfErrorSeconds: 600,
      cacheMaxEntries: 128,
      sharedCacheRedisUrl: undefined,
      sharedCacheKeyPrefix: "test:situation-data",
      sharedCacheConnectTimeoutMs: 1000,
      bboxCachePaddingDegrees: 0.18,
      staleAfterSeconds: 900,
      openMeteoBaseUrl: "https://api.open-meteo.com",
      openMeteoCacheTtlSeconds: 600,
      openMeteoGridDegrees: 0.05,
      mobileCoverageCacheTtlSeconds: 21600,
      mobileNetworkCacheTtlSeconds: 3600,
      mobileCoverageResolutionM: 1000,
      mobileCoverageMaxCells: 1000,
      mobileCoverageModelVersion: "coverage-v1",
      mobileCoverageDemSource: "not-used-phase-1",
      mobileCoverageTerrainAware: false,
      mobileCoverageAntennaHeightM: 30,
      mobileCoverageReadModelEnabled: true,
      mobileCoverageReadModelTable: "public.mobile_coverage_cells",
      mobileCoverageReadModelMaxAgeSeconds: 604800,
      osmPostgisConnectionString: undefined,
      osmPostgisBackend: "unconfigured",
      osmPostgisTable: "public.osm_poi",
      osmPostgisCacheTtlSeconds: 21600,
      overpassBaseUrl: "https://overpass-api.de/api/interpreter",
      overpassCacheTtlSeconds: 21600,
      overpassMaxBboxDegrees: 1.6,
      ctuNettestUrl: "https://nettest.ctu.gov.cz/RMBTStatisticServer/export/nettest-opendata_hours-048.zip",
      ctuStationaryMobileUrls: [
        "https://ctu.gov.cz/sites/default/files/applications/ctu_imports/import_stacionarni_mereni/4g_o2_stacionarni/4g_o2_stacionarni.zip"
      ],
      ctuStationaryMobileCacheTtlSeconds: 86400,
      pidGtfsRtVehiclePositionsUrl: "https://api.golemio.cz/v2/vehiclepositions/gtfsrt/vehicle_positions.pb",
      idsjmkVehiclePositionsUrl: "https://example.test/idsjmk/vehicles.json",
      idsjmkVehiclePositionsCacheTtlSeconds: 20,
      roadSrtiLodSparqlUrl: "https://example.test/sparql",
      roadSrtiLodCacheTtlSeconds: 300,
      roadSrtiLodMaxRecords: 1500,
      safetyDataBaseUrl: "http://127.0.0.1:4030",
      safetyDataCacheTtlSeconds: 300,
      aviationWeatherBaseUrl: "https://aviationweather.gov",
      aviationWeatherCacheTtlSeconds: 600,
      chmiAirQualityMetadataUrl: "https://opendata.chmi.cz/air_quality/now/metadata/metadata.json",
      chmiAirQualityDataUrl: "https://opendata.chmi.cz/air_quality/now/data/airquality_1h_avg_CZ.csv",
      chmiAirQualityCacheTtlSeconds: 900,
      chmiWeatherMetadataBaseUrl: "https://opendata.chmi.cz/meteorology/climate/now/metadata/",
      chmiWeatherDataBaseUrl: "https://opendata.chmi.cz/meteorology/climate/now/data/",
      chmiWeatherCacheTtlSeconds: 600,
      chmiWeatherMaxStations: 16,
      ardosPartnerBaseUrl: undefined,
      ardosPartnerToken: undefined,
      ardosPartnerCacheTtlSeconds: 15,
      demEnabled: false,
      demDatasetId: "copernicus-glo30-cz",
      demPostgisConnectionString: undefined,
      demLocalCacheDir: "/dem-cache/copernicus-glo30",
      demSeaweedfsEndpoint: undefined,
      demSeaweedfsBucket: "sim-dem",
      demSeaweedfsPrefix: "copernicus-glo30/2021"
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
    expect(health.body.dem).toEqual(expect.objectContaining({ status: "disabled", datasetId: "copernicus-glo30-cz" }));

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
          sourceId: "mobile_coverage_model",
          layers: expect.arrayContaining(["mobile_coverage"])
        }),
        expect.objectContaining({
          sourceId: "mobile_network_model",
          layers: expect.arrayContaining(["mobile_network"])
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
          sourceId: "idsjmk_vehicle_positions",
          layers: expect.arrayContaining(["traffic"])
        }),
        expect.objectContaining({
          sourceId: "road_srti_lod",
          layers: expect.arrayContaining(["traffic"])
        }),
        expect.objectContaining({
          sourceId: "safety_data",
          layers: expect.arrayContaining(["warnings", "fire", "flood", "boundary_admin"])
        }),
        expect.objectContaining({
          sourceId: "aviation_weather",
          layers: expect.arrayContaining(["weather"])
        }),
        expect.objectContaining({
          sourceId: "chmi_air_quality",
          layers: expect.arrayContaining(["air_quality"])
        }),
        expect.objectContaining({
          sourceId: "chmi_weather_stations",
          layers: expect.arrayContaining(["weather"])
        }),
        expect.objectContaining({
          sourceId: "ardos_partner",
          license: expect.objectContaining({ name: "ARDOS partner data under MoU" })
        })
      ])
    );
  });

  it("exposes provider map catalog metadata for COM", async () => {
    const response = await request(app).get("/api/v1/catalog").expect(200);

    expect(response.body.contractVersion).toBe("provider-map-catalog-v1");
    expect(response.body.catalogVersion).toBe("provider-map-catalog-v1");
    expect(response.body.providerId).toBe("sim.situation-data");
    expect(response.body.status).toBe("online");
    expect(response.body.authority).toEqual(
      expect.objectContaining({
        contractVersion: "map-catalog-v1",
        catalogVersion: "map-catalog-v1",
        document: expect.stringContaining("02_MAP_CATALOG_PROVIDER_CONTRACT.md")
      })
    );

    expect(response.body.layers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerLayerId: "mobile_network",
          recommendedCatalogLayerId: "public.mobile.network",
          role: "overlay",
          audience: "public",
          kind: "vector_features",
          categories: ["mobile_network"],
          selectable: true,
          styleProfile: "mobile-network-quality-v1",
          sourceIds: ["mobile_network_model"],
          technicalInputs: expect.arrayContaining(["mobile_coverage_model", "ctu_nettest", "ctu_stationary_mobile", "osm_postgis"]),
          model: expect.objectContaining({
            modelVersion: "coverage-v1+mobile-network-v1",
            terrainAware: false,
            demSource: "not-used-phase-1"
          })
        }),
        expect.objectContaining({
          providerLayerId: "mobile_coverage",
          recommendedCatalogLayerId: "diagnostic.mobile.coverage",
          role: "diagnostic",
          audience: "diagnostic",
          selectable: false,
          replacedBy: "public.mobile.network"
        }),
        expect.objectContaining({
          providerLayerId: "mobile.ctu_nettest",
          recommendedCatalogLayerId: "diagnostic.mobile.ctu_measurements",
          role: "diagnostic",
          audience: "diagnostic",
          selectable: false,
          replacedBy: "public.mobile.network"
        }),
        expect.objectContaining({
          providerLayerId: "mobile.osm_postgis.communications",
          recommendedCatalogLayerId: "reference.infrastructure.communications",
          role: "reference",
          audience: "public",
          selectable: false
        }),
        expect.objectContaining({
          providerLayerId: "traffic.idsjmk_vehicle_positions",
          recommendedCatalogLayerId: "public.traffic.transit",
          role: "reference",
          audience: "public",
          sourceIds: ["idsjmk_vehicle_positions"]
        }),
        expect.objectContaining({
          providerLayerId: "traffic.road_events.srti",
          recommendedCatalogLayerId: "public.traffic.road_events",
          role: "overlay",
          audience: "public",
          sourceIds: ["road_srti_lod"]
        }),
        expect.objectContaining({
          providerLayerId: "warnings.safety_data_projection",
          recommendedCatalogLayerId: "public.safety.warnings",
          compatibilityOnly: true,
          preferredProviderId: "sim.safety-data",
          selectable: false
        }),
        expect.objectContaining({
          providerLayerId: "fire.safety_data_projection",
          recommendedCatalogLayerId: "public.safety.fire",
          compatibilityOnly: true,
          preferredProviderId: "sim.safety-data",
          selectable: false
        }),
        expect.objectContaining({
          providerLayerId: "boundary_admin.safety_data_projection",
          recommendedCatalogLayerId: "public.boundary.admin",
          compatibilityOnly: true,
          preferredProviderId: "sim.safety-data",
          selectable: false
        }),
        expect.objectContaining({
          providerLayerId: "air_quality.chmi_station_observations",
          recommendedCatalogLayerId: "public.safety.air_quality",
          role: "overlay",
          audience: "public",
          sourceIds: ["chmi_air_quality"]
        }),
        expect.objectContaining({
          providerLayerId: "weather.chmi_station_observations",
          recommendedCatalogLayerId: "public.weather.observations",
          role: "reference",
          audience: "public",
          sourceIds: ["chmi_weather_stations"]
        })
      ])
    );

    for (const layer of response.body.layers) {
      expect(layer).toEqual(
        expect.objectContaining({
          recommendedCatalogLayerId: expect.any(String),
          categories: expect.any(Array),
          role: expect.any(String),
          audience: expect.any(String),
          kind: expect.any(String),
          styleProfile: expect.any(String),
          sourceIds: expect.any(Array),
          refreshSeconds: expect.any(Number),
          cacheTtlSeconds: expect.any(Number)
        }),
        expect.objectContaining({
          providerLayerId: "mobile.ctu_stationary",
          recommendedCatalogLayerId: "diagnostic.mobile.ctu_stationary_measurements",
          role: "diagnostic",
          audience: "diagnostic",
          sourceIds: expect.arrayContaining(["ctu_stationary_mobile"]),
          replacedBy: "public.mobile.network"
        })
      );
    }

    expect(response.body.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "mobile_network_model",
          sourceRole: "final",
          audience: "public",
          selectableInMap: true,
          visibleInDiagnostics: true,
          feedsLayerIds: ["mobile_network"],
          technicalInputs: expect.arrayContaining(["mobile_coverage_model", "ctu_nettest", "ctu_stationary_mobile", "osm_postgis"]),
          feedsCatalogLayerIds: ["public.mobile.network"]
        }),
        expect.objectContaining({
          sourceId: "mobile_coverage_model",
          sourceRole: "input",
          audience: "diagnostic",
          selectableInMap: false,
          visibleInDiagnostics: true,
          feedsLayerIds: ["mobile_coverage"],
          usedByLayerIds: ["mobile_network"],
          usedByCatalogLayerIds: ["public.mobile.network"],
          replacedBy: "mobile_network_model"
        }),
        expect.objectContaining({
          sourceId: "ctu_nettest",
          sourceRole: "input",
          audience: "diagnostic",
          selectableInMap: false,
          visibleInDiagnostics: true,
          feedsLayerIds: ["mobile.ctu_nettest"],
          usedByLayerIds: ["mobile_network"],
          usedByCatalogLayerIds: ["public.mobile.network"],
          replacedBy: "mobile_network_model"
        }),
        expect.objectContaining({
          sourceId: "ctu_stationary_mobile",
          sourceRole: "input",
          audience: "diagnostic",
          selectableInMap: false,
          visibleInDiagnostics: true,
          feedsLayerIds: ["mobile.ctu_stationary"],
          usedByLayerIds: ["mobile_network"],
          usedByCatalogLayerIds: ["public.mobile.network"],
          replacedBy: "mobile_network_model"
        }),
        expect.objectContaining({
          sourceId: "idsjmk_vehicle_positions",
          sourceRole: "final",
          audience: "public",
          selectableInMap: true,
          feedsLayerIds: ["traffic.idsjmk_vehicle_positions"],
          feedsCatalogLayerIds: ["public.traffic.transit"]
        }),
        expect.objectContaining({
          sourceId: "road_srti_lod",
          sourceRole: "final",
          audience: "public",
          selectableInMap: true,
          feedsLayerIds: ["traffic.road_events.srti"],
          feedsCatalogLayerIds: ["public.traffic.road_events"]
        }),
        expect.objectContaining({
          sourceId: "safety_data",
          sourceRole: "projection",
          audience: "public",
          selectableInMap: false,
          feedsCatalogLayerIds: expect.arrayContaining(["public.safety.warnings", "public.safety.fire", "public.safety.flood", "public.boundary.admin"]),
          preferredProviderId: "sim.safety-data"
        })
      ])
    );

    for (const source of response.body.sources) {
      expect(source).toEqual(
        expect.objectContaining({
          sourceRole: expect.any(String),
          audience: expect.any(String),
          selectableInMap: expect.any(Boolean),
          visibleInDiagnostics: expect.any(Boolean),
          feedsLayerIds: expect.any(Array),
          feedsCatalogLayerIds: expect.any(Array)
        })
      );
    }
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
        sharedCache: {
          enabled: false,
          backend: "memory",
          keyPrefix: "test:situation-data",
          connectTimeoutMs: 1000
        },
        bboxCachePaddingDegrees: 0.18,
        staleAfterSeconds: 900,
        sourceCacheTtlSeconds: {
          openMeteo: 600,
          mobileNetwork: 3600,
          mobileCoverage: 21600,
          osmPostgis: 21600,
          osmOverpass: 21600,
          ctuStationaryMobile: 86400,
          idsjmkVehiclePositions: 20,
          roadSrtiLod: 300,
          safetyData: 300,
          aviationWeather: 600,
          chmiAirQuality: 900,
          chmiWeatherStations: 600,
          ardosPartner: 15
        },
        providers: expect.arrayContaining([
          expect.objectContaining({ sourceId: "mock", authConfigured: true }),
          expect.objectContaining({ sourceId: "open_meteo", authConfigured: true }),
          expect.objectContaining({ sourceId: "mobile_coverage_model", authConfigured: false, backend: "unconfigured" }),
          expect.objectContaining({ sourceId: "mobile_network_model", authConfigured: false, backend: "unconfigured" }),
          expect.objectContaining({ sourceId: "osm_postgis", authConfigured: false, backend: "unconfigured" }),
          expect.objectContaining({ sourceId: "ctu_nettest", authConfigured: true }),
          expect.objectContaining({ sourceId: "ctu_stationary_mobile", authConfigured: true }),
          expect.objectContaining({ sourceId: "pid_gtfs_rt", authConfigured: true }),
          expect.objectContaining({ sourceId: "idsjmk_vehicle_positions", authConfigured: true }),
          expect.objectContaining({ sourceId: "road_srti_lod", authConfigured: true }),
          expect.objectContaining({ sourceId: "safety_data", authConfigured: true }),
          expect.objectContaining({ sourceId: "aviation_weather", authConfigured: true }),
          expect.objectContaining({ sourceId: "chmi_air_quality", authConfigured: true, backend: "chmi-opendata" }),
          expect.objectContaining({ sourceId: "chmi_weather_stations", authConfigured: true, backend: "chmi-opendata" }),
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
    expect(response.text).toContain("situation_data_cache_shared_enabled");
    expect(response.text).toContain("situation_data_cache_shared_errors");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    const cachedSources = await createApp({
      ...config,
      enabledSources: [
        "open_meteo",
        "mobile_coverage_model",
        "mobile_network_model",
        "osm_postgis",
        "osm_overpass",
        "ctu_nettest",
        "ctu_stationary_mobile",
        "pid_gtfs_rt",
        "idsjmk_vehicle_positions",
        "road_srti_lod",
        "safety_data",
        "aviation_weather",
        "chmi_air_quality",
        "chmi_weather_stations",
        "ardos_partner"
      ]
    });
    const cachedSourceMetrics = await request(cachedSources.app).get("/metrics").expect(200);
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_hits{source="open_meteo"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_misses{source="mobile_coverage_model"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_health{source="mobile_coverage_model",backend="unconfigured"} 0');
    expect(cachedSourceMetrics.text).toContain('situation_data_mobile_coverage_backend_info{backend="unconfigured"} 1');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_misses{source="mobile_network_model"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_health{source="mobile_network_model",backend="unconfigured"} 0');
    expect(cachedSourceMetrics.text).toContain('situation_data_mobile_network_backend_info{backend="unconfigured"} 1');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_misses{source="osm_postgis"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_health{source="osm_postgis",backend="unconfigured"} 0');
    expect(cachedSourceMetrics.text).toContain('situation_data_osm_postgis_backend_info{backend="unconfigured"} 1');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_misses{source="osm_overpass"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_stale_hits{source="ctu_nettest"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_health{source="ctu_nettest",backend="ctu-nettest"} 0');
    expect(cachedSourceMetrics.text).toContain('situation_data_ctu_nettest_backend_info{backend="ctu-nettest"} 1');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_errors{source="ctu_stationary_mobile"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_health{source="ctu_stationary_mobile",backend="ctu-stationary-mobile"} 0');
    expect(cachedSourceMetrics.text).toContain('situation_data_ctu_stationary_mobile_backend_info{backend="ctu-stationary-mobile"} 1');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_errors{source="pid_gtfs_rt"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_errors{source="idsjmk_vehicle_positions"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_errors{source="road_srti_lod"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_hits{source="safety_data"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_hits{source="aviation_weather"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_errors{source="chmi_air_quality"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_health{source="chmi_air_quality",backend="chmi-opendata"} 0');
    expect(cachedSourceMetrics.text).toContain('situation_data_chmi_air_quality_backend_info{backend="chmi-opendata"} 1');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_errors{source="chmi_weather_stations"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_health{source="chmi_weather_stations",backend="chmi-opendata"} 0');
    expect(cachedSourceMetrics.text).toContain('situation_data_chmi_weather_stations_backend_info{backend="chmi-opendata"} 1');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_misses{source="ardos_partner"}');
  });

  it("projects fire and administrative boundary features from Safety Data without dropping MultiPolygon geometry", async () => {
    const safetyFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/v1/features");
      expect(url.searchParams.get("layers")).toBe("fire,boundary_admin");
      return new Response(
        JSON.stringify({
          features: [
            {
              type: "Feature",
              id: "fire:chmi_alerts:risk-orp",
              geometry: {
                type: "MultiPolygon",
                coordinates: [[[[14.2, 50.0], [14.3, 50.0], [14.3, 50.1], [14.2, 50.1], [14.2, 50.0]]]]
              },
              properties: {
                featureId: "fire:chmi_alerts:risk-orp",
                layerId: "public.safety.fire",
                providerId: "sim.safety-data",
                providerLayerId: "safety.fire",
                layer: "fire",
                category: "fire_weather_risk",
                hazardType: "fire_weather",
                headline: "Nebezpečí požárů",
                description: "Test fire danger warning.",
                recommendedAction: "Sledujte oficiální pokyny.",
                sourceId: "chmi_alerts",
                source: "chmi_alerts",
                sourceName: "CHMI CAP fire danger warnings",
                observedAt: "2026-05-28T08:00:00.000Z",
                validFrom: "2026-05-28T08:00:00.000Z",
                validUntil: "2026-05-28T18:00:00.000Z",
                updatedAt: "2026-05-28T08:00:00.000Z",
                confidence: 0.9,
                stale: false,
                severity: "warning",
                status: "risk",
                urgency: "expected",
                certainty: "likely",
                areaName: "ORP Praha",
                styleHint: "safety-fire-warning",
                iconHint: "fire",
                basis: ["chmi_cap_fire_weather"],
                fireStatus: "risk",
                license: { name: "CC BY 4.0", attribution: "CHMI" },
                affectedAreas: ["ORP Praha"],
                geocodes: [{ scheme: "CISORP", value: "3100" }],
                metrics: { fireRiskFromWeatherWarning: true },
                tags: { test: "fire" }
              }
            },
            {
              type: "Feature",
              id: "boundary_admin:admin_boundaries:CZ",
              geometry: {
                type: "MultiPolygon",
                coordinates: [[[[14.0, 49.9], [14.5, 49.9], [14.5, 50.3], [14.0, 50.3], [14.0, 49.9]]]]
              },
              properties: {
                featureId: "boundary_admin:admin_boundaries:CZ",
                layerId: "public.boundary.admin",
                providerId: "sim.safety-data",
                providerLayerId: "boundary.admin",
                layer: "boundary_admin",
                category: "admin_boundary",
                hazardType: "boundary",
                headline: "Czechia",
                sourceId: "admin_boundaries",
                source: "admin_boundaries",
                sourceName: "Administrative boundaries",
                observedAt: "2026-05-28T08:00:00.000Z",
                validFrom: "2026-05-28T08:00:00.000Z",
                updatedAt: "2026-05-28T08:00:00.000Z",
                confidence: 0.95,
                stale: false,
                severity: "info",
                status: "reference",
                urgency: "unknown",
                certainty: "observed",
                adminLevel: 2,
                name: "Czechia",
                code: "CZ",
                countryCode: "CZ",
                basis: ["postgis_admin_boundary"],
                license: { name: "ODbL 1.0", attribution: "OpenStreetMap contributors" },
                metrics: { adminLevel: 2 }
              }
            }
          ],
          warnings: []
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    vi.stubGlobal("fetch", safetyFetch);
    const safetyApp = await createApp({ ...config, enabledSources: ["safety_data"] });
    const response = await request(safetyApp.app)
      .get("/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=fire,boundary_admin&source=safety_data&limit=10")
      .expect(200);

    expect(response.body.summary.featureCount).toBe(2);
    expect(response.body.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          geometry: expect.objectContaining({ type: "MultiPolygon" }),
          properties: expect.objectContaining({
            layer: "fire",
            layerId: "public.safety.fire",
            providerId: "sim.situation-data",
            providerLayerId: "fire.safety_data_projection",
            providerProperties: expect.objectContaining({ fireStatus: "risk", nativeProviderId: "sim.safety-data" })
          })
        }),
        expect.objectContaining({
          geometry: expect.objectContaining({ type: "MultiPolygon" }),
          properties: expect.objectContaining({
            layer: "boundary_admin",
            layerId: "public.boundary.admin",
            providerLayerId: "boundary_admin.safety_data_projection",
            providerProperties: expect.objectContaining({ adminLevel: 2, code: "CZ" })
          })
        })
      ])
    );
    expect(safetyFetch).toHaveBeenCalledTimes(1);
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
          layerId: expect.stringMatching(/^diagnostic\.mock\./),
          providerId: "sim.situation-data",
          providerLayerId: expect.any(String),
          sourceId: "mock",
          confidence: expect.any(Number),
          stale: false,
          license: expect.objectContaining({ attribution: "CSM SIM" })
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

  it("projects CHMI air-quality observations as public safety features", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/metadata.json")) {
        return new Response(
          JSON.stringify({
            data: {
              Localities: [
                {
                  LocalityCode: "APRA",
                  Name: "Praha test",
                  Localization: { LatAsNumber: 50.08, LonAsNumber: 14.42, Alt: "250 m" },
                  BasicInfo: { LocalityName: "Praha test", Region: "Praha", District: "Praha" },
                  MeasuringPrograms: [
                    {
                      Measurements: [
                        { IdRegistration: 101, ComponentCode: "PM10", ComponentName: "prachove castice PM10", UnitAsASCII: "ug/m^3" },
                        { IdRegistration: 102, ComponentCode: "INDX", ComponentName: "Index kvality ovzdusi", UnitAsASCII: "1" }
                      ]
                    }
                  ]
                }
              ]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/airquality_1h_avg_CZ.csv")) {
        return new Response(
          [
            "idRegistration, startTime, idValueType, value",
            "101, 2026-05-28T08:00:00Z, 8, 45.5",
            "102, 2026-05-28T08:00:00Z, 148, 4"
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/csv" } }
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const chmiApp = await createApp({ ...config, enabledSources: ["chmi_air_quality"] });

    const response = await request(chmiApp.app)
      .get("/api/v1/features?bbox=14.0,49.8,14.8,50.3&layers=air_quality&source=chmi_air_quality&limit=20&includeRaw=true")
      .expect(200);

    expect(response.body.features).toHaveLength(1);
    expect(response.body.features[0]).toEqual(
      expect.objectContaining({
        id: "air_quality:chmi_air_quality:APRA",
        properties: expect.objectContaining({
          sourceId: "chmi_air_quality",
          layerId: "public.safety.air_quality",
          providerLayerId: "air_quality.chmi_station_observations",
          category: "air_quality_observation",
          severity: "advisory",
          metrics: expect.objectContaining({ airQualityIndex: 4, pm10UgM3: 45.5 }),
          tags: expect.objectContaining({ stationCode: "APRA", region: "Praha", airQualityLevel: "acceptable" }),
          providerProperties: expect.objectContaining({
            raw: expect.objectContaining({
              components: expect.objectContaining({ pm10UgM3: "PM10" })
            })
          })
        })
      })
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("projects CHMI measured weather stations from source-level caches", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url === config.chmiWeatherMetadataBaseUrl) {
        return new Response('<a href="meta1-20260528.json">meta1-20260528.json</a>', {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (url === config.chmiWeatherDataBaseUrl) {
        return new Response('<a href="10m-0-20000-0-11518-20260528.json">10m-0-20000-0-11518-20260528.json</a>', {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (url.endsWith("/meta1-20260528.json")) {
        return new Response(
          JSON.stringify({
            data: {
              data: {
                header: "WSI,GH_ID,FULL_NAME,GEOGR1,GEOGR2,ELEVATION,BEGIN_DATE",
                values: [["0-20000-0-11518", "ZIS11518", "Praha-Karlov", 14.42, 50.08, 260, "1900-01-01T00:00:00Z"]]
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/10m-0-20000-0-11518-20260528.json")) {
        return new Response(
          JSON.stringify({
            data: {
              data: {
                header: "STATION,ELEMENT,DT,VAL,FLAG,QUALITY",
                values: [
                  ["0-20000-0-11518", "T", "2026-05-28T08:00:00Z", 17.2, "", 5],
                  ["0-20000-0-11518", "H", "2026-05-28T08:00:00Z", 63, "", 5],
                  ["0-20000-0-11518", "D", "2026-05-28T08:00:00Z", 270, "", 5],
                  ["0-20000-0-11518", "F", "2026-05-28T08:00:00Z", 4.2, "", 5],
                  ["0-20000-0-11518", "Fmax", "2026-05-28T08:00:00Z", 7.8, "", 5],
                  ["0-20000-0-11518", "SRA10M", "2026-05-28T08:00:00Z", 0.4, "", 5]
                ]
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const chmiApp = await createApp({ ...config, enabledSources: ["chmi_weather_stations"] });

    const first = await request(chmiApp.app)
      .get("/api/v1/features?bbox=14.0,49.8,14.8,50.3&layers=weather&source=chmi_weather_stations&limit=20&includeRaw=true")
      .expect(200);
    const second = await request(chmiApp.app)
      .get("/api/v1/features?bbox=14.0,49.8,14.8,50.3&layers=weather&source=chmi_weather_stations&limit=21")
      .expect(200);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(first.body.features).toHaveLength(1);
    expect(second.body.features).toHaveLength(1);
    expect(first.body.features[0]).toEqual(
      expect.objectContaining({
        id: "weather:chmi_weather_stations:0-20000-0-11518",
        properties: expect.objectContaining({
          sourceId: "chmi_weather_stations",
          layerId: "public.weather.observations",
          providerLayerId: "weather.chmi_station_observations",
          category: "weather_station_observation",
          metrics: expect.objectContaining({
            temperatureC: 17.2,
            relativeHumidityPercent: 63,
            windSpeedMps: 4.2,
            precipitation10mMm: 0.4
          }),
          tags: expect.objectContaining({ stationId: "0-20000-0-11518", ghId: "ZIS11518" }),
          providerProperties: expect.objectContaining({
            raw: expect.objectContaining({ station: expect.any(Object) })
          })
        })
      })
    );
  });

  it("projects PID GTFS-RT vehicle positions with normalized traffic attributes", async () => {
    const feed = gtfsRealtime.transit_realtime.FeedMessage.create({
      header: {
        gtfsRealtimeVersion: "2.0",
        timestamp: Math.round(Date.parse("2026-05-28T08:00:00.000Z") / 1000)
      },
      entity: [
        {
          id: "pid-entity-1",
          vehicle: {
            trip: {
              tripId: "trip-136-1",
              routeId: "L136",
              startDate: "20260528",
              startTime: "08:00:00"
            },
            vehicle: {
              id: "service-3-pid-veh-1",
              label: "PID vehicle 1"
            },
            position: {
              latitude: 50.08,
              longitude: 14.42,
              bearing: 82,
              speed: 7.5
            },
            timestamp: Math.round(Date.parse("2026-05-28T08:01:00.000Z") / 1000),
            occupancyStatus: gtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.MANY_SEATS_AVAILABLE,
            occupancyPercentage: 37
          }
        }
      ]
    });
    const payload = gtfsRealtime.transit_realtime.FeedMessage.encode(feed).finish();
    const fetchMock = vi.fn(async () => {
      return new Response(payload, { status: 200, headers: { "content-type": "application/octet-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const pidApp = await createApp({
      ...config,
      cacheTtlSeconds: 0,
      enabledSources: ["pid_gtfs_rt"]
    });

    const response = await request(pidApp.app)
      .get("/api/v1/features?bbox=14.0,49.8,14.8,50.3&layers=traffic&source=pid_gtfs_rt&limit=20&includeRaw=true")
      .expect(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.body.features).toHaveLength(1);
    expect(response.body.features[0]).toEqual(
      expect.objectContaining({
        id: "traffic:pid_gtfs_rt:service-3-pid-veh-1",
        properties: expect.objectContaining({
          sourceId: "pid_gtfs_rt",
          layerId: "public.traffic.transit",
          providerLayerId: "traffic.pid_gtfs_rt",
          category: "public_transport_bus",
          transportMode: "bus",
          routeShortName: "136",
          vehicleId: "service-3-pid-veh-1",
          tripId: "trip-136-1",
          occupancyStatus: "many_seats_available",
          occupancyPercent: 37,
          speedMps: 7.5,
          headingDeg: 82,
          operator: "PID",
          providerProperties: expect.objectContaining({
            raw: expect.any(Object)
          })
        })
      })
    );
  });

  it("projects IDS JMK vehicle positions from a source-level cache", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          LastUpdate: "2026-05-28T08:00:00.000Z",
          features: [
            {
              attributes: {
                VehicleId: "idsjmk-veh-1",
                LineName: "12",
                VehicleType: "tram",
                Speed: 9,
                Bearing: 88,
                DelaySeconds: 60,
                Destination: "Technologický park",
                Operator: "DPMB"
              },
              geometry: {
                x: 16.607,
                y: 49.195
              }
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const idsjmkApp = await createApp({
      ...config,
      cacheTtlSeconds: 0,
      enabledSources: ["idsjmk_vehicle_positions"]
    });

    const first = await request(idsjmkApp.app)
      .get("/api/v1/features?bbox=16.2,48.9,16.9,49.4&layers=traffic&source=idsjmk_vehicle_positions&limit=20&includeRaw=true")
      .expect(200);
    const second = await request(idsjmkApp.app)
      .get("/api/v1/features?bbox=16.2,48.9,16.9,49.4&layers=traffic&source=idsjmk_vehicle_positions&limit=21")
      .expect(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.body.features).toHaveLength(1);
    expect(second.body.features).toHaveLength(1);
    expect(first.body.features[0]).toEqual(
      expect.objectContaining({
        id: "traffic:idsjmk_vehicle_positions:idsjmk-veh-1",
        properties: expect.objectContaining({
          sourceId: "idsjmk_vehicle_positions",
          layerId: "public.traffic.transit",
          providerLayerId: "traffic.idsjmk_vehicle_positions",
          category: "public_transport_tram",
          transportMode: "tram",
          routeShortName: "12",
          destination: "Technologický park",
          delaySeconds: 60,
          vehicleId: "idsjmk-veh-1",
          operator: "DPMB",
          speedMps: 9,
          headingDeg: 88,
          metrics: expect.objectContaining({ speedMps: 9, headingDeg: 88 }),
          tags: expect.objectContaining({ line: "12", transportMode: "tram" }),
          providerProperties: expect.objectContaining({
            raw: expect.any(Object)
          })
        })
      })
    );
  });

  it("projects NDIC SRTI road events from a source-level cache", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          head: { vars: ["SituationRecord", "Type", "VersionTime", "GeometryWKT"] },
          results: {
            bindings: [
              {
                SituationRecord: { type: "uri", value: "https://lod.tamtamresearch.com/resource/situation/road-1" },
                Type: { type: "uri", value: "http://cef.uv.es/lodroadtran18/def/transporte/dtx_srti#Accident" },
                VersionTime: { type: "literal", value: "2026-05-28T08:30:00.000Z" },
                GeometryWKT: { type: "literal", value: "POINT(14.42 50.08)" }
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/sparql-results+json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const roadApp = await createApp({
      ...config,
      cacheTtlSeconds: 0,
      enabledSources: ["road_srti_lod"]
    });

    const first = await request(roadApp.app)
      .get("/api/v1/features?bbox=14.0,49.8,14.8,50.3&layers=traffic&source=road_srti_lod&limit=20")
      .expect(200);
    const second = await request(roadApp.app)
      .get("/api/v1/features?bbox=14.0,49.8,14.8,50.3&layers=traffic&source=road_srti_lod&limit=21")
      .expect(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.body.features).toHaveLength(1);
    expect(second.body.features).toHaveLength(1);
    expect(first.body.features[0]).toEqual(
      expect.objectContaining({
        id: "traffic:road_srti_lod:https:__lod.tamtamresearch.com_resource_situation_road-1",
        properties: expect.objectContaining({
          sourceId: "road_srti_lod",
          layerId: "public.traffic.road_events",
          providerLayerId: "traffic.road_events.srti",
          category: "road_accident",
          severity: "warning",
          transportMode: "road",
          operator: "NDIC/ŘSD",
          tags: expect.objectContaining({ srtiType: "Accident", sourceSystem: "ndic_srti_lod" })
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

  it("exposes mobile coverage metadata and configuration warnings", async () => {
    const coverageApp = await createApp({ ...config, enabledSources: ["mobile_coverage_model"] });

    const metadata = await request(coverageApp.app).get("/api/v1/mobile-coverage/metadata").expect(200);
    expect(metadata.body).toEqual(
      expect.objectContaining({
        layerId: "mobile_coverage",
        modelVersion: "coverage-v1",
        technologies: ["2G", "4G", "5G"],
        qualityLevels: ["good", "fair", "weak", "none", "unknown"],
        cacheTtlSeconds: 21600,
        disclaimer: expect.stringContaining("estimate")
      })
    );

    const response = await request(coverageApp.app)
      .get("/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=mobile_coverage&source=mobile_coverage_model&limit=20")
      .expect(200);
    expect(response.body.features).toHaveLength(0);
    expect(response.body.warnings[0]).toContain("OSM_POSTGIS_DATABASE_URL");
  });

  it("exposes DEM metadata when the catalog is disabled", async () => {
    const response = await request(app).get("/api/v1/dem/metadata").expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        enabled: false,
        status: "disabled",
        datasetId: "copernicus-glo30-cz",
        localCacheDir: "/dem-cache/copernicus-glo30",
        objectStore: expect.objectContaining({ bucket: "sim-dem", prefix: "copernicus-glo30/2021" })
      })
    );
  });

  it("builds mobile coverage polygons from tower references", async () => {
    const source = new MobileCoverageSource({
      ...config,
      enabledSources: ["mobile_coverage_model"],
      osmPostgisConnectionString: "postgresql://sim_osm:secret@example.test:5432/sim_osm",
      osmPostgisBackend: "external-postgis",
      mobileCoverageResolutionM: 500,
      mobileCoverageMaxCells: 16
    });
    (source as unknown as { fetchTowers: () => Promise<Array<{ id: string; name: string; lon: number; lat: number }>> }).fetchTowers = async () => [
      { id: "node:1", name: "Test tower", lon: 14.42, lat: 50.08 }
    ];

    const result = await source.fetchFeatures({
      bbox: { west: 14.41, south: 50.07, east: 14.43, north: 50.09 },
      layers: ["mobile_coverage"],
      sourceIds: ["mobile_coverage_model"],
      limit: 5,
      includeRaw: false,
      mobileCoverageTechnologies: ["4G"]
    });

    expect(result.warnings).toEqual([]);
    expect(result.features[0]).toEqual(
      expect.objectContaining({
        geometry: expect.objectContaining({ type: "Polygon" }),
        properties: expect.objectContaining({
          sourceId: "mobile_coverage_model",
          layer: "mobile_coverage",
          technology: "4G",
          quality: expect.stringMatching(/good|fair|weak|none/),
          dataQuality: "modelled",
          btsStatus: "operator_feed_unavailable",
          operatorStatusAvailable: false,
          modelVersion: "coverage-v1",
          resolutionM: expect.any(Number),
          disclaimer: expect.stringContaining("estimate")
        })
      })
    );
    expect(result.features[0].properties.raw).toBeUndefined();
  });

  it("prefers prepared mobile coverage read-model polygons over runtime calculation", async () => {
    const source = new MobileCoverageSource({
      ...config,
      enabledSources: ["mobile_coverage_model"],
      osmPostgisConnectionString: "postgresql://sim_osm:secret@example.test:5432/sim_osm",
      osmPostgisBackend: "external-postgis",
      mobileCoverageReadModelEnabled: true
    });
    let runtimeFallbackCalled = false;
    (source as unknown as { fetchTowers: () => Promise<Array<never>> }).fetchTowers = async () => {
      runtimeFallbackCalled = true;
      return [];
    };
    (source as unknown as { fetchReadModelFeatures: () => Promise<{ hit: boolean; warnings: string[]; features: Array<unknown> }> }).fetchReadModelFeatures =
      async () => ({
        hit: true,
        warnings: [],
        features: [
          {
            type: "Feature",
            id: "coverage:mobile:4g:prepared",
            geometry: {
              type: "Polygon",
              coordinates: [[
                [14.41, 50.07],
                [14.43, 50.07],
                [14.43, 50.09],
                [14.41, 50.09],
                [14.41, 50.07]
              ]]
            },
            properties: {
              featureId: "coverage:mobile:4g:prepared",
              layer: "mobile_coverage",
              category: "mobile_coverage",
              label: "4G coverage estimate",
              sourceId: "mobile_coverage_model",
              observedAt: new Date().toISOString(),
              confidence: 0.74,
              stale: false,
              severity: "info",
              license: { name: "coverage", attribution: "coverage" },
              operator: "unknown",
              technology: "4G",
              quality: "good",
              modelVersion: "coverage-v1",
              readModel: true,
              dataQuality: "modelled"
            }
          }
        ]
      });

    const result = await source.fetchFeatures({
      bbox: { west: 14.41, south: 50.07, east: 14.43, north: 50.09 },
      layers: ["mobile_coverage"],
      sourceIds: ["mobile_coverage_model"],
      limit: 5,
      includeRaw: false,
      mobileCoverageTechnologies: ["4G"]
    });

    expect(runtimeFallbackCalled).toBe(false);
    expect(result.features[0].properties.readModel).toBe(true);
    expect(result.features[0].properties.quality).toBe("good");
  });

  it("builds unified mobile network assessment from coverage and measurements", async () => {
    const source = new MobileNetworkSource({
      ...config,
      enabledSources: ["mobile_network_model"],
      osmPostgisConnectionString: "postgresql://sim_osm:secret@example.test:5432/sim_osm",
      osmPostgisBackend: "external-postgis",
      mobileCoverageResolutionM: 500,
      mobileCoverageMaxCells: 16
    });
    let coverageTechnologies: string[] | undefined;
    (source as unknown as { coverageSource: SituationDataSource }).coverageSource = {
      descriptor: {
        sourceId: "mobile_coverage_model",
        label: "coverage",
        enabled: true,
        mode: "live",
        priority: 64,
        layers: ["mobile_coverage"],
        license: { name: "coverage", attribution: "coverage", commercialUse: "allowed", operationalUse: "allowed", notes: [] }
      },
      async fetchFeatures(query) {
        coverageTechnologies = query.mobileCoverageTechnologies;
        return {
          source: this.descriptor,
          fetchedAt: new Date().toISOString(),
          warnings: [],
          features: [
            {
              type: "Feature",
              id: "coverage:mobile:4g:0-0",
              geometry: {
                type: "Polygon",
                coordinates: [[
                  [14.41, 50.07],
                  [14.43, 50.07],
                  [14.43, 50.09],
                  [14.41, 50.09],
                  [14.41, 50.07]
                ]]
              },
              properties: {
                featureId: "coverage:mobile:4g:0-0",
                layer: "mobile_coverage",
                category: "mobile_coverage",
                label: "4G coverage estimate",
                sourceId: "mobile_coverage_model",
                observedAt: new Date().toISOString(),
                confidence: 0.66,
                stale: false,
                severity: "info",
                license: { name: "coverage", attribution: "coverage" },
                operator: "unknown",
                technology: "4G",
                quality: "fair",
                estimatedSignalDbm: -98,
                modelVersion: "coverage-v1",
                generatedAt: new Date().toISOString(),
                resolutionM: 500,
                demSource: "not-used-phase-1"
              }
            }
          ]
        };
      }
    };
    (source as unknown as { ctuNettestSource: SituationDataSource }).ctuNettestSource = {
      descriptor: {
        sourceId: "ctu_nettest",
        label: "measurements",
        enabled: true,
        mode: "live",
        priority: 65,
        layers: ["mobile"],
        license: { name: "CTU", attribution: "CTU", commercialUse: "allowed", operationalUse: "allowed", notes: [] }
      },
      async fetchFeatures() {
        return {
          source: this.descriptor,
          fetchedAt: new Date().toISOString(),
          warnings: [],
          features: [
            {
              type: "Feature",
              id: "mobile:ctu_nettest:1",
              geometry: { type: "Point", coordinates: [14.42, 50.08] },
              properties: {
                featureId: "mobile:ctu_nettest:1",
                layer: "mobile",
                category: "network_measurement",
                label: "CTU NetTest LTE",
                sourceId: "ctu_nettest",
                observedAt: new Date().toISOString(),
                confidence: 0.8,
                stale: false,
                severity: "warning",
                license: { name: "CTU", attribution: "CTU" },
                metrics: { downloadMbps: 3, uploadMbps: 1, latencyMs: 90, lteRsrpDbm: -111 }
              }
            }
          ]
        };
      }
    };

    const result = await source.fetchFeatures({
      bbox: { west: 14.41, south: 50.07, east: 14.43, north: 50.09 },
      layers: ["mobile_network"],
      sourceIds: ["mobile_network_model"],
      limit: 5,
      includeRaw: false
    });

    expect(coverageTechnologies).toEqual(["4G"]);
    expect(result.features[0]).toEqual(
      expect.objectContaining({
        geometry: expect.objectContaining({ type: "Polygon" }),
        properties: expect.objectContaining({
          sourceId: "mobile_network_model",
          layer: "mobile_network",
          quality: "fair",
          status: expect.stringMatching(/ok|weak_signal|degraded_possible|unknown/),
          dataQuality: "mixed",
          btsStatus: "operator_feed_unavailable",
          operatorStatusAvailable: false,
          basis: expect.arrayContaining(["CTU_NETTEST_MEASUREMENT", "NO_OPERATOR_BTS_STATUS"]),
          summary: expect.stringContaining("Mobilní síť"),
          disclaimer: expect.stringContaining("not a confirmed BTS")
        })
      })
    );
    expect(result.features[0].properties.raw).toBeUndefined();
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

  it("reuses aggregate responses from a shared cache store", async () => {
    let calls = 0;
    const sharedStore = new InMemorySharedResponseCacheStore();
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
    const query = {
      bbox: { west: 13.85, south: 49.65, east: 15.35, north: 50.45 },
      layers: ["weather" as const],
      sourceIds: ["mock" as const],
      limit: 10,
      includeRaw: false
    };

    const firstService = new SituationAggregationService(config, [source], sharedStore);
    await firstService.getFeatures(query);
    const secondService = new SituationAggregationService(config, [source], sharedStore);
    await secondService.getFeatures(query);

    expect(calls).toBe(1);
    expect(firstService.cacheStats().sharedWrites).toBe(1);
    expect(secondService.cacheStats().sharedHits).toBe(1);
  });
});

class InMemorySharedResponseCacheStore implements SharedResponseCacheStore {
  private readonly values = new Map<string, { value: string; expiresAtMs: number }>();

  async get(key: string): Promise<string | undefined> {
    const item = this.values.get(key);
    if (!item || item.expiresAtMs <= Date.now()) {
      return undefined;
    }
    return item.value;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.values.set(key, { value, expiresAtMs: Date.now() + ttlMs });
  }

  isAvailable(): boolean {
    return true;
  }
}
