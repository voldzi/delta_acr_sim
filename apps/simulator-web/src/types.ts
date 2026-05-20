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
  metadata?: {
    syntheticOnly?: boolean;
    createdAt?: string;
    [key: string]: unknown;
  };
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
  createdAt?: string;
  updatedAt: string;
  lastError?: string;
  event: {
    eventType: string;
    classification: { handlingCaveats: string[] };
    geo?: { lat?: number; lon?: number; altitudeM?: number; accuracyM?: number };
    payload: {
      objectId: string;
      objectType: string;
      affiliation?: string;
      status: string;
      speedMps?: number;
      headingDeg?: number;
    };
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

export interface FlightDataHealth {
  status: string;
  timestamp?: string;
  enabledSources: string[];
}

export interface FlightDataLicense {
  name: string;
  url?: string;
  attribution: string;
  commercialUse: "allowed" | "allowed_with_obligations" | "requires_license" | "unknown";
  operationalUse: "allowed" | "allowed_with_obligations" | "requires_license" | "unknown";
  notes: string[];
}

export interface FlightDataSource {
  sourceId: "mock" | "adsb_lol" | "opensky";
  label: string;
  enabled: boolean;
  mode: "live" | "mock" | "reference";
  priority: number;
  license: FlightDataLicense;
  baseUrl?: string;
}

export interface FlightDataConfig {
  enabledSources: Array<"mock" | "adsb_lol" | "opensky">;
  defaultArea: {
    lat: number;
    lon: number;
    radiusNm: number;
  };
  cacheTtlSeconds: number;
  staleIfErrorSeconds: number;
  cacheMaxEntries: number;
  staleAfterSeconds: number;
  requestTimeoutMs: number;
  providers: Array<{
    sourceId: "mock" | "adsb_lol" | "opensky";
    baseUrl?: string;
    authConfigured: boolean;
  }>;
}

export interface FlightDataTrack {
  trackId: string;
  icao24: string;
  callsign?: string;
  registration?: string;
  objectType: "AIRCRAFT" | "UAV" | "UNKNOWN";
  domain: "AIR";
  lat: number;
  lon: number;
  altitudeM?: number;
  speedMps?: number;
  headingDeg?: number;
  verticalRateMps?: number;
  lastSeenAt: string;
  originCountry?: string;
  aircraft?: {
    typeDesignator?: string;
    manufacturer?: string;
    model?: string;
    category?: string;
    engineType?: string;
    wakeTurbulenceCategory?: string;
  };
  sources: Array<{
    sourceId: string;
    sourceRecordId: string;
    fetchedAt: string;
    seenAt: string;
  }>;
  deduplication: {
    key: "icao24";
    mergedRecordCount: number;
    primarySourceId: string;
  };
  quality: {
    confidence: number;
    stale: boolean;
    positionAgeSeconds?: number;
  };
  metadata: {
    onGround?: boolean;
    squawk?: string;
    emergency?: string;
    sourceLicenses: string[];
  };
}

export interface FlightDataTrackResponse {
  contractVersion: "cop-flight-source-v1";
  source: {
    sourceId: string;
    sourceType: "PUBLIC_FLIGHT_AGGREGATE";
    generatedAt: string;
  };
  summary: {
    rawObservationCount: number;
    deduplicatedTrackCount: number;
    droppedWithoutPositionCount: number;
    staleTrackCount: number;
  };
  tracks: FlightDataTrack[];
  sources: FlightDataSource[];
  warnings: string[];
}

export type SituationLayerId = "weather" | "ground" | "mobile" | "traffic" | "warnings" | "flood" | "air_quality";
export type SituationDataSourceId = "mock" | "open_meteo" | "osm_overpass" | "ctu_nettest" | "pid_gtfs_rt" | "safety_data";

export interface SituationDataHealth {
  status: string;
  timestamp?: string;
  enabledSources: SituationDataSourceId[];
}

export interface SituationDataLicense {
  name: string;
  url?: string;
  attribution: string;
  commercialUse: "allowed" | "allowed_with_obligations" | "requires_license" | "unknown";
  operationalUse: "allowed" | "allowed_with_obligations" | "requires_license" | "unknown";
  notes: string[];
}

export interface SituationDataLayer {
  layerId: SituationLayerId;
  label: string;
  description: string;
  defaultVisible: boolean;
  geometryTypes: Array<"Point" | "LineString" | "Polygon">;
  expectedCadenceSeconds?: number;
}

export interface SituationDataSource {
  sourceId: SituationDataSourceId;
  label: string;
  enabled: boolean;
  mode: "live" | "mock" | "reference";
  priority: number;
  layers: SituationLayerId[];
  license: SituationDataLicense;
  baseUrl?: string;
  updateCadenceSeconds?: number;
}

export interface SituationDataConfig {
  enabledSources: SituationDataSourceId[];
  defaultBbox: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
  cacheTtlSeconds: number;
  staleIfErrorSeconds: number;
  cacheMaxEntries: number;
  bboxCachePaddingDegrees: number;
  staleAfterSeconds: number;
  requestTimeoutMs: number;
  sourceCacheTtlSeconds: {
    openMeteo: number;
    osmOverpass: number;
    safetyData: number;
  };
  providers: Array<{
    sourceId: SituationDataSourceId;
    baseUrl?: string;
    authConfigured: boolean;
  }>;
}

export interface SituationDataFeature {
  type: "Feature";
  id: string;
  geometry: {
    type: "Point" | "LineString" | "Polygon";
    coordinates: unknown;
  };
  properties: {
    featureId: string;
    layer: SituationLayerId;
    category: string;
    label: string;
    sourceId: SituationDataSourceId;
    observedAt: string;
    validUntil?: string;
    confidence: number;
    stale: boolean;
    severity: "info" | "advisory" | "warning" | "critical";
    license: {
      name: string;
      attribution: string;
      url?: string;
    };
    metrics?: Record<string, number | string | boolean>;
    tags?: Record<string, string>;
  };
}

export interface SituationDataFeatureResponse {
  contractVersion: "cop-situation-source-v1";
  type: "FeatureCollection";
  generatedAt: string;
  source: {
    sourceId: string;
    sourceType: "PUBLIC_SITUATION_AGGREGATE";
    generatedAt: string;
  };
  query: {
    bbox: {
      west: number;
      south: number;
      east: number;
      north: number;
    };
    layers: SituationLayerId[];
    limit: number;
    sources: SituationDataSourceId[];
  };
  summary: {
    featureCount: number;
    sourceCount: number;
    staleFeatureCount: number;
    warningCount: number;
  };
  features: SituationDataFeature[];
  sources: SituationDataSource[];
  warnings: string[];
}

export type SafetyLayerId = "warnings" | "flood";
export type SafetyDataSourceId = "mock" | "chmi_alerts" | "chmi_hydro";

export interface SafetyDataHealth {
  status: string;
  timestamp?: string;
  enabledSources: SafetyDataSourceId[];
}

export interface SafetyDataLicense {
  name: string;
  url?: string;
  attribution: string;
  commercialUse: "allowed" | "allowed_with_obligations" | "requires_license" | "unknown";
  operationalUse: "allowed" | "allowed_with_obligations" | "requires_license" | "unknown";
  notes: string[];
}

export interface SafetyDataLayer {
  layerId: SafetyLayerId;
  label: string;
  description: string;
  defaultVisible: boolean;
  geometryTypes: Array<"Point" | "LineString" | "Polygon">;
  expectedCadenceSeconds?: number;
}

export interface SafetyDataSource {
  sourceId: SafetyDataSourceId;
  label: string;
  enabled: boolean;
  mode: "live" | "mock" | "reference";
  priority: number;
  layers: SafetyLayerId[];
  license: SafetyDataLicense;
  baseUrl?: string;
  updateCadenceSeconds?: number;
}

export interface SafetyDataConfig {
  enabledSources: SafetyDataSourceId[];
  defaultBbox: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
  cacheTtlSeconds: number;
  staleIfErrorSeconds: number;
  cacheMaxEntries: number;
  staleAfterSeconds: number;
  requestTimeoutMs: number;
  hydroMaxStations: number;
  providers: Array<{
    sourceId: SafetyDataSourceId;
    baseUrl?: string;
    authConfigured: boolean;
  }>;
}

export interface SafetyDataFeature {
  type: "Feature";
  id: string;
  geometry: {
    type: "Point" | "Polygon";
    coordinates: unknown;
  };
  properties: {
    featureId: string;
    layer: SafetyLayerId;
    category: string;
    headline: string;
    description?: string;
    recommendedAction?: string;
    sourceId: SafetyDataSourceId;
    observedAt: string;
    effectiveAt?: string;
    expiresAt?: string;
    confidence: number;
    stale: boolean;
    severity: "info" | "advisory" | "warning" | "critical";
    urgency: "immediate" | "expected" | "future" | "past" | "unknown";
    certainty: "observed" | "likely" | "possible" | "unlikely" | "unknown";
    license: {
      name: string;
      attribution: string;
      url?: string;
    };
    affectedAreas?: string[];
    geocodes?: Array<{ scheme: string; value: string }>;
    metrics?: Record<string, number | string | boolean>;
    tags?: Record<string, string>;
  };
}

export interface SafetyDataFeatureResponse {
  contractVersion: "cop-safety-source-v1";
  type: "FeatureCollection";
  generatedAt: string;
  source: {
    sourceId: string;
    sourceType: "PUBLIC_SAFETY_AGGREGATE";
    generatedAt: string;
  };
  query: {
    bbox: {
      west: number;
      south: number;
      east: number;
      north: number;
    };
    layers: SafetyLayerId[];
    limit: number;
    sources: SafetyDataSourceId[];
  };
  summary: {
    featureCount: number;
    sourceCount: number;
    staleFeatureCount: number;
    advisoryCount: number;
    warningCount: number;
    criticalCount: number;
  };
  features: SafetyDataFeature[];
  sources: SafetyDataSource[];
  warnings: string[];
}
