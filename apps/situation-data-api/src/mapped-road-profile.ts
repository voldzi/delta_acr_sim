import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { canonicalRoutingHash, RoadTripError } from "./routing-safety.js";
import type { RoutingRouteRequest, RoutingRoute, ExactRoutingDataset } from "./routing-service.js";
const require = createRequire(import.meta.url),
  Ajv = require("ajv/dist/2020").default,
  formats = require("ajv-formats");
const schemas = JSON.parse(readFileSync(new URL("../../../openapi/fragments/mapped-road-profile-v1.schemas.json", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
formats(ajv);
const validProfile = ajv.compile({ components: { schemas }, $ref: "#/components/schemas/Profile" });
export interface MappedVehicle {
  heightM: number;
  widthM: number;
  lengthM: number;
  loadedWeightKg: number;
  axleLoadKg?: number;
  axleCount?: number;
  trailer?: { attached: true; heightM: number; widthM: number; lengthM: number; loadedWeightKg: number };
}
export interface MappedRoadProfile {
  version: "sim-mapped-road-profile-v1";
  intent: "car" | "commercial_truck" | "car_with_trailer" | "road_legal_4x4";
  coverageAcknowledged: "mapped_restrictions_incomplete";
  vehicle?: MappedVehicle;
  driverDeclaredAuthorization?: boolean;
}
export interface MappedProfileAssessment {
  version: "sim-mapped-road-profile-assessment-v1";
  state: "applied";
  coverage: "mapped_restrictions_incomplete";
  appliedProfile: MappedRoadProfile;
  profileHash: string;
  requestHash: string;
  geometryHash: string;
  engine: { provider: "valhalla"; version: "3.8.3"; costing: "auto" | "truck"; fallbackUsed: false };
  routingDataset: ExactRoutingDataset;
  appliedFields: string[];
  validUntil: string;
  lastMile: {
    state: "mapped_target" | "target_guidance_only";
    target: { lon: number; lat: number };
    mappedEndpoint: { lon: number; lat: number };
    distanceM: number;
  };
  limitations: string[];
}
const fail = (status: number, code: string, message: string): never => {
  throw new RoadTripError(status, code, message);
};
export function parseMappedProfile(raw: RoutingRouteRequest): MappedRoadProfile | undefined {
  if (!Object.prototype.hasOwnProperty.call(raw, "vehicleProfile")) return undefined;
  const allowed = [
    "vehicleProfile",
    "profileId",
    "from",
    "to",
    "via",
    "avoid",
    "departureTime",
    "alternatives",
    "includeSteps",
    "includeRoadAttributes",
    "includeElevationProfile",
    "includeWeatherOnRoute",
    "includeHazardsOnRoute",
    "includeTraffic",
    "includeDebug"
  ];
  if (
    !validProfile(raw.vehicleProfile) ||
    Object.keys(raw).some((k) => !allowed.includes(k)) ||
    (raw.profileId !== undefined && raw.profileId !== "car") ||
    (raw.alternatives !== undefined && (!Number.isInteger(raw.alternatives) || raw.alternatives < 1 || raw.alternatives > 3)) ||
    (raw.avoid !== undefined &&
      (!Array.isArray(raw.avoid) ||
        raw.avoid.some((a) => typeof a !== "string" || !["flood", "fire", "road_closure", "unpaved", "tunnel", "bridge"].includes(a)))) ||
    [raw.from, raw.to, ...(Array.isArray(raw.via) ? raw.via : [])].some(
      (c) => !c || typeof c.lon !== "number" || typeof c.lat !== "number" || !Number.isFinite(c.lon) || !Number.isFinite(c.lat)
    ) ||
    Object.entries(raw).some(([k, v]) => k.startsWith("include") && typeof v !== "boolean") ||
    (raw.via !== undefined && (!Array.isArray(raw.via) || raw.via.length > 12))
  )
    fail(400, "ROUTING_PROFILE_INVALID", "Invalid immutable mapped profile or conflicting legacy/strict fields.");
  const p = structuredClone(raw.vehicleProfile!),
    v = p.vehicle;
  if (v?.trailer && (["heightM", "widthM", "lengthM", "loadedWeightKg"] as const).some((k) => v[k] < v.trailer![k]))
    fail(400, "ROUTING_PROFILE_INVALID", "Vehicle dimensions and loaded weight must describe the WHOLE combination, not the towing vehicle alone.");
  if (v?.axleLoadKg !== undefined && v.axleLoadKg > v.loadedWeightKg)
    fail(400, "ROUTING_PROFILE_INVALID", "Axle load exceeds the whole loaded vehicle weight.");
  if (
    raw.departureTime !== undefined ||
    raw.avoid?.some((a) => a === "flood" || a === "fire") ||
    p.driverDeclaredAuthorization === true ||
    (p.intent !== "commercial_truck" && (v?.axleCount !== undefined || v?.axleLoadKg !== undefined))
  )
    fail(
      422,
      "ROUTING_PROFILE_UNSUPPORTED",
      "Requested permission exemption, axle profile, future departure or hazard exclusion has no accepted engine mechanism; no downgrade."
    );
  return p;
}
export const mappedCosting = (p: MappedRoadProfile): "auto" | "truck" => (p.intent === "commercial_truck" ? "truck" : "auto");
export function mappedCostOptions(p: MappedRoadProfile): Record<string, number | boolean> {
  const base: Record<string, number | boolean> = {
    ignore_restrictions: false,
    ignore_oneways: false,
    ignore_access: false,
    ignore_closures: false,
    ignore_non_vehicular_restrictions: false,
    use_tracks: 0,
    shortest: false
  };
  if (p.vehicle) {
    const v = p.vehicle;
    Object.assign(base, { height: v.heightM, width: v.widthM, length: v.lengthM, weight: v.loadedWeightKg / 1000 });
    if (v.axleLoadKg !== undefined) base.axle_load = v.axleLoadKg / 1000;
    if (v.axleCount !== undefined) base.axle_count = v.axleCount;
  }
  if (p.intent === "commercial_truck") base.hgv_no_access_penalty = 43200;
  if (p.intent === "road_legal_4x4") base.use_tracks = 0.1; // Road-first preference, never an access exemption.
  return base;
}
export function mappedLimitations(p: MappedRoadProfile): string[] {
  return [
    "Mapped vehicle restrictions are incomplete; legal access, physical passability and current signage remain the driver's responsibility.",
    ...(!p.vehicle ? ["No actual dimensions or loaded weight supplied; engine defaults are not measurements of this vehicle."] : []),
    ...(p.intent === "car_with_trailer"
      ? ["Whole-combination dimensions/weight are applied under auto access; trailer-specific bans, articulation and turning clearance are not evaluated."]
      : []),
    ...(p.intent === "road_legal_4x4"
      ? ["Road-first mapped routing may use unpaved access. It does not create a road across unmapped ground or grant private/forestry access."]
      : []),
    ...(p.intent === "commercial_truck" && !p.vehicle?.axleLoadKg
      ? ["No measured axle load supplied; the engine default is not an actual vehicle measurement."]
      : []),
    ...(p.intent === "commercial_truck" && !p.vehicle?.axleCount
      ? ["No measured axle count supplied; the engine default is not an actual vehicle measurement."]
      : [])
  ];
}
export function mappedCapabilities(enabled: boolean) {
  const dimensions = ["heightM", "widthM", "lengthM", "loadedWeightKg"];
  return {
    version: "sim-mapped-road-profile-capabilities-v1" as const,
    availability: enabled ? "requires_runtime_validation" : "disabled",
    intents: (["car", "commercial_truck", "car_with_trailer", "road_legal_4x4"] as const).map((intent) => ({
      intent,
      costing: intent === "commercial_truck" ? "truck" : "auto",
      supportedFields: [
        ...dimensions,
        ...(intent === "commercial_truck" ? ["axleLoadKg", "axleCount"] : []),
        ...(intent === "car_with_trailer" ? ["whole_combination", "trailer_facts"] : []),
        ...(intent === "road_legal_4x4" ? ["road_first_preference", "mapped_endpoint_guidance"] : [])
      ],
      limitations: mappedLimitations({ version: "sim-mapped-road-profile-v1", intent, coverageAcknowledged: "mapped_restrictions_incomplete" })
    })),
    maxSnapDistanceM: 25,
    driverDeclaredAuthorization: "unsupported",
    unmappedLastMile: "unsupported",
    strictGuarantees: false
  };
}
export function mappedAssessment(
  request: RoutingRouteRequest,
  query: unknown,
  route: RoutingRoute,
  dataset: ExactRoutingDataset,
  version: string,
  validUntil: string
): MappedProfileAssessment {
  const p = request.vehicleProfile!;
  if (version !== "3.8.3") fail(503, "ROUTING_PROFILE_UNAVAILABLE", "Exact profile engine build is not accepted.");
  const end = route.geometry.coordinates.at(-1)!,
    target = { lon: request.to!.lon, lat: request.to!.lat },
    mappedEndpoint = { lon: end[0], lat: end[1] },
    r = Math.PI / 180;
  const a = Math.sin(((end[1] - target.lat) * r) / 2) ** 2 + Math.cos(end[1] * r) * Math.cos(target.lat * r) * Math.sin(((end[0] - target.lon) * r) / 2) ** 2,
    distanceM = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  if (!Number.isFinite(distanceM) || distanceM > 25)
    fail(422, "ROUTING_TARGET_NOT_ROUTABLE", "Target is farther than accepted mapped endpoint tolerance; no synthetic navigable final leg.");
  return {
    version: "sim-mapped-road-profile-assessment-v1",
    state: "applied",
    coverage: "mapped_restrictions_incomplete",
    appliedProfile: structuredClone(p),
    profileHash: canonicalRoutingHash(p),
    requestHash: canonicalRoutingHash(query),
    geometryHash: canonicalRoutingHash(route.geometry),
    engine: { provider: "valhalla", version: "3.8.3", costing: mappedCosting(p), fallbackUsed: false },
    routingDataset: dataset,
    appliedFields: [
      ...(p.vehicle ? ["heightM", "widthM", "lengthM", "loadedWeightKg"] : []),
      ...(p.vehicle?.axleLoadKg !== undefined ? ["axleLoadKg"] : []),
      ...(p.vehicle?.axleCount !== undefined ? ["axleCount"] : []),
      ...(p.intent === "road_legal_4x4" ? ["road_first_preference"] : [])
    ],
    validUntil,
    lastMile: { state: end[0] === target.lon && end[1] === target.lat ? "mapped_target" : "target_guidance_only", target, mappedEndpoint, distanceM },
    limitations: mappedLimitations(p)
  };
}
