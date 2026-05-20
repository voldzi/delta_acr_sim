import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { FlightDataConfig } from "../src/config.js";

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
});
