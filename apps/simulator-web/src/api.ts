import type {
  AiDraft,
  FlightDataConfig,
  FlightDataHealth,
  FlightDataSource,
  FlightDataTrackResponse,
  PublisherStatus,
  QueueItem,
  RuntimeStatus,
  Scenario,
  ScenarioBlock,
  SituationDataConfig,
  SituationDataFeatureResponse,
  SituationDataHealth,
  SituationDataLayer,
  SituationDataSource
} from "./types";

const API_TIMEOUT_MS = 5_000;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {})
      }
    }).catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`API request timed out after ${API_TIMEOUT_MS / 1000}s: ${path}`);
      }
      throw error;
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
      throw new Error(error.error?.message ?? response.statusText);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timeout);
  }
}

export const demoScenario: Scenario = {
  name: "Moving COP Tracks Demo",
  description: "Synthetic moving aircraft, UAV and missile-track events for COP display validation.",
  area: {
    type: "BBOX",
    bbox: [14.0, 49.8, 15.0, 50.3]
  },
  durationSeconds: 900,
  seed: 123456,
  blocks: [
    {
      blockId: "air-sim-aircraft",
      enabled: true,
      objectCount: 4,
      updateRateHz: 1,
      patterns: ["DIRECT", "PATROL"],
      parameters: { affiliations: ["FRIEND", "HOSTILE", "ASSUMED_FRIEND", "SUSPECT"] }
    },
    {
      blockId: "air-sim-uav",
      enabled: true,
      objectCount: 3,
      updateRateHz: 1,
      patterns: ["LOITER", "SURVEY"],
      parameters: { affiliations: ["HOSTILE", "SUSPECT", "FRIEND"] }
    },
    {
      blockId: "air-sim-missile",
      enabled: true,
      objectCount: 1,
      updateRateHz: 1,
      patterns: ["SHORT_LIVED_TRACK"],
      parameters: { affiliations: ["HOSTILE"] }
    }
  ],
  faults: []
};

export const denseDemoScenario: Scenario = {
  name: "High Density COP Tracks Demo",
  description: "Synthetic high-density moving air picture with hundreds of COP-compatible tracks.",
  area: {
    type: "BBOX",
    bbox: [13.85, 49.65, 15.35, 50.45]
  },
  durationSeconds: 1800,
  seed: 20260519,
  blocks: [
    {
      blockId: "air-sim-aircraft",
      enabled: true,
      objectCount: 120,
      updateRateHz: 0.5,
      patterns: ["DIRECT", "PATROL"],
      parameters: { affiliations: ["FRIEND", "HOSTILE", "ASSUMED_FRIEND", "SUSPECT"] }
    },
    {
      blockId: "air-sim-uav",
      enabled: true,
      objectCount: 160,
      updateRateHz: 0.5,
      patterns: ["LOITER", "SURVEY"],
      parameters: { affiliations: ["HOSTILE", "SUSPECT", "FRIEND", "UNKNOWN"] }
    },
    {
      blockId: "air-sim-missile",
      enabled: true,
      objectCount: 20,
      updateRateHz: 0.2,
      patterns: ["SHORT_LIVED_TRACK"],
      parameters: { affiliations: ["HOSTILE"] }
    }
  ],
  faults: []
};

export interface DashboardLoadResult {
  scenarios: Scenario[];
  runtime: RuntimeStatus;
  publisher: PublisherStatus;
  queue: QueueItem[];
  queueTotalCount: number;
  blocks: ScenarioBlock[];
  providers: Array<{ id: string; enabled: boolean; external: boolean; healthy: boolean }>;
  flightData: {
    health: FlightDataHealth;
    sources: FlightDataSource[];
    config: FlightDataConfig;
    tracks: FlightDataTrackResponse;
  };
  situationData: {
    health: SituationDataHealth;
    layers: SituationDataLayer[];
    sources: SituationDataSource[];
    config: SituationDataConfig;
    features: SituationDataFeatureResponse;
  };
  warnings: string[];
}

