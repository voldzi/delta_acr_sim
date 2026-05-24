import {
  CONTRACT_VERSION,
  DEFAULT_ADAPTER_ID,
  type CanonicalEventEnvelope,
  type Scenario,
  type ScenarioBlock
} from "@csm-sim/contracts";
import { randomUUID } from "node:crypto";

export interface GenerateOptions {
  sourceSystemId: string;
  adapterVersion: string;
  timestamp?: Date;
  tick?: number;
  elapsedSeconds?: number;
  tickIntervalSeconds?: number;
  speedMultiplier?: number;
}

export interface ActiveObjectCountOptions {
  elapsedSeconds?: number;
  tickIntervalSeconds?: number;
  speedMultiplier?: number;
}

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0xffffffff;
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

export const MAX_OBJECTS_PER_BLOCK = 500;

const MIN_ROUTE_MARGIN_M = 300;
const MIN_LOITER_RADIUS_M = 250;
const MAX_LOITER_RADIUS_M = 5500;
const MIN_SURVEY_SPAN_M = 1200;

const objectTypesByBlock: Record<string, CanonicalEventEnvelope["payload"]["objectType"]> = {
  "air-sim-aircraft": "AIRCRAFT",
  "air-sim-uav": "UAV",
  "air-sim-missile": "MISSILE_TRACK",
  "ground-sim-friendly": "GROUND_UNIT",
  "rescue-sim": "INCIDENT",
  "report-sim": "REPORT"
};

const domainsByBlock: Record<string, CanonicalEventEnvelope["payload"]["domain"]> = {
  "air-sim-aircraft": "AIR",
  "air-sim-uav": "AIR",
  "air-sim-missile": "AIR",
  "ground-sim-friendly": "LAND",
  "rescue-sim": "RESCUE",
  "report-sim": "OTHER"
};

const speedProfilesByBlock: Record<string, { minMps: number; maxMps: number }> = {
  "air-sim-aircraft": { minMps: 130, maxMps: 260 },
  "air-sim-uav": { minMps: 22, maxMps: 75 },
  "air-sim-missile": { minMps: 250, maxMps: 900 },
  "ground-sim-friendly": { minMps: 2, maxMps: 12 },
  "rescue-sim": { minMps: 0, maxMps: 0 },
  "report-sim": { minMps: 0, maxMps: 0 }
};

export function generateScenarioEvents(
  scenario: Scenario,
  options: GenerateOptions
): CanonicalEventEnvelope[] {
  const scenarioId = scenario.scenarioId ?? randomUUID();
  const timestamp = (options.timestamp ?? new Date()).toISOString();
  const tick = options.tick ?? 0;
  const tickIntervalSeconds = Math.max(0.1, options.tickIntervalSeconds ?? 1);
  const elapsedSeconds = options.elapsedSeconds ?? tick * tickIntervalSeconds;
  const speedMultiplier = Math.max(0.1, options.speedMultiplier ?? 1);
  const events: CanonicalEventEnvelope[] = [];

  for (const block of scenario.blocks.filter((item) => item.enabled)) {
    if (!shouldEmitBlock(block, tick, tickIntervalSeconds)) {
      continue;
    }
    const count = cappedObjectCount(block);
    for (let index = 0; index < count; index += 1) {
      const event = buildEventForBlock(scenario, scenarioId, block, index, tick, elapsedSeconds, speedMultiplier, tickIntervalSeconds, timestamp, options);
      if (event) {
        events.push(event);
      }
    }
  }

  return events;
}

export function countActiveScenarioObjects(scenario: Scenario, options: ActiveObjectCountOptions = {}): number {
  const elapsedSeconds = Math.max(0, options.elapsedSeconds ?? 0);
  const speedMultiplier = Math.max(0.1, options.speedMultiplier ?? 1);
  const tickIntervalSeconds = Math.max(0.1, options.tickIntervalSeconds ?? 1);
  let count = 0;

  for (const block of scenario.blocks.filter((item) => item.enabled)) {
    const objectType = objectTypesByBlock[block.blockId] ?? "UNKNOWN";
    const domain = domainsByBlock[block.blockId] ?? "OTHER";
    const blockCount = cappedObjectCount(block);

    for (let index = 0; index < blockCount; index += 1) {
      const profile = createTrackProfile(scenario, block, index, objectType, domain);
      const movement = computeTrackPosition(scenario, profile, elapsedSeconds * speedMultiplier, tickIntervalSeconds * speedMultiplier);
      if (!movement.expired) {
        count += 1;
      }
    }
  }

  return count;
}

