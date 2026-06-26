import type {
  AiDraft,
  FlightDataConfig,
  FlightDataHealth,
  FlightDataSource,
  FlightDataTrackResponse,
  PublisherStatus,
  QueueItem,
  RuntimeStatus,
  SafetyDataConfig,
  SafetyDataFeatureResponse,
  SafetyDataHealth,
  SafetyDataLayer,
  SafetyDataSourceId,
  SafetyDataSource,
  Scenario,
  ScenarioBlock,
  DashboardObservability,
  OperationsSummary,
  ServiceObservability,
  TakGatewayConfig,
  TakGatewayFeatureResponse,
  TakGatewayHealth,
  TakGatewayLayer,
  TakGatewaySource,
  SituationDataConfig,
  SituationDataFeatureResponse,
  SituationDataHealth,
  SituationDataLayer,
  SituationDataSourceId,
  SituationDataSource
} from "./types";

const API_TIMEOUT_MS = 5_000;
const SIM_API_TOKEN_STORAGE_KEY = "csm-sim-api-token";
const AUTH_CHANGE_EVENT = "csm-sim-auth-change";
let authorizationTokenProvider: (() => string | undefined) | undefined;
let manualTokenUsageEnabled = true;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  const token = getSimAuthorizationToken();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init?.headers as Record<string, string> | undefined)
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers
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

async function timedApi<T>(path: string, init?: RequestInit): Promise<{ latencyMs: number; payload: T }> {
  const startedAt = performance.now();
  const payload = await api<T>(path, init);
  return {
    latencyMs: Math.round(performance.now() - startedAt),
    payload
  };
}

export function getSimApiToken(): string {
  return window.sessionStorage.getItem(SIM_API_TOKEN_STORAGE_KEY) ?? "";
}

export function hasSimApiToken(): boolean {
  return getSimApiToken().length > 0;
}

export function getSimAuthorizationToken(): string {
  return authorizationTokenProvider?.() ?? (manualTokenUsageEnabled ? getSimApiToken() : "");
}

export function hasSimAuthorizationToken(): boolean {
  return getSimAuthorizationToken().length > 0;
}

export function setSimAuthorizationTokenProvider(provider: (() => string | undefined) | undefined): void {
  authorizationTokenProvider = provider;
  window.dispatchEvent(new Event(AUTH_CHANGE_EVENT));
}

export function setSimManualTokenUsageEnabled(enabled: boolean): void {
  manualTokenUsageEnabled = enabled;
  if (!enabled && hasSimApiToken()) {
    window.sessionStorage.removeItem(SIM_API_TOKEN_STORAGE_KEY);
  }
  window.dispatchEvent(new Event(AUTH_CHANGE_EVENT));
}

export function setSimApiToken(token: string): void {
  const trimmed = token.trim();
  if (trimmed) {
    window.sessionStorage.setItem(SIM_API_TOKEN_STORAGE_KEY, trimmed);
  } else {
    window.sessionStorage.removeItem(SIM_API_TOKEN_STORAGE_KEY);
  }
  window.dispatchEvent(new Event(AUTH_CHANGE_EVENT));
}

export function clearSimApiToken(): void {
  setSimApiToken("");
}

export function onSimApiAuthChange(handler: () => void): () => void {
  window.addEventListener(AUTH_CHANGE_EVENT, handler);
  return () => window.removeEventListener(AUTH_CHANGE_EVENT, handler);
}

