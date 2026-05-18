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
  const events: CanonicalEventEnvelope[] = [];

  for (const block of scenario.blocks.filter((item) => item.enabled)) {
    const count = Math.min(block.objectCount, 25);
    for (let index = 0; index < count; index += 1) {
      events.push(buildEventForBlock(scenario, scenarioId, block, index, tick, timestamp, options));
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
  timestamp: string,
  options: GenerateOptions
): CanonicalEventEnvelope {
  const rng = new SeededRandom(scenario.seed + tick * 1009 + index * 31 + block.blockId.length);
  const [minLon, minLat, maxLon, maxLat] = scenario.area.bbox;
  const lat = Number(rng.range(minLat, maxLat).toFixed(6));
  const lon = Number(rng.range(minLon, maxLon).toFixed(6));
  const objectType = objectTypesByBlock[block.blockId] ?? "UNKNOWN";
  const domain = domainsByBlock[block.blockId] ?? "OTHER";
  const objectId = `${block.blockId.toUpperCase().replaceAll("-", "_")}-${String(index + 1).padStart(4, "0")}`;

  return {
    eventId: randomUUID(),
    eventType: index === 0 && tick === 0 ? "track.created" : "track.updated",
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
      lat,
      lon,
      altitudeM: domain === "AIR" ? Math.round(rng.range(500, 9000)) : 0,
      accuracyM: Math.round(rng.range(15, 180))
    },
    payload: {
      objectId,
      objectType,
      affiliation: block.blockId === "ground-sim-friendly" ? "FRIEND" : "UNKNOWN",
      domain,
      status: "ACTIVE",
      speedMps: domain === "AIR" ? Number(rng.range(40, 260).toFixed(1)) : Number(rng.range(0, 20).toFixed(1)),
      headingDeg: Number(rng.range(0, 359).toFixed(1)),
      verticalRateMps: domain === "AIR" ? Number(rng.range(-8, 8).toFixed(1)) : 0,
      attributes: {
        syntheticPattern: block.patterns?.[0] ?? "DIRECT",
        simplifiedTrack: objectType === "MISSILE_TRACK",
        note: "Synthetic COP test data only"
      }
    },
    quality: {
      confidence: Number(rng.range(0.75, 0.99).toFixed(2)),
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

export const availableBlocks: ScenarioBlock[] = [
  { blockId: "air-sim-aircraft", enabled: true, objectCount: 20, updateRateHz: 1, patterns: ["DIRECT", "PATROL"] },
  { blockId: "air-sim-uav", enabled: true, objectCount: 50, updateRateHz: 1, patterns: ["LOITER", "SURVEY"] },
  { blockId: "air-sim-missile", enabled: false, objectCount: 5, updateRateHz: 1, patterns: ["SHORT_LIVED_TRACK"] },
  { blockId: "ground-sim-friendly", enabled: false, objectCount: 10, updateRateHz: 0.5, patterns: ["DIRECT"] },
  { blockId: "rescue-sim", enabled: false, objectCount: 3, updateRateHz: 0.2, patterns: ["STATIC_REPORT"] },
  { blockId: "report-sim", enabled: false, objectCount: 5, updateRateHz: 0.1, patterns: ["STATIC_REPORT"] }
];