function buildEventForBlock(
  scenario: Scenario,
  scenarioId: string,
  block: ScenarioBlock,
  index: number,
  tick: number,
  elapsedSeconds: number,
  speedMultiplier: number,
  tickIntervalSeconds: number,
  timestamp: string,
  options: GenerateOptions
): CanonicalEventEnvelope | null {
  const objectType = objectTypesByBlock[block.blockId] ?? "UNKNOWN";
  const domain = domainsByBlock[block.blockId] ?? "OTHER";
  const objectId = `${objectIdPrefixForBlock(block)}-${String(index + 1).padStart(4, "0")}`;
  const profile = createTrackProfile(scenario, block, index, objectType, domain);
  const movement = computeTrackPosition(scenario, profile, elapsedSeconds * speedMultiplier, tickIntervalSeconds * speedMultiplier);

  if (movement.expired) {
    return null;
  }

  return {
    eventId: randomUUID(),
    eventType: eventTypeFor(objectType, tick, movement.status),
    contractVersion: CONTRACT_VERSION,
    correlationId: randomUUID(),
    source: {
      sourceSystemId: options.sourceSystemId,
      sourceDeviceId: block.blockId,
      adapterId: DEFAULT_ADAPTER_ID,
      adapterVersion: options.adapterVersion
    },
    producerTimestamp: timestamp,
    sequence: {
      streamId: `${block.blockId}-main`,
      number: tick * 100000 + index
    },
    classification: {
      level: "UNCLASSIFIED",
      releasability: ["CZE"],
      handlingCaveats: ["SYNTHETIC"]
    },
    geo: {
      lat: movement.lat,
      lon: movement.lon,
      altitudeM: movement.altitudeM,
      accuracyM: movement.accuracyM
    },
    payload: {
      objectId,
      objectType,
      affiliation: profile.affiliation,
      domain,
      status: movement.status,
      speedMps: movement.status === "LOST" ? 0 : Number(profile.speedMps.toFixed(1)),
      headingDeg: Number(movement.headingDeg.toFixed(1)),
      verticalRateMps: movement.verticalRateMps,
      attributes: {
        syntheticPattern: profile.pattern,
        motionModel: profile.customRoute ? "SCRIPTED_SYNTHETIC_INTERCEPT" : profile.pattern === "SHORT_LIVED_TRACK" ? "STRAIGHT_TRANSIT" : "CONTINUOUS_KINEMATIC",
        sampleIntervalSeconds: tickIntervalSeconds,
        trackAgeSeconds: Math.round(elapsedSeconds * speedMultiplier),
        tick,
        simplifiedTrack: objectType === "MISSILE_TRACK",
        note: "Synthetic COP test data only",
        ...(profile.customRoute
          ? {
              engagementId: profile.customRoute.engagementId,
              engagementRole: profile.customRoute.role,
              engagementFamily: profile.customRoute.family,
              pairedObjectId: profile.customRoute.pairedObjectId,
              routeLabel: profile.customRoute.routeLabel,
              sourceReferenceDate: profile.customRoute.sourceReferenceDate,
              terminalAtSeconds: profile.customRoute.terminalAtSeconds,
              terminalMode: profile.customRoute.terminalMode,
              destroyedInScenario: profile.customRoute.destroyed,
              modeledInterceptedRatio: profile.customRoute.interceptedRatio
            }
          : {})
      }
    },
    quality: {
      confidence: movement.status === "LOST" ? 0.35 : profile.confidence,
      sourceReliability: "A",
      informationCredibility: "1"
    },
    simulation: {
      synthetic: true,
      scenarioId,
      blockId: block.blockId,
      seed: scenario.seed
    },
    signature: {
      signed: false,
      keyId: null,
      algorithm: null
    }
  };
}

interface TrackProfile {
  blockId: string;
  pattern: string;
  domain: CanonicalEventEnvelope["payload"]["domain"];
  objectType: CanonicalEventEnvelope["payload"]["objectType"];
  affiliation: NonNullable<CanonicalEventEnvelope["payload"]["affiliation"]>;
  originLat: number;
  originLon: number;
  headingDeg: number;
  speedMps: number;
  altitudeM: number;
  verticalRateMps: number;
  accuracyM: number;
  confidence: number;
  loiterRadiusM: number;
  loiterAngularDegPerSecond: number;
  loiterDirection: 1 | -1;
  surveyWidthM: number;
  surveyHeightM: number;
  surveyRows: number;
  ttlSeconds: number;
  customRoute?: CustomRouteProfile;
}

interface TrackPosition {
  lat: number;
  lon: number;
  headingDeg: number;
  altitudeM: number;
  verticalRateMps: number;
  accuracyM: number;
  status: "ACTIVE" | "LOST";
  expired: boolean;
}

interface AreaProjection {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  refLat: number;
  widthM: number;
  heightM: number;
}

interface LocalPoint {
  xM: number;
  yM: number;
}

interface CustomRouteProfile {
  role: "HOSTILE_INBOUND" | "FRIEND_INTERCEPTOR";
  family: "uav" | "missile";
  startLat: number;
  startLon: number;
  terminalLat: number;
  terminalLon: number;
  headingDeg: number;
  terminalAtSeconds: number;
  terminalMode: "INTERCEPT" | "TRANSIT";
  engagementId: string;
  pairedObjectId?: string;
  routeLabel: string;
  sourceReferenceDate: string;
  destroyed: boolean;
  interceptedRatio: number;
}

function shouldEmitBlock(block: ScenarioBlock, tick: number, tickIntervalSeconds: number): boolean {
  if (tick === 0) {
    return true;
  }
  if (block.updateRateHz <= 0) {
    return false;
  }
  const intervalTicks = Math.max(1, Math.round(1 / Math.max(0.001, block.updateRateHz * tickIntervalSeconds)));
  return tick % intervalTicks === 0;
}

