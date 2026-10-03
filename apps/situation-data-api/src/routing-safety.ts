import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { ValidateFunction } from "ajv";
import type { ExactRoutingDataset, RoutingCoordinate, RoutingRouteRequest } from "./routing-service.js";

const require = createRequire(import.meta.url);
const Ajv = require("ajv/dist/2020").default as new (options: object) => { compile: (schema: object) => ValidateFunction };
const formats = require("ajv-formats").default as (ajv: unknown) => void;
const schemas = JSON.parse(readFileSync(new URL("../../../openapi/fragments/road-trip-v1.schemas.json", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: false, allErrors: false, coerceTypes: false, removeAdditional: false, useDefaults: false });
formats(ajv);
const validator = (name: string) => ajv.compile({ components: { schemas }, $ref: `#/components/schemas/${name}` });
const validateTrip = validator("Trip"),
  validateCoordinate = validator("Coordinate");
export const validateRoadTripAssessment = validator("Assessment");
export const validateRoadTripCapabilities = validator("Capabilities");
export const ROAD_TRIP_FIELDS = ["heightM", "widthM", "lengthM", "loadedWeightKg"] as const;
export const ROAD_TRIP_MAX_GRAPH_AGE_SECONDS = 10 * 24 * 3600;

export interface RoadTrip {
  version: "sim-road-trip-v1";
  requestId: string;
  intent: "car" | "commercial_truck" | "car_with_trailer";
  vehicle: {
    heightM: number;
    widthM: number;
    lengthM: number;
    loadedWeightKg: number;
    axleLoadKg?: number;
    axleCount?: number;
    trailer: { attached: boolean; heightM?: number; widthM?: number; lengthM?: number; loadedWeightKg?: number; axleCount?: number };
  };
  departure: { mode: "now" | "depart_at"; at?: string };
  preferences: { avoidTolls: boolean; preferPaved: boolean };
  requirements: { roadClosures: "mandatory"; legalAccess: "mandatory"; vehicleLimits: "mandatory" };
  waypoints: Array<{ type: "via" | "stop"; point: RoutingCoordinate }>;
  destination: { kind: "road_point" | "approved_entrance"; entranceId?: string };
}
export interface RoadTripAssessment {
  version: "sim-road-trip-assessment-v1";
  requestId: string;
  requestHash: string;
  appliedHash: string;
  appliedTrip: RoadTrip;
  engine: { provider: "valhalla"; version: string; costing: "auto" | "truck"; fallbackUsed: false };
  geometryHash: string;
  routingDataset: ExactRoutingDataset & { sourceAgeSeconds: number; freshness: "current" };
  closures: {
    state: "applied";
    revision: string;
    observedAt: string;
    validUntil: string;
    appliedClosureCount: number;
    coverage: "authoritative_reviewed_snapshot";
  };
  vehicleLimits: { state: "provider_costing_applied"; appliedFields: string[]; coverage: "mapped_restrictions_incomplete" };
  waypoints: { state: "applied"; orderedCount: number };
  lastMile: "not_requested";
  validUntil: string;
  limitations: string[];
}
export interface RoadTripRoundabout {
  phase: "enter" | "exit";
  source: "valhalla_maneuver";
  countState: "provider_supplied" | "unknown";
  exitCount?: number;
  exitRoadNames?: string[];
  signNames?: string[];
}
export class RoadTripError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}
const fail = (status: number, code: string, message: string): never => {
  throw new RoadTripError(status, code, message);
};
export function canonicalRoutingHash(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical((v as Record<string, unknown>)[k])])
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function roadTripRequestHash(request: RoutingRouteRequest): string {
  return canonicalRoutingHash({ from: request.from, to: request.to, avoid: [...new Set(request.avoid)].sort(), trip: request.trip });
}
export function parseRoadTripRequest(raw: RoutingRouteRequest, defaultAlternatives: number): RoadTrip {
  const allowed = [
    "trip",
    "from",
    "to",
    "profileId",
    "avoid",
    "alternatives",
    "includeRoadAttributes",
    "includeSteps",
    "includeElevationProfile",
    "includeWeatherOnRoute",
    "includeHazardsOnRoute",
    "includeTraffic",
    "includeDebug"
  ];
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some((k) => !allowed.includes(k)) ||
    !validateTrip(raw.trip) ||
    !validateCoordinate(raw.from) ||
    !validateCoordinate(raw.to) ||
    raw.profileId !== "car" ||
    !Array.isArray(raw.avoid) ||
    !raw.avoid.includes("road_closure") ||
    raw.avoid.some((a) => !["flood", "fire", "road_closure", "unpaved", "tunnel", "bridge"].includes(a)) ||
    !Number.isInteger(raw.alternatives ?? defaultAlternatives) ||
    (raw.alternatives ?? defaultAlternatives) < 1 ||
    (raw.alternatives ?? defaultAlternatives) > 3 ||
    Object.keys(raw)
      .filter((k) => k.startsWith("include"))
      .some((k) => typeof (raw as unknown as Record<string, unknown>)[k] !== "boolean")
  ) {
    fail(400, "ROUTING_TRIP_INVALID", "Invalid immutable trip structure, coordinate, requirement or conflicting legacy parameter.");
  }
  const trip = structuredClone(raw.trip!);
  if ((trip.intent === "car_with_trailer") !== trip.vehicle.trailer.attached) {
    fail(400, "ROUTING_TRIP_INVALID", "Trailer intent and attached state must agree.");
  }
  // Validate the full snapshot before checking runtime support; never strip it.
  if (
    trip.vehicle.trailer.attached ||
    trip.vehicle.axleLoadKg !== undefined ||
    trip.vehicle.axleCount !== undefined ||
    trip.departure.mode !== "now" ||
    trip.destination.kind !== "road_point" ||
    raw.avoid!.some((a) => a === "flood" || a === "fire")
  ) {
    fail(
      422,
      "ROUTING_SAFETY_UNSUPPORTED",
      "Trailer, axle, planned departure, approved entrance and hazard exclusions require separate engine and source acceptance."
    );
  }
  return trip;
}

