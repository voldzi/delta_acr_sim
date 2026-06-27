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
  sourceId: "mock" | "adsb_lol" | "opensky" | "local_adsb";
  label: string;
  enabled: boolean;
  mode: "live" | "mock" | "reference";
  priority: number;
  license: FlightDataLicense;
  baseUrl?: string;
}

export interface FlightDataConfig {
  enabledSources: Array<"mock" | "adsb_lol" | "opensky" | "local_adsb">;
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
    sourceId: "mock" | "adsb_lol" | "opensky" | "local_adsb";
    baseUrl?: string;
    authConfigured: boolean;
  }>;
  referenceData?: {
    ourAirportsEnabled: boolean;
    ourAirportsCountries: string[];
    ourAirportsCacheTtlSeconds: number;
    aipAirspacesEnabled: boolean;
    aipAirspacesCacheTtlSeconds: number;
    aipAirspacesSourceUrl: string;
    uasGeozonesEnabled: boolean;
    uasGeozonesLayerIds: string[];
    uasGeozonesCacheTtlSeconds: number;
    uasGeozonesCatalogUrl: string;
    airspaceActivationEnabled: boolean;
    airspaceActivationCacheTtlSeconds: number;
    airspaceActivationBaseUrl: string;
  };
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
  contractVersion: "flight-track-response-v1" | "cop-flight-source-v1";
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

export type SituationLayerId =
  | "weather"
  | "ground"
  | "mobile"
  | "mobile_coverage"
  | "mobile_network"
  | "traffic"
  | "warnings"
  | "fire"
  | "flood"
  | "boundary_admin"
  | "boundary_country"
  | "boundary_region"
  | "boundary_district"
  | "boundary_orp"
  | "place_settlements"
  | "air_quality"
  | "weather_temperature_grid"
  | "weather_wind_field"
  | "weather_precipitation_grid"
  | "weather_humidity_grid"
  | "weather_pressure_grid"
  | "air_quality_grid";
export type SituationDataSourceId =
  | "mock"
  | "open_meteo"
  | "mobile_coverage_model"
  | "mobile_network_model"
  | "osm_postgis"
  | "osm_overpass"
  | "ctu_nettest"
  | "ctu_stationary_mobile"
  | "pid_gtfs_rt"
  | "idsjmk_vehicle_positions"
  | "road_srti_lod"
  | "safety_data"
  | "aviation_weather"
  | "chmi_air_quality"
  | "chmi_weather_stations"
  | "ardos_partner";

export interface SituationDataSourceHealth {
  sourceId: SituationDataSourceId;
  status: "ok" | "degraded";
  backend?: string;
  objectCount?: number;
  lastImportAt?: string;
  lastImportAgeSeconds?: number;
  boundaryFeatureCount?: number;
  boundaryLevels?: string[];
  boundaryLastImportAt?: string;
  boundaryLastImportAgeSeconds?: number;
  warnings: string[];
}

export interface SituationDataHealth {
  status: string;
  timestamp?: string;
  enabledSources: SituationDataSourceId[];
  sourceHealth?: SituationDataSourceHealth[];
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
  geometryTypes: Array<"Point" | "LineString" | "Polygon" | "MultiPolygon">;
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
  sharedCache: {
    enabled: boolean;
    backend: "memory" | "redis";
    keyPrefix: string;
    connectTimeoutMs: number;
  };
  bboxCachePaddingDegrees: number;
  staleAfterSeconds: number;
  requestTimeoutMs: number;
  sourceCacheTtlSeconds: {
    openMeteo: number;
    mobileNetwork: number;
    mobileCoverage: number;
    osmPostgis: number;
    osmOverpass: number;
    ctuStationaryMobile: number;
    idsjmkVehiclePositions: number;
    roadSrtiLod: number;
    safetyData: number;
    aviationWeather: number;
    chmiAirQuality: number;
    chmiWeatherStations: number;
    ardosPartner: number;
  };
  providers: Array<{
    sourceId: SituationDataSourceId;
    baseUrl?: string;
    authConfigured: boolean;
    backend?: string;
  }>;
}

