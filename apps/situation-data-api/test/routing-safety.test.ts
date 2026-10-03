import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { encodeValhallaPolyline6, RoutingService, valhallaSteps } from "../src/routing-service.js";
import {
  activeClosures,
  canonicalRoutingHash,
  parseRoadTripRequest,
  reviewedClosureSnapshot,
  roadTripCapabilities,
  roadTripRequestHash,
  validateRoadTripAssessment,
  validateRoadTripCapabilities,
  verifyClosureGeometry,
  type ClosureSnapshot,
  type RoadTrip,
  type RoutingSafetyOptions
} from "../src/routing-safety.js";

const now = Date.parse("2026-10-03T12:00:00Z"),
  tileset = 1790679143;
const dataset = { version: "sim-routing-2026-09-29-1790679143", builtAt: new Date(tileset * 1000).toISOString() };
const from = { lon: 14.42, lat: 50.08, label: " start " },
  to = { lon: 14.45, lat: 50.1 };
function request() {
  return {
    from: { ...from },
    to: { ...to },
    profileId: "car" as const,
    avoid: ["road_closure" as const],
    alternatives: 2,
    includeSteps: true,
    includeRoadAttributes: false,
    includeElevationProfile: false,
    includeWeatherOnRoute: false,
    includeHazardsOnRoute: false,
    trip: {
      version: "sim-road-trip-v1",
      requestId: "2c78031f-0db9-430f-bfc8-e527df399aba",
      intent: "car",
      vehicle: { heightM: 1.8, widthM: 1.9, lengthM: 4.5, loadedWeightKg: 1900, trailer: { attached: false } },
      departure: { mode: "now" },
      preferences: { avoidTolls: true, preferPaved: true },
      requirements: { roadClosures: "mandatory", legalAccess: "mandatory", vehicleLimits: "mandatory" },
      waypoints: [{ type: "via", point: { lon: 14.43, lat: 50.085 } }],
      destination: { kind: "road_point" }
    } as RoadTrip
  };
}
function snapshot(): ClosureSnapshot {
  return {
    version: "sim-reviewed-road-closures-v1",
    revision: "synthetic-1",
    routingDataset: { ...dataset },
    observedAt: "2026-10-03T11:59:00Z",
    validUntil: "2026-10-03T12:10:00Z",
    coverage: "authoritative_reviewed_snapshot",
    bbox: { west: 10, south: 45, east: 20, north: 55 },
    closures: [
      {
        id: "synthetic-closure",
        status: "active",
        direction: "both",
        validFrom: "2026-10-03T11:00:00Z",
        validUntil: "2026-10-03T12:08:00Z",
        polygon: [
          [14.49, 50.09],
          [14.51, 50.09],
          [14.51, 50.11],
          [14.49, 50.11],
          [14.49, 50.09]
        ],
        source: { authority: "synthetic-test", reference: "NOT-A-REAL-CLOSURE", reviewedAt: "2026-10-03T11:58:00Z" }
      }
    ]
  };
}
function reply(alternate = false) {
  const leg = (shape: Array<[number, number]>) => ({
    shape: encodeValhallaPolyline6(shape),
    summary: { length: 2, time: 100 },
    maneuvers: [{ type: 26, roundabout_exit_count: 4, begin_shape_index: 0, end_shape_index: shape.length - 1, time: 100, length: 2 }]
  });
  return {
    status: 0,
    summary: { length: 4, time: 200 },
    legs: [
      leg([
        [14.42, 50.08],
        [14.43, 50.085]
      ]),
      leg(
        alternate
          ? [
              [14.43, 50.085],
              [14.44, 50.097],
              [14.45, 50.1]
            ]
          : [
              [14.43, 50.085],
              [14.44, 50.09],
              [14.45, 50.1]
            ]
      )
    ]
  };
}
async function fixture() {
  let source: unknown = snapshot();
  const options: RoutingSafetyOptions = { enabled: true, acceptedEngineVersions: ["3.8.3"], loadClosureSnapshot: vi.fn(async () => structuredClone(source)) };
  const config = {
    ...(await loadConfig()),
    enabledSources: [],
    routingEngine: "valhalla" as const,
    valhallaBaseUrl: "http://synthetic.valhalla/",
    valhallaTrafficEnabled: false,
    routingMaxSearchRadiusM: 800000,
    osmPostgisConnectionString: undefined
  };
  const payloads: any[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
    payloads.push(JSON.parse(String(init?.body)));
    return Response.json({ trip: reply(), alternates: [{ trip: reply(true) }] });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    service: new RoutingService(config, undefined, options),
    options,
    payloads,
    fetchMock,
    setSource: (s: unknown) => {
      source = s;
    }
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("immutable road trip validation", () => {
  it("validates exact snapshots and canonical ordered identity without client hashes", () => {
    const r = request();
    expect(parseRoadTripRequest(r, 1)).toEqual(r.trip);
    expect(canonicalRoutingHash({ a: 1, b: 2 })).toBe(canonicalRoutingHash({ b: 2, a: 1 }));
    const hash = roadTripRequestHash(r);
    r.avoid.push("road_closure");
    expect(roadTripRequestHash(r)).toBe(hash);
    r.trip.vehicle.loadedWeightKg++;
    expect(roadTripRequestHash(r)).not.toBe(hash);
  });
  it("rejects unknown root/nested keys, conflicting legacy fields, numerics, missing requirements and unbounded alternatives", () => {
    const changes: Array<(r: any) => void> = [
      (r) => (r.userHash = "fake"),
      (r) => (r.via = []),
      (r) => (r.vehicle = {}),
      (r) => (r.departureTime = "now"),
      (r) => (r.trip.extra = true),
      (r) => (r.trip.vehicle.heightM = "1.8"),
      (r) => (r.trip.vehicle.extra = 1),
      (r) => delete r.trip.requirements.legalAccess,
      (r) => (r.trip.preferences.avoidTolls = 1),
      (r) => (r.trip.vehicle.trailer.lengthM = 3),
      (r) => (r.from.lon = 181),
      (r) => (r.from.latitude = 50),
      (r) => (r.profileId = "emergency_vehicle"),
      (r) => (r.avoid = []),
      (r) => (r.avoid = ["unknown"]),
      (r) => (r.alternatives = 4),
      (r) => (r.alternatives = 1.5),
      (r) => (r.alternatives = "2"),
      (r) => (r.trip.waypoints = Array(13).fill(r.trip.waypoints[0])),
      (r) => (r.trip.destination.entranceId = "fake")
    ];
    for (const mutate of changes) {
      const r = request();
      mutate(r);
      expect(() => parseRoadTripRequest(r, 1)).toThrow(expect.objectContaining({ status: 400, code: "ROUTING_TRIP_INVALID" }));
    }
  });
  it("accepts valid unsupported fields structurally, then explicitly rejects rather than silently omitting them", () => {
    const changes: Array<(r: any) => void> = [
      (r) => (r.trip.vehicle.axleLoadKg = 2000),
      (r) => (r.trip.vehicle.axleCount = 2),
      (r) => r.avoid.push("fire"),
      (r) => r.avoid.push("flood"),
      (r) => (r.trip.departure = { mode: "depart_at", at: "2026-10-03T13:00:00Z" }),
      (r) => (r.trip.destination = { kind: "approved_entrance", entranceId: "review-me" }),
      (r) => {
        r.trip.intent = "car_with_trailer";
        r.trip.vehicle.trailer = { attached: true, heightM: 2, widthM: 2, lengthM: 3, loadedWeightKg: 500, axleCount: 1 };
      }
    ];
    for (const mutate of changes) {
      const r = request();
      mutate(r);
      expect(() => parseRoadTripRequest(r, 1)).toThrow(expect.objectContaining({ status: 422, code: "ROUTING_SAFETY_UNSUPPORTED" }));
    }
  });
  it("capabilities are schema valid and never claim that configuration proves readiness", () => {
    const capabilities = roadTripCapabilities({ enabled: false, acceptedEngineVersions: [], loadClosureSnapshot: async () => undefined });
    expect(validateRoadTripCapabilities(capabilities)).toBe(true);
    expect(capabilities.availability).toBe("disabled");
    expect(capabilities.intents[0]!.costing).toBe("auto");
    expect(capabilities.intents[2]!.state).toBe("unsupported");
  });
});

describe("reviewed closure boundary", () => {
  it("excludes both directions, including a crossing with no vertex inside the polygon", () => {
    const s = snapshot(),
      line: Array<[number, number]> = [
        [14.48, 50.1],
        [14.52, 50.1]
      ];
    expect(() => verifyClosureGeometry(line, s, now)).toThrow(expect.objectContaining({ code: "ROUTING_SAFETY_ENGINE_FAILED" }));
    expect(() => verifyClosureGeometry([...line].reverse(), s, now)).toThrow();
    s.closures[0]!.status = "revoked";
    expect(() => verifyClosureGeometry(line, s, now)).not.toThrow();
    s.closures[0]!.status = "active";
    s.closures[0]!.validUntil = "2026-10-03T11:59:59Z";
    expect(activeClosures(s, now)).toHaveLength(0);
  });
  it("rejects expired/missing/provenance-invalid/wrong-graph/incomplete/one-direction/self-intersecting snapshots", async () => {
    const changes: Array<(s: any) => void> = [
      (s) => (s.validUntil = "2026-10-03T11:00:00Z"),
      (s) => (s.coverage = "incomplete"),
      (s) => (s.routingDataset.version = "old"),
      (s) => (s.closures[0].direction = "forward"),
      (s) => delete s.closures[0].source,
      (s) =>
        (s.closures[0].polygon = [
          [14, 50],
          [15, 51],
          [14, 51],
          [15, 50],
          [14, 50]
        ]),
      (s) => (s.closures[0].source.reviewedAt = "2026-10-03T12:00:00Z"),
      (s) => s.closures.push(s.closures[0])
    ];
    for (const change of changes) {
      const s = snapshot();
      change(s);
      await expect(
        reviewedClosureSnapshot({ enabled: true, acceptedEngineVersions: ["3.8.3"], loadClosureSnapshot: async () => s }, dataset, now)
      ).rejects.toThrow();
    }
  });
});

describe("actual strict route pipeline (synthetic engine)", () => {
  it("exposes the additive profiles capability and exact correlated errors through the actual HTTP app", async () => {
    const f = await fixture(),
      { app, context } = await createApp({ ...(await loadConfig()), enabledSources: [], sharedCacheRedisUrl: undefined });
    context.routing = f.service;
    try {
      const profiles = await supertest(app).get("/api/v1/routing/profiles");
      expect(profiles.status).toBe(200);
      expect(validateRoadTripCapabilities(profiles.body.capabilities)).toBe(true);
      const invalid = request() as any;
      invalid.trip.vehicle.heightM = "1.8";
      const error = await supertest(app).post("/api/v1/routing/route").set("x-correlation-id", "synthetic-trip-contract").send(invalid);
      expect(error.status).toBe(400);
      expect(error.body.code ?? error.body.error?.code).toBe("ROUTING_TRIP_INVALID");
      expect(JSON.stringify(error.body)).toContain("synthetic-trip-contract");
      const response = await supertest(app).post("/api/v1/routing/alternatives").send(request());
      expect(response.status).toBe(200);
      expect(response.body.routes).toHaveLength(2);
      // Optional generated test artifact for independent COP verifier acceptance.
      // Never use a production path; fixture engine has no real network or closures.
      const dir = process.env.ROUTING_TEST_CONTRACT_FIXTURE_DIR;
      if (dir) {
        const path = resolve(dir);
        if (!path.startsWith("/private/tmp/") && !path.startsWith("/tmp/")) throw Error("Fixture output must be in a temporary test directory");
        await mkdir(path, { recursive: true });
        for (const [name, value] of Object.entries({
          request: request(),
          response: response.body,
          capabilities: profiles.body.capabilities,
          manifest: { syntheticOnly: true, now: new Date(now).toISOString(), source: "SIM actual HTTP app with injected synthetic Valhalla and closure source" }
        })) {
          await writeFile(join(path, `${name}.json`), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
        }
      }
    } finally {
      await context.driverMeasurements.close();
    }
  });
  it.each(["car", "commercial_truck"] as const)("preserves %s intent, units, locations, exclusions and independent variant assessments", async (intent) => {
    const f = await fixture(),
      r = request();
    r.trip.intent = intent;
    const response = await f.service.alternatives(r);
    expect(response.routes).toHaveLength(2);
    const body = f.payloads[0],
      costing = intent === "car" ? "auto" : "truck";
    expect(body.costing).toBe(costing);
    expect(body.locations.map((p: any) => p.type)).toEqual(["break", "break_through", "break"]);
    expect(body.locations[0].name).toBe(" start ");
    expect(body.locations[0].radius).toBe(25);
    expect(body.costing_options[costing]).toMatchObject({
      height: 1.8,
      width: 1.9,
      length: 4.5,
      weight: 1.9,
      ignore_access: false,
      ignore_restrictions: false,
      ignore_closures: false,
      use_tolls: 0,
      exclude_unpaved: true
    });
    if (costing === "truck") expect(body.costing_options.truck.hgv_no_access_penalty).toBe(43200);
    expect(body.exclude_polygons).toEqual(snapshot().closures.map((c) => c.polygon));
    for (const route of response.routes) {
      expect(validateRoadTripAssessment(route.assessment)).toBe(true);
      expect(route.assessment).toMatchObject({
        requestHash: roadTripRequestHash(r),
        appliedHash: roadTripRequestHash(r),
        appliedTrip: r.trip,
        engine: { costing, fallbackUsed: false },
        waypoints: { orderedCount: 1 },
        geometryHash: canonicalRoutingHash(route.geometry)
      });
    }
    expect(response.routes[0]!.assessment!.geometryHash).not.toBe(response.routes[1]!.assessment!.geometryHash);
    expect(Date.parse(response.routes[0]!.assessment!.validUntil)).toBe(Date.parse(snapshot().closures[0]!.validUntil));
    expect(response.coverage?.routingDataset).toEqual(dataset);
  });
  it("keeps stop as a leg boundary and does not reuse a stale route cache", async () => {
    const f = await fixture(),
      r = request();
    r.trip.waypoints[0]!.type = "stop";
    await f.service.route(r);
    await f.service.route(r);
    expect(f.payloads).toHaveLength(2);
    expect(f.payloads[0].locations[1].type).toBe("break");
  });
  it("does not label a discarded legacy engine exclusion as applied after fallback", async () => {
    const f = await fixture(),
      event = {
        incidentId: "synthetic-closure",
        category: "closure",
        severity: "high",
        label: "synthetic",
        lon: 14.43,
        lat: 50.085,
        observedAt: new Date(now).toISOString(),
        validUntil: new Date(now + 600000).toISOString(),
        confidence: 0.8
      };
    vi.spyOn(f.service as any, "routeTrafficContext").mockResolvedValue({
      sourceStatus: "ok",
      events: [event],
      hardExclusionCandidates: [event],
      hardExclusionsApplied: [event],
      warnings: []
    });
    f.fetchMock.mockRejectedValue(Error("synthetic engine unavailable"));
    const response = await f.service.route({
      from,
      to,
      profileId: "car",
      avoid: ["road_closure"],
      includeElevationProfile: false,
      includeWeatherOnRoute: false,
      includeHazardsOnRoute: false
    });
    expect(response.routes[0]!.quality.mode).toBe("direct_fallback");
    expect(response.traffic.hardExclusionApplied).toBe(false);
    expect(response.traffic.hardExclusionAppliedCount).toBe(0);
    expect(response.routes[0]!.assessment).toBeUndefined();
  });
  it("does not activate the strict path by default or fall back when closure data is absent", async () => {
    const f = await fixture();
    f.options.enabled = false;
    await expect(f.service.route(request())).rejects.toMatchObject({ status: 422, code: "ROUTING_SAFETY_UNSUPPORTED" });
    expect(f.payloads).toHaveLength(0);
    f.options.enabled = true;
    f.setSource(undefined);
    await expect(f.service.route(request())).rejects.toMatchObject({ status: 503, code: "ROUTING_CLOSURES_UNAVAILABLE" });
    expect(f.payloads).toHaveLength(0);
  });
  it("rejects engine errors without invoking any local/unconstrained route", async () => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
      throw Error("unavailable private engine detail");
    });
    await expect(f.service.route(request())).rejects.toMatchObject({ status: 502, code: "ROUTING_SAFETY_ENGINE_FAILED" });
    expect(f.fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/route"))).toHaveLength(1);
  });
  it.each(["root", "trip", "alternate"])("rejects %s engine warnings rather than accepting clamped restrictions", async (location) => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
      const data: any = { trip: reply(), alternates: [{ trip: reply(true) }] },
        warnings = [{ code: 500, text: "restriction clamped" }];
      if (location === "root") data.warnings = warnings;
      else if (location === "trip") data.trip.warnings = warnings;
      else data.alternates[0].trip.warnings = warnings;
      return Response.json(data);
    });
    await expect(f.service.route(request())).rejects.toMatchObject({ status: 502, code: "ROUTING_SAFETY_ENGINE_FAILED" });
  });
  it("checks a surplus engine alternative before limiting the output count", async () => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
      const bad = reply();
      bad.legs[1]!.shape = encodeValhallaPolyline6([
        [14.43, 50.085],
        [14.5, 50.1],
        [14.45, 50.1]
      ]);
      return Response.json({ trip: reply(), alternates: [{ trip: reply(true) }, { trip: bad }] });
    });
    await expect(f.service.route(request())).rejects.toMatchObject({ status: 502, code: "ROUTING_SAFETY_ENGINE_FAILED" });
  });
  it("rejects even a secondary variant that intersects a closure away from the straight OD corridor", async () => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
      f.payloads.push(JSON.parse(String(init?.body)));
      const bad = reply();
      bad.legs[1]!.shape = encodeValhallaPolyline6([
        [14.43, 50.085],
        [14.5, 50.1],
        [14.45, 50.1]
      ]);
      return Response.json({ trip: reply(), alternates: [{ trip: bad }] });
    });
    await expect(f.service.route(request())).rejects.toMatchObject({ status: 502, code: "ROUTING_SAFETY_ENGINE_FAILED" });
  });
  it.each(["revision", "revoked", "direction", "expiry", "graph"])("fences %s changes in flight", async (change) => {
    const f = await fixture();
    let routed = false;
    f.fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/status"))
        return Response.json({ version: "3.8.3", tileset_last_modified: change === "graph" && routed ? tileset + 1 : tileset });
      routed = true;
      const s = snapshot();
      if (change === "revision") s.revision = "synthetic-2";
      if (change === "revoked") s.closures[0]!.status = "revoked";
      if (change === "direction") s.closures[0]!.direction = "backward";
      if (change === "expiry") vi.setSystemTime(now + 8 * 60000);
      f.setSource(s);
      return Response.json({ trip: reply() });
    });
    await expect(f.service.route(request())).rejects.toMatchObject({ status: change === "direction" ? 422 : 503 });
  });
  it("rejects stale graph, unreviewed engine, missing stop leg and overlong snap", async () => {
    for (const mode of ["stale", "unreviewed", "missing-leg", "bad-snap"]) {
      const f = await fixture();
      f.fetchMock.mockImplementation(async (url) => {
        if (String(url).endsWith("/status"))
          return Response.json({
            version: mode === "unreviewed" ? "4.0.0" : "3.8.3",
            tileset_last_modified: mode === "stale" ? tileset - 30 * 86400 : tileset
          });
        const trip = reply();
        if (mode === "missing-leg") trip.legs.pop();
        if (mode === "bad-snap")
          trip.legs[0]!.shape = encodeValhallaPolyline6([
            [14.4, 50.08],
            [14.43, 50.085]
          ]);
        return Response.json({ trip });
      });
      await expect(f.service.route(request())).rejects.toMatchObject({ status: mode === "stale" ? 503 : mode === "unreviewed" ? 422 : 502 });
    }
  });
});

