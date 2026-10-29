/** Purpose-separated, stateless assistance. No GPS mutation or access grant. */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { timingSafeEqual, randomUUID } from "node:crypto";
import type { Express, ErrorRequestHandler } from "express";
import type { ValidateFunction } from "ajv";
import type { SituationDataConfig } from "./config.js";
import type { ExactRoutingDataset, RoutingCoordinate, RoutingRouteResponse } from "./routing-service.js";
import { canonicalRoutingHash as H } from "./routing-safety.js";
import { parseMappedProfile, type MappedRoadProfile } from "./mapped-road-profile.js";
import { routingRequestContext } from "./routing-diagnostics.js";
import { planningOrdinaryQuery } from "./planning-origin-query.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020").default;
const formats = require("ajv-formats");
const spec = JSON.parse(readFileSync(new URL("../../../openapi/fragments/planning-origin-v1.openapi.json", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: false, strictNumbers: true, coerceTypes: false, removeAdditional: false, useDefaults: false });
formats(ajv);
const check = (name: string): ValidateFunction => ajv.compile({ components: spec.components, $ref: `#/components/schemas/${name}` });
const validators = { candidates: check("CandidatesRequest"), preview: check("PreviewRequest"), candidatesResponse: check("CandidatesResponse"), previewResponse: check("PreviewResponse") };
const DOMAIN = "sim-planning-origin-v1";
type Dataset = ExactRoutingDataset;
export interface PlanningContext {
  version: "sim-planning-origin-v1"; purpose: "planning_preview"; contextId: string;
  originContext: ({ kind: "phone_measured"; horizontalAccuracyM: number; observedAt: string; accuracyAuthorization: "full" | "reduced" } |
    { kind: "manual_point"; source: "user_map_selection" | "user_selected_last_known" | "address_selection" }) & { coordinate: RoutingCoordinate };
  destination: RoutingCoordinate; vehicleProfile: MappedRoadProfile;
}
export interface PlanningActor { serviceActor: string; opaquePlanningActor: string }
interface Direction { directionId: string; headingDeg?: number; validation: "graph_candidate_only" }
interface Selection {
  coordinate: RoutingCoordinate; source: "candidate_selection" | "user_map_selection"; confirmed: true;
  candidateId?: string; directions?: Direction[]; directionsTruncated?: boolean;
}
export interface PlanningPort {
  planningDataset(): Promise<Dataset>;
  planningLocate(context: PlanningContext): Promise<unknown>;
  planningPreview(context: PlanningContext, coordinate: RoutingCoordinate): Promise<RoutingRouteResponse>;
}
export class PlanningOriginError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const fail = (status: number, code: string): never => { throw new PlanningOriginError(status, code); };
const record = (x: unknown): Record<string, unknown> | undefined => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : undefined;
const contextHash = (context: PlanningContext): string => H({ domain: `${DOMAIN}/context`, context });
const requestHash = (actor: PlanningActor, context: PlanningContext, selection: Selection | null, routingDataset: Dataset): string =>
  H({ domain: `${DOMAIN}/request`, ...actor, context, selection, routingDataset });
export const planningBinding = (actor: PlanningActor, context: PlanningContext, dataset: Dataset, selection: Selection | null = null) => ({
  contextId: context.contextId, requestHash: requestHash(actor, context, selection, dataset), contextHash: contextHash(context),
  profileHash: H(context.vehicleProfile), destinationHash: H(context.destination), routingDataset: structuredClone(dataset)
});
export const planningCandidateId = (context: PlanningContext, routingDataset: Dataset, coordinate: RoutingCoordinate, directions: Direction[], directionsTruncated: boolean): string =>
  `candidate:${H({ domain: `${DOMAIN}/candidate`, contextHash: contextHash(context), routingDataset, coordinate, directions, directionsTruncated })}`;
export function planningOffset(a: RoutingCoordinate, b: RoutingCoordinate): number {
  const r = Math.PI / 180, v = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(Math.min(1, v)), Math.sqrt(Math.max(0, 1 - v)));
}
function fresh(context: PlanningContext, now: number): void {
  if (context.originContext.kind !== "phone_measured") return;
  const age = now - Date.parse(context.originContext.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 900_000) fail(422, "PLANNING_ORIGIN_CONTEXT_EXPIRED");
}
function validateContext(context: PlanningContext, now: number): void {
  fresh(context, now);
  try { parseMappedProfile({ profileId: "car", from: context.originContext.coordinate, to: context.destination, vehicleProfile: context.vehicleProfile }); }
  catch (error) {
    const status = record(error)?.status;
    fail(status === 422 ? 422 : 400, "VALIDATION_ERROR");
  }
}
function checkedDataset(value: Dataset, now: number): Dataset {
  const age = now - Date.parse(value.builtAt);
  if (!value.version || !Number.isFinite(age) || age < 0 || age > 10 * 86400_000) fail(503, "ROUTING_GRAPH_STALE");
  return structuredClone(value);
}
function candidatesFromNative(raw: unknown, context: PlanningContext, dataset: Dataset) {
  if (!Array.isArray(raw) || raw.length !== 1 || !record(raw[0]) || !Array.isArray(raw[0].edges) || raw[0].edges.length > 256)
    return fail(503, "PLANNING_ORIGIN_UNAVAILABLE");
  const groups = new Map<string, { coordinate: RoutingCoordinate; distance: number; directions: Map<string, Direction> }>();
  for (const item of raw[0].edges as unknown[]) {
    const edge = record(item); if (!edge) continue;
    const lat = edge.correlated_lat, lon = edge.correlated_lon;
    const id = record(edge.edge_id)?.value;
    if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 ||
      !(typeof id === "string" && /^\d{1,20}$/.test(id) || typeof id === "number" && Number.isSafeInteger(id) && id >= 0)) continue;
    const coordinate = { lat, lon }, distance = planningOffset(context.originContext.coordinate, coordinate);
    if (!Number.isFinite(distance) || distance > 500) continue;
    const directionId = `direction:${H({ domain: `${DOMAIN}/direction`, routingDataset: dataset, directedEdge: String(id) })}`;
    const heading = edge.heading;
    const direction: Direction = { directionId, ...(typeof heading === "number" && Number.isFinite(heading) && heading >= 0 && heading < 360 ? { headingDeg: heading } : {}), validation: "graph_candidate_only" };
    const way = record(edge.edge_info)?.way_id ?? edge.way_id;
    // Only same exact point AND same known physical way may group; never merge
    // nearby carriageways or infer a shared physical identity from proximity.
    const physical = (typeof way === "number" && Number.isSafeInteger(way) && way > 0) || (typeof way === "string" && /^\d{1,20}$/.test(way));
    const key = H({ coordinate, physical: physical ? String(way) : directionId });
    const group = groups.get(key) ?? { coordinate, distance, directions: new Map<string, Direction>() };
    group.directions.set(directionId, direction); groups.set(key, group);
  }
  return [...groups.values()].map(g => {
    const all = [...g.directions.values()].sort((a, b) => a.directionId.localeCompare(b.directionId));
    const directions = all.slice(0, 8), directionsTruncated = all.length > 8;
    return { candidateId: planningCandidateId(context, dataset, g.coordinate, directions, directionsTruncated), coordinate: g.coordinate,
      offsetDistanceM: g.distance, directions, directionsTruncated,
      profileValidation: "not_checked", legalAccess: "not_verified", directionValidation: "graph_candidate_only" };
  }).sort((a, b) => a.offsetDistanceM - b.offsetDistanceM || a.candidateId.localeCompare(b.candidateId)).slice(0, 3);
}

