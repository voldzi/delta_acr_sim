import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import express from "express";
import supertest from "supertest";
import { loadConfig } from "../src/config.js";
import { PlanningOriginService, PlanningOriginError, planningBinding, planningCandidateId, registerPlanningOriginRoutes, planningBodyErrorHandler, type PlanningContext } from "../src/planning-origin.js";
import { planningOrdinaryQuery } from "../src/planning-origin-query.js";
import { canonicalRoutingHash as H } from "../src/routing-safety.js";
import type { RoutingRouteResponse } from "../src/routing-service.js";
const now = Date.parse("2026-10-29T12:00:00Z");
const dataset = { version: "synthetic-graph", builtAt: "2026-10-29T00:00:00Z" };
const actor = { serviceActor: "cop", opaquePlanningActor: "a".repeat(64) };
const coordinate = { lat: 50, lon: 14.0005 };
const ctx = (): PlanningContext => ({ version: "sim-planning-origin-v1", purpose: "planning_preview", contextId: "11111111-1111-4111-8111-111111111111",
  originContext: { kind: "phone_measured", coordinate: { lat: 50, lon: 14 }, observedAt: new Date(now).toISOString(), horizontalAccuracyM: 3, accuracyAuthorization: "reduced" },
  destination: { lat: 50, lon: 14.01 }, vehicleProfile: { version: "sim-mapped-road-profile-v1", intent: "car", coverageAcknowledged: "mapped_restrictions_incomplete", vehicle: { heightM: 2, widthM: 2, lengthM: 5, loadedWeightKg: 3000 } } });