export interface ClosureSnapshot {
  version: "sim-reviewed-road-closures-v1";
  revision: string;
  routingDataset: ExactRoutingDataset;
  observedAt: string;
  validUntil: string;
  coverage: "authoritative_reviewed_snapshot";
  bbox: { west: number; south: number; east: number; north: number };
  closures: Array<{
    id: string;
    status: "active" | "revoked";
    direction: "both" | "forward" | "backward";
    validFrom: string;
    validUntil: string;
    polygon: Array<[number, number]>;
    source: { authority: string; reference: string; reviewedAt: string };
  }>;
}
export interface RoutingSafetyOptions {
  enabled: boolean;
  // Only exact accepted engine builds; an upgrade must be independently re-reviewed.
  acceptedEngineVersions: string[];
  loadClosureSnapshot: () => Promise<unknown>;
}
export function routingSafetyFromEnv(): RoutingSafetyOptions {
  const path = process.env.ROUTING_REVIEWED_CLOSURES_FILE;
  return {
    enabled: process.env.ROUTING_STRICT_TRIPS_ENABLED === "true",
    acceptedEngineVersions: (process.env.ROUTING_STRICT_ENGINE_VERSIONS ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    loadClosureSnapshot: async () => {
      if (!path || !path.startsWith("/")) fail(503, "ROUTING_CLOSURES_UNAVAILABLE", "Reviewed closure snapshot is not configured.");
      if ((await stat(path!)).size > 1024 * 1024) fail(503, "ROUTING_CLOSURES_UNAVAILABLE", "Closure snapshot exceeds the bounded source limit.");
      const text = await readFile(path!, "utf8");
      if (Buffer.byteLength(text) > 1024 * 1024) fail(503, "ROUTING_CLOSURES_UNAVAILABLE", "Closure snapshot exceeds the bounded source limit.");
      return JSON.parse(text);
    }
  };
}
export function roadTripCapabilities(options: RoutingSafetyOptions) {
  return {
    version: "sim-road-trip-capabilities-v1" as const,
    strictRoutesEnabled: options.enabled,
    availability: options.enabled ? "requires_runtime_validation" : "disabled",
    intents: [
      { intent: "car", costing: "auto", state: "requires_runtime_validation" },
      { intent: "commercial_truck", costing: "truck", state: "requires_runtime_validation" },
      { intent: "car_with_trailer", costing: "unsupported", state: "unsupported" }
    ],
    vehicleFields: [...ROAD_TRIP_FIELDS],
    unsupportedFields: ["trailer", "axleLoadKg", "axleCount", "depart_at", "approved_entrance"],
    closures: { mode: "reviewed_both_direction_polygons", state: "requires_runtime_validation", oneDirection: "unsupported" },
    graphMaxAgeSeconds: ROAD_TRIP_MAX_GRAPH_AGE_SECONDS,
    maxWaypoints: 12,
    maxAlternatives: 3,
    cachePolicy: "no_cache",
    emergencyExemption: false
  };
}
export type RoadTripCapabilities = ReturnType<typeof roadTripCapabilities>;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => record(v) && Object.keys(v).length === keys.length && keys.every((k) => k in v);
const boundedText = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;
const time = (v: unknown): number => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(v) ? Date.parse(v) : NaN);
export async function reviewedClosureSnapshot(options: RoutingSafetyOptions, dataset: ExactRoutingDataset, now: number): Promise<ClosureSnapshot> {
  let value: unknown;
  try {
    value = await options.loadClosureSnapshot();
  } catch {
    return fail(503, "ROUTING_CLOSURES_UNAVAILABLE", "Reviewed closure source could not be read.");
  }
  if (
    !exact(value, ["version", "revision", "routingDataset", "observedAt", "validUntil", "coverage", "bbox", "closures"]) ||
    value.version !== "sim-reviewed-road-closures-v1" ||
    !boundedText(value.revision) ||
    value.coverage !== "authoritative_reviewed_snapshot" ||
    !exact(value.routingDataset, ["version", "builtAt"]) ||
    value.routingDataset.version !== dataset.version ||
    value.routingDataset.builtAt !== dataset.builtAt ||
    !Number.isFinite(time(value.observedAt)) ||
    time(value.observedAt) > now ||
    !Number.isFinite(time(value.validUntil)) ||
    time(value.validUntil) <= now ||
    time(value.validUntil) - time(value.observedAt) > 15 * 60 * 1000 ||
    !exact(value.bbox, ["west", "south", "east", "north"]) ||
    Object.values(value.bbox).some((v) => typeof v !== "number" || !Number.isFinite(v)) ||
    !Array.isArray(value.closures) ||
    value.closures.length > 128
  ) {
    return fail(503, "ROUTING_CLOSURES_UNAVAILABLE", "Closure snapshot is incomplete, expired, invalid or bound to another graph.");
  }
  const snap = value as unknown as ClosureSnapshot,
    b = snap.bbox;
  if (b.west < -180 || b.east > 180 || b.south < -90 || b.north > 90 || b.west >= b.east || b.south >= b.north) {
    fail(503, "ROUTING_CLOSURES_UNAVAILABLE", "Invalid reviewed coverage bounds.");
  }
  const ids = new Set<string>();
  let vertices = 0;
  for (const c of snap.closures) {
    if (
      !exact(c, ["id", "status", "direction", "validFrom", "validUntil", "polygon", "source"]) ||
      !boundedText(c.id) ||
      ids.has(c.id) ||
      !["active", "revoked"].includes(c.status) ||
      !["both", "forward", "backward"].includes(c.direction) ||
      !Number.isFinite(time(c.validFrom)) ||
      !Number.isFinite(time(c.validUntil)) ||
      time(c.validFrom) >= time(c.validUntil) ||
      !exact(c.source, ["authority", "reference", "reviewedAt"]) ||
      !boundedText(c.source.authority) ||
      !boundedText(c.source.reference) ||
      !Number.isFinite(time(c.source.reviewedAt)) ||
      time(c.source.reviewedAt) > time(snap.observedAt) ||
      !Array.isArray(c.polygon) ||
      c.polygon.length < 4 ||
      c.polygon.length > 256 ||
      c.polygon.some((p) => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || !insideCoverage(p, b)) ||
      canonicalRoutingHash(c.polygon[0]) !== canonicalRoutingHash(c.polygon.at(-1))
    ) {
      fail(503, "ROUTING_CLOSURES_UNAVAILABLE", "Malformed closure, geometry or provenance; no partial exclusions are allowed.");
    }
    vertices += c.polygon.length;
    if (vertices > 4096) fail(503, "ROUTING_CLOSURES_UNAVAILABLE", "Closure geometry exceeds the bounded computation budget.");
    ids.add(c.id);
    if (c.status === "active" && time(c.validUntil) > now && c.direction !== "both") {
      fail(422, "ROUTING_SAFETY_UNSUPPORTED", "A directed closure cannot be represented by a both-direction polygon.");
    }
    // Only simple non-degenerate rings. Self-intersection would make exclusion ambiguous.
    const ring = c.polygon;
    const area = ring.slice(1).reduce((s, p, i) => s + ring[i]![0] * p[1] - p[0] * ring[i]![1], 0);
    if (Math.abs(area) < 1e-12) fail(503, "ROUTING_CLOSURES_UNAVAILABLE", "Degenerate closure polygon.");
    for (let i = 0; i < ring.length - 1; i++)
      for (let j = i + 2; j < ring.length - 1; j++) {
        if (i === 0 && j === ring.length - 2) continue;
        if (segmentsIntersect(ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!)) fail(503, "ROUTING_CLOSURES_UNAVAILABLE", "Self-intersecting closure polygon.");
      }
  }
  return structuredClone(snap);
}
export const activeClosures = (s: ClosureSnapshot, now: number) =>
  s.closures.filter((c) => c.status === "active" && time(c.validFrom) <= now && time(c.validUntil) > now);