export interface SituationDataFeature {
  type: "Feature";
  id: string;
  geometry: {
    type: "Point" | "LineString" | "Polygon" | "MultiPolygon";
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
    transportMode?: string;
    routeShortName?: string;
    destination?: string;
    delaySeconds?: number;
    vehicleId?: string;
    tripId?: string;
    occupancyStatus?: string;
    occupancyPercent?: number;
    operator?: string;
    headingDeg?: number;
    speedMps?: number;
    providerProperties?: Record<string, unknown>;
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

export type SafetyLayerId = "weather_alerts" | "warnings" | "fire" | "flood" | "boundary_admin";
export type SafetyDataSourceId = "mock" | "chmi_alerts" | "chmi_hydro" | "nasa_firms" | "admin_boundaries";

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
  geometryTypes: Array<"Point" | "LineString" | "Polygon" | "MultiPolygon">;
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
    type: "Point" | "Polygon" | "MultiPolygon";
    coordinates: unknown;
  };
  properties: {
    featureId: string;
    layerId?: string;
    providerId?: string;
    providerLayerId?: string;
    layer: SafetyLayerId;
    category: string;
    hazardType?: string;
    typeCode?: string;
    sourceCode?: string;
    sourceSystem?: string;
    headline: string;
    description?: string;
    recommendedAction?: string;
    sourceId: SafetyDataSourceId;
    source?: string;
    sourceName?: string;
    observedAt: string;
    effectiveAt?: string;
    expiresAt?: string;
    validFrom?: string;
    validUntil?: string;
    updatedAt?: string;
    confidence: number;
    stale: boolean;
    severity: "info" | "advisory" | "warning" | "critical";
    status?: string;
    urgency: "immediate" | "expected" | "future" | "past" | "unknown";
    certainty: "observed" | "likely" | "possible" | "unlikely" | "unknown";
    areaName?: string;
    adminLevel?: number | string;
    basis?: string[];
    fireStatus?: string;
    detectedAt?: string;
    sourceSatellite?: string;
    sourceIncident?: string;
    intensity?: number;
    frp?: number;
    riverName?: string;
    stationId?: string;
    waterLevelCm?: number;
    discharge?: number;
    floodStage?: number | string;
    trend?: string;
    basin?: string;
    affectedArea?: string;
    name?: string;
    code?: string;
    countryCode?: string;
    styleHint?: string;
    iconHint?: string;
    license: {
      name: string;
      attribution: string;
      url?: string;
    };
    affectedAreas?: string[];
    geocodes?: Array<{ scheme: string; value: string }>;
    metrics?: Record<string, number | string | boolean>;
    tags?: Record<string, string>;
    localized?: Record<string, Record<string, unknown>>;
    providerProperties?: Record<string, unknown>;
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

export type TakLayerId = "ground" | "mobile" | "traffic";
export type TakAffiliation = "friend" | "hostile" | "neutral" | "unknown";

export interface TakGatewayHealth {
  status: string;
  timestamp?: string;
  ingestAuthConfigured: boolean;
  readAuthConfigured: boolean;
  publicRead: boolean;
  currentEvents: number;
  staleEvents: number;
  lastIngestAt?: string;
}

export interface TakGatewayLayer {
  layerId: TakLayerId;
  label: string;
  description: string;
  defaultVisible: boolean;
  geometryTypes: Array<"Point">;
  expectedCadenceSeconds?: number;
}

export interface TakGatewaySource {
  sourceId: "tak_gateway";
  label: string;
  enabled: boolean;
  mode: "live" | "mock" | "reference";
  priority: number;
  layers: TakLayerId[];
  license: {
    name: string;
    attribution: string;
    commercialUse: "requires_license" | "unknown";
    operationalUse: "requires_license" | "unknown";
    notes: string[];
  };
  updateCadenceSeconds?: number;
}

export interface TakGatewayConfig {
  defaultBbox: {
    west: number;
    south: number;
    east: number;
    north: number;
  };
  staleAfterSeconds: number;
  retentionSeconds: number;
  maxEvents: number;
  exposeRaw: boolean;
  ingestAuthConfigured: boolean;
  readAuthConfigured: boolean;
  publicRead: boolean;
  sourceLabel: string;
}

export interface CacheObservability {
  entries: number;
  inflight: number;
  maxEntries: number;
  pressure: number;
  hits: number;
  misses: number;
  hitRate: number;
  coalescedHits: number;
  staleHits: number;
  refreshes: number;
  errors: number;
  evictions: number;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  state: "cold" | "warm" | "pressure" | "degraded" | string;
}

export interface DataFreshnessObservability {
  sourceCount: number;
  sourcesWithImportAge: number;
  newestImportAgeSeconds: number;
  oldestImportAgeSeconds: number;
  degradedSourceCount: number;
  warningCount: number;
}

export interface SourceCacheObservability {
  sourceId: string;
  cache: CacheObservability;
}

export interface SharedCacheObservability {
  enabled: boolean;
  available: boolean;
  hits: number;
  misses: number;
  hitRate: number;
  staleHits: number;
  writes: number;
  errors: number;
  state: "ok" | "degraded" | "disabled" | string;
}

export interface SourceHealthObservability {
  sourceId: string;
  status: string;
  backend?: string;
  objectCount?: number;
  lastImportAt?: string;
  lastImportAgeSeconds?: number;
  boundaryFeatureCount?: number;
  boundaryLevels?: string[];
  boundaryLastImportAt?: string;
  boundaryLastImportAgeSeconds?: number;
  warningCount: number;
}

export interface TakEventStoreObservability {
  currentEvents: number;
  staleEvents: number;
  acceptedEvents: number;
  invalidEvents: number;
  droppedEvents: number;
  authFailures: number;
  parseErrors: number;
  lastIngestAt?: string;
  lastErrorAt?: string;
  staleRate: number;
  errorCount: number;
}

export interface ServiceObservability {
  serviceId: string;
  generatedAt: string;
  status: string;
  cache?: CacheObservability;
  sharedCache?: SharedCacheObservability;
  sourceCaches?: SourceCacheObservability[];
  referenceCaches?: SourceCacheObservability[];
  dataFreshness?: DataFreshnessObservability;
  environmentGrid?: Record<string, unknown>;
  boundaryReadModel?: Record<string, unknown>;
  sourceHealth?: SourceHealthObservability[];
  eventStore?: TakEventStoreObservability;
  lastResult?: {
    generatedAt?: string;
    generatedAgeSeconds: number;
    featureCount: number;
    sourceCount: number;
    staleFeatureCount: number;
    advisoryCount?: number;
    warningCount: number;
    criticalCount?: number;
    responseWarningCount?: number;
    layerCounts?: Partial<Record<SafetyLayerId, number>>;
    sourceIds?: string[];
    layers?: string[];
  };
}

export interface TimedServiceObservability {
  latencyMs: number;
  payload: ServiceObservability;
}

export interface DashboardObservability {
  generatedAt: string;
  loadDurationMs: number;
  flightData: TimedServiceObservability;
  situationData: TimedServiceObservability;
  safetyData: TimedServiceObservability;
  takGateway: TimedServiceObservability;
}

export type OperationsSummaryStatus = "ok" | "degraded" | "critical" | "unknown";
export type OperationsAlertSeverity = "info" | "warning" | "critical";
export type OperationsAlertCategory = "technical" | "data_quality" | "simulation" | "operational_check";

export interface LocalizedOperatorMessage {
  action?: {
    cs: string;
    en: string;
  };
  detail: {
    cs: string;
    en: string;
  };
  impact?: {
    cs: string;
    en: string;
  };
  title: {
    cs: string;
    en: string;
  };
}

export interface OperationsQualityWarning {
  action: string;
  code: string;
  detail: string;
  impact: string;
  localized: LocalizedOperatorMessage;
  messages: string[];
  sourceId: string;
  title: string;
  warningCount: number;
}

export interface OperationsSummaryService {
  cache?: {
    entries?: number;
    errors?: number;
    hitRate?: number;
    lastErrorAt?: string;
    lastSuccessAt?: string;
    misses?: number;
    pressure?: number;
    state?: string;
    staleHits?: number;
  };
  dataFreshness?: {
    degradedSourceCount?: number;
    newestImportAgeSeconds?: number;
    oldestImportAgeSeconds?: number;
    sourceCount?: number;
    warningCount?: number;
  };
  enabledSources: string[];
  healthStatus?: string;
  label: string;
  latencyMs: number;
  objectCount?: number;
  serviceId: string;
  sharedCache?: {
    available?: boolean;
    enabled?: boolean;
    errors?: number;
    hitRate?: number;
    state?: string;
  };
  status: OperationsSummaryStatus;
  qualityWarningCount: number;
  qualityWarnings: OperationsQualityWarning[];
  warningCount: number;
  warnings: string[];
}

export interface OperationsSummaryAlert {
  action?: string;
  category: OperationsAlertCategory;
  code: string;
  detail: string;
  impact?: string;
  localized: LocalizedOperatorMessage;
  serviceId?: string;
  severity: OperationsAlertSeverity;
  title: string;
}

export interface OperationsSummary {
  alerts: OperationsSummaryAlert[];
  contractVersion: "sim-operations-summary-v1";
  deployment: {
    adapterVersion: string;
    publisherMode: "DRY_RUN" | "MOCK" | "LIVE";
    sourceSystemId: string;
  };
  generatedAt: string;
  operationalCheck?: {
    finishedAt?: string;
    status?: string;
    summary?: string;
  };
  publisher: PublisherStatus;
  runtime: RuntimeStatus;
  scenarios: {
    active: number;
    draft: number;
    paused: number;
    ready: number;
    running: number;
    stopped: number;
    total: number;
  };
  services: OperationsSummaryService[];
  status: OperationsSummaryStatus;
}

export interface TakGatewayFeature {
  type: "Feature";
  id: string;
  geometry: {
    type: "Point";
    coordinates: [number, number];
  };
  properties: {
    featureId: string;
    layer: TakLayerId;
    category: string;
    label: string;
    description?: string;
    sourceId: "tak_gateway";
    observedAt: string;
    receivedAt: string;
    validUntil?: string;
    confidence: number;
    stale: boolean;
    affiliation: TakAffiliation;
    license: {
      name: string;
      attribution: string;
    };
    metrics?: Record<string, number | string | boolean>;
    tags?: Record<string, string>;
  };
}

export interface TakGatewayFeatureResponse {
  contractVersion: "cop-tak-source-v1";
  type: "FeatureCollection";
  generatedAt: string;
  source: {
    sourceId: string;
    sourceType: "TAK_COT_GATEWAY";
    generatedAt: string;
  };
  query: {
    bbox: {
      west: number;
      south: number;
      east: number;
      north: number;
    };
    layers: TakLayerId[];
    limit: number;
  };
  summary: {
    eventCount: number;
    featureCount: number;
    sourceCount: number;
    staleFeatureCount: number;
    warningCount: number;
    affiliationCounts: Record<TakAffiliation, number>;
  };
  features: TakGatewayFeature[];
  sources: TakGatewaySource[];
  warnings: string[];
}