function route(context: PlanningContext): RoutingRouteResponse {
  const geometry = { type: "LineString", coordinates: [[coordinate.lon, coordinate.lat], [context.destination.lon, context.destination.lat]] };
  const query = planningOrdinaryQuery(context, coordinate), queryHash = H(query), expiry = new Date(now + 60_000).toISOString();
  return { query, routes: [{ status: "ok", geometry, distanceM: 1000, durationSeconds: 100, warnings: [],
    mappedProfileAssessment: { version: "sim-mapped-road-profile-assessment-v1", state: "applied", coverage: "mapped_restrictions_incomplete", appliedProfile: context.vehicleProfile,
      profileHash: H(context.vehicleProfile), requestHash: queryHash, geometryHash: H(geometry), engine: { provider: "valhalla", version: "3.8.3", costing: "auto", fallbackUsed: false },
      routingDataset: dataset, appliedFields: ["heightM", "widthM", "lengthM", "loadedWeightKg"], validUntil: expiry,
      lastMile: { state: "mapped_target", target: context.destination, mappedEndpoint: context.destination, distanceM: 0 }, limitations: ["Mapped restrictions incomplete."] },
    knownClosures: { version: "sim-known-road-closures-v1", state: "applied", coverage: "incomplete", revision: "b".repeat(64), observedAt: new Date(now).toISOString(), validUntil: expiry,
      appliedClosureCount: 0, geometryHash: H(geometry), requestHash: queryHash, exclusions: [], routingDataset: dataset,
      engine: { provider: "valhalla", version: "3.8.3", fallbackUsed: false }, limitations: ["Reviewed closures only."] }
  }] } as unknown as RoutingRouteResponse;
}
function fixture() {
  const context = ctx();
  const port = { planningDataset: vi.fn(async () => structuredClone(dataset)), planningLocate: vi.fn(async () => [{ edges: [
    { correlated_lat: 50, correlated_lon: 14.0005, edge_id: { value: "101" }, edge_info: { way_id: 1001 }, heading: 90 },
    { correlated_lat: 50, correlated_lon: 14.0005, edge_id: { value: "102" }, edge_info: { way_id: 1001 }, heading: 270 }
  ], filtered_edges: [{ secret: "never exposed", correlated_lat: 50, correlated_lon: 14 }] }]), planningPreview: vi.fn(async () => route(context)) };
  const service = new PlanningOriginService(port, () => now);
  const request = () => ({ context: structuredClone(context), expectedDataset: structuredClone(dataset), discoveryBinding: planningBinding(actor, context, dataset), selection: { source: "user_map_selection", confirmed: true, coordinate } });
  return { context, port, service, request };
}
describe("purpose-separated planning origin (synthetic only)", () => {
  it("matches shared Swift/JS wire hash vectors without actor data entering public context hash", () => {
    const f = JSON.parse(readFileSync(new URL('../../../openapi/examples/planning-origin.synthetic.json', import.meta.url), 'utf8'));
    const c = f.candidatesRequest.context, selection = f.previewRequest.selection;
    expect(planningBinding(f.actor, c, f.previewRequest.expectedDataset)).toEqual(f.candidatesResponse.binding);
    expect(planningBinding(f.actor, c, f.previewRequest.expectedDataset, selection)).toEqual(f.previewResponse.assessment.binding);
    expect(H(planningOrdinaryQuery(c, selection.coordinate))).toBe(f.canonicalPublicVectors.ordinaryQueryHash);
    expect(H(selection)).toBe(f.canonicalPublicVectors.selectionHash);
    expect(H(f.previewResponse.route.geometry)).toBe(f.canonicalPublicVectors.geometryHash);
    expect(planningCandidateId(c, f.previewRequest.expectedDataset, selection.coordinate, selection.directions, selection.directionsTruncated)).toBe(f.canonicalPublicVectors.candidateId);
    expect(planningBinding({ ...f.actor, opaquePlanningActor: 'f'.repeat(64) }, c, f.previewRequest.expectedDataset).requestHash).not.toBe(f.candidatesResponse.binding.requestHash);
  });
  it("offers projected choices, preserves uncertainty and opposite directions without asserting access", async () => {
    const f = fixture(), original = structuredClone(f.context);
    const result = await f.service.candidates({ context: f.context }, actor);
    expect(result.candidates).toHaveLength(1); expect(result.candidates[0]!.directions).toHaveLength(2);
    expect(result.candidates[0]!.offsetDistanceM).toBeGreaterThan(3);
    expect(result.candidates[0]).toMatchObject({ profileValidation: "not_checked", legalAccess: "not_verified" });
    expect(JSON.stringify(result)).not.toContain("never exposed");
    expect(f.port.planningLocate).toHaveBeenCalledTimes(1); expect(f.port.planningPreview).not.toHaveBeenCalled();
    expect(f.context).toEqual(original);
  });
  it("does not reuse results or merge concurrent calls", async () => {
    const f = fixture(); await Promise.all([f.service.candidates({ context: f.context }, actor), f.service.candidates({ context: f.context }, actor)]);
    expect(f.port.planningLocate).toHaveBeenCalledTimes(2);
  });
  it("keeps only three choices and ignores out-of-budget projections", async () => {
    const f = fixture();
    f.port.planningLocate.mockResolvedValue([{ edges: Array.from({ length: 10 }, (_, i) => ({ correlated_lat: 50,
      correlated_lon: 14 + (i + 1) * .0001, edge_id: { value: String(i + 1) }, edge_info: { way_id: i + 1 } })).concat([
        { correlated_lat: 50, correlated_lon: 15, edge_id: { value: '1000' }, edge_info: { way_id: 1000 } }
      ]) }] as never);
    const result = await f.service.candidates({ context: f.context }, actor);
    expect(result.candidates).toHaveLength(3); expect(result.candidates.every(c => c.offsetDistanceM <= 500)).toBe(true);
  });
  it("freezes original context before an asynchronous provider mutates caller input", async () => {
    const f = fixture(), input = { context: structuredClone(f.context) }, original = structuredClone(input.context);
    f.port.planningLocate.mockImplementation(async () => { input.context.vehicleProfile.intent = 'road_legal_4x4'; return [{ edges: [] }] as never; });
    const result = await f.service.candidates(input, actor);
    expect(result.binding.contextHash).toBe(H({ domain: 'sim-planning-origin-v1/context', context: original }));
  });
  it("returns zero choices rather than a fallback when all provider candidates are invalid", async () => {
    const f = fixture(); f.port.planningLocate.mockResolvedValue([{ edges: [] }] as never);
    expect(await f.service.candidates({ context: f.context }, actor)).toMatchObject({ state: "no_candidates", candidates: [] });
  });
  it("keeps nearby different carriageways separate", async () => {
    const f = fixture(); f.port.planningLocate.mockResolvedValue([{ edges: [
      { correlated_lat: 50, correlated_lon: 14.0005, edge_id: { value: "101" }, edge_info: { way_id: 1001 } },
      { correlated_lat: 50, correlated_lon: 14.0005, edge_id: { value: "102" }, edge_info: { way_id: 1002 } }
    ] }] as never);
    expect((await f.service.candidates({ context: f.context }, actor)).candidates).toHaveLength(2);
  });
  it.each(["future", "stale", "unknown-field", "bad-profile", "manual-fake-gps"])("rejects %s before native calls", async mode => {
    const f = fixture(), request: any = { context: structuredClone(f.context) };
    if (mode === "future") request.context.originContext.observedAt = new Date(now + 1).toISOString();
    if (mode === "stale") request.context.originContext.observedAt = new Date(now - 900_001).toISOString();
    if (mode === "unknown-field") request.context.userId = "spoofed";
    if (mode === "bad-profile") request.context.vehicleProfile.vehicle.heightM = 6;
    if (mode === "manual-fake-gps") request.context.originContext.kind = "manual_point";
    await expect(f.service.candidates(request, actor)).rejects.toThrow();
    expect(f.port.planningDataset).not.toHaveBeenCalled(); expect(f.port.planningLocate).not.toHaveBeenCalled();
  });
  it("revalidates immutable context and freshness after await", async () => {
    const f = fixture(); let clock = now;
    f.port.planningLocate.mockImplementation(async () => { clock += 900_001; return [{ edges: [] }] as never; });
    await expect(new PlanningOriginService(f.port, () => clock).candidates({ context: f.context }, actor)).rejects.toMatchObject({ code: "PLANNING_ORIGIN_CONTEXT_EXPIRED" });
  });
  it("rejects changed dataset after discovery", async () => {
    const f = fixture(); f.port.planningDataset.mockResolvedValueOnce(dataset).mockResolvedValueOnce({ ...dataset, version: "other" });
    await expect(f.service.candidates({ context: f.context }, actor)).rejects.toMatchObject({ code: "PLANNING_ORIGIN_DATASET_CHANGED" });
  });
  it("projects actual mapped and closure proof facts into a non-promotable preview", async () => {
    const f = fixture(), result = await f.service.preview(f.request(), actor);
    expect(result).toMatchObject({ navigationEligible: false, measurementEligible: false, connector: { state: "unknown", navigable: false },
      assessment: { version: "sim-planning-origin-assessment-v1", appliedProfile: f.context.vehicleProfile, knownClosuresEvidence: { appliedClosureCount: 0 } } });
    expect(result.route.previewPathId).toMatch(/^preview:/); expect(result.route).not.toHaveProperty("mappedProfileAssessment");
    expect(f.port.planningPreview).toHaveBeenCalledTimes(1); expect(f.port.planningLocate).not.toHaveBeenCalled();
  });
  it("binds actor, profile and destination before calculation", async () => {
    const f = fixture(); await expect(f.service.preview(f.request(), { ...actor, opaquePlanningActor: "c".repeat(64) })).rejects.toMatchObject({ code: "PLANNING_ORIGIN_SELECTION_INVALID" });
    expect(f.port.planningPreview).not.toHaveBeenCalled();
  });
  it.each(["ROUTING_LOCATION_NOT_ROUTABLE", "ROUTING_RESTRICTIONS_RELAXATION_REQUIRED", "ROUTING_KNOWN_CLOSURES_CHANGED", "ROUTING_PROFILE_UNAVAILABLE"])("fabricated UX candidate cannot bypass full route rejection %s", async code => {
    const f = fixture(), directions = [{ directionId: `direction:${"f".repeat(64)}`, validation: "graph_candidate_only" as const }];
    const selection = { coordinate, source: "candidate_selection", confirmed: true, directions, directionsTruncated: false,
      candidateId: planningCandidateId(f.context, dataset, coordinate, directions, false) };
    f.port.planningPreview.mockRejectedValue(new PlanningOriginError(422, code));
    await expect(f.service.preview({ ...f.request(), selection }, actor)).rejects.toMatchObject({ code });
    expect(f.port.planningPreview).toHaveBeenCalledTimes(1); expect(f.port.planningPreview.mock.calls[0]).toHaveLength(2);
  });
  it.each(["closure", "profile", "query", "expiry"])("rejects broken proof %s", async field => {
    const f = fixture(), result = route(f.context);
    if (field === "closure") result.routes[0]!.knownClosures!.geometryHash = "0".repeat(64);
    if (field === "profile") result.routes[0]!.mappedProfileAssessment!.appliedProfile.intent = "road_legal_4x4";
    if (field === "query") result.query = {};
    if (field === "expiry") result.routes[0]!.knownClosures!.validUntil = new Date(now).toISOString();
    f.port.planningPreview.mockResolvedValue(result); await expect(f.service.preview(f.request(), actor)).rejects.toThrow();
  });
});

