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
  const objectId = `${block.blockId.toUpperCase().replaceAll("-", "_")}-${String(index + 1).padStart(4, "0")}`;
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
        motionModel: profile.pattern === "SHORT_LIVED_TRACK" ? "STRAIGHT_TRANSIT" : "CONTINUOUS_KINEMATIC",
        sampleIntervalSeconds: tickIntervalSeconds,
        trackAgeSeconds: Math.round(elapsedSeconds * speedMultiplier),
        tick,
        simplifiedTrack: objectType === "MISSILE_TRACK",
        note: "Synthetic COP test data only"
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

  return {
    blockId: block.blockId,
    pattern,
    domain,
    objectType,
    affiliation: affiliationForBlock(block, index, objectType),
    originLat: originGeo.lat,
    originLon: originGeo.lon,
    headingDeg,
    speedMps,
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
    ttlSeconds: objectType === "MISSILE_TRACK" ? Math.round(rng.range(45, 120)) : scenario.durationSeconds
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

function hashString(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash;
}

export const availableBlocks: ScenarioBlock[] = [
  { blockId: "air-sim-aircraft", enabled: true, objectCount: 20, updateRateHz: 1, patterns: ["DIRECT", "PATROL"] },
  { blockId: "air-sim-uav", enabled: true, objectCount: 50, updateRateHz: 1, patterns: ["LOITER", "SURVEY"] },
  { blockId: "air-sim-missile", enabled: false, objectCount: 5, updateRateHz: 1, patterns: ["SHORT_LIVED_TRACK"] },
  { blockId: "ground-sim-friendly", enabled: false, objectCount: 10, updateRateHz: 0.5, patterns: ["DIRECT"] },
  { blockId: "rescue-sim", enabled: false, objectCount: 3, updateRateHz: 0.2, patterns: ["STATIC_REPORT"] },
  { blockId: "report-sim", enabled: false, objectCount: 5, updateRateHz: 0.1, patterns: ["STATIC_REPORT"] }
];