function createTrackProfile(
  scenario: Scenario,
  block: ScenarioBlock,
  index: number,
  objectType: CanonicalEventEnvelope["payload"]["objectType"],
  domain: CanonicalEventEnvelope["payload"]["domain"]
): TrackProfile {
  const rng = new SeededRandom(scenario.seed + hashString(block.blockId) * 17 + index * 7919);
  const area = projectArea(scenario);
  const pattern = block.patterns?.[index % Math.max(1, block.patterns.length)] ?? defaultPatternFor(block.blockId);
  const speedMps = speedFor(block.blockId, rng);
  let origin = randomPointWithinMargins(area, rng, 0, 0);
  let headingDeg = rng.range(0, 359);
  let loiterRadiusM = rng.range(1000, MAX_LOITER_RADIUS_M);
  let surveyWidthM = rng.range(8000, 18_000);
  let surveyHeightM = rng.range(5000, 12_000);
  const surveyRows = Math.max(3, Math.round(rng.range(4, 7)));

  if (pattern === "LOITER") {
    const maxRadiusForArea = Math.max(
      MIN_LOITER_RADIUS_M,
      Math.min(MAX_LOITER_RADIUS_M, area.widthM * 0.22, area.heightM * 0.22)
    );
    loiterRadiusM = Math.min(loiterRadiusM, maxRadiusForArea);
    const margin = Math.max(loiterRadiusM + MIN_ROUTE_MARGIN_M, MIN_ROUTE_MARGIN_M);
    origin = randomPointWithinMargins(area, rng, margin, margin);
    const availableRadiusM = Math.max(
      0,
      Math.min(
        origin.xM - MIN_ROUTE_MARGIN_M,
        area.widthM - origin.xM - MIN_ROUTE_MARGIN_M,
        origin.yM - MIN_ROUTE_MARGIN_M,
        area.heightM - origin.yM - MIN_ROUTE_MARGIN_M
      )
    );
    loiterRadiusM = Math.max(
      Math.min(MIN_LOITER_RADIUS_M, availableRadiusM),
      Math.min(loiterRadiusM, availableRadiusM)
    );
  }

  if (pattern === "SURVEY") {
    surveyWidthM = Math.max(MIN_SURVEY_SPAN_M, Math.min(surveyWidthM, area.widthM * 0.42));
    surveyHeightM = Math.max(MIN_SURVEY_SPAN_M, Math.min(surveyHeightM, area.heightM * 0.42));
    origin = randomPointWithinMargins(area, rng, surveyWidthM / 2 + MIN_ROUTE_MARGIN_M, surveyHeightM / 2 + MIN_ROUTE_MARGIN_M);
  }

  if (objectType === "MISSILE_TRACK" && pattern === "SHORT_LIVED_TRACK") {
    const edge = index % 4;
    const edgeInsetM = MIN_ROUTE_MARGIN_M;
    if (edge === 0) {
      origin = { xM: edgeInsetM, yM: rng.range(edgeInsetM, Math.max(edgeInsetM, area.heightM - edgeInsetM)) };
      headingDeg = normalizeHeading(90 + rng.range(-12, 12));
    } else if (edge === 1) {
      origin = { xM: Math.max(edgeInsetM, area.widthM - edgeInsetM), yM: rng.range(edgeInsetM, Math.max(edgeInsetM, area.heightM - edgeInsetM)) };
      headingDeg = normalizeHeading(270 + rng.range(-12, 12));
    } else if (edge === 2) {
      origin = { xM: rng.range(edgeInsetM, Math.max(edgeInsetM, area.widthM - edgeInsetM)), yM: edgeInsetM };
      headingDeg = normalizeHeading(rng.range(-12, 12));
    } else {
      origin = { xM: rng.range(edgeInsetM, Math.max(edgeInsetM, area.widthM - edgeInsetM)), yM: Math.max(edgeInsetM, area.heightM - edgeInsetM) };
      headingDeg = normalizeHeading(180 + rng.range(-12, 12));
    }
  }

  const originGeo = fromLocalPoint(area, origin);
  const loiterDirection = rng.next() >= 0.5 ? 1 : -1;
  const customRoute = buildCustomRoute(block, index, objectType, scenario.durationSeconds);
  const effectiveOrigin = customRoute ? { lat: customRoute.startLat, lon: customRoute.startLon } : originGeo;
  const effectiveHeading = customRoute?.headingDeg ?? headingDeg;
  const effectiveSpeedMps = customRoute ? distanceBetweenGeo(customRoute.startLat, customRoute.startLon, customRoute.terminalLat, customRoute.terminalLon) / customRoute.terminalAtSeconds : speedMps;
  const effectiveTtlSeconds = customRoute?.terminalAtSeconds ?? (objectType === "MISSILE_TRACK" ? Math.round(rng.range(45, 120)) : scenario.durationSeconds);

  return {
    blockId: block.blockId,
    pattern,
    domain,
    objectType,
    affiliation: affiliationForBlock(block, index, objectType),
    originLat: effectiveOrigin.lat,
    originLon: effectiveOrigin.lon,
    headingDeg: effectiveHeading,
    speedMps: effectiveSpeedMps,
    altitudeM: domain === "AIR" ? Math.round(rng.range(900, objectType === "MISSILE_TRACK" ? 4500 : 9500)) : 0,
    verticalRateMps: domain === "AIR" ? Number(rng.range(-3, 3).toFixed(1)) : 0,
    accuracyM: Math.round(rng.range(15, 140)),
    confidence: Number(rng.range(0.79, 0.98).toFixed(2)),
    loiterRadiusM,
    loiterAngularDegPerSecond: speedMps > 0 && loiterRadiusM > 0 ? toDegrees(speedMps / loiterRadiusM) * loiterDirection : 0,
    loiterDirection,
    surveyWidthM,
    surveyHeightM,
    surveyRows,
    ttlSeconds: effectiveTtlSeconds,
    customRoute
  };
}

function affiliationForBlock(
  block: ScenarioBlock,
  index: number,
  objectType: CanonicalEventEnvelope["payload"]["objectType"]
): NonNullable<CanonicalEventEnvelope["payload"]["affiliation"]> {
  const configuredAffiliations = Array.isArray(block.parameters?.affiliations) ? block.parameters.affiliations : undefined;
  const validConfigured = configuredAffiliations?.filter(isAffiliation);
  if (validConfigured?.length) {
    return validConfigured[index % validConfigured.length]!;
  }

  if (block.blockId === "ground-sim-friendly") {
    return index % 3 === 0 ? "ASSUMED_FRIEND" : "FRIEND";
  }
  if (objectType === "MISSILE_TRACK") {
    return "HOSTILE";
  }
  if (block.blockId === "air-sim-aircraft") {
    return ["FRIEND", "HOSTILE", "ASSUMED_FRIEND", "SUSPECT"][index % 4] as NonNullable<CanonicalEventEnvelope["payload"]["affiliation"]>;
  }
  if (block.blockId === "air-sim-uav") {
    return ["HOSTILE", "SUSPECT", "FRIEND"][index % 3] as NonNullable<CanonicalEventEnvelope["payload"]["affiliation"]>;
  }
  return "UNKNOWN";
}

