import {
  CONTRACT_VERSION,
  DEFAULT_ADAPTER_ID,
  type CanonicalEventEnvelope,
  type Scenario,
  type ScenarioBlock
} from "@delta-acr/contracts";
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
    const count = Math.min(block.objectCount, 25);
    for (let index = 0; index < count; index += 1) {
      const event = buildEventForBlock(scenario, scenarioId, block, index, tick, elapsedSeconds, speedMultiplier, tickIntervalSeconds, timestamp, options);
      if (event) {
        events.push(event);
      }
    }
  }

  return events;
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
      affiliation: block.blockId === "ground-sim-friendly" ? "FRIEND" : "UNKNOWN",
      domain,
      status: movement.status,
      speedMps: movement.status === "LOST" ? 0 : Number(profile.speedMps.toFixed(1)),
      headingDeg: Number(movement.headingDeg.toFixed(1)),
      verticalRateMps: movement.verticalRateMps,
      attributes: {
        syntheticPattern: profile.pattern,
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
  const [minLon, minLat, maxLon, maxLat] = scenario.area.bbox;
  const pattern = block.patterns?.[index % Math.max(1, block.patterns.length)] ?? defaultPatternFor(block.blockId);
  const originLat = Number(rng.range(minLat, maxLat).toFixed(6));
  const originLon = Number(rng.range(minLon, maxLon).toFixed(6));
  const speedMps = speedFor(block.blockId, rng);

  return {
    blockId: block.blockId,
    pattern,
    domain,
    objectType,
    originLat,
    originLon,
    headingDeg: rng.range(0, 359),
    speedMps,
    altitudeM: domain === "AIR" ? Math.round(rng.range(900, objectType === "MISSILE_TRACK" ? 4500 : 9500)) : 0,
    verticalRateMps: domain === "AIR" ? Number(rng.range(-3, 3).toFixed(1)) : 0,
    accuracyM: Math.round(rng.range(15, 140)),
    confidence: Number(rng.range(0.79, 0.98).toFixed(2)),
    loiterRadiusM: rng.range(1000, 5500),
    loiterAngularDegPerSecond: rng.range(1.5, 4.5),
    ttlSeconds: objectType === "MISSILE_TRACK" ? Math.round(rng.range(45, 120)) : scenario.durationSeconds
  };
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
      ? loiterPosition(profile, motionSeconds)
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
  const moved = moveMeters(profile.originLat, profile.originLon, profile.headingDeg, distanceM);
  return {
    ...wrapToBbox(scenario, moved.lat, moved.lon),
    headingDeg: profile.headingDeg
  };
}

function patrolPosition(scenario: Scenario, profile: TrackProfile, elapsedSeconds: number): Pick<TrackPosition, "lat" | "lon" | "headingDeg"> {
  const segmentMeters = Math.max(10_000, profile.speedMps * 160);
  const start = moveMeters(profile.originLat, profile.originLon, profile.headingDeg + 180, segmentMeters / 2);
  const end = moveMeters(profile.originLat, profile.originLon, profile.headingDeg, segmentMeters / 2);
  const cycleSeconds = Math.max(60, (segmentMeters * 2) / profile.speedMps);
  const cyclePosition = (elapsedSeconds % cycleSeconds) / cycleSeconds;
  const forward = cyclePosition <= 0.5;
  const ratio = forward ? cyclePosition * 2 : (1 - cyclePosition) * 2;

  return {
    ...wrapToBbox(scenario, interpolate(start.lat, end.lat, ratio), interpolate(start.lon, end.lon, ratio)),
    headingDeg: normalizeHeading(forward ? profile.headingDeg : profile.headingDeg + 180)
  };
}

function loiterPosition(profile: TrackProfile, elapsedSeconds: number): Pick<TrackPosition, "lat" | "lon" | "headingDeg"> {
  const angleDeg = normalizeHeading(profile.headingDeg + elapsedSeconds * profile.loiterAngularDegPerSecond);
  const latOffset = metersToLat(profile.loiterRadiusM * Math.sin(toRadians(angleDeg)));
  const lonOffset = metersToLon(profile.loiterRadiusM * Math.cos(toRadians(angleDeg)), profile.originLat);

  return {
    lat: Number((profile.originLat + latOffset).toFixed(6)),
    lon: Number((profile.originLon + lonOffset).toFixed(6)),
    headingDeg: normalizeHeading(angleDeg + 90)
  };
}

function surveyPosition(scenario: Scenario, profile: TrackProfile, elapsedSeconds: number): Pick<TrackPosition, "lat" | "lon" | "headingDeg"> {
  const [minLon, minLat, maxLon, maxLat] = scenario.area.bbox;
  const rowCount = 6;
  const cycleSeconds = 180;
  const rowPhase = ((elapsedSeconds % cycleSeconds) / cycleSeconds) * rowCount;
  const rowIndex = Math.min(rowCount - 1, Math.floor(rowPhase));
  const rowProgress = rowPhase - rowIndex;
  const x = rowIndex % 2 === 0 ? rowProgress : 1 - rowProgress;
  const y = (rowIndex + 0.5) / rowCount;

  return {
    lat: Number(interpolate(minLat, maxLat, y).toFixed(6)),
    lon: Number(interpolate(minLon, maxLon, x).toFixed(6)),
    headingDeg: rowIndex % 2 === 0 ? 90 : 270
  };
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
  if (blockId === "air-sim-uav") {
    return rng.range(28, 72);
  }
  if (blockId === "air-sim-missile") {
    return rng.range(260, 430);
  }
  if (blockId === "ground-sim-friendly") {
    return rng.range(2, 12);
  }
  if (blockId === "rescue-sim" || blockId === "report-sim") {
    return 0;
  }
  return rng.range(120, 245);
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

function wrapToBbox(scenario: Scenario, lat: number, lon: number): { lat: number; lon: number } {
  const [minLon, minLat, maxLon, maxLat] = scenario.area.bbox;
  return {
    lat: Number(wrapValue(lat, minLat, maxLat).toFixed(6)),
    lon: Number(wrapValue(lon, minLon, maxLon).toFixed(6))
  };
}

function metersToLat(meters: number): number {
  return meters / 111_320;
}

function metersToLon(meters: number, lat: number): number {
  return meters / (111_320 * Math.max(0.2, Math.cos(toRadians(lat))));
}

function wrapValue(value: number, min: number, max: number): number {
  const width = max - min;
  if (width <= 0) {
    return min;
  }
  return ((((value - min) % width) + width) % width) + min;
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
