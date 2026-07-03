import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FlightAggregationService } from "../src/aggregation.js";
import { createApp } from "../src/app.js";
import type { FlightDataConfig } from "../src/config.js";
import { FlightRouteEnrichmentService } from "../src/route-enrichment.js";
import type { FlightDataSource } from "../src/sources.js";

describe("Flight Data API contract", () => {
  let dataDir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let config: FlightDataConfig;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "csm-sim-flight-data-"));
    config = {
      port: 0,
      dataDir,
      enabledSources: ["mock"],
      defaultLat: 50.1008,
      defaultLon: 14.2632,
      defaultRadiusNm: 120,
      requestTimeoutMs: 1000,
      cacheTtlSeconds: 1,
      bboxCacheGridDegrees: 0.1,
      bboxCachePaddingDegrees: 0.08,
      staleIfErrorSeconds: 60,
      cacheMaxEntries: 128,
      staleAfterSeconds: 120,
      adsbLolBaseUrl: "https://api.adsb.lol",
      openskyBaseUrl: "https://opensky-network.org/api",
      openskyAuthUrl: "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
      localAdsbAircraftJsonUrls: [],
      flightRouteEnrichmentEnabled: false,
      flightRouteRoutesCsvUrl: "https://vrs-standing-data.adsb.lol/routes.csv",
      flightRouteAirportsCsvUrl: "https://vrs-standing-data.adsb.lol/airports.csv",
      flightRouteCacheTtlSeconds: 86400,
      ourAirportsEnabled: false,
      ourAirportsCsvUrl: "https://davidmegginson.github.io/ourairports-data/airports.csv",
      ourAirportsCountries: ["CZ", "SK", "AT", "DE", "PL", "HU"],
      ourAirportsCacheTtlSeconds: 86400,
      aipAirspacesEnabled: false,
      aipAirspacesSourceUrl: "https://aim.rlp.cz/eaip/html/eAIP/LK-ENR-5.1-en-GB.html",
      aipAirspacesCacheTtlSeconds: 86400,
      uasGeozonesEnabled: false,
      uasGeozonesCatalogUrl: "https://aim.rlp.cz/?lang=cz&p=uas-gz",
      uasGeozonesLayerIds: ["LKR320A"],
      uasGeozonesCacheTtlSeconds: 86400,
      airspaceActivationEnabled: false,
      airspaceActivationBaseUrl: "https://aup.rlp.cz/",
      airspaceActivationCacheTtlSeconds: 300
    };
    ({ app } = await createApp(config));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("exposes health and source metadata", async () => {
    const health = await request(app).get("/health/ready").expect(200);
    expect(health.body.status).toBe("ok");
    expect(health.body.enabledSources).toEqual(["mock"]);

    const sources = await request(app).get("/api/v1/sources").expect(200);
    expect(sources.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "mock",
          enabled: true,
          license: expect.objectContaining({ commercialUse: "allowed" })
        }),
        expect.objectContaining({
          sourceId: "adsb_lol",
          license: expect.objectContaining({ name: "ODbL 1.0" })
        }),
        expect.objectContaining({
          sourceId: "opensky",
          license: expect.objectContaining({ commercialUse: "requires_license" })
        }),
        expect.objectContaining({
          sourceId: "local_adsb",
          license: expect.objectContaining({ name: "Owner-operated ADS-B receiver feed" })
        })
      ])
    );
  });

  it("exposes non-secret runtime configuration", async () => {
    const response = await request(app).get("/api/v1/config").expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        enabledSources: ["mock"],
        defaultArea: { lat: 50.1008, lon: 14.2632, radiusNm: 120 },
        cacheTtlSeconds: 1,
        bboxCacheGridDegrees: 0.1,
        bboxCachePaddingDegrees: 0.08,
        staleIfErrorSeconds: 60,
        cacheMaxEntries: 128,
        staleAfterSeconds: 120,
        referenceData: expect.objectContaining({
          ourAirportsEnabled: false,
          ourAirportsCountries: ["CZ", "SK", "AT", "DE", "PL", "HU"],
          ourAirportsCacheTtlSeconds: 86400,
          aipAirspacesEnabled: false,
          aipAirspacesCacheTtlSeconds: 86400,
          uasGeozonesEnabled: false,
          uasGeozonesLayerIds: ["LKR320A"],
          airspaceActivationEnabled: false,
          airspaceActivationCacheTtlSeconds: 300,
          flightRouteEnrichmentEnabled: false,
          flightRouteCacheTtlSeconds: 86400
        }),
        providers: expect.arrayContaining([
          expect.objectContaining({ sourceId: "mock", authConfigured: true }),
          expect.objectContaining({ sourceId: "opensky", authConfigured: false }),
          expect.objectContaining({ sourceId: "local_adsb", authConfigured: false })
        ])
      })
    );
    expect(JSON.stringify(response.body)).not.toContain("clientSecret");
  });

  it("exposes provider map catalog metadata for COM", async () => {
    const response = await request(app).get("/api/v1/catalog").expect(200);

    expect(response.body).toEqual(
      expect.objectContaining({
        contractVersion: "provider-map-catalog-v1",
        catalogVersion: "provider-map-catalog-v1",
        providerId: "sim.flight-data",
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
          providerLayerId: "flight.tracks",
          recommendedCatalogLayerId: "flight.public.tracks",
          label: "Veřejné lety",
          kind: "track_stream",
          categories: expect.arrayContaining(["aircraft_track"])
        }),
        expect.objectContaining({
          providerLayerId: "flight.airports",
          recommendedCatalogLayerId: "flight.reference.airports",
          kind: "static_reference",
          categories: expect.arrayContaining(["airport"])
        }),
        expect.objectContaining({
          providerLayerId: "flight.airspaces",
          recommendedCatalogLayerId: "flight.reference.airspaces",
          kind: "static_reference",
          categories: expect.arrayContaining(["airspace"])
        }),
        expect.objectContaining({
          providerLayerId: "flight.uas_geozones",
          recommendedCatalogLayerId: "flight.reference.uas_geozones",
          kind: "static_reference",
          categories: expect.arrayContaining(["uas_geozone"])
        }),
        expect.objectContaining({
          providerLayerId: "flight.airspace_activation",
          recommendedCatalogLayerId: "flight.airspace.activation",
          kind: "vector_features",
          categories: expect.arrayContaining(["airspace_activation"])
        })
      ])
    );
    expect(response.body.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceId: "local_adsb",
          sourceRole: "final",
          feedsLayerIds: ["flight.tracks"],
          feedsCatalogLayerIds: ["flight.public.tracks"]
        }),
        expect.objectContaining({
          sourceId: "ourairports",
          sourceRole: "reference",
          feedsLayerIds: ["flight.airports"],
          feedsCatalogLayerIds: ["flight.reference.airports"]
        }),
        expect.objectContaining({
          sourceId: "czech_aip_airspaces",
          sourceRole: "reference",
          feedsLayerIds: ["flight.airspaces"],
          feedsCatalogLayerIds: ["flight.reference.airspaces"]
        }),
        expect.objectContaining({
          sourceId: "czech_uas_geozones",
          sourceRole: "reference",
          feedsLayerIds: ["flight.uas_geozones"],
          feedsCatalogLayerIds: ["flight.reference.uas_geozones"]
        }),
        expect.objectContaining({
          sourceId: "czech_aup_uup",
          sourceRole: "reference",
          feedsLayerIds: ["flight.airspace_activation"],
          feedsCatalogLayerIds: ["flight.airspace.activation"]
        })
      ])
    );
  });

  it("exposes cache metrics", async () => {
    const response = await request(app).get("/metrics").expect(200);
    expect(response.text).toContain("flight_data_cache_entries");
    expect(response.text).toContain("flight_data_cache_coalesced_hits");

    const cachedSources = await createApp({
      ...config,
      enabledSources: ["adsb_lol", "opensky", "local_adsb"],
      localAdsbAircraftJsonUrls: ["data:application/json,%7B%22aircraft%22%3A%5B%5D%7D"]
    });
    const cachedSourceMetrics = await request(cachedSources.app).get("/metrics").expect(200);
    expect(cachedSourceMetrics.text).toContain('flight_data_source_cache_hits{source="adsb_lol"}');
    expect(cachedSourceMetrics.text).toContain('flight_data_source_cache_misses{source="opensky"}');
    expect(cachedSourceMetrics.text).toContain('flight_data_source_cache_stale_hits{source="local_adsb"}');
    expect(cachedSourceMetrics.text).toContain('flight_data_reference_cache_hits{source="czech_aip_airspaces"}');
    expect(cachedSourceMetrics.text).toContain('flight_data_reference_cache_hits{source="czech_uas_geozones"}');
    expect(cachedSourceMetrics.text).toContain('flight_data_reference_cache_hits{source="czech_aup_uup"}');
    expect(cachedSourceMetrics.text).toContain('flight_data_reference_cache_hits{source="vrs_standing_data_routes"}');
  });

  it("returns deduplicated aircraft positions by icao24", async () => {
    const response = await request(app).get("/api/v1/aircraft/positions?source=mock&limit=10").expect(200);

    expect(response.body.summary.rawObservationCount).toBe(4);
    expect(response.body.summary.deduplicatedTrackCount).toBe(3);
    expect(response.body.tracks).toHaveLength(3);
    expect(response.body.tracks[0]).toEqual(
      expect.objectContaining({
        trackId: expect.stringMatching(/^flight:icao24:/),
        domain: "AIR",
        position: expect.objectContaining({
          lat: expect.any(Number),
          lon: expect.any(Number)
        }),
        deduplication: expect.objectContaining({ key: "icao24" })
      })
    );
    const duplicated = response.body.tracks.find((track: { icao24: string }) => track.icao24 === "4d2216");
    expect(duplicated.deduplication.mergedRecordCount).toBe(2);
    expect(duplicated.aircraft.typeDesignator).toBe("A320");
    expect(duplicated.aircraft.iconHint).toBe("jet");
  });

  it("provides the COP source projection", async () => {
    const response = await request(app).get("/api/v1/cop/tracks?bbox=13.5,49.5,15.0,50.5&source=mock").expect(200);

    expect(response.body.contractVersion).toBe("cop-flight-source-v1");
    expect(response.body.source.sourceType).toBe("PUBLIC_FLIGHT_AGGREGATE");
    expect(response.body.tracks.length).toBeGreaterThan(0);
    expect(response.body.tracks.every((track: { lat?: number; lon?: number }) => typeof track.lat === "number" && typeof track.lon === "number")).toBe(true);
  });

  it("enriches aircraft positions with route itinerary reference data", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.includes("routes.csv")) {
        return new Response("Callsign,Code,Number,AirlineCode,AirportCodes\nWMT9214,WMT,9214,WMT,LRCV-EDLW\n");
      }
      if (url.includes("airports.csv")) {
        return new Response(
          [
            "Code,Name,ICAO,IATA,Location,CountryISO2,Latitude,Longitude,AltitudeFeet",
            "LRCV,Craiova International Airport,LRCV,CRA,Craiova,RO,44.3181,23.888599,626",
            "EDLW,Dortmund Airport,EDLW,DTM,Dortmund,DE,51.518299,7.61224,425"
          ].join("\n")
        );
      }
      return new Response("not found", { status: 404 });
    };

    try {
      const descriptor: FlightDataSource["descriptor"] = {
        sourceId: "mock",
        label: "test",
        enabled: true,
        mode: "mock",
        priority: 10,
        license: {
          name: "test",
          attribution: "test",
          commercialUse: "allowed",
          operationalUse: "allowed",
          notes: []
        }
      };
      const fetchedAt = new Date("2026-07-03T10:00:00.000Z").toISOString();
      const source: FlightDataSource = {
        descriptor,
        async fetchObservations() {
          return {
            source: descriptor,
            fetchedAt,
            warnings: [],
            observations: [
              {
                sourceId: "mock",
                sourceRecordId: "test:4d2216",
                sourcePriority: 10,
                fetchedAt,
                seenAt: fetchedAt,
                icao24: "4d2216",
                callsign: "WMT9214",
                lat: 49.0,
                lon: 14.0,
                speedMps: 220
              }
            ]
          };
        }
      };
      const routeConfig = {
        ...config,
        flightRouteEnrichmentEnabled: true,
        flightRouteRoutesCsvUrl: "https://example.test/routes.csv",
        flightRouteAirportsCsvUrl: "https://example.test/airports.csv"
      };
      const service = new FlightAggregationService(routeConfig, [source], new FlightRouteEnrichmentService(routeConfig));

      const response = await service.getTracks({ bbox: undefined, limit: 10, sourceIds: ["mock"], includeStale: false });

      expect(response.tracks[0]?.itinerary).toEqual(
        expect.objectContaining({
          callsign: "WMT9214",
          airlineCode: "WMT",
          flightNumber: "9214",
          airportCodes: ["LRCV", "EDLW"],
          airportIataCodes: ["CRA", "DTM"],
          display: expect.objectContaining({
            title: "CRA -> DTM",
            originCode: "CRA",
            destinationCode: "DTM",
            originCity: "Craiova",
            destinationCity: "Dortmund"
          }),
          timing: expect.objectContaining({
            scheduledDeparture: { status: "unavailable", reason: "not_in_open_adsb_route_reference" },
            actualDeparture: { status: "unavailable", reason: "not_in_open_adsb_route_reference" },
            scheduledArrival: { status: "unavailable", reason: "not_in_open_adsb_route_reference" },
            estimatedArrival: expect.objectContaining({
              status: "estimated",
              basis: "current_position_groundspeed_great_circle"
            })
          }),
          quality: expect.objectContaining({
            routeMatch: "callsign_exact",
            scheduleAvailable: false,
            timingMode: "position_estimate"
          })
        })
      );
      expect(response.tracks[0]?.itinerary?.origin).toEqual(expect.objectContaining({ icao: "LRCV", iata: "CRA" }));
      expect(response.tracks[0]?.itinerary?.destination).toEqual(expect.objectContaining({ icao: "EDLW", iata: "DTM" }));
      expect(response.tracks[0]?.itinerary?.progress?.estimatedArrivalAt).toEqual(expect.any(String));
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("reads a local readsb/dump1090 aircraft.json feed", async () => {
    const payload = encodeURIComponent(
      JSON.stringify({
        now: Date.now() / 1000,
        aircraft: [
          {
            hex: "4D2216",
            flight: "CSA42 ",
            r: "OK-TSR",
            t: "A320",
            lat: 50.1174,
            lon: 14.5121,
            alt_baro: 9000,
            gs: 268,
            track: 269,
            baro_rate: 256,
            squawk: "2741",
            seen: 1,
            category: "A3"
          }
        ]
      })
    );
    const localApp = await createApp({
      ...config,
      enabledSources: ["local_adsb"],
      localAdsbAircraftJsonUrls: [`data:application/json,${payload}`]
    });

    const response = await request(localApp.app).get("/api/v1/cop/tracks?source=local_adsb&limit=10").expect(200);

    expect(response.body.summary.rawObservationCount).toBe(1);
    expect(response.body.tracks[0]).toEqual(
      expect.objectContaining({
        icao24: "4d2216",
        callsign: "CSA42",
        registration: "OK-TSR",
        altitudeM: 2743,
        speedMps: 137.87,
        position: { lat: 50.1174, lon: 14.5121 },
        aircraft: expect.objectContaining({ iconHint: "jet" }),
        deduplication: expect.objectContaining({ primarySourceId: "local_adsb" })
      })
    );
  });

  it("exposes airport and aircraft type reference lookups", async () => {
    const airports = await request(app).get("/api/v1/airports?query=LKPR").expect(200);
    expect(airports.body.items[0]).toEqual(expect.objectContaining({ ident: "LKPR", iata: "PRG" }));

    const airport = await request(app).get("/api/v1/airports/LKPR").expect(200);
    expect(airport.body.name).toContain("Prague");

    const aircraftTypes = await request(app).get("/api/v1/aircraft-types?query=A320").expect(200);
    expect(aircraftTypes.body.items[0]).toEqual(expect.objectContaining({ designator: "A320", manufacturer: "Airbus" }));

    const aircraftType = await request(app).get("/api/v1/aircraft-types/B738").expect(200);
    expect(aircraftType.body.model).toBe("737-800");
  });

  it("exposes airspace reference as GeoJSON features", async () => {
    const response = await request(app).get("/api/v1/airspaces?bbox=14.2,49.9,14.6,50.2&type=prohibited&limit=10").expect(200);

    expect(response.body.contractVersion).toBe("flight-airspace-reference-v1");
    expect(response.body.type).toBe("FeatureCollection");
    expect(response.body.summary.notForNavigation).toBe(true);
    expect(response.body.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "Feature",
          properties: expect.objectContaining({
            layerId: "flight.reference.airspaces",
            providerLayerId: "flight.airspaces",
            sourceId: "czech_aip_airspaces",
            notForNavigation: true,
            airspaceType: "prohibited"
          })
        })
      ])
    );
  });

  it("exposes UAS geozone reference and activation endpoints", async () => {
    const uas = await request(app).get("/api/v1/uas-geozones?bbox=12,48,19,52&limit=10").expect(200);
    expect(uas.body.contractVersion).toBe("flight-uas-geozone-reference-v1");
    expect(uas.body.summary.notForNavigation).toBe(true);

    const activations = await request(app).get("/api/v1/airspace-activations?bbox=12,48,19,52&limit=10&includeCancelled=true").expect(200);
    expect(activations.body.contractVersion).toBe("flight-airspace-activation-v1");
    expect(activations.body.summary.notForNavigation).toBe(true);
  });

  it("validates bbox format", async () => {
    const response = await request(app).get("/api/v1/aircraft/positions?bbox=bad").expect(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("coalesces concurrent cache misses into one source fetch", async () => {
    let calls = 0;
    const descriptor: FlightDataSource["descriptor"] = {
      sourceId: "mock",
      label: "test",
      enabled: true,
      mode: "mock",
      priority: 10,
      license: {
        name: "test",
        attribution: "test",
        commercialUse: "allowed",
        operationalUse: "allowed",
        notes: []
      }
    };
    const source: FlightDataSource = {
      descriptor,
      async fetchObservations() {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        const fetchedAt = new Date().toISOString();
        return {
          source: descriptor,
          fetchedAt,
          warnings: [],
          observations: [
            {
              sourceId: "mock",
              sourceRecordId: "test:4d2216",
              sourcePriority: 10,
              fetchedAt,
              seenAt: fetchedAt,
              icao24: "4d2216",
              lat: 50.1,
              lon: 14.4
            }
          ]
        };
      }
    };
    const service = new FlightAggregationService(config, [source]);
    const query = { bbox: undefined, limit: 10, sourceIds: ["mock" as const], includeStale: false };

    await Promise.all(Array.from({ length: 8 }, () => service.getTracks(query)));

    expect(calls).toBe(1);
    expect(service.cacheStats().coalescedHits).toBe(7);
  });

  it("uses a canonical padded bbox cache and returns the requested viewport", async () => {
    let calls = 0;
    const descriptor: FlightDataSource["descriptor"] = {
      sourceId: "mock",
      label: "test",
      enabled: true,
      mode: "mock",
      priority: 10,
      license: {
        name: "test",
        attribution: "test",
        commercialUse: "allowed",
        operationalUse: "allowed",
        notes: []
      }
    };
    const source: FlightDataSource = {
      descriptor,
      async fetchObservations(query) {
        calls += 1;
        const fetchedAt = new Date().toISOString();
        const observations = [
          {
            sourceId: "mock" as const,
            sourceRecordId: "test:4d2216",
            sourcePriority: 10,
            fetchedAt,
            seenAt: fetchedAt,
            icao24: "4d2216",
            lat: 50.1,
            lon: 14.1
          },
          {
            sourceId: "mock" as const,
            sourceRecordId: "test:440090",
            sourcePriority: 10,
            fetchedAt,
            seenAt: fetchedAt,
            icao24: "440090",
            lat: 50.2,
            lon: 14.2
          }
        ].filter((observation) => {
          if (!query.bbox) {
            return true;
          }
          return (
            observation.lon >= query.bbox.west &&
            observation.lon <= query.bbox.east &&
            observation.lat >= query.bbox.south &&
            observation.lat <= query.bbox.north
          );
        });
        return { source: descriptor, fetchedAt, warnings: [], observations };
      }
    };
    const service = new FlightAggregationService(
      { ...config, bboxCacheGridDegrees: 1, bboxCachePaddingDegrees: 0.2 },
      [source]
    );

    const first = await service.getTracks({
      bbox: { west: 14.0, south: 50.0, east: 14.15, north: 50.15 },
      limit: 10,
      sourceIds: ["mock"],
      includeStale: false
    });
    const second = await service.getTracks({
      bbox: { west: 14.05, south: 50.05, east: 14.25, north: 50.25 },
      limit: 10,
      sourceIds: ["mock"],
      includeStale: false
    });

    expect(calls).toBe(1);
    expect(service.cacheStats().hits).toBe(1);
    expect(first.query.bbox).toEqual({ west: 14.0, south: 50.0, east: 14.15, north: 50.15 });
    expect(first.tracks.map((track) => track.icao24)).toEqual(["4d2216"]);
    expect(second.query.bbox).toEqual({ west: 14.05, south: 50.05, east: 14.25, north: 50.25 });
    expect(second.tracks.map((track) => track.icao24).sort()).toEqual(["440090", "4d2216"]);
  });
});