function isAffiliation(value: unknown): value is NonNullable<CanonicalEventEnvelope["payload"]["affiliation"]> {
  return (
    value === "FRIEND" ||
    value === "ASSUMED_FRIEND" ||
    value === "NEUTRAL" ||
    value === "UNKNOWN" ||
    value === "SUSPECT" ||
    value === "HOSTILE" ||
    value === "PENDING"
  );
}

function computeTrackPosition(
  scenario: Scenario,
  profile: TrackProfile,
  elapsedSeconds: number,
  tickIntervalSeconds: number
): TrackPosition {
  if (profile.customRoute) {
    return computeCustomRoutePosition(profile, elapsedSeconds, tickIntervalSeconds);
  }

  if (profile.objectType === "MISSILE_TRACK" && profile.pattern === "SHORT_LIVED_TRACK") {
    const lostWindowSeconds = Math.max(1, tickIntervalSeconds * 1.5);
    if (elapsedSeconds > profile.ttlSeconds + lostWindowSeconds) {
      return {
        lat: profile.originLat,
        lon: profile.originLon,
        headingDeg: profile.headingDeg,
        altitudeM: profile.altitudeM,
        verticalRateMps: 0,
        accuracyM: profile.accuracyM,
        status: "LOST",
        expired: true
      };
    }
  }

  const status = profile.objectType === "MISSILE_TRACK" && profile.pattern === "SHORT_LIVED_TRACK" && elapsedSeconds >= profile.ttlSeconds ? "LOST" : "ACTIVE";
  const motionSeconds = Math.min(elapsedSeconds, profile.ttlSeconds);
  const position =
    profile.pattern === "LOITER"
      ? loiterPosition(scenario, profile, motionSeconds)
      : profile.pattern === "SURVEY"
        ? surveyPosition(scenario, profile, motionSeconds)
        : profile.pattern === "PATROL"
          ? patrolPosition(scenario, profile, motionSeconds)
          : directPosition(scenario, profile, motionSeconds);

  return {
    ...position,
    altitudeM: status === "LOST" ? profile.altitudeM : Math.max(0, Math.round(profile.altitudeM + profile.verticalRateMps * Math.sin(motionSeconds / 40) * 25)),
    verticalRateMps: status === "LOST" ? 0 : profile.verticalRateMps,
    accuracyM: status === "LOST" ? Math.round(profile.accuracyM * 3) : profile.accuracyM,
    status,
    expired: false
  };
}

function computeCustomRoutePosition(profile: TrackProfile, elapsedSeconds: number, tickIntervalSeconds: number): TrackPosition {
  const route = profile.customRoute!;
  const lostWindowSeconds = Math.max(2, tickIntervalSeconds * 1.5);
  const terminalReached = route.terminalMode === "INTERCEPT" && elapsedSeconds >= route.terminalAtSeconds;

  if (route.terminalMode === "INTERCEPT" && elapsedSeconds > route.terminalAtSeconds + lostWindowSeconds) {
    return {
      lat: route.terminalLat,
      lon: route.terminalLon,
      headingDeg: route.headingDeg,
      altitudeM: profile.altitudeM,
      verticalRateMps: 0,
      accuracyM: profile.accuracyM,
      status: "LOST",
      expired: true
    };
  }

  const progress = Math.min(1, Math.max(0, elapsedSeconds / route.terminalAtSeconds));
  const point =
    route.terminalMode === "TRANSIT" && progress >= 1
      ? moveMeters(route.startLat, route.startLon, route.headingDeg, profile.speedMps * elapsedSeconds)
      : interpolateGeo(route.startLat, route.startLon, route.terminalLat, route.terminalLon, progress);

  return {
    ...point,
    headingDeg: route.headingDeg,
    altitudeM: Math.max(0, Math.round(profile.altitudeM + profile.verticalRateMps * Math.sin(elapsedSeconds / 40) * 25)),
    verticalRateMps: terminalReached ? 0 : profile.verticalRateMps,
    accuracyM: terminalReached ? Math.round(profile.accuracyM * 3) : profile.accuracyM,
    status: terminalReached ? "LOST" : "ACTIVE",
    expired: false
  };
}

function directPosition(scenario: Scenario, profile: TrackProfile, elapsedSeconds: number): Pick<TrackPosition, "lat" | "lon" | "headingDeg"> {
  const distanceM = profile.speedMps * elapsedSeconds;
  if (profile.pattern === "SHORT_LIVED_TRACK") {
    const moved = moveMeters(profile.originLat, profile.originLon, profile.headingDeg, distanceM);
    return {
      ...moved,
      headingDeg: profile.headingDeg
    };
  }

  const area = projectArea(scenario);
  const origin = toLocalPoint(area, profile.originLat, profile.originLon);
  const moved = moveLocal(origin, profile.headingDeg, distanceM);
  const reflected = reflectPointWithinArea(area, moved, profile.headingDeg);
  const geo = fromLocalPoint(area, reflected.point);

  return {
    ...geo,
    headingDeg: reflected.headingDeg
  };
}

