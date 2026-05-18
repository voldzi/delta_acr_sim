export interface Scenario {
  scenarioId?: string;
  name: string;
  description?: string;
  status?: "DRAFT" | "READY" | "RUNNING" | "PAUSED" | "STOPPED" | "ERROR";
  area: { type: "BBOX"; bbox: [number, number, number, number] };
  durationSeconds: number;
  seed: number;
  blocks: ScenarioBlock[];
  faults?: FaultInjection[];
}

export interface ScenarioBlock {
  blockId: string;
  enabled: boolean;
  objectCount: number;
  updateRateHz: number;
  patterns?: string[];
  parameters?: Record<string, unknown>;
}

export interface FaultInjection {
  faultId?: string;
  type: string;
  targetBlockId: string;
  startAtSecond: number;
  durationSeconds: number;
  parameters?: Record<string, unknown>;
}

export interface RuntimeStatus {
  scenarioId?: string;
  runtimeId?: string;
  state: string;
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

export interface PublisherStatus {
  mode: "DRY_RUN" | "MOCK" | "LIVE";
  queueSize: number;
  deadLetterSize: number;
  publishingEnabled: boolean;
  lastSuccessAt?: string;
  lastFailureAt?: string;
}

export interface QueueItem {
  queueId: string;
  eventId: string;
  state: string;
  attempts: number;
  updatedAt: string;
  event: {
    eventType: string;
    classification: { handlingCaveats: string[] };
    payload: { objectId: string; objectType: string; status: string };
    simulation: { synthetic: boolean; blockId: string };
  };
}

export interface AiDraft {
  draftId: string;
  title: string;
  purpose: string;
  provider: string;
  policyCheck: { allowed: boolean; reasons: string[] };
  validation?: { schemaValid: boolean; issues: unknown[] };
  explanation?: string;
  scenarioPatch?: Partial<Scenario>;
}