/** No result cache, no single-flight, no persistent state. */
export class PlanningOriginService {
  constructor(private readonly port: PlanningPort, private readonly now: () => number = Date.now) {}
  async candidates(raw: unknown, actor: PlanningActor) {
    if (!validators.candidates(raw)) fail(400, "VALIDATION_ERROR");
    const { context } = structuredClone(raw as { context: PlanningContext });
    validateContext(context, this.now());
    const dataset = checkedDataset(await this.port.planningDataset(), this.now());
    fresh(context, this.now());
    const result = candidatesFromNative(await this.port.planningLocate(context), context, dataset);
    fresh(context, this.now());
    if (H(checkedDataset(await this.port.planningDataset(), this.now())) !== H(dataset)) fail(409, "PLANNING_ORIGIN_DATASET_CHANGED");
    fresh(context, this.now());
    const observedAt = new Date(this.now()).toISOString();
    const validUntil = new Date(Math.min(this.now() + 120_000, Date.parse(dataset.builtAt) + 10 * 86400_000,
      context.originContext.kind === "phone_measured" ? Date.parse(context.originContext.observedAt) + 900_000 : Infinity)).toISOString();
    if (Date.parse(validUntil) <= this.now()) fail(422, "PLANNING_ORIGIN_CONTEXT_EXPIRED");
    const response = { version: "sim-planning-origin-candidates-v1", purpose: "planning_preview", state: result.length ? "choices_available" : "no_candidates",
      binding: planningBinding(actor, context, dataset), observedAt, validUntil, candidates: result, navigationEligible: false, measurementEligible: false };
    if (!validators.candidatesResponse(response)) fail(503, "PLANNING_ORIGIN_UNAVAILABLE");
    return response;
  }
  async preview(raw: unknown, actor: PlanningActor) {
    if (!validators.preview(raw)) fail(400, "VALIDATION_ERROR");
    const request = structuredClone(raw as { context: PlanningContext; expectedDataset: Dataset; discoveryBinding: unknown; selection: Selection });
    const { context, selection, expectedDataset } = request;
    validateContext(context, this.now());
    if (H(request.discoveryBinding) !== H(planningBinding(actor, context, expectedDataset))) fail(409, "PLANNING_ORIGIN_SELECTION_INVALID");
    if (planningOffset(context.originContext.coordinate, selection.coordinate) > 500) fail(409, "PLANNING_ORIGIN_SELECTION_INVALID");
    if (selection.source === "candidate_selection" && selection.candidateId !== planningCandidateId(context, expectedDataset, selection.coordinate, selection.directions!, selection.directionsTruncated!))
      fail(409, "PLANNING_ORIGIN_SELECTION_INVALID");
    const dataset = checkedDataset(await this.port.planningDataset(), this.now());
    if (H(dataset) !== H(expectedDataset)) fail(409, "PLANNING_ORIGIN_DATASET_CHANGED");
    fresh(context, this.now());
    // Candidate IDs/directions NEVER enter the native request. Same full guard
    // as a chosen manual point, even if a caller manufactured a valid UX ID.
    const result = await this.port.planningPreview(context, selection.coordinate);
    fresh(context, this.now());
    if (H(checkedDataset(await this.port.planningDataset(), this.now())) !== H(dataset)) fail(409, "PLANNING_ORIGIN_DATASET_CHANGED");
    fresh(context, this.now());
    const route = result.routes[0], assessment = route?.mappedProfileAssessment, closure = route?.knownClosures;
    if (result.routes.length !== 1 || !route || route.status !== "ok" || route.warnings.length || !assessment || !closure ||
      assessment.state !== "applied" || H(assessment.appliedProfile) !== H(context.vehicleProfile) || H(assessment.routingDataset) !== H(dataset) ||
      H(closure.routingDataset) !== H(dataset) || assessment.engine.fallbackUsed || assessment.geometryHash !== H(route.geometry)) return fail(503, "PLANNING_ORIGIN_UNAVAILABLE");
    const queryHash = H(planningOrdinaryQuery(context, selection.coordinate));
    if (H(result.query) !== queryHash || assessment.requestHash !== queryHash || assessment.profileHash !== H(context.vehicleProfile) ||
      closure.requestHash !== queryHash || closure.geometryHash !== H(route.geometry) || closure.engine.version !== "3.8.3" || closure.engine.fallbackUsed ||
      closure.appliedClosureCount !== closure.exclusions.length || new Set(closure.exclusions.map(e => e.closureId)).size !== closure.exclusions.length)
      return fail(503, "PLANNING_ORIGIN_UNAVAILABLE");
    const deadline = Math.min(Date.parse(assessment.validUntil), Date.parse(closure.validUntil),
      context.originContext.kind === "phone_measured" ? Date.parse(context.originContext.observedAt) + 900_000 : Infinity);
    if (!Number.isFinite(deadline) || deadline <= this.now()) fail(422, "PLANNING_ORIGIN_CONTEXT_EXPIRED");
    const binding = planningBinding(actor, context, dataset, selection), geometryHash = H(route.geometry);
    const path = { previewPathId: `preview:${H({ domain: `${DOMAIN}/path`, binding, geometryHash })}`, geometry: route.geometry,
      distanceM: route.distanceM, durationSeconds: route.durationSeconds, warnings: [] };
    const response = { version: "sim-planning-origin-preview-v1", purpose: "planning_preview", context, planningOrigin: selection.coordinate,
      offsetDistanceM: planningOffset(context.originContext.coordinate, selection.coordinate), connector: { state: "unknown", navigable: false },
      navigationEligible: false, measurementEligible: false, route: path,
      assessment: { ...assessment, version: "sim-planning-origin-assessment-v1", purpose: "planning_preview", binding, knownClosuresEvidence: closure,
        requestHash: binding.requestHash, selectionHash: H(selection), geometryHash, validUntil: new Date(deadline).toISOString(),
        navigationEligible: false, measurementEligible: false,
        guards: { mappedProfile: "applied_incomplete_coverage", knownClosures: "applied_reviewed_snapshot", closureRevision: closure.revision,
          snapToleranceM: 25, nativeWarningCount: 0, allVariantsValidated: true, fallbackUsed: false } } };
    if (!validators.previewResponse(response)) fail(503, "PLANNING_ORIGIN_UNAVAILABLE");
    return response;
  }
}