function patrolPosition(scenario: Scenario, profile: TrackProfile, elapsedSeconds: number): Pick<TrackPosition, "lat" | "lon" | "headingDeg"> {
  const area = projectArea(scenario);
  const origin = toLocalPoint(area, profile.originLat, profile.originLon);
  const desiredHalfSegmentM = Math.max(5000, profile.speedMps * 80);
  const forwardLimitM = distanceToAreaEdge(area, origin, profile.headingDeg);
  const backwardLimitM = distanceToAreaEdge(area, origin, profile.headingDeg + 180);
  const halfSegmentM = Math.min(desiredHalfSegmentM, forwardLimitM * 0.85, backwardLimitM * 0.85);

  if (!Number.isFinite(halfSegmentM) || halfSegmentM < 1000 || profile.speedMps <= 0) {
    return directPosition(scenario, profile, elapsedSeconds);
  }

  const start = moveLocal(origin, profile.headingDeg + 180, halfSegmentM);
  const end = moveLocal(origin, profile.headingDeg, halfSegmentM);
  const legLengthM = halfSegmentM * 2;
  const roundTripM = legLengthM * 2;
  const distanceOnRouteM = positiveModulo(profile.speedMps * elapsedSeconds, roundTripM);
  const forward = distanceOnRouteM <= legLengthM;
  const ratio = forward ? distanceOnRouteM / legLengthM : (distanceOnRouteM - legLengthM) / legLengthM;
  const point = forward ? interpolatePoint(start, end, ratio) : interpolatePoint(end, start, ratio);
  const geo = fromLocalPoint(area, point);

  return {
    ...geo,
    headingDeg: normalizeHeading(forward ? profile.headingDeg : profile.headingDeg + 180)
  };
}

function loiterPosition(scenario: Scenario, profile: TrackProfile, elapsedSeconds: number): Pick<TrackPosition, "lat" | "lon" | "headingDeg"> {
  const area = projectArea(scenario);
  const center = toLocalPoint(area, profile.originLat, profile.originLon);
  const angleDeg = normalizeHeading(profile.headingDeg + elapsedSeconds * profile.loiterAngularDegPerSecond);
  const angle = toRadians(angleDeg);
  const point = {
    xM: center.xM + profile.loiterRadiusM * Math.sin(angle),
    yM: center.yM + profile.loiterRadiusM * Math.cos(angle)
  };
  const geo = fromLocalPoint(area, point);

  return {
    ...geo,
    headingDeg: normalizeHeading(angleDeg + (profile.loiterDirection >= 0 ? 90 : -90))
  };
}

function surveyPosition(scenario: Scenario, profile: TrackProfile, elapsedSeconds: number): Pick<TrackPosition, "lat" | "lon" | "headingDeg"> {
  const area = projectArea(scenario);
  const center = toLocalPoint(area, profile.originLat, profile.originLon);
  const halfWidthM = Math.min(profile.surveyWidthM / 2, area.widthM / 2);
  const halfHeightM = Math.min(profile.surveyHeightM / 2, area.heightM / 2);
  const minX = clamp(center.xM - halfWidthM, 0, Math.max(0, area.widthM - halfWidthM * 2));
  const minY = clamp(center.yM - halfHeightM, 0, Math.max(0, area.heightM - halfHeightM * 2));
  const maxX = Math.min(area.widthM, minX + halfWidthM * 2);
  const maxY = Math.min(area.heightM, minY + halfHeightM * 2);
  const route = buildSurveyRoute(minX, minY, maxX, maxY, profile.surveyRows);
  const position = pointAlongPolyline(route, profile.speedMps * elapsedSeconds);
  const geo = fromLocalPoint(area, position.point);

  return {
    ...geo,
    headingDeg: position.headingDeg
  };
}

function moveMeters(lat: number, lon: number, headingDeg: number, distanceM: number): { lat: number; lon: number } {
  const heading = toRadians(headingDeg);
  const northM = Math.cos(heading) * distanceM;
  const eastM = Math.sin(heading) * distanceM;
  return {
    lat: Number((lat + metersToLat(northM)).toFixed(6)),
    lon: Number((lon + metersToLon(eastM, lat)).toFixed(6))
  };
}

function projectArea(scenario: Scenario): AreaProjection {
  const [minLon, minLat, maxLon, maxLat] = scenario.area.bbox;
  const refLat = (minLat + maxLat) / 2;
  return {
    minLon,
    minLat,
    maxLon,
    maxLat,
    refLat,
    widthM: Math.max(1, lonToMeters(maxLon - minLon, refLat)),
    heightM: Math.max(1, latToMeters(maxLat - minLat))
  };
}

function toLocalPoint(area: AreaProjection, lat: number, lon: number): LocalPoint {
  return {
    xM: lonToMeters(lon - area.minLon, area.refLat),
    yM: latToMeters(lat - area.minLat)
  };
}

function fromLocalPoint(area: AreaProjection, point: LocalPoint): { lat: number; lon: number } {
  return {
    lat: Number((area.minLat + metersToLat(point.yM)).toFixed(6)),
    lon: Number((area.minLon + metersToLon(point.xM, area.refLat)).toFixed(6))
  };
}

function randomPointWithinMargins(area: AreaProjection, rng: SeededRandom, marginX: number, marginY: number): LocalPoint {
  const safeMarginX = Math.min(Math.max(0, marginX), area.widthM / 2);
  const safeMarginY = Math.min(Math.max(0, marginY), area.heightM / 2);
  const minX = safeMarginX;
  const maxX = Math.max(minX, area.widthM - safeMarginX);
  const minY = safeMarginY;
  const maxY = Math.max(minY, area.heightM - safeMarginY);

  return {
    xM: maxX === minX ? area.widthM / 2 : rng.range(minX, maxX),
    yM: maxY === minY ? area.heightM / 2 : rng.range(minY, maxY)
  };
}

function moveLocal(point: LocalPoint, headingDeg: number, distanceM: number): LocalPoint {
  const heading = toRadians(headingDeg);
  return {
    xM: point.xM + Math.sin(heading) * distanceM,
    yM: point.yM + Math.cos(heading) * distanceM
  };
}