describe("planning HTTP service delegation", () => {
  function appFixture(allowed = ["cop"], max = 60) {
    const f = fixture();
    // Use manual input here so the HTTP wall clock does not rely on a frozen date.
    const context: PlanningContext = { ...ctx(), originContext: { kind: "manual_point", coordinate: { lat: 50, lon: 14 }, source: "user_map_selection" } };
    f.port.planningDataset.mockResolvedValue({ version: "synthetic-now", builtAt: new Date().toISOString() });
    const app = express(); app.use(express.json({ limit: '1kb' })); app.use(planningBodyErrorHandler);
    registerPlanningOriginRoutes(app, { ...loadConfig(), planningOriginAllowedServiceActors: allowed,
      geoRoutingPrincipals: [{ actor: "cop", token: "SYNTHETIC_TEST_TOKEN" }], geoRoutingRateLimitPerMinute: max }, f.port);
    return { ...f, app, context };
  }
  const headers = { Authorization: "Bearer SYNTHETIC_TEST_TOKEN", "X-Correlation-ID": "11111111-1111-4111-8111-111111111111", "X-COP-Planning-Actor": "a".repeat(64) };
  it("rejects unauthenticated and default-denied services without engine calls", async () => {
    const f = appFixture([]);
    expect((await supertest(f.app).post('/api/v1/routing/planning-origin/candidates').send({})).status).toBe(401);
    expect((await supertest(f.app).post('/api/v1/routing/planning-origin/candidates').set(headers).send({ context: f.context })).status).toBe(401);
    expect(f.port.planningDataset).not.toHaveBeenCalled();
  });
  it("rejects malformed body and actor and keeps provider prose private", async () => {
    const f = appFixture();
    expect((await supertest(f.app).post('/api/v1/routing/planning-origin/candidates').set(headers).send({})).status).toBe(400);
    expect((await supertest(f.app).post('/api/v1/routing/planning-origin/candidates').set({ ...headers, 'X-COP-Planning-Actor': 'spoof' }).send({ context: f.context })).status).toBe(400);
    f.port.planningLocate.mockRejectedValue(new Error('SENSITIVE_PROVIDER_BODY'));
    const response = await supertest(f.app).post('/api/v1/routing/planning-origin/candidates').set(headers).send({ context: f.context });
    expect(response.status).toBe(503); expect(JSON.stringify(response.body)).not.toContain('SENSITIVE_PROVIDER_BODY');
  });
  it("enforces a shared service/user budget and no fallback", async () => {
    const f = appFixture(['cop'], 1);
    expect((await supertest(f.app).post('/api/v1/routing/planning-origin/candidates').set(headers).send({ context: f.context })).status).toBe(200);
    const r = await supertest(f.app).post('/api/v1/routing/planning-origin/candidates').set(headers).send({ context: f.context });
    expect(r.status).toBe(429); expect(f.port.planningLocate).toHaveBeenCalledTimes(1);
  });
  it("sanitizes malformed and oversized JSON without exposing request data", async () => {
    const f = appFixture();
    for (const body of ['{"PRIVATE_COORDINATE"', JSON.stringify({ PRIVATE_TRACE: 'x'.repeat(2000) })]) {
      const r = await supertest(f.app).post('/api/v1/routing/planning-origin/candidates').set(headers).set('Content-Type', 'application/json').send(body);
      expect(r.status).toBe(400); expect(JSON.stringify(r.body)).not.toMatch(/PRIVATE/);
    }
    expect(f.port.planningDataset).not.toHaveBeenCalled();
  });
});
