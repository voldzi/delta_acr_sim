import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Express, Request, Response } from "express";
import type { SituationDataConfig } from "./config.js";
import { problem } from "./http.js";
import { RoutingError, type RoutingCoordinate, type RoutingService } from "./routing-service.js";

const CONTRACT_VERSION = "geo-routing-v1" as const;
const ROUTE_PATH = "/api/v1/geo-routing-v1/route";
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

type GeoRoutingProfile = "walking" | "bicycle";

interface GeoRoutingRequest {
  contractVersion: typeof CONTRACT_VERSION;
  profile: GeoRoutingProfile;
  locations: RoutingCoordinate[];
  options: {
    elevation: true;
    optimizeWaypointOrder: false;
  };
}

interface GeoRoutingResponse {
  contractVersion: typeof CONTRACT_VERSION;
  profile: GeoRoutingProfile;
  waypointOrder: number[];
  geometry: {
    type: "LineString";
    coordinates: Array<[number, number]>;
  };
  summary: {
    distanceM: number;
    durationSeconds: number;
    elevationGainM: number;
    elevationLossM: number;
  };
  routingDataset: {
    version: string;
    builtAt: string;
  };
  computedAt: string;
}

interface StoredIdempotentResponse {
  actor: string;
  requestHash: string;
  response: GeoRoutingResponse;
}

interface RateWindow {
  startedAtMs: number;
  count: number;
}

interface InFlightIdempotentResponse {
  requestHash: string;
  promise: Promise<GeoRoutingResponse>;
}

export function registerGeoRoutingRoutes(app: Express, config: SituationDataConfig, routing: RoutingService): void {
  const rateWindows = new Map<string, RateWindow>();
  const inFlight = new Map<string, InFlightIdempotentResponse>();

  app.post(ROUTE_PATH, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.header("origin")) {
      return problem(req, res, 403, "BROWSER_ACCESS_FORBIDDEN", "geo-routing-v1 is available only to authenticated backend services.");
    }
    const actor = authenticate(req, config);
    if (!actor) {
      res.setHeader("WWW-Authenticate", `Bearer realm="csm-sim", scope="geo-routing:route", audience="${config.geoRoutingAudience}"`);
      return problem(req, res, 401, "UNAUTHORIZED", "A valid scoped geo-routing service token is required.");
    }
    if (!consumeRateLimit(actor, config.geoRoutingRateLimitPerMinute, rateWindows, res)) {
      return problem(req, res, 429, "RATE_LIMITED", "The geo-routing service identity rate limit was exceeded.");
    }

    try {
      const parsed = parseRequest(req.body, config);
      const idempotencyKey = parseIdempotencyKey(req.header("idempotency-key"));
      const response = idempotencyKey
        ? await idempotentCompute(actor, idempotencyKey, parsed, config, routing, inFlight, res)
        : await computeResponse(parsed, routing);
      res.setHeader("X-Geo-Routing-Actor", actor);
      res.setHeader("X-Geo-Routing-Audience", config.geoRoutingAudience);
      return res.json(response);
    } catch (error) {
      if (error instanceof RoutingError) {
        return problem(req, res, error.status, error.code, error.message);
      }
      return problem(req, res, 500, "INTERNAL_ERROR", error instanceof Error ? error.message : "geo-routing-v1 failed.");
    }
  });
}

function authenticate(req: Request, config: SituationDataConfig): string | undefined {
  const match = /^Bearer\s+(.+)$/iu.exec(req.header("authorization") ?? "");
  const token = match?.[1]?.trim();
  if (!token) {
    return undefined;
  }
  return config.geoRoutingPrincipals.find((principal) => secureCompare(principal.token, token))?.actor;
}

function secureCompare(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function consumeRateLimit(actor: string, maxRequests: number, windows: Map<string, RateWindow>, res: Response): boolean {
  const now = Date.now();
  const existing = windows.get(actor);
  const window = !existing || now - existing.startedAtMs >= 60_000 ? { startedAtMs: now, count: 0 } : existing;
  window.count += 1;
  windows.set(actor, window);
  const remaining = Math.max(0, maxRequests - window.count);
  const resetSeconds = Math.max(1, Math.ceil((window.startedAtMs + 60_000 - now) / 1000));
  res.setHeader("X-RateLimit-Limit", String(maxRequests));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader("X-RateLimit-Reset", String(resetSeconds));
  if (window.count > maxRequests) {
    res.setHeader("Retry-After", String(resetSeconds));
    return false;
  }
  return true;
}

function parseRequest(value: unknown, config: SituationDataConfig): GeoRoutingRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutingError(400, "VALIDATION_ERROR", "Request body must be a JSON object.");
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set(["contractVersion", "profile", "locations", "options"]);
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new RoutingError(400, "VALIDATION_ERROR", `Unsupported request field(s): ${unknown.join(", ")}.`);
  }
  if (raw.contractVersion !== CONTRACT_VERSION) {
    throw new RoutingError(400, "VALIDATION_ERROR", `contractVersion must be ${CONTRACT_VERSION}.`);
  }
  if (raw.profile !== "walking" && raw.profile !== "bicycle") {
    throw new RoutingError(400, "VALIDATION_ERROR", "profile must be walking or bicycle.");
  }
  if (!Array.isArray(raw.locations) || raw.locations.length < 2 || raw.locations.length > config.geoRoutingMaxWaypoints) {
    throw new RoutingError(400, "VALIDATION_ERROR", `locations must contain between 2 and ${config.geoRoutingMaxWaypoints} points.`);
  }
  const locations = raw.locations.map((location, index) => parseLocation(location, index));
  const options = parseOptions(raw.options);
  const directDistanceM = orderedDirectDistanceM(locations);
  if (directDistanceM > config.geoRoutingMaxTotalDistanceM) {
    throw new RoutingError(
      400,
      "VALIDATION_ERROR",
      `Ordered straight-line distance ${Math.round(directDistanceM)} m exceeds limit ${config.geoRoutingMaxTotalDistanceM} m.`
    );
  }
  return { contractVersion: CONTRACT_VERSION, profile: raw.profile, locations, options };
}

