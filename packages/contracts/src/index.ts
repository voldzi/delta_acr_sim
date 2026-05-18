export const CONTRACT_VERSION = "cop-ingest-v1";
export const DEFAULT_SOURCE_SYSTEM_ID = "sim-air-situation-001";
export const DEFAULT_ADAPTER_ID = "simulation-adapter";

export const SIMULATION_BLOCK_IDS = [
  "air-sim-aircraft",
  "air-sim-uav",
  "air-sim-missile",
  "ground-sim-friendly",
  "rescue-sim",
  "report-sim"
] as const;

export type SimulationBlockId = (typeof SIMULATION_BLOCK_IDS)[number];

export type ScenarioStatus = "DRAFT" | "READY" | "RUNNING" | "PAUSED" | "STOPPED" | "ERROR";
export type PublisherMode = "DRY_RUN" | "MOCK" | "LIVE";
export type RuntimeState = ScenarioStatus;

export interface ScenarioArea {
  type: "BBOX";
  bbox: [number, number, number, number];
}

export interface ScenarioBlock {
  blockId: SimulationBlockId;
  enabled: boolean;
  objectCount: number;
  updateRateHz: number;
  patterns?: string[];
  parameters?: Record<string, unknown>;
}

export interface FaultInjection {
  faultId?: string;
  type:
    | "DELAY"
    | "DUPLICATE"
    | "SOURCE_OUTAGE"
    | "CONFLICT"
    | "DEGRADED_ACCURACY"
    | "RECONNECT_BURST"
    | "BATCH_REPLAY";
  targetBlockId: string;
  startAtSecond: number;
  durationSeconds: number;
  parameters?: Record<string, unknown>;
}

export interface Scenario {
  scenarioId?: string;
  name: string;
  description?: string;
  status?: ScenarioStatus;
  area: ScenarioArea;
  durationSeconds: number;
  seed: number;
  blocks: ScenarioBlock[];
  faults?: FaultInjection[];
  metadata?: Record<string, unknown>;
}

export type EventType =
  | "track.created"
  | "track.updated"
  | "track.lost"
  | "track.restored"
  | "track.deleted"
  | "incident.created"
  | "incident.updated"
  | "report.created"
  | "source.status.changed";

export interface CanonicalEventEnvelope {
  eventId: string;
  eventType: EventType;
  contractVersion: typeof CONTRACT_VERSION;
  correlationId: string;
  source: {
    sourceSystemId: string;
    sourceDeviceId?: string;
    adapterId: string;
    adapterVersion: string;
  };
  producerTimestamp: string;
  sequence?: {
    streamId: string;
    number: number;
  };
  classification: {
    level: "UNCLASSIFIED" | "RESTRICTED" | "CONFIDENTIAL";
    releasability?: string[];
    handlingCaveats: string[];
  };
  geo?: {
    lat?: number;
    lon?: number;
    altitudeM?: number;
    accuracyM?: number;
  };
  payload: {
    objectId: string;
    objectType:
      | "AIRCRAFT"
      | "UAV"
      | "MISSILE_TRACK"
      | "GROUND_UNIT"
      | "RESCUE_ASSET"
      | "INCIDENT"
      | "REPORT"
      | "UNKNOWN";
    affiliation?: "FRIEND" | "ASSUMED_FRIEND" | "NEUTRAL" | "UNKNOWN" | "SUSPECT" | "HOSTILE" | "PENDING";
    domain?: "AIR" | "LAND" | "SEA" | "RESCUE" | "OTHER";
    status: "ACTIVE" | "INACTIVE" | "LOST" | "STALE" | "CONFLICTED";
    speedMps?: number;
    headingDeg?: number;
    verticalRateMps?: number;
    attributes?: Record<string, unknown>;
  };
  quality: {
    confidence?: number;
    sourceReliability?: string;
    informationCredibility?: string;
  };
  simulation: {
    synthetic: true;
    scenarioId: string;
    blockId: string;
    seed: number;
  };
  signature?: {
    signed?: boolean;
    keyId?: string | null;
    algorithm?: string | null;
  };
}

export interface RuntimeStatus {
  scenarioId?: string;
  runtimeId?: string;
  state: RuntimeState;
  startedAt?: string;
  generatedEvents: number;
  publishedEvents: number;
  queuedEvents: number;
  tick?: number;
  elapsedSeconds?: number;
  speedMultiplier?: number;
  tickIntervalSeconds?: number;
  activeObjects?: number;
  lastTickAt?: string;
  completedAt?: string;
}

export interface AiScenarioDraft {
  draftId: string;
  title: string;
  purpose: "LATENCY_TEST" | "LOAD_TEST" | "CONFLICT_TEST" | "DEGRADED_CONNECTIVITY" | "DEMO" | "DOCUMENTATION";
  safetyScope: "SYNTHETIC_COP_TEST_ONLY";
  provider: "openai" | "codex" | "local" | "mock";
  scenarioPatch: Partial<Scenario>;
  expectedObservations: string[];
  policyCheck: {
    allowed: boolean;
    reasons: string[];
  };
  prohibitedContentCheck: {
    targeting: false;
    weaponGuidance: false;
    realOperationalAdvice: false;
    useOfForceRecommendation?: false;
    attackOptimization?: false;
  };
  validation?: {
    schemaValid: boolean;
    issues: unknown[];
  };
  explanation?: string;
  audit?: Record<string, unknown>;
}
