import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SafetyAggregationService } from "../src/aggregation.js";
import { createApp } from "../src/app.js";
import type { SafetyDataConfig } from "../src/config.js";
import type { SafetyDataSource } from "../src/sources.js";

describe("Safety Data API contract", () => {
  let dataDir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let config: SafetyDataConfig;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "csm-sim-safety-data-"));
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
      chmiAlertsCapBaseUrl: "https://opendata.chmi.cz/meteorology/weather/alerts/cap/",
      chmiHydroMetadataUrl: "https://opendata.chmi.cz/hydrology/now/metadata/meta1.json",
      chmiHydroNowBaseUrl: "https://opendata.chmi.cz/hydrology/now/data",
      chmiHydroRecentBaseUrl: "https://opendata.chmi.cz/hydrology/recent/data",
      chmiHydroMaxStations: 20,
      chmiHydroDetailDefaultPastHours: 168,
      chmiHydroDetailForecastHours: 72,
      chmiHydroDetailBackfillDays: 0,
      nasaFirmsAreaBaseUrl: "https://firms.modaps.eosdis.nasa.gov/api/area/csv",
      nasaFirmsSource: "VIIRS_SNPP_NRT",
      nasaFirmsDayRange: 1,
      chmiOrpCodelistUrl:
        "https://apl2.czso.cz/iSMS/do_cis_export?cisjaz=203&cisvaz=61_88&format=2&kodcis=65&separator=,&typdat=1",
      adminBoundaryTable: "public.osm_admin_boundary",
      adminBoundaryCacheTtlSeconds: 86_400
    };
    ({ app } = await createApp(config));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("exposes health, layers and source metadata", async () => {
    const health = await request(app).get("/health/ready").expect(200);
    expect(health.body.status).toBe("ok");
    expect(health.body.enabledSources).toEqual(["mock"]);

    const layers = await request(app).get("/api/v1/layers").expect(200);
    expect(layers.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layerId: "weather_alerts", defaultVisible: true }),
        expect.objectContaining({ layerId: "fire", defaultVisible: false }),
        expect.objectContaining({ layerId: "flood", defaultVisible: true }),
        expect.objectContaining({ layerId: "boundary_admin", defaultVisible: false })
      ])
    );

    const sources = await request(app).get("/api/v1/sources").expect(200);
    expect(sources.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "mock",
          enabled: true,
          layers: expect.arrayContaining(["weather_alerts", "fire", "flood", "boundary_admin"])
        }),
        expect.objectContaining({
          sourceId: "chmi_alerts",
          license: expect.objectContaining({ name: "CHMI Open Data" })
        }),
        expect.objectContaining({
          sourceId: "chmi_hydro",
          layers: expect.arrayContaining(["flood"])
        }),
        expect.objectContaining({
          sourceId: "nasa_firms",
          layers: expect.arrayContaining(["fire"])
        }),
        expect.objectContaining({
          sourceId: "admin_boundaries",
          layers: expect.arrayContaining(["boundary_admin"])
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
        hydroMaxStations: 20,
        hydroDetailDefaultPastHours: 168,
        hydroDetailForecastHours: 72,
        hydroDetailBackfillDays: 0,
        providers: expect.arrayContaining([
          expect.objectContaining({ sourceId: "mock", authConfigured: true }),
          expect.objectContaining({ sourceId: "chmi_alerts", authConfigured: true }),
          expect.objectContaining({ sourceId: "chmi_hydro", authConfigured: true }),
          expect.objectContaining({ sourceId: "nasa_firms", authConfigured: false }),
          expect.objectContaining({ sourceId: "admin_boundaries", authConfigured: false })
        ])
      })
    );
    expect(JSON.stringify(response.body)).not.toContain("secret");
  });

  it("exposes provider map catalog metadata for COM", async () => {
    const response = await request(app).get("/api/v1/catalog").expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        contractVersion: "provider-map-catalog-v1",
        catalogVersion: "provider-map-catalog-v1",
        providerId: "sim.safety-data",
        status: "online",
        authority: expect.objectContaining({
          contractVersion: "map-catalog-v1",
          document: expect.stringContaining("02_MAP_CATALOG_PROVIDER_CONTRACT.md")
        })
      })
    );
    expect(response.body.layers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerLayerId: "safety.weather_alerts",
          recommendedCatalogLayerId: "public.safety.weather_alerts",
          categories: expect.arrayContaining(["weather_alert"]),
          role: "overlay",
          sourceIds: ["chmi_alerts"],
          notificationPolicy: expect.objectContaining({
            eligible: true,
            audienceDecisionOwner: "cop",
            deliveryOwner: "csm-messaging",
            recommendedNotificationTypes: ["safety.alert"],
            technicalWarningsPolicy: "never_push_to_public_users"
          })
        }),
        expect.objectContaining({
          providerLayerId: "safety.fire",
          recommendedCatalogLayerId: "public.safety.fire",
          categories: expect.arrayContaining(["fire", "fire_weather_risk"]),
          role: "overlay",
          sourceIds: ["chmi_alerts", "nasa_firms"]
        }),
        expect.objectContaining({
          providerLayerId: "safety.flood",
          recommendedCatalogLayerId: "public.safety.flood",
          categories: expect.arrayContaining(["hydrology"]),
          role: "overlay",
          sourceIds: ["chmi_hydro"]
        }),
        expect.objectContaining({
          providerLayerId: "boundary.admin",
          recommendedCatalogLayerId: "public.boundary.admin",
          categories: expect.arrayContaining(["admin_boundary"]),
          role: "reference",
          sourceIds: ["admin_boundaries"],
          notificationPolicy: expect.objectContaining({
            eligible: false
          })
        })
      ])
    );
    expect(response.body.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "chmi_alerts",
          sourceRole: "final",
          feedsLayerIds: ["safety.weather_alerts", "safety.fire"],
          feedsCatalogLayerIds: ["public.safety.weather_alerts", "public.safety.fire"]
        }),
        expect.objectContaining({
          sourceId: "chmi_hydro",
          sourceRole: "final",
          feedsLayerIds: ["safety.flood"],
          feedsCatalogLayerIds: ["public.safety.flood"]
        }),
        expect.objectContaining({
          sourceId: "nasa_firms",
          sourceRole: "final",
          feedsLayerIds: ["safety.fire"],
          feedsCatalogLayerIds: ["public.safety.fire"]
        }),
        expect.objectContaining({
          sourceId: "admin_boundaries",
          sourceRole: "reference",
          feedsLayerIds: ["boundary.admin"],
          feedsCatalogLayerIds: ["public.boundary.admin"]
        })
      ])
    );
  });

  it("exposes lightweight summary, detail, geometry and taxonomy endpoints", async () => {
    const taxonomy = await request(app).get("/api/v1/taxonomy").expect(200);
    expect(taxonomy.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-provider-taxonomy-v1",
        providerId: "sim.safety-data",
        taxonomies: expect.arrayContaining([
          expect.objectContaining({
            taxonomyId: "chmi.sivs",
            entries: expect.arrayContaining([
              expect.objectContaining({ typeCode: "weather.temperature.high", codes: expect.arrayContaining(["I.1", "I.2"]) }),
              expect.objectContaining({ typeCode: "hydro.flood.warning", codes: expect.arrayContaining(["XI.1", "XI.2", "XI.3", "XI.4"]) })
            ])
          }),
          expect.objectContaining({ taxonomyId: "sim.safety.layers" })
        ])
      })
    );

    const summary = await request(app).get("/api/v1/features/summary?layers=weather_alerts&source=mock&limit=1").expect(200);
    expect(summary.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-provider-feature-summary-v1",
        providerId: "sim.safety-data",
        summary: expect.objectContaining({ omittedGeometry: true }),
        features: [
          expect.objectContaining({
            featureId: "weather_alerts:mock:wind-prague-west",
            layerId: "public.safety.weather_alerts",
            providerLayerId: "safety.weather_alerts",
            geometry: expect.objectContaining({ type: "Point", coordinateCount: 1, geometryRole: "feature_geometry" }),
            links: expect.objectContaining({
              detail: expect.stringContaining("/safety-data/api/v1/features/weather_alerts%3Amock%3Awind-prague-west?"),
              geometry: expect.stringContaining("/safety-data/api/v1/features/weather_alerts%3Amock%3Awind-prague-west/geometry?")
            })
          })
        ]
      })
    );
    expect(summary.body.features[0].links.detail).toContain("layers=weather_alerts");
    expect(summary.body.features[0].links.detail).toContain("source=mock");
    expect(summary.body.features[0]).not.toHaveProperty("geometry.coordinates");

    const detail = await request(app).get("/api/v1/features/weather_alerts%3Amock%3Awind-prague-west?layers=weather_alerts&source=mock&limit=1").expect(200);
    expect(detail.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-provider-feature-detail-v1",
        providerId: "sim.safety-data",
        summary: expect.objectContaining({ featureId: "weather_alerts:mock:wind-prague-west" }),
        properties: expect.objectContaining({ headline: "Synthetic wind warning" }),
        links: expect.objectContaining({
          geometry: expect.stringContaining("/safety-data/api/v1/features/weather_alerts%3Amock%3Awind-prague-west/geometry?")
        })
      })
    );
    expect(detail.body.properties.raw).toBeUndefined();

    const geometry = await request(app).get("/api/v1/features/weather_alerts%3Amock%3Awind-prague-west/geometry?layers=weather_alerts&source=mock&limit=1").expect(200);
    expect(geometry.body).toEqual(
      expect.objectContaining({
        contractVersion: "sim-provider-feature-geometry-v1",
        providerId: "sim.safety-data",
        featureId: "weather_alerts:mock:wind-prague-west",
        resolution: "native",
        geometry: expect.objectContaining({ type: "Point", coordinates: expect.any(Array) }),
        geometrySummary: expect.objectContaining({ type: "Point", coordinateCount: 1 })
      })
    );
  });

  it("exposes cache metrics", async () => {
    await request(app).get("/api/v1/features?layers=weather_alerts,fire,flood,boundary_admin&source=mock&limit=10").expect(200);

    const response = await request(app).get("/metrics").expect(200);
    expect(response.text).toContain("safety_data_cache_entries");
    expect(response.text).toContain("safety_data_cache_coalesced_hits");
    expect(response.text).toContain("safety_data_last_feature_count");
    expect(response.text).toContain('safety_data_last_layer_features{layer="fire"}');
  });

  it("exposes observability with per-source cache state", async () => {
    const configured = await createApp({ ...config, enabledSources: ["chmi_alerts", "chmi_hydro", "nasa_firms", "admin_boundaries"] });
    await request(configured.app).get("/api/v1/observability").expect(200).expect((response) => {
      expect(response.body).toEqual(
        expect.objectContaining({
          serviceId: "safety-data-api",
          cache: expect.objectContaining({ entries: expect.any(Number), hitRate: expect.any(Number) }),
          sourceCaches: expect.arrayContaining([
            expect.objectContaining({ sourceId: "chmi_alerts", cache: expect.objectContaining({ hits: expect.any(Number), misses: expect.any(Number) }) }),
            expect.objectContaining({ sourceId: "chmi_hydro", cache: expect.objectContaining({ hits: expect.any(Number), misses: expect.any(Number) }) }),
            expect.objectContaining({ sourceId: "nasa_firms", cache: expect.objectContaining({ hits: expect.any(Number), misses: expect.any(Number) }) }),
            expect.objectContaining({ sourceId: "admin_boundaries", cache: expect.objectContaining({ hits: expect.any(Number), misses: expect.any(Number) }) })
          ]),
          lastResult: expect.objectContaining({
            featureCount: 0,
            generatedAgeSeconds: -1,
            layerCounts: {}
          })
        })
      );
    });
  });

  it("skips CHMI hydro stations with missing current data without degrading a partial response", async () => {
    await withFixtureServer(
      {
        "/meta.json": JSON.stringify(chmiHydroMetadataFixture()),
        "/now/0-203-1-good.json": JSON.stringify(chmiHydroNowFixture("0-203-1-good")),
        "/now/0-203-1-missing.json": { status: 404, body: "not found" }
      },
      async (baseUrl) => {
        const configured = await createApp({
          ...config,
          enabledSources: ["chmi_hydro"],
          chmiHydroMetadataUrl: `${baseUrl}/meta.json`,
          chmiHydroNowBaseUrl: `${baseUrl}/now`
        });

        const response = await request(configured.app)
          .get("/api/v1/cop/features?bbox=13.85,49.65,15.35,50.45&layers=flood&source=chmi_hydro&limit=10")
          .expect(200);

        expect(response.body.summary.featureCount).toBe(1);
        expect(response.body.warnings).toEqual([]);
        expect(response.body.features[0].properties.tags.stationId).toBe("0-203-1-good");
        expect(response.body.features[0].properties).toEqual(
          expect.objectContaining({
            layerId: "public.safety.flood",
            providerLayerId: "safety.flood",
            floodStage: 2,
            severity: "warning",
            status: "active",
            trend: "rising",
            detailUrl: "/safety-data/api/v1/hydro/stations/0-203-1-good/observations",
            timelineUrl: "/safety-data/api/v1/hydro/stations/0-203-1-good/observations",
            forecastAvailable: true,
            forecastUntil: "2026-05-29T10:00:00.000Z",
            basin: "1-01-01-0000",
            affectedArea: "Vltava - Good station",
            metrics: expect.objectContaining({
              waterLevelCm: 160,
              waterTemperatureC: 12.4,
              waterLevelDeltaCm: 20,
              waterLevelRateCmPerHour: 20,
              flowM3s: 40,
              flowDeltaM3s: 5,
              flowRateM3sPerHour: 5,
              forecastAvailable: true,
              catchmentAreaKm2: 123.45,
              spa2Cm: 150,
              spa2FlowM3s: 35
            }),
            tags: expect.objectContaining({
              hydrologicalOrder: "1-01-01-0000",
              detailUrl: "/safety-data/api/v1/hydro/stations/0-203-1-good/observations",
              trendBasis: "water_level"
            })
          })
        );
      }
    );
  });

  it("returns CHMI hydro station detail series for COP graph rendering", async () => {
    await withFixtureServer(
      {
        "/meta.json": JSON.stringify(chmiHydroMetadataFixture()),
        "/now/0-203-1-good.json": JSON.stringify(chmiHydroNowFixture("0-203-1-good"))
      },
      async (baseUrl) => {
        const configured = await createApp({
          ...config,
          enabledSources: ["chmi_hydro"],
          chmiHydroMetadataUrl: `${baseUrl}/meta.json`,
          chmiHydroNowBaseUrl: `${baseUrl}/now`,
          chmiHydroRecentBaseUrl: `${baseUrl}/recent`,
          chmiHydroDetailBackfillDays: 0
        });

        const response = await request(configured.app)
          .get(
            "/api/v1/hydro/stations/0-203-1-good/observations?from=2026-05-28T08:00:00Z&to=2026-05-29T12:00:00Z&series=H,Q,TH,H_F,Q_F"
          )
          .expect(200);

        expect(response.body).toEqual(
          expect.objectContaining({
            contractVersion: "chmi-hydro-station-detail-v1",
            providerId: "sim.safety-data",
            sourceId: "chmi_hydro",
            station: expect.objectContaining({
              stationId: "0-203-1-good",
              stationCode: "GOOD",
              stationName: "Good station",
              streamName: "Vltava"
            }),
            window: {
              from: "2026-05-28T08:00:00.000Z",
              to: "2026-05-29T12:00:00.000Z"
            },
            thresholds: {
              waterLevel: expect.objectContaining({ unit: "cm", dry: 10, spa1: 100, spa2: 150, spa3: 200 }),
              discharge: expect.objectContaining({ unit: "m3/s", dry: 2, spa1: 20, spa2: 35, spa3: 50 })
            },
            chart: expect.objectContaining({
              title: "Good station - Vltava",
              panels: expect.arrayContaining([
                expect.objectContaining({ id: "water_level", seriesIds: ["H", "H_F"], thresholdSet: "waterLevel" }),
                expect.objectContaining({ id: "discharge", seriesIds: ["Q", "Q_F"], thresholdSet: "discharge" }),
                expect.objectContaining({ id: "temperature", seriesIds: ["TH"] })
              ])
            }),
            warnings: []
          })
        );
        expect(response.body.series).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "H",
              unit: "cm",
              role: "observation",
              points: expect.arrayContaining([expect.objectContaining({ at: "2026-05-28T10:00:00.000Z", value: 160, source: "live_now" })])
            }),
            expect.objectContaining({
              id: "H_F",
              unit: "cm",
              role: "forecast",
              points: expect.arrayContaining([expect.objectContaining({ at: "2026-05-29T10:00:00.000Z", value: 155 })])
            }),
            expect.objectContaining({
              id: "TH",
              unit: "°C",
              role: "observation",
              points: expect.arrayContaining([expect.objectContaining({ at: "2026-05-28T10:00:00.000Z", value: 12.4 })])
            })
          ])
        );
      }
    );
  });

  it("does not publish inactive CHMI CAP no-warning entries as stale warnings", async () => {
    await withFixtureServer(
      {
        "/cap/": '<html><body><a href="alert.xml">alert.xml</a> 20-May-2026 10:09</body></html>',
        "/cap/alert.xml": chmiNoWarningCapFixture()
      },
      async (baseUrl) => {
        const configured = await createApp({
          ...config,
          enabledSources: ["chmi_alerts"],
          chmiAlertsCapBaseUrl: `${baseUrl}/cap/`
        });

        const response = await request(configured.app)
          .get("/api/v1/cop/features?bbox=13.85,49.65,15.35,50.45&layers=warnings&source=chmi_alerts&limit=10")
          .expect(200);

        expect(response.body.summary.featureCount).toBe(0);
        expect(response.body.summary.staleFeatureCount).toBe(0);
        expect(response.body.warnings).toEqual([]);
      }
    );
  });

  it("deduplicates localized CHMI CAP info blocks and exposes canonical taxonomy", async () => {
    await withFixtureServer(
      {
        "/cap/": '<html><body><a href="alert.xml">alert.xml</a> 28-May-2026 12:00</body></html>',
        "/cap/alert.xml": chmiBilingualHeatCapFixture()
      },
      async (baseUrl) => {
        const configured = await createApp({
          ...config,
          enabledSources: ["chmi_alerts"],
          chmiAlertsCapBaseUrl: `${baseUrl}/cap/`
        });

        const response = await request(configured.app)
          .get("/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=weather_alerts&source=chmi_alerts&limit=10")
          .expect(200);

        expect(response.body.summary.featureCount).toBe(1);
        expect(response.body.features[0].properties).toEqual(
          expect.objectContaining({
            hazardType: "temperature",
            typeCode: "weather.temperature.high",
            sourceCode: "I.2",
            sourceSystem: "CHMI_SIVS",
            severity: "warning",
            localized: expect.objectContaining({
              cs: expect.objectContaining({ headline: "Výstraha před velmi vysokými teplotami" }),
              en: expect.objectContaining({ headline: "Very high temperature warning" })
            }),
            providerProperties: expect.objectContaining({
              schemaVersion: "sim.provider.v2",
              typeCode: "weather.temperature.high",
              localized: expect.objectContaining({
                cs: expect.objectContaining({ event: "Velmi vysoké teploty" }),
                en: expect.objectContaining({ event: "Very High Temperatures" })
              }),
              taxonomy: expect.objectContaining({
                sourceCode: "I.2",
                typeCode: "weather.temperature.high",
                classificationBasis: "source_code",
                awarenessLevelCode: "3"
              }),
              notification: expect.objectContaining({ eligible: true })
            })
          })
        );
      }
    );
  });

  it("classifies extended CHMI SIVS event codes for ice and air-quality alerts", async () => {
    await withFixtureServer(
      {
        "/cap/": '<html><body><a href="alert.xml">alert.xml</a> 28-May-2026 12:00</body></html>',
        "/cap/alert.xml": chmiExtendedCodesCapFixture()
      },
      async (baseUrl) => {
        const configured = await createApp({
          ...config,
          enabledSources: ["chmi_alerts"],
          chmiAlertsCapBaseUrl: `${baseUrl}/cap/`
        });

        const response = await request(configured.app)
          .get("/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=weather_alerts&source=chmi_alerts&limit=10")
          .expect(200);

        const typeCodes = response.body.features.map((feature: { properties: { typeCode: string } }) => feature.properties.typeCode);
        expect(typeCodes).toEqual(expect.arrayContaining(["weather.ice.slippery_roads", "air_quality.pm10.smog"]));
      }
    );
  });

  it("resolves CHMI CAP CISORP geocodes to PostGIS administrative polygons", async () => {
    const querySpy = vi.spyOn(Pool.prototype, "query").mockResolvedValue({
      rows: [
        {
          cisorp_code: "2101",
          cisorp_name: "Benešov",
          osm_id: "-20150098",
          admin_level: 6,
          name: "SO ORP Benešov",
          code: "-20150098",
          country_code: "CZ",
          source: "osm_postgis",
          imported_at: "2026-05-28T00:00:00.000Z",
          geometry_geojson:
            '{"type":"Polygon","coordinates":[[[14.3,49.7],[14.9,49.7],[14.9,50.1],[14.3,50.1],[14.3,49.7]]]}',
          tags: { short_name: "Benešov" }
        }
      ]
    } as never);

    await withFixtureServer(
      {
        "/cap/": '<html><body><a href="alert.xml">alert.xml</a> 28-May-2026 12:00</body></html>',
        "/cap/alert.xml": chmiActiveCapFixture(),
        "/cisorp.csv": chmiOrpCodelistCsvFixture()
      },
      async (baseUrl) => {
        const configured = await createApp({
          ...config,
          enabledSources: ["chmi_alerts"],
          chmiAlertsCapBaseUrl: `${baseUrl}/cap/`,
          chmiOrpCodelistUrl: `${baseUrl}/cisorp.csv`,
          adminBoundaryConnectionString: "postgresql://sim:test@localhost:5432/sim_osm"
        });

        const response = await request(configured.app)
          .get("/api/v1/features?bbox=14.0,49.5,15.1,50.2&layers=weather_alerts&source=chmi_alerts&limit=10")
          .expect(200);

        expect(querySpy).toHaveBeenCalledTimes(1);
        expect(response.body.warnings).toEqual([]);
        expect(response.body.summary.featureCount).toBe(1);
        expect(response.body.features[0]).toEqual(
          expect.objectContaining({
            geometry: expect.objectContaining({ type: "Polygon" }),
            properties: expect.objectContaining({
              layerId: "public.safety.weather_alerts",
              providerLayerId: "safety.weather_alerts",
              sourceId: "chmi_alerts",
              adminLevel: "6",
              basis: expect.arrayContaining(["chmi_cap_cisorp", "osm_postgis_admin_boundary_match"]),
              metrics: expect.objectContaining({
                boundaryRequestedCount: 1,
                boundaryMatchCount: 1,
                geometryMode: "admin_boundary"
              }),
              tags: expect.objectContaining({
                geometryMode: "admin_boundary",
                boundaryMatch: "full",
                boundarySource: "osm_postgis_admin_boundary"
              })
            })
          })
        );
      }
    );
  });

  it("normalizes NASA FIRMS fire detections when a map key is configured", async () => {
    await withFixtureServer(
      {
        "/firms/test-map-key/VIIRS_SNPP_NRT/13.85,49.65,15.35,50.45/1":
          "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n50.1000,14.4000,333.1,0.39,0.36,2026-05-28,0930,N,VIIRS,n,2.0NRT,291.5,14.2,D\n"
      },
      async (baseUrl) => {
        const configured = await createApp({
          ...config,
          enabledSources: ["nasa_firms"],
          nasaFirmsMapKey: "test-map-key",
          nasaFirmsAreaBaseUrl: `${baseUrl}/firms`
        });

        const response = await request(configured.app)
          .get("/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=fire&source=nasa_firms&limit=10")
          .expect(200);

        expect(response.body.summary.featureCount).toBe(1);
        expect(response.body.features[0].properties).toEqual(
          expect.objectContaining({
            layerId: "public.safety.fire",
            providerLayerId: "safety.fire",
            layer: "fire",
            hazardType: "fire",
            status: "active",
            fireStatus: "detected",
            detectedAt: "2026-05-28T09:30:00.000Z",
            source: "nasa_firms",
            sourceName: "NASA FIRMS active fire detections",
            sourceSatellite: "N VIIRS",
            frp: 14.2,
            styleHint: "safety-fire-warning",
            iconHint: "fire",
            basis: ["nasa_firms_area_csv", "VIIRS_SNPP_NRT"]
          })
        );
      }
    );
  });

  it("projects CHMI fire danger warnings into the fire layer", async () => {
    vi.spyOn(Pool.prototype, "query").mockResolvedValue({
      rows: [
        {
          cisorp_code: "2101",
          cisorp_name: "Benešov",
          osm_id: "-20150098",
          admin_level: 6,
          name: "SO ORP Benešov",
          code: "-20150098",
          country_code: "CZ",
          source: "osm_postgis",
          imported_at: "2026-05-28T00:00:00.000Z",
          geometry_geojson:
            '{"type":"Polygon","coordinates":[[[14.3,49.7],[14.9,49.7],[14.9,50.1],[14.3,50.1],[14.3,49.7]]]}',
          tags: { short_name: "Benešov" }
        }
      ]
    } as never);

    await withFixtureServer(
      {
        "/cap/": '<html><body><a href="alert.xml">alert.xml</a> 28-May-2026 12:00</body></html>',
        "/cap/alert.xml": chmiFireDangerCapFixture(),
        "/cisorp.csv": chmiOrpCodelistCsvFixture()
      },
      async (baseUrl) => {
        const configured = await createApp({
          ...config,
          enabledSources: ["chmi_alerts"],
          chmiAlertsCapBaseUrl: `${baseUrl}/cap/`,
          chmiOrpCodelistUrl: `${baseUrl}/cisorp.csv`,
          adminBoundaryConnectionString: "postgresql://sim:test@localhost:5432/sim_osm"
        });

        const response = await request(configured.app)
          .get("/api/v1/features?bbox=14.0,49.5,15.1,50.2&layers=fire&source=chmi_alerts&limit=10")
          .expect(200);

        expect(response.body.summary.featureCount).toBe(1);
        expect(response.body.features[0]).toEqual(
          expect.objectContaining({
            geometry: expect.objectContaining({ type: "Polygon" }),
            properties: expect.objectContaining({
              layerId: "public.safety.fire",
              providerLayerId: "safety.fire",
              layer: "fire",
              category: "fire_weather_risk",
              hazardType: "fire_weather",
              sourceId: "chmi_alerts",
              sourceName: "CHMI CAP fire danger warnings",
              status: "risk",
              fireStatus: "risk",
              sourceIncident: "CHMI_CAP_FIRE_DANGER",
              iconHint: "fire",
              basis: expect.arrayContaining(["chmi_cap_fire_weather", "osm_postgis_admin_boundary_match"]),
              metrics: expect.objectContaining({
                fireRiskFromWeatherWarning: true,
                geometryMode: "admin_boundary"
              }),
              tags: expect.objectContaining({
                fireRiskSource: "chmi_cap",
                boundaryMatch: "full"
              })
            })
          })
        );
      }
    );
  });

  it("returns the COP GeoJSON projection", async () => {
    const response = await request(app)
      .get("/api/v1/cop/features?bbox=13.85,49.65,15.35,50.45&layers=warnings,flood&source=mock&limit=20")
      .expect(200);

    expect(response.body.contractVersion).toBe("cop-safety-source-v1");
    expect(response.body.type).toBe("FeatureCollection");
    expect(response.body.source.sourceType).toBe("PUBLIC_SAFETY_AGGREGATE");
    expect(response.body.summary.featureCount).toBeGreaterThan(0);
    expect(response.body.features[0]).toEqual(
      expect.objectContaining({
        type: "Feature",
        id: expect.any(String),
        geometry: expect.objectContaining({ type: "Point" }),
        properties: expect.objectContaining({
          featureId: expect.any(String),
          layerId: expect.stringMatching(/^public\.safety\./),
          providerId: "sim.safety-data",
          providerLayerId: expect.stringMatching(/^safety\./),
          sourceId: "mock",
          confidence: expect.any(Number),
          hazardType: expect.any(String),
          status: expect.any(String),
          validFrom: expect.any(String),
          updatedAt: expect.any(String),
          source: "mock",
          sourceName: "Synthetic local safety feed",
          basis: expect.any(Array),
          stale: false,
          license: expect.objectContaining({ attribution: "CSM SIM" })
        })
      })
    );
  });

  it("filters by layer", async () => {
    const response = await request(app).get("/api/v1/features?layers=flood&source=mock").expect(200);

    expect(response.body.features.length).toBeGreaterThan(0);
    expect(response.body.features.every((feature: { properties: { layer: string } }) => feature.properties.layer === "flood")).toBe(true);
  });

  it("returns a coarse admin boundary fallback when PostGIS boundaries are not configured", async () => {
    const configured = await createApp({ ...config, enabledSources: ["admin_boundaries"] });

    const response = await request(configured.app)
      .get("/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=boundary_admin&source=admin_boundaries&limit=5")
      .expect(200);

    expect(response.body.summary.featureCount).toBe(1);
    expect(response.body.warnings[0]).toContain("coarse seed fallback");
    expect(response.body.features[0]).toEqual(
      expect.objectContaining({
        geometry: expect.objectContaining({ type: "Polygon" }),
        properties: expect.objectContaining({
          layerId: "public.boundary.admin",
          providerLayerId: "boundary.admin",
          layer: "boundary_admin",
          sourceId: "admin_boundaries",
          sourceName: "Administrative boundary seed reference",
          adminLevel: 2,
          countryCode: "CZ",
          status: "reference"
        })
      })
    );
  });

  it("keeps layers represented when a low limit is requested", async () => {
    const response = await request(app).get("/api/v1/features?layers=warnings,flood&source=mock&limit=2").expect(200);

    const layers = new Set(response.body.features.map((feature: { properties: { layer: string } }) => feature.properties.layer));
    expect(layers).toEqual(new Set(["weather_alerts", "flood"]));
  });

  it("validates bbox and layers", async () => {
    const bbox = await request(app).get("/api/v1/features?bbox=bad").expect(400);
    expect(bbox.body.error.code).toBe("VALIDATION_ERROR");

    const layers = await request(app).get("/api/v1/features?layers=unknown").expect(400);
    expect(layers.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("coalesces concurrent cache misses into one source fetch", async () => {
    let calls = 0;
    const descriptor: SafetyDataSource["descriptor"] = {
      sourceId: "mock",
      label: "test",
      enabled: true,
      mode: "mock",
      priority: 10,
      layers: ["warnings"],
      license: {
        name: "test",
        attribution: "test",
        commercialUse: "allowed",
        operationalUse: "allowed",
        notes: []
      }
    };
    const source: SafetyDataSource = {
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
              id: "warnings:test",
              geometry: { type: "Point", coordinates: [14.4, 50.1] },
              properties: {
                featureId: "warnings:test",
                layer: "warnings",
                category: "weather_warning",
                headline: "test",
                sourceId: "mock",
                observedAt: fetchedAt,
                confidence: 1,
                stale: false,
                severity: "info",
                urgency: "unknown",
                certainty: "unknown",
                license: { name: "test", attribution: "test" }
              }
            }
          ]
        };
      }
    };
    const service = new SafetyAggregationService(config, [source]);
    const query = {
      bbox: { west: 13.85, south: 49.65, east: 15.35, north: 50.45 },
      layers: ["warnings" as const],
      sourceIds: ["mock" as const],
      limit: 10,
      includeRaw: false
    };

    await Promise.all(Array.from({ length: 8 }, () => service.getFeatures(query)));

    expect(calls).toBe(1);
    expect(service.cacheStats().coalescedHits).toBe(7);
  });
});