export async function loadDashboard(): Promise<DashboardLoadResult> {
  const results = await Promise.allSettled([
    api<{ items: Scenario[] }>("/api/v1/scenarios"),
    api<RuntimeStatus>("/api/v1/runtime/status"),
    api<PublisherStatus>("/api/v1/runtime/publisher"),
    api<{ items: QueueItem[]; totalCount?: number }>("/api/v1/publisher/queue?limit=20"),
    api<{ blocks: ScenarioBlock[] }>("/api/v1/runtime/blocks"),
    api<{ providers: Array<{ id: string; enabled: boolean; external: boolean; healthy: boolean }> }>("/api/v1/ai/providers"),
    api<FlightDataHealth>("/flight-data/health/ready"),
    api<{ items: FlightDataSource[] }>("/flight-data/api/v1/sources"),
    api<FlightDataConfig>("/flight-data/api/v1/config"),
    api<FlightDataTrackResponse>("/flight-data/api/v1/cop/tracks?limit=8"),
    api<SituationDataHealth>("/situation-data/health/ready"),
    api<{ items: SituationDataLayer[] }>("/situation-data/api/v1/layers"),
    api<{ items: SituationDataSource[] }>("/situation-data/api/v1/sources"),
    api<SituationDataConfig>("/situation-data/api/v1/config"),
    api<SituationDataFeatureResponse>("/situation-data/api/v1/cop/features?limit=12")
  ]);

  const warnings: string[] = [];
  const scenarios = unwrapDashboardResult(results[0], { items: [] }, "scenarios", warnings);
  const runtime = unwrapDashboardResult(results[1], {
    state: "UNAVAILABLE",
    generatedEvents: 0,
    publishedEvents: 0,
    queuedEvents: 0
  }, "runtime", warnings);
  const publisher = unwrapDashboardResult(results[2], {
    mode: "DRY_RUN",
    queueSize: 0,
    deadLetterSize: 0,
    publishingEnabled: false
  }, "publisher", warnings);
  const queue = unwrapDashboardResult(results[3], { items: [], totalCount: 0 }, "publisher queue", warnings);
  const blocks = unwrapDashboardResult(results[4], { blocks: [] }, "runtime blocks", warnings);
  const providers = unwrapDashboardResult(results[5], { providers: [] }, "AI providers", warnings);
  const flightHealth = unwrapDashboardResult(results[6], { status: "unavailable", enabledSources: [] }, "flight data health", warnings);
  const flightSources = unwrapDashboardResult(results[7], { items: [] }, "flight data sources", warnings);
  const flightConfig = unwrapDashboardResult(
    results[8],
    {
      enabledSources: [],
      defaultArea: { lat: 0, lon: 0, radiusNm: 0 },
      cacheTtlSeconds: 0,
      staleAfterSeconds: 0,
      requestTimeoutMs: 0,
      providers: []
    },
    "flight data config",
    warnings
  );
  const flightTracks = unwrapDashboardResult(
    results[9],
    {
      contractVersion: "cop-flight-source-v1",
      source: { sourceId: "flight-data-api", sourceType: "PUBLIC_FLIGHT_AGGREGATE", generatedAt: new Date(0).toISOString() },
      summary: { rawObservationCount: 0, deduplicatedTrackCount: 0, droppedWithoutPositionCount: 0, staleTrackCount: 0 },
      tracks: [],
      sources: [],
      warnings: []
    },
    "flight data tracks",
    warnings
  );
  const situationHealth = unwrapDashboardResult(results[10], { status: "unavailable", enabledSources: [] }, "situation data health", warnings);
  const situationLayers = unwrapDashboardResult(results[11], { items: [] }, "situation data layers", warnings);
  const situationSources = unwrapDashboardResult(results[12], { items: [] }, "situation data sources", warnings);
  const situationConfig = unwrapDashboardResult(
    results[13],
    {
      enabledSources: [],
      defaultBbox: { west: 0, south: 0, east: 0, north: 0 },
      cacheTtlSeconds: 0,
      staleAfterSeconds: 0,
      requestTimeoutMs: 0,
      providers: []
    },
    "situation data config",
    warnings
  );
  const situationFeatures = unwrapDashboardResult(
    results[14],
    {
      contractVersion: "cop-situation-source-v1",
      type: "FeatureCollection",
      generatedAt: new Date(0).toISOString(),
      source: {
        sourceId: "situation-data-api",
        sourceType: "PUBLIC_SITUATION_AGGREGATE",
        generatedAt: new Date(0).toISOString()
      },
      query: {
        bbox: { west: 0, south: 0, east: 0, north: 0 },
        layers: [],
        limit: 0,
        sources: []
      },
      summary: { featureCount: 0, sourceCount: 0, staleFeatureCount: 0, warningCount: 0 },
      features: [],
      sources: [],
      warnings: []
    },
    "situation data features",
    warnings
  );

  return {
    scenarios: scenarios.items,
    runtime,
    publisher,
    queue: queue.items,
    queueTotalCount: queue.totalCount ?? queue.items.length,
    blocks: blocks.blocks,
    providers: providers.providers,
    flightData: {
      health: flightHealth,
      sources: flightSources.items,
      config: flightConfig,
      tracks: flightTracks
    },
    situationData: {
      health: situationHealth,
      layers: situationLayers.items,
      sources: situationSources.items,
      config: situationConfig,
      features: situationFeatures
    },
    warnings
  };
}

