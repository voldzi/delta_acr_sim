import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { canonicalRoutingHash, RoadTripError } from "./routing-safety.js";
import type { RoutingRoute, RoutingRouteRequest } from "./routing-service.js";
const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020").default;
const ajv = new Ajv({ strict: false, coerceTypes: false });
require("ajv-formats")(ajv);
const shared = JSON.parse(readFileSync(new URL("../../../openapi/fragments/user-selected-arrival-v1.schemas.json", import.meta.url), "utf8"));
const validator = (name: string) => ajv.compile({ ...shared, $ref: `#/components/schemas/${name}` });
const requestValid = validator("RoutingUserArrivalRequest"), responseValid = validator("RoutingUserArrival");
export type ArrivalPoint = { lat: number; lon: number };
export type ArrivalRequest = { version: "sim-user-selected-arrival-v1"; selection: "user_selected"; target: ArrivalPoint };
export const arrivalCapabilities = (enabled: boolean) => ({ version: "sim-user-selected-arrival-v1" as const,
  availability: enabled ? "requires_runtime_validation" as const : "disabled" as const,
  selection: "user_selected_only" as const, profileIds: ["car"], maxRemainingDistanceM: 250,
  maxSnapDistanceM: 25, remainingAccess: "unverified" as const, cachePolicy: "no_cache" as const });
function fail(status: number, code: string): never { throw new RoadTripError(status, code, "User-selected arrival rejected; no route or access assurance is returned."); }
export function arrivalDistance(a: ArrivalPoint, b: ArrivalPoint): number {
  const r = Math.PI / 180, x = Math.sin((b.lat - a.lat) * r / 2) ** 2 +
    Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(Math.min(1, x)), Math.sqrt(Math.max(0, 1 - x)));
}
export function parseArrival(raw: RoutingRouteRequest, enabled: boolean): ArrivalRequest | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (!Object.hasOwn(raw, "arrival")) return undefined;
  if (!requestValid(raw.arrival)) fail(400, "VALIDATION_ERROR");
  if (!enabled || raw.profileId !== "car" || raw.includeSteps !== true ||
    ["vehicle", "vehicleProfile", "trip", "via", "departureTime"].some(k => Object.hasOwn(raw, k)))
    fail(422, "ROUTING_ARRIVAL_UNSUPPORTED");
  if (raw.alternatives !== undefined && (!Number.isInteger(raw.alternatives) || raw.alternatives < 1 || raw.alternatives > 3)) fail(400, "VALIDATION_ERROR");
  const a = raw.arrival!;
  if (!raw.to || !Number.isFinite(raw.to.lon) || !Number.isFinite(raw.to.lat) || Math.abs(raw.to.lon) > 180 || Math.abs(raw.to.lat) > 90)
    fail(400, "VALIDATION_ERROR");
  if (arrivalDistance(raw.to, a.target) > 250) fail(422, "ROUTING_ARRIVAL_TOO_DISTANT");
  return structuredClone(a);
}
export function assessArrival(request: RoutingRouteRequest, query: Record<string, unknown>, route: RoutingRoute) {
  if (!request.arrival) return undefined;
  const proof = route.knownClosures, end = route.geometry.coordinates.at(-1);
  if (!proof || !end || route.status !== "ok" || route.quality.mode !== "engine_route" ||
      route.vehicleAssessment?.providerCosting !== "auto" || proof.engine.provider !== "valhalla" || proof.engine.fallbackUsed !== false ||
      proof.geometryHash !== canonicalRoutingHash(route.geometry) || proof.requestHash !== canonicalRoutingHash(query) ||
      Date.parse(proof.validUntil) <= Date.now()) fail(502, "ROUTING_ARRIVAL_INVALID");
  const mappedEndpoint = { lon: end[0], lat: end[1] }, target = request.arrival.target;
  const distanceM = arrivalDistance(mappedEndpoint, target), snapDistanceM = arrivalDistance(mappedEndpoint, request.to!);
  if (distanceM > 250) fail(422, "ROUTING_ARRIVAL_TOO_DISTANT");
  if (snapDistanceM > 25) fail(502, "ROUTING_ARRIVAL_INVALID");
  const result = { version: "sim-user-selected-arrival-v1", selection: "user_selected", target: { ...target },
    requestedAccess: { lon: request.to!.lon, lat: request.to!.lat }, mappedEndpoint, distanceM, snapDistanceM,
    remainingAccess: "unverified", requestHash: proof.requestHash, geometryHash: proof.geometryHash,
    routeId: route.routeId, routingDataset: proof.routingDataset, profileId: "car",
    engine: { ...proof.engine, costing: "auto" }, closureRevision: proof.revision, validUntil: proof.validUntil };
  if (!responseValid(result)) fail(502, "ROUTING_ARRIVAL_INVALID");
  return result;
}
