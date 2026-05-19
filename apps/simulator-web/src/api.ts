import type { AiDraft, PublisherStatus, QueueItem, RuntimeStatus, Scenario, ScenarioBlock } from "./types";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
    throw new Error(error.error?.message ?? response.statusText);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
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

export async function loadDashboard() {
  const [scenarios, runtime, publisher, queue, blocks, providers] = await Promise.all([
    api<{ items: Scenario[] }>("/api/v1/scenarios"),
    api<RuntimeStatus>("/api/v1/runtime/status"),
    api<PublisherStatus>("/api/v1/runtime/publisher"),
    api<{ items: QueueItem[]; totalCount?: number }>("/api/v1/publisher/queue?limit=20"),
    api<{ blocks: ScenarioBlock[] }>("/api/v1/runtime/blocks"),
    api<{ providers: Array<{ id: string; enabled: boolean; external: boolean; healthy: boolean }> }>("/api/v1/ai/providers")
  ]);

  return {
    scenarios: scenarios.items,
    runtime,
    publisher,
    queue: queue.items,
    queueTotalCount: queue.totalCount ?? queue.items.length,
    blocks: blocks.blocks,
    providers: providers.providers
  };
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