export const planningBodyErrorHandler: ErrorRequestHandler = (_error, req, res, next) => {
  if (!req.path.startsWith("/api/v1/routing/planning-origin/")) return next(_error);
  res.status(400).set("Cache-Control", "no-store").json({ code: "VALIDATION_ERROR",
    correlationId: routingRequestContext(req.get("x-correlation-id"))?.correlationId ?? randomUUID(), message: "VALIDATION_ERROR" });
};

export function registerPlanningOriginRoutes(app: Express, config: SituationDataConfig, port: PlanningPort): void {
  const service = new PlanningOriginService(port), windows = new Map<string, { at: number; count: number }>();
  const allowed = new Set(config.planningOriginAllowedServiceActors ?? []);
  const consume = (key: string) => {
    const now = Date.now();
    for (const [k, v] of windows) if (now - v.at >= 60_000) windows.delete(k);
    const item = windows.get(key) ?? { at: now, count: 0 };
    if (!windows.has(key) && windows.size >= 10_000) return false;
    item.count++; windows.set(key, item); return item.count <= config.geoRoutingRateLimitPerMinute;
  };
  for (const operation of ["candidates", "preview"] as const) app.post(`/api/v1/routing/planning-origin/${operation}`, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const cid = routingRequestContext(req.get("x-correlation-id"))?.correlationId;
    const respond = (status: number, code: string) => res.status(status).json({ code, correlationId: cid ?? randomUUID(), message: code });
    try {
      const count = (name: string) => req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === name).length;
      const token = /^Bearer\s+([^\s]+)$/i.exec(req.get("authorization") ?? "")?.[1];
      const principal = token && count("authorization") === 1 && config.geoRoutingPrincipals.find(p =>
        p.actor === "cop" && allowed.has(p.actor) && Buffer.byteLength(token) === Buffer.byteLength(p.token) && timingSafeEqual(Buffer.from(token), Buffer.from(p.token)));
      if (!principal || req.get("origin")) { res.set("WWW-Authenticate", 'Bearer scope="planning-origin:read", audience="csm-sim-planning-origin-v1"'); return respond(401, "UNAUTHORIZED"); }
      const actor = req.get("x-cop-planning-actor");
      if (!cid || count("x-correlation-id") !== 1 || Object.keys(req.query).length || count("x-cop-planning-actor") !== 1 || !actor || !/^[a-f0-9]{64}$/.test(actor)) return respond(400, "VALIDATION_ERROR");
      if (!consume(`service:${principal.actor}`) || !consume(`actor:${principal.actor}:${actor}`)) { res.set("Retry-After", "60"); return respond(429, "PLANNING_ORIGIN_LIMIT_EXCEEDED"); }
      return res.json(await service[operation](req.body, { serviceActor: principal.actor, opaquePlanningActor: actor }));
    } catch (error) {
      if (error instanceof PlanningOriginError) return respond(error.status, error.code);
      const e = record(error), code = e?.code, status = e?.status;
      const admitted = spec.components.schemas.Problem.properties.code.enum as string[];
      if (typeof code === "string" && admitted.includes(code) && typeof status === "number") return respond(status === 502 ? 503 : status, code);
      return respond(503, "PLANNING_ORIGIN_UNAVAILABLE");
    }
  });
}
