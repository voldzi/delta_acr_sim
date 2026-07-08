import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import gtfsRealtime from "gtfs-realtime-bindings";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SituationAggregationService } from "../src/aggregation.js";
import { createApp } from "../src/app.js";
import { CommunityContextSource } from "../src/community-context-source.js";
import type { SituationDataConfig } from "../src/config.js";
import { MobileCoverageSource } from "../src/mobile-coverage-source.js";
import { OsmPostgisSource } from "../src/osm-postgis-source.js";
import type { SharedResponseCacheStore } from "../src/response-cache.js";
import { spatiallyLimitFeatures } from "../src/spatial-limit.js";
import { MobileNetworkSource, type SituationDataSource } from "../src/sources.js";
import type { SituationFeature } from "../src/types.js";

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
      metNorwayBaseUrl: "https://api.met.no",
      metNorwayCacheTtlSeconds: 600,
      metNorwayUserAgent: "csm-sim-test/0.1 contact:test@example.invalid",
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
      osmPostgisTrailRoutesTable: "public.osm_trail_routes",
      osmPostgisTrailPoiTable: "public.osm_trail_poi",
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
      pidGtfsRtTripUpdatesUrl: "https://api.golemio.cz/v2/vehiclepositions/gtfsrt/trip_updates.pb",
      pidGtfsStaticUrl: "https://data.pid.cz/PID_GTFS.zip",
      pidGtfsStaticCacheTtlSeconds: 21600,
      publicTransitStaticGtfsFeeds: [
        { systemId: "pid", label: "PID statický GTFS", url: "https://example.test/pid/PID_GTFS.zip" },
        { systemId: "idsjmk", label: "IDS JMK statický GTFS", url: "https://example.test/idsjmk/gtfs.zip" },
        { systemId: "dpmo", label: "DPMO Olomouc statický GTFS", url: "https://example.test/dpmo/dpmo-olomouc-cz.zip" },
        { systemId: "pmdp", label: "PMDP Plzeň statický GTFS", url: "https://example.test/pmdp/gtfs" },
        { systemId: "dpmlj", label: "DPMLJ Liberec/Jablonec statický GTFS", url: "https://example.test/dpmlj/gtfs.zip" }
      ],
      publicTransitStaticGeojsonFeeds: [
        {
          systemId: "dpo_ostrava",
          label: "DPO Ostrava zastávky MHD GeoJSON",
          url: "https://example.test/ostrava/zastavky_MHD_WGS84_gjson.zip"
        }
      ],
      publicTransitStaticCacheTtlSeconds: 21600,
      publicTransitStaticMaxStops: 60000,
      idsjmkVehiclePositionsUrl: "https://example.test/idsjmk/vehicles.json",
      idsjmkVehiclePositionsCacheTtlSeconds: 20,
      spravaZeleznicTrainPositionsUrl: "https://example.test/spravazeleznic/request2.php?module=Layers%5COsVlaky&action=load2",
      spravaZeleznicTrainPositionsCacheTtlSeconds: 900,
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
      publicCameraFeeds: [],
      ardosPartnerBaseUrl: undefined,
      ardosPartnerToken: undefined,
      ardosPartnerCacheTtlSeconds: 15,
      searchDataCacheTtlSeconds: 300,
      searchDataCacheMaxEntries: 256,
      searchDataMaxLimit: 5000,
      routingCacheTtlSeconds: 300,
      routingCacheMaxEntries: 512,
      routingOsmRoadsTable: "public.osm_roads",
      routingMaxGraphEdges: 45000,
      routingMaxSearchRadiusM: 160000,
      routingMaxSnapDistanceM: 2500,
      radioPlanningCacheTtlSeconds: 900,
      radioPlanningCacheMaxEntries: 512,
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
        expect.objectContaining({ layerId: "weather_forecast_area", defaultVisible: false }),
        expect.objectContaining({ layerId: "weather_radar_reflectivity", defaultVisible: false }),
        expect.objectContaining({ layerId: "weather_thunderstorm_risk", defaultVisible: false }),
        expect.objectContaining({ layerId: "weather_webcams", defaultVisible: false }),
        expect.objectContaining({ layerId: "outdoor_webcams", defaultVisible: false }),
        expect.objectContaining({ layerId: "air_quality_grid", defaultVisible: false }),
        expect.objectContaining({ layerId: "community_places", defaultVisible: false }),
        expect.objectContaining({ layerId: "community_reports", defaultVisible: false })
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
          license: expect.objectContaining({ name: "Open-Meteo + MET Norway / CC BY 4.0" })
        }),
        expect.objectContaining({
          sourceId: "weather_forecast",
          layers: expect.arrayContaining(["weather_forecast_area"])
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
          layers: expect.arrayContaining([
            "ground",
            "mobile",
            "boundary_country",
            "boundary_region",
            "boundary_district",
            "boundary_orp",
            "place_settlements",
            "trail_routes",
            "trail_poi"
          ]),
          license: expect.objectContaining({ name: "ODbL 1.0" })
        }),
        expect.objectContaining({
          sourceId: "community_context",
          layers: expect.arrayContaining(["community_places"]),
          mode: "reference"
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
          sourceId: "public_transit_static",
          layers: expect.arrayContaining(["traffic"]),
          mode: "reference"
        }),
        expect.objectContaining({
          sourceId: "idsjmk_vehicle_positions",
          layers: expect.arrayContaining(["traffic"])
        }),
        expect.objectContaining({
          sourceId: "spravazeleznic_trains",
          layers: expect.arrayContaining(["traffic"]),
          updateCadenceSeconds: 900
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
          layers: expect.arrayContaining(["weather_webcams", "outdoor_webcams"])
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

  it("aggregates direct origin public camera feeds behind the weather camera contract", async () => {
    const feedUrl = "https://geoportal.example.test/arcgis/rest/services/kamery/MapServer/0/query?f=geojson";
    const snapshotUrl = "https://www.lavdis.example.test/public/files/cameras/Lovosice_kamera_1/last_photo.jpg";
    config.publicCameraFeeds = [
      [
        "sps_lavdis_cameras",
        "Státní plavební správa / LAVDIS kamery",
        "waterway",
        "Státní plavební správa",
        "https://www.lavdis.cz/",
        "arcgis_lavdis",
        feedUrl
      ].join("|")
    ];
    ({ app } = await createApp(config));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === feedUrl) {
          return jsonResponse({
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                id: 1,
                geometry: { type: "Point", coordinates: [14.073064592573621, 50.514826112597] },
                properties: {
                  OBJECTID: 1,
                  nazev_lok: "Lovosice",
                  nazev_kam: "kamera1",
                  kamera_link: snapshotUrl
                }
              },
              {
                type: "Feature",
                id: 2,
                geometry: { type: "Point", coordinates: [14.073064592573621, 50.514826112597] },
                properties: {
                  OBJECTID: 2,
                  nazev_lok: "Lovosice",
                  nazev_kam: "kamera2",
                  kamera_link: "https://www.lavdis.example.test/public/files/cameras/Lovosice_kamera_2/last_photo.jpg"
                }
              }
            ]
          });
        }
        if (url === snapshotUrl) {
          return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
            status: 200,
            headers: { "content-type": "image/jpeg", "content-length": "4" }
          });
        }
        return new Response("not found", { status: 404 });
      })
    );

    const catalog = await request(app).get("/api/v1/weather-cameras?bbox=14,50.4,14.2,50.6").expect(200);
    expect(catalog.body.locations).toEqual([
      expect.objectContaining({
        label: "Lovosice",
        originSourceId: "sps_lavdis_cameras",
        originAuthority: "Státní plavební správa",
        snapshotAvailable: true
      })
    ]);

    const detail = await request(app).get(catalog.body.locations[0].detailUrl).expect(200);
    expect(detail.body.cameras).toHaveLength(2);
    expect(detail.body.cameras[0]).toEqual(
      expect.objectContaining({
        name: "Lovosice kamera1",
        snapshotAvailable: true
      })
    );

    const snapshot = await request(app).get(detail.body.cameras[0].snapshotUrl).expect(200);
    expect(snapshot.headers["content-type"]).toContain("image/jpeg");
    expect(snapshot.body).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });

  it("accepts curated static origin camera feeds without exposing image payloads in feature streams", async () => {
    const feedUrl = "https://camera-origin.example.test/public-webcams.json";
    const snapshotUrl = "https://camera-origin.example.test/ostrava/slezska/latest.jpg";
    config.enabledSources = ["chmi_weather_webcams"];
    config.publicCameraFeeds = [
      [
        "curated_public_webcams",
        "Kurátorované origin webkamery",
        "city",
        "Ověřený origin provozovatel",
        "https://camera-origin.example.test/",
        "static_json",
        feedUrl
      ].join("|")
    ];
    ({ app } = await createApp(config));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === feedUrl) {
          return jsonResponse({
            sourceId: "webcamlive_origin_review",
            label: "Ověřené origin kamery z WebCamLive auditu",
            authority: "Statutární město Ostrava",
            attribution: "Statutární město Ostrava; origin ověřen přes WebCamLive audit",
            providerPageUrl: "https://www.ostrava.cz/",
            category: "city",
            locations: [
              {
                locationId: "ostrava_slezska_ostrava",
                label: "Ostrava - Slezská Ostrava",
                lon: 18.29291,
                lat: 49.83928,
                providerPageUrl: "https://miksa.cz/",
                sourceDataUrl: "https://miksa.cz/",
                cameras: [
                  {
                    cameraId: "slezska_ostrava",
                    name: "Slezská Ostrava",
                    providerUrl: "https://miksa.cz/",
                    directImageUrl: snapshotUrl,
                    contentType: "image/jpeg"
                  }
                ]
              }
            ]
          });
        }
        if (url === snapshotUrl) {
          return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
            status: 200,
            headers: { "content-type": "image/jpeg", "content-length": "4" }
          });
        }
        return new Response("not found", { status: 404 });
      })
    );

    const response = await request(app)
      .get("/api/v1/features?layers=weather_webcams&sources=chmi_weather_webcams&bbox=18.2,49.8,18.4,49.9&includeRaw=false")
      .expect(200);

    expect(response.body.features).toEqual([
      expect.objectContaining({
        id: "weather_webcam:ostrava_slezska_ostrava",
        geometry: { type: "Point", coordinates: [18.29291, 49.83928] },
        properties: expect.objectContaining({
          sourceId: "chmi_weather_webcams",
          iconHint: "camera",
          providerProperties: expect.objectContaining({
            camera: expect.objectContaining({
              originSourceId: "webcamlive_origin_review",
              originAuthority: "Statutární město Ostrava",
              snapshotAvailable: true,
              imagePayloadInFeatureStream: false
            })
          })
        })
      })
    ]);
    expect(JSON.stringify(response.body.features)).not.toContain(snapshotUrl);
    expect(response.body.features[0].properties.raw).toBeUndefined();

    const detailUrl = response.body.features[0].properties.providerProperties.camera.detailUrl;
    const detail = await request(app).get(detailUrl).expect(200);
    expect(detail.body.cameras).toEqual([
      expect.objectContaining({
        cameraId: "webcamlive_origin_review-ostrava_slezska_ostrava-slezska_ostrava",
        name: "Slezská Ostrava",
        snapshotAvailable: true,
        contentType: "image/jpeg"
      })
    ]);
    expect(JSON.stringify(detail.body)).not.toContain(snapshotUrl);

    const snapshot = await request(app).get(detail.body.cameras[0].snapshotUrl).expect(200);
    expect(snapshot.headers["content-type"]).toContain("image/jpeg");
    expect(snapshot.body).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });

  it("discovers direct snapshots from curated outdoor origin pages on demand", async () => {
    const feedUrl = "https://camera-origin.example.test/public-webcams.json";
    const providerPageUrl = "https://camera-origin.example.test/skalka/webkamera";
    const snapshotUrl = "https://camera-origin.example.test/skalka/webcam-current.jpg";
    config.enabledSources = ["chmi_weather_webcams"];
    config.publicCameraFeeds = [
      [
        "curated_outdoor_webcams",
        "Kurátorované turistické webkamery",
        "outdoor_webcam",
        "Ověřený origin provozovatel",
        "https://camera-origin.example.test/",
        "static_json",
        feedUrl
      ].join("|")
    ];
    ({ app } = await createApp(config));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === feedUrl) {
          return jsonResponse({
            sourceId: "webcamlive_origin_review",
            label: "Ověřené turistické kamery",
            authority: "Obec Skalka",
            attribution: "Obec Skalka",
            providerPageUrl: "https://camera-origin.example.test/",
            category: "outdoor_webcam",
            locations: [
              {
                locationId: "skalka_rozhledna",
                label: "Skalka - rozhledna",
                lon: 15.1,
                lat: 49.8,
                providerPageUrl,
                sourceDataUrl: providerPageUrl,
                cameras: [
                  {
                    cameraId: "rozhledna",
                    name: "Rozhledna",
                    providerUrl: providerPageUrl,
                    snapshotAvailable: false
                  }
                ]
              }
            ]
          });
        }
        if (url === providerPageUrl) {
          return new Response(`<html><body><img class="webkamera aktualni" src="${snapshotUrl}" alt="webkamera rozhledna"></body></html>`, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" }
          });
        }
        if (url === snapshotUrl) {
          return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
            status: 200,
            headers: { "content-type": "image/jpeg", "content-length": "4" }
          });
        }
        return new Response("not found", { status: 404 });
      })
    );

    const response = await request(app)
      .get("/api/v1/features?layers=outdoor_webcams&sources=chmi_weather_webcams&bbox=15,49.7,15.2,49.9&includeRaw=false")
      .expect(200);

    expect(response.body.features[0].properties.providerProperties.camera).toEqual(
      expect.objectContaining({
        snapshotAvailable: true,
        snapshotAvailability: "origin_page_discovery",
        snapshotDiscoveryMode: "origin_page_html_candidates"
      })
    );
    expect(JSON.stringify(response.body.features)).not.toContain(snapshotUrl);

    const detailUrl = response.body.features[0].properties.providerProperties.camera.detailUrl;
    const detail = await request(app).get(detailUrl).expect(200);
    expect(detail.body.cameras[0]).toEqual(
      expect.objectContaining({
        name: "Rozhledna",
        snapshotAvailable: true,
        snapshotAvailability: "origin_page_discovery"
      })
    );

    const snapshot = await request(app).get(detail.body.cameras[0].snapshotUrl).expect(200);
    expect(snapshot.headers["content-type"]).toContain("image/jpeg");
    expect(snapshot.body).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });

  it("does not fetch private origin page URLs from curated outdoor camera feeds", async () => {
    const feedUrl = "https://camera-origin.example.test/public-webcams.json";
    const privateProviderPageUrl = "http://127.0.0.1:18080/internal-camera";
    config.enabledSources = ["chmi_weather_webcams"];
    config.publicCameraFeeds = [
      [
        "curated_outdoor_webcams",
        "Kurátorované turistické webkamery",
        "outdoor_webcam",
        "Ověřený origin provozovatel",
        "https://camera-origin.example.test/",
        "static_json",
        feedUrl
      ].join("|")
    ];
    ({ app } = await createApp(config));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === feedUrl) {
        return jsonResponse({
          sourceId: "webcamlive_origin_review",
          label: "Ověřené turistické kamery",
          authority: "Obec Skalka",
          attribution: "Obec Skalka",
          providerPageUrl: "https://camera-origin.example.test/",
          category: "outdoor_webcam",
          locations: [
            {
              locationId: "skalka_internal",
              label: "Skalka - interní",
              lon: 15.1,
              lat: 49.8,
              providerPageUrl: privateProviderPageUrl,
              sourceDataUrl: privateProviderPageUrl,
              cameras: [
                {
                  cameraId: "internal",
                  name: "Internal",
                  providerUrl: privateProviderPageUrl,
                  snapshotAvailable: false
                }
              ]
            }
          ]
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await request(app)
      .get("/api/v1/features?layers=outdoor_webcams&sources=chmi_weather_webcams&bbox=15,49.7,15.2,49.9&includeRaw=false")
      .expect(200);

    expect(response.body.features).toHaveLength(0);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain(privateProviderPageUrl);
  });

  it("filters private image candidates during origin page snapshot discovery", async () => {
    const feedUrl = "https://camera-origin.example.test/public-webcams.json";
    const providerPageUrl = "https://camera-origin.example.test/skalka/webkamera";
    const privateSnapshotUrl = "http://169.254.169.254/latest/meta-data/webcam-current.jpg";
    const publicSnapshotUrl = "https://camera-origin.example.test/skalka/webcam-current.jpg";
    config.enabledSources = ["chmi_weather_webcams"];
    config.publicCameraFeeds = [
      [
        "curated_outdoor_webcams",
        "Kurátorované turistické webkamery",
        "outdoor_webcam",
        "Ověřený origin provozovatel",
        "https://camera-origin.example.test/",
        "static_json",
        feedUrl
      ].join("|")
    ];
    ({ app } = await createApp(config));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === feedUrl) {
        return jsonResponse({
          sourceId: "webcamlive_origin_review",
          label: "Ověřené turistické kamery",
          authority: "Obec Skalka",
          attribution: "Obec Skalka",
          providerPageUrl: "https://camera-origin.example.test/",
          category: "outdoor_webcam",
          locations: [
            {
              locationId: "skalka_rozhledna",
              label: "Skalka - rozhledna",
              lon: 15.1,
              lat: 49.8,
              providerPageUrl,
              sourceDataUrl: providerPageUrl,
              cameras: [
                {
                  cameraId: "rozhledna",
                  name: "Rozhledna",
                  providerUrl: providerPageUrl,
                  snapshotAvailable: false
                }
              ]
            }
          ]
        });
      }
      if (url === providerPageUrl) {
        return new Response(
          `<html><body><img class="webkamera aktualni" src="${privateSnapshotUrl}"><img class="webkamera aktualni" src="${publicSnapshotUrl}"></body></html>`,
          {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" }
          }
        );
      }
      if (url === publicSnapshotUrl) {
        return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-length": "4" }
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await request(app)
      .get("/api/v1/features?layers=outdoor_webcams&sources=chmi_weather_webcams&bbox=15,49.7,15.2,49.9&includeRaw=false")
      .expect(200);
    const detail = await request(app).get(response.body.features[0].properties.providerProperties.camera.detailUrl).expect(200);

    const snapshot = await request(app).get(detail.body.cameras[0].snapshotUrl).expect(200);

    expect(snapshot.headers["content-type"]).toContain("image/jpeg");
    expect(snapshot.body).toEqual(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain(privateSnapshotUrl);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain(publicSnapshotUrl);
  });

  it("publishes bundled verified origin webcams as outdoor context, not weather", async () => {
    config.enabledSources = ["chmi_weather_webcams"];
    config.publicCameraFeeds = [
      [
        "cz_verified_origin_webcams",
        "Ověřené turistické webkamery ČR",
        "outdoor_webcam",
        "Jednotliví veřejní provozovatelé kamer v ČR",
        "https://www.webcamlive.cz/webkamery/ceska-republika/2",
        "static_json",
        "builtin:curated_outdoor_webcams_cz"
      ].join("|")
    ];
    ({ app } = await createApp(config));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === config.chmiWeatherWebcamsMapUrl) {
          return jsonResponse({ type: "FeatureCollection", features: [] });
        }
        return new Response("not found", { status: 404 });
      })
    );

    const outdoor = await request(app)
      .get("/api/v1/features?layers=outdoor_webcams&sources=chmi_weather_webcams&bbox=12,48,19.2,51.2&limit=500&includeRaw=false")
      .expect(200);

    expect(outdoor.body.features.length).toBeGreaterThan(200);
    expect(outdoor.body.features[0]).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^outdoor_webcam:/),
        properties: expect.objectContaining({
          layer: "outdoor_webcams",
          category: "outdoor_webcam",
          styleHint: "outdoor-webcam-point-v1",
          providerProperties: expect.objectContaining({
            camera: expect.objectContaining({
              originCategory: "outdoor_webcam",
              presentationGroup: "outdoor",
              snapshotAvailable: true,
              snapshotAvailability: "origin_page_discovery",
              imagePayloadInFeatureStream: false
            })
          })
        })
      })
    );
    expect(JSON.stringify(outdoor.body.features)).not.toContain("camera_image.php");
    expect(JSON.stringify(outdoor.body.features)).not.toContain("outputCache");

    const weather = await request(app)
      .get("/api/v1/features?layers=weather_webcams&sources=chmi_weather_webcams&bbox=12,48,19.2,51.2&limit=500&includeRaw=false")
      .expect(200);
    expect(weather.body.features).toHaveLength(0);
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

    const response = await request(app).get("/api/v1/features?layers=weather_webcams&sources=chmi_weather_webcams&bbox=14.4,50,14.5,50.1").expect(200);

    expect(response.body.features).toEqual([
      expect.objectContaining({
        id: "weather_webcam:wgs84_14p445358_50p007510",
        geometry: { type: "Point", coordinates: [14.445358, 50.00751] },
        properties: expect.objectContaining({
          layer: "weather_webcams",
          layerId: "public.weather.webcams",
          providerLayerId: "weather.chmi_webcams",
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
          selectable: true
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
          providerLayerId: "outdoor.osm_postgis.trail_routes",
          recommendedCatalogLayerId: "public.trails.routes",
          role: "reference",
          audience: "public",
          kind: "vector_features",
          geometryTypes: ["LineString", "MultiLineString"],
          styleProfile: "trail-route-osm-v1",
          sourceIds: ["osm_postgis"],
          readModel: expect.objectContaining({ table: "public.osm_trail_routes" })
        }),
        expect.objectContaining({
          providerLayerId: "outdoor.osm_postgis.trail_poi",
          recommendedCatalogLayerId: "public.trails.poi",
          role: "reference",
          audience: "public",
          kind: "vector_features",
          geometryTypes: ["Point"],
          styleProfile: "trail-poi-osm-v1",
          sourceIds: ["osm_postgis"],
          readModel: expect.objectContaining({ table: "public.osm_trail_poi" })
        }),
        expect.objectContaining({
          providerLayerId: "outdoor.community.places",
          recommendedCatalogLayerId: "public.outdoor.community_places",
          role: "reference",
          audience: "public",
          kind: "vector_features",
          selectable: true,
          geometryTypes: ["Point"],
          styleProfile: "community-place-osm-v1",
          sourceIds: ["community_context"],
          technicalInputs: ["osm_postgis"],
          readModel: expect.objectContaining({ table: "public.osm_poi" })
        }),
        expect.objectContaining({
          providerLayerId: "outdoor.community.reports",
          recommendedCatalogLayerId: "public.outdoor.community_reports",
          role: "user",
          audience: "authenticated",
          kind: "user_objects",
          selectable: false,
          sourceIds: ["community_context"]
        }),
        expect.objectContaining({
          providerLayerId: "traffic.idsjmk_vehicle_positions",
          recommendedCatalogLayerId: "public.traffic.transit",
          role: "reference",
          audience: "public",
          enabled: false,
          availability: "disabled",
          disabledReason: expect.stringContaining("idsjmk_vehicle_positions"),
          sourceIds: ["idsjmk_vehicle_positions"]
        }),
        expect.objectContaining({
          providerLayerId: "traffic.public_transit_static",
          recommendedCatalogLayerId: "public.traffic.transit_stops",
          role: "reference",
          audience: "public",
          minZoom: 11,
          sourceIds: ["public_transit_static"]
        }),
        expect.objectContaining({
          providerLayerId: "traffic.spravazeleznic_trains",
          recommendedCatalogLayerId: "public.traffic.transit",
          role: "reference",
          audience: "public",
          refreshSeconds: 900,
          sourceIds: ["spravazeleznic_trains"]
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
          providerLayerId: "weather_alerts.safety_data_projection",
          recommendedCatalogLayerId: "public.safety.weather_alerts",
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
          providerLayerId: "weather.forecast_area",
          recommendedCatalogLayerId: "public.weather.forecast_area",
          role: "primary",
          audience: "public",
          kind: "vector_features",
          sourceIds: ["weather_forecast"],
          delivery: expect.objectContaining({
            mode: "features",
            geometryRole: "grid_cell",
            valueField: "metrics.riskScore"
          })
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
          providerLayerId: "outdoor.verified_origin_webcams",
          recommendedCatalogLayerId: "public.outdoor.webcams",
          role: "reference",
          audience: "public",
          kind: "vector_features",
          selectable: true,
          sourceIds: ["chmi_weather_webcams"],
          query: expect.objectContaining({
            providerLayerIds: ["outdoor_webcams"],
            providerSourceIds: ["chmi_weather_webcams"],
            categoryFilter: ["outdoor_webcam"]
          }),
          legal: expect.objectContaining({
            notes: expect.arrayContaining([expect.stringContaining("WebCamLive")])
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
          selectableInMap: true,
          visibleInDiagnostics: true,
          feedsLayerIds: ["mobile_coverage"],
          usedByLayerIds: ["mobile_network"],
          usedByCatalogLayerIds: ["public.mobile.network"]
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
          sourceId: "public_transit_static",
          sourceRole: "reference",
          audience: "public",
          selectableInMap: true,
          feedsLayerIds: ["traffic.public_transit_static"],
          feedsCatalogLayerIds: ["public.traffic.transit_stops"],
          cacheTtlSeconds: 21600,
          backend: "gtfs-static"
        }),
        expect.objectContaining({
          sourceId: "spravazeleznic_trains",
          sourceRole: "final",
          audience: "public",
          selectableInMap: true,
          feedsLayerIds: ["traffic.spravazeleznic_trains"],
          feedsCatalogLayerIds: ["public.traffic.transit"],
          cacheTtlSeconds: 900,
          backend: "spravazeleznic-mapy"
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
          feedsLayerIds: ["weather.chmi_webcams", "outdoor.verified_origin_webcams"],
          feedsCatalogLayerIds: ["public.weather.webcams", "public.outdoor.webcams"]
        }),
        expect.objectContaining({
          sourceId: "chmi_air_quality",
          feedsCatalogLayerIds: expect.arrayContaining(["public.safety.air_quality", "public.safety.air_quality_grid"])
        }),
        expect.objectContaining({
          sourceId: "osm_postgis",
          feedsCatalogLayerIds: expect.arrayContaining([
            "public.boundary.country",
            "public.boundary.region",
            "public.boundary.district",
            "public.boundary.orp",
            "public.trails.routes",
            "public.trails.poi"
          ])
        }),
        expect.objectContaining({
          sourceId: "community_context",
          sourceRole: "reference",
          audience: "public",
          selectableInMap: true,
          visibleInDiagnostics: true,
          feedsLayerIds: ["outdoor.community.places"],
          feedsCatalogLayerIds: ["public.outdoor.community_places"],
          technicalInputs: ["osm_postgis"]
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

  it("marks provider catalog layers available only when their runtime source is enabled", async () => {
    const { app: trafficApp } = await createApp({
      ...config,
      enabledSources: ["pid_gtfs_rt", "public_transit_static"]
    });

    const response = await request(trafficApp).get("/api/v1/catalog").expect(200);
    const pidLayer = response.body.layers.find((layer: { providerLayerId?: string }) => layer.providerLayerId === "traffic.pid_gtfs_rt");
    const staticLayer = response.body.layers.find((layer: { providerLayerId?: string }) => layer.providerLayerId === "traffic.public_transit_static");
    const idsjmkLayer = response.body.layers.find((layer: { providerLayerId?: string }) => layer.providerLayerId === "traffic.idsjmk_vehicle_positions");

    expect(pidLayer).toEqual(expect.objectContaining({ enabled: true, availability: "available" }));
    expect(staticLayer).toEqual(expect.objectContaining({ enabled: true, availability: "available" }));
    expect(idsjmkLayer).toEqual(
      expect.objectContaining({
        enabled: false,
        availability: "disabled",
        disabledReason: expect.stringContaining("idsjmk_vehicle_positions")
      })
    );
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

    const density = await request(app)
      .get("/api/v1/features/density?layers=weather,ground,mobile,traffic&source=mock&limit=20&cellSizeDegrees=1&sampleSize=3")
      .expect(200);
    expect(density.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-provider-feature-density-v1",
        type: "FeatureCollection",
        providerId: "sim.situation-data",
        density: expect.objectContaining({
          cellSizeDegrees: 1,
          cellCount: 1,
          inputFeatureCount: 6,
          omittedOriginalGeometry: true,
          truncated: false
        }),
        summary: expect.objectContaining({ cellCount: 1, inputFeatureCount: 6, omittedGeometry: true }),
        features: [
          expect.objectContaining({
            type: "Feature",
            geometry: expect.objectContaining({ type: "Polygon" }),
            properties: expect.objectContaining({
              category: "density_cell",
              featureCount: 6,
              topSeverity: "warning",
              layerCounts: expect.objectContaining({ weather: 1, ground: 2, mobile: 2, traffic: 1 }),
              sourceCounts: expect.objectContaining({ mock: 6 }),
              sampleFeatureIds: expect.arrayContaining(["weather:mock:prague-west"])
            })
          })
        ]
      })
    );
    expect(density.body.features[0].properties.sampleFeatureIds).toHaveLength(3);
    expect(density.body.features[0].properties).not.toHaveProperty("raw");

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
          metNorway: 600,
          mobileNetwork: 3600,
          mobileCoverage: 21600,
          osmPostgis: 21600,
          communityContext: 21600,
          osmOverpass: 21600,
          ctuStationaryMobile: 86400,
          pidGtfsRt: 20,
          pidGtfsStatic: 21600,
          publicTransitStatic: 21600,
          idsjmkVehiclePositions: 20,
          spravaZeleznicTrains: 900,
          roadSrtiLod: 300,
          safetyData: 300,
          aviationWeather: 600,
          chmiAirQuality: 900,
          chmiWeatherStations: 600,
          chmiWeatherRadar: 300,
          chmiWeatherWebcams: 300,
          ardosPartner: 15,
          routing: 300,
          radioPlanning: 900
        },
        routing: {
          enabled: false,
          backend: "unconfigured",
          graphTable: "public.osm_roads",
          maxGraphEdges: 45000,
          maxSearchRadiusM: 160000,
          maxSnapDistanceM: 2500
        },
        searchData: {
          enabled: true,
          contractVersion: "sim-search-source-v1",
          basePath: "/search-data/api/v1",
          cacheTtlSeconds: 300,
          cacheMaxEntries: 256,
          maxLimit: 5000
        },
        providers: expect.arrayContaining([
          expect.objectContaining({ sourceId: "mock", authConfigured: true }),
          expect.objectContaining({ sourceId: "open_meteo", authConfigured: true, backend: "open-meteo+met-norway" }),
          expect.objectContaining({ sourceId: "weather_forecast", authConfigured: true, backend: "sim-weather-forecast-open-meteo" }),
          expect.objectContaining({ sourceId: "mobile_coverage_model", authConfigured: false, backend: "unconfigured" }),
          expect.objectContaining({ sourceId: "mobile_network_model", authConfigured: false, backend: "unconfigured" }),
          expect.objectContaining({ sourceId: "osm_postgis", authConfigured: false, backend: "unconfigured" }),
          expect.objectContaining({ sourceId: "community_context", authConfigured: false, backend: "unconfigured:community-reference" }),
          expect.objectContaining({ sourceId: "ctu_nettest", authConfigured: true }),
          expect.objectContaining({ sourceId: "ctu_stationary_mobile", authConfigured: true }),
          expect.objectContaining({ sourceId: "pid_gtfs_rt", authConfigured: true }),
          expect.objectContaining({ sourceId: "public_transit_static", authConfigured: true, backend: "gtfs-static+geojson-static" }),
          expect.objectContaining({ sourceId: "idsjmk_vehicle_positions", authConfigured: true }),
          expect.objectContaining({ sourceId: "spravazeleznic_trains", authConfigured: true, backend: "spravazeleznic-mapy" }),
          expect.objectContaining({ sourceId: "road_srti_lod", authConfigured: true }),
          expect.objectContaining({ sourceId: "safety_data", authConfigured: true }),
          expect.objectContaining({ sourceId: "aviation_weather", authConfigured: true }),
          expect.objectContaining({ sourceId: "chmi_air_quality", authConfigured: true, backend: "chmi-opendata" }),
          expect.objectContaining({ sourceId: "chmi_weather_stations", authConfigured: true, backend: "chmi-opendata" }),
          expect.objectContaining({ sourceId: "chmi_weather_radar", authConfigured: true, backend: "chmi-opendata" }),
          expect.objectContaining({ sourceId: "chmi_weather_webcams", authConfigured: true, backend: "multi-origin-public-camera-feeds" }),
          expect.objectContaining({ sourceId: "ardos_partner", authConfigured: false })
        ])
      })
    );
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });

  it("corroborates current weather with MET Norway without changing the COP-facing Open-Meteo contract", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://api.open-meteo.com/v1/forecast")) {
        return jsonResponse({
          current: {
            time: "2026-06-28T12:00",
            temperature_2m: 25.4,
            relative_humidity_2m: 48,
            precipitation: 0,
            weather_code: 2,
            cloud_cover: 34,
            wind_speed_10m: 3.2,
            wind_direction_10m: 270,
            wind_gusts_10m: 7.1
          },
          current_units: { temperature_2m: "°C" }
        });
      }
      if (url.startsWith("https://api.met.no/weatherapi/locationforecast/2.0/compact")) {
        return jsonResponse({
          properties: {
            timeseries: [
              {
                time: "2026-06-28T12:00:00Z",
                data: {
                  instant: {
                    details: {
                      air_temperature: 24.9,
                      relative_humidity: 50,
                      cloud_area_fraction: 38,
                      wind_speed: 3.5,
                      wind_from_direction: 265
                    }
                  },
                  next_1_hours: {
                    summary: { symbol_code: "partlycloudy_day" },
                    details: { precipitation_amount: 0 }
                  }
                }
              }
            ]
          }
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const weatherApp = await createApp({ ...config, enabledSources: ["open_meteo"] });

    const response = await request(weatherApp.app).get("/api/v1/features?bbox=14.0,50.0,14.2,50.2&layers=weather&source=open_meteo&limit=5").expect(200);

    expect(response.body.features).toHaveLength(1);
    expect(response.body.features[0]).toEqual(
      expect.objectContaining({
        id: "weather:open_meteo:50.1000:14.1000",
        properties: expect.objectContaining({
          layer: "weather",
          layerId: "public.weather.current",
          providerLayerId: "weather.open_meteo",
          sourceId: "open_meteo",
          metrics: expect.objectContaining({ temperatureC: 25.4, windSpeedMps: 3.2, weatherCode: 2 }),
          tags: expect.objectContaining({
            primaryWeatherProvider: "open_meteo",
            corroboratingWeatherProvider: "met_norway"
          }),
          providerProperties: expect.objectContaining({
            weather: expect.objectContaining({
              primaryProvider: "open_meteo",
              sourceInputs: ["open_meteo_current", "met_norway_locationforecast"],
              contractStableForCop: true
            }),
            weatherCorroboration: expect.objectContaining({
              fallbackUsed: false,
              providers: ["open_meteo_current", "met_norway_locationforecast"],
              metNorway: expect.objectContaining({
                symbolCode: "partlycloudy_day",
                temperatureC: 24.9
              })
            })
          })
        })
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("api.met.no/weatherapi/locationforecast/2.0/compact"),
      expect.objectContaining({
        headers: expect.objectContaining({ "user-agent": "csm-sim-test/0.1 contact:test@example.invalid" })
      })
    );
  });

  it("publishes SIM forecast areas with COP-ready symbols and meteogram detail", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://api.open-meteo.com/v1/forecast")) {
        return jsonResponse({
          current: {
            time: "2026-07-01T12:00",
            temperature_2m: 18.7,
            relative_humidity_2m: 77,
            precipitation: 0.8,
            weather_code: 61,
            cloud_cover: 92,
            wind_speed_10m: 5.1,
            wind_direction_10m: 240,
            wind_gusts_10m: 12.5
          },
          hourly: {
            time: ["2026-07-01T12:00", "2026-07-01T13:00", "2026-07-01T14:00", "2026-07-01T15:00", "2026-07-01T16:00", "2026-07-01T17:00"],
            temperature_2m: [18.7, 19.1, 19.4, 18.9, 18.2, 17.8],
            relative_humidity_2m: [77, 76, 78, 82, 84, 86],
            precipitation: [0.8, 1.2, 3.4, 0.6, 0.2, 0],
            precipitation_probability: [70, 75, 88, 62, 35, 15],
            weather_code: [61, 63, 80, 61, 3, 2],
            cloud_cover: [92, 94, 96, 88, 80, 55],
            wind_speed_10m: [5.1, 5.4, 6.2, 5.9, 4.2, 3.5],
            wind_direction_10m: [240, 245, 250, 252, 260, 265],
            wind_gusts_10m: [12.5, 13.2, 15.1, 12.4, 9.5, 7.3]
          },
          daily: {
            time: ["2026-07-01", "2026-07-02"],
            weather_code: [80, 2],
            temperature_2m_max: [20.1, 23.4],
            temperature_2m_min: [14.5, 13.1],
            precipitation_sum: [8.4, 0.1],
            precipitation_probability_max: [88, 15],
            wind_gusts_10m_max: [15.1, 7.2]
          }
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const forecastApp = await createApp({ ...config, enabledSources: ["weather_forecast"] });

    const response = await request(forecastApp.app)
      .get("/api/v1/features?bbox=14.0,50.0,14.2,50.2&layers=weather_forecast_area&source=weather_forecast&limit=1")
      .expect(200);

    expect(response.body.features).toHaveLength(1);
    const feature = response.body.features[0];
    expect(feature).toEqual(
      expect.objectContaining({
        geometry: expect.objectContaining({ type: "Polygon" }),
        properties: expect.objectContaining({
          layer: "weather_forecast_area",
          layerId: "public.weather.forecast_area",
          providerLayerId: "weather.forecast_area",
          sourceId: "weather_forecast",
          iconHint: expect.any(String),
          metrics: expect.objectContaining({
            temperatureC: 18.7,
            precipitationNext10MinMm: 0.13,
            precipitationNext1hMm: 0.8,
            precipitationNext3hMm: 5.4,
            precipitationProbabilityNext1hPercent: 70,
            precipitationProbabilityNext3hPercent: 88,
            thunderstormProbabilityPercent: expect.any(Number),
            lightningStrikeFeedAvailable: false,
            riskScore: expect.any(Number)
          }),
          providerProperties: expect.objectContaining({
            presentation: expect.objectContaining({
              symbolKey: expect.not.stringMatching(/^partly_cloudy$/),
              riskLevel: expect.any(String)
            }),
            display: expect.objectContaining({
              detailType: "weather_forecast_meteogram",
              detailUrl: expect.stringContaining("/situation-data/api/v1/weather-forecast/areas/"),
              chartUrl: expect.stringContaining("/situation-data/api/v1/weather-forecast/areas/")
            }),
            weatherForecast: expect.objectContaining({
              detailAvailable: true,
              detailUrl: expect.stringContaining("/situation-data/api/v1/weather-forecast/areas/"),
              serviceDetailUrl: expect.stringContaining("/api/v1/weather-forecast/areas/")
            }),
            aiContext: expect.objectContaining({
              dynamicDataRequiresTimestamp: true,
              lightningNearbyAvailable: false
            })
          })
        })
      })
    );

    const detailUrl = feature.properties.providerProperties.weatherForecast.serviceDetailUrl;
    const detail = await request(forecastApp.app).get(detailUrl).expect(200);
    expect(detail.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-weather-forecast-area-detail-v1",
        sourceId: "weather_forecast",
        catalogLayerId: "public.weather.forecast_area",
        summary: expect.objectContaining({
          symbolKey: expect.any(String),
          headlineCs: expect.any(String),
          severity: expect.any(String)
        }),
        hourly: expect.objectContaining({
          points: expect.arrayContaining([
            expect.objectContaining({
              time: "2026-07-01T12:00:00.000Z",
              precipitationMm: 0.8,
              precipitationProbabilityPercent: 70
            })
          ])
        }),
        charts: expect.arrayContaining([
          expect.objectContaining({ chartId: "temperature" }),
          expect.objectContaining({ chartId: "precipitation" }),
          expect.objectContaining({ chartId: "wind" }),
          expect.objectContaining({ chartId: "risk" })
        ])
      })
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps SIM forecast areas inside the Czech operational forecast grid", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://api.open-meteo.com/v1/forecast")) {
        return jsonResponse({
          current: {
            time: "2026-07-01T12:00",
            temperature_2m: 20,
            relative_humidity_2m: 60,
            precipitation: 0,
            weather_code: 2,
            cloud_cover: 45,
            wind_speed_10m: 3,
            wind_direction_10m: 220,
            wind_gusts_10m: 6
          },
          hourly: {
            time: ["2026-07-01T12:00", "2026-07-01T13:00"],
            temperature_2m: [20, 21],
            relative_humidity_2m: [60, 58],
            precipitation: [0, 0],
            precipitation_probability: [10, 10],
            weather_code: [2, 2],
            cloud_cover: [45, 45],
            wind_speed_10m: [3, 3],
            wind_direction_10m: [220, 220],
            wind_gusts_10m: [6, 6]
          },
          daily: {
            time: ["2026-07-01"],
            weather_code: [2],
            temperature_2m_max: [23],
            temperature_2m_min: [14],
            precipitation_sum: [0],
            precipitation_probability_max: [10],
            wind_gusts_10m_max: [6]
          }
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const forecastApp = await createApp({ ...config, enabledSources: ["weather_forecast"] });

    const outside = await request(forecastApp.app)
      .get("/api/v1/features?bbox=21.0,47.0,25.0,50.0&layers=weather_forecast_area&source=weather_forecast&limit=50")
      .expect(200);

    expect(outside.body.features).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    const wide = await request(forecastApp.app)
      .get("/api/v1/features?bbox=10.0,47.5,31.0,52.5&layers=weather_forecast_area&source=weather_forecast&limit=200")
      .expect(200);

    expect(wide.body.features.length).toBeGreaterThan(20);
    expect(wide.body.features.length).toBeLessThanOrEqual(64);
    for (const forecastFeature of wide.body.features) {
      const coordinates = forecastFeature.geometry.coordinates[0] as Array<[number, number]>;
      const lons = coordinates.map(([lon]) => lon);
      const lats = coordinates.map(([, lat]) => lat);
      expect(Math.min(...lons)).toBeGreaterThanOrEqual(11.25);
      expect(Math.max(...lons)).toBeLessThanOrEqual(19.5);
      expect(Math.min(...lats)).toBeGreaterThanOrEqual(48);
      expect(Math.max(...lats)).toBeLessThanOrEqual(51.75);
      expect(forecastFeature.properties.providerProperties.weatherForecast).toEqual(
        expect.objectContaining({
          coverageBbox: { west: 11.8, south: 48.4, east: 19.2, north: 51.2 },
          stableGrid: expect.objectContaining({ alignment: "wgs84" })
        })
      );
    }
  });

  it("uses MET Norway as current weather fallback while preserving the Open-Meteo source id for COP", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.open-meteo.com/v1/forecast")) {
          return new Response("unavailable", { status: 503 });
        }
        if (url.startsWith("https://api.met.no/weatherapi/locationforecast/2.0/compact")) {
          return jsonResponse({
            properties: {
              timeseries: [
                {
                  time: "2026-06-28T12:00:00Z",
                  data: {
                    instant: {
                      details: {
                        air_temperature: 18.5,
                        relative_humidity: 82,
                        cloud_area_fraction: 100,
                        wind_speed: 4.2,
                        wind_from_direction: 180
                      }
                    },
                    next_1_hours: {
                      summary: { symbol_code: "rain" },
                      details: { precipitation_amount: 1.4 }
                    }
                  }
                }
              ]
            }
          });
        }
        return new Response("not found", { status: 404 });
      })
    );
    const weatherApp = await createApp({ ...config, enabledSources: ["open_meteo"] });

    const response = await request(weatherApp.app).get("/api/v1/features?bbox=14.0,50.0,14.2,50.2&layers=weather&source=open_meteo&limit=5").expect(200);

    expect(response.body.warnings).toEqual([expect.stringContaining("open_meteo primary provider failed")]);
    expect(response.body.features).toHaveLength(1);
    expect(response.body.features[0].properties).toEqual(
      expect.objectContaining({
        layer: "weather",
        layerId: "public.weather.current",
        providerLayerId: "weather.open_meteo",
        sourceId: "open_meteo",
        metrics: expect.objectContaining({
          temperatureC: 18.5,
          precipitationMm: 1.4,
          weatherCode: 61
        }),
        tags: expect.objectContaining({
          primaryWeatherProvider: "met_norway"
        }),
        providerProperties: expect.objectContaining({
          weather: expect.objectContaining({ primaryProvider: "met_norway" }),
          weatherCorroboration: expect.objectContaining({ fallbackUsed: true })
        })
      })
    );
  });

  it("exposes cache metrics", async () => {
    const response = await request(app).get("/metrics").expect(200);
    expect(response.text).toContain("situation_data_cache_entries");
    expect(response.text).toContain("situation_data_cache_coalesced_hits");
    expect(response.text).toContain("situation_data_cache_shared_enabled");
    expect(response.text).toContain("situation_data_cache_shared_errors");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 }))
    );
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
        "public_transit_static",
        "idsjmk_vehicle_positions",
        "spravazeleznic_trains",
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
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_errors{source="public_transit_static"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_errors{source="idsjmk_vehicle_positions"}');
    expect(cachedSourceMetrics.text).toContain('situation_data_source_cache_errors{source="spravazeleznic_trains"}');
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

  it("projects meteorological warnings from Safety Data for compatibility COP adapters", async () => {
    const safetyFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/v1/features");
      expect(url.searchParams.get("layers")).toBe("weather_alerts");
      return new Response(
        JSON.stringify({
          features: [
            {
              type: "Feature",
              id: "weather_alerts:chmi_alerts:wind-orp",
              geometry: {
                type: "MultiPolygon",
                coordinates: [
                  [
                    [
                      [14.2, 50.0],
                      [14.3, 50.0],
                      [14.3, 50.1],
                      [14.2, 50.1],
                      [14.2, 50.0]
                    ]
                  ]
                ]
              },
              properties: {
                featureId: "weather_alerts:chmi_alerts:wind-orp",
                layerId: "public.safety.weather_alerts",
                providerId: "sim.safety-data",
                providerLayerId: "safety.weather_alerts",
                layer: "weather_alerts",
                category: "weather_alert",
                hazardType: "wind",
                typeCode: "weather.wind.high",
                headline: "Silný vítr",
                description: "Test meteorological warning.",
                recommendedAction: "Sledujte výstrahy ČHMÚ a pokyny IZS.",
                sourceId: "chmi_alerts",
                source: "chmi_alerts",
                sourceName: "CHMI CAP warnings",
                observedAt: "2026-05-28T08:00:00.000Z",
                validFrom: "2026-05-28T08:00:00.000Z",
                validUntil: "2026-05-28T18:00:00.000Z",
                updatedAt: "2026-05-28T08:00:00.000Z",
                confidence: 0.92,
                stale: false,
                severity: "warning",
                status: "active",
                urgency: "expected",
                certainty: "likely",
                areaName: "ORP Praha",
                styleHint: "safety-weather-warning",
                iconHint: "wind",
                basis: ["chmi_cap"],
                license: { name: "CC BY 4.0", attribution: "CHMI" },
                affectedAreas: ["ORP Praha"],
                geocodes: [{ scheme: "CISORP", value: "3100" }],
                metrics: { areaMatchConfidence: 0.96 },
                tags: { test: "weather_alert" }
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
      .get("/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=weather_alerts&source=safety_data&limit=10")
      .expect(200);

    expect(response.body.summary.featureCount).toBe(1);
    expect(response.body.features[0]).toEqual(
      expect.objectContaining({
        geometry: expect.objectContaining({ type: "MultiPolygon" }),
        properties: expect.objectContaining({
          layer: "weather_alerts",
          layerId: "public.safety.weather_alerts",
          providerId: "sim.situation-data",
          providerLayerId: "weather_alerts.safety_data_projection",
          label: "Silný vítr",
          typeCode: "weather.wind.high",
          providerProperties: expect.objectContaining({
            nativeProviderId: "sim.safety-data",
            nativeProviderLayerId: "safety.weather_alerts",
            sourceName: "CHMI CAP warnings"
          })
        })
      })
    );
    expect(safetyFetch).toHaveBeenCalledTimes(1);
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
                coordinates: [
                  [
                    [
                      [14.2, 50.0],
                      [14.3, 50.0],
                      [14.3, 50.1],
                      [14.2, 50.1],
                      [14.2, 50.0]
                    ]
                  ]
                ]
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
                coordinates: [
                  [
                    [
                      [14.0, 49.9],
                      [14.5, 49.9],
                      [14.5, 50.3],
                      [14.0, 50.3],
                      [14.0, 49.9]
                    ]
                  ]
                ]
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
          ["idRegistration, startTime, idValueType, value", "101, 2026-05-28T08:00:00Z, 8, 45.5", "102, 2026-05-28T08:00:00Z, 148, 4"].join("\n"),
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
    const second = await request(chmiApp.app).get("/api/v1/features?bbox=14.0,49.8,14.8,50.3&layers=weather&source=chmi_weather_stations&limit=21").expect(200);

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

  it("returns CHMI weather station detail with display, history and forecast charts", async () => {
    const nowMs = Date.now();
    const observedAt1 = new Date(nowMs - 20 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const observedAt2 = new Date(nowMs - 10 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const forecastAt1 = new Date(Math.ceil(nowMs / (60 * 60 * 1000)) * 60 * 60 * 1000).toISOString().slice(0, 16);
    const forecastAt2 = new Date(Math.ceil(nowMs / (60 * 60 * 1000)) * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString().slice(0, 16);
    const dateToken = observedAt2.slice(0, 10).replace(/-/g, "");
    const testConfig = {
      ...config,
      chmiWeatherMetadataBaseUrl: "https://example.test/chmi/detail/metadata/",
      chmiWeatherDataBaseUrl: "https://example.test/chmi/detail/data/",
      openMeteoBaseUrl: "https://example.test/open-meteo"
    };
    const stationId = "0-20000-0-11520";
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url === testConfig.chmiWeatherMetadataBaseUrl) {
        return new Response(`<a href="meta1-${dateToken}.json">meta1-${dateToken}.json</a>`, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      if (url === testConfig.chmiWeatherDataBaseUrl) {
        return new Response(
          [
            `<a href="10m-${stationId}-${dateToken}.json">10m-${stationId}-${dateToken}.json</a>`,
            `<a href="1h-${stationId}-${dateToken}.json">1h-${stationId}-${dateToken}.json</a>`
          ].join("\n"),
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
      if (url.endsWith(`/meta1-${dateToken}.json`)) {
        return new Response(
          JSON.stringify({
            data: {
              data: {
                header: "WSI,GH_ID,FULL_NAME,GEOGR1,GEOGR2,ELEVATION,BEGIN_DATE",
                values: [[stationId, "ZIS11520", "Detail station", 14.5, 50.1, 250, "1900-01-01T00:00:00Z"]]
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith(`/10m-${stationId}-${dateToken}.json`)) {
        return new Response(
          JSON.stringify({
            data: {
              data: {
                header: "STATION,ELEMENT,DT,VAL,FLAG,QUALITY",
                values: [
                  [stationId, "T", observedAt1, 19.5, "", 5],
                  [stationId, "T", observedAt2, 20.2, "", 5],
                  [stationId, "H", observedAt2, 65, "", 5],
                  [stationId, "F", observedAt2, 2.4, "", 5],
                  [stationId, "Fmax", observedAt2, 4.1, "", 5],
                  [stationId, "SRA10M", observedAt2, 0.2, "", 5],
                  [stationId, "SSV10M", observedAt2, 0, "", 5]
                ]
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith(`/1h-${stationId}-${dateToken}.json`)) {
        return new Response(
          JSON.stringify({
            data: {
              data: {
                header: "STATION,ELEMENT,DT,VAL,FLAG,QUALITY",
                values: [
                  [stationId, "N", observedAt2, 8, "", 5],
                  [stationId, "SRA1H", observedAt2, 1.4, "", 5],
                  [stationId, "VV", observedAt2, 40, "", 5]
                ]
              }
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.startsWith(`${testConfig.openMeteoBaseUrl}/v1/forecast`)) {
        return new Response(
          JSON.stringify({
            hourly: {
              time: [forecastAt1, forecastAt2],
              temperature_2m: [21.1, 20.4],
              relative_humidity_2m: [62, 70],
              precipitation: [0.1, 0.4],
              precipitation_probability: [20, 40],
              weather_code: [3, 61],
              cloud_cover: [70, 90],
              wind_speed_10m: [3.1, 3.5],
              wind_direction_10m: [270, 280],
              wind_gusts_10m: [5.1, 6.2]
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const chmiApp = await createApp({ ...testConfig, enabledSources: ["chmi_weather_stations"] });

    const response = await request(chmiApp.app).get(`/api/v1/weather-stations/${stationId}/detail?historyHours=72&forecastHours=2`).expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-weather-station-detail-v1",
        station: expect.objectContaining({ stationId, name: "Detail station" }),
        current: expect.objectContaining({
          display: expect.objectContaining({
            contractVersion: "sim-cop-weather-display-v1",
            renderer: "weather_station_detail_v1",
            iconKey: "rain",
            conditionMode: "measured"
          })
        }),
        history: expect.objectContaining({ pointCount: expect.any(Number), source: "chmi_meteorology_climate_now" }),
        forecast: expect.objectContaining({ pointCount: 2, source: "open_meteo" }),
        copInstructions: expect.objectContaining({ renderOnly: true })
      })
    );
    expect(response.body.charts.map((chart: { chartId: string }) => chart.chartId)).toEqual(["temperature", "precipitation", "wind", "humidity_cloud"]);
    expect(response.body.charts[0].series.length).toBeGreaterThanOrEqual(2);
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
        "/fct_pseudocappi2km/png/": radarIndex([
          "pacz2gmaps3.fct_z_cappi020.20260604.2115.ft60s10.tar",
          "pacz2gmaps3.fct_z_cappi020.20260604.2120.ft60s10.tar"
        ]),
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
            transit: expect.objectContaining({
              systemId: "pid",
              sourceId: "pid_gtfs_rt",
              positionKind: "vehicle_live",
              livePosition: true,
              motionExpected: true,
              refreshSeconds: 20,
              cacheTtlSeconds: 20,
              transportMode: "bus",
              routeId: "L136",
              routeShortName: "136",
              tripId: "trip-136-1",
              vehicleId: "service-3-pid-veh-1",
              detailUrl: "/situation-data/api/v1/transit/vehicles/traffic%3Apid_gtfs_rt%3Aservice-3-pid-veh-1?source=pid_gtfs_rt"
            }),
            raw: expect.any(Object)
          })
        })
      })
    );
  });

  it("returns PID transit vehicle detail from GTFS-RT and static GTFS", async () => {
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
            timestamp: Math.round(Date.parse("2026-05-28T06:05:30.000Z") / 1000),
            currentStopSequence: 2,
            currentStatus: gtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.IN_TRANSIT_TO,
            stopId: "stop-2",
            occupancyStatus: gtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.MANY_SEATS_AVAILABLE,
            occupancyPercentage: 37
          }
        }
      ]
    });
    const realtimePayload = gtfsRealtime.transit_realtime.FeedMessage.encode(feed).finish();
    const tripUpdatesFeed = gtfsRealtime.transit_realtime.FeedMessage.create({
      header: {
        gtfsRealtimeVersion: "2.0",
        timestamp: Math.round(Date.parse("2026-05-28T06:05:45.000Z") / 1000)
      },
      entity: [
        {
          id: "trip-update-1",
          tripUpdate: {
            trip: {
              tripId: "trip-136-1",
              routeId: "L136",
              startDate: "20260528",
              startTime: "08:00:00"
            },
            vehicle: {
              id: "service-3-pid-veh-1"
            },
            timestamp: Math.round(Date.parse("2026-05-28T06:05:45.000Z") / 1000),
            delay: 45,
            stopTimeUpdate: [
              {
                stopSequence: 1,
                stopId: "stop-1",
                arrival: { delay: 20 },
                departure: { delay: 20 }
              },
              {
                stopSequence: 2,
                stopId: "stop-2",
                arrival: { delay: 45 },
                departure: { delay: 45 }
              },
              {
                stopSequence: 3,
                stopId: "stop-3",
                arrival: { delay: 70 },
                departure: { delay: 75 }
              }
            ]
          }
        }
      ]
    });
    const tripUpdatesPayload = gtfsRealtime.transit_realtime.FeedMessage.encode(tripUpdatesFeed).finish();
    const staticPayload = zipSync({
      "routes.txt": strToU8("route_id,route_short_name,route_long_name,route_type\nL136,136,Sidliste Dablice - Sidliste Repy,3\n"),
      "trips.txt": strToU8("route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\nL136,WK,trip-136-1,Sidliste Repy,0,shape-136\n"),
      "stops.txt": strToU8(
        ["stop_id,stop_name,stop_lat,stop_lon", "stop-1,Sidliste Dablice,50.128,14.486", "stop-2,Stepnicna,50.12,14.45", "stop-3,Ladvi,50.125,14.469"].join(
          "\n"
        ) + "\n"
      ),
      "stop_times.txt": strToU8(
        [
          "trip_id,arrival_time,departure_time,stop_id,stop_sequence",
          "trip-136-1,08:00:00,08:00:00,stop-1,1",
          "trip-136-1,08:05:00,08:05:00,stop-2,2",
          "trip-136-1,08:08:00,08:08:00,stop-3,3"
        ].join("\n") + "\n"
      ),
      "shapes.txt": strToU8(
        ["shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence", "shape-136,50.128,14.486,1", "shape-136,50.12,14.45,2", "shape-136,50.125,14.469,3"].join(
          "\n"
        ) + "\n"
      )
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("PID_GTFS.zip")) {
        return new Response(staticPayload, { status: 200, headers: { "content-type": "application/zip" } });
      }
      if (url.endsWith("trip_updates.pb")) {
        return new Response(tripUpdatesPayload, { status: 200, headers: { "content-type": "application/octet-stream" } });
      }
      return new Response(realtimePayload, { status: 200, headers: { "content-type": "application/octet-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const pidApp = await createApp({
      ...config,
      pidGtfsRtVehiclePositionsUrl: "https://example.test/pid/vehicle_positions.pb",
      pidGtfsRtTripUpdatesUrl: "https://example.test/pid/trip_updates.pb",
      pidGtfsStaticUrl: "https://example.test/pid/PID_GTFS.zip",
      cacheTtlSeconds: 0,
      enabledSources: ["pid_gtfs_rt"]
    });

    const response = await request(pidApp.app)
      .get("/api/v1/transit/vehicles/traffic%3Apid_gtfs_rt%3Aservice-3-pid-veh-1?source=pid_gtfs_rt&maxStopTimes=10&maxShapePoints=10")
      .expect(200);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(response.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-transit-vehicle-detail-v1",
        sourceId: "pid_gtfs_rt",
        systemId: "pid",
        featureId: "traffic:pid_gtfs_rt:service-3-pid-veh-1",
        vehicle: expect.objectContaining({
          vehicleId: "service-3-pid-veh-1",
          transportMode: "bus",
          currentStatus: "in_transit_to",
          currentStopSequence: 2
        }),
        trip: expect.objectContaining({
          tripId: "trip-136-1",
          routeId: "L136",
          routeShortName: "136",
          destination: "Sidliste Repy",
          delaySeconds: 45,
          status: "stale"
        }),
        stopTimes: [
          expect.objectContaining({ stopId: "stop-1", relationToVehicle: "previous" }),
          expect.objectContaining({
            stopId: "stop-2",
            relationToVehicle: "current",
            predictedArrival: "2026-05-28T06:05:45.000Z",
            predictedDeparture: "2026-05-28T06:05:45.000Z",
            delaySeconds: 45,
            tripUpdateTimestamp: "2026-05-28T06:05:45.000Z"
          }),
          expect.objectContaining({ stopId: "stop-3", relationToVehicle: "next", delaySeconds: 75 })
        ],
        delaySeconds: 45,
        history: expect.objectContaining({
          generatedFrom: expect.arrayContaining(["pid_gtfs_rt_vehicle_positions", "sim_in_memory_vehicle_history"]),
          windowSeconds: 1800,
          pointCount: 1,
          points: [
            expect.objectContaining({
              observedAt: "2026-05-28T06:05:30.000Z",
              currentStopSequence: 2,
              relationToVehicle: "next"
            })
          ]
        }),
        prediction: expect.objectContaining({
          delaySource: "official_trip_update",
          delaySeconds: 45,
          tripUpdateTimestamp: "2026-05-28T06:05:45.000Z",
          stopTimes: expect.arrayContaining([
            expect.objectContaining({
              stopId: "stop-2",
              predictedArrival: "2026-05-28T06:05:45.000Z",
              delaySeconds: 45
            })
          ])
        }),
        routeShape: expect.objectContaining({
          shapeId: "shape-136",
          truncated: false,
          coordinates: [
            [14.486, 50.128],
            [14.45, 50.12],
            [14.469, 50.125]
          ]
        }),
        quality: expect.objectContaining({
          realtimeVehicleAvailable: true,
          staticModelAvailable: true,
          tripUpdateAvailable: true,
          tripScheduleAvailable: true,
          routeShapeAvailable: true,
          historyAvailable: true,
          predictionAvailable: true
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
              properties: {
                globalid: "{IDSJMK-GEO-1}",
                LineName: "12",
                VType: 1,
                Speed: 9,
                Bearing: 88,
                DelaySeconds: 120,
                Destination: "Technologický park",
                Operator: "DPMB",
                TimeUpdated: Date.now(),
                IsInactive: "false"
              },
              geometry: {
                type: "Point",
                coordinates: [16.607, 49.195]
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
        id: "traffic:idsjmk_vehicle_positions:_IDSJMK-GEO-1_",
        properties: expect.objectContaining({
          sourceId: "idsjmk_vehicle_positions",
          layerId: "public.traffic.transit",
          providerLayerId: "traffic.idsjmk_vehicle_positions",
          category: "public_transport_tram",
          transportMode: "tram",
          routeShortName: "12",
          destination: "Technologický park",
          delaySeconds: 120,
          vehicleId: "{IDSJMK-GEO-1}",
          operator: "DPMB",
          speedMps: 9,
          headingDeg: 88,
          metrics: expect.objectContaining({ speedMps: 9, headingDeg: 88 }),
          tags: expect.objectContaining({ line: "12", transportMode: "tram", positionKind: "vehicle_live", livePosition: "true" }),
          providerProperties: expect.objectContaining({
            transit: expect.objectContaining({
              systemId: "idsjmk",
              sourceId: "idsjmk_vehicle_positions",
              positionKind: "vehicle_live",
              livePosition: true,
              motionExpected: true,
              refreshSeconds: 20,
              cacheTtlSeconds: 20,
              detailAvailable: true,
              detailUrl: "/situation-data/api/v1/transit/vehicles/traffic%3Aidsjmk_vehicle_positions%3A_IDSJMK-GEO-1_?source=idsjmk_vehicle_positions"
            }),
            raw: expect.any(Object)
          })
        })
      })
    );

    const detail = await request(idsjmkApp.app)
      .get("/api/v1/transit/vehicles/traffic%3Aidsjmk_vehicle_positions%3A_IDSJMK-GEO-1_?source=idsjmk_vehicle_positions")
      .expect(200);
    expect(detail.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-transit-vehicle-detail-v1",
        sourceId: "idsjmk_vehicle_positions",
        systemId: "idsjmk",
        trip: expect.objectContaining({
          routeShortName: "12",
          destination: "Technologický park",
          delaySeconds: 120,
          status: "delayed"
        }),
        quality: expect.objectContaining({
          realtimeVehicleAvailable: true,
          tripUpdateAvailable: true,
          routeShapeAvailable: false
        })
      })
    );
  });

  it("projects public static GTFS stops from a source-level cache", async () => {
    const staticPayloadA = zipSync({
      "routes.txt": strToU8(
        ["route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_color,route_text_color", "L1,A1,10,Linka 10,,3,ff0000,ffffff"].join(
          "\n"
        )
      ),
      "trips.txt": strToU8(["route_id,service_id,trip_id,trip_headsign,direction_id,block_id,shape_id", "L1,S1,T1,Centrum,0,,SH1"].join("\n")),
      "stop_times.txt": strToU8(
        [
          "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type,timepoint",
          "T1,08:00:00,08:00:00,U1,1,0,0,1",
          "T1,08:05:00,08:05:00,P1,2,0,0,1"
        ].join("\n")
      ),
      "calendar.txt": strToU8(
        ["service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date", "S1,1,1,1,1,1,1,1,20260101,20261231"].join("\n")
      ),
      "shapes.txt": strToU8(["shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence", "SH1,50.6593,14.0447,1", "SH1,50.0832,14.4355,2"].join("\n")),
      "stops.txt": strToU8(
        [
          "stop_id,stop_code,stop_name,stop_lat,stop_lon,zone_id,location_type,parent_station,wheelchair_boarding",
          "U1,1001,Ústí nad Labem hlavní nádraží,50.6593,14.0447,UL,0,,1",
          "P1,2001,Praha hlavní nádraží,50.0832,14.4355,P,0,,1"
        ].join("\n")
      )
    });
    const staticPayloadB = zipSync({
      "stops.txt": strToU8(
        [
          "stop_id,stop_code,stop_name,stop_lat,stop_lon,zone_id,location_type,parent_station,wheelchair_boarding",
          "B1,3001,Brno hlavní nádraží,49.1905,16.6128,100,0,,1"
        ].join("\n")
      )
    });
    const staticGeojsonPayload = zipSync({
      "zastavky_MHD_WGS84_gjson.geojson": strToU8(
        JSON.stringify({
          type: "FeatureCollection",
          features: [
            {
              type: "Feature",
              geometry: { type: "Point", coordinates: [18.268441, 49.850552] },
              properties: { zast_jm: "Hlavní nádraží", sloupek_jm: "nástupní TRAM", bezbarier: "NE" }
            }
          ]
        })
      )
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes("test_geojson.zip") ? staticGeojsonPayload : url.includes("test_gtfs_b.zip") ? staticPayloadB : staticPayloadA;
      return new Response(payload, { status: 200, headers: { "content-type": "application/zip" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const staticApp = await createApp({
      ...config,
      cacheTtlSeconds: 0,
      enabledSources: ["public_transit_static"],
      publicTransitStaticGtfsFeeds: [
        { systemId: "test_gtfs", label: "Test GTFS", url: "https://example.test/transit/test_gtfs.zip" },
        { systemId: "test_gtfs_b", label: "Test GTFS B", url: "https://example.test/transit/test_gtfs_b.zip" }
      ],
      publicTransitStaticGeojsonFeeds: [{ systemId: "test_geojson", label: "Test GeoJSON", url: "https://example.test/transit/test_geojson.zip" }]
    });

    const first = await request(staticApp.app)
      .get("/api/v1/features?bbox=13.9,50.5,14.2,50.8&layers=traffic&source=public_transit_static&limit=20")
      .expect(200);
    const second = await request(staticApp.app)
      .get("/api/v1/features?bbox=13.9,50.5,14.2,50.8&layers=traffic&source=public_transit_static&limit=21")
      .expect(200);
    const pragueStops = await request(staticApp.app)
      .get("/api/v1/features?bbox=14.3,50.0,14.6,50.2&layers=traffic&source=public_transit_static&limit=5000")
      .expect(200);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(first.body.features).toHaveLength(1);
    expect(second.body.features).toHaveLength(1);
    expect(pragueStops.body.query.limit).toBe(5000);
    expect(pragueStops.body.features).toHaveLength(1);
    expect(pragueStops.body.features[0]).toEqual(
      expect.objectContaining({
        id: "traffic:public_transit_static:test_gtfs:P1",
        properties: expect.objectContaining({
          sourceId: "public_transit_static",
          layerId: "public.traffic.transit_stops",
          providerLayerId: "traffic.public_transit_static",
          label: "Praha hlavní nádraží"
        })
      })
    );
    expect(first.body.features[0]).toEqual(
      expect.objectContaining({
        id: "traffic:public_transit_static:test_gtfs:U1",
        properties: expect.objectContaining({
          sourceId: "public_transit_static",
          layerId: "public.traffic.transit_stops",
          providerLayerId: "traffic.public_transit_static",
          category: "public_transport_stop",
          label: "Ústí nad Labem hlavní nádraží",
          transportMode: "public_transport",
          tags: expect.objectContaining({
            sourceSystem: "test_gtfs",
            stopId: "U1",
            stopCode: "1001",
            positionKind: "static_stop",
            livePosition: "false"
          }),
          providerProperties: expect.objectContaining({
            transit: expect.objectContaining({
              systemId: "test_gtfs",
              sourceId: "public_transit_static",
              positionKind: "static_stop",
              livePosition: false,
              motionExpected: false,
              refreshSeconds: 21600,
              cacheTtlSeconds: 21600,
              stopId: "U1",
              stopName: "Ústí nad Labem hlavní nádraží",
              staticOnly: true,
              detailAvailable: true,
              detailUrl: "/situation-data/api/v1/transit/stops/test_gtfs/U1?source=public_transit_static"
            })
          })
        })
      })
    );

    const stopDetail = await request(staticApp.app).get("/api/v1/transit/stops/test_gtfs/U1?date=2026-05-28&time=07:55:00&maxDepartures=5").expect(200);
    expect(stopDetail.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-transit-stop-detail-v1",
        sourceId: "public_transit_static",
        systemId: "test_gtfs",
        stop: expect.objectContaining({ stopId: "U1", stopName: "Ústí nad Labem hlavní nádraží" }),
        routes: [expect.objectContaining({ routeId: "L1", routeShortName: "10", transportMode: "bus" })],
        departures: [
          expect.objectContaining({
            tripId: "T1",
            routeId: "L1",
            routeShortName: "10",
            scheduledDeparture: "08:00:00",
            minutesFromQueryTime: 5,
            destination: "Centrum"
          })
        ],
        quality: expect.objectContaining({ staticModelAvailable: true, scheduleAvailable: true })
      })
    );

    const departures = await request(staticApp.app).get("/api/v1/transit/stops/test_gtfs/U1/departures?date=20260528&time=07:59:00").expect(200);
    expect(departures.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-transit-stop-departures-v1",
        departures: [expect.objectContaining({ tripId: "T1", routeId: "L1", scheduledDeparture: "08:00:00" })]
      })
    );

    const routeDetail = await request(staticApp.app).get("/api/v1/transit/routes/test_gtfs/L1?includeShape=true&maxShapePoints=10").expect(200);
    expect(routeDetail.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-transit-route-detail-v1",
        route: expect.objectContaining({ routeId: "L1", routeShortName: "10" }),
        trips: [expect.objectContaining({ tripId: "T1", destination: "Centrum" })],
        stops: [expect.objectContaining({ stopId: "U1" }), expect.objectContaining({ stopId: "P1" })],
        routeShape: expect.objectContaining({
          shapeId: "SH1",
          coordinates: [
            [14.0447, 50.6593],
            [14.4355, 50.0832]
          ],
          truncated: false
        })
      })
    );

    const tripDetail = await request(staticApp.app).get("/api/v1/transit/trips/test_gtfs/T1?includeShape=true&maxStopTimes=5&maxShapePoints=10").expect(200);
    expect(tripDetail.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-transit-trip-detail-v1",
        trip: expect.objectContaining({ tripId: "T1", routeId: "L1", destination: "Centrum" }),
        stopTimes: [
          expect.objectContaining({ stopId: "U1", scheduledDeparture: "08:00:00" }),
          expect.objectContaining({ stopId: "P1", scheduledDeparture: "08:05:00" })
        ],
        routeShape: expect.objectContaining({ shapeId: "SH1", truncated: false })
      })
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("projects Správa železnic train positions from a 15-minute source-level cache", async () => {
    const encoded = encodeSpravaZeleznicTestPayload([
      {
        type: "Feature",
        id: "TR/1154/KASO---25301/00/2026/20260630",
        g: { type: "Point", c: [-699292.5296080904, -1145127.4765034965] },
        p: {
          id: "TR/1154/KASO---25301/00/2026/20260630",
          tt: "R",
          tn: "654",
          na: "Rožmberk",
          fn: "Brno hl.n.",
          ln: "Č.Budějovice os.n.",
          cna: "Počátky-Žirovnice",
          de: 13,
          a: 203.04,
          nna: "hr.VUSC 0310/0630 04",
          d: "České dráhy, a.s.",
          cp: "18:34",
          cr: "18:47",
          pde: "13 min",
          nsn: "Jindřichův Hradec",
          nsn70: "74362",
          nst: "18:56",
          nsp: "19:09",
          zst_sr70: "757633"
        }
      }
    ]);
    const fetchMock = vi.fn(async () => jsonResponse({ cachedResult: false, result: [encoded] }));
    vi.stubGlobal("fetch", fetchMock);
    const trainsApp = await createApp({
      ...config,
      cacheTtlSeconds: 0,
      enabledSources: ["spravazeleznic_trains"]
    });

    const first = await request(trainsApp.app)
      .get("/api/v1/features?bbox=12.0,48.0,19.0,51.5&layers=traffic&source=spravazeleznic_trains&limit=20&includeRaw=true")
      .expect(200);
    const second = await request(trainsApp.app)
      .get("/api/v1/features?bbox=12.0,48.0,19.0,51.5&layers=traffic&source=spravazeleznic_trains&limit=21")
      .expect(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.body.features).toHaveLength(1);
    expect(second.body.features).toHaveLength(1);
    const coordinates = first.body.features[0].geometry.coordinates as [number, number];
    expect(coordinates[0]).toBeGreaterThan(14);
    expect(coordinates[0]).toBeLessThan(16);
    expect(coordinates[1]).toBeGreaterThan(48);
    expect(coordinates[1]).toBeLessThan(50);
    expect(first.body.features[0]).toEqual(
      expect.objectContaining({
        id: "traffic:spravazeleznic_trains:TR_1154_KASO---25301_00_2026_20260630",
        properties: expect.objectContaining({
          sourceId: "spravazeleznic_trains",
          layerId: "public.traffic.transit",
          providerLayerId: "traffic.spravazeleznic_trains",
          category: "public_transport_train",
          transportMode: "train",
          routeShortName: "R 654",
          destination: "Č.Budějovice os.n.",
          delaySeconds: 780,
          vehicleId: "TR/1154/KASO---25301/00/2026/20260630",
          operator: "České dráhy, a.s.",
          headingDeg: expect.any(Number),
          metrics: expect.objectContaining({ delayMinutes: 13, delaySeconds: 780 }),
          tags: expect.objectContaining({
            trainType: "R",
            trainNumber: "654",
            trainName: "Rožmberk",
            currentStationName: "Počátky-Žirovnice",
            nextStationName: "Jindřichův Hradec",
            delayText: "13 min",
            positionKind: "vehicle_live_cached",
            livePosition: "true"
          }),
          providerProperties: expect.objectContaining({
            transit: expect.objectContaining({
              systemId: "spravazeleznic",
              sourceId: "spravazeleznic_trains",
              positionKind: "vehicle_live_cached",
              livePosition: true,
              motionExpected: true,
              refreshSeconds: 900,
              cacheTtlSeconds: 900,
              refreshLimitation: "SIM enforces the agreed minimum upstream polling interval of 15 minutes for Správa železnic.",
              transportMode: "train",
              routeShortName: "R 654",
              delayMinutes: 13,
              delaySeconds: 780,
              detailAvailable: true,
              detailUrl:
                "/situation-data/api/v1/transit/vehicles/traffic%3Aspravazeleznic_trains%3ATR_1154_KASO---25301_00_2026_20260630?source=spravazeleznic_trains"
            }),
            raw: expect.any(Object)
          })
        })
      })
    );

    const detail = await request(trainsApp.app)
      .get("/api/v1/transit/vehicles/traffic%3Aspravazeleznic_trains%3ATR_1154_KASO---25301_00_2026_20260630?source=spravazeleznic_trains")
      .expect(200);
    expect(detail.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-transit-vehicle-detail-v1",
        sourceId: "spravazeleznic_trains",
        systemId: "spravazeleznic",
        trip: expect.objectContaining({
          routeShortName: "R 654",
          destination: "Č.Budějovice os.n.",
          delaySeconds: 780,
          status: "delayed"
        }),
        stopTimes: [
          expect.objectContaining({
            stopName: "Počátky-Žirovnice",
            relationToVehicle: "current"
          }),
          expect.objectContaining({
            stopName: "Jindřichův Hradec",
            relationToVehicle: "next"
          })
        ],
        quality: expect.objectContaining({
          realtimeVehicleAvailable: true,
          tripUpdateAvailable: true,
          routeShapeAvailable: false
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

    const first = await request(roadApp.app).get("/api/v1/features?bbox=14.0,49.8,14.8,50.3&layers=traffic&source=road_srti_lod&limit=20").expect(200);
    const second = await request(roadApp.app).get("/api/v1/features?bbox=14.0,49.8,14.8,50.3&layers=traffic&source=road_srti_lod&limit=21").expect(200);

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

  it("publishes OSM communication tower viewshed references for COP detail actions", async () => {
    const source = new OsmPostgisSource({
      ...config,
      enabledSources: ["osm_postgis"],
      osmPostgisConnectionString: "postgresql://sim_osm:secret@example.test:5432/sim_osm",
      osmPostgisBackend: "external-postgis"
    });
    (source as unknown as { fetchRows: () => Promise<unknown[]> }).fetchRows = async () => [
      {
        osm_id: "436954796",
        osm_type: "area",
        category: "communications_tower",
        layer: "mobile",
        name: "Test communications tower",
        lon: 14.42,
        lat: 50.08,
        tags: { man_made: "communications_tower", "tower:type": "communication" },
        imported_at: "2026-06-27T00:00:00.000Z"
      }
    ];

    const result = await source.fetchFeatures({
      bbox: { west: 14.41, south: 50.07, east: 14.43, north: 50.09 },
      layers: ["mobile"],
      sourceIds: ["osm_postgis"],
      limit: 10,
      includeRaw: false
    });

    expect(result.features).toHaveLength(1);
    expect(result.features[0]).toEqual(
      expect.objectContaining({
        id: "mobile:osm_postgis:area:436954796:communications_tower",
        properties: expect.objectContaining({
          layer: "mobile",
          sourceId: "osm_postgis",
          category: "communications_tower",
          btsStatus: "unknown",
          operatorStatusAvailable: false,
          tags: expect.objectContaining({
            osmType: "area",
            osmId: "436954796",
            viewshedTowerId: "area:436954796",
            referenceOnly: "true"
          }),
          providerProperties: expect.objectContaining({
            mobileCoverage: expect.objectContaining({
              contractVersion: "sim-mobile-coverage-tower-reference-v1",
              towerId: "area:436954796",
              viewshedAvailable: true,
              viewshedUrl: "/situation-data/api/v1/mobile-coverage/towers/area:436954796/viewshed",
              serviceViewshedUrl: "/api/v1/mobile-coverage/towers/area:436954796/viewshed",
              defaultQuery: expect.objectContaining({
                technology: "4G",
                radiusM: 12000,
                azimuthStepDeg: 10,
                distanceStepM: 500,
                includeNoSignal: false
              }),
              btsStatus: "operator_feed_unavailable",
              operatorStatusAvailable: false
            })
          })
        })
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
          coordinates: [
            [
              [
                [14.1, 49.8],
                [14.8, 49.8],
                [14.8, 50.3],
                [14.1, 50.3],
                [14.1, 49.8]
              ]
            ]
          ]
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

  it("projects OSM trail routes and trail POIs as dedicated COP layers", async () => {
    const source = new OsmPostgisSource({
      ...config,
      enabledSources: ["osm_postgis"],
      osmPostgisConnectionString: "postgresql://sim_osm:secret@example.test:5432/sim_osm",
      osmPostgisBackend: "external-postgis"
    });
    (source as unknown as { fetchTrailRouteRows: () => Promise<unknown[]> }).fetchTrailRouteRows = async () => [
      {
        osm_id: "123456",
        osm_type: "relation",
        route_mode: "hiking",
        network: "nwn",
        name: "Testovací hřebenovka",
        ref: "T1",
        operator: "KČT",
        osmc_symbol: "red:white:red_bar",
        segment_count: 12,
        length_km: 42.4,
        geometry_geojson: {
          type: "MultiLineString",
          coordinates: [
            [
              [14.0, 50.0],
              [14.2, 50.1]
            ]
          ]
        },
        geometry_detail: "full",
        simplification_degrees: 0,
        generalization_m: 0,
        tags: { route: "hiking", network: "nwn", name: "Testovací hřebenovka", phone: "+420123456789" },
        imported_at: "2026-07-01T08:00:00.000Z"
      }
    ];
    (source as unknown as { fetchTrailPoiRows: () => Promise<unknown[]> }).fetchTrailPoiRows = async () => [
      {
        osm_id: "987654",
        osm_type: "node",
        category: "water",
        name: "Studánka",
        lon: 14.1,
        lat: 50.05,
        tags: { amenity: "drinking_water", opening_hours: "24/7", website: "https://example.test", phone: "+420123456789" },
        imported_at: "2026-07-01T08:00:00.000Z"
      }
    ];

    const result = await source.fetchFeatures({
      bbox: { west: 13.9, south: 49.9, east: 14.3, north: 50.2 },
      layers: ["trail_routes", "trail_poi"],
      sourceIds: ["osm_postgis"],
      limit: 20,
      includeRaw: true
    });

    expect(result.features).toHaveLength(2);
    expect(result.features[0]).toEqual(
      expect.objectContaining({
        geometry: expect.objectContaining({ type: "MultiLineString" }),
        properties: expect.objectContaining({
          layer: "trail_routes",
          category: "hiking_route",
          label: "Testovací hřebenovka",
          styleHint: "trail-route-osm-v1",
          metrics: expect.objectContaining({ lengthKm: 42.4, segmentCount: 12 }),
          providerProperties: expect.objectContaining({
            trail: expect.objectContaining({
              contractVersion: "sim-osm-trail-route-v1",
              mode: "hiking",
              network: "nwn",
              ref: "T1",
              geometryDetail: "full",
              generalizationM: 0,
              license: "ODbL 1.0"
            })
          })
        })
      })
    );
    expect(JSON.stringify(result.features[0].properties.raw)).not.toContain("+420123456789");
    expect(result.features[1]).toEqual(
      expect.objectContaining({
        geometry: expect.objectContaining({ type: "Point", coordinates: [14.1, 50.05] }),
        properties: expect.objectContaining({
          layer: "trail_poi",
          category: "water",
          label: "Studánka",
          iconHint: "trail-water",
          providerProperties: expect.objectContaining({
            trailPoi: expect.objectContaining({
              contractVersion: "sim-osm-trail-poi-v1",
              category: "water",
              openingHours: "24/7",
              website: "https://example.test",
              mayDisplayContact: false
            })
          })
        })
      })
    );
    expect(JSON.stringify(result.features[1].properties.raw)).not.toContain("+420123456789");
  });

  it("projects OSM community context as a dedicated outdoor layer", async () => {
    const source = new CommunityContextSource({
      ...config,
      enabledSources: ["community_context"],
      osmPostgisConnectionString: "postgresql://sim_osm:secret@example.test:5432/sim_osm",
      osmPostgisBackend: "external-postgis"
    });
    (source as unknown as { fetchRows: () => Promise<unknown[]> }).fetchRows = async () => [
      {
        osm_id: "123",
        osm_type: "node",
        category: "toilets",
        name: "Veřejné WC",
        lon: 14.1,
        lat: 50.05,
        tags: { amenity: "toilets", wheelchair: "yes", fee: "no", opening_hours: "24/7", phone: "+420123456789" },
        imported_at: "2026-07-05T08:00:00.000Z"
      }
    ];

    const result = await source.fetchFeatures({
      bbox: { west: 14.0, south: 50.0, east: 14.2, north: 50.1 },
      layers: ["community_places"],
      sourceIds: ["community_context"],
      limit: 20,
      includeRaw: true
    });

    expect(result.features).toHaveLength(1);
    expect(result.features[0]).toEqual(
      expect.objectContaining({
        id: "community_places:osm_postgis:node:123:toilet",
        geometry: expect.objectContaining({ type: "Point", coordinates: [14.1, 50.05] }),
        properties: expect.objectContaining({
          layer: "community_places",
          sourceId: "community_context",
          category: "toilet",
          label: "Veřejné WC",
          labelLocalized: expect.objectContaining({ cs: "Veřejné WC", en: "Veřejné WC" }),
          styleHint: "community-place-osm-v1",
          iconHint: "community-toilet",
          dataQuality: "observed",
          tags: expect.objectContaining({
            communityStatus: "reference_only",
            sourceAuthority: "reference",
            rawCategory: "toilets"
          }),
          providerProperties: expect.objectContaining({
            community: expect.objectContaining({
              contractVersion: "sim-community-context-v1",
              sourceAuthority: "reference",
              communityStatus: "reference_only",
              category: "toilet",
              categoryGroup: "sanitation",
              openingHours: "24/7",
              wheelchair: "yes",
              fee: "no",
              canAcceptContributions: true,
              acceptedContributionTypes: ["photo", "review", "status_report", "proposed_edit"],
              moderationRequired: true,
              mayDisplayContact: false
            }),
            display: expect.objectContaining({
              styleProfile: "community-place-osm-v1",
              icon: "community-toilet",
              minZoomHint: 13
            })
          })
        })
      })
    );
    expect(JSON.stringify(result.features[0].properties.raw)).not.toContain("+420123456789");
  });

  it("keeps police and fire stations out of the OSM trail POI read model", () => {
    const sql = readFileSync(new URL("../../../deploy/osm/osm-trail-poi-view.sql", import.meta.url), "utf8");

    expect(sql).not.toContain("tags->'amenity' in ('police', 'fire_station')");
    expect(sql).not.toContain("tags->'emergency' in ('ambulance_station'");
    expect(sql).toContain("tags->'highway' = 'emergency_access_point'");
    expect(sql).toContain("'defibrillator'");
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

  it("caches repeated radio planning responses and exposes cache telemetry", async () => {
    const linkPayload = {
      profileId: "pmr446_handheld",
      radioName: "PMR tym A",
      from: { lon: 14.42, lat: 50.08, antennaHeightM: 1.5 },
      to: { lon: 14.425, lat: 50.085, receiverHeightM: 1.5 }
    };
    const coveragePayload = {
      profileId: "pmr446_handheld",
      station: { lon: 14.42, lat: 50.08, antennaHeightM: 1.5 },
      radiusM: 500,
      azimuthStepDeg: 90,
      distanceStepM: 250
    };
    const siteSearchPayload = {
      profileId: "pmr446_handheld",
      searchArea: { bbox: [14.418, 50.078, 14.424, 50.084] },
      targets: [{ lon: 14.425, lat: 50.085, receiverHeightM: 1.5 }],
      gridStepM: 500,
      maxCandidates: 3
    };

    const firstLink = await request(app).post("/api/v1/radio/link-check").send(linkPayload).expect(200);
    const secondLink = await request(app).post("/api/v1/radio/link-check").send(linkPayload).expect(200);
    const firstCoverage = await request(app).post("/api/v1/radio/coverage").send(coveragePayload).expect(200);
    const secondCoverage = await request(app).post("/api/v1/radio/coverage").send(coveragePayload).expect(200);
    const firstSiteSearch = await request(app).post("/api/v1/radio/site-search").send(siteSearchPayload).expect(200);
    const secondSiteSearch = await request(app).post("/api/v1/radio/site-search").send(siteSearchPayload).expect(200);

    expect(secondLink.body.generatedAt).toBe(firstLink.body.generatedAt);
    expect(secondCoverage.body.generatedAt).toBe(firstCoverage.body.generatedAt);
    expect(secondSiteSearch.body.generatedAt).toBe(firstSiteSearch.body.generatedAt);

    const observability = await request(app).get("/api/v1/observability").expect(200);
    expect(observability.body.radioPlanningCaches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "link_check", cache: expect.objectContaining({ hits: 1, misses: 1 }) }),
        expect.objectContaining({ operation: "coverage", cache: expect.objectContaining({ hits: 1, misses: 1 }) }),
        expect.objectContaining({ operation: "site_search", cache: expect.objectContaining({ hits: 1, misses: 1 }) })
      ])
    );

    const metrics = await request(app).get("/metrics").expect(200);
    expect(metrics.text).toContain('situation_data_radio_planning_cache_hits{operation="link_check"} 1');
    expect(metrics.text).toContain('situation_data_radio_planning_cache_hits{operation="coverage"} 1');
    expect(metrics.text).toContain('situation_data_radio_planning_cache_hits{operation="site_search"} 1');
  });

  it("exposes emergency routing profiles and direct fallback responses", async () => {
    const catalog = await request(app).get("/api/v1/routing/profiles").expect(200);
    expect(catalog.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-routing-profile-catalog-v1",
        backend: expect.objectContaining({ backend: "unconfigured", graphTable: "public.osm_roads" }),
        profiles: expect.arrayContaining([
          expect.objectContaining({ profileId: "emergency_vehicle", transportMode: "road" }),
          expect.objectContaining({ profileId: "large_emergency_vehicle", transportMode: "road" }),
          expect.objectContaining({ profileId: "evacuation_walking", transportMode: "walk" })
        ])
      })
    );

    const payload = {
      profileId: "emergency_vehicle",
      from: { lon: 14.42, lat: 50.08, label: "Start" },
      to: { lon: 14.45, lat: 50.1, label: "Cíl" },
      avoid: ["flood", "road_closure"]
    };
    const route = await request(app).post("/api/v1/routing/route").send(payload).expect(200);
    expect(route.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-routing-route-v1",
        profile: expect.objectContaining({ profileId: "emergency_vehicle" }),
        routes: [
          expect.objectContaining({
            status: "partial",
            geometry: expect.objectContaining({ type: "LineString" }),
            distanceM: expect.any(Number),
            durationSeconds: expect.any(Number),
            quality: expect.objectContaining({ mode: "direct_fallback", fallbackReason: expect.stringContaining("OSM_POSTGIS_DATABASE_URL") })
          })
        ],
        features: [
          expect.objectContaining({
            geometry: expect.objectContaining({ type: "LineString" }),
            properties: expect.objectContaining({ styleHint: "routing-primary-v1" })
          })
        ]
      })
    );

    const secondRoute = await request(app).post("/api/v1/routing/route").send(payload).expect(200);
    expect(secondRoute.body.generatedAt).toBe(route.body.generatedAt);

    const isochrone = await request(app)
      .post("/api/v1/routing/isochrone")
      .send({ profileId: "evacuation_walking", origin: { lon: 14.42, lat: 50.08 }, maxTravelTimeMinutes: 10 })
      .expect(200);
    expect(isochrone.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-routing-isochrone-v1",
        features: [expect.objectContaining({ geometry: expect.objectContaining({ type: "Polygon" }) })]
      })
    );

    const nearest = await request(app)
      .post("/api/v1/routing/nearest-access")
      .send({ profileId: "emergency_vehicle", point: { lon: 14.42, lat: 50.08 } })
      .expect(200);
    expect(nearest.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-routing-nearest-access-v1",
        profile: expect.objectContaining({ profileId: "emergency_vehicle" }),
        features: []
      })
    );

    const observability = await request(app).get("/api/v1/observability").expect(200);
    expect(observability.body.routingCaches).toEqual(
      expect.arrayContaining([expect.objectContaining({ operation: "route", cache: expect.objectContaining({ hits: 1, misses: 1 }) })])
    );
    const metrics = await request(app).get("/metrics").expect(200);
    expect(metrics.text).toContain('situation_data_routing_cache_hits{operation="route"} 1');
  });

  it("exposes normalized search-data provider contract for COP AI indexing", async () => {
    const taxonomy = await request(app).get("/search-data/api/v1/taxonomy").expect(200);
    expect(taxonomy.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-search-source-v1",
        providerId: "sim.search-data",
        entityTypes: expect.arrayContaining([
          expect.objectContaining({ entityType: "police_station", layerIds: ["public.security.police"] }),
          expect.objectContaining({ entityType: "fire_station", layerIds: ["public.security.fire_station"] }),
          expect.objectContaining({ entityType: "weather_forecast", layerIds: ["public.weather.forecast_area"], sourceSystems: ["weather_forecast"] }),
          expect.objectContaining({ entityType: "weather_nowcast", layerIds: ["public.weather.radar_nowcast"], sourceSystems: ["chmi_weather_radar"] }),
          expect.objectContaining({ entityType: "weather_radar", layerIds: ["public.weather.radar_reflectivity", "public.weather.radar_precipitation"] }),
          expect.objectContaining({ entityType: "thunderstorm_risk", layerIds: ["public.safety.thunderstorm_risk"] }),
          expect.objectContaining({ entityType: "weather_warning", layerIds: ["public.safety.weather_alerts"] })
        ]),
        sourceAuthorities: expect.arrayContaining(["official", "reference", "modelled"]),
        dataQualities: expect.arrayContaining(["official_observed", "verified_reference", "modelled"])
      })
    );

    const feed = await request(app).get("/search-data/api/v1/entities?entityTypes=police_station,fire_station&limit=5&includeDeleted=true").expect(200);
    expect(feed.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-search-source-v1",
        providerId: "sim.search-data",
        query: expect.objectContaining({
          limit: 5,
          entityTypes: ["police_station", "fire_station"],
          includeDeleted: true
        }),
        summary: expect.objectContaining({
          returnedCount: 0,
          deletedCount: 0,
          warningCount: expect.any(Number)
        }),
        entities: [],
        warnings: expect.arrayContaining([expect.stringContaining("includeDeleted")])
      })
    );

    const secondFeed = await request(app).get("/search-data/api/v1/entities?entityTypes=police_station,fire_station&limit=5&includeDeleted=true").expect(200);
    expect(secondFeed.body.generatedAt).toBe(feed.body.generatedAt);

    const query = await request(app)
      .post("/search-data/api/v1/query")
      .send({
        text: "policie Vrbno",
        entityTypes: ["police_station", "fire_station"],
        sourceSystems: ["osm_reference"],
        center: { lat: 50.1201, lon: 17.3832 },
        radiusM: 25000,
        includeStale: false,
        limit: 10
      })
      .expect(200);
    expect(query.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-search-source-v1",
        providerId: "sim.search-data",
        query: expect.objectContaining({ limit: 10, sourceSystems: ["osm_reference"] }),
        summary: expect.objectContaining({ returnedCount: 0 }),
        entities: []
      })
    );

    const observability = await request(app).get("/search-data/api/v1/observability").expect(200);
    expect(observability.body).toEqual(
      expect.objectContaining({
        serviceId: "search-data-api",
        contractVersion: "sim-search-source-v1",
        providerId: "sim.search-data",
        status: "ok",
        dataQualityStatus: "degraded",
        degradedSourceCount: expect.any(Number),
        sources: expect.arrayContaining([
          expect.objectContaining({ sourceSystem: "osm_reference", status: "degraded" }),
          expect.objectContaining({ sourceSystem: "safety_data", status: "degraded" }),
          expect.objectContaining({ sourceSystem: "weather_forecast", status: "degraded" }),
          expect.objectContaining({ sourceSystem: "chmi_weather_radar", status: "degraded" })
        ]),
        capabilities: expect.objectContaining({
          incrementalSync: true,
          cursorPagination: true,
          providerLocalQuery: true,
          browserDirectAccess: false
        })
      })
    );

    const alias = await request(app).get("/api/v1/search-data/taxonomy").expect(200);
    expect(alias.body.contractVersion).toBe("sim-search-source-v1");

    const metrics = await request(app).get("/metrics").expect(200);
    expect(metrics.text).toContain("search_data_cache_hits 1");
    expect(metrics.text).toContain("search_data_cache_misses 1");
  });

  it("adds forecast weather context to search-data for deterministic COP AI answers", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://api.open-meteo-search.test/v1/forecast")) {
        return jsonResponse({
          current: {
            time: "2099-07-05T20:00",
            temperature_2m: 19.4,
            relative_humidity_2m: 84,
            precipitation: 0.2,
            weather_code: 95,
            cloud_cover: 91,
            wind_speed_10m: 4.8,
            wind_direction_10m: 238,
            wind_gusts_10m: 13.1
          },
          hourly: {
            time: ["2099-07-05T20:00", "2099-07-05T21:00", "2099-07-05T22:00"],
            temperature_2m: [19.4, 18.9, 18.1],
            relative_humidity_2m: [84, 86, 89],
            precipitation: [1.8, 3.2, 0.7],
            precipitation_probability: [76, 82, 54],
            weather_code: [95, 96, 61],
            cloud_cover: [91, 94, 87],
            wind_speed_10m: [4.8, 5.6, 4.1],
            wind_direction_10m: [238, 241, 248],
            wind_gusts_10m: [13.1, 17.4, 10.2]
          },
          daily: {
            time: ["2099-07-05"],
            weather_code: [95],
            temperature_2m_max: [24.1],
            temperature_2m_min: [15.2],
            precipitation_sum: [7.2],
            precipitation_probability_max: [82],
            wind_gusts_10m_max: [17.4]
          }
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const forecastApp = await createApp({
      ...config,
      enabledSources: ["weather_forecast"],
      openMeteoBaseUrl: "https://api.open-meteo-search.test"
    });

    const response = await request(forecastApp.app)
      .post("/search-data/api/v1/query")
      .send({
        text: "bude pršet bouřka srážky",
        entityTypes: ["weather_forecast"],
        sourceSystems: ["weather_forecast"],
        center: { lat: 50.1001, lon: 14.1001 },
        radiusM: 5000,
        limit: 5
      })
      .expect(200);

    expect(response.body.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: "weather_forecast",
          sourceSystem: "weather_forecast",
          handling: expect.arrayContaining(["dynamic_data_requires_timestamp"]),
          observedAt: "2099-07-05T20:00:00.000Z",
          validFrom: "2099-07-05T20:00:00.000Z",
          validUntil: expect.any(String),
          metrics: expect.objectContaining({
            precipitationNext10MinMm: 0.3,
            precipitationNext1hMm: 1.8,
            precipitationProbabilityNext1hPercent: 76,
            precipitationNext3hMm: 5.7,
            thunderstormProbabilityPercent: 70,
            windGustMps: 13.1,
            lightningStrikeFeedAvailable: false
          }),
          providerProperties: expect.objectContaining({
            display: expect.objectContaining({
              detailType: "weather_forecast_meteogram",
              detailUrl: expect.stringContaining("/situation-data/api/v1/weather-forecast/areas/")
            }),
            aiContext: expect.objectContaining({
              dynamicDataRequiresTimestamp: true,
              lightningNearbyAvailable: false
            })
          })
        })
      ])
    );
  });

  it("keeps forecast search-data available through MET Norway fallback when Open-Meteo is rate limited", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const parsed = new URL(String(input));
      if (parsed.hostname === "api.open-meteo-rate-limit.test") {
        return new Response("rate limited", { status: 429 });
      }
      if (parsed.hostname === "api.met-rate-limit.test") {
        return jsonResponse({
          properties: {
            timeseries: [
              {
                time: "2099-07-05T20:00:00Z",
                data: {
                  instant: {
                    details: {
                      air_temperature: 17.6,
                      relative_humidity: 91,
                      cloud_area_fraction: 99,
                      wind_speed: 5.1,
                      wind_from_direction: 240,
                      wind_speed_of_gust: 14.2
                    }
                  },
                  next_1_hours: {
                    summary: { symbol_code: "rainshowersandthunder" },
                    details: { precipitation_amount: 2.4 }
                  }
                }
              },
              {
                time: "2099-07-05T21:00:00Z",
                data: {
                  instant: {
                    details: {
                      air_temperature: 17.1,
                      relative_humidity: 94,
                      cloud_area_fraction: 100,
                      wind_speed: 4.7,
                      wind_from_direction: 245,
                      wind_speed_of_gust: 13.5
                    }
                  },
                  next_1_hours: {
                    summary: { symbol_code: "rain" },
                    details: { precipitation_amount: 1.1 }
                  }
                }
              }
            ]
          }
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const forecastApp = await createApp({
      ...config,
      enabledSources: ["weather_forecast"],
      openMeteoBaseUrl: "https://api.open-meteo-rate-limit.test",
      metNorwayBaseUrl: "https://api.met-rate-limit.test"
    });

    const response = await request(forecastApp.app)
      .post("/search-data/api/v1/query")
      .send({
        text: "bude pršet bouřka srážky",
        entityTypes: ["weather_forecast"],
        sourceSystems: ["weather_forecast"],
        center: { lat: 50.1001, lon: 14.1001 },
        radiusM: 5000,
        limit: 5
      })
      .expect(200);

    expect(response.body.entities[0]).toEqual(
      expect.objectContaining({
        entityType: "weather_forecast",
        observedAt: "2099-07-05T20:00:00.000Z",
        metrics: expect.objectContaining({
          precipitationNext10MinMm: 0.4,
          precipitationNext1hMm: 2.4,
          precipitationNext3hMm: 3.5,
          thunderstormProbabilityPercent: 70,
          windGustMps: 14.2,
          lightningStrikeFeedAvailable: false
        }),
        providerProperties: expect.objectContaining({
          weatherForecast: expect.objectContaining({
            fallbackUsed: true,
            sourceInputs: ["met_norway_locationforecast"],
            providerWarning: expect.stringContaining("Open-Meteo forecast unavailable")
          })
        })
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
          disclaimer: expect.stringContaining("estimate"),
          rendering: expect.objectContaining({ mode: "feature", geometryRole: "grid_cell" }),
          styleHint: "mobile-coverage-diagnostic-v1",
          tags: expect.objectContaining({ renderAs: "coverage_grid_cell", renderPolicy: "quality_fill" }),
          providerProperties: expect.objectContaining({
            display: expect.objectContaining({
              contractVersion: "sim-mobile-coverage-display-v1",
              renderer: "mobile_coverage_grid_cell_v1",
              renderOnly: true,
              style: expect.objectContaining({ fillColor: expect.any(String), fillOpacity: expect.any(Number) })
            })
          })
        })
      })
    );
    expect(result.features[0].properties.raw).toBeUndefined();
  });

  it("maps prepared mobile coverage read-model cells with display-ready styling", async () => {
    const source = new MobileCoverageSource({
      ...config,
      enabledSources: ["mobile_coverage_model"],
      osmPostgisConnectionString: "postgresql://sim_osm:secret@example.test:5432/sim_osm",
      osmPostgisBackend: "external-postgis"
    });

    const feature = (
      source as unknown as {
        readModelFeature: (row: Record<string, unknown>) => { properties: Record<string, unknown> } | undefined;
      }
    ).readModelFeature({
      feature_id: "coverage:mobile:4g:prepared",
      model_version: "coverage-v2-terrain",
      technology: "4G",
      operator: "unknown",
      quality: "fair",
      estimated_signal_dbm: -96,
      confidence: 0.7,
      resolution_m: 1000,
      dem_dataset_id: "copernicus-glo30-cz",
      generated_at: "2026-06-27T00:00:00.000Z",
      expires_at: "2026-07-04T00:00:00.000Z",
      assumptions: { terrainApplied: true },
      metrics: { terrainPenaltyDb: 4, terrainMaxObstructionM: 2, distanceToNearestTowerM: 1200 },
      tags: { nearestTowerId: "node:1" },
      data_quality: "modelled",
      bts_status: "operator_feed_unavailable",
      bts_status_source: "none",
      operator_status_available: false,
      source_revision: "model=coverage-v2-terrain",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [14.41, 50.07],
            [14.43, 50.07],
            [14.43, 50.09],
            [14.41, 50.09],
            [14.41, 50.07]
          ]
        ]
      }
    });

    expect(feature?.properties).toEqual(
      expect.objectContaining({
        layer: "mobile_coverage",
        quality: "fair",
        estimatedSignalDbm: -96,
        rendering: expect.objectContaining({ mode: "feature", geometryRole: "grid_cell" }),
        styleHint: "mobile-coverage-diagnostic-v1",
        tags: expect.objectContaining({ nearestTowerId: "node:1", renderAs: "coverage_grid_cell" }),
        providerProperties: expect.objectContaining({
          display: expect.objectContaining({
            contractVersion: "sim-mobile-coverage-display-v1",
            primaryValue: "-96 dBm",
            secondaryValue: "4 dB terrain loss",
            style: expect.objectContaining({ fillColor: "#eab308" })
          })
        })
      })
    );
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

  it("looks up OSM area tower ids for per-tower mobile coverage viewsheds", async () => {
    const source = new MobileCoverageSource({
      ...config,
      enabledSources: ["mobile_coverage_model"],
      osmPostgisConnectionString: "postgresql://sim_osm:secret@example.test:5432/sim_osm",
      osmPostgisBackend: "external-postgis"
    });
    const queryMock = vi.fn(async (_sql: string, params: unknown[]) => {
      expect(params).toEqual(["area", "436954796"]);
      return {
        rows: [
          {
            osm_id: "436954796",
            osm_type: "area",
            name: "Test area tower",
            lon: 14.42,
            lat: 50.08,
            tags: { operator: "unknown", "tower:type": "communication" }
          }
        ]
      };
    });
    (source as unknown as { getPool: () => { query: typeof queryMock } }).getPool = () => ({ query: queryMock });

    const result = await source.buildTowerViewshed({
      towerId: "area:436954796",
      technology: "4G",
      radiusM: 1000,
      azimuthStepDeg: 180,
      distanceStepM: 500
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(
      expect.objectContaining({
        contractVersion: "sim-mobile-coverage-tower-viewshed-v1",
        tower: expect.objectContaining({
          towerId: "area:436954796",
          name: "Test area tower"
        }),
        features: expect.any(Array)
      })
    );
  });

  it("omits no-signal tower viewshed sectors by default while keeping diagnostic counts", async () => {
    const source = new MobileCoverageSource({
      ...config,
      enabledSources: ["mobile_coverage_model"],
      osmPostgisConnectionString: "postgresql://sim_osm:secret@example.test:5432/sim_osm",
      osmPostgisBackend: "external-postgis"
    });
    (source as unknown as { fetchTowerById: () => Promise<{ id: string; name: string; lon: number; lat: number; operator: string }> }).fetchTowerById =
      async () => ({ id: "node:1", name: "Test tower", lon: 14.42, lat: 50.08, operator: "unknown" });

    const defaultResult = await source.buildTowerViewshed({
      towerId: "node:1",
      technology: "4G",
      radiusM: 5000,
      azimuthStepDeg: 180,
      distanceStepM: 1000
    });
    const diagnosticResult = await source.buildTowerViewshed({
      towerId: "node:1",
      technology: "4G",
      radiusM: 5000,
      azimuthStepDeg: 180,
      distanceStepM: 1000,
      includeNoSignal: true
    });

    expect(defaultResult?.query.includeNoSignal).toBe(false);
    expect(defaultResult?.summary).toEqual(
      expect.objectContaining({
        featureCount: 12,
        computedSectorCount: 20,
        omittedNoSignalSectorCount: 8,
        renderPolicy: "coverage_only"
      })
    );
    expect(defaultResult?.summary.qualityCounts.none).toBe(0);
    expect(defaultResult?.summary.computedQualityCounts.none).toBe(8);
    expect(defaultResult?.features.every((feature) => feature.properties.quality !== "none")).toBe(true);
    expect(defaultResult?.features[0].properties.providerProperties?.display).toEqual(
      expect.objectContaining({
        contractVersion: "sim-mobile-coverage-viewshed-display-v1",
        renderOnly: true,
        renderPolicy: "coverage_only",
        style: expect.objectContaining({ fillColor: expect.any(String), fillOpacity: expect.any(Number) })
      })
    );

    expect(diagnosticResult?.query.includeNoSignal).toBe(true);
    expect(diagnosticResult?.summary).toEqual(
      expect.objectContaining({
        featureCount: 20,
        computedSectorCount: 20,
        omittedNoSignalSectorCount: 0,
        renderPolicy: "diagnostic_all_sectors"
      })
    );
    expect(diagnosticResult?.summary.qualityCounts.none).toBe(8);
  });

  it("caches per-tower mobile coverage viewshed responses by normalized query", async () => {
    const source = new MobileCoverageSource({
      ...config,
      enabledSources: ["mobile_coverage_model"],
      osmPostgisConnectionString: "postgresql://sim_osm:secret@example.test:5432/sim_osm",
      osmPostgisBackend: "external-postgis"
    });
    let fetchCount = 0;
    (source as unknown as { fetchTowerById: () => Promise<{ id: string; name: string; lon: number; lat: number; operator: string }> }).fetchTowerById =
      async () => {
        fetchCount += 1;
        return { id: "node:1", name: "Test tower", lon: 14.42, lat: 50.08, operator: "unknown" };
      };

    const first = await source.buildTowerViewshed({
      towerId: "node:1",
      technology: "4G",
      radiusM: 1000,
      azimuthStepDeg: 90,
      distanceStepM: 500
    });
    const second = await source.buildTowerViewshed({
      towerId: "node:1",
      technology: "4G",
      radiusM: 1000,
      azimuthStepDeg: 90,
      distanceStepM: 500
    });
    const diagnostic = await source.buildTowerViewshed({
      towerId: "node:1",
      technology: "4G",
      radiusM: 1000,
      azimuthStepDeg: 90,
      distanceStepM: 500,
      includeNoSignal: true
    });

    expect(fetchCount).toBe(2);
    expect(second?.generatedAt).toBe(first?.generatedAt);
    expect(diagnostic?.query.includeNoSignal).toBe(true);
  });

  it("exposes per-tower mobile coverage viewshed cache metrics", async () => {
    const coverageApp = await createApp({
      ...config,
      enabledSources: [],
      osmPostgisConnectionString: "postgresql://sim_osm:secret@example.test:5432/sim_osm",
      osmPostgisBackend: "external-postgis",
      mobileCoverageTerrainAware: false,
      demEnabled: false
    });
    (
      coverageApp.context.mobileCoverage as unknown as {
        fetchTowerById: () => Promise<{ id: string; name: string; lon: number; lat: number; operator: string }>;
      }
    ).fetchTowerById = async () => ({ id: "node:1", name: "Test tower", lon: 14.42, lat: 50.08, operator: "unknown" });

    const endpoint = "/api/v1/mobile-coverage/towers/node:1/viewshed?technology=4G&radiusM=1000&azimuthStepDeg=90&distanceStepM=500";
    await request(coverageApp.app).get(endpoint).expect(200);
    await request(coverageApp.app).get(endpoint).expect(200);

    const metrics = await request(coverageApp.app).get("/metrics").expect(200);
    expect(metrics.text).toContain('situation_data_source_cache_entries{source="mobile_coverage_model"} 1');
    expect(metrics.text).toContain('situation_data_source_cache_hits{source="mobile_coverage_model"} 1');
    expect(metrics.text).toContain('situation_data_source_cache_misses{source="mobile_coverage_model"} 1');
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
        receiverHeightM: 1.5,
        includeNoSignal: false
      },
      summary: {
        featureCount: 1,
        qualityCounts: { good: 1, fair: 0, weak: 0, none: 0, unknown: 0 },
        computedSectorCount: 1,
        computedQualityCounts: { good: 1, fair: 0, weak: 0, none: 0, unknown: 0 },
        omittedNoSignalSectorCount: 0,
        lineOfSightClearSectorCount: 0,
        lineOfSightBlockedSectorCount: 0,
        lineOfSightUnknownSectorCount: 1,
        renderPolicy: "coverage_only",
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

  it("accepts OSM area tower ids on the per-tower mobile coverage viewshed endpoint", async () => {
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
        towerId: "area:436954796",
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
        receiverHeightM: 1.5,
        includeNoSignal: false
      },
      summary: {
        featureCount: 0,
        qualityCounts: { good: 0, fair: 0, weak: 0, none: 0, unknown: 0 },
        computedSectorCount: 0,
        computedQualityCounts: { good: 0, fair: 0, weak: 0, none: 0, unknown: 0 },
        omittedNoSignalSectorCount: 0,
        lineOfSightClearSectorCount: 0,
        lineOfSightBlockedSectorCount: 0,
        lineOfSightUnknownSectorCount: 0,
        renderPolicy: "coverage_only",
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
      .get("/api/v1/mobile-coverage/towers/area:436954796/viewshed?technology=4G&radiusM=1000&azimuthStepDeg=90&distanceStepM=500")
      .expect(200);

    expect(response.body.tower.towerId).toBe("area:436954796");
    expect(coverageApp.context.mobileCoverage.buildTowerViewshed).toHaveBeenCalledWith(
      expect.objectContaining({
        towerId: "area:436954796",
        technology: "4G"
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
              coordinates: [
                [
                  [14.41, 50.07],
                  [14.43, 50.07],
                  [14.43, 50.09],
                  [14.41, 50.09],
                  [14.41, 50.07]
                ]
              ]
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
                coordinates: [
                  [
                    [14.41, 50.07],
                    [14.43, 50.07],
                    [14.43, 50.09],
                    [14.41, 50.09],
                    [14.41, 50.07]
                  ]
                ]
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
        geometry: expect.objectContaining({ type: "MultiPolygon" }),
        properties: expect.objectContaining({
          sourceId: "mobile_network_model",
          layer: "mobile_network",
          quality: "fair",
          status: expect.stringMatching(/ok|weak_signal|degraded_possible|unknown/),
          styleHint: "mobile-network-assessment-v1",
          rendering: expect.objectContaining({ mode: "feature", geometryRole: "feature_geometry" }),
          providerProperties: expect.objectContaining({
            display: expect.objectContaining({
              renderer: "mobile_network_area_v1",
              renderPolicy: "status_fill",
              style: expect.objectContaining({
                fillColor: expect.any(String),
                fillOpacity: expect.any(Number)
              })
            })
          }),
          dataQuality: "mixed",
          btsStatus: "operator_feed_unavailable",
          operatorStatusAvailable: false,
          basis: expect.arrayContaining(["CTU_NETTEST_MEASUREMENT", "NO_OPERATOR_BTS_STATUS"]),
          metrics: expect.objectContaining({ cellCount: 1, polygonPartCount: 1 }),
          summary: expect.stringContaining("mobilní síť"),
          disclaimer: expect.stringContaining("not a confirmed BTS")
        })
      })
    );
    expect(result.features[0].properties.raw).toBeUndefined();
  });

  it("spatially distributes limited mobile coverage grid cells across the requested bbox", () => {
    const bbox = { west: 10, south: 48, east: 20, north: 52 };
    const features: SituationFeature[] = [];
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 10; x += 1) {
        features.push(coverageGridFeature(x, y));
      }
    }

    const selected = spatiallyLimitFeatures(features, 10, bbox);
    const selectedTags = selected.map((feature) => feature.properties.tags);

    expect(selected).toHaveLength(10);
    expect(new Set(selectedTags.map((tags) => tags?.gridX)).size).toBeGreaterThan(3);
    expect(new Set(selectedTags.map((tags) => tags?.gridY)).size).toBeGreaterThan(3);
    expect(selected.map((feature) => feature.id)).not.toEqual(features.slice(0, 10).map((feature) => feature.id));
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
                coordinates: [
                  [
                    [14.41, 50.07],
                    [14.43, 50.07],
                    [14.43, 50.09],
                    [14.41, 50.09],
                    [14.41, 50.07]
                  ]
                ]
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
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "mobile_network_model ignored coverage polygons that were not backed by a prepared read-model.",
        "mobile_network_model has no prepared read-model coverage cells in the requested area; no synthetic bbox polygon was generated.",
        "CTU measurements are available only as point features in their own sources; mobile_network_model did not convert them to an area polygon."
      ])
    );
  });

  it("keeps layers represented when a low limit is requested", async () => {
    const response = await request(app).get("/api/v1/features?layers=weather,ground,mobile,traffic&source=mock&limit=4").expect(200);

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

function coverageGridFeature(x: number, y: number): SituationFeature {
  const west = 10 + x;
  const south = 48 + y * 0.4;
  const east = west + 0.8;
  const north = south + 0.32;
  return {
    type: "Feature",
    id: `coverage:mobile:4g:test-${x}-${y}`,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south]
        ]
      ]
    },
    properties: {
      featureId: `coverage:mobile:4g:test-${x}-${y}`,
      layer: "mobile_coverage",
      category: "mobile_coverage",
      label: "4G coverage estimate",
      sourceId: "mobile_coverage_model",
      observedAt: "2026-06-28T00:00:00.000Z",
      confidence: 0.5,
      stale: false,
      severity: "info",
      license: { name: "coverage", attribution: "coverage" },
      technology: "4G",
      quality: "unknown",
      tags: { gridX: String(x), gridY: String(y) }
    }
  };
}

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

function encodeSpravaZeleznicTestPayload(value: unknown): string {
  const json = Buffer.from(JSON.stringify(value), "utf8");
  const now = new Date();
  const key = Buffer.from(`${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}`, "utf8");
  const encoded = Buffer.alloc(json.length);
  for (let index = 0; index < json.length; index += 1) {
    encoded[index] = json[index] ^ key[index % key.length];
  }
  return encoded.toString("base64");
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