function reflectPointWithinArea(area: AreaProjection, point: LocalPoint, headingDeg: number): { point: LocalPoint; headingDeg: number } {
  const reflectedX = reflectCoordinate(point.xM, 0, area.widthM);
  const reflectedY = reflectCoordinate(point.yM, 0, area.heightM);
  const heading = toRadians(headingDeg);
  const eastComponent = Math.sin(heading) * (reflectedX.reversed ? -1 : 1);
  const northComponent = Math.cos(heading) * (reflectedY.reversed ? -1 : 1);

  return {
    point: {
      xM: reflectedX.value,
      yM: reflectedY.value
    },
    headingDeg: normalizeHeading(toDegrees(Math.atan2(eastComponent, northComponent)))
  };
}

function reflectCoordinate(value: number, min: number, max: number): { value: number; reversed: boolean } {
  const width = max - min;
  if (width <= 0) {
    return { value: min, reversed: false };
  }
  const offset = positiveModulo(value - min, width * 2);
  if (offset <= width) {
    return { value: min + offset, reversed: false };
  }
  return { value: max - (offset - width), reversed: true };
}

function distanceToAreaEdge(area: AreaProjection, point: LocalPoint, headingDeg: number): number {
  const heading = toRadians(headingDeg);
  const dx = Math.sin(heading);
  const dy = Math.cos(heading);
  const distances: number[] = [];

  if (dx > 0) {
    distances.push((area.widthM - point.xM) / dx);
  } else if (dx < 0) {
    distances.push((0 - point.xM) / dx);
  }

  if (dy > 0) {
    distances.push((area.heightM - point.yM) / dy);
  } else if (dy < 0) {
    distances.push((0 - point.yM) / dy);
  }

  const positiveDistances = distances.filter((distance) => Number.isFinite(distance) && distance > 0);
  return positiveDistances.length ? Math.min(...positiveDistances) : Number.POSITIVE_INFINITY;
}

function buildSurveyRoute(minX: number, minY: number, maxX: number, maxY: number, rows: number): LocalPoint[] {
  const route: LocalPoint[] = [];
  const rowCount = Math.max(2, rows);
  for (let row = 0; row < rowCount; row += 1) {
    const yM = interpolate(minY, maxY, row / (rowCount - 1));
    if (row % 2 === 0) {
      route.push({ xM: minX, yM }, { xM: maxX, yM });
    } else {
      route.push({ xM: maxX, yM }, { xM: minX, yM });
    }
  }
  return route;
}

function pointAlongPolyline(route: LocalPoint[], distanceM: number): { point: LocalPoint; headingDeg: number } {
  if (route.length < 2 || distanceM <= 0) {
    return { point: route[0] ?? { xM: 0, yM: 0 }, headingDeg: 90 };
  }

  const segments: Array<{ start: LocalPoint; end: LocalPoint; lengthM: number }> = [];
  let totalLengthM = 0;
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index]!;
    const end = route[index + 1]!;
    const lengthM = distanceBetweenPoints(start, end);
    if (lengthM > 0) {
      segments.push({ start, end, lengthM });
      totalLengthM += lengthM;
    }
  }

  if (totalLengthM <= 0) {
    return { point: route[0]!, headingDeg: 90 };
  }

  let remainingM = positiveModulo(distanceM, totalLengthM);
  for (const segment of segments) {
    if (remainingM <= segment.lengthM) {
      const ratio = remainingM / segment.lengthM;
      return {
        point: interpolatePoint(segment.start, segment.end, ratio),
        headingDeg: headingBetweenPoints(segment.start, segment.end)
      };
    }
    remainingM -= segment.lengthM;
  }

  const finalSegment = segments[segments.length - 1]!;
  return {
    point: finalSegment.end,
    headingDeg: headingBetweenPoints(finalSegment.start, finalSegment.end)
  };
}

function interpolatePoint(start: LocalPoint, end: LocalPoint, ratio: number): LocalPoint {
  return {
    xM: interpolate(start.xM, end.xM, ratio),
    yM: interpolate(start.yM, end.yM, ratio)
  };
}

function distanceBetweenPoints(start: LocalPoint, end: LocalPoint): number {
  return Math.hypot(end.xM - start.xM, end.yM - start.yM);
}

function headingBetweenPoints(start: LocalPoint, end: LocalPoint): number {
  return normalizeHeading(toDegrees(Math.atan2(end.xM - start.xM, end.yM - start.yM)));
}

function latToMeters(degrees: number): number {
  return degrees * 111_320;
}

function lonToMeters(degrees: number, lat: number): number {
  return degrees * 111_320 * Math.max(0.2, Math.cos(toRadians(lat)));
}