function parseLocation(value: unknown, index: number): RoutingCoordinate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutingError(400, "VALIDATION_ERROR", `locations[${index}] must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !["longitude", "latitude"].includes(key));
  if (unknown.length > 0) {
    throw new RoutingError(400, "VALIDATION_ERROR", `locations[${index}] contains unsupported field(s): ${unknown.join(", ")}.`);
  }
  const longitude = Number(raw.longitude);
  const latitude = Number(raw.latitude);
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RoutingError(400, "VALIDATION_ERROR", `locations[${index}] must contain valid WGS84 longitude and latitude.`);
  }
  return { lon: longitude, lat: latitude };
}

function parseOptions(value: unknown): GeoRoutingRequest["options"] {
  if (value === undefined) {
    return { elevation: true, optimizeWaypointOrder: false };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutingError(400, "VALIDATION_ERROR", "options must be an object.");
  }
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !["elevation", "optimizeWaypointOrder"].includes(key));
  if (unknown.length > 0) {
    throw new RoutingError(400, "VALIDATION_ERROR", `Unsupported options field(s): ${unknown.join(", ")}.`);
  }
  if (raw.optimizeWaypointOrder === true) {
    throw new RoutingError(400, "WAYPOINT_OPTIMIZATION_NOT_SUPPORTED", "optimizeWaypointOrder=true is not supported by geo-routing-v1.");
  }
  if (raw.optimizeWaypointOrder !== undefined && raw.optimizeWaypointOrder !== false) {
    throw new RoutingError(400, "VALIDATION_ERROR", "optimizeWaypointOrder must be false.");
  }
  if (raw.elevation !== undefined && raw.elevation !== true) {
    throw new RoutingError(400, "VALIDATION_ERROR", "elevation must be true in geo-routing-v1.");
  }
  return { elevation: true, optimizeWaypointOrder: false };
}

function parseIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const key = value.trim();
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    throw new RoutingError(400, "VALIDATION_ERROR", "Idempotency-Key must contain 1-128 safe ASCII characters.");
  }
  return key;
}

async function computeResponse(request: GeoRoutingRequest, routing: RoutingService): Promise<GeoRoutingResponse> {
  const result = await routing.exactRoute(request.profile, request.locations);
  return {
    contractVersion: CONTRACT_VERSION,
    profile: request.profile,
    waypointOrder: request.locations.map((_location, index) => index),
    geometry: result.route.geometry,
    summary: {
      distanceM: Math.max(0, result.route.distanceM),
      durationSeconds: Math.max(0, result.route.durationSeconds),
      elevationGainM: Math.max(0, result.route.elevation!.gainM!),
      elevationLossM: Math.max(0, result.route.elevation!.lossM!)
    },
    routingDataset: result.routingDataset,
    computedAt: new Date().toISOString()
  };
}

async function idempotentCompute(
  actor: string,
  key: string,
  request: GeoRoutingRequest,
  config: SituationDataConfig,
  routing: RoutingService,
  inFlight: Map<string, InFlightIdempotentResponse>,
  res: Response
): Promise<GeoRoutingResponse> {
  const storageKey = createHash("sha256").update(`${actor}\0${key}`).digest("hex");
  const path = join(config.geoRoutingPrecomputeDir, `${storageKey}.json`);
  const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const existing = await readStored(path);
  if (existing) {
    if (existing.actor !== actor || existing.requestHash !== requestHash) {
      throw new RoutingError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used with a different geo-routing request.");
    }
    res.setHeader("X-Idempotent-Replay", "true");
    return existing.response;
  }
  const flightKey = `${actor}:${key}`;
  const active = inFlight.get(flightKey);
  if (active) {
    if (active.requestHash !== requestHash) {
      throw new RoutingError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key is in use with a different geo-routing request.");
    }
    const response = await active.promise;
    res.setHeader("X-Idempotent-Replay", "true");
    return response;
  }
  const promise = (async () => {
    const response = await computeResponse(request, routing);
    await mkdir(config.geoRoutingPrecomputeDir, { recursive: true });
    const stored: StoredIdempotentResponse = { actor, requestHash, response };
    const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
    return response;
  })();
  inFlight.set(flightKey, { requestHash, promise });
  try {
    res.setHeader("X-Idempotent-Replay", "false");
    return await promise;
  } finally {
    inFlight.delete(flightKey);
  }
}

async function readStored(path: string): Promise<StoredIdempotentResponse | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as StoredIdempotentResponse;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function orderedDirectDistanceM(locations: RoutingCoordinate[]): number {
  let total = 0;
  for (let index = 1; index < locations.length; index += 1) {
    total += haversineMeters(locations[index - 1]!, locations[index]!);
  }
  return total;
}

function haversineMeters(left: RoutingCoordinate, right: RoutingCoordinate): number {
  const earthRadiusM = 6_371_000;
  const lat1 = (left.lat * Math.PI) / 180;
  const lat2 = (right.lat * Math.PI) / 180;
  const latDelta = ((right.lat - left.lat) * Math.PI) / 180;
  const lonDelta = ((right.lon - left.lon) * Math.PI) / 180;
  const a = Math.sin(latDelta / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(lonDelta / 2) ** 2;
  return earthRadiusM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