export function snapshotDeadline(s: ClosureSnapshot, now: number): number {
  return Math.min(
    time(s.validUntil),
    ...s.closures
      .filter((c) => c.status === "active" && time(c.validUntil) > now)
      .map((c) => (time(c.validFrom) > now ? time(c.validFrom) : time(c.validUntil)))
  );
}
export function insideCoverage(p: [number, number], b: ClosureSnapshot["bbox"]): boolean {
  return p[0] >= b.west && p[0] <= b.east && p[1] >= b.south && p[1] <= b.north;
}
function segmentsIntersect(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const cross = (p: number[], q: number[], r: number[]) => (q[0]! - p[0]!) * (r[1]! - p[1]!) - (q[1]! - p[1]!) * (r[0]! - p[0]!);
  const on = (p: number[], q: number[], r: number[]) =>
    Math.abs(cross(p, q, r)) < 1e-12 &&
    r[0]! >= Math.min(p[0]!, q[0]!) &&
    r[0]! <= Math.max(p[0]!, q[0]!) &&
    r[1]! >= Math.min(p[1]!, q[1]!) &&
    r[1]! <= Math.max(p[1]!, q[1]!);
  return (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
}
function pointInRing(p: [number, number], ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!,
      b = ring[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function verifyClosureGeometry(shape: Array<[number, number]>, snapshot: ClosureSnapshot, now: number): void {
  if (shape.length < 2 || shape.some((p) => !p.every(Number.isFinite) || !insideCoverage(p, snapshot.bbox))) {
    fail(503, "ROUTING_CLOSURES_UNAVAILABLE", "Route lies outside the reviewed closure coverage.");
  }
  for (const c of activeClosures(snapshot, now)) {
    if (
      shape.some((p) => pointInRing(p, c.polygon)) ||
      shape.slice(1).some((p, i) => c.polygon.slice(1).some((q, j) => segmentsIntersect(shape[i]!, p, c.polygon[j]!, q)))
    ) {
      fail(502, "ROUTING_SAFETY_ENGINE_FAILED", "A returned variant intersects a mandatory closure; no variants will be returned.");
    }
  }
}
