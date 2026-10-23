import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parseArrival, arrivalDistance, arrivalCapabilities, assessArrival } from "../src/user-selected-arrival.js";
import type { RoutingRouteRequest, RoutingRoute } from "../src/routing-service.js";
import { canonicalRoutingHash } from "../src/routing-safety.js";
const point = { lat: 50, lon: 14 };
const offset = (m: number) => ({ lat: 50 + m / 6371000 * 180 / Math.PI, lon: 14 });
const raw = (): RoutingRouteRequest => ({ profileId: "car", from: point, to: point, includeSteps: true,
  arrival: { version: "sim-user-selected-arrival-v1", selection: "user_selected", target: offset(27) } });
describe("shared user-selected arrival contract", () => {
  it("reproduces the exact two-variant COP fixture proof and capability", () => {
    const fixture = JSON.parse(readFileSync(new URL("./user-selected-arrival-v1.fixture.json", import.meta.url), "utf8"));
    expect(fixture.fixtureKind).toBe("synthetic_contract_not_live_route");
    vi.useFakeTimers(); vi.setSystemTime(Date.parse(fixture.validationNow));
    try {
      expect(parseArrival(fixture.request, true)).toEqual(fixture.request.arrival);
      expect(arrivalCapabilities(true)).toEqual(fixture.capabilities.userSelectedArrival ?? fixture.capabilities);
      for (const route of fixture.response.routes) {
        expect(assessArrival(fixture.request, fixture.response.query, route)).toEqual(route.arrival);
        expect(fixture.response.features.find((f: { id: string }) => f.id === route.routeId).properties.arrival).toEqual(route.arrival);
      }
    } finally { vi.useRealTimers(); }
  });
  it.each([24, 25, 26, 27, 249.9])("allows %sm POI remainder without changing road snap tolerance", m => {
    const r = raw(); r.arrival!.target = offset(m);
    expect(parseArrival(r, true)).toEqual(r.arrival);
    expect(arrivalDistance(point, offset(m))).toBeCloseTo(m, 6);
  });
  it("rejects distant request and disabled service", () => {
    const r = raw(); r.arrival!.target = offset(250.1);
    expect(() => parseArrival(r, true)).toThrowError(expect.objectContaining({ status: 422, code: "ROUTING_ARRIVAL_TOO_DISTANT" }));
    expect(() => parseArrival(raw(), false)).toThrowError(expect.objectContaining({ code: "ROUTING_ARRIVAL_UNSUPPORTED" }));
    expect(arrivalCapabilities(false).availability).toBe("disabled");
  });
  it.each([null, {}, { ...raw().arrival, extra: true }, { ...raw().arrival, target: { ...point, label: "not allowed" } },
    { ...raw().arrival, version: "unknown" }, { ...raw().arrival, target: { lat: NaN, lon: 14 } }])("rejects malformed opt-in", arrival => {
    expect(() => parseArrival({ ...raw(), arrival } as RoutingRouteRequest, true)).toThrowError(expect.objectContaining({ status: 400, code: "VALIDATION_ERROR" }));
  });
  it.each(["walking", "bicycle", "commercial_truck"])("never downgrades %s", profileId => {
    expect(() => parseArrival({ ...raw(), profileId } as RoutingRouteRequest, true)).toThrowError(expect.objectContaining({ code: "ROUTING_ARRIVAL_UNSUPPORTED" }));
  });
  const route = (request: RoutingRouteRequest, end = point): RoutingRoute => {
    const geometry = { type: "LineString" as const, coordinates: [[14, 49.999], [end.lon, end.lat]] as Array<[number, number]> };
    return { routeId: "synthetic", profileId: "car", status: "ok", geometry,
      quality: { mode: "engine_route" }, vehicleAssessment: { providerCosting: "auto" },
      knownClosures: { geometryHash: canonicalRoutingHash(geometry), requestHash: canonicalRoutingHash(request),
        revision: "a".repeat(64), routingDataset: { version: "synthetic", builtAt: new Date().toISOString() },
        engine: { provider: "valhalla", version: "3.8.3", fallbackUsed: false }, validUntil: new Date(Date.now() + 60000).toISOString() }
    } as RoutingRoute;
  };
  it.each([24, 25, 26, 27])("enforces unchanged endpoint snap at %sm", m => {
    const r = raw(), result = route(r, offset(m));
    if (m <= 25) expect(assessArrival(r, r as Record<string, unknown>, result)?.snapDistanceM).toBeCloseTo(m, 6);
    else expect(() => assessArrival(r, r as Record<string, unknown>, result)).toThrowError(expect.objectContaining({ code: "ROUTING_ARRIVAL_INVALID" }));
  });
  it("rejects stale or mismatched proofs and actual endpoint beyond 250m", () => {
    const r = raw();
    for (const mutation of ["stale", "hash", "costing"]) {
      const x = route(r);
      if (mutation === "stale") x.knownClosures!.validUntil = new Date(0).toISOString();
      if (mutation === "hash") x.knownClosures!.requestHash = "b".repeat(64);
      if (mutation === "costing") x.vehicleAssessment!.providerCosting = "truck";
      expect(() => assessArrival(r, r as Record<string, unknown>, x)).toThrowError(expect.objectContaining({ code: "ROUTING_ARRIVAL_INVALID" }));
    }
    r.arrival!.target = offset(249); const x = route(r, offset(-2));
    expect(() => assessArrival(r, r as Record<string, unknown>, x)).toThrowError(expect.objectContaining({ code: "ROUTING_ARRIVAL_TOO_DISTANT" }));
  });
  it("produces no metadata without opt-in", () => {
    const r = raw(); delete r.arrival;
    expect(parseArrival(r, true)).toBeUndefined();
    expect(assessArrival(r, r as Record<string, unknown>, route(r))).toBeUndefined();
  });
});