function unwrapDashboardResult<T>(result: PromiseSettledResult<T>, fallback: T, label: string, warnings: string[]): T {
  if (result.status === "fulfilled") {
    return result.value;
  }
  const message = result.reason instanceof Error ? result.reason.message : "unknown error";
  warnings.push(`${label}: ${message}`);
  return fallback;
}

export async function createScenario(payload: Scenario) {
  return api<{ scenarioId: string; status: string; createdAt: string }>("/api/v1/scenarios", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function runtimeAction(
  scenarioId: string,
  action: "start" | "pause" | "resume" | "stop" | "reset" | "step",
  payload: Record<string, unknown> = {}
) {
  return api<RuntimeStatus>(`/api/v1/scenarios/${scenarioId}/${action}`, {
    method: "POST",
    body: JSON.stringify({ reason: "UI pilot action", ...payload })
  });
}

export async function addConnectivityFault(scenarioId: string) {
  return api(`/api/v1/scenarios/${scenarioId}/faults`, {
    method: "POST",
    body: JSON.stringify({
      type: "SOURCE_OUTAGE",
      targetBlockId: "air-sim-uav",
      startAtSecond: 300,
      durationSeconds: 120,
      parameters: { reconnectBurst: true }
    })
  });
}

export async function testPublisher() {
  return api<{ ok: boolean; mode: string; latencyMs: number }>("/api/v1/publisher/test-connection", {
    method: "POST",
    body: JSON.stringify({})
  });
}

export async function clearQueue() {
  return api<{ accepted: boolean; affectedCount: number }>("/api/v1/publisher/queue/clear", {
    method: "POST",
    body: JSON.stringify({ reason: "UI pilot clear" })
  });
}

export async function createAiDraft(prompt: string) {
  return api<AiDraft>("/api/v1/ai/scenario-drafts", {
    method: "POST",
    body: JSON.stringify({
      prompt,
      purpose: "LATENCY_TEST",
      allowedBlocks: ["air-sim-aircraft", "air-sim-uav", "air-sim-missile"],
      limits: {
        maxObjects: 120,
        maxDurationSeconds: 900,
        externalProviderAllowed: false
      },
      providerPreference: "mock"
    })
  });
}

export async function acceptAiDraft(draftId: string) {
  return api<{ scenarioId: string; status: string; createdAt: string }>(`/api/v1/ai/scenario-drafts/${draftId}/accept`, {
    method: "POST",
    body: JSON.stringify({})
  });
}