export const demoScenario: Scenario = {
  name: "Moving COM Tracks Demo",
  description: "Synthetic moving aircraft, UAV and missile-track events for COM display validation.",
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
  name: "High Density COM Tracks Demo",
  description: "Synthetic high-density moving air picture with hundreds of COM-compatible tracks.",
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

export const ukraineAirDefenseDemoScenario: Scenario = {
  name: "Ukraine Air Defense Demo 2026-05-13",
  description:
    "Synthetic non-operational demonstration inspired by a public aggregate flight-path image from 2026-05-13. Red inbound tracks and blue defensive interceptors meet over Ukraine; about 90% of hostile tracks are terminated together with the paired interceptor.",
  area: {
    type: "BBOX",
    bbox: [22.0, 44.2, 40.4, 52.5]
  },
  durationSeconds: 5700,
  seed: 20260513,
  blocks: [
    {
      blockId: "air-sim-uav",
      enabled: true,
      objectCount: 72,
      updateRateHz: 1,
      patterns: ["DIRECT"],
      parameters: {
        objectIdPrefix: "HOSTILE_UAV",
        routeModel: "UKRAINE_AIR_DEFENSE_DEMO",
        engagementRole: "HOSTILE_INBOUND",
        engagementFamily: "uav",
        pairedObjectIdPrefix: "BLUE_INTERCEPTOR_UAV",
        affiliations: ["HOSTILE"],
        sourceReferenceDate: "2026-05-13"
      }
    },
    {
      blockId: "air-sim-missile",
      enabled: true,
      objectCount: 18,
      updateRateHz: 1,
      patterns: ["SHORT_LIVED_TRACK"],
      parameters: {
        objectIdPrefix: "HOSTILE_MSL",
        routeModel: "UKRAINE_AIR_DEFENSE_DEMO",
        engagementRole: "HOSTILE_INBOUND",
        engagementFamily: "missile",
        pairedObjectIdPrefix: "BLUE_INTERCEPTOR_MSL",
        affiliations: ["HOSTILE"],
        sourceReferenceDate: "2026-05-13"
      }
    },
    {
      blockId: "air-sim-uav",
      enabled: true,
      objectCount: 65,
      updateRateHz: 1,
      patterns: ["DIRECT"],
      parameters: {
        objectIdPrefix: "BLUE_INTERCEPTOR_UAV",
        routeModel: "UKRAINE_AIR_DEFENSE_DEMO",
        engagementRole: "FRIEND_INTERCEPTOR",
        engagementFamily: "uav",
        pairedObjectIdPrefix: "HOSTILE_UAV",
        affiliations: ["FRIEND"],
        sourceReferenceDate: "2026-05-13"
      }
    },
    {
      blockId: "air-sim-missile",
      enabled: true,
      objectCount: 17,
      updateRateHz: 1,
      patterns: ["SHORT_LIVED_TRACK"],
      parameters: {
        objectIdPrefix: "BLUE_INTERCEPTOR_MSL",
        routeModel: "UKRAINE_AIR_DEFENSE_DEMO",
        engagementRole: "FRIEND_INTERCEPTOR",
        engagementFamily: "missile",
        pairedObjectIdPrefix: "HOSTILE_MSL",
        affiliations: ["FRIEND"],
        sourceReferenceDate: "2026-05-13"
      }
    }
  ],
  faults: [],
  metadata: {
    syntheticOnly: true,
    demonstration: "ukraine-air-defense-summary",
    sourceReferenceDate: "2026-05-13",
    modeledInterceptedRatio: 0.9,
    nonOperational: true
  }
};

export interface DashboardLoadResult {
  operations: OperationsSummary;
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
  safetyData: {
    health: SafetyDataHealth;
    layers: SafetyDataLayer[];
    sources: SafetyDataSource[];
    config: SafetyDataConfig;
    features: SafetyDataFeatureResponse;
  };
  takGateway: {
    health: TakGatewayHealth;
    layers: TakGatewayLayer[];
    sources: TakGatewaySource[];
    config: TakGatewayConfig;
    features: TakGatewayFeatureResponse;
  };
  observability: DashboardObservability;
  warnings: string[];
}

const emptyTakFeatureResponse: TakGatewayFeatureResponse = {
  contractVersion: "cop-tak-source-v1",
  type: "FeatureCollection",
  generatedAt: new Date(0).toISOString(),
  source: {
    sourceId: "tak-gateway-api",
    sourceType: "TAK_COT_GATEWAY",
    generatedAt: new Date(0).toISOString()
  },
  query: {
    bbox: { west: 0, south: 0, east: 0, north: 0 },
    layers: [],
    limit: 0
  },
  summary: {
    eventCount: 0,
    featureCount: 0,
    sourceCount: 0,
    staleFeatureCount: 0,
    warningCount: 0,
    affiliationCounts: { friend: 0, hostile: 0, neutral: 0, unknown: 0 }
  },
  features: [],
  sources: [],
  warnings: []
};

const emptyOperationsSummary: OperationsSummary = {
  alerts: [],
  contractVersion: "sim-operations-summary-v1",
  deployment: {
    adapterVersion: "-",
    publisherMode: "DRY_RUN",
    sourceSystemId: "-"
  },
  generatedAt: new Date(0).toISOString(),
  publisher: {
    mode: "DRY_RUN",
    queueSize: 0,
    deadLetterSize: 0,
    publishingEnabled: false
  },
  runtime: {
    state: "UNAVAILABLE",
    generatedEvents: 0,
    publishedEvents: 0,
    queuedEvents: 0
  },
  scenarios: {
    active: 0,
    draft: 0,
    paused: 0,
    ready: 0,
    running: 0,
    stopped: 0,
    total: 0
  },
  services: [],
  status: "unknown"
};

function operationsService(summary: OperationsSummary, serviceId: string) {
  return summary.services.find((service) => service.serviceId === serviceId);
}

const situationDataSourceIds: SituationDataSourceId[] = [
  "mock",
  "open_meteo",
  "mobile_coverage_model",
  "mobile_network_model",
  "osm_postgis",
  "osm_overpass",
  "ctu_nettest",
  "ctu_stationary_mobile",
  "pid_gtfs_rt",
  "idsjmk_vehicle_positions",
  "road_srti_lod",
  "safety_data",
  "aviation_weather",
  "chmi_air_quality",
  "chmi_weather_stations",
  "ardos_partner"
];

const safetyDataSourceIds: SafetyDataSourceId[] = ["mock", "chmi_alerts", "chmi_hydro", "nasa_firms", "admin_boundaries"];

function filterKnownSourceIds<T extends string>(sourceIds: string[], allowed: readonly T[]): T[] {
  const allowedSet = new Set<string>(allowed);
  return sourceIds.filter((sourceId): sourceId is T => allowedSet.has(sourceId));
}

function flightHealthFromOperations(summary: OperationsSummary): FlightDataHealth {
  const service = operationsService(summary, "flight-data-api");
  return {
    status: service?.healthStatus ?? service?.status ?? "unavailable",
    enabledSources: service?.enabledSources ?? []
  };
}

function situationHealthFromOperations(summary: OperationsSummary): SituationDataHealth {
  const service = operationsService(summary, "situation-data-api");
  return {
    status: service?.healthStatus ?? service?.status ?? "unavailable",
    enabledSources: filterKnownSourceIds(service?.enabledSources ?? [], situationDataSourceIds),
    sourceHealth: []
  };
}

function safetyHealthFromOperations(summary: OperationsSummary): SafetyDataHealth {
  const service = operationsService(summary, "safety-data-api");
  return {
    status: service?.healthStatus ?? service?.status ?? "unavailable",
    enabledSources: filterKnownSourceIds(service?.enabledSources ?? [], safetyDataSourceIds)
  };
}

function takGatewayHealthFromOperations(summary: OperationsSummary): TakGatewayHealth {
  const service = operationsService(summary, "tak-gateway-api");
  return {
    status: service?.healthStatus ?? service?.status ?? "unavailable",
    ingestAuthConfigured: false,
    readAuthConfigured: false,
    publicRead: false,
    currentEvents: service?.objectCount ?? 0,
    staleEvents: 0
  };
}

function timedObservabilityFromOperations(summary: OperationsSummary, serviceId: string): { latencyMs: number; payload: ServiceObservability } {
  const service = operationsService(summary, serviceId);
  return {
    latencyMs: service?.latencyMs ?? 0,
    payload: {
      serviceId,
      generatedAt: summary.generatedAt,
      status: service?.status ?? "unavailable",
      cache: service?.cache ? fullCacheObservability(service.cache) : undefined,
      sharedCache: service?.sharedCache
        ? {
            enabled: service.sharedCache.enabled ?? false,
            available: service.sharedCache.available ?? false,
            hits: 0,
            misses: 0,
            hitRate: service.sharedCache.hitRate ?? 0,
            staleHits: 0,
            writes: 0,
            errors: service.sharedCache.errors ?? 0,
            state: service.sharedCache.state ?? "unknown"
          }
        : undefined,
      dataFreshness: service?.dataFreshness
        ? {
            sourceCount: service.dataFreshness.sourceCount ?? 0,
            sourcesWithImportAge: service.dataFreshness.newestImportAgeSeconds === undefined ? 0 : 1,
            newestImportAgeSeconds: service.dataFreshness.newestImportAgeSeconds ?? -1,
            oldestImportAgeSeconds: service.dataFreshness.oldestImportAgeSeconds ?? -1,
            degradedSourceCount: service.dataFreshness.degradedSourceCount ?? 0,
            warningCount: service.dataFreshness.warningCount ?? 0
          }
        : undefined
    }
  };
}

function fullCacheObservability(cache: NonNullable<OperationsSummary["services"][number]["cache"]>): ServiceObservability["cache"] {
  return {
    entries: cache.entries ?? 0,
    inflight: 0,
    maxEntries: 0,
    pressure: cache.pressure ?? 0,
    hits: 0,
    misses: cache.misses ?? 0,
    hitRate: cache.hitRate ?? 0,
    coalescedHits: 0,
    staleHits: cache.staleHits ?? 0,
    refreshes: 0,
    errors: cache.errors ?? 0,
    evictions: 0,
    state: cache.state ?? "unknown"
  };
}

function emptyFlightDataConfig(): FlightDataConfig {
  return {
    enabledSources: [],
    defaultArea: { lat: 0, lon: 0, radiusNm: 0 },
    cacheTtlSeconds: 0,
    staleIfErrorSeconds: 0,
    cacheMaxEntries: 0,
    staleAfterSeconds: 0,
    requestTimeoutMs: 0,
    providers: []
  };
}

function emptySituationDataConfig(): SituationDataConfig {
  return {
    enabledSources: [],
    defaultBbox: { west: 0, south: 0, east: 0, north: 0 },
    cacheTtlSeconds: 0,
    staleIfErrorSeconds: 0,
    cacheMaxEntries: 0,
    sharedCache: { enabled: false, backend: "memory", keyPrefix: "-", connectTimeoutMs: 0 },
    bboxCachePaddingDegrees: 0,
    staleAfterSeconds: 0,
    requestTimeoutMs: 0,
    sourceCacheTtlSeconds: {
      openMeteo: 0,
      mobileNetwork: 0,
      mobileCoverage: 0,
      osmPostgis: 0,
      osmOverpass: 0,
      ctuStationaryMobile: 0,
      idsjmkVehiclePositions: 0,
      roadSrtiLod: 0,
      safetyData: 0,
      aviationWeather: 0,
      chmiAirQuality: 0,
      chmiWeatherStations: 0,
      ardosPartner: 0
    },
    providers: []
  };
}

function emptySafetyDataConfig(): SafetyDataConfig {
  return {
    enabledSources: [],
    defaultBbox: { west: 0, south: 0, east: 0, north: 0 },
    cacheTtlSeconds: 0,
    staleIfErrorSeconds: 0,
    cacheMaxEntries: 0,
    staleAfterSeconds: 0,
    requestTimeoutMs: 0,
    hydroMaxStations: 0,
    providers: []
  };
}

function emptyTakGatewayConfig(): TakGatewayConfig {
  return {
    defaultBbox: { west: 0, south: 0, east: 0, north: 0 },
    staleAfterSeconds: 0,
    retentionSeconds: 0,
    maxEvents: 0,
    exposeRaw: false,
    ingestAuthConfigured: false,
    readAuthConfigured: false,
    publicRead: false,
    sourceLabel: ""
  };
}

function emptyFlightTrackPayload(): FlightDataTrackPayload {
  return {
    generatedAt: new Date(0).toISOString(),
    summary: { rawObservationCount: 0, deduplicatedTrackCount: 0, droppedWithoutPositionCount: 0, staleTrackCount: 0 },
    tracks: [],
    sources: [],
    warnings: []
  };
}

function emptySituationDataFeatureResponse(): SituationDataFeatureResponse {
  return {
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
  };
}

function emptySafetyDataFeatureResponse(): SafetyDataFeatureResponse {
  return {
    contractVersion: "cop-safety-source-v1",
    type: "FeatureCollection",
    generatedAt: new Date(0).toISOString(),
    source: {
      sourceId: "safety-data-api",
      sourceType: "PUBLIC_SAFETY_AGGREGATE",
      generatedAt: new Date(0).toISOString()
    },
    query: {
      bbox: { west: 0, south: 0, east: 0, north: 0 },
      layers: [],
      limit: 0,
      sources: []
    },
    summary: {
      featureCount: 0,
      sourceCount: 0,
      staleFeatureCount: 0,
      advisoryCount: 0,
      warningCount: 0,
      criticalCount: 0
    },
    features: [],
    sources: [],
    warnings: []
  };
}

export async function loadDashboard(options: { includeDetails?: boolean } = {}): Promise<DashboardLoadResult> {
  const dashboardStartedAt = performance.now();
  const operatorTokenConfigured = hasSimAuthorizationToken();
  const includeDetails = options.includeDetails ?? true;
  let operationsSummaryWarning: string | undefined;
  const operationsSummary = await api<OperationsSummary>("/api/v1/operations/summary").catch((error: unknown) => {
    operationsSummaryWarning = error instanceof Error ? error.message : "unknown error";
    return emptyOperationsSummary;
  });
  const results = await Promise.allSettled([
    includeDetails ? api<{ items: Scenario[] }>("/api/v1/scenarios") : Promise.resolve({ items: [] }),
    includeDetails ? api<RuntimeStatus>("/api/v1/runtime/status") : Promise.resolve(operationsSummary.runtime),
    includeDetails ? api<PublisherStatus>("/api/v1/runtime/publisher") : Promise.resolve(operationsSummary.publisher),
    includeDetails && operatorTokenConfigured ? api<{ items: QueueItem[]; totalCount?: number }>("/api/v1/publisher/queue?limit=20") : Promise.resolve({ items: [], totalCount: 0 }),
    includeDetails ? api<{ blocks: ScenarioBlock[] }>("/api/v1/runtime/blocks") : Promise.resolve({ blocks: [] }),
    includeDetails ? api<{ providers: Array<{ id: string; enabled: boolean; external: boolean; healthy: boolean }> }>("/api/v1/ai/providers") : Promise.resolve({ providers: [] }),
    includeDetails ? api<FlightDataHealth>("/flight-data/health/ready") : Promise.resolve(flightHealthFromOperations(operationsSummary)),
    includeDetails ? api<{ items: FlightDataSource[] }>("/flight-data/api/v1/sources") : Promise.resolve({ items: [] }),
    includeDetails ? api<FlightDataConfig>("/flight-data/api/v1/config") : Promise.resolve(emptyFlightDataConfig()),
    includeDetails ? api<FlightDataTrackPayload>("/flight-data/api/v1/aircraft/positions?limit=8") : Promise.resolve(emptyFlightTrackPayload()),
    includeDetails ? api<SituationDataHealth>("/situation-data/health/ready") : Promise.resolve(situationHealthFromOperations(operationsSummary)),
    includeDetails ? api<{ items: SituationDataLayer[] }>("/situation-data/api/v1/layers") : Promise.resolve({ items: [] }),
    includeDetails ? api<{ items: SituationDataSource[] }>("/situation-data/api/v1/sources") : Promise.resolve({ items: [] }),
    includeDetails ? api<SituationDataConfig>("/situation-data/api/v1/config") : Promise.resolve(emptySituationDataConfig()),
    includeDetails ? api<SituationDataFeatureResponse>("/situation-data/api/v1/features?limit=12") : Promise.resolve(emptySituationDataFeatureResponse()),
    includeDetails ? api<SafetyDataHealth>("/safety-data/health/ready") : Promise.resolve(safetyHealthFromOperations(operationsSummary)),
    includeDetails ? api<{ items: SafetyDataLayer[] }>("/safety-data/api/v1/layers") : Promise.resolve({ items: [] }),
    includeDetails ? api<{ items: SafetyDataSource[] }>("/safety-data/api/v1/sources") : Promise.resolve({ items: [] }),
    includeDetails ? api<SafetyDataConfig>("/safety-data/api/v1/config") : Promise.resolve(emptySafetyDataConfig()),
    includeDetails ? api<SafetyDataFeatureResponse>("/safety-data/api/v1/features?limit=12") : Promise.resolve(emptySafetyDataFeatureResponse()),
    includeDetails ? api<TakGatewayHealth>("/tak-gateway/health/ready") : Promise.resolve(takGatewayHealthFromOperations(operationsSummary)),
    includeDetails ? api<{ items: TakGatewayLayer[] }>("/tak-gateway/api/v1/layers") : Promise.resolve({ items: [] }),
    includeDetails ? api<{ items: TakGatewaySource[] }>("/tak-gateway/api/v1/sources") : Promise.resolve({ items: [] }),
    includeDetails ? api<TakGatewayConfig>("/tak-gateway/api/v1/config") : Promise.resolve(emptyTakGatewayConfig()),
    includeDetails && operatorTokenConfigured ? api<TakGatewayFeatureResponse>("/tak-gateway/api/v1/features?limit=12") : Promise.resolve(emptyTakFeatureResponse),
    includeDetails ? timedApi<ServiceObservability>("/flight-data/api/v1/observability") : Promise.resolve(timedObservabilityFromOperations(operationsSummary, "flight-data-api")),
    includeDetails ? timedApi<ServiceObservability>("/situation-data/api/v1/observability") : Promise.resolve(timedObservabilityFromOperations(operationsSummary, "situation-data-api")),
    includeDetails ? timedApi<ServiceObservability>("/safety-data/api/v1/observability") : Promise.resolve(timedObservabilityFromOperations(operationsSummary, "safety-data-api")),
    includeDetails ? timedApi<ServiceObservability>("/tak-gateway/api/v1/observability") : Promise.resolve(timedObservabilityFromOperations(operationsSummary, "tak-gateway-api"))
  ]);

  const warnings: string[] = operationsSummaryWarning ? [`operations summary: ${operationsSummaryWarning}`] : [];
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
      staleIfErrorSeconds: 0,
      cacheMaxEntries: 0,
      staleAfterSeconds: 0,
      requestTimeoutMs: 0,
      providers: []
    },
    "flight data config",
    warnings
  );
  const flightTrackPayload = unwrapDashboardResult(
    results[9],
    {
      generatedAt: new Date(0).toISOString(),
      summary: { rawObservationCount: 0, deduplicatedTrackCount: 0, droppedWithoutPositionCount: 0, staleTrackCount: 0 },
      tracks: [],
      sources: [],
      warnings: []
    },
    "flight data tracks",
    warnings
  );
  const flightTracks = normalizeFlightTrackPayload(flightTrackPayload);
  const situationHealth = unwrapDashboardResult(results[10], { status: "unavailable", enabledSources: [], sourceHealth: [] }, "situation data health", warnings);
  const situationLayers = unwrapDashboardResult(results[11], { items: [] }, "situation data layers", warnings);
  const situationSources = unwrapDashboardResult(results[12], { items: [] }, "situation data sources", warnings);
  const situationConfig = unwrapDashboardResult(
    results[13],
    {
      enabledSources: [],
      defaultBbox: { west: 0, south: 0, east: 0, north: 0 },
      cacheTtlSeconds: 0,
      staleIfErrorSeconds: 0,
      cacheMaxEntries: 0,
      sharedCache: { enabled: false, backend: "memory", keyPrefix: "-", connectTimeoutMs: 0 },
      bboxCachePaddingDegrees: 0,
      staleAfterSeconds: 0,
      requestTimeoutMs: 0,
      sourceCacheTtlSeconds: {
        openMeteo: 0,
        mobileNetwork: 0,
        mobileCoverage: 0,
        osmPostgis: 0,
        osmOverpass: 0,
        ctuStationaryMobile: 0,
        idsjmkVehiclePositions: 0,
        roadSrtiLod: 0,
        safetyData: 0,
        aviationWeather: 0,
        chmiAirQuality: 0,
        chmiWeatherStations: 0,
        ardosPartner: 0
      },
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
  const safetyHealth = unwrapDashboardResult(results[15], { status: "unavailable", enabledSources: [] }, "safety data health", warnings);
  const safetyLayers = unwrapDashboardResult(results[16], { items: [] }, "safety data layers", warnings);
  const safetySources = unwrapDashboardResult(results[17], { items: [] }, "safety data sources", warnings);
  const safetyConfig = unwrapDashboardResult(
    results[18],
    {
      enabledSources: [],
      defaultBbox: { west: 0, south: 0, east: 0, north: 0 },
      cacheTtlSeconds: 0,
      staleIfErrorSeconds: 0,
      cacheMaxEntries: 0,
      staleAfterSeconds: 0,
      requestTimeoutMs: 0,
      hydroMaxStations: 0,
      providers: []
    },
    "safety data config",
    warnings
  );
  const safetyFeatures = unwrapDashboardResult(
    results[19],
    {
      contractVersion: "cop-safety-source-v1",
      type: "FeatureCollection",
      generatedAt: new Date(0).toISOString(),
      source: {
        sourceId: "safety-data-api",
        sourceType: "PUBLIC_SAFETY_AGGREGATE",
        generatedAt: new Date(0).toISOString()
      },
      query: {
        bbox: { west: 0, south: 0, east: 0, north: 0 },
        layers: [],
        limit: 0,
        sources: []
      },
      summary: {
        featureCount: 0,
        sourceCount: 0,
        staleFeatureCount: 0,
        advisoryCount: 0,
        warningCount: 0,
        criticalCount: 0
      },
      features: [],
      sources: [],
      warnings: []
    },
    "safety data features",
    warnings
  );
  const takHealth = unwrapDashboardResult(
    results[20],
    { status: "unavailable", ingestAuthConfigured: false, readAuthConfigured: false, publicRead: false, currentEvents: 0, staleEvents: 0 },
    "TAK gateway health",
    warnings
  );
  const takLayers = unwrapDashboardResult(results[21], { items: [] }, "TAK gateway layers", warnings);
  const takSources = unwrapDashboardResult(results[22], { items: [] }, "TAK gateway sources", warnings);
  const takConfig = unwrapDashboardResult(
    results[23],
    {
      defaultBbox: { west: 0, south: 0, east: 0, north: 0 },
      staleAfterSeconds: 0,
      retentionSeconds: 0,
      maxEvents: 0,
      exposeRaw: false,
      ingestAuthConfigured: false,
      readAuthConfigured: false,
      publicRead: false,
      sourceLabel: ""
    },
    "TAK gateway config",
    warnings
  );
  const takFeatures = unwrapDashboardResult(
    results[24],
    emptyTakFeatureResponse,
    "TAK gateway features",
    warnings
  );
  const flightDataObservability = unwrapDashboardResult(results[25], emptyTimedServiceObservability("flight-data-api"), "flight data observability", warnings);
  const situationDataObservability = unwrapDashboardResult(
    results[26],
    emptyTimedServiceObservability("situation-data-api"),
    "situation data observability",
    warnings
  );
  const safetyDataObservability = unwrapDashboardResult(results[27], emptyTimedServiceObservability("safety-data-api"), "safety data observability", warnings);
  const takGatewayObservability = unwrapDashboardResult(results[28], emptyTimedServiceObservability("tak-gateway-api"), "TAK gateway observability", warnings);

  return {
    operations: operationsSummary,
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
    safetyData: {
      health: safetyHealth,
      layers: safetyLayers.items,
      sources: safetySources.items,
      config: safetyConfig,
      features: safetyFeatures
    },
    takGateway: {
      health: takHealth,
      layers: takLayers.items,
      sources: takSources.items,
      config: takConfig,
      features: takFeatures
    },
    observability: {
      generatedAt: new Date().toISOString(),
      loadDurationMs: Math.round(performance.now() - dashboardStartedAt),
      flightData: flightDataObservability,
      situationData: situationDataObservability,
      safetyData: safetyDataObservability,
      takGateway: takGatewayObservability
    },
    warnings
  };
}

type FlightDataTrackPayload = Omit<FlightDataTrackResponse, "contractVersion" | "source"> &
  Partial<Pick<FlightDataTrackResponse, "contractVersion" | "source">> & {
    generatedAt?: string;
  };

function normalizeFlightTrackPayload(payload: FlightDataTrackPayload): FlightDataTrackResponse {
  const generatedAt = payload.source?.generatedAt ?? payload.generatedAt ?? new Date(0).toISOString();
  return {
    contractVersion: payload.contractVersion ?? "flight-track-response-v1",
    source: payload.source ?? {
      sourceId: "flight-data-api",
      sourceType: "PUBLIC_FLIGHT_AGGREGATE",
      generatedAt
    },
    summary: payload.summary,
    tracks: payload.tracks,
    sources: payload.sources,
    warnings: payload.warnings
  };
}

function emptyTimedServiceObservability(serviceId: string): { latencyMs: number; payload: ServiceObservability } {
  return {
    latencyMs: 0,
    payload: {
      serviceId,
      generatedAt: new Date(0).toISOString(),
      status: "unavailable",
      dataFreshness: {
        sourceCount: 0,
        sourcesWithImportAge: 0,
        newestImportAgeSeconds: -1,
        oldestImportAgeSeconds: -1,
        degradedSourceCount: 0,
        warningCount: 0
      }
    }
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
