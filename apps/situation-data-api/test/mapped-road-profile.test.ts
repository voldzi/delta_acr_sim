import { describe, it, expect } from "vitest";
import {
  parseMappedProfile,
  mappedCostOptions,
  mappedCosting,
  mappedAssessment,
  mappedCapabilities,
  type MappedRoadProfile
} from "../src/mapped-road-profile.js";
import { canonicalRoutingHash } from "../src/routing-safety.js";
import type { RoutingRoute, RoutingRouteRequest } from "../src/routing-service.js";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url),
  Ajv = require("ajv/dist/2020").default,
  ajv = new Ajv({ strict: false });
require("ajv-formats").default(ajv);
const schemas = JSON.parse(readFileSync(new URL("../../../openapi/fragments/mapped-road-profile-v1.schemas.json", import.meta.url), "utf8"));
const validate = (name: string) => ajv.compile({ components: { schemas }, $ref: `#/components/schemas/${name}` });
const vehicle = { heightM: 3, widthM: 2.5, lengthM: 12, loadedWeightKg: 20000 };
const profile = (intent: MappedRoadProfile["intent"]): MappedRoadProfile => ({
  version: "sim-mapped-road-profile-v1",
  intent,
  coverageAcknowledged: "mapped_restrictions_incomplete",
  ...(intent === "commercial_truck" || intent === "car_with_trailer"
    ? {
        vehicle: {
          ...vehicle,
          ...(intent === "car_with_trailer"
            ? { trailer: { attached: true as const, heightM: 2.8, widthM: 2.4, lengthM: 6, loadedWeightKg: 4000 } }
            : { axleLoadKg: 8000, axleCount: 3 })
        }
      }
    : {})
});
const request = (p: MappedRoadProfile): RoutingRouteRequest => ({
  profileId: "car",
  vehicleProfile: p,
  from: { lon: 14, lat: 50 },
  to: { lon: 14.001, lat: 50.001 },
  alternatives: 3
});
describe("mapped vehicle intent", () => {
  it("ships exact four-profile COP fixtures, without changing the native geometry or engine identity", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../openapi/examples/mapped-road-profiles.synthetic.json", import.meta.url), "utf8"));
    expect(fixture.synthetic).toBe(true);
    expect(fixture.cases.map((c: any) => c.intent)).toEqual(["car", "commercial_truck", "car_with_trailer", "road_legal_4x4"]);
    const check = validate("Assessment");
    for (const c of fixture.cases) {
      expect(parseMappedProfile(c.request)).toEqual(c.request.vehicleProfile);
      expect(c.response.routes).toHaveLength(2);
      for (const r of c.response.routes) {
        const a = r.mappedProfileAssessment;
        expect(check(a)).toBe(true);
        expect(a.appliedProfile).toEqual(c.request.vehicleProfile);
        expect(a.profileHash).toBe(canonicalRoutingHash(c.request.vehicleProfile));
        expect(a.requestHash).toBe(canonicalRoutingHash(c.response.query));
        expect(a.geometryHash).toBe(canonicalRoutingHash(r.geometry));
        expect(a.engine.version).toBe(r.knownClosures.engine.version);
        expect(a.routingDataset).toEqual(r.knownClosures.routingDataset);
        expect(c.response.features.find((f: any) => f.id === r.routeId).properties.mappedProfileAssessment).toEqual(a);
      }
    }
  });
  it.each(["car", "commercial_truck", "car_with_trailer", "road_legal_4x4"] as const)(
    "keeps exact %s profile and selects real costing without legacy truck substitution",
    (intent) => {
      const p = profile(intent);
      expect(parseMappedProfile(request(p))).toEqual(p);
      const o = mappedCostOptions(p);
      expect(mappedCosting(p)).toBe(intent === "commercial_truck" ? "truck" : "auto");
      expect(o.ignore_access).toBe(false);
      expect(o.ignore_restrictions).toBe(false);
      expect(o.ignore_closures).toBe(false);
      expect(o.ignore_oneways).toBe(false);
      expect(o.shortest).toBe(false);
      if (p.vehicle) {
        expect(o.height).toBe(3);
        expect(o.width).toBe(2.5);
        expect(o.length).toBe(12);
        expect(o.weight).toBe(20);
      }
      if (intent === "commercial_truck") {
        expect(o.axle_load).toBe(8);
        expect(o.axle_count).toBe(3);
        expect(o.hgv_no_access_penalty).toBe(43200);
      }
      if (intent === "road_legal_4x4") expect(o.use_tracks).toBe(0.1);
    }
  );
  it.each([
    ["legacy", { vehicle: { heightM: 4 } }],
    ["strict", { trip: {} }],
    ["wrong-profile", { profileId: "offroad_4x4" }],
    ["extra", { ignored: true }],
    ["bad-count", { alternatives: 5 }],
    ["malformed-avoid", { avoid: "road_closure" }],
    ["unknown-avoid", { avoid: ["undocumented"] }],
    ["typed-avoid", { avoid: [{ type: "road_closure" }] }],
    ["invalid-coordinate", { from: { lon: "14", lat: 50 } }]
  ])("rejects conflict %s without dropping fields", (_name, extra) => {
    expect(() => parseMappedProfile({ ...request(profile("car")), ...extra } as unknown as RoutingRouteRequest)).toThrow();
  });
  it("rejects unknown nested keys, missing acknowledgement, wrong units and missing whole truck/trailer dimensions", () => {
    for (const p of [
      { ...profile("car"), ignore_access: true },
      { ...profile("car"), coverageAcknowledged: undefined },
      { ...profile("commercial_truck"), vehicle: { ...vehicle, loadedWeightKg: 200000 } },
      { ...profile("commercial_truck"), vehicle: undefined },
      { ...profile("car_with_trailer"), vehicle }
    ])
      expect(() => parseMappedProfile(request(p as any))).toThrow();
  });
  it("rejects impossible combination and axle relations", () => {
    const p = profile("car_with_trailer");
    p.vehicle!.trailer!.lengthM = 13;
    expect(() => parseMappedProfile(request(p))).toThrow();
    const t = profile("commercial_truck");
    t.vehicle!.axleLoadKg = 21000;
    expect(() => parseMappedProfile(request(t))).toThrow();
  });
  it.each(["authorization", "car-axle", "trailer-axle", "future", "hazard"])("rejects unsupported %s with 422", (kind) => {
    let p = profile(kind === "trailer-axle" ? "car_with_trailer" : "car"),
      r = request(p);
    if (kind === "authorization") p.driverDeclaredAuthorization = true;
    if (kind.includes("axle")) p.vehicle = { ...(p.vehicle ?? vehicle), axleCount: 3 };
    if (kind === "future") r.departureTime = "2026-10-05T12:00:00Z";
    if (kind === "hazard") r.avoid = ["flood"];
    expect(() => parseMappedProfile(r)).toThrowError(expect.objectContaining({ status: 422, code: "ROUTING_PROFILE_UNSUPPORTED" }));
  });
  it("reports runtime validation, not strict guarantees or private-access permission, in exact schema", () => {
    const c = mappedCapabilities(true);
    expect(validate("Capabilities")(c)).toBe(true);
    expect(c.intents).toHaveLength(4);
    expect(c.strictGuarantees).toBe(false);
    expect(c.driverDeclaredAuthorization).toBe("unsupported");
    expect(mappedCapabilities(false).availability).toBe("disabled");
  });
  it("binds exact profile/query/geometry/dataset and never appends a final straight-line road", () => {
    const r = request(profile("road_legal_4x4")),
      route = {
        geometry: {
          type: "LineString",
          coordinates: [
            [14, 50],
            [14.001, 50.001]
          ]
        }
      } as RoutingRoute,
      ds = { version: "synthetic-graph", builtAt: "2026-10-04T10:00:00Z" };
    const a = mappedAssessment(r, r, route, ds, "3.8.3", "2026-10-04T10:10:00Z");
    expect(validate("Assessment")(a)).toBe(true);
    expect(a.profileHash).toBe(canonicalRoutingHash(r.vehicleProfile));
    expect(a.requestHash).toBe(canonicalRoutingHash(r));
    expect(a.geometryHash).toBe(canonicalRoutingHash(route.geometry));
    expect(a.lastMile.state).toBe("mapped_target");
    const before = structuredClone(route);
    r.to!.lon += 0.0001;
    const b = mappedAssessment(r, r, route, ds, "3.8.3", a.validUntil);
    expect(b.lastMile.state).toBe("target_guidance_only");
    expect(b.lastMile.distanceM).toBeGreaterThan(0);
    expect(route).toEqual(before);
    r.to!.lon += 0.001;
    expect(() => mappedAssessment(r, r, route, ds, "3.8.3", a.validUntil)).toThrowError(
      expect.objectContaining({ status: 422, code: "ROUTING_TARGET_NOT_ROUTABLE" })
    );
  });
  it("rejects a changed engine before claiming applied profile", () => {
    const r = request(profile("car"));
    expect(() =>
      mappedAssessment(
        r,
        r,
        {
          geometry: {
            type: "LineString",
            coordinates: [
              [14, 50],
              [14.001, 50.001]
            ]
          }
        } as RoutingRoute,
        { version: "synthetic", builtAt: "2026-10-04T10:00:00Z" },
        "3.9.0",
        "2026-10-04T10:10:00Z"
      )
    ).toThrow();
  });
});
