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
import { OsmPostgisSource } from "../src/osm-postgis-source.js";
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
      osmPostgisAdminBoundaryTable: "public.osm_admin_boundary",
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
      chmiWeatherRadarBaseUrl: "https://opendata.chmi.cz/meteorology/weather/radar/composite/",
      chmiWeatherRadarCacheTtlSeconds: 300,
      chmiWeatherRadarFrameHistoryHours: 6,
      chmiWeatherRadarFrameMaxCount: 72,
      chmiWeatherRadarFrameStoreEnabled: false,
      chmiWeatherRadarFrameStoreDir: join(dataDir, "weather-radar-frames"),
      chmiWeatherRadarCleanCropInsetPixels: 2,
      chmiWeatherWebcamsMapUrl: "https://data-provider.chmi.cz/api/kamery/data/map",
      chmiWeatherWebcamsDataBaseUrl: "https://data-provider.chmi.cz",
      chmiWeatherWebcamsPublicBaseUrl: "https://www.chmi.cz",
      chmiWeatherWebcamsCacheTtlSeconds: 300,
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
        expect.objectContaining({ layerId: "mobile", defaultVisible: false }),
        expect.objectContaining({ layerId: "boundary_region", defaultVisible: false }),
        expect.objectContaining({ layerId: "weather_temperature_grid", defaultVisible: false }),
        expect.objectContaining({ layerId: "weather_radar_reflectivity", defaultVisible: false }),
        expect.objectContaining({ layerId: "weather_thunderstorm_risk", defaultVisible: false }),
        expect.objectContaining({ layerId: "weather_webcams", defaultVisible: false }),
        expect.objectContaining({ layerId: "air_quality_grid", defaultVisible: false })
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
          layers: expect.arrayContaining(["ground", "mobile", "boundary_country", "boundary_region", "boundary_district", "boundary_orp", "place_settlements"]),
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
          layers: expect.arrayContaining(["air_quality", "air_quality_grid"])
        }),
        expect.objectContaining({
          sourceId: "chmi_weather_stations",
          layers: expect.arrayContaining(["weather", "weather_temperature_grid", "weather_wind_field"])
        }),
        expect.objectContaining({
          sourceId: "chmi_weather_radar",
          layers: expect.arrayContaining(["weather_radar_reflectivity", "weather_radar_precipitation", "weather_radar_nowcast", "weather_thunderstorm_risk"])
        }),
        expect.objectContaining({
          sourceId: "chmi_weather_webcams",
          layers: expect.arrayContaining(["weather_webcams"])
        }),
        expect.objectContaining({
          sourceId: "ardos_partner",
          license: expect.objectContaining({ name: "ARDOS partner data under MoU" })
        })
      ])
    );
  });

  it("exposes CHMI weather radar frame metadata", async () => {
    const now = new Date();
    const dateToken = now.toISOString().slice(0, 10).replace(/-/g, "");
    const timeToken = `${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}`;
    const href = `pacz2gmaps3.merge.${dateToken}.${timeToken}.60.png`;
    const fetchMock = vi.fn(async () => new Response(`<html><body><a href="${href}">${href}</a></body></html>`, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await request(app).get("/api/v1/weather-radar/frames?product=merge1h&hours=72&limit=1").expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-weather-radar-frames-v1",
        providerId: "sim.situation-data",
        sourceId: "chmi_weather_radar",
        frameStore: expect.objectContaining({ enabled: false, mode: "metadata_only" }),
        rasterSemantics: expect.objectContaining({
          sourceImageMayContainFrame: true,
          sourceImageMayContainEmbeddedLabels: true,
          cleanRasterAvailable: true,
          cleanMethod: "server_crop_to_data_bounds",
          cleanCropInsetPixels: 2
        }),
        products: [
          expect.objectContaining({
            productId: "merge1h",
            catalogLayerId: "public.weather.radar_precipitation",
            frames: [
              expect.objectContaining({
                sourceRevision: href,
                cleanRasterAvailable: true,
                cleanUrl: `/api/v1/weather-radar/clean/merge1h/${href}?v=2`,
                stored: false,
                sourceImageMayContainFrame: true,
                sourceImageMayContainEmbeddedLabels: true
              })
            ]
          })
        ]
      })
    );
  });

  it("exposes CHMI weather camera catalog detail and snapshot endpoints", async () => {
    const dataUrl = "https://data-provider.chmi.cz/api/kamery/data/point?x=14.445358&y=50.00751";
    const image = "R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === config.chmiWeatherWebcamsMapUrl) {
        return jsonResponse({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [482791.5, 5540813.3] },
              properties: { dataUrl, icon: "335" }
            }
          ]
        });
      }
      if (url === dataUrl) {
        return jsonResponse({
          data: [
            {
              name: "Praha-Libuš (VSV)",
              url: "/namerena-data/webkamera/praha_libus-praha-libus",
              img: image
            }
          ]
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await request(app).get("/api/v1/weather-cameras?bbox=14.4,50,14.5,50.1").expect(200);
    expect(catalog.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-weather-cameras-v1",
        sourceId: "chmi_weather_webcams",
        snapshotPolicy: expect.objectContaining({ imagePayloadInFeatureStream: false }),
        locations: [
          expect.objectContaining({
            locationId: "wgs84_14p445358_50p007510",
            detailUrl: "/api/v1/weather-cameras/wgs84_14p445358_50p007510",
            snapshotUrl: "/api/v1/weather-cameras/wgs84_14p445358_50p007510/snapshot"
          })
        ]
      })
    );

    const detail = await request(app).get(catalog.body.locations[0].detailUrl).expect(200);
    expect(detail.body.cameras).toEqual([
      expect.objectContaining({
        cameraId: "praha_libus-praha-libus",
        name: "Praha-Libuš (VSV)",
        snapshotUrl: "/api/v1/weather-cameras/wgs84_14p445358_50p007510/snapshot?cameraId=praha_libus-praha-libus",
        contentType: "image/gif"
      })
    ]);
    expect(JSON.stringify(detail.body)).not.toContain(image);

    const snapshot = await request(app).get(detail.body.cameras[0].snapshotUrl).expect(200);
    expect(snapshot.headers["content-type"]).toContain("image/gif");
    expect(snapshot.headers["x-sim-camera-id"]).toBe("praha_libus-praha-libus");
    expect(snapshot.body.length).toBeGreaterThan(0);
  });

  it("projects CHMI weather cameras as clickable COP feature points", async () => {
    config.enabledSources = ["chmi_weather_webcams"];
    ({ app } = await createApp(config));
    const dataUrl = "https://data-provider.chmi.cz/api/kamery/data/point?x=14.445358&y=50.00751";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === config.chmiWeatherWebcamsMapUrl) {
          return jsonResponse({
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: { type: "Point", coordinates: [482791.5, 5540813.3] },
                properties: { dataUrl, icon: "335" }
              }
            ]
          });
        }
        return new Response("not found", { status: 404 });
      })
    );

    const response = await request(app)
      .get("/api/v1/features?layers=weather_webcams&sources=chmi_weather_webcams&bbox=14.4,50,14.5,50.1")
      .expect(200);

    expect(response.body.features).toEqual([
      expect.objectContaining({
        id: "weather_webcam:wgs84_14p445358_50p007510",
        geometry: { type: "Point", coordinates: [14.445358, 50.00751] },
        properties: expect.objectContaining({
          layer: "weather_webcams",
          category: "weather_webcam",
          iconHint: "camera",
          rendering: { mode: "feature", geometryRole: "feature_geometry" },
          providerProperties: expect.objectContaining({
            camera: expect.objectContaining({
              detailUrl: "/api/v1/weather-cameras/wgs84_14p445358_50p007510",
              snapshotUrl: "/api/v1/weather-cameras/wgs84_14p445358_50p007510/snapshot",
              imagePayloadInFeatureStream: false
            }),
            copPresentation: expect.objectContaining({
              onClick: "open_custom_camera_preview"
            })
          })
        })
      })
    ]);
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
        }),
        expect.objectContaining({
          providerLayerId: "weather.chmi_webcams",
          recommendedCatalogLayerId: "public.weather.webcams",
          role: "reference",
          audience: "public",
          kind: "vector_features",
          selectable: true,
          sourceIds: ["chmi_weather_webcams"],
          readModel: expect.objectContaining({
            refreshedBy: "/api/v1/weather-cameras"
          }),
          legal: expect.objectContaining({
            notes: expect.arrayContaining([expect.stringContaining("click")])
          })
        }),
        expect.objectContaining({
          providerLayerId: "weather.temperature_grid",
          recommendedCatalogLayerId: "public.weather.temperature_grid",
          kind: "grid_field",
          labelLocalized: expect.objectContaining({ cs: "Teplota", en: "Temperature" }),
          delivery: expect.objectContaining({
            mode: "grid",
            stableGrid: expect.objectContaining({ alignment: "wgs84" })
          })
        }),
        expect.objectContaining({
          providerLayerId: "weather.precipitation_grid",
          recommendedCatalogLayerId: "public.weather.precipitation_grid",
          kind: "grid_field",
          legend: expect.objectContaining({ unit: "mm/10min" }),
          delivery: expect.objectContaining({ mode: "grid", geometryRole: "grid_cell", valueField: "metrics.value" })
        }),
        expect.objectContaining({
          providerLayerId: "weather.wind_field",
          recommendedCatalogLayerId: "public.weather.wind_field",
          kind: "vector_field",
          legend: expect.objectContaining({ unit: "m/s" })
        }),
        expect.objectContaining({
          providerLayerId: "air_quality.grid",
          recommendedCatalogLayerId: "public.safety.air_quality_grid",
          kind: "grid_field",
          sourceIds: ["chmi_air_quality"]
        }),
        expect.objectContaining({
          providerLayerId: "weather.radar_reflectivity",
          recommendedCatalogLayerId: "public.weather.radar_reflectivity",
          kind: "raster_overlay",
          sourceIds: ["chmi_weather_radar"],
          readModel: expect.objectContaining({
            refreshedBy: "/api/v1/weather-radar/frames"
          }),
          delivery: expect.objectContaining({
            mode: "raster_overlay",
            geometryRole: "raster_extent",
            doNotRenderGeometryFill: true,
            fallbackPolicy: "hide_if_raster_overlay_unsupported"
          })
        }),
        expect.objectContaining({
          providerLayerId: "weather.radar_precipitation",
          recommendedCatalogLayerId: "public.weather.radar_precipitation",
          kind: "raster_overlay",
          sourceIds: ["chmi_weather_radar"]
        }),
        expect.objectContaining({
          providerLayerId: "weather.thunderstorm_risk",
          recommendedCatalogLayerId: "public.safety.thunderstorm_risk",
          kind: "raster_overlay",
          sourceIds: ["chmi_weather_radar"],
          legal: expect.objectContaining({
            notes: expect.arrayContaining([expect.stringContaining("blesků")])
          })
        }),
        expect.objectContaining({
          providerLayerId: "boundary.region",
          recommendedCatalogLayerId: "public.boundary.region",
          role: "reference",
          sourceIds: ["osm_postgis"],
          readModel: expect.objectContaining({ table: "public.osm_admin_boundary" })
        }),
        expect.objectContaining({
          providerLayerId: "boundary.orp",
          recommendedCatalogLayerId: "public.boundary.orp",
          sourceIds: ["osm_postgis"]
        }),
        expect.objectContaining({
          providerLayerId: "place.settlements",
          recommendedCatalogLayerId: "public.place.settlements",
          sourceIds: ["osm_postgis"]
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
        }),
        expect.objectContaining({
          sourceId: "chmi_weather_stations",
          feedsCatalogLayerIds: expect.arrayContaining(["public.weather.observations", "public.weather.temperature_grid", "public.weather.wind_field"])
        }),
        expect.objectContaining({
          sourceId: "chmi_weather_radar",
          sourceRole: "final",
          selectableInMap: true,
          feedsCatalogLayerIds: expect.arrayContaining([
            "public.weather.radar_reflectivity",
            "public.weather.radar_precipitation",
            "public.weather.radar_nowcast",
            "public.safety.thunderstorm_risk"
          ])
        }),
        expect.objectContaining({
          sourceId: "chmi_weather_webcams",
          sourceRole: "final",
          selectableInMap: true,
          feedsLayerIds: ["weather.chmi_webcams"],
          feedsCatalogLayerIds: ["public.weather.webcams"]
        }),
        expect.objectContaining({
          sourceId: "chmi_air_quality",
          feedsCatalogLayerIds: expect.arrayContaining(["public.safety.air_quality", "public.safety.air_quality_grid"])
        }),
        expect.objectContaining({
          sourceId: "osm_postgis",
          feedsCatalogLayerIds: expect.arrayContaining(["public.boundary.country", "public.boundary.region", "public.boundary.district", "public.boundary.orp"])
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

  it("exposes lightweight summary, detail, geometry and taxonomy endpoints", async () => {
    const taxonomy = await request(app).get("/api/v1/taxonomy").expect(200);
    expect(taxonomy.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-provider-taxonomy-v1",
        providerId: "sim.situation-data",
        taxonomies: expect.arrayContaining([
          expect.objectContaining({
            taxonomyId: "sim.situation.layers",
            entries: expect.arrayContaining([
              expect.objectContaining({ layerId: "weather" }),
              expect.objectContaining({ layerId: "weather_webcams" }),
              expect.objectContaining({ layerId: "weather_radar_reflectivity" })
            ])
          }),
          expect.objectContaining({
            taxonomyId: "sim.situation.geometry_roles",
            entries: expect.arrayContaining([
              expect.objectContaining({ geometryRole: "feature_geometry" }),
              expect.objectContaining({ geometryRole: "raster_extent" })
            ])
          })
        ])
      })
    );

    const summary = await request(app).get("/api/v1/features/summary?layers=weather&source=mock&limit=1").expect(200);
    expect(summary.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-provider-feature-summary-v1",
        providerId: "sim.situation-data",
        summary: expect.objectContaining({ omittedGeometry: true }),
        features: [
          expect.objectContaining({
            featureId: "weather:mock:prague-west",
            layerId: "diagnostic.mock.weather",
            providerLayerId: "mock.weather",
            label: "Synthetic weather reference",
            geometrySummary: expect.objectContaining({ type: "Point", coordinateCount: 1, geometryRole: "feature_geometry" }),
            links: expect.objectContaining({
              detail: expect.stringContaining("/situation-data/api/v1/features/weather%3Amock%3Aprague-west?"),
              geometry: expect.stringContaining("/situation-data/api/v1/features/weather%3Amock%3Aprague-west/geometry?")
            })
          })
        ]
      })
    );
    expect(summary.body.features[0].links.detail).toContain("layers=weather");
    expect(summary.body.features[0].links.detail).toContain("source=mock");
    expect(summary.body.features[0]).not.toHaveProperty("geometry");

    const detail = await request(app).get("/api/v1/features/weather%3Amock%3Aprague-west?layers=weather&source=mock&limit=1").expect(200);
    expect(detail.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-provider-feature-detail-v1",
        providerId: "sim.situation-data",
        summary: expect.objectContaining({ featureId: "weather:mock:prague-west" }),
        properties: expect.objectContaining({
          label: "Synthetic weather reference",
          metrics: expect.objectContaining({ temperatureC: 18.2 })
        }),
        links: expect.objectContaining({
          geometry: expect.stringContaining("/situation-data/api/v1/features/weather%3Amock%3Aprague-west/geometry?")
        })
      })
    );
    expect(detail.body.properties.raw).toBeUndefined();

    const geometry = await request(app).get("/api/v1/features/weather%3Amock%3Aprague-west/geometry?layers=weather&source=mock&limit=1").expect(200);
    expect(geometry.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-provider-feature-geometry-v1",
        providerId: "sim.situation-data",
        featureId: "weather:mock:prague-west",
        resolution: "native",
        geometry: expect.objectContaining({ type: "Point", coordinates: expect.any(Array) }),
        geometrySummary: expect.objectContaining({ type: "Point", coordinateCount: 1, geometryRole: "feature_geometry" })
      })
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
          chmiWeatherRadar: 300,
          chmiWeatherWebcams: 300,
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
          expect.objectContaining({ sourceId: "chmi_weather_radar", authConfigured: true, backend: "chmi-opendata" }),
          expect.objectContaining({ sourceId: "chmi_weather_webcams", authConfigured: true, backend: "chmi-data-provider" }),
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

  it("exposes environment grid and boundary read-model observability", async () => {
    const response = await request(app).get("/api/v1/observability").expect(200);

    expect(response.body.environmentGrid).toEqual(
      expect.objectContaining({
        enabledLayers: expect.arrayContaining(["public.weather.temperature_grid", "public.weather.wind_field", "public.safety.air_quality_grid"]),
        stableGrid: expect.objectContaining({ alignment: "wgs84", resolutionDegrees: 0.05 }),
        readModel: expect.objectContaining({ mode: "catalog_only" })
      })
    );
    expect(response.body.boundaryReadModel).toEqual(
      expect.objectContaining({
        backend: "unconfigured",
        table: "public.osm_admin_boundary",
        layers: expect.arrayContaining(["public.boundary.country", "public.boundary.region", "public.boundary.orp"])
      })
    );
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

    const grid = await request(chmiApp.app)
      .get("/api/v1/features?bbox=14.0,49.8,14.8,50.3&layers=air_quality_grid&source=chmi_air_quality&limit=20")
      .expect(200);

    expect(grid.body.features).toHaveLength(1);
    expect(grid.body.features[0]).toEqual(
      expect.objectContaining({
        geometry: expect.objectContaining({ type: "Polygon" }),
        properties: expect.objectContaining({
          sourceId: "chmi_air_quality",
          layer: "air_quality_grid",
          layerId: "public.safety.air_quality_grid",
          providerLayerId: "air_quality.grid",
          category: "air_quality_cell",
          readModel: true,
          styleHint: "air-quality-grid-v1",
          metrics: expect.objectContaining({ airQualityIndex: 4, value: 4 }),
          providerProperties: expect.objectContaining({
            upstreamStationId: "APRA"
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
        return new Response(
          [
            '<a href="10m-0-20000-0-11518-20260528.json">10m-0-20000-0-11518-20260528.json</a>',
            '<a href="1h-0-20000-0-11518-20260528.json">1h-0-20000-0-11518-20260528.json</a>'
          ].join("\n"),
          {
            status: 200,
            headers: { "content-type": "text/html" }
          }
        );
      }
      if (url.endsWith("/meta1-20260528.json")) {
        return new Response(
          JSON.stringify({
            data: {
              data: {
                header: "WSI,GH_ID,FULL_NAME,GEOGR1,GEOGR2,ELEVATION,BEGIN_DATE",
                values: [["0-20000-0-11518", "ZIS11518", "Praha-Karlov", 14.4201234, 50.0805678, 260, "1900-01-01T00:00:00Z"]]
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
                  ["0-20000-0-11518", "SRA10M", "2026-05-28T08:00:00Z", 0, "", 5],
                  ["0-20000-0-11518", "SSV10M", "2026-05-28T08:00:00Z", 0, "", 5]
                ]
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/1h-0-20000-0-11518-20260528.json")) {
        return new Response(
          JSON.stringify({
            data: {
              data: {
                header: "STATION,ELEMENT,DT,VAL,FLAG,QUALITY",
                values: [
                  ["0-20000-0-11518", "ww", "2026-05-28T08:00:00Z", 61, "", 5],
                  ["0-20000-0-11518", "N", "2026-05-28T08:00:00Z", 8, "", 5],
                  ["0-20000-0-11518", "VV", "2026-05-28T08:00:00Z", 30, "", 5],
                  ["0-20000-0-11518", "SRA1H", "2026-05-28T08:00:00Z", 1.2, "", 5],
                  ["0-20000-0-11518", "SSV1H", "2026-05-28T08:00:00Z", 0, "", 5]
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

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(first.body.features).toHaveLength(1);
    expect(second.body.features).toHaveLength(1);
    expect(first.body.features[0].geometry).toEqual({ type: "Point", coordinates: [14.4201234, 50.0805678] });
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
            precipitation10mMm: 0,
            precipitation1hMm: 1.2,
            presentWeatherCode: 61,
            normalizedPresentWeatherCode: 61,
            cloudCoverOctas: 8,
            cloudCoverPercent: 100
          }),
          tags: expect.objectContaining({ stationId: "0-20000-0-11518", ghId: "ZIS11518" }),
          providerProperties: expect.objectContaining({
            weatherSymbolKey: "rain",
            weatherConditionLabel: "déšť",
            weather: expect.objectContaining({
              symbolKey: "rain",
              conditionLabel: "déšť",
              authoritativeCondition: true,
              conditionMode: "observed",
              basis: "chmi_1h_present_weather",
              sourceInputs: ["chmi_1h:ww"],
              presentWeatherCode: 61,
              normalizedPresentWeatherCode: 61,
              cloudCoverOctas: 8,
              cloudCoverPercent: 100
            }),
            presentation: expect.objectContaining({
              primaryValue: "17.2 °C",
              secondaryValue: "1.2 mm/h",
              mapLabel: "Praha-Karlov 17.2 °C · 1.2 mm/h"
            }),
            raw: expect.objectContaining({ station: expect.any(Object), hourlyObservations: expect.any(Object) })
          })
        })
      })
    );

    const grid = await request(chmiApp.app)
      .get(
        "/api/v1/features?bbox=14.0,49.8,14.8,50.3&layers=weather_temperature_grid,weather_wind_field,weather_precipitation_grid,weather_humidity_grid&source=chmi_weather_stations&limit=20"
      )
      .expect(200);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(grid.body.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          geometry: expect.objectContaining({ type: "Polygon" }),
          properties: expect.objectContaining({
            sourceId: "chmi_weather_stations",
            layer: "weather_temperature_grid",
            layerId: "public.weather.temperature_grid",
            providerLayerId: "weather.temperature_grid",
            readModel: true,
            styleHint: "weather-temperature-grid-v1",
            metrics: expect.objectContaining({ temperatureC: 17.2, value: 17.2 }),
            rendering: expect.objectContaining({ mode: "grid_field", geometryRole: "grid_cell", valueMetric: "temperatureC" }),
            tags: expect.objectContaining({ geometryRole: "grid_cell", renderAs: "grid_field", valueMetric: "temperatureC" }),
            providerProperties: expect.objectContaining({
              geometryRole: "grid_cell",
              renderAs: "grid_field",
              valueMetric: "temperatureC",
              interpolationMethod: "station_backed_nearest_cell"
            })
          })
        }),
        expect.objectContaining({
          geometry: expect.objectContaining({ type: "LineString" }),
          properties: expect.objectContaining({
            sourceId: "chmi_weather_stations",
            layer: "weather_wind_field",
            layerId: "public.weather.wind_field",
            providerLayerId: "weather.wind_field",
            readModel: true,
            styleHint: "weather-wind-field-v1",
            metrics: expect.objectContaining({ windSpeedMps: 4.2, windDirectionDeg: 270 })
          })
        }),
        expect.objectContaining({
          geometry: expect.objectContaining({ type: "Polygon" }),
          properties: expect.objectContaining({
            layer: "weather_precipitation_grid",
            layerId: "public.weather.precipitation_grid",
            providerLayerId: "weather.precipitation_grid",
            metrics: expect.objectContaining({ precipitation10mMm: 0, value: 0, unit: "mm/10min" }),
            rendering: expect.objectContaining({ mode: "grid_field", geometryRole: "grid_cell", valueMetric: "precipitation10mMm", unit: "mm/10min" })
          })
        }),
        expect.objectContaining({
          geometry: expect.objectContaining({ type: "Polygon" }),
          properties: expect.objectContaining({
            layer: "weather_humidity_grid",
            layerId: "public.weather.humidity_grid",
            providerLayerId: "weather.humidity_grid",
            metrics: expect.objectContaining({ relativeHumidityPercent: 63, value: 63 })
          })
        })
      ])
    );
  });

  it("estimates CHMI station weather presentation from measured sunshine when hourly state is unavailable", async () => {
    const testConfig = {
      ...config,
      chmiWeatherMetadataBaseUrl: "https://example.test/chmi/weather/metadata/",
      chmiWeatherDataBaseUrl: "https://example.test/chmi/weather/data/"
    };
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url === testConfig.chmiWeatherMetadataBaseUrl) {
        return new Response('<a href="meta1-20260528.json">meta1-20260528.json</a>', {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (url === testConfig.chmiWeatherDataBaseUrl) {
        return new Response('<a href="10m-0-20000-0-11519-20260528.json">10m-0-20000-0-11519-20260528.json</a>', {
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
                values: [["0-20000-0-11519", "ZIS11519", "Test sunshine", 14.5, 50.1, 250, "1900-01-01T00:00:00Z"]]
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/10m-0-20000-0-11519-20260528.json")) {
        return new Response(
          JSON.stringify({
            data: {
              data: {
                header: "STATION,ELEMENT,DT,VAL,FLAG,QUALITY",
                values: [
                  ["0-20000-0-11519", "T", "2026-05-28T08:00:00Z", 20.1, "", 5],
                  ["0-20000-0-11519", "H", "2026-05-28T08:00:00Z", 55, "", 5],
                  ["0-20000-0-11519", "F", "2026-05-28T08:00:00Z", 2.1, "", 5],
                  ["0-20000-0-11519", "SRA10M", "2026-05-28T08:00:00Z", 0, "", 5],
                  ["0-20000-0-11519", "SSV10M", "2026-05-28T08:00:00Z", 300, "", 5]
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
    const chmiApp = await createApp({ ...testConfig, enabledSources: ["chmi_weather_stations"] });

    const response = await request(chmiApp.app)
      .get("/api/v1/features?bbox=14.0,49.8,14.8,50.3&layers=weather&source=chmi_weather_stations&limit=20")
      .expect(200);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(response.body.features).toHaveLength(1);
    expect(response.body.features[0].properties.providerProperties).toEqual(
      expect.objectContaining({
        weatherSymbolKey: "partly_cloudy",
        weatherConditionLabel: "sluneční svit / proměnlivá oblačnost",
        weatherConditionMode: "estimated",
        weather: expect.objectContaining({
          symbolKey: "partly_cloudy",
          basis: "measured_sunshine_duration_partial",
          conditionMode: "estimated",
          authoritativeCondition: false,
          confidence: 0.6,
          sourceInputs: ["chmi_10m:SSV10M"]
        })
      })
    );
  });

  it("exposes CHMI radar overlay and thunderstorm context metadata", async () => {
    const radarIndex = (names: string[]) => `<html><body><pre>${names.map((name) => `<a href="${name}">${name}</a>`).join("\n")}</pre></body></html>`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const indexes: Record<string, string> = {
        "/maxz/png/": radarIndex(["pacz2gmaps3.z_max3d.20260604.2115.0.png", "pacz2gmaps3.z_max3d.20260604.2120.0.png"]),
        "/maxz/hdf5/": radarIndex(["T_PABV23_C_OKPR_20260604211500.hdf", "T_PABV23_C_OKPR_20260604212000.hdf"]),
        "/pseudocappi2km/png/": radarIndex(["pacz2gmaps3.z_cappi020.20260604.2115.0.png", "pacz2gmaps3.z_cappi020.20260604.2120.0.png"]),
        "/pseudocappi2km/hdf5/": radarIndex(["T_PANV23_C_OKPR_20260604211500.hdf", "T_PANV23_C_OKPR_20260604212000.hdf"]),
        "/merge1h/png/": radarIndex(["pacz2gmaps3.merge.20260604.2110.60.png", "pacz2gmaps3.merge.20260604.2120.60.png"]),
        "/merge1h/hdf5/": radarIndex(["T_PASV23_C_OKPR_20260604211000.hdf", "T_PASV23_C_OKPR_20260604212000.hdf"]),
        "/fct_maxz/png/": radarIndex(["pacz2gmaps3.fct_z_max.20260604.2115.ft60s10.tar", "pacz2gmaps3.fct_z_max.20260604.2120.ft60s10.tar"]),
        "/fct_pseudocappi2km/png/": radarIndex(["pacz2gmaps3.fct_z_cappi020.20260604.2115.ft60s10.tar", "pacz2gmaps3.fct_z_cappi020.20260604.2120.ft60s10.tar"]),
        "/maxz/png_masked/": radarIndex(["pacz2gmaps3.z_max3d.20260604.2115.0.png", "pacz2gmaps3.z_max3d.20260604.2120.0.png"]),
        "/echotop/hdf5/": radarIndex(["T_PADV23_C_OKPR_20260604211500.hdf", "T_PADV23_C_OKPR_20260604212000.hdf"])
      };
      const match = Object.entries(indexes).find(([suffix]) => url.endsWith(suffix));
      if (match) {
        return new Response(match[1], { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const radarApp = await createApp({ ...config, enabledSources: ["chmi_weather_radar"] });

    const response = await request(radarApp.app)
      .get(
        "/api/v1/features?bbox=12.0,48.5,19.0,51.2&layers=weather_radar_reflectivity,weather_radar_precipitation,weather_radar_nowcast,weather_thunderstorm_risk&source=chmi_weather_radar&limit=20"
      )
      .expect(200);

    expect(response.body.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          geometry: expect.objectContaining({ type: "Polygon" }),
          properties: expect.objectContaining({
            layer: "weather_radar_reflectivity",
            layerId: "public.weather.radar_reflectivity",
            providerLayerId: "weather.radar_reflectivity",
            category: "weather_radar_reflectivity",
            sourceId: "chmi_weather_radar",
            sourceRevision: "pacz2gmaps3.z_max3d.20260604.2120.0.png",
            rendering: expect.objectContaining({
              mode: "raster_overlay",
              geometryRole: "raster_extent",
              doNotRenderGeometryFill: true,
              fallbackPolicy: "hide_if_raster_overlay_unsupported"
            }),
            tags: expect.objectContaining({
              geometryRole: "raster_extent",
              renderAs: "raster_overlay",
              doNotRenderGeometryFill: "true",
              sourceImageMayContainFrame: "true",
              sourceImageMayContainEmbeddedLabels: "true"
            }),
            providerProperties: expect.objectContaining({
              geometryRole: "raster_extent",
              renderAs: "raster_overlay",
              doNotRenderGeometryFill: true,
              raster: expect.objectContaining({
                url: expect.stringContaining("pacz2gmaps3.z_max3d.20260604.2120.0.png"),
                rawUrl: expect.stringContaining("pacz2gmaps3.z_max3d.20260604.2120.0.png"),
                boundsWgs84: [11.267, 48.047, 19.624, 51.458],
                sourceBoundsWgs84: [11.267, 48.047, 20.77, 52.167],
                dataBoundsWgs84: [11.267, 48.047, 19.624, 51.458],
                sourceImageMayContainFrame: true,
                sourceImageMayContainEmbeddedLabels: true,
                cleanRasterAvailable: true,
                cleanMethod: "server_crop_to_data_bounds",
                frameCatalogUrl: "/api/v1/weather-radar/frames?product=maxz",
                renderMode: "clean_image_overlay"
              }),
              hdf5: expect.objectContaining({
                url: expect.stringContaining("T_PABV23_C_OKPR_20260604212000.hdf")
              })
            })
          })
        }),
        expect.objectContaining({
          properties: expect.objectContaining({
            layer: "weather_radar_precipitation",
            layerId: "public.weather.radar_precipitation",
            providerLayerId: "weather.radar_precipitation"
          })
        }),
        expect.objectContaining({
          properties: expect.objectContaining({
            layer: "weather_radar_nowcast",
            layerId: "public.weather.radar_nowcast",
            providerLayerId: "weather.radar_nowcast",
            providerProperties: expect.objectContaining({
              raster: expect.objectContaining({
                archiveUrl: expect.stringContaining("pacz2gmaps3.fct_z_max.20260604.2120.ft60s10.tar"),
                renderMode: "archive_sequence"
              })
            })
          })
        }),
        expect.objectContaining({
          properties: expect.objectContaining({
            layer: "weather_thunderstorm_risk",
            layerId: "public.safety.thunderstorm_risk",
            providerLayerId: "weather.thunderstorm_risk",
            tags: expect.objectContaining({ lightningStrikeFeed: "false" }),
            providerProperties: expect.objectContaining({
              lightningStrikeFeed: false,
              sourceLimitation: expect.stringContaining("No redistributable official raw lightning-strike feed")
            })
          })
        })
      ])
    );
    expect(response.body.summary.featureCount).toBe(6);
    expect(fetchMock).toHaveBeenCalledTimes(10);
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

  it("projects OSM PostGIS administrative boundaries as provider catalog layers", async () => {
    const source = new OsmPostgisSource({
      ...config,
      enabledSources: ["osm_postgis"],
      osmPostgisConnectionString: "postgresql://sim_osm:secret@example.test:5432/sim_osm",
      osmPostgisBackend: "external-postgis"
    });
    (source as unknown as { fetchAdminBoundaryRows: () => Promise<unknown[]> }).fetchAdminBoundaryRows = async () => [
      {
        osm_id: "442314",
        admin_level: 4,
        name: "Středočeský kraj",
        code: "CZ-20",
        country_code: "CZ",
        source: "osm_postgis",
        geometry_geojson: {
          type: "MultiPolygon",
          coordinates: [[[[14.1, 49.8], [14.8, 49.8], [14.8, 50.3], [14.1, 50.3], [14.1, 49.8]]]]
        },
        tags: { "name:en": "Central Bohemian Region", "name:cs": "Středočeský kraj" },
        imported_at: "2026-05-28T08:00:00.000Z"
      }
    ];
    (source as unknown as { fetchRows: () => Promise<unknown[]> }).fetchRows = async () => [];

    const result = await source.fetchFeatures({
      bbox: { west: 14.0, south: 49.7, east: 15.0, north: 50.4 },
      layers: ["boundary_region"],
      sourceIds: ["osm_postgis"],
      limit: 20,
      includeRaw: true
    });

    expect(result.features).toHaveLength(1);
    expect(result.features[0]).toEqual(
      expect.objectContaining({
        id: expect.stringContaining("boundary_region:osm_postgis:boundary"),
        geometry: expect.objectContaining({ type: "MultiPolygon" }),
        properties: expect.objectContaining({
          layer: "boundary_region",
          sourceId: "osm_postgis",
          category: "admin_boundary",
          labelLocalized: expect.objectContaining({ cs: "Středočeský kraj", en: "Central Bohemian Region" }),
          dataQuality: "observed",
          adminLevel: 4,
          code: "CZ-20",
          countryCode: "CZ",
          readModel: true,
          basis: expect.arrayContaining(["osm_postgis_admin_boundary"])
        })
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

  it("exposes radio planning profiles and persists custom profiles", async () => {
    const catalog = await request(app).get("/api/v1/radio/profiles").expect(200);
    expect(catalog.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-radio-profile-catalog-v1",
        profiles: expect.arrayContaining([
          expect.objectContaining({ profileId: "pmr446_handheld", category: "civil" }),
          expect.objectContaining({ profileId: "ham_145_handheld", category: "amateur" }),
          expect.objectContaining({ profileId: "tetra_handheld", category: "public_safety" }),
          expect.objectContaining({ profileId: "mil_vhf_manpack", category: "military_generic", sensitiveUse: true })
        ]),
        warnings: expect.arrayContaining([expect.stringContaining("Military profiles")])
      })
    );

    const created = await request(app)
      .post("/api/v1/radio/profiles")
      .send({
        profileId: "custom_test_radio",
        name: "Custom test radio",
        category: "business",
        frequencyMhz: 170,
        txPowerW: 10,
        antennaHeightM: 4,
        receiverHeightM: 1.5,
        maxRadiusM: 12000
      })
      .expect(201);
    expect(created.body).toEqual(
      expect.objectContaining({
        profileId: "custom_test_radio",
        source: "custom",
        frequencyMhz: 170,
        maxRadiusM: 12000
      })
    );

    const updatedCatalog = await request(app).get("/api/v1/radio/profiles").expect(200);
    expect(updatedCatalog.body.profiles).toEqual(expect.arrayContaining([expect.objectContaining({ profileId: "custom_test_radio" })]));
  });

  it("runs radio link-check, coverage and site-search without DEM", async () => {
    const link = await request(app)
      .post("/api/v1/radio/link-check")
      .send({
        profileId: "pmr446_handheld",
        radioName: "PMR tým A",
        from: { lon: 14.42, lat: 50.08, antennaHeightM: 1.5 },
        to: { lon: 14.425, lat: 50.085, receiverHeightM: 1.5 }
      })
      .expect(200);
    expect(link.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-radio-link-check-v1",
        profile: expect.objectContaining({ profileId: "pmr446_handheld" }),
        result: expect.objectContaining({
          linkStatus: expect.stringMatching(/marginal|unknown|clear|obstructed/),
          quality: expect.stringMatching(/good|fair|weak|none|unknown/),
          terrainApplied: false,
          distanceM: expect.any(Number),
          azimuthDeg: expect.any(Number)
        }),
        warnings: expect.arrayContaining([expect.stringContaining("DEM is not enabled")])
      })
    );

    const coverage = await request(app)
      .post("/api/v1/radio/coverage")
      .send({
        profileId: "pmr446_handheld",
        station: { lon: 14.42, lat: 50.08, antennaHeightM: 1.5 },
        radiusM: 500,
        azimuthStepDeg: 90,
        distanceStepM: 250
      })
      .expect(200);
    expect(coverage.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-radio-coverage-v1",
        type: "FeatureCollection",
        profile: expect.objectContaining({ profileId: "pmr446_handheld" }),
        summary: expect.objectContaining({ featureCount: 8, terrainApplied: false }),
        features: expect.arrayContaining([
          expect.objectContaining({
            geometry: expect.objectContaining({ type: "Polygon" }),
            properties: expect.objectContaining({
              analysisLayer: "radio_coverage",
              category: "radio_coverage_sector",
              profileId: "pmr446_handheld",
              quality: expect.stringMatching(/good|fair|weak|none|unknown/)
            })
          })
        ])
      })
    );

    const siteSearch = await request(app)
      .post("/api/v1/radio/site-search")
      .send({
        profileId: "pmr446_handheld",
        searchArea: { bbox: [14.418, 50.078, 14.424, 50.084] },
        targets: [{ lon: 14.425, lat: 50.085, receiverHeightM: 1.5 }],
        gridStepM: 500,
        maxCandidates: 3
      })
      .expect(200);
    expect(siteSearch.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-radio-site-search-v1",
        type: "FeatureCollection",
        profile: expect.objectContaining({ profileId: "pmr446_handheld" }),
        summary: expect.objectContaining({
          returnedCandidateCount: expect.any(Number),
          terrainApplied: false
        }),
        features: expect.arrayContaining([
          expect.objectContaining({
            geometry: expect.objectContaining({ type: "Point" }),
            properties: expect.objectContaining({
              analysisLayer: "radio_site_search",
              category: "radio_site_candidate",
              rank: expect.any(Number),
              score: expect.any(Number)
            })
          })
        ])
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

  it("builds per-tower mobile coverage viewshed sectors", async () => {
    const source = new MobileCoverageSource({
      ...config,
      enabledSources: ["mobile_coverage_model"],
      osmPostgisConnectionString: "postgresql://sim_osm:secret@example.test:5432/sim_osm",
      osmPostgisBackend: "external-postgis",
      mobileCoverageModelVersion: "coverage-v2-terrain"
    });
    (source as unknown as { fetchTowerById: () => Promise<{ id: string; name: string; lon: number; lat: number; operator: string }> }).fetchTowerById =
      async () => ({ id: "node:1", name: "Test tower", lon: 14.42, lat: 50.08, operator: "unknown" });

    const result = await source.buildTowerViewshed({
      towerId: "node:1",
      technology: "4G",
      radiusM: 1000,
      azimuthStepDeg: 90,
      distanceStepM: 500
    });

    expect(result).toEqual(
      expect.objectContaining({
        contractVersion: "sim-mobile-coverage-tower-viewshed-v1",
        type: "FeatureCollection",
        tower: expect.objectContaining({
          towerId: "node:1",
          btsStatus: "operator_feed_unavailable",
          operatorStatusAvailable: false
        }),
        query: expect.objectContaining({
          technology: "4G",
          radiusM: 1000,
          azimuthStepDeg: 90,
          distanceStepM: 500
        }),
        summary: expect.objectContaining({
          featureCount: 8,
          terrainApplied: false,
          disclaimer: expect.stringContaining("estimate")
        })
      })
    );
    expect(result?.features).toHaveLength(8);
    expect(result?.features[0]).toEqual(
      expect.objectContaining({
        geometry: expect.objectContaining({ type: "Polygon" }),
        properties: expect.objectContaining({
          layer: "mobile_coverage",
          category: "mobile_coverage_viewshed",
          sourceId: "mobile_coverage_model",
          technology: "4G",
          quality: expect.stringMatching(/good|fair|weak|none/),
          modelVersion: "coverage-v2-terrain+tower-viewshed-v1",
          sourceRevision: expect.stringContaining("viewshed=tower-radial-v1"),
          dataQuality: "modelled",
          btsStatus: "operator_feed_unavailable",
          operatorStatusAvailable: false,
          disclaimer: expect.stringContaining("estimate")
        })
      })
    );
  });

  it("exposes a per-tower mobile coverage viewshed endpoint for COP detail overlays", async () => {
    const coverageApp = await createApp({
      ...config,
      enabledSources: ["mobile_coverage_model"],
      osmPostgisConnectionString: "postgresql://sim_osm:secret@example.test:5432/sim_osm",
      osmPostgisBackend: "external-postgis"
    });
    vi.spyOn(coverageApp.context.mobileCoverage, "buildTowerViewshed").mockResolvedValue({
      contractVersion: "sim-mobile-coverage-tower-viewshed-v1",
      type: "FeatureCollection",
      generatedAt: "2026-06-27T00:00:00.000Z",
      source: {
        sourceId: "mobile_coverage_model",
        sourceType: "MODELLED_BTS_VIEWSHED",
        generatedAt: "2026-06-27T00:00:00.000Z"
      },
      tower: {
        towerId: "node:1",
        lon: 14.42,
        lat: 50.08,
        btsStatus: "operator_feed_unavailable",
        btsStatusSource: "none",
        operatorStatusAvailable: false
      },
      query: {
        technology: "4G",
        radiusM: 1000,
        azimuthStepDeg: 90,
        distanceStepM: 500,
        antennaHeightM: 30,
        receiverHeightM: 1.5
      },
      summary: {
        featureCount: 1,
        qualityCounts: { good: 1, fair: 0, weak: 0, none: 0, unknown: 0 },
        terrainAware: false,
        terrainApplied: false,
        demSource: "not-used-phase-1",
        warningCount: 0,
        disclaimer: "Coverage is an estimate, not guaranteed service availability."
      },
      features: [],
      warnings: []
    });

    const response = await request(coverageApp.app)
      .get("/api/v1/mobile-coverage/towers/node:1/viewshed?technology=4G&radiusM=1000&azimuthStepDeg=90&distanceStepM=500")
      .expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-mobile-coverage-tower-viewshed-v1",
        source: expect.objectContaining({ sourceId: "mobile_coverage_model" }),
        tower: expect.objectContaining({ towerId: "node:1" }),
        query: expect.objectContaining({ technology: "4G", radiusM: 1000 })
      })
    );
    expect(coverageApp.context.mobileCoverage.buildTowerViewshed).toHaveBeenCalledWith(
      expect.objectContaining({
        towerId: "node:1",
        technology: "4G",
        radiusM: 1000,
        azimuthStepDeg: 90,
        distanceStepM: 500
      })
    );
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
                demSource: "not-used-phase-1",
                readModel: true
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

  it("does not synthesize a mobile network bbox polygon when coverage read-model cells are missing", async () => {
    const source = new MobileNetworkSource({
      ...config,
      enabledSources: ["mobile_network_model"],
      osmPostgisConnectionString: "postgresql://sim_osm:secret@example.test:5432/sim_osm",
      osmPostgisBackend: "external-postgis",
      mobileCoverageResolutionM: 500,
      mobileCoverageMaxCells: 16
    });
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
      async fetchFeatures() {
        return {
          source: this.descriptor,
          fetchedAt: new Date().toISOString(),
          warnings: [],
          features: [
            {
              type: "Feature",
              id: "coverage:mobile:5g:runtime",
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
                featureId: "coverage:mobile:5g:runtime",
                layer: "mobile_coverage",
                category: "mobile_coverage",
                label: "5G runtime coverage estimate",
                sourceId: "mobile_coverage_model",
                observedAt: new Date().toISOString(),
                confidence: 0.42,
                stale: false,
                severity: "info",
                license: { name: "coverage", attribution: "coverage" },
                operator: "unknown",
                technology: "5G",
                quality: "fair",
                modelVersion: "coverage-v1",
                readModel: false,
                dataQuality: "modelled"
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
      includeRaw: false,
      mobileCoverageTechnologies: ["5G"]
    });

    expect(result.features).toHaveLength(0);
    expect(result.warnings).toEqual(expect.arrayContaining([
      "mobile_network_model ignored coverage polygons that were not backed by a prepared read-model.",
      "mobile_network_model has no prepared read-model coverage cells in the requested area; no synthetic bbox polygon was generated.",
      "CTU measurements are available only as point features in their own sources; mobile_network_model did not convert them to an area polygon."
    ]));
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