function positiveModulo(value: number, divisor: number): number {
  if (divisor <= 0) {
    return 0;
  }
  return ((value % divisor) + divisor) % divisor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

function eventTypeFor(
  objectType: CanonicalEventEnvelope["payload"]["objectType"],
  tick: number,
  status: TrackPosition["status"]
): CanonicalEventEnvelope["eventType"] {
  if (objectType === "REPORT") {
    return "report.created";
  }
  if (objectType === "INCIDENT") {
    return tick === 0 ? "incident.created" : "incident.updated";
  }
  if (status === "LOST") {
    return "track.lost";
  }
  return tick === 0 ? "track.created" : "track.updated";
}

function defaultPatternFor(blockId: string): string {
  if (blockId === "air-sim-uav") {
    return "LOITER";
  }
  if (blockId === "air-sim-missile") {
    return "SHORT_LIVED_TRACK";
  }
  return "DIRECT";
}

function speedFor(blockId: string, rng: SeededRandom): number {
  const profile = speedProfilesByBlock[blockId] ?? speedProfilesByBlock["air-sim-aircraft"]!;
  return rng.range(profile.minMps, profile.maxMps);
}

function cappedObjectCount(block: ScenarioBlock): number {
  return Math.min(MAX_OBJECTS_PER_BLOCK, Math.max(0, Math.trunc(block.objectCount)));
}

function metersToLat(meters: number): number {
  return meters / 111_320;
}

function metersToLon(meters: number, lat: number): number {
  return meters / (111_320 * Math.max(0.2, Math.cos(toRadians(lat))));
}

function interpolate(start: number, end: number, ratio: number): number {
  return start + (end - start) * ratio;
}

function normalizeHeading(headingDeg: number): number {
  return ((headingDeg % 360) + 360) % 360;
}

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function objectIdPrefixForBlock(block: ScenarioBlock): string {
  const configured = stringParameter(block, "objectIdPrefix");
  const fallback = block.blockId.toUpperCase().replaceAll("-", "_");
  return sanitizeObjectIdPrefix(configured ?? fallback);
}

function sanitizeObjectIdPrefix(value: string): string {
  const sanitized = value
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || "SIM_OBJECT";
}

function buildCustomRoute(
  block: ScenarioBlock,
  index: number,
  objectType: CanonicalEventEnvelope["payload"]["objectType"],
  scenarioDurationSeconds: number
): CustomRouteProfile | undefined {
  if (stringParameter(block, "routeModel") !== "UKRAINE_AIR_DEFENSE_DEMO") {
    return undefined;
  }

  const role = stringParameter(block, "engagementRole");
  if (role !== "HOSTILE_INBOUND" && role !== "FRIEND_INTERCEPTOR") {
    return undefined;
  }

  const family = stringParameter(block, "engagementFamily") === "missile" || objectType === "MISSILE_TRACK" ? "missile" : "uav";
  const pairIndex = role === "FRIEND_INTERCEPTOR" ? friendlyIndexToHostileIndex(index) : index;
  const route = UKRAINE_AIR_DEFENSE_ROUTES[pairIndex % UKRAINE_AIR_DEFENSE_ROUTES.length]!;
  const destroyed = role === "FRIEND_INTERCEPTOR" || isDestroyedHostileIndex(pairIndex);
  const terminalAtSeconds = terminalAtSecondsForUkraineDemo(family, pairIndex, scenarioDurationSeconds);
  const start =
    role === "HOSTILE_INBOUND"
      ? route.hostileStart
      : family === "missile"
        ? route.friendlyMissileStart
        : route.friendlyUavStart;
  const terminal = destroyed ? route.intercept : route.transitEnd;
  const friendlyIndex = hostileIndexToFriendlyIndex(pairIndex);
  const pairedObjectId =
    role === "HOSTILE_INBOUND"
      ? destroyed && friendlyIndex !== undefined
        ? `${sanitizeObjectIdPrefix(stringParameter(block, "pairedObjectIdPrefix") ?? (family === "missile" ? "BLUE_INTERCEPTOR_MSL" : "BLUE_INTERCEPTOR_UAV"))}-${String(friendlyIndex + 1).padStart(4, "0")}`
        : undefined
      : `${sanitizeObjectIdPrefix(stringParameter(block, "pairedObjectIdPrefix") ?? (family === "missile" ? "HOSTILE_MSL" : "HOSTILE_UAV"))}-${String(pairIndex + 1).padStart(4, "0")}`;

  return {
    role,
    family,
    startLat: start.lat,
    startLon: start.lon,
    terminalLat: terminal.lat,
    terminalLon: terminal.lon,
    headingDeg: headingBetweenGeo(start.lat, start.lon, terminal.lat, terminal.lon),
    terminalAtSeconds,
    terminalMode: destroyed ? "INTERCEPT" : "TRANSIT",
    engagementId: `UKR-DEMO-${family.toUpperCase()}-${String(pairIndex + 1).padStart(4, "0")}`,
    pairedObjectId,
    routeLabel: route.label,
    sourceReferenceDate: UKRAINE_AIR_DEFENSE_SOURCE_DATE,
    destroyed,
    interceptedRatio: UKRAINE_AIR_DEFENSE_INTERCEPTED_RATIO
  };
}

function stringParameter(block: ScenarioBlock, key: string): string | undefined {
  const value = block.parameters?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isDestroyedHostileIndex(index: number): boolean {
  return index % 10 !== 9;
}

function friendlyIndexToHostileIndex(index: number): number {
  return Math.floor(index / 9) * 10 + (index % 9);
}

function hostileIndexToFriendlyIndex(index: number): number | undefined {
  if (!isDestroyedHostileIndex(index)) {
    return undefined;
  }
  return Math.floor(index / 10) * 9 + (index % 10);
}

function terminalAtSecondsForUkraineDemo(family: "uav" | "missile", pairIndex: number, scenarioDurationSeconds: number): number {
  const routeIndex = pairIndex % UKRAINE_AIR_DEFENSE_ROUTES.length;
  const waveIndex = Math.floor(pairIndex / UKRAINE_AIR_DEFENSE_ROUTES.length);
  const terminalAt =
    family === "missile"
      ? 100 + routeIndex * 12 + waveIndex * 50
      : 1220 + routeIndex * 65 + waveIndex * 220;
  return Math.min(Math.max(30, scenarioDurationSeconds - 30), terminalAt);
}

function interpolateGeo(startLat: number, startLon: number, endLat: number, endLon: number, ratio: number): { lat: number; lon: number } {
  return {
    lat: Number(interpolate(startLat, endLat, ratio).toFixed(6)),
    lon: Number(interpolate(startLon, endLon, ratio).toFixed(6))
  };
}

function distanceBetweenGeo(startLat: number, startLon: number, endLat: number, endLon: number): number {
  const refLat = (startLat + endLat) / 2;
  return Math.hypot(latToMeters(endLat - startLat), lonToMeters(endLon - startLon, refLat));
}

function headingBetweenGeo(startLat: number, startLon: number, endLat: number, endLon: number): number {
  const refLat = (startLat + endLat) / 2;
  return normalizeHeading(toDegrees(Math.atan2(lonToMeters(endLon - startLon, refLat), latToMeters(endLat - startLat))));
}

function hashString(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

const UKRAINE_AIR_DEFENSE_SOURCE_DATE = "2026-05-13";
const UKRAINE_AIR_DEFENSE_INTERCEPTED_RATIO = 0.9;

const UKRAINE_AIR_DEFENSE_ROUTES: Array<{
  label: string;
  hostileStart: { lat: number; lon: number };
  friendlyUavStart: { lat: number; lon: number };
  friendlyMissileStart: { lat: number; lon: number };
  intercept: { lat: number; lon: number };
  transitEnd: { lat: number; lon: number };
}> = [
  {
    label: "Kyiv north approach",
    hostileStart: { lat: 51.25, lon: 30.15 },
    friendlyUavStart: { lat: 50.42, lon: 30.85 },
    friendlyMissileStart: { lat: 50.12, lon: 31.25 },
    intercept: { lat: 50.68, lon: 30.56 },
    transitEnd: { lat: 50.42, lon: 30.52 }
  },
  {
    label: "Kyiv south-west crossing",
    hostileStart: { lat: 49.15, lon: 31.6 },
    friendlyUavStart: { lat: 49.72, lon: 30.96 },
    friendlyMissileStart: { lat: 49.95, lon: 29.75 },
    intercept: { lat: 49.43, lon: 30.65 },
    transitEnd: { lat: 50.05, lon: 30.37 }
  },
  {
    label: "Dnipro east approach",
    hostileStart: { lat: 48.8, lon: 36.45 },
    friendlyUavStart: { lat: 48.42, lon: 35.52 },
    friendlyMissileStart: { lat: 47.75, lon: 34.4 },
    intercept: { lat: 48.47, lon: 35.17 },
    transitEnd: { lat: 48.46, lon: 35.04 }
  },
  {
    label: "Odesa coastal approach",
    hostileStart: { lat: 45.86, lon: 30.9 },
    friendlyUavStart: { lat: 46.28, lon: 30.48 },
    friendlyMissileStart: { lat: 46.95, lon: 29.75 },
    intercept: { lat: 46.45, lon: 30.73 },
    transitEnd: { lat: 46.49, lon: 30.72 }
  },
  {
    label: "Lviv west corridor",
    hostileStart: { lat: 49.42, lon: 25.18 },
    friendlyUavStart: { lat: 49.62, lon: 24.42 },
    friendlyMissileStart: { lat: 50.25, lon: 23.2 },
    intercept: { lat: 49.82, lon: 24.21 },
    transitEnd: { lat: 49.84, lon: 24.03 }
  },
  {
    label: "Kharkiv east approach",
    hostileStart: { lat: 50.15, lon: 37.1 },
    friendlyUavStart: { lat: 49.82, lon: 36.52 },
    friendlyMissileStart: { lat: 49.35, lon: 35.55 },
    intercept: { lat: 49.98, lon: 36.25 },
    transitEnd: { lat: 49.99, lon: 36.23 }
  },
  {
    label: "Zaporizhzhia south-east approach",
    hostileStart: { lat: 46.95, lon: 36.0 },
    friendlyUavStart: { lat: 47.52, lon: 35.42 },
    friendlyMissileStart: { lat: 47.15, lon: 34.1 },
    intercept: { lat: 47.8, lon: 35.2 },
    transitEnd: { lat: 47.84, lon: 35.14 }
  },
  {
    label: "Vinnytsia central crossing",
    hostileStart: { lat: 48.5, lon: 29.7 },
    friendlyUavStart: { lat: 48.92, lon: 28.86 },
    friendlyMissileStart: { lat: 49.75, lon: 27.65 },
    intercept: { lat: 49.2, lon: 28.46 },
    transitEnd: { lat: 49.23, lon: 28.47 }
  },
  {
    label: "Poltava north-east approach",
    hostileStart: { lat: 50.15, lon: 35.4 },
    friendlyUavStart: { lat: 49.72, lon: 34.86 },
    friendlyMissileStart: { lat: 49.05, lon: 33.6 },
    intercept: { lat: 49.62, lon: 34.55 },
    transitEnd: { lat: 49.59, lon: 34.55 }
  },
  {
    label: "Mykolaiv southern approach",
    hostileStart: { lat: 46.55, lon: 33.0 },
    friendlyUavStart: { lat: 46.85, lon: 32.1 },
    friendlyMissileStart: { lat: 46.25, lon: 31.25 },
    intercept: { lat: 46.98, lon: 31.99 },
    transitEnd: { lat: 46.97, lon: 32.0 }
  }
];

export const availableBlocks: ScenarioBlock[] = [
  { blockId: "air-sim-aircraft", enabled: true, objectCount: 20, updateRateHz: 1, patterns: ["DIRECT", "PATROL"] },
  { blockId: "air-sim-uav", enabled: true, objectCount: 50, updateRateHz: 1, patterns: ["LOITER", "SURVEY"] },
  { blockId: "air-sim-missile", enabled: false, objectCount: 5, updateRateHz: 1, patterns: ["SHORT_LIVED_TRACK"] },
  { blockId: "ground-sim-friendly", enabled: false, objectCount: 10, updateRateHz: 0.5, patterns: ["DIRECT"] },
  { blockId: "rescue-sim", enabled: false, objectCount: 3, updateRateHz: 0.2, patterns: ["STATIC_REPORT"] },
  { blockId: "report-sim", enabled: false, objectCount: 5, updateRateHz: 0.1, patterns: ["STATIC_REPORT"] }
];
