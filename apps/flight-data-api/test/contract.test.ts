import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FlightAggregationService } from "../src/aggregation.js";
import { createApp } from "../src/app.js";
import type { FlightDataConfig } from "../src/config.js";
import type { FlightDataSource } from "../src/sources.js";

describe("Flight Data API contract", () => {
  let dataDir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let config: FlightDataConfig;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "delta-acr-flight-data-"));
    config = {
      port: 0,
      dataDir,
      enabledSources: ["mock"],
      defaultLat: 50.1008,
      defaultLon: 14.2632,
      defaultRadiusNm: 120,
      requestTimeoutMs: 1000,
      cacheTtlSeconds: 1,
      staleIfErrorSeconds: 60,
      cacheMaxEntries: 128,
      staleAfterSeconds: 120,
      adsbLolBaseUrl: "https://api.adsb.lol",
      openskyBaseUrl: "https://opensky-network.org/api",
      openskyAuthUrl: "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"
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
        staleIfErrorSeconds: 60,
        cacheMaxEntries: 128,
        staleAfterSeconds: 120,
        providers: expect.arrayContaining([
          expect.objectContaining({ sourceId: "mock", authConfigured: true }),
          expect.objectContaining({ sourceId: "opensky", authConfigured: false })
        ])
      })
    );
    expect(JSON.stringify(response.body)).not.toContain("clientSecret");
  });

  it("exposes cache metrics", async () => {
    const response = await request(app).get("/metrics").expect(200);
    expect(response.text).toContain("flight_data_cache_entries");
    expect(response.text).toContain("flight_data_cache_coalesced_hits");
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
        deduplication: expect.objectContaining({ key: "icao24" })
      })
    );
    const duplicated = response.body.tracks.find((track: { icao24: string }) => track.icao24 === "4d2216");
    expect(duplicated.deduplication.mergedRecordCount).toBe(2);
    expect(duplicated.aircraft.typeDesignator).toBe("A320");
  });

  it("provides the COP source projection", async () => {
    const response = await request(app).get("/api/v1/cop/tracks?bbox=13.5,49.5,15.0,50.5&source=mock").expect(200);

    expect(response.body.contractVersion).toBe("cop-flight-source-v1");
    expect(response.body.source.sourceType).toBe("PUBLIC_FLIGHT_AGGREGATE");
    expect(response.body.tracks.length).toBeGreaterThan(0);
    expect(response.body.tracks.every((track: { lat?: number; lon?: number }) => typeof track.lat === "number" && typeof track.lon === "number")).toBe(true);
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
});