describe("structured roundabout source truth", () => {
  it("uses actual 26/27 phases, positive provider count, and exit/sign names without invented bearings", () => {
    const shape: Array<[number, number]> = [
      [14.42, 50.08],
      [14.43, 50.085],
      [14.45, 50.1]
    ];
    const steps = valhallaSteps(
      [
        {
          shape: encodeValhallaPolyline6(shape),
          maneuvers: [
            { type: 26, roundabout_exit_count: 4, street_names: ["Ring"], begin_shape_index: 0, end_shape_index: 1 },
            { type: 27, street_names: ["Exit street"], sign: { exit_toward_elements: [{ text: "Town" }] }, begin_shape_index: 1, end_shape_index: 2 }
          ]
        }
      ],
      shape
    );
    expect(steps[0]!.roundabout).toEqual({ phase: "enter", source: "valhalla_maneuver", countState: "provider_supplied", exitCount: 4 });
    expect(steps[1]!.roundabout).toEqual({
      phase: "exit",
      source: "valhalla_maneuver",
      countState: "unknown",
      exitRoadNames: ["Exit street"],
      signNames: ["Town"]
    });
    expect(steps[0]!.bearingAfter).toBeUndefined();
  });
  it("never calls merge type 25 a roundabout and omits invalid exit counts", () => {
    const shape: Array<[number, number]> = [
      [14.42, 50.08],
      [14.43, 50.085]
    ];
    for (const type of [25, 26]) {
      const steps = valhallaSteps(
        [{ shape: encodeValhallaPolyline6(shape), maneuvers: [{ type, roundabout_exit_count: 0, begin_shape_index: 0, end_shape_index: 1 }] }],
        shape
      );
      expect(steps[0]!.roundaboutExitCount).toBeUndefined();
      if (type === 25) expect(steps[0]!.roundabout).toBeUndefined();
      else expect(steps[0]!.roundabout?.countState).toBe("unknown");
    }
  });
});