async function withFixtureServer(
  routes: Record<string, string | { status: number; body: string }>,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = createServer((req, res) => {
    const route = routes[req.url ?? ""];
    if (route === undefined) {
      res.writeHead(404).end("not found");
      return;
    }
    if (typeof route === "string") {
      res.writeHead(200, { "content-type": route.trim().startsWith("<") ? "application/xml" : "application/json" }).end(route);
      return;
    }
    res.writeHead(route.status).end(route.body);
  });
  await listen(server);
  try {
    const address = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await close(server);
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function chmiHydroMetadataFixture(): unknown {
  return {
    data: {
      data: {
        header:
          "objID,DBC,STATION_NAME,STREAM_NAME,GEOGR1,GEOGR2,SPA_TYP,DRYH,SPA1H,SPA2H,SPA3H,SPA4H,DRYQ,SPA1Q,SPA2Q,SPA3Q,SPA4Q,PLO_STA,HLGP4",
        values: [
          ["0-203-1-good", "GOOD", "Good station", "Vltava", 50.05, 14.4, "H", 10, 100, 150, 200, 250, 2, 20, 35, 50, 70, 123.45, "1-01-01-0000"],
          ["0-203-1-missing", "MISS", "Missing station", "Vltava", 50.06, 14.41, "H", 10, 100, 150, 200, 250, 2, 20, 35, 50, 70, 123.45, "1-01-01-0000"]
        ]
      }
    }
  };
}

function chmiHydroNowFixture(stationId: string): unknown {
  const latest = "2026-05-28T10:00:00Z";
  const previous = "2026-05-28T09:00:00Z";
  return {
    objList: [
      {
        objID: stationId,
        tsList: [
          {
            tsConID: "H",
            unit: "CM",
            tsData: [
              { dt: previous, value: 140 },
              { dt: latest, value: 160 }
            ]
          },
          {
            tsConID: "Q",
            unit: "M3_S",
            tsData: [
              { dt: previous, value: 35 },
              { dt: latest, value: 40 }
            ]
          },
          {
            tsConID: "TH",
            unit: "DEG_C",
            tsData: [
              { dt: previous, value: 12.1 },
              { dt: latest, value: 12.4 }
            ]
          },
          {
            tsConID: "H_F",
            unit: "CM",
            tsData: [
              { dt: "2026-05-28T12:00:00Z", value: 162 },
              { dt: "2026-05-29T10:00:00Z", value: 155 }
            ]
          },
          {
            tsConID: "Q_F",
            unit: "M3_S",
            tsData: [
              { dt: "2026-05-28T12:00:00Z", value: 41 },
              { dt: "2026-05-29T10:00:00Z", value: 38 }
            ]
          }
        ]
      }
    ]
  };
}

function chmiNoWarningCapFixture(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>test-no-warning</identifier>
  <sender>chmi@chmi.cz</sender>
  <sent>2026-05-20T10:09:04+02:00</sent>
  <status>Actual</status>
  <msgType>Update</msgType>
  <scope>Public</scope>
  <info>
    <language>cs</language>
    <event>Žádná výstraha před teplotou</event>
    <urgency>Immediate</urgency>
    <severity>Minor</severity>
    <certainty>Unlikely</certainty>
    <onset>2026-05-20T10:03:21+02:00</onset>
    <description></description>
    <area><areaDesc>Hlavní město Praha</areaDesc></area>
  </info>
  <info>
    <language>en-GB</language>
    <event>Minor Temperature Warning</event>
    <urgency>Immediate</urgency>
    <severity>Minor</severity>
    <certainty>Unlikely</certainty>
    <onset>2026-05-20T10:03:21+02:00</onset>
    <description></description>
    <area><areaDesc>Hlavní město Praha</areaDesc></area>
  </info>
</alert>`;
}

function chmiActiveCapFixture(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>test-active-warning</identifier>
  <sender>chmi@chmi.cz</sender>
  <sent>2026-05-28T12:00:00+02:00</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>cs</language>
    <event>Silné bouřky</event>
    <headline>Výstraha před silnými bouřkami</headline>
    <urgency>Expected</urgency>
    <severity>Moderate</severity>
    <certainty>Likely</certainty>
    <onset>2026-05-28T14:00:00+02:00</onset>
    <expires>2026-05-28T20:00:00+02:00</expires>
    <description>Očekává se výskyt silných bouřek.</description>
    <instruction>Sledujte vývoj počasí a dbejte pokynů autorit.</instruction>
    <area>
      <areaDesc>Středočeský kraj</areaDesc>
      <geocode><valueName>CISORP</valueName><value>2101</value></geocode>
      <geocode><valueName>EMMA_ID</valueName><value>CZ02101</value></geocode>
    </area>
  </info>
</alert>`;
}

function chmiBilingualHeatCapFixture(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>test-bilingual-heat-warning</identifier>
  <sender>chmi@chmi.cz</sender>
  <sent>2026-05-28T12:00:00+02:00</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>cs</language>
    <event>Velmi vysoké teploty</event>
    <eventCode><valueName>SIVS</valueName><value>I.2</value></eventCode>
    <headline>Výstraha před velmi vysokými teplotami</headline>
    <urgency>Expected</urgency>
    <severity>Severe</severity>
    <certainty>Likely</certainty>
    <onset>2026-05-28T14:00:00+02:00</onset>
    <expires>2026-05-28T20:00:00+02:00</expires>
    <description>Očekávají se velmi vysoké teploty.</description>
    <instruction>Omezte fyzickou zátěž a dbejte pitného režimu.</instruction>
    <parameter><valueName>awareness_type</valueName><value>5; high-temperature</value></parameter>
    <parameter><valueName>awareness_level</valueName><value>3; orange; Severe</value></parameter>
    <parameter><valueName>criterion</valueName><value>TMAX.GT.31</value></parameter>
    <area><areaDesc>Hlavní město Praha</areaDesc></area>
  </info>
  <info>
    <language>en-GB</language>
    <event>Very High Temperatures</event>
    <eventCode><valueName>SIVS</valueName><value>I.2</value></eventCode>
    <headline>Very high temperature warning</headline>
    <urgency>Expected</urgency>
    <severity>Severe</severity>
    <certainty>Likely</certainty>
    <onset>2026-05-28T14:00:00+02:00</onset>
    <expires>2026-05-28T20:00:00+02:00</expires>
    <description>Very high temperatures are expected.</description>
    <instruction>Limit physical activity and stay hydrated.</instruction>
    <parameter><valueName>awareness_type</valueName><value>5; high-temperature</value></parameter>
    <parameter><valueName>awareness_level</valueName><value>3; orange; Severe</value></parameter>
    <parameter><valueName>criterion</valueName><value>TMAX.GT.31</value></parameter>
    <area><areaDesc>Hlavní město Praha</areaDesc></area>
  </info>
</alert>`;
}

function chmiExtendedCodesCapFixture(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>test-extended-sivs-codes</identifier>
  <sender>chmi@chmi.cz</sender>
  <sent>2026-05-28T12:00:00+02:00</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>cs</language>
    <event>Kluzké povrchy</event>
    <eventCode><valueName>SIVS</valueName><value>VII.1</value></eventCode>
    <headline>Výstraha před kluzkými povrchy</headline>
    <urgency>Expected</urgency>
    <severity>Moderate</severity>
    <certainty>Likely</certainty>
    <onset>2026-05-28T14:00:00+02:00</onset>
    <expires>2026-05-28T20:00:00+02:00</expires>
    <description>Očekávají se kluzké povrchy komunikací.</description>
    <parameter><valueName>awareness_level</valueName><value>2; yellow; Moderate</value></parameter>
    <area><areaDesc>Hlavní město Praha</areaDesc></area>
  </info>
  <info>
    <language>cs</language>
    <event>Smogová situace - suspendované částice PM10</event>
    <eventCode><valueName>SIVS</valueName><value>SMOGSIT.PM10</value></eventCode>
    <headline>Smogová situace PM10</headline>
    <urgency>Expected</urgency>
    <severity>Severe</severity>
    <certainty>Observed</certainty>
    <onset>2026-05-28T14:00:00+02:00</onset>
    <expires>2026-05-28T20:00:00+02:00</expires>
    <description>Je vyhlášena smogová situace pro PM10.</description>
    <parameter><valueName>awareness_level</valueName><value>3; orange; Severe</value></parameter>
    <area><areaDesc>Hlavní město Praha</areaDesc></area>
  </info>
</alert>`;
}

function chmiFireDangerCapFixture(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
  <identifier>test-fire-danger-warning</identifier>
  <sender>chmi@chmi.cz</sender>
  <sent>2026-05-28T12:00:00+02:00</sent>
  <status>Actual</status>
  <msgType>Alert</msgType>
  <scope>Public</scope>
  <info>
    <language>cs</language>
    <event>Nebezpečí požárů</event>
    <headline>Výstraha před nebezpečím požárů</headline>
    <urgency>Expected</urgency>
    <severity>Moderate</severity>
    <certainty>Likely</certainty>
    <onset>2026-05-28T14:00:00+02:00</onset>
    <expires>2026-05-28T20:00:00+02:00</expires>
    <description>V důsledku sucha hrozí zvýšené riziko vzniku a šíření požárů.</description>
    <instruction>Nerozdělávejte oheň ve volné přírodě a respektujte místní omezení.</instruction>
    <area>
      <areaDesc>Středočeský kraj</areaDesc>
      <geocode><valueName>CISORP</valueName><value>2101</value></geocode>
      <geocode><valueName>EMMA_ID</valueName><value>CZ02101</value></geocode>
    </area>
  </info>
</alert>`;
}

function chmiOrpCodelistCsvFixture(): string {
  return `"kodjaz","typvaz","akrcis1","kodcis1","chodnota1","text1","akrcis2","kodcis2","chodnota2","text2"
"CS","Editační vazba","CISORP",65,"1000","Praha","CISPOU",61,"10000","Praha"
"CS","Editační vazba","CISORP",65,"2101","Benešov","CISPOU",61,"21011","Benešov"
`;
}
