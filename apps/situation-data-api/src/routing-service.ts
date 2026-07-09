import { Pool } from "pg";
import { createHash } from "node:crypto";
import type { SituationDataConfig } from "./config.js";
import { DemElevationSampler, type DemTileRef } from "./dem-elevation-sampler.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import {
  createSituationDataSources,
  fetchRoadSrtiLodEvents,
  roadSrtiCategory,
  roadSrtiLabel,
  roadSrtiSeverity,
  type RoadSrtiLodEvent,
  type SituationDataSource
} from "./sources.js";
import type {
  BoundingBox,
  LineStringGeometry,
  PointGeometry,
  PolygonGeometry,
  SituationDataSourceId,
  SituationFeature,
  SituationLayerId,
  SituationSeverity
} from "./types.js";

export type RoutingProfileId = "car" | "emergency_vehicle" | "large_emergency_vehicle" | "offroad_4x4" | "walking" | "evacuation_walking";

export type RoutingAvoid = "flood" | "fire" | "road_closure" | "unpaved" | "tunnel" | "bridge";
export type RoutingQualityMode = "engine_route" | "osm_graph" | "direct_fallback";

export interface RoutingProfile {
  profileId: RoutingProfileId;
  label: string;
  labelLocalized: Record<"cs" | "en", string>;
  transportMode: "road" | "walk" | "offroad";
  descriptionLocalized: Record<"cs" | "en", string>;
  defaultSpeedKph: number;
  maxSearchRadiusM: number;
  supportsAvoid: RoutingAvoid[];
  notes: string[];
}

export interface RoutingProfileCatalog {
  contractVersion: "sim-routing-profile-catalog-v1";
  generatedAt: string;
  profiles: RoutingProfile[];
  backend: RoutingBackendStatus;
  warnings: string[];
}

export interface RoutingCoordinate {
  lon: number;
  lat: number;
  label?: string;
}

export interface RoutingRouteRequest {
  profileId?: RoutingProfileId;
  from?: RoutingCoordinate;
  to?: RoutingCoordinate;
  avoid?: RoutingAvoid[];
  departureTime?: string;
  alternatives?: number;
  includeSteps?: boolean;
  includeElevationProfile?: boolean;
  includeWeatherOnRoute?: boolean;
  includeHazardsOnRoute?: boolean;
  includeTraffic?: boolean;
  includeDebug?: boolean;
}

export interface RoutingAlternativesRequest extends RoutingRouteRequest {
  alternatives?: number;
}

export interface RoutingIsochroneRequest {
  profileId?: RoutingProfileId;
  origin?: RoutingCoordinate;
  maxTravelTimeMinutes?: number;
  maxDistanceM?: number;
  avoid?: RoutingAvoid[];
  includeDebug?: boolean;
}

export interface RoutingNearestAccessRequest {
  profileId?: RoutingProfileId;
  point?: RoutingCoordinate;
  radiusM?: number;
  includeDebug?: boolean;
}

export interface RoutingFeature {
  type: "Feature";
  id: string;
  geometry: PointGeometry | LineStringGeometry | PolygonGeometry;
  properties: Record<string, unknown>;
}

export interface RoutingRoute {
  routeId: string;
  profileId: RoutingProfileId;
  rank: number;
  status: "ok" | "partial" | "unavailable";
  geometry: LineStringGeometry;
  distanceM: number;
  durationSeconds: number;
  ascentM?: number;
  descentM?: number;
  snap: {
    fromDistanceM: number;
    toDistanceM: number;
    from: RoutingCoordinate;
    to: RoutingCoordinate;
  };
  steps: RoutingStep[];
  warnings: string[];
  traffic: RoutingRouteTraffic;
  quality: RoutingRouteQuality;
  elevation?: RoutingElevationSummary;
  elevationProfile?: RoutingElevationProfilePoint[];
  weatherOnRoute?: RoutingWeatherOnRoute;
  hazardsOnRoute?: RoutingHazardsOnRoute;
}

export type RoutingTrafficAction = "warn" | "soft_penalty" | "hard_exclusion_candidate" | "hard_exclusion_applied";

export interface RoutingTrafficIncident {
  incidentId: string;
  sourceId: "road_srti_lod";
  category: string;
  severity: SituationSeverity;
  label: string;
  lon: number;
  lat: number;
  observedAt: string;
  validUntil: string;
  distanceFromRouteM: number;
  distanceAlongRouteM: number;
  action: RoutingTrafficAction;
  confidence: number;
  srtiType?: string;
  srtiTypeUri?: string;
}

export interface RoutingRouteTraffic {
  trafficAware: boolean;
  sourceStatus: RoutingTrafficSummary["sourceStatus"];
  incidentCount: number;
  highestSeverity?: SituationSeverity;
  delayPenaltySeconds: number;
  hardExclusionCandidateCount: number;
  hardExclusionApplied: boolean;
  hard_exclusion_applied: boolean;
  softPenaltyCandidateCount: number;
  incidentsOnRoute: RoutingTrafficIncident[];
  warnings: string[];
  limitations: string[];
}

export type RoutingAnalysisSourceStatus = "ok" | "disabled" | "degraded";

export interface RoutingElevationSummary {
  sourceStatus: RoutingAnalysisSourceStatus;
  sourceId?: "valhalla" | "dem";
  gainM?: number;
  lossM?: number;
  minM?: number;
  maxM?: number;
  sampleCount: number;
  warnings: string[];
}

export interface RoutingElevationProfilePoint {
  distanceM: number;
  lon: number;
  lat: number;
  elevationM: number;
  gradePct?: number;
  sourceId?: "valhalla" | "dem";
  tileId?: string;
}

export interface RoutingWeatherOnRoute {
  sourceStatus: RoutingAnalysisSourceStatus;
  summary: string;
  warnings: string[];
  sourceIds: SituationDataSourceId[];
  segments: RoutingWeatherRouteSegment[];
}

export interface RoutingWeatherRouteSegment {
  sourceId: SituationDataSourceId;
  featureId: string;
  label: string;
  severity: SituationSeverity;
  lon: number;
  lat: number;
  routeDistanceM: number;
  distanceFromRouteM: number;
  segmentStartM: number;
  segmentEndM: number;
  observedAt: string;
  validUntil?: string;
  metrics: Record<string, number | string | boolean>;
}

export interface RoutingHazardsOnRoute {
  sourceStatus: RoutingAnalysisSourceStatus;
  summary: string;
  warnings: string[];
  sourceIds: SituationDataSourceId[];
  items: RoutingHazardRouteItem[];
}

export interface RoutingHazardRouteItem {
  hazardId: string;
  sourceId: SituationDataSourceId;
  layer: SituationLayerId | "traffic";
  category: string;
  hazardType?: string;
  label: string;
  severity: SituationSeverity;
  lon: number;
  lat: number;
  routeDistanceM: number;
  distanceFromRouteM: number;
  segmentStartM: number;
  segmentEndM: number;
  observedAt: string;
  validUntil?: string;
  confidence: number;
}

export interface RoutingRouteQuality {
  mode: RoutingQualityMode;
  confidence: number;
  graphEdgesScanned: number;
  graphEdgesUsed: number;
  routingModelVersion: string;
  engine?: "valhalla" | "osm-postgis-graph";
  fallbackReason?: string;
}

export interface RoutingStep {
  index: number;
  instructionLocalized: Record<"cs" | "en", string>;
  distanceM: number;
  durationSeconds: number;
  roadName?: string;
  roadRef?: string;
  highway?: string;
  geometry: LineStringGeometry;
}

export interface RoutingRouteResponse {
  contractVersion: "sim-routing-route-v1";
  generatedAt: string;
  source: RoutingSource;
  query: Record<string, unknown>;
  profile: RoutingProfile;
  traffic: RoutingTrafficSummary;
  quality: RoutingRouteQuality;
  routes: RoutingRoute[];
  features: RoutingFeature[];
  warnings: string[];
}

export interface RoutingTrafficSummary {
  trafficAware: boolean;
  sourceIds: Array<"road_srti_lod">;
  sourceStatus: "ok" | "disabled" | "degraded";
  corridorRadiusM: number;
  candidateCount: number;
  incidentCount: number;
  hardExclusionCandidateCount: number;
  hardExclusionAppliedCount: number;
  hardExclusionApplied: boolean;
  hard_exclusion_applied: boolean;
  softPenaltyCandidateCount: number;
  delayPenaltySeconds: number;
  highestSeverity?: SituationSeverity;
  warnings: string[];
  limitations: string[];
}

export interface RoutingIsochroneResponse {
  contractVersion: "sim-routing-isochrone-v1";
  generatedAt: string;
  source: RoutingSource;
  query: Record<string, unknown>;
  profile: RoutingProfile;
  summary: {
    maxTravelTimeMinutes: number;
    maxDistanceM?: number;
    reachedNodeCount: number;
    areaKm2?: number;
  };
  features: RoutingFeature[];
  warnings: string[];
}

export interface RoutingNearestAccessResponse {
  contractVersion: "sim-routing-nearest-access-v1";
  generatedAt: string;
  source: RoutingSource;
  query: Record<string, unknown>;
  profile: RoutingProfile;
  accessPoint?: {
    lon: number;
    lat: number;
    distanceM: number;
    osmId?: number;
    roadName?: string;
    roadRef?: string;
    highway?: string;
  };
  features: RoutingFeature[];
  warnings: string[];
}

export interface RoutingCacheStats extends ManagedResponseCacheStats {
  operation: "route" | "isochrone" | "nearest_access";
}

export interface RoutingBackendHealth {
  status: "ok" | "degraded" | "disabled";
  backend: "valhalla" | "osm-postgis-graph" | "unconfigured";
  configuredEngine: "auto" | "valhalla" | "osm_postgis";
  valhallaConfigured: boolean;
  osmPostgisConfigured: boolean;
  valhallaBaseUrl?: string;
  valhallaVersion?: string;
  valhallaActions?: string[];
  warnings: string[];
}

type RoutingOperationBackend = "valhalla" | "osm-postgis-graph" | "unconfigured";

export class RoutingError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

interface RoutingSource {
  sourceId: "routing_model";
  sourceType: "MODELLED_ROUTING";
  generatedAt: string;
  backend: "valhalla" | "osm-postgis-graph";
}

interface RoutingBackendStatus {
  enabled: boolean;
  backend: "valhalla" | "osm-postgis-graph" | "unconfigured";
  configuredEngine: "auto" | "valhalla" | "osm_postgis";
  valhallaConfigured: boolean;
  osmPostgisConfigured: boolean;
  valhallaBaseUrl?: string;
  operationBackends: {
    route: RoutingOperationBackend;
    alternatives: RoutingOperationBackend;
    isochrone: RoutingOperationBackend;
    nearestAccess: RoutingOperationBackend;
  };
  graphTable: string;
  maxGraphEdges: number;
  cacheTtlSeconds: number;
  limitations: string[];
}

interface RoadEdgeRow {
  osm_id: string | number;
  highway: string | null;
  name: string | null;
  ref: string | null;
  access: string | null;
  motorcar: string | null;
  foot: string | null;
  bicycle: string | null;
  surface: string | null;
  tracktype: string | null;
  oneway: string | null;
  bridge: string | null;
  tunnel: string | null;
  geom: unknown;
}

interface RoadGeometry {
  type: "LineString" | "MultiLineString";
  coordinates: Array<[number, number]> | Array<Array<[number, number]>>;
}

interface GraphEdge {
  id: string;
  from: string;
  to: string;
  fromCoord: [number, number];
  toCoord: [number, number];
  distanceM: number;
  durationSeconds: number;
  highway?: string;
  roadName?: string;
  roadRef?: string;
  osmId?: number;
  tags: {
    surface?: string;
    tracktype?: string;
    bridge?: string;
    tunnel?: string;
    access?: string;
  };
}

interface RoadGraph {
  bbox: BoundingBox;
  nodeCoords: Map<string, [number, number]>;
  adjacency: Map<string, GraphEdge[]>;
  edgeCount: number;
  warnings: string[];
}

interface PathResult {
  nodeIds: string[];
  edges: GraphEdge[];
  distanceM: number;
  durationSeconds: number;
}

interface SnapResult {
  nodeId: string;
  coordinate: [number, number];
  distanceM: number;
}

interface RoutingTrafficEvent {
  incidentId: string;
  category: string;
  severity: SituationSeverity;
  label: string;
  lon: number;
  lat: number;
  observedAt: string;
  validUntil: string;
  confidence: number;
  srtiType?: string;
  srtiTypeUri?: string;
}

interface RoutingTrafficContext {
  sourceStatus: RoutingTrafficSummary["sourceStatus"];
  events: RoutingTrafficEvent[];
  hardExclusionCandidates: RoutingTrafficEvent[];
  hardExclusionsApplied: RoutingTrafficEvent[];
  warnings: string[];
}

interface RoutingFeatureAnalysisContext {
  sourceStatus: RoutingAnalysisSourceStatus;
  sourceIds: SituationDataSourceId[];
  features: SituationFeature[];
  warnings: string[];
}

interface DijkstraState {
  nodeId: string;
  cost: number;
}

interface ValhallaRouteResponse {
  trip?: {
    status?: number;
    status_message?: string;
    summary?: {
      time?: number;
      length?: number;
    };
    locations?: Array<Record<string, unknown>>;
    legs?: ValhallaLeg[];
    warnings?: Array<{ text?: string; code?: number } | string>;
  };
  alternates?: Array<{ trip?: ValhallaRouteResponse["trip"] }>;
  error?: string;
  error_code?: number;
  status?: number;
  status_message?: string;
}

interface ValhallaIsochroneResponse {
  type?: "FeatureCollection";
  features?: ValhallaGeoJsonFeature[];
  warnings?: Array<{ text?: string; code?: number } | string>;
  error?: string;
  error_code?: number;
  status?: number;
  status_message?: string;
}

interface ValhallaGeoJsonFeature {
  type?: "Feature";
  geometry?: {
    type?: "Polygon" | "MultiPolygon" | "LineString" | string;
    coordinates?: unknown;
  };
  properties?: Record<string, unknown>;
}

interface ValhallaLocateLocation {
  input_lat?: number;
  input_lon?: number;
  edges?: ValhallaLocateEdge[];
  warnings?: Array<{ text?: string; code?: number } | string>;
}

interface ValhallaLocateEdge {
  correlated_lat?: number;
  correlated_lon?: number;
  distance?: number;
  way_id?: number;
  names?: string[];
  use?: string;
  road_class?: string;
  edge_info?: {
    way_id?: number;
    names?: string[];
    shape?: string;
    speed_limit?: number;
  };
}

interface ValhallaStatusResponse {
  version?: string;
  available_actions?: string[];
  error?: string;
  status_message?: string;
}

interface ValhallaLeg {
  shape?: string;
  elevation?: number[];
  elevation_interval?: number;
  summary?: {
    time?: number;
    length?: number;
  };
  maneuvers?: ValhallaManeuver[];
}

interface ValhallaManeuver {
  instruction?: string;
  length?: number;
  time?: number;
  begin_shape_index?: number;
  end_shape_index?: number;
  street_names?: string[];
  begin_street_names?: string[];
  travel_mode?: string;
  travel_type?: string;
}

interface ValhallaRouteRequestOptions {
  alternates?: number;
  linearCostFactors?: ValhallaLinearCostFactor[];
}

interface ValhallaLinearCostFactor {
  coordinates: Array<[number, number]>;
  factor: number;
}

const ROUTING_MODEL_VERSION = "osm-postgis-graph-v1";
const VALHALLA_ROUTING_MODEL_VERSION = "valhalla-v1";
const TRAFFIC_ROUTE_CORRIDOR_RADIUS_M = 350;
const TRAFFIC_PRE_ROUTE_CORRIDOR_RADIUS_M = 800;
const MAX_VALHALLA_EXCLUDE_LOCATIONS = 25;
const VALHALLA_ALTERNATIVE_LINEAR_COST_FACTORS = [2, 5, 10];
const ROUTE_ELEVATION_SAMPLE_INTERVAL_M = 250;
const ROUTE_ELEVATION_MAX_SAMPLES = 120;
const ROUTE_ANALYSIS_BBOX_PADDING_M = 2_000;
const WEATHER_ROUTE_CORRIDOR_RADIUS_M = 25_000;
const HAZARD_ROUTE_CORRIDOR_RADIUS_M = 1_000;
const ROUTE_ANALYSIS_SEGMENT_HALF_LENGTH_M = 500;
const ROUTE_ANALYSIS_SOURCE_IDS = new Set<SituationDataSourceId>(["weather_forecast", "open_meteo", "chmi_weather_stations", "safety_data"]);

const ROUTING_PROFILES: RoutingProfile[] = [
  {
    profileId: "car",
    label: "Car",
    labelLocalized: { cs: "Osobní vozidlo", en: "Car" },
    transportMode: "road",
    descriptionLocalized: {
      cs: "Běžná silniční trasa pro osobní vozidlo.",
      en: "Standard road route for a passenger car."
    },
    defaultSpeedKph: 55,
    maxSearchRadiusM: 120_000,
    supportsAvoid: ["flood", "fire", "road_closure", "unpaved", "tunnel", "bridge"],
    notes: ["Uses local OSM road geometry. It does not yet enforce live closures as hard constraints."]
  },
  {
    profileId: "emergency_vehicle",
    label: "Emergency vehicle",
    labelLocalized: { cs: "Zásahové vozidlo", en: "Emergency vehicle" },
    transportMode: "road",
    descriptionLocalized: {
      cs: "Silniční trasa pro zásahové vozidlo s vyšší tolerancí k servisním komunikacím.",
      en: "Road route for emergency response vehicles with broader service-road tolerance."
    },
    defaultSpeedKph: 65,
    maxSearchRadiusM: 160_000,
    supportsAvoid: ["flood", "fire", "road_closure", "unpaved", "tunnel", "bridge"],
    notes: ["Operational priority is modelled as speed/penalty preference only, not as permission to ignore legal closures."]
  },
  {
    profileId: "large_emergency_vehicle",
    label: "Large emergency vehicle",
    labelLocalized: { cs: "Velké zásahové vozidlo", en: "Large emergency vehicle" },
    transportMode: "road",
    descriptionLocalized: {
      cs: "Konzervativnější trasa pro velká vozidla, omezuje malé servisní a nezpevněné cesty.",
      en: "More conservative route for large vehicles, limiting minor service and unpaved roads."
    },
    defaultSpeedKph: 48,
    maxSearchRadiusM: 140_000,
    supportsAvoid: ["flood", "fire", "road_closure", "unpaved", "tunnel", "bridge"],
    notes: ["OSM height/width/weight limits are not fully normalized in this first model."]
  },
  {
    profileId: "offroad_4x4",
    label: "4x4 / field vehicle",
    labelLocalized: { cs: "Terénní vozidlo 4x4", en: "4x4 / field vehicle" },
    transportMode: "offroad",
    descriptionLocalized: {
      cs: "Trasa pro terénní vozidlo s využitím track/service cest, pokud jsou v OSM.",
      en: "Route for a field-capable vehicle using track/service roads where OSM provides them."
    },
    defaultSpeedKph: 32,
    maxSearchRadiusM: 90_000,
    supportsAvoid: ["flood", "fire", "road_closure", "tunnel", "bridge"],
    notes: ["Does not guarantee physical passability; surface, seasonal closures and private access may be incomplete."]
  },
  {
    profileId: "walking",
    label: "Walking",
    labelLocalized: { cs: "Pěší", en: "Walking" },
    transportMode: "walk",
    descriptionLocalized: {
      cs: "Pěší trasa po komunikacích a cestách dostupných v OSM.",
      en: "Walking route on roads and paths available in OSM."
    },
    defaultSpeedKph: 4.8,
    maxSearchRadiusM: 35_000,
    supportsAvoid: ["flood", "fire", "road_closure", "tunnel", "bridge"],
    notes: ["Terrain slope is not yet used as a speed penalty in this endpoint."]
  },
  {
    profileId: "evacuation_walking",
    label: "Evacuation walking",
    labelLocalized: { cs: "Evakuační pěší trasa", en: "Evacuation walking" },
    transportMode: "walk",
    descriptionLocalized: {
      cs: "Pěší evakuační trasa preferující širší a běžnější komunikace.",
      en: "Walking evacuation route preferring broader and more common roads."
    },
    defaultSpeedKph: 3.8,
    maxSearchRadiusM: 25_000,
    supportsAvoid: ["flood", "fire", "road_closure", "tunnel", "bridge"],
    notes: ["Designed for planning support; final evacuation instructions remain an operator decision."]
  }
];

const HIGHWAYS_BY_PROFILE: Record<RoutingProfileId, string[]> = {
  car: [
    "motorway",
    "motorway_link",
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "unclassified",
    "residential",
    "living_street",
    "service"
  ],
  emergency_vehicle: [
    "motorway",
    "motorway_link",
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "unclassified",
    "residential",
    "living_street",
    "service",
    "track"
  ],
  large_emergency_vehicle: [
    "motorway",
    "motorway_link",
    "trunk",
    "trunk_link",
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "unclassified",
    "residential"
  ],
  offroad_4x4: ["primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "service", "track", "path"],
  walking: ["primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "service", "track", "path", "footway", "pedestrian", "steps"],
  evacuation_walking: ["primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "service", "track", "path", "footway", "pedestrian"]
};

const BASE_SPEED_KPH_BY_HIGHWAY: Record<string, number> = {
  motorway: 100,
  motorway_link: 55,
  trunk: 85,
  trunk_link: 50,
  primary: 70,
  primary_link: 45,
  secondary: 60,
  secondary_link: 40,
  tertiary: 50,
  tertiary_link: 35,
  unclassified: 40,
  residential: 30,
  living_street: 18,
  service: 18,
  track: 16,
  path: 5,
  footway: 5,
  pedestrian: 5,
  steps: 2.5
};

export class RoutingService {
  private pool?: Pool;
  private readonly routeCache: ManagedResponseCache<RoutingRouteResponse>;
  private readonly isochroneCache: ManagedResponseCache<RoutingIsochroneResponse>;
  private readonly nearestAccessCache: ManagedResponseCache<RoutingNearestAccessResponse>;
  private readonly trafficEventCache: ManagedResponseCache<RoutingTrafficEvent[]>;
  private readonly demElevationSampler: DemElevationSampler;
  private readonly routeAnalysisSources: SituationDataSource[];

  constructor(private readonly config: SituationDataConfig) {
    this.routeCache = new ManagedResponseCache<RoutingRouteResponse>({
      ttlMs: Math.max(10, config.routingCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.routingCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: config.routingCacheMaxEntries
    });
    this.isochroneCache = new ManagedResponseCache<RoutingIsochroneResponse>({
      ttlMs: Math.max(10, config.routingCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.routingCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: config.routingCacheMaxEntries
    });
    this.nearestAccessCache = new ManagedResponseCache<RoutingNearestAccessResponse>({
      ttlMs: Math.max(10, config.routingCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.routingCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: config.routingCacheMaxEntries
    });
    this.trafficEventCache = new ManagedResponseCache<RoutingTrafficEvent[]>({
      ttlMs: Math.max(60, config.roadSrtiLodCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.roadSrtiLodCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: 1
    });
    this.demElevationSampler = new DemElevationSampler(config);
    this.routeAnalysisSources = createSituationDataSources(config).filter((source) => ROUTE_ANALYSIS_SOURCE_IDS.has(source.descriptor.sourceId));
  }

  listProfiles(): RoutingProfileCatalog {
    return {
      contractVersion: "sim-routing-profile-catalog-v1",
      generatedAt: new Date().toISOString(),
      profiles: ROUTING_PROFILES,
      backend: this.backendStatus(),
      warnings: this.backendWarnings()
    };
  }

  cacheStats(): RoutingCacheStats[] {
    return [
      { operation: "route", ...this.routeCache.stats() },
      { operation: "isochrone", ...this.isochroneCache.stats() },
      { operation: "nearest_access", ...this.nearestAccessCache.stats() }
    ];
  }

  backendSummary(): RoutingBackendHealth {
    const status = this.backendStatus();
    return {
      status: status.enabled ? "ok" : "disabled",
      backend: status.backend,
      configuredEngine: status.configuredEngine,
      valhallaConfigured: status.valhallaConfigured,
      osmPostgisConfigured: status.osmPostgisConfigured,
      valhallaBaseUrl: status.valhallaBaseUrl,
      warnings: this.backendWarnings()
    };
  }

  async healthStatus(): Promise<RoutingBackendHealth> {
    const summary = this.backendSummary();
    if (!this.shouldUseValhalla()) {
      return summary;
    }
    try {
      const response = await requestValhallaStatus(this.config);
      return {
        ...summary,
        status: "ok",
        valhallaVersion: cleanString(response.version),
        valhallaActions: Array.isArray(response.available_actions) ? response.available_actions.flatMap((action) => cleanString(action) ?? []) : []
      };
    } catch (error) {
      return {
        ...summary,
        status: "degraded",
        warnings: [...summary.warnings, error instanceof Error ? `Valhalla status failed: ${error.message}` : "Valhalla status failed."]
      };
    }
  }

  async route(raw: RoutingRouteRequest): Promise<RoutingRouteResponse> {
    const request = this.normalizeRouteRequest(raw, 1);
    return this.routeCache.getOrLoad(`route:${stablePayload(request)}`, () => this.computeRouteResponse(request));
  }

  async alternatives(raw: RoutingAlternativesRequest): Promise<RoutingRouteResponse> {
    const requestedAlternatives = integerInRange(raw.alternatives, 2, 1, 3);
    const request = this.normalizeRouteRequest(raw, requestedAlternatives);
    return this.routeCache.getOrLoad(`alternatives:${stablePayload(request)}`, () => this.computeRouteResponse(request));
  }

  async isochrone(raw: RoutingIsochroneRequest): Promise<RoutingIsochroneResponse> {
    const request = this.normalizeIsochroneRequest(raw);
    return this.isochroneCache.getOrLoad(`isochrone:${stablePayload(request)}`, () => this.computeIsochroneResponse(request));
  }

  async nearestAccess(raw: RoutingNearestAccessRequest): Promise<RoutingNearestAccessResponse> {
    const request = this.normalizeNearestAccessRequest(raw);
    return this.nearestAccessCache.getOrLoad(`nearest:${stablePayload(request)}`, () => this.computeNearestAccessResponse(request));
  }

  private async computeRouteResponse(
    request: Required<Pick<RoutingRouteRequest, "profileId" | "from" | "to" | "avoid" | "alternatives">> & RoutingRouteRequest
  ): Promise<RoutingRouteResponse> {
    const generatedAt = new Date().toISOString();
    const profile = getRoutingProfile(request.profileId);
    const warnings: string[] = [];
    const routes: RoutingRoute[] = [];
    const trafficContext = await this.routeTrafficContext(request, profile, generatedAt);
    warnings.push(...trafficContext.warnings);
    if (this.shouldUseValhalla()) {
      try {
        const valhallaResponse = await this.computeValhallaRouteResponse(generatedAt, profile, request, trafficContext);
        if (valhallaResponse.routes.length > 0) {
          return valhallaResponse;
        }
        warnings.push("Valhalla returned no route candidates; falling back to local OSM/PostGIS routing.");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Valhalla routing failed.";
        if (this.config.routingEngine === "valhalla" && !this.config.osmPostgisConnectionString) {
          warnings.push(`Valhalla routing failed: ${message}`);
          routes.push(directFallbackRoute(profile, request.from, request.to, 1, "Valhalla routing failed.", "valhalla"));
          return this.routeResponse(generatedAt, profile, request, routes, warnings, "valhalla", trafficContext);
        }
        warnings.push(`Valhalla routing failed: ${message}; falling back to local OSM/PostGIS routing.`);
      }
    }
    if (!this.config.osmPostgisConnectionString) {
      warnings.push("OSM PostGIS is not configured; returning a direct fallback line.");
      const fallback = directFallbackRoute(profile, request.from, request.to, 1, "OSM_POSTGIS_DATABASE_URL is not configured.");
      return this.routeResponse(
        generatedAt,
        profile,
        request,
        [fallback],
        warnings,
        this.shouldUseValhalla() ? "valhalla" : "osm-postgis-graph",
        trafficContext
      );
    }

    try {
      const searchBbox = routeSearchBbox(request.from, request.to, profile, this.config.routingMaxSearchRadiusM);
      const graph = await this.loadGraph(profile, searchBbox, request.avoid);
      warnings.push(...graph.warnings);
      if (graph.edgeCount === 0) {
        warnings.push("No routable OSM graph edges were found in the search area; returning a direct fallback line.");
        const fallback = directFallbackRoute(profile, request.from, request.to, 1, "No routable graph edges in search area.");
        return this.routeResponse(generatedAt, profile, request, [fallback], warnings, "osm-postgis-graph", trafficContext);
      }
      const fromSnap = nearestNode(graph, request.from);
      const toSnap = nearestNode(graph, request.to);
      if (!fromSnap || !toSnap) {
        warnings.push("Could not snap one or both route endpoints to the OSM graph; returning a direct fallback line.");
        const fallback = directFallbackRoute(profile, request.from, request.to, 1, "Endpoint snap failed.");
        return this.routeResponse(generatedAt, profile, request, [fallback], warnings, "osm-postgis-graph", trafficContext);
      }
      if (fromSnap.distanceM > this.config.routingMaxSnapDistanceM || toSnap.distanceM > this.config.routingMaxSnapDistanceM) {
        warnings.push(`Endpoint snap distance exceeds configured threshold ${this.config.routingMaxSnapDistanceM} m; route is only indicative.`);
      }

      const penalizedEdges = new Set<string>();
      const alternativeCount = Math.max(1, Math.min(3, request.alternatives));
      for (let index = 0; index < alternativeCount; index += 1) {
        const path = shortestPath(graph, fromSnap.nodeId, toSnap.nodeId, penalizedEdges, index === 0 ? 1 : 2.8 + index);
        if (!path) {
          if (routes.length === 0) {
            warnings.push("No connected route was found in the OSM graph; returning a direct fallback line.");
            routes.push(directFallbackRoute(profile, request.from, request.to, 1, "No connected path in OSM graph."));
          }
          break;
        }
        const route = buildRouteFromPath(profile, request, path, fromSnap, toSnap, index + 1, graph.edgeCount);
        routes.push(route);
        for (const edge of path.edges) {
          penalizedEdges.add(edge.id);
        }
      }
    } catch (error) {
      warnings.push(error instanceof Error ? `OSM graph routing failed: ${error.message}` : "OSM graph routing failed.");
      routes.push(directFallbackRoute(profile, request.from, request.to, 1, "OSM graph routing failed."));
    }
    return this.routeResponse(generatedAt, profile, request, routes, warnings, "osm-postgis-graph", trafficContext);
  }

  private async routeResponse(
    generatedAt: string,
    profile: RoutingProfile,
    request: unknown,
    routes: RoutingRoute[],
    warnings: string[],
    backend: "valhalla" | "osm-postgis-graph" = "osm-postgis-graph",
    trafficContext?: RoutingTrafficContext
  ): Promise<RoutingRouteResponse> {
    const trafficRoutes = rankRoutesByTrafficImpact(routes.map((route) => annotateRouteTraffic(route, trafficContext)));
    const analysisRoutes = await this.annotateRouteAnalysis(trafficRoutes, request, trafficContext);
    const primaryRoute = analysisRoutes.find((route) => route.rank === 1) ?? analysisRoutes[0];
    const traffic = routingTrafficSummary(trafficContext, analysisRoutes);
    const responseWarnings = [...warnings];
    const requestedRouteCount = requestedRouteCountFromQuery(request);
    if (requestedRouteCount && requestedRouteCount > analysisRoutes.length) {
      responseWarnings.push(
        `Routing backend returned only ${analysisRoutes.length} of ${requestedRouteCount} requested route variant(s); no sufficiently distinct alternative path was available.`
      );
    }
    return {
      contractVersion: "sim-routing-route-v1",
      generatedAt,
      source: routingSource(generatedAt, backend),
      query: publicQuery(request),
      profile,
      traffic,
      quality: primaryRoute?.quality ?? unavailableRouteQuality(backend),
      routes: analysisRoutes,
      features: analysisRoutes.map((route) => routeFeature(route)),
      warnings: responseWarnings
    };
  }

  private shouldUseValhalla(): boolean {
    return Boolean(this.config.valhallaBaseUrl && this.config.routingEngine !== "osm_postgis");
  }

  private async computeValhallaRouteResponse(
    generatedAt: string,
    profile: RoutingProfile,
    request: Required<Pick<RoutingRouteRequest, "profileId" | "from" | "to" | "avoid" | "alternatives">> & RoutingRouteRequest,
    trafficContext?: RoutingTrafficContext
  ): Promise<RoutingRouteResponse> {
    const response = await requestValhallaRoute(this.config, profile, request, trafficContext);
    const warnings = valhallaWarnings(response);
    let routes = valhallaRoutes(profile, request, response, request.alternatives);
    if (routes.length > 0 && routes.length < request.alternatives) {
      const augmented = await this.computeValhallaPenaltyAlternatives(profile, request, trafficContext, routes, request.alternatives);
      routes = augmented.routes;
      warnings.push(...augmented.warnings);
    }
    return this.routeResponse(generatedAt, profile, request, routes, warnings, "valhalla", trafficContext);
  }

  private async computeValhallaPenaltyAlternatives(
    profile: RoutingProfile,
    request: Required<Pick<RoutingRouteRequest, "profileId" | "from" | "to" | "avoid" | "alternatives">> & RoutingRouteRequest,
    trafficContext: RoutingTrafficContext | undefined,
    initialRoutes: RoutingRoute[],
    requestedRouteCount: number
  ): Promise<{ routes: RoutingRoute[]; warnings: string[] }> {
    const routes = [...initialRoutes];
    const warnings: string[] = [];
    const primaryRoute = routes.find((route) => route.rank === 1) ?? routes[0];
    if (!primaryRoute) {
      return { routes, warnings };
    }
    const seenGeometry = new Set(routes.map((route) => routeGeometryToken(route)));
    let generatedCount = 0;
    for (const factor of VALHALLA_ALTERNATIVE_LINEAR_COST_FACTORS) {
      if (routes.length >= requestedRouteCount) {
        break;
      }
      try {
        const response = await requestValhallaRoute(this.config, profile, request, trafficContext, {
          alternates: 0,
          linearCostFactors: [{ coordinates: primaryRoute.geometry.coordinates, factor }]
        });
        const candidate = response.trip ? valhallaRoute(profile, request, response.trip, routes.length + 1) : undefined;
        if (!candidate) {
          continue;
        }
        const token = routeGeometryToken(candidate);
        if (seenGeometry.has(token)) {
          continue;
        }
        seenGeometry.add(token);
        generatedCount += 1;
        routes.push({
          ...candidate,
          warnings: [...candidate.warnings, `Alternative route generated by applying Valhalla linear_cost_factors=${factor} to the primary route geometry.`],
          quality: {
            ...candidate.quality,
            confidence: Math.min(candidate.quality.confidence, 0.84)
          }
        });
      } catch {
        continue;
      }
    }
    if (generatedCount > 0) {
      warnings.push(
        `Valhalla returned fewer native alternates than requested; SIM generated ${generatedCount} additional route variant(s) by penalizing the primary route geometry.`
      );
    }
    return { routes, warnings };
  }

  private async annotateRouteAnalysis(routes: RoutingRoute[], request: unknown, trafficContext?: RoutingTrafficContext): Promise<RoutingRoute[]> {
    const options = routeAnalysisOptions(request);
    if (!options.includeElevationProfile && !options.includeWeatherOnRoute && !options.includeHazardsOnRoute) {
      return routes;
    }

    const analysisBbox = routes.length > 0 ? routesAnalysisBbox(routes) : undefined;
    const weatherContext =
      options.includeWeatherOnRoute && analysisBbox
        ? await this.loadRouteAnalysisFeatures(
            ["weather_forecast", "open_meteo", "chmi_weather_stations"],
            ["weather_forecast_area", "weather"],
            analysisBbox,
            24,
            "weather"
          )
        : undefined;
    const hazardContext =
      options.includeHazardsOnRoute && analysisBbox
        ? await this.loadRouteAnalysisFeatures(["safety_data"], ["warnings", "weather_alerts", "fire", "flood"], analysisBbox, 80, "hazards")
        : undefined;

    return Promise.all(
      routes.map(async (route) => {
        let analyzed = route;
        const routeWarnings: string[] = [];
        if (options.includeElevationProfile) {
          const elevationAnalysis = await this.routeElevationAnalysis(analyzed);
          analyzed = {
            ...analyzed,
            ascentM: elevationAnalysis.elevation.gainM ?? analyzed.ascentM,
            descentM: elevationAnalysis.elevation.lossM ?? analyzed.descentM,
            elevation: elevationAnalysis.elevation,
            elevationProfile: elevationAnalysis.profile
          };
          routeWarnings.push(...elevationAnalysis.elevation.warnings);
        }
        if (options.includeWeatherOnRoute) {
          const weatherOnRoute = routeWeatherOnRoute(analyzed, weatherContext);
          analyzed = { ...analyzed, weatherOnRoute };
          routeWarnings.push(...weatherOnRoute.warnings);
        }
        if (options.includeHazardsOnRoute) {
          const hazardsOnRoute = routeHazardsOnRoute(analyzed, hazardContext);
          analyzed = { ...analyzed, hazardsOnRoute };
          routeWarnings.push(...hazardsOnRoute.warnings);
        }
        return routeWarnings.length > 0 ? { ...analyzed, warnings: uniqueStrings([...analyzed.warnings, ...routeWarnings]) } : analyzed;
      })
    );
  }

  private async routeElevationAnalysis(route: RoutingRoute): Promise<{ elevation: RoutingElevationSummary; profile: RoutingElevationProfilePoint[] }> {
    if (route.elevationProfile && route.elevation) {
      return { elevation: route.elevation, profile: route.elevationProfile };
    }
    if (!this.config.demEnabled || !this.config.demPostgisConnectionString) {
      const warning = "Elevation profile unavailable for this route: DEM sampling is not configured and Valhalla did not return elevation values.";
      return {
        elevation: { sourceStatus: "disabled", sampleCount: 0, warnings: [warning] },
        profile: []
      };
    }
    try {
      const bbox = routeGeometryBbox(route.geometry.coordinates, ROUTE_ANALYSIS_BBOX_PADDING_M);
      const tiles = await this.demElevationSampler.tilesForBbox(bbox);
      if (tiles.length === 0) {
        const warning = "Elevation profile unavailable for this route: no local DEM tiles intersect the route corridor.";
        return {
          elevation: { sourceStatus: "degraded", sourceId: "dem", sampleCount: 0, warnings: [warning] },
          profile: []
        };
      }
      const profile = await sampleElevationProfileFromDem(route, tiles, this.demElevationSampler);
      if (profile.length === 0) {
        const warning = "Elevation profile unavailable for this route: DEM tiles did not contain usable samples.";
        return {
          elevation: { sourceStatus: "degraded", sourceId: "dem", sampleCount: 0, warnings: [warning] },
          profile: []
        };
      }
      return { elevation: elevationSummary(profile, "ok", "dem", []), profile };
    } catch (error) {
      const warning =
        error instanceof Error ? `Elevation profile unavailable for this route: ${error.message}` : "Elevation profile unavailable for this route.";
      return {
        elevation: { sourceStatus: "degraded", sourceId: "dem", sampleCount: 0, warnings: [warning] },
        profile: []
      };
    }
  }

  private async loadRouteAnalysisFeatures(
    sourceIds: SituationDataSourceId[],
    layers: SituationLayerId[],
    bbox: BoundingBox,
    limit: number,
    label: "weather" | "hazards"
  ): Promise<RoutingFeatureAnalysisContext> {
    const sources = this.routeAnalysisSources.filter((source) => sourceIds.includes(source.descriptor.sourceId));
    if (sources.length === 0) {
      return {
        sourceStatus: "disabled",
        sourceIds: [],
        features: [],
        warnings: [`${label} route analysis unavailable: no enabled SIM source is configured.`]
      };
    }
    const query = {
      bbox,
      layers,
      sourceIds,
      limit,
      includeRaw: false
    };
    const results = await Promise.allSettled(sources.map((source) => source.fetchFeatures(query)));
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<SituationDataSource["fetchFeatures"]>>> => result.status === "fulfilled"
    );
    const features = fulfilled.flatMap((result) => result.value.features).slice(0, limit);
    const warnings = [
      ...fulfilled.flatMap((result) => result.value.warnings),
      ...results.flatMap((result, index) =>
        result.status === "rejected" ? [`${sources[index]?.descriptor.sourceId ?? label} route analysis failed: ${errorMessage(result.reason)}`] : []
      )
    ];
    return {
      sourceStatus: results.some((result) => result.status === "rejected") ? "degraded" : "ok",
      sourceIds: sources.map((source) => source.descriptor.sourceId),
      features,
      warnings
    };
  }

  private async routeTrafficContext(
    request: Required<Pick<RoutingRouteRequest, "profileId" | "from" | "to" | "avoid" | "alternatives">> & RoutingRouteRequest,
    profile: RoutingProfile,
    generatedAt: string
  ): Promise<RoutingTrafficContext> {
    if (!this.config.enabledSources.includes("road_srti_lod") || profile.transportMode !== "road") {
      return emptyTrafficContext("disabled");
    }
    try {
      const searchBbox = routeSearchBbox(request.from, request.to, profile, this.config.routingMaxSearchRadiusM);
      const events = (await this.trafficEventCache.getOrLoad("road_srti_lod_recent", () => loadRoutingTrafficEvents(this.config))).filter(
        (event) => eventValidAt(event, generatedAt) && isPointInBbox(event.lon, event.lat, searchBbox)
      );
      const hardExclusionCandidates = request.avoid.includes("road_closure")
        ? events.filter(
            (event) =>
              isHardExclusionCandidate(event) &&
              distancePointToSegmentM([event.lon, event.lat], request.from, request.to).distanceM <= TRAFFIC_PRE_ROUTE_CORRIDOR_RADIUS_M
          )
        : [];
      return {
        sourceStatus: "ok",
        events,
        hardExclusionCandidates,
        hardExclusionsApplied: this.shouldUseValhalla() ? hardExclusionCandidates.slice(0, MAX_VALHALLA_EXCLUDE_LOCATIONS) : [],
        warnings: []
      };
    } catch (error) {
      return {
        ...emptyTrafficContext("degraded"),
        warnings: [error instanceof Error ? `SRTI traffic context failed: ${error.message}` : "SRTI traffic context failed."]
      };
    }
  }

  private async computeIsochroneResponse(
    request: Required<Pick<RoutingIsochroneRequest, "profileId" | "origin" | "maxTravelTimeMinutes" | "avoid">> & RoutingIsochroneRequest
  ): Promise<RoutingIsochroneResponse> {
    const generatedAt = new Date().toISOString();
    const profile = getRoutingProfile(request.profileId);
    const warnings: string[] = [];
    const maxDistanceM = request.maxDistanceM ?? (profile.defaultSpeedKph * 1000 * request.maxTravelTimeMinutes) / 60;
    if (this.shouldUseValhalla()) {
      try {
        const response = await requestValhallaIsochrone(this.config, profile, request);
        const valhallaResponse = valhallaIsochroneResponse(generatedAt, profile, request, response, maxDistanceM, valhallaWarnings(response));
        if (valhallaResponse.features.length > 0) {
          return valhallaResponse;
        }
        warnings.push("Valhalla returned no isochrone polygons; falling back to local OSM/PostGIS routing.");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Valhalla isochrone failed.";
        if (this.config.routingEngine === "valhalla" && !this.config.osmPostgisConnectionString) {
          warnings.push(`Valhalla isochrone failed: ${message}`);
          return directIsochroneResponse(generatedAt, profile, request, maxDistanceM, warnings, "valhalla");
        }
        warnings.push(`Valhalla isochrone failed: ${message}; falling back to local OSM/PostGIS routing.`);
      }
    }
    if (!this.config.osmPostgisConnectionString) {
      warnings.push("OSM PostGIS is not configured; returning circular direct-distance isochrone.");
      return directIsochroneResponse(generatedAt, profile, request, maxDistanceM, warnings, this.shouldUseValhalla() ? "valhalla" : "osm-postgis-graph");
    }
    try {
      const bbox = bboxAroundPoint(request.origin, Math.min(maxDistanceM * 1.25, profile.maxSearchRadiusM, this.config.routingMaxSearchRadiusM));
      const graph = await this.loadGraph(profile, bbox, request.avoid);
      warnings.push(...graph.warnings);
      const snap = nearestNode(graph, request.origin);
      if (!snap || graph.edgeCount === 0) {
        warnings.push("No routable OSM graph was found near the origin; returning circular direct-distance isochrone.");
        return directIsochroneResponse(generatedAt, profile, request, maxDistanceM, warnings);
      }
      const distances = shortestPathTree(graph, snap.nodeId, request.maxTravelTimeMinutes * 60);
      const reached = Array.from(distances.keys()).flatMap((nodeId) => {
        const coordinate = graph.nodeCoords.get(nodeId);
        return coordinate ? [coordinate] : [];
      });
      const polygon = radialReachPolygon(request.origin, reached, maxDistanceM);
      return {
        contractVersion: "sim-routing-isochrone-v1",
        generatedAt,
        source: routingSource(generatedAt),
        query: publicQuery(request),
        profile,
        summary: {
          maxTravelTimeMinutes: request.maxTravelTimeMinutes,
          maxDistanceM: Math.round(maxDistanceM),
          reachedNodeCount: reached.length,
          areaKm2: approximatePolygonAreaKm2(polygon.coordinates[0] ?? [])
        },
        features: [
          {
            type: "Feature",
            id: `routing:isochrone:${stablePayload(request)}`,
            geometry: polygon,
            properties: {
              profileId: profile.profileId,
              mode: "osm_graph",
              maxTravelTimeMinutes: request.maxTravelTimeMinutes,
              maxDistanceM: Math.round(maxDistanceM),
              confidence: reached.length > 2 ? 0.68 : 0.42,
              styleHint: "routing-isochrone-v1"
            }
          }
        ],
        warnings
      };
    } catch (error) {
      warnings.push(error instanceof Error ? `OSM isochrone failed: ${error.message}` : "OSM isochrone failed.");
      return directIsochroneResponse(generatedAt, profile, request, maxDistanceM, warnings);
    }
  }

  private async computeNearestAccessResponse(
    request: Required<Pick<RoutingNearestAccessRequest, "profileId" | "point" | "radiusM">> & RoutingNearestAccessRequest
  ): Promise<RoutingNearestAccessResponse> {
    const generatedAt = new Date().toISOString();
    const profile = getRoutingProfile(request.profileId);
    const warnings: string[] = [];
    if (this.shouldUseValhalla()) {
      try {
        const response = await requestValhallaLocate(this.config, profile, request);
        const valhallaResponse = valhallaNearestAccessResponse(generatedAt, profile, request, response, warnings);
        if (valhallaResponse.accessPoint) {
          return valhallaResponse;
        }
        warnings.push("Valhalla returned no routable access candidate; falling back to local OSM/PostGIS routing.");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Valhalla locate failed.";
        if (this.config.routingEngine === "valhalla" && !this.config.osmPostgisConnectionString) {
          warnings.push(`Valhalla locate failed: ${message}`);
          return emptyNearestAccessResponse(generatedAt, profile, request, warnings, "valhalla");
        }
        warnings.push(`Valhalla locate failed: ${message}; falling back to local OSM/PostGIS routing.`);
      }
    }
    if (!this.config.osmPostgisConnectionString) {
      warnings.push("OSM PostGIS is not configured; nearest access point is unavailable.");
      return emptyNearestAccessResponse(generatedAt, profile, request, warnings, this.shouldUseValhalla() ? "valhalla" : "osm-postgis-graph");
    }
    const table = quoteQualifiedIdentifier(this.config.routingOsmRoadsTable, "ROUTING_OSM_ROADS_TABLE");
    const highways = HIGHWAYS_BY_PROFILE[profile.profileId];
    const bbox = bboxAroundPoint(request.point, request.radiusM);
    const result = await this.getPool().query<{
      osm_id: string | number;
      highway: string | null;
      name: string | null;
      ref: string | null;
      lon: number | string;
      lat: number | string;
      distance_m: number | string;
    }>(
      `
        with origin as (select st_setsrid(st_makepoint($1, $2), 4326) as geom),
        candidates as (
          select osm_id, highway, name, ref, way
          from ${table}
          where highway = any($7::text[])
            and way && st_makeenvelope($3, $4, $5, $6, 4326)
            and st_dwithin(way::geography, (select geom::geography from origin), $8)
          order by way <-> (select geom from origin)
          limit 100
        )
        select
          osm_id,
          highway,
          name,
          ref,
          st_x(st_closestpoint(way, (select geom from origin))) as lon,
          st_y(st_closestpoint(way, (select geom from origin))) as lat,
          st_distance(way::geography, (select geom::geography from origin)) as distance_m
        from candidates
        order by distance_m asc
        limit 1
      `,
      [request.point.lon, request.point.lat, bbox.west, bbox.south, bbox.east, bbox.north, highways, request.radiusM]
    );
    const row = result.rows[0];
    if (!row) {
      warnings.push("No routable access geometry was found within the requested radius.");
      return emptyNearestAccessResponse(generatedAt, profile, request, warnings);
    }
    const lon = Number(row.lon);
    const lat = Number(row.lat);
    const distanceM = Number(row.distance_m);
    const accessPoint = {
      lon,
      lat,
      distanceM: Math.round(distanceM),
      osmId: optionalInteger(row.osm_id),
      roadName: cleanString(row.name),
      roadRef: cleanString(row.ref),
      highway: cleanString(row.highway)
    };
    return {
      contractVersion: "sim-routing-nearest-access-v1",
      generatedAt,
      source: routingSource(generatedAt),
      query: publicQuery(request),
      profile,
      accessPoint,
      features: [
        {
          type: "Feature",
          id: `routing:nearest-access:${stablePayload(request)}`,
          geometry: { type: "Point", coordinates: [lon, lat] },
          properties: {
            profileId: profile.profileId,
            distanceM: accessPoint.distanceM,
            highway: accessPoint.highway,
            roadName: accessPoint.roadName,
            roadRef: accessPoint.roadRef,
            styleHint: "routing-nearest-access-v1"
          }
        }
      ],
      warnings
    };
  }

  private normalizeRouteRequest(
    raw: RoutingRouteRequest,
    alternatives: number
  ): Required<Pick<RoutingRouteRequest, "profileId" | "from" | "to" | "avoid" | "alternatives">> & RoutingRouteRequest {
    const profileId = parseProfileId(raw.profileId);
    const from = parseCoordinate(raw.from, "from");
    const to = parseCoordinate(raw.to, "to");
    const distanceM = haversineMeters([from.lon, from.lat], [to.lon, to.lat]);
    const profile = getRoutingProfile(profileId);
    if (distanceM > Math.min(profile.maxSearchRadiusM, this.config.routingMaxSearchRadiusM)) {
      throw new RoutingError(400, "VALIDATION_ERROR", `Route distance ${Math.round(distanceM)} m exceeds profile/search limit.`);
    }
    return {
      ...raw,
      profileId,
      from,
      to,
      avoid: parseAvoid(raw.avoid),
      alternatives: Math.max(1, Math.min(3, alternatives))
    };
  }

  private normalizeIsochroneRequest(
    raw: RoutingIsochroneRequest
  ): Required<Pick<RoutingIsochroneRequest, "profileId" | "origin" | "maxTravelTimeMinutes" | "avoid">> & RoutingIsochroneRequest {
    const profileId = parseProfileId(raw.profileId);
    const profile = getRoutingProfile(profileId);
    const origin = parseCoordinate(raw.origin, "origin");
    const maxTravelTimeMinutes = integerInRange(raw.maxTravelTimeMinutes, 15, 1, 180);
    const maxDistanceM = raw.maxDistanceM === undefined ? undefined : positiveNumber(raw.maxDistanceM, "maxDistanceM");
    const effectiveDistance = maxDistanceM ?? (profile.defaultSpeedKph * 1000 * maxTravelTimeMinutes) / 60;
    if (effectiveDistance > Math.min(profile.maxSearchRadiusM, this.config.routingMaxSearchRadiusM)) {
      throw new RoutingError(400, "VALIDATION_ERROR", "Isochrone radius exceeds profile/search limit.");
    }
    return { ...raw, profileId, origin, maxTravelTimeMinutes, maxDistanceM, avoid: parseAvoid(raw.avoid) };
  }

  private normalizeNearestAccessRequest(
    raw: RoutingNearestAccessRequest
  ): Required<Pick<RoutingNearestAccessRequest, "profileId" | "point" | "radiusM">> & RoutingNearestAccessRequest {
    const profileId = parseProfileId(raw.profileId);
    const point = parseCoordinate(raw.point, "point");
    const radiusM = raw.radiusM === undefined ? 1500 : positiveNumber(raw.radiusM, "radiusM");
    if (radiusM > this.config.routingMaxSearchRadiusM) {
      throw new RoutingError(400, "VALIDATION_ERROR", "radiusM exceeds configured routing search limit.");
    }
    return { ...raw, profileId, point, radiusM };
  }

  private async loadGraph(profile: RoutingProfile, bbox: BoundingBox, avoid: RoutingAvoid[] = []): Promise<RoadGraph> {
    const table = quoteQualifiedIdentifier(this.config.routingOsmRoadsTable, "ROUTING_OSM_ROADS_TABLE");
    const highways = HIGHWAYS_BY_PROFILE[profile.profileId];
    const result = await this.getPool().query<RoadEdgeRow>(
      `
        select
          osm_id,
          highway,
          name,
          ref,
          access,
          motorcar,
          foot,
          bicycle,
          surface,
          tracktype,
          oneway,
          bridge,
          tunnel,
          st_asgeojson(way)::json as geom
        from ${table}
        where highway = any($5::text[])
          and way && st_makeenvelope($1, $2, $3, $4, 4326)
          and st_intersects(way, st_makeenvelope($1, $2, $3, $4, 4326))
        order by way <-> st_centroid(st_makeenvelope($1, $2, $3, $4, 4326))
        limit $6
      `,
      [bbox.west, bbox.south, bbox.east, bbox.north, highways, this.config.routingMaxGraphEdges]
    );
    const graph: RoadGraph = { bbox, nodeCoords: new Map(), adjacency: new Map(), edgeCount: 0, warnings: [] };
    if (result.rows.length >= this.config.routingMaxGraphEdges) {
      graph.warnings.push(`Routing graph reached max edge row limit ${this.config.routingMaxGraphEdges}; result can be incomplete.`);
    }
    for (const row of result.rows) {
      if (!roadAllowedForProfile(row, profile, avoid)) {
        continue;
      }
      const lineStrings = roadLineStrings(row.geom);
      for (const line of lineStrings) {
        for (let index = 1; index < line.length; index += 1) {
          const fromCoord = line[index - 1];
          const toCoord = line[index];
          if (!fromCoord || !toCoord) {
            continue;
          }
          const distanceM = haversineMeters(fromCoord, toCoord);
          if (!Number.isFinite(distanceM) || distanceM <= 0.2) {
            continue;
          }
          const oneWay = oneWayDirection(row.oneway);
          const base = buildGraphEdge(row, fromCoord, toCoord, index, distanceM, profile);
          if (oneWay !== "reverse") {
            addGraphEdge(graph, base);
          }
          if (oneWay !== "forward" || profile.transportMode === "walk") {
            addGraphEdge(graph, reverseGraphEdge(base));
          }
        }
      }
    }
    return graph;
  }

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: this.config.osmPostgisConnectionString,
        max: 4,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: this.config.requestTimeoutMs
      });
    }
    return this.pool;
  }

  private backendStatus(): RoutingBackendStatus {
    const valhallaEnabled = this.shouldUseValhalla();
    return {
      enabled: Boolean(valhallaEnabled || this.config.osmPostgisConnectionString),
      backend: valhallaEnabled ? "valhalla" : this.config.osmPostgisConnectionString ? "osm-postgis-graph" : "unconfigured",
      configuredEngine: this.config.routingEngine,
      valhallaConfigured: Boolean(this.config.valhallaBaseUrl),
      osmPostgisConfigured: Boolean(this.config.osmPostgisConnectionString),
      valhallaBaseUrl: this.config.valhallaBaseUrl,
      operationBackends: operationBackends(valhallaEnabled, Boolean(this.config.osmPostgisConnectionString)),
      graphTable: this.config.routingOsmRoadsTable,
      maxGraphEdges: this.config.routingMaxGraphEdges,
      cacheTtlSeconds: this.config.routingCacheTtlSeconds,
      limitations: [
        valhallaEnabled
          ? "Route, alternative-route, isochrone and nearest-access calculation use Valhalla when available; SIM preserves the COP routing response contract."
          : "Initial SIM routing uses a local in-process graph built from OSM road geometries.",
        valhallaEnabled
          ? "Local OSM/PostGIS remains a compatibility fallback for routing operations when configured."
          : "It does not yet use pgRouting, OSRM or Valhalla turn restrictions.",
        "Live closures and hazards are reported as avoid preferences in the contract, not hard constraints until source geometries are normalized into the graph."
      ]
    };
  }

  private backendWarnings(): string[] {
    const warnings: string[] = [];
    if (this.config.routingEngine === "valhalla" && !this.config.valhallaBaseUrl) {
      warnings.push("ROUTING_ENGINE=valhalla is configured, but VALHALLA_BASE_URL is missing.");
    }
    if (!this.shouldUseValhalla() && !this.config.osmPostgisConnectionString) {
      warnings.push("No routing backend is configured. Routing endpoints will return direct fallback geometry.");
    }
    if (this.shouldUseValhalla() && !this.config.osmPostgisConnectionString) {
      warnings.push("OSM PostGIS fallback is not configured. If Valhalla fails, route endpoints can degrade to direct fallback geometry.");
    }
    return warnings;
  }
}

function roadAllowedForProfile(row: RoadEdgeRow, profile: RoutingProfile, avoid: RoutingAvoid[]): boolean {
  const highway = cleanString(row.highway);
  if (!highway || !HIGHWAYS_BY_PROFILE[profile.profileId].includes(highway)) {
    return false;
  }
  const access = cleanString(row.access)?.toLowerCase();
  if (access && ["private", "no", "customers"].includes(access)) {
    return false;
  }
  if (profile.transportMode === "road" || profile.transportMode === "offroad") {
    const motorcar = cleanString(row.motorcar)?.toLowerCase();
    if (motorcar && ["private", "no"].includes(motorcar)) {
      return false;
    }
  }
  if (profile.transportMode === "walk") {
    const foot = cleanString(row.foot)?.toLowerCase();
    if (foot && ["private", "no"].includes(foot)) {
      return false;
    }
  }
  if (avoid.includes("unpaved") && isLikelyUnpaved(row.surface, row.tracktype)) {
    return false;
  }
  if (avoid.includes("bridge") && truthyTag(row.bridge)) {
    return false;
  }
  if (avoid.includes("tunnel") && truthyTag(row.tunnel)) {
    return false;
  }
  if (profile.profileId === "large_emergency_vehicle" && (highway === "track" || highway === "service" || isLikelyUnpaved(row.surface, row.tracktype))) {
    return false;
  }
  return true;
}

function buildGraphEdge(
  row: RoadEdgeRow,
  fromCoord: [number, number],
  toCoord: [number, number],
  segmentIndex: number,
  distanceM: number,
  profile: RoutingProfile
): GraphEdge {
  const highway = cleanString(row.highway);
  const speedKph = speedForEdge(profile, highway, cleanString(row.surface), cleanString(row.tracktype));
  const durationSeconds = (distanceM / Math.max(1, speedKph * 1000)) * 3600;
  const osmId = optionalInteger(row.osm_id);
  return {
    id: `${osmId ?? "osm"}:${segmentIndex}:${nodeKey(fromCoord)}:${nodeKey(toCoord)}`,
    from: nodeKey(fromCoord),
    to: nodeKey(toCoord),
    fromCoord,
    toCoord,
    distanceM,
    durationSeconds,
    highway,
    roadName: cleanString(row.name),
    roadRef: cleanString(row.ref),
    osmId,
    tags: {
      surface: cleanString(row.surface),
      tracktype: cleanString(row.tracktype),
      bridge: cleanString(row.bridge),
      tunnel: cleanString(row.tunnel),
      access: cleanString(row.access)
    }
  };
}

function addGraphEdge(graph: RoadGraph, edge: GraphEdge): void {
  graph.nodeCoords.set(edge.from, edge.fromCoord);
  graph.nodeCoords.set(edge.to, edge.toCoord);
  const edges = graph.adjacency.get(edge.from) ?? [];
  edges.push(edge);
  graph.adjacency.set(edge.from, edges);
  graph.edgeCount += 1;
}

function reverseGraphEdge(edge: GraphEdge): GraphEdge {
  return {
    ...edge,
    id: `${edge.id}:reverse`,
    from: edge.to,
    to: edge.from,
    fromCoord: edge.toCoord,
    toCoord: edge.fromCoord
  };
}

function roadLineStrings(value: unknown): Array<Array<[number, number]>> {
  const geometry = value as RoadGeometry | null | undefined;
  if (!geometry || !Array.isArray(geometry.coordinates)) {
    return [];
  }
  if (geometry.type === "LineString") {
    return [normalizeLineString(geometry.coordinates as Array<[number, number]>)];
  }
  if (geometry.type === "MultiLineString") {
    return (geometry.coordinates as Array<Array<[number, number]>>).map(normalizeLineString).filter((line) => line.length >= 2);
  }
  return [];
}

function normalizeLineString(coordinates: Array<[number, number]>): Array<[number, number]> {
  return coordinates
    .filter(
      (coordinate): coordinate is [number, number] =>
        Array.isArray(coordinate) && coordinate.length >= 2 && Number.isFinite(Number(coordinate[0])) && Number.isFinite(Number(coordinate[1]))
    )
    .map((coordinate) => [Number(coordinate[0]), Number(coordinate[1])]);
}

function shortestPath(graph: RoadGraph, fromNode: string, toNode: string, penalizedEdges = new Set<string>(), penaltyMultiplier = 1): PathResult | undefined {
  if (fromNode === toNode) {
    return { nodeIds: [fromNode], edges: [], distanceM: 0, durationSeconds: 0 };
  }
  const heap = new MinHeap<DijkstraState>((left, right) => left.cost - right.cost);
  const costs = new Map<string, number>([[fromNode, 0]]);
  const previous = new Map<string, { nodeId: string; edge: GraphEdge }>();
  heap.push({ nodeId: fromNode, cost: 0 });

  while (heap.size > 0) {
    const current = heap.pop();
    if (!current) {
      break;
    }
    if (current.cost > (costs.get(current.nodeId) ?? Infinity)) {
      continue;
    }
    if (current.nodeId === toNode) {
      break;
    }
    for (const edge of graph.adjacency.get(current.nodeId) ?? []) {
      const penalty = penalizedEdges.has(edge.id.replace(/:reverse$/, "")) || penalizedEdges.has(edge.id) ? penaltyMultiplier : 1;
      const edgeCost = edge.durationSeconds * penalty;
      const nextCost = current.cost + edgeCost;
      if (nextCost < (costs.get(edge.to) ?? Infinity)) {
        costs.set(edge.to, nextCost);
        previous.set(edge.to, { nodeId: current.nodeId, edge });
        heap.push({ nodeId: edge.to, cost: nextCost });
      }
    }
  }
  if (!previous.has(toNode)) {
    return undefined;
  }
  const nodeIds: string[] = [toNode];
  const edges: GraphEdge[] = [];
  let cursor = toNode;
  while (cursor !== fromNode) {
    const item = previous.get(cursor);
    if (!item) {
      return undefined;
    }
    edges.push(item.edge);
    cursor = item.nodeId;
    nodeIds.push(cursor);
  }
  edges.reverse();
  nodeIds.reverse();
  return {
    nodeIds,
    edges,
    distanceM: edges.reduce((sum, edge) => sum + edge.distanceM, 0),
    durationSeconds: edges.reduce((sum, edge) => sum + edge.durationSeconds, 0)
  };
}

function shortestPathTree(graph: RoadGraph, fromNode: string, maxCostSeconds: number): Map<string, number> {
  const heap = new MinHeap<DijkstraState>((left, right) => left.cost - right.cost);
  const costs = new Map<string, number>([[fromNode, 0]]);
  heap.push({ nodeId: fromNode, cost: 0 });
  while (heap.size > 0) {
    const current = heap.pop();
    if (!current || current.cost > maxCostSeconds) {
      continue;
    }
    if (current.cost > (costs.get(current.nodeId) ?? Infinity)) {
      continue;
    }
    for (const edge of graph.adjacency.get(current.nodeId) ?? []) {
      const nextCost = current.cost + edge.durationSeconds;
      if (nextCost <= maxCostSeconds && nextCost < (costs.get(edge.to) ?? Infinity)) {
        costs.set(edge.to, nextCost);
        heap.push({ nodeId: edge.to, cost: nextCost });
      }
    }
  }
  return costs;
}

function nearestNode(graph: RoadGraph, point: RoutingCoordinate): SnapResult | undefined {
  let best: SnapResult | undefined;
  for (const [nodeId, coordinate] of graph.nodeCoords.entries()) {
    const distanceM = haversineMeters([point.lon, point.lat], coordinate);
    if (!best || distanceM < best.distanceM) {
      best = { nodeId, coordinate, distanceM };
    }
  }
  return best;
}

function buildRouteFromPath(
  profile: RoutingProfile,
  request: Required<Pick<RoutingRouteRequest, "from" | "to">> & RoutingRouteRequest,
  path: PathResult,
  fromSnap: SnapResult,
  toSnap: SnapResult,
  rank: number,
  graphEdgesScanned: number
): RoutingRoute {
  const routeCoords = dedupeConsecutiveCoordinates([
    [request.from.lon, request.from.lat] as [number, number],
    fromSnap.coordinate,
    ...path.edges.map((edge) => edge.toCoord),
    toSnap.coordinate,
    [request.to.lon, request.to.lat] as [number, number]
  ]);
  const connectorDistanceM = fromSnap.distanceM + toSnap.distanceM;
  const totalDistanceM = path.distanceM + connectorDistanceM;
  const durationSeconds = path.durationSeconds + (connectorDistanceM / Math.max(1, profile.defaultSpeedKph * 1000)) * 3600;
  const warnings: string[] = [];
  if (connectorDistanceM > 0) {
    warnings.push("Route includes endpoint connector segments from requested coordinates to the nearest OSM graph nodes.");
  }
  return {
    routeId: `routing:${profile.profileId}:${stablePayload({ from: request.from, to: request.to, rank })}`,
    profileId: profile.profileId,
    rank,
    status: "ok",
    geometry: { type: "LineString", coordinates: routeCoords },
    distanceM: Math.round(totalDistanceM),
    durationSeconds: Math.round(durationSeconds),
    snap: {
      fromDistanceM: Math.round(fromSnap.distanceM),
      toDistanceM: Math.round(toSnap.distanceM),
      from: { lon: roundCoord(fromSnap.coordinate[0]), lat: roundCoord(fromSnap.coordinate[1]) },
      to: { lon: roundCoord(toSnap.coordinate[0]), lat: roundCoord(toSnap.coordinate[1]) }
    },
    steps: buildSteps(path),
    warnings,
    traffic: emptyRouteTraffic(),
    quality: {
      mode: "osm_graph",
      confidence: path.edges.length > 0 ? 0.74 : 0.4,
      graphEdgesScanned,
      graphEdgesUsed: path.edges.length,
      routingModelVersion: ROUTING_MODEL_VERSION,
      engine: "osm-postgis-graph"
    }
  };
}

function buildSteps(path: PathResult): RoutingStep[] {
  const groups: GraphEdge[][] = [];
  for (const edge of path.edges) {
    const current = groups[groups.length - 1];
    if (current && sameRoad(current[0]!, edge)) {
      current.push(edge);
    } else {
      groups.push([edge]);
    }
  }
  return groups.map((group, index) => {
    const first = group[0]!;
    const coordinates = dedupeConsecutiveCoordinates([first.fromCoord, ...group.map((edge) => edge.toCoord)]);
    const distanceM = group.reduce((sum, edge) => sum + edge.distanceM, 0);
    const durationSeconds = group.reduce((sum, edge) => sum + edge.durationSeconds, 0);
    const road = first.roadName ?? first.roadRef ?? first.highway ?? "road";
    return {
      index,
      instructionLocalized: {
        cs: `Pokračujte po ${road}.`,
        en: `Continue on ${road}.`
      },
      distanceM: Math.round(distanceM),
      durationSeconds: Math.round(durationSeconds),
      roadName: first.roadName,
      roadRef: first.roadRef,
      highway: first.highway,
      geometry: { type: "LineString", coordinates }
    };
  });
}

function sameRoad(left: GraphEdge, right: GraphEdge): boolean {
  return left.roadName === right.roadName && left.roadRef === right.roadRef && left.highway === right.highway;
}

function directFallbackRoute(
  profile: RoutingProfile,
  from: RoutingCoordinate,
  to: RoutingCoordinate,
  rank: number,
  reason: string,
  engine: "valhalla" | "osm-postgis-graph" = "osm-postgis-graph"
): RoutingRoute {
  const distanceM = haversineMeters([from.lon, from.lat], [to.lon, to.lat]);
  const durationSeconds = (distanceM / Math.max(1, profile.defaultSpeedKph * 1000)) * 3600;
  return {
    routeId: `routing:${profile.profileId}:direct:${stablePayload({ from, to, rank })}`,
    profileId: profile.profileId,
    rank,
    status: "partial",
    geometry: {
      type: "LineString",
      coordinates: [
        [from.lon, from.lat],
        [to.lon, to.lat]
      ]
    },
    distanceM: Math.round(distanceM),
    durationSeconds: Math.round(durationSeconds),
    snap: {
      fromDistanceM: 0,
      toDistanceM: 0,
      from,
      to
    },
    steps: [
      {
        index: 0,
        instructionLocalized: {
          cs: "Přímá spojnice bez routování po komunikacích.",
          en: "Direct connector without road-graph routing."
        },
        distanceM: Math.round(distanceM),
        durationSeconds: Math.round(durationSeconds),
        geometry: {
          type: "LineString",
          coordinates: [
            [from.lon, from.lat],
            [to.lon, to.lat]
          ]
        }
      }
    ],
    warnings: [reason],
    traffic: emptyRouteTraffic(),
    quality: {
      mode: "direct_fallback",
      confidence: 0.18,
      graphEdgesScanned: 0,
      graphEdgesUsed: 0,
      routingModelVersion: engine === "valhalla" ? VALHALLA_ROUTING_MODEL_VERSION : ROUTING_MODEL_VERSION,
      engine,
      fallbackReason: reason
    }
  };
}

function routeFeature(route: RoutingRoute): RoutingFeature {
  return {
    type: "Feature",
    id: route.routeId,
    geometry: route.geometry,
    properties: {
      profileId: route.profileId,
      rank: route.rank,
      role: route.rank === 1 ? "primary" : "alternative",
      status: route.status,
      distanceM: route.distanceM,
      durationSeconds: route.durationSeconds,
      quality: route.quality,
      traffic: route.traffic,
      warnings: route.warnings,
      styleHint: route.rank === 1 ? "routing-primary-v1" : "routing-alternative-v1"
    }
  };
}

function routeGeometryToken(route: RoutingRoute): string {
  return stablePayload(route.geometry.coordinates);
}

function requestedRouteCountFromQuery(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("alternatives" in value)) {
    return undefined;
  }
  const parsed = Number((value as { alternatives?: unknown }).alternatives);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.max(1, Math.min(3, Math.round(parsed)));
}

function unavailableRouteQuality(backend: "valhalla" | "osm-postgis-graph"): RoutingRouteQuality {
  return {
    mode: "direct_fallback",
    confidence: 0,
    graphEdgesScanned: 0,
    graphEdgesUsed: 0,
    routingModelVersion: backend === "valhalla" ? VALHALLA_ROUTING_MODEL_VERSION : ROUTING_MODEL_VERSION,
    engine: backend,
    fallbackReason: "No route candidates were returned."
  };
}

function routeAnalysisOptions(value: unknown): {
  includeElevationProfile: boolean;
  includeWeatherOnRoute: boolean;
  includeHazardsOnRoute: boolean;
} {
  const request = value && typeof value === "object" ? (value as RoutingRouteRequest) : {};
  return {
    includeElevationProfile: request.includeElevationProfile === true,
    includeWeatherOnRoute: request.includeWeatherOnRoute === true,
    includeHazardsOnRoute: request.includeHazardsOnRoute === true
  };
}

function routesAnalysisBbox(routes: RoutingRoute[]): BoundingBox {
  return expandBbox(
    routes
      .map((route) => rawRouteGeometryBbox(route.geometry.coordinates))
      .reduce(
        (bbox, next) => ({
          west: Math.min(bbox.west, next.west),
          south: Math.min(bbox.south, next.south),
          east: Math.max(bbox.east, next.east),
          north: Math.max(bbox.north, next.north)
        }),
        rawRouteGeometryBbox(
          routes[0]?.geometry.coordinates ?? [
            [0, 0],
            [0, 0]
          ]
        )
      ),
    ROUTE_ANALYSIS_BBOX_PADDING_M
  );
}

function routeGeometryBbox(coordinates: Array<[number, number]>, paddingM = 0): BoundingBox {
  return expandBbox(rawRouteGeometryBbox(coordinates), paddingM);
}

function rawRouteGeometryBbox(coordinates: Array<[number, number]>): BoundingBox {
  const lons = coordinates.map((coordinate) => coordinate[0]);
  const lats = coordinates.map((coordinate) => coordinate[1]);
  return {
    west: Math.min(...lons),
    south: Math.min(...lats),
    east: Math.max(...lons),
    north: Math.max(...lats)
  };
}

async function sampleElevationProfileFromDem(route: RoutingRoute, tiles: DemTileRef[], sampler: DemElevationSampler): Promise<RoutingElevationProfilePoint[]> {
  const samples = sampleCoordinatesAlongRoute(route.geometry.coordinates, route.distanceM, ROUTE_ELEVATION_SAMPLE_INTERVAL_M, ROUTE_ELEVATION_MAX_SAMPLES);
  const profile: RoutingElevationProfilePoint[] = [];
  for (const sample of samples) {
    const elevation = await sampler.sample(sample.lon, sample.lat, tiles);
    if (!elevation) {
      continue;
    }
    profile.push({
      distanceM: Math.round(sample.distanceM),
      lon: roundCoord(sample.lon),
      lat: roundCoord(sample.lat),
      elevationM: elevation.elevationM,
      sourceId: "dem",
      tileId: elevation.tileId
    });
  }
  return withElevationGrades(profile);
}

function valhallaElevationProfile(
  legs: ValhallaLeg[],
  routeCoordinates: Array<[number, number]>,
  routeDistanceM: number
): RoutingElevationProfilePoint[] | undefined {
  const elevations = legs.flatMap((leg) => (Array.isArray(leg.elevation) ? leg.elevation : []));
  if (elevations.length === 0 || routeCoordinates.length < 2) {
    return undefined;
  }
  const denominator = Math.max(1, elevations.length - 1);
  const profile = elevations.map((value, index) => {
    const distanceM = (routeDistanceM * index) / denominator;
    const point = interpolatePointAtDistance(routeCoordinates, distanceM) ?? {
      lon: routeCoordinates[routeCoordinates.length - 1]![0],
      lat: routeCoordinates[routeCoordinates.length - 1]![1]
    };
    return {
      distanceM: Math.round(distanceM),
      lon: roundCoord(point.lon),
      lat: roundCoord(point.lat),
      elevationM: Math.round(Number(value)),
      sourceId: "valhalla" as const
    };
  });
  return withElevationGrades(profile.filter((sample) => Number.isFinite(sample.elevationM)));
}

function sampleCoordinatesAlongRoute(
  coordinates: Array<[number, number]>,
  distanceM: number,
  intervalM: number,
  maxSamples: number
): Array<{ distanceM: number; lon: number; lat: number }> {
  if (coordinates.length < 2) {
    return [];
  }
  const sampleCount = Math.max(2, Math.min(maxSamples, Math.floor(distanceM / Math.max(1, intervalM)) + 1));
  const stepM = sampleCount > 1 ? distanceM / (sampleCount - 1) : distanceM;
  return Array.from({ length: sampleCount }, (_, index) => {
    const targetM = index === sampleCount - 1 ? distanceM : stepM * index;
    const point = interpolatePointAtDistance(coordinates, targetM);
    return {
      distanceM: targetM,
      lon: point?.lon ?? coordinates[0]![0],
      lat: point?.lat ?? coordinates[0]![1]
    };
  });
}

function interpolatePointAtDistance(coordinates: Array<[number, number]>, targetDistanceM: number): { lon: number; lat: number } | undefined {
  if (coordinates.length === 0) {
    return undefined;
  }
  if (coordinates.length === 1 || targetDistanceM <= 0) {
    return { lon: coordinates[0]![0], lat: coordinates[0]![1] };
  }
  let traversedM = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1]!;
    const end = coordinates[index]!;
    const segmentM = haversineMeters(start, end);
    if (traversedM + segmentM >= targetDistanceM) {
      const t = segmentM > 0 ? (targetDistanceM - traversedM) / segmentM : 0;
      return {
        lon: start[0] + (end[0] - start[0]) * t,
        lat: start[1] + (end[1] - start[1]) * t
      };
    }
    traversedM += segmentM;
  }
  const last = coordinates[coordinates.length - 1]!;
  return { lon: last[0], lat: last[1] };
}

function withElevationGrades(profile: RoutingElevationProfilePoint[]): RoutingElevationProfilePoint[] {
  return profile.map((sample, index) => {
    if (index === 0) {
      return { ...sample, gradePct: 0 };
    }
    const previous = profile[index - 1]!;
    const distanceDeltaM = sample.distanceM - previous.distanceM;
    const elevationDeltaM = sample.elevationM - previous.elevationM;
    return {
      ...sample,
      gradePct: distanceDeltaM > 0 ? Math.round((elevationDeltaM / distanceDeltaM) * 1000) / 10 : 0
    };
  });
}

function elevationSummary(
  profile: RoutingElevationProfilePoint[],
  sourceStatus: RoutingAnalysisSourceStatus,
  sourceId: "valhalla" | "dem",
  warnings: string[]
): RoutingElevationSummary {
  const elevations = profile.map((sample) => sample.elevationM);
  let gainM = 0;
  let lossM = 0;
  for (let index = 1; index < profile.length; index += 1) {
    const delta = profile[index]!.elevationM - profile[index - 1]!.elevationM;
    if (delta > 0) {
      gainM += delta;
    } else {
      lossM += Math.abs(delta);
    }
  }
  return {
    sourceStatus,
    sourceId,
    gainM: Math.round(gainM),
    lossM: Math.round(lossM),
    minM: elevations.length > 0 ? Math.min(...elevations) : undefined,
    maxM: elevations.length > 0 ? Math.max(...elevations) : undefined,
    sampleCount: profile.length,
    warnings
  };
}

function routeWeatherOnRoute(route: RoutingRoute, context: RoutingFeatureAnalysisContext | undefined): RoutingWeatherOnRoute {
  if (!context) {
    return { sourceStatus: "disabled", summary: "Počasí na trase nebylo požadováno.", warnings: [], sourceIds: [], segments: [] };
  }
  if (context.sourceStatus === "disabled") {
    return {
      sourceStatus: "disabled",
      summary: "Počasí na trase není dostupné.",
      warnings: context.warnings,
      sourceIds: context.sourceIds,
      segments: []
    };
  }
  const segments = context.features
    .flatMap((feature) => weatherSegmentForRoute(feature, route))
    .sort((left, right) => left.routeDistanceM - right.routeDistanceM)
    .slice(0, 20);
  return {
    sourceStatus: context.sourceStatus,
    summary: weatherRouteSummary(segments),
    warnings: context.warnings,
    sourceIds: context.sourceIds,
    segments
  };
}

function weatherSegmentForRoute(feature: SituationFeature, route: RoutingRoute): RoutingWeatherRouteSegment[] {
  const point = featureRepresentativePoint(feature);
  if (!point) {
    return [];
  }
  const match = nearestPointOnPolyline([point.lon, point.lat], route.geometry.coordinates);
  if (!match || match.distanceM > WEATHER_ROUTE_CORRIDOR_RADIUS_M) {
    return [];
  }
  return [
    {
      sourceId: feature.properties.sourceId,
      featureId: feature.id,
      label: feature.properties.label,
      severity: feature.properties.severity,
      lon: roundCoord(point.lon),
      lat: roundCoord(point.lat),
      routeDistanceM: Math.round(match.distanceAlongRouteM),
      distanceFromRouteM: Math.round(match.distanceM),
      segmentStartM: Math.max(0, Math.round(match.distanceAlongRouteM - ROUTE_ANALYSIS_SEGMENT_HALF_LENGTH_M)),
      segmentEndM: Math.min(route.distanceM, Math.round(match.distanceAlongRouteM + ROUTE_ANALYSIS_SEGMENT_HALF_LENGTH_M)),
      observedAt: feature.properties.observedAt,
      validUntil: feature.properties.validUntil,
      metrics: routeWeatherMetrics(feature.properties.metrics)
    }
  ];
}

function routeWeatherMetrics(metrics: Record<string, number | string | boolean> | undefined): Record<string, number | string | boolean> {
  if (!metrics) {
    return {};
  }
  const keys = [
    "temperatureC",
    "relativeHumidityPercent",
    "precipitationMm",
    "precipitationNext1hMm",
    "precipitationNext3hMm",
    "precipitationProbabilityNext1hPercent",
    "precipitationProbabilityNext3hPercent",
    "windSpeedMps",
    "windGustMps",
    "windDirectionDeg",
    "cloudCoverPercent",
    "riskScore"
  ];
  return Object.fromEntries(keys.flatMap((key) => (metrics[key] === undefined ? [] : [[key, metrics[key]!] as const])));
}

function weatherRouteSummary(segments: RoutingWeatherRouteSegment[]): string {
  if (segments.length === 0) {
    return "Bez dostupných meteorologických segmentů v koridoru trasy.";
  }
  const maxPrecipitation = Math.max(0, ...segments.map((segment) => Number(segment.metrics.precipitationNext3hMm ?? segment.metrics.precipitationMm ?? 0)));
  const maxWind = Math.max(0, ...segments.map((segment) => Number(segment.metrics.windGustMps ?? segment.metrics.windSpeedMps ?? 0)));
  const severeCount = segments.filter((segment) => segment.severity === "warning" || segment.severity === "critical").length;
  const parts: string[] = [];
  if (maxPrecipitation >= 0.2) {
    parts.push(maxPrecipitation >= 5 ? "výrazné srážky na části trasy" : "srážky na části trasy");
  }
  if (maxWind > 0) {
    parts.push(`vítr do ${Math.round(maxWind)} m/s`);
  }
  if (severeCount > 0) {
    parts.push(`${severeCount} meteorologické výstražné segmenty`);
  }
  return parts.length > 0 ? capitalizeSentence(parts.join(", ")) : "Bez výrazných meteorologických rizik na trase.";
}

function routeHazardsOnRoute(route: RoutingRoute, context: RoutingFeatureAnalysisContext | undefined): RoutingHazardsOnRoute {
  if (!context) {
    return { sourceStatus: "disabled", summary: "Bez požadované bezpečnostní analýzy trasy.", warnings: [], sourceIds: [], items: [] };
  }
  const safetyItems =
    context.sourceStatus === "disabled"
      ? []
      : context.features
          .flatMap((feature) => hazardItemForRoute(feature, route))
          .sort((left, right) => left.routeDistanceM - right.routeDistanceM)
          .slice(0, 30);
  const trafficItems = route.traffic.incidentsOnRoute.map((incident) => trafficIncidentHazardItem(incident, route));
  const items = [...safetyItems, ...trafficItems].sort((left, right) => left.routeDistanceM - right.routeDistanceM).slice(0, 40);
  const warnings = context.sourceStatus === "disabled" ? context.warnings : context.warnings;
  return {
    sourceStatus: context.sourceStatus,
    summary: hazardRouteSummary(items),
    warnings,
    sourceIds: uniqueSourceIds([...context.sourceIds, ...(trafficItems.length > 0 ? ["road_srti_lod" as SituationDataSourceId] : [])]),
    items
  };
}

function hazardItemForRoute(feature: SituationFeature, route: RoutingRoute): RoutingHazardRouteItem[] {
  const point = featureRepresentativePoint(feature);
  if (!point) {
    return [];
  }
  const match = nearestPointOnPolyline([point.lon, point.lat], route.geometry.coordinates);
  if (!match || match.distanceM > HAZARD_ROUTE_CORRIDOR_RADIUS_M) {
    return [];
  }
  return [
    {
      hazardId: feature.id,
      sourceId: feature.properties.sourceId,
      layer: feature.properties.layer,
      category: feature.properties.category,
      hazardType: feature.properties.hazardType,
      label: feature.properties.label,
      severity: feature.properties.severity,
      lon: roundCoord(point.lon),
      lat: roundCoord(point.lat),
      routeDistanceM: Math.round(match.distanceAlongRouteM),
      distanceFromRouteM: Math.round(match.distanceM),
      segmentStartM: Math.max(0, Math.round(match.distanceAlongRouteM - ROUTE_ANALYSIS_SEGMENT_HALF_LENGTH_M)),
      segmentEndM: Math.min(route.distanceM, Math.round(match.distanceAlongRouteM + ROUTE_ANALYSIS_SEGMENT_HALF_LENGTH_M)),
      observedAt: feature.properties.observedAt,
      validUntil: feature.properties.validUntil,
      confidence: feature.properties.confidence
    }
  ];
}

function trafficIncidentHazardItem(incident: RoutingTrafficIncident, route: RoutingRoute): RoutingHazardRouteItem {
  return {
    hazardId: incident.incidentId,
    sourceId: incident.sourceId,
    layer: "traffic",
    category: incident.category,
    hazardType: incident.srtiType,
    label: incident.label,
    severity: incident.severity,
    lon: incident.lon,
    lat: incident.lat,
    routeDistanceM: incident.distanceAlongRouteM,
    distanceFromRouteM: incident.distanceFromRouteM,
    segmentStartM: Math.max(0, incident.distanceAlongRouteM - ROUTE_ANALYSIS_SEGMENT_HALF_LENGTH_M),
    segmentEndM: Math.min(route.distanceM, incident.distanceAlongRouteM + ROUTE_ANALYSIS_SEGMENT_HALF_LENGTH_M),
    observedAt: incident.observedAt,
    validUntil: incident.validUntil,
    confidence: incident.confidence
  };
}

function hazardRouteSummary(items: RoutingHazardRouteItem[]): string {
  if (items.length === 0) {
    return "Bez zásadních bezpečnostních překážek v koridoru trasy.";
  }
  const highest = highestSeverity(items.map((item) => item.severity));
  return `${items.length} bezpečnostní položka/položek v koridoru trasy${highest ? `, nejvyšší závažnost ${highest}` : ""}.`;
}

function featureRepresentativePoint(feature: SituationFeature): { lon: number; lat: number } | undefined {
  const coordinates = flattenGeometryCoordinates(feature.geometry);
  if (coordinates.length === 0) {
    return undefined;
  }
  const lon = coordinates.reduce((sum, coordinate) => sum + coordinate[0], 0) / coordinates.length;
  const lat = coordinates.reduce((sum, coordinate) => sum + coordinate[1], 0) / coordinates.length;
  return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : undefined;
}

function flattenGeometryCoordinates(geometry: SituationFeature["geometry"]): Array<[number, number]> {
  if (geometry.type === "Point") {
    return [geometry.coordinates];
  }
  if (geometry.type === "LineString") {
    return geometry.coordinates;
  }
  if (geometry.type === "MultiLineString" || geometry.type === "Polygon") {
    return geometry.coordinates.flat();
  }
  return geometry.coordinates.flat(2);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}

function uniqueSourceIds(values: SituationDataSourceId[]): SituationDataSourceId[] {
  return Array.from(new Set(values));
}

function capitalizeSentence(value: string): string {
  return value.length === 0 ? value : `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

async function loadRoutingTrafficEvents(config: SituationDataConfig): Promise<RoutingTrafficEvent[]> {
  const events = await fetchRoadSrtiLodEvents(config);
  return events.map(routingTrafficEvent);
}

function routingTrafficEvent(event: RoadSrtiLodEvent): RoutingTrafficEvent {
  const category = roadSrtiCategory(event.typeLabel);
  return {
    incidentId: `traffic:road_srti_lod:${stablePayload(event.iri)}`,
    category,
    severity: roadSrtiSeverity(category, event.typeLabel),
    label: `Silniční událost: ${roadSrtiLabel(event.typeLabel)}`,
    lon: roundCoord(event.lon),
    lat: roundCoord(event.lat),
    observedAt: event.observedAt,
    validUntil: addIsoSeconds(event.observedAt, 2 * 60 * 60),
    confidence: 0.82,
    srtiType: event.typeLabel,
    srtiTypeUri: event.typeUri
  };
}

function annotateRouteTraffic(route: RoutingRoute, context: RoutingTrafficContext | undefined): RoutingRoute {
  if (!context || context.sourceStatus === "disabled") {
    return { ...route, traffic: emptyRouteTraffic("disabled") };
  }
  if (context.sourceStatus === "degraded") {
    return {
      ...route,
      traffic: {
        ...emptyRouteTraffic("degraded"),
        trafficAware: false,
        warnings: context.warnings
      }
    };
  }
  const incidents = context.events
    .map((event) => incidentNearRoute(event, route.geometry.coordinates, context))
    .filter((incident): incident is RoutingTrafficIncident => Boolean(incident))
    .sort((left, right) => left.distanceAlongRouteM - right.distanceAlongRouteM)
    .slice(0, 25);
  const delayPenaltySeconds = incidents.reduce((sum, incident) => sum + trafficDelayPenaltySeconds(incident), 0);
  const hardExclusionCandidateCount = incidents.filter(
    (incident) => incident.action === "hard_exclusion_candidate" || incident.action === "hard_exclusion_applied"
  ).length;
  const hardExclusionApplied = incidents.some((incident) => incident.action === "hard_exclusion_applied");
  return {
    ...route,
    durationSeconds: route.durationSeconds + delayPenaltySeconds,
    warnings:
      incidents.length > 0 ? [...route.warnings, `Route corridor contains ${incidents.length} current NDIC/ŘSD SRTI traffic event(s).`] : route.warnings,
    traffic: {
      trafficAware: true,
      sourceStatus: "ok",
      incidentCount: incidents.length,
      highestSeverity: highestSeverity(incidents.map((incident) => incident.severity)),
      delayPenaltySeconds,
      hardExclusionCandidateCount,
      hardExclusionApplied,
      hard_exclusion_applied: hardExclusionApplied,
      softPenaltyCandidateCount: incidents.filter((incident) => incident.action === "soft_penalty").length,
      incidentsOnRoute: incidents,
      warnings: context.warnings,
      limitations: routeTrafficLimitations()
    },
    quality: {
      ...route.quality,
      confidence: incidents.length > 0 ? Math.max(0.5, route.quality.confidence - Math.min(0.2, incidents.length * 0.04)) : route.quality.confidence
    }
  };
}

function incidentNearRoute(
  event: RoutingTrafficEvent,
  routeCoordinates: Array<[number, number]>,
  context: RoutingTrafficContext
): RoutingTrafficIncident | undefined {
  const match = nearestPointOnPolyline([event.lon, event.lat], routeCoordinates);
  if (!match || match.distanceM > TRAFFIC_ROUTE_CORRIDOR_RADIUS_M) {
    return undefined;
  }
  const applied = context.hardExclusionsApplied.some((candidate) => candidate.incidentId === event.incidentId);
  return {
    incidentId: event.incidentId,
    sourceId: "road_srti_lod",
    category: event.category,
    severity: event.severity,
    label: event.label,
    lon: event.lon,
    lat: event.lat,
    observedAt: event.observedAt,
    validUntil: event.validUntil,
    distanceFromRouteM: Math.round(match.distanceM),
    distanceAlongRouteM: Math.round(match.distanceAlongRouteM),
    action: applied ? "hard_exclusion_applied" : trafficAction(event),
    confidence: event.confidence,
    srtiType: event.srtiType,
    srtiTypeUri: event.srtiTypeUri
  };
}

function routingTrafficSummary(context: RoutingTrafficContext | undefined, routes: RoutingRoute[]): RoutingTrafficSummary {
  const incidents = routes.flatMap((route) => route.traffic.incidentsOnRoute);
  const uniqueIncidentIds = new Set(incidents.map((incident) => incident.incidentId));
  const primaryRoute = routes.find((route) => route.rank === 1) ?? routes[0];
  const hardExclusionApplied = Boolean(context?.hardExclusionsApplied.length) || incidents.some((incident) => incident.action === "hard_exclusion_applied");
  return {
    trafficAware: Boolean(context && context.sourceStatus === "ok"),
    sourceIds: context && context.sourceStatus !== "disabled" ? ["road_srti_lod"] : [],
    sourceStatus: context?.sourceStatus ?? "disabled",
    corridorRadiusM: TRAFFIC_ROUTE_CORRIDOR_RADIUS_M,
    candidateCount: context?.events.length ?? 0,
    incidentCount: uniqueIncidentIds.size,
    hardExclusionCandidateCount: context?.hardExclusionCandidates.length ?? 0,
    hardExclusionAppliedCount: context?.hardExclusionsApplied.length ?? 0,
    hardExclusionApplied,
    hard_exclusion_applied: hardExclusionApplied,
    softPenaltyCandidateCount: incidents.filter((incident) => incident.action === "soft_penalty").length,
    delayPenaltySeconds: primaryRoute?.traffic.delayPenaltySeconds ?? 0,
    highestSeverity: highestSeverity(incidents.map((incident) => incident.severity)),
    warnings: context?.warnings ?? [],
    limitations: [...routeTrafficLimitations()]
  };
}

function rankRoutesByTrafficImpact(routes: RoutingRoute[]): RoutingRoute[] {
  if (routes.length < 2 || routes.every((route) => route.traffic.delayPenaltySeconds === 0 && route.traffic.hardExclusionCandidateCount === 0)) {
    return routes;
  }
  return [...routes].sort((left, right) => trafficRouteScore(left) - trafficRouteScore(right)).map((route, index) => ({ ...route, rank: index + 1 }));
}

function trafficRouteScore(route: RoutingRoute): number {
  return route.durationSeconds + route.traffic.hardExclusionCandidateCount * 600;
}

function emptyRouteTraffic(sourceStatus: RoutingTrafficSummary["sourceStatus"] = "disabled"): RoutingRouteTraffic {
  return {
    trafficAware: false,
    sourceStatus,
    incidentCount: 0,
    delayPenaltySeconds: 0,
    hardExclusionCandidateCount: 0,
    hardExclusionApplied: false,
    hard_exclusion_applied: false,
    softPenaltyCandidateCount: 0,
    incidentsOnRoute: [],
    warnings: [],
    limitations: routeTrafficLimitations()
  };
}

function routeTrafficLimitations(): string[] {
  return [
    "SRTI LOD events are currently consumed as representative points; precise segment-level hard closures require DATEX II linear references or Valhalla edge mapping.",
    "Hard exclusion uses Valhalla exclude_locations only for closure-like candidates when the route request includes avoid=road_closure."
  ];
}

function emptyTrafficContext(sourceStatus: RoutingTrafficSummary["sourceStatus"]): RoutingTrafficContext {
  return {
    sourceStatus,
    events: [],
    hardExclusionCandidates: [],
    hardExclusionsApplied: [],
    warnings: []
  };
}

function valhallaTrafficAvoidancePayload(context: RoutingTrafficContext | undefined): { exclude_locations?: Array<{ lat: number; lon: number }> } {
  const events = context?.hardExclusionsApplied ?? [];
  if (events.length === 0) {
    return {};
  }
  return {
    exclude_locations: events.map((event) => ({ lat: event.lat, lon: event.lon }))
  };
}

function isHardExclusionCandidate(event: RoutingTrafficEvent): boolean {
  const normalized = `${event.category} ${event.srtiType ?? ""}`.toLowerCase();
  return normalized.includes("closure") || normalized.includes("blocked") || normalized.includes("obstruction");
}

function trafficAction(event: RoutingTrafficEvent): RoutingTrafficAction {
  if (isHardExclusionCandidate(event)) {
    return "hard_exclusion_candidate";
  }
  return event.severity === "warning" || event.severity === "advisory" ? "soft_penalty" : "warn";
}

function trafficDelayPenaltySeconds(incident: RoutingTrafficIncident): number {
  if (incident.action === "hard_exclusion_candidate" || incident.action === "hard_exclusion_applied") {
    return 180;
  }
  if (incident.action === "soft_penalty") {
    return incident.severity === "warning" ? 120 : 60;
  }
  return 0;
}

function eventValidAt(event: RoutingTrafficEvent, isoTime: string): boolean {
  const now = Date.parse(isoTime);
  const validUntil = Date.parse(event.validUntil);
  return !Number.isFinite(validUntil) || !Number.isFinite(now) || validUntil >= now;
}

function highestSeverity(values: SituationSeverity[]): SituationSeverity | undefined {
  const order: SituationSeverity[] = ["info", "advisory", "warning", "critical"];
  return values.sort((left, right) => order.indexOf(right) - order.indexOf(left))[0];
}

function nearestPointOnPolyline(point: [number, number], coordinates: Array<[number, number]>): { distanceM: number; distanceAlongRouteM: number } | undefined {
  if (coordinates.length < 2) {
    return undefined;
  }
  let best: { distanceM: number; distanceAlongRouteM: number } | undefined;
  let traversedM = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const start = coordinates[index - 1]!;
    const end = coordinates[index]!;
    const segment = distancePointToSegmentM(point, { lon: start[0], lat: start[1] }, { lon: end[0], lat: end[1] });
    if (!best || segment.distanceM < best.distanceM) {
      best = { distanceM: segment.distanceM, distanceAlongRouteM: traversedM + segment.alongSegmentM };
    }
    traversedM += haversineMeters(start, end);
  }
  return best;
}

function distancePointToSegmentM(
  point: [number, number],
  start: Pick<RoutingCoordinate, "lon" | "lat">,
  end: Pick<RoutingCoordinate, "lon" | "lat">
): { distanceM: number; alongSegmentM: number } {
  const lat = ((start.lat + end.lat + point[1]) / 3) * (Math.PI / 180);
  const metersPerLon = 111_320 * Math.cos(lat);
  const metersPerLat = 111_320;
  const ax = start.lon * metersPerLon;
  const ay = start.lat * metersPerLat;
  const bx = end.lon * metersPerLon;
  const by = end.lat * metersPerLat;
  const px = point[0] * metersPerLon;
  const py = point[1] * metersPerLat;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared, 0, 1) : 0;
  const closestX = ax + t * dx;
  const closestY = ay + t * dy;
  return {
    distanceM: Math.hypot(px - closestX, py - closestY),
    alongSegmentM: Math.sqrt(lengthSquared) * t
  };
}

function addIsoSeconds(value: string, seconds: number): string {
  const timestamp = Date.parse(value);
  return new Date((Number.isFinite(timestamp) ? timestamp : Date.now()) + seconds * 1000).toISOString();
}

async function requestValhallaRoute(
  config: SituationDataConfig,
  profile: RoutingProfile,
  request: Required<Pick<RoutingRouteRequest, "profileId" | "from" | "to" | "avoid" | "alternatives">> & RoutingRouteRequest,
  trafficContext?: RoutingTrafficContext,
  options: ValhallaRouteRequestOptions = {}
): Promise<ValhallaRouteResponse> {
  const payload = {
    locations: [
      { lat: request.from.lat, lon: request.from.lon, name: request.from.label, type: "break" },
      { lat: request.to.lat, lon: request.to.lon, name: request.to.label, type: "break" }
    ],
    costing: valhallaCosting(profile.profileId),
    costing_options: valhallaCostingOptions(profile, request.avoid),
    ...valhallaTrafficAvoidancePayload(trafficContext),
    ...valhallaLinearCostFactorsPayload(options.linearCostFactors),
    alternates: Math.max(0, Math.min(2, options.alternates ?? request.alternatives - 1)),
    ...(request.includeElevationProfile ? { elevation_interval: ROUTE_ELEVATION_SAMPLE_INTERVAL_M } : {}),
    units: "kilometers",
    language: "cs-CZ",
    directions_options: {
      units: "kilometers",
      language: "cs-CZ"
    }
  };
  const body = await requestValhallaJson<ValhallaRouteResponse>(config, "/route", payload);
  if (body.error || body.status_message === "No route found") {
    throw new Error(body.error ?? body.status_message ?? "Valhalla did not return a route.");
  }
  return body;
}

function valhallaLinearCostFactorsPayload(linearCostFactors: ValhallaLinearCostFactor[] | undefined): {
  linear_cost_factors?: Array<{
    type: "Feature";
    geometry: { type: "LineString"; coordinates: Array<[number, number]> };
    properties: { factor: number };
  }>;
} {
  if (!linearCostFactors?.length) {
    return {};
  }
  return {
    linear_cost_factors: linearCostFactors.map((costFactor) => ({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: costFactor.coordinates
      },
      properties: {
        factor: costFactor.factor
      }
    }))
  };
}

async function requestValhallaIsochrone(
  config: SituationDataConfig,
  profile: RoutingProfile,
  request: Required<Pick<RoutingIsochroneRequest, "profileId" | "origin" | "maxTravelTimeMinutes" | "avoid">> & RoutingIsochroneRequest
): Promise<ValhallaIsochroneResponse> {
  const contour = request.maxDistanceM
    ? { distance: Math.round((request.maxDistanceM / 1000) * 1000) / 1000, color: "3b82f6" }
    : { time: request.maxTravelTimeMinutes, color: "3b82f6" };
  return requestValhallaJson<ValhallaIsochroneResponse>(config, "/isochrone", {
    locations: [{ lat: request.origin.lat, lon: request.origin.lon, name: request.origin.label }],
    costing: valhallaCosting(profile.profileId),
    costing_options: valhallaCostingOptions(profile, request.avoid),
    contours: [contour],
    polygons: true,
    denoise: 1,
    generalize: 80,
    units: "kilometers"
  });
}

async function requestValhallaLocate(
  config: SituationDataConfig,
  profile: RoutingProfile,
  request: Required<Pick<RoutingNearestAccessRequest, "profileId" | "point" | "radiusM">> & RoutingNearestAccessRequest
): Promise<ValhallaLocateLocation[]> {
  return requestValhallaJson<ValhallaLocateLocation[]>(config, "/locate", {
    verbose: true,
    locations: [{ lat: request.point.lat, lon: request.point.lon, radius: request.radiusM }],
    costing: valhallaCosting(profile.profileId),
    costing_options: valhallaCostingOptions(profile, []),
    directions_options: {
      units: "kilometers",
      language: "cs-CZ"
    }
  });
}

async function requestValhallaStatus(config: SituationDataConfig): Promise<ValhallaStatusResponse> {
  return requestValhallaJson<ValhallaStatusResponse>(config, "/status", undefined, "GET");
}

async function requestValhallaJson<T>(config: SituationDataConfig, endpoint: string, payload?: unknown, method: "GET" | "POST" = "POST"): Promise<T> {
  const baseUrl = config.valhallaBaseUrl;
  if (!baseUrl) {
    throw new Error("VALHALLA_BASE_URL is not configured.");
  }
  const response = await fetch(new URL(endpoint, withTrailingSlash(baseUrl)), {
    method,
    headers: {
      accept: "application/json",
      ...(payload === undefined ? {} : { "content-type": "application/json; charset=utf-8" }),
      "user-agent": "csm-sim-situation-data/0.1"
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(config.requestTimeoutMs)
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; status_message?: string };
  if (!response.ok) {
    throw new Error(body.error ?? body.status_message ?? `HTTP ${response.status} from Valhalla.`);
  }
  if (body.error) {
    throw new Error(body.error);
  }
  return body as T;
}

function valhallaRoutes(
  profile: RoutingProfile,
  request: Required<Pick<RoutingRouteRequest, "from" | "to">> & RoutingRouteRequest,
  response: ValhallaRouteResponse,
  requestedAlternatives: number
): RoutingRoute[] {
  const trips = [response.trip, ...(response.alternates ?? []).map((alternate) => alternate.trip)].filter(
    (trip): trip is NonNullable<ValhallaRouteResponse["trip"]> => Boolean(trip)
  );
  return trips
    .slice(0, Math.max(1, Math.min(3, requestedAlternatives)))
    .map((trip, index) => valhallaRoute(profile, request, trip, index + 1))
    .filter((route): route is RoutingRoute => Boolean(route));
}

function valhallaRoute(
  profile: RoutingProfile,
  request: Required<Pick<RoutingRouteRequest, "from" | "to">> & RoutingRouteRequest,
  trip: NonNullable<ValhallaRouteResponse["trip"]>,
  rank: number
): RoutingRoute | undefined {
  const legShapes = (trip.legs ?? []).map((leg) => decodeValhallaPolyline6(leg.shape)).filter((coordinates) => coordinates.length >= 2);
  const coordinates = dedupeConsecutiveCoordinates(legShapes.flat());
  if (coordinates.length < 2) {
    return undefined;
  }
  const summary = trip.summary;
  const distanceM = metersFromKilometers(summary?.length) ?? Math.round(polylineDistanceM(coordinates));
  const durationSeconds = Number.isFinite(Number(summary?.time))
    ? Math.round(Number(summary?.time))
    : estimatedDurationSeconds(distanceM, profile.defaultSpeedKph);
  const elevationProfile = request.includeElevationProfile ? valhallaElevationProfile(trip.legs ?? [], coordinates, distanceM) : undefined;
  const elevation = elevationProfile && elevationProfile.length > 0 ? elevationSummary(elevationProfile, "ok", "valhalla", []) : undefined;
  return {
    routeId: `routing:${profile.profileId}:valhalla:${stablePayload({ from: request.from, to: request.to, rank })}`,
    profileId: profile.profileId,
    rank,
    status: "ok",
    geometry: { type: "LineString", coordinates },
    distanceM,
    durationSeconds,
    ascentM: elevation?.gainM,
    descentM: elevation?.lossM,
    snap: valhallaSnap(request, trip),
    steps: valhallaSteps(trip.legs ?? [], coordinates),
    warnings: [],
    traffic: emptyRouteTraffic(),
    quality: {
      mode: "engine_route",
      confidence: 0.9,
      graphEdgesScanned: 0,
      graphEdgesUsed: Math.max(0, coordinates.length - 1),
      routingModelVersion: VALHALLA_ROUTING_MODEL_VERSION,
      engine: "valhalla"
    },
    elevation,
    elevationProfile
  };
}

function valhallaIsochroneResponse(
  generatedAt: string,
  profile: RoutingProfile,
  request: Required<Pick<RoutingIsochroneRequest, "origin" | "maxTravelTimeMinutes">> & RoutingIsochroneRequest,
  response: ValhallaIsochroneResponse,
  maxDistanceM: number,
  warnings: string[]
): RoutingIsochroneResponse {
  const features = (response.features ?? []).flatMap((feature, index) =>
    polygonsFromValhallaGeometry(feature.geometry).map((polygon, polygonIndex) => {
      const contourMinutes = numericProperty(feature.properties?.contour);
      return {
        type: "Feature" as const,
        id: `routing:isochrone:valhalla:${stablePayload({ request, index, polygonIndex })}`,
        geometry: polygon,
        properties: {
          profileId: profile.profileId,
          mode: "engine_route",
          engine: "valhalla",
          contourMinutes: contourMinutes ?? request.maxTravelTimeMinutes,
          maxTravelTimeMinutes: request.maxTravelTimeMinutes,
          maxDistanceM: Math.round(maxDistanceM),
          confidence: 0.88,
          styleHint: "routing-isochrone-v1",
          color: cleanString(feature.properties?.color)
        }
      };
    })
  );
  const largestPolygon = features
    .map((feature) => feature.geometry)
    .sort((left, right) => (approximatePolygonAreaKm2(right.coordinates[0] ?? []) ?? 0) - (approximatePolygonAreaKm2(left.coordinates[0] ?? []) ?? 0))[0];
  return {
    contractVersion: "sim-routing-isochrone-v1",
    generatedAt,
    source: routingSource(generatedAt, "valhalla"),
    query: publicQuery(request),
    profile,
    summary: {
      maxTravelTimeMinutes: request.maxTravelTimeMinutes,
      maxDistanceM: Math.round(maxDistanceM),
      reachedNodeCount: features.length,
      areaKm2: largestPolygon ? approximatePolygonAreaKm2(largestPolygon.coordinates[0] ?? []) : undefined
    },
    features,
    warnings
  };
}

function valhallaNearestAccessResponse(
  generatedAt: string,
  profile: RoutingProfile,
  request: Required<Pick<RoutingNearestAccessRequest, "point" | "radiusM">> & RoutingNearestAccessRequest,
  response: ValhallaLocateLocation[],
  warnings: string[]
): RoutingNearestAccessResponse {
  const location = response[0];
  warnings.push(...valhallaLocateWarnings(response));
  const edge = location?.edges?.find((candidate) => Number.isFinite(Number(candidate.correlated_lon)) && Number.isFinite(Number(candidate.correlated_lat)));
  if (!edge) {
    return emptyNearestAccessResponse(generatedAt, profile, request, warnings, "valhalla");
  }
  const lon = roundCoord(Number(edge.correlated_lon));
  const lat = roundCoord(Number(edge.correlated_lat));
  const distanceM = Number.isFinite(Number(edge.distance))
    ? Math.round(Number(edge.distance))
    : Math.round(haversineMeters([request.point.lon, request.point.lat], [lon, lat]));
  const accessPoint = {
    lon,
    lat,
    distanceM,
    osmId: optionalInteger(edge.edge_info?.way_id ?? edge.way_id),
    roadName: cleanString(edge.names?.[0] ?? edge.edge_info?.names?.[0]),
    highway: cleanString(edge.use ?? edge.road_class)
  };
  return {
    contractVersion: "sim-routing-nearest-access-v1",
    generatedAt,
    source: routingSource(generatedAt, "valhalla"),
    query: publicQuery(request),
    profile,
    accessPoint,
    features: [
      {
        type: "Feature",
        id: `routing:nearest-access:valhalla:${stablePayload(request)}`,
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: {
          profileId: profile.profileId,
          mode: "engine_route",
          engine: "valhalla",
          distanceM: accessPoint.distanceM,
          highway: accessPoint.highway,
          roadName: accessPoint.roadName,
          osmId: accessPoint.osmId,
          confidence: 0.9,
          styleHint: "routing-nearest-access-v1"
        }
      }
    ],
    warnings
  };
}

function valhallaCosting(profileId: RoutingProfileId): string {
  switch (profileId) {
    case "walking":
    case "evacuation_walking":
      return "pedestrian";
    case "large_emergency_vehicle":
      return "truck";
    case "offroad_4x4":
    case "emergency_vehicle":
    case "car":
    default:
      return "auto";
  }
}

function valhallaCostingOptions(profile: RoutingProfile, avoid: RoutingAvoid[]): Record<string, Record<string, boolean | number>> {
  const options: Record<string, Record<string, boolean | number>> = {};
  const costing = valhallaCosting(profile.profileId);
  const base: Record<string, boolean | number> = {};
  if (avoid.includes("bridge")) {
    base.exclude_bridges = true;
  }
  if (avoid.includes("tunnel")) {
    base.exclude_tunnels = true;
  }
  if (profile.profileId === "evacuation_walking") {
    base.walking_speed = 3.8;
  } else if (profile.profileId === "walking") {
    base.walking_speed = 4.8;
  }
  if (profile.profileId === "large_emergency_vehicle") {
    base.use_tracks = 0;
  }
  if (Object.keys(base).length > 0) {
    options[costing] = base;
  }
  return options;
}

function valhallaSnap(
  request: Required<Pick<RoutingRouteRequest, "from" | "to">> & RoutingRouteRequest,
  trip: NonNullable<ValhallaRouteResponse["trip"]>
): RoutingRoute["snap"] {
  const first = coordinateFromValhallaLocation(trip.locations?.[0]) ?? request.from;
  const last = coordinateFromValhallaLocation(trip.locations?.[trip.locations.length - 1]) ?? request.to;
  const fromCoordinate = { lon: roundCoord(first.lon), lat: roundCoord(first.lat) };
  const toCoordinate = { lon: roundCoord(last.lon), lat: roundCoord(last.lat) };
  return {
    fromDistanceM: Math.round(haversineMeters([request.from.lon, request.from.lat], [fromCoordinate.lon, fromCoordinate.lat])),
    toDistanceM: Math.round(haversineMeters([request.to.lon, request.to.lat], [toCoordinate.lon, toCoordinate.lat])),
    from: fromCoordinate,
    to: toCoordinate
  };
}

function coordinateFromValhallaLocation(value: Record<string, unknown> | undefined): RoutingCoordinate | undefined {
  if (!value) {
    return undefined;
  }
  const lon = Number(value.lon);
  const lat = Number(value.lat);
  return Number.isFinite(lon) && Number.isFinite(lat) ? { lon, lat } : undefined;
}

function valhallaSteps(legs: ValhallaLeg[], routeCoordinates: Array<[number, number]>): RoutingStep[] {
  const steps: RoutingStep[] = [];
  for (const leg of legs) {
    const coordinates = decodeValhallaPolyline6(leg.shape);
    for (const maneuver of leg.maneuvers ?? []) {
      const begin = Math.max(0, Math.min(coordinates.length - 1, Number(maneuver.begin_shape_index) || 0));
      const end = Math.max(begin + 1, Math.min(coordinates.length, (Number(maneuver.end_shape_index) || begin) + 1));
      const stepCoordinates = coordinates.slice(begin, end);
      if (stepCoordinates.length < 2) {
        continue;
      }
      const roadName = cleanString(maneuver.street_names?.[0] ?? maneuver.begin_street_names?.[0]);
      steps.push({
        index: steps.length,
        instructionLocalized: {
          cs: cleanString(maneuver.instruction) ?? "Pokračujte po trase.",
          en: cleanString(maneuver.instruction) ?? "Continue on the route."
        },
        distanceM: metersFromKilometers(maneuver.length) ?? Math.round(polylineDistanceM(stepCoordinates)),
        durationSeconds: Number.isFinite(Number(maneuver.time)) ? Math.round(Number(maneuver.time)) : 0,
        roadName,
        highway: cleanString(maneuver.travel_type ?? maneuver.travel_mode),
        geometry: { type: "LineString", coordinates: stepCoordinates }
      });
    }
  }
  if (steps.length > 0) {
    return steps;
  }
  return [
    {
      index: 0,
      instructionLocalized: { cs: "Pokračujte po trase.", en: "Continue on the route." },
      distanceM: Math.round(polylineDistanceM(routeCoordinates)),
      durationSeconds: 0,
      geometry: { type: "LineString", coordinates: routeCoordinates }
    }
  ];
}

function polygonsFromValhallaGeometry(geometry: ValhallaGeoJsonFeature["geometry"]): PolygonGeometry[] {
  if (geometry?.type === "Polygon") {
    const polygon = polygonCoordinates(geometry.coordinates);
    return polygon ? [{ type: "Polygon", coordinates: polygon }] : [];
  }
  if (geometry?.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    return geometry.coordinates.flatMap((coordinates) => {
      const polygon = polygonCoordinates(coordinates);
      return polygon ? [{ type: "Polygon", coordinates: polygon }] : [];
    });
  }
  return [];
}

function polygonCoordinates(value: unknown): Array<Array<[number, number]>> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const rings = value.flatMap((ring) => {
    if (!Array.isArray(ring)) {
      return [];
    }
    const coordinates = ring.flatMap((coordinate) => {
      if (!Array.isArray(coordinate) || coordinate.length < 2) {
        return [];
      }
      const lon = Number(coordinate[0]);
      const lat = Number(coordinate[1]);
      return Number.isFinite(lon) && Number.isFinite(lat) ? ([[roundCoord(lon), roundCoord(lat)] as [number, number]] as Array<[number, number]>) : [];
    });
    return coordinates.length >= 4 ? [closeLinearRing(coordinates)] : [];
  });
  return rings.length > 0 ? rings : undefined;
}

function closeLinearRing(coordinates: Array<[number, number]>): Array<[number, number]> {
  const first = coordinates[0];
  const last = coordinates[coordinates.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    return [...coordinates, first];
  }
  return coordinates;
}

function valhallaWarnings(response: ValhallaRouteResponse | ValhallaIsochroneResponse): string[] {
  const routeWarnings = (response as ValhallaRouteResponse).trip?.warnings ?? [];
  const isochroneWarnings = (response as ValhallaIsochroneResponse).warnings ?? [];
  return [...routeWarnings, ...isochroneWarnings].flatMap((warning) => {
    if (typeof warning === "string") {
      return [warning];
    }
    return warning.text ? [warning.text] : [];
  });
}

function operationBackends(
  valhallaEnabled: boolean,
  osmPostgisConfigured: boolean
): Record<"route" | "alternatives" | "isochrone" | "nearestAccess", RoutingOperationBackend> {
  const backend: RoutingOperationBackend = valhallaEnabled ? "valhalla" : osmPostgisConfigured ? "osm-postgis-graph" : "unconfigured";
  return {
    route: backend,
    alternatives: backend,
    isochrone: backend,
    nearestAccess: backend
  };
}

function valhallaLocateWarnings(response: ValhallaLocateLocation[]): string[] {
  return response.flatMap((location) =>
    (location.warnings ?? []).flatMap((warning) => {
      if (typeof warning === "string") {
        return [warning];
      }
      return warning.text ? [warning.text] : [];
    })
  );
}

function decodeValhallaPolyline6(value: string | undefined): Array<[number, number]> {
  if (!value) {
    return [];
  }
  const coordinates: Array<[number, number]> = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < value.length) {
    const latResult = decodePolylineChunk(value, index);
    index = latResult.nextIndex;
    const lonResult = decodePolylineChunk(value, index);
    index = lonResult.nextIndex;
    lat += latResult.delta;
    lon += lonResult.delta;
    coordinates.push([roundCoord(lon / 1e6), roundCoord(lat / 1e6)]);
  }
  return coordinates;
}

function decodePolylineChunk(value: string, startIndex: number): { delta: number; nextIndex: number } {
  let result = 0;
  let shift = 0;
  let index = startIndex;
  let byte = 0;
  do {
    byte = value.charCodeAt(index) - 63;
    index += 1;
    result |= (byte & 0x1f) << shift;
    shift += 5;
  } while (byte >= 0x20 && index <= value.length);
  return { delta: result & 1 ? ~(result >> 1) : result >> 1, nextIndex: index };
}

function metersFromKilometers(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) : undefined;
}

function polylineDistanceM(coordinates: Array<[number, number]>): number {
  let distanceM = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    distanceM += haversineMeters(coordinates[index - 1]!, coordinates[index]!);
  }
  return distanceM;
}

function estimatedDurationSeconds(distanceM: number, speedKph: number): number {
  return Math.round((distanceM / Math.max(1, speedKph * 1000)) * 3600);
}

function directIsochroneResponse(
  generatedAt: string,
  profile: RoutingProfile,
  request: Required<Pick<RoutingIsochroneRequest, "origin" | "maxTravelTimeMinutes">> & RoutingIsochroneRequest,
  maxDistanceM: number,
  warnings: string[],
  backend: "valhalla" | "osm-postgis-graph" = "osm-postgis-graph"
): RoutingIsochroneResponse {
  const polygon = circlePolygon(request.origin, maxDistanceM);
  return {
    contractVersion: "sim-routing-isochrone-v1",
    generatedAt,
    source: routingSource(generatedAt, backend),
    query: publicQuery(request),
    profile,
    summary: {
      maxTravelTimeMinutes: request.maxTravelTimeMinutes,
      maxDistanceM: Math.round(maxDistanceM),
      reachedNodeCount: 0,
      areaKm2: approximatePolygonAreaKm2(polygon.coordinates[0] ?? [])
    },
    features: [
      {
        type: "Feature",
        id: `routing:isochrone:direct:${stablePayload(request)}`,
        geometry: polygon,
        properties: {
          profileId: profile.profileId,
          mode: "direct_fallback",
          engine: backend,
          maxTravelTimeMinutes: request.maxTravelTimeMinutes,
          maxDistanceM: Math.round(maxDistanceM),
          confidence: 0.18,
          styleHint: "routing-isochrone-v1"
        }
      }
    ],
    warnings
  };
}

function emptyNearestAccessResponse(
  generatedAt: string,
  profile: RoutingProfile,
  request: unknown,
  warnings: string[],
  backend: "valhalla" | "osm-postgis-graph" = "osm-postgis-graph"
): RoutingNearestAccessResponse {
  return {
    contractVersion: "sim-routing-nearest-access-v1",
    generatedAt,
    source: routingSource(generatedAt, backend),
    query: publicQuery(request),
    profile,
    features: [],
    warnings
  };
}

function radialReachPolygon(origin: RoutingCoordinate, reached: Array<[number, number]>, fallbackRadiusM: number): PolygonGeometry {
  if (reached.length < 3) {
    return circlePolygon(origin, fallbackRadiusM);
  }
  const bins = new Array<{ distanceM: number; coordinate: [number, number] } | undefined>(36).fill(undefined);
  for (const coordinate of reached) {
    const azimuth = bearingDegrees([origin.lon, origin.lat], coordinate);
    const index = Math.min(35, Math.floor(azimuth / 10));
    const distanceM = haversineMeters([origin.lon, origin.lat], coordinate);
    const current = bins[index];
    if (!current || distanceM > current.distanceM) {
      bins[index] = { distanceM, coordinate };
    }
  }
  const coordinates = bins
    .map((bin, index) => bin?.coordinate ?? destinationPoint(origin, fallbackRadiusM * 0.25, index * 10 + 5))
    .map(([lon, lat]) => [roundCoord(lon), roundCoord(lat)] as [number, number]);
  coordinates.push(coordinates[0]!);
  return { type: "Polygon", coordinates: [coordinates] };
}

function circlePolygon(origin: RoutingCoordinate, radiusM: number): PolygonGeometry {
  const coordinates: Array<[number, number]> = [];
  for (let angle = 0; angle < 360; angle += 10) {
    const point = destinationPoint(origin, radiusM, angle);
    coordinates.push([roundCoord(point[0]), roundCoord(point[1])]);
  }
  coordinates.push(coordinates[0]!);
  return { type: "Polygon", coordinates: [coordinates] };
}

function routingSource(generatedAt: string, backend: "valhalla" | "osm-postgis-graph" = "osm-postgis-graph"): RoutingSource {
  return {
    sourceId: "routing_model",
    sourceType: "MODELLED_ROUTING",
    generatedAt,
    backend
  };
}

function publicQuery(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function routeSearchBbox(from: RoutingCoordinate, to: RoutingCoordinate, profile: RoutingProfile, maxSearchRadiusM: number): BoundingBox {
  const distanceM = haversineMeters([from.lon, from.lat], [to.lon, to.lat]);
  const paddingM = Math.min(Math.max(2500, distanceM * 0.35), Math.min(profile.maxSearchRadiusM, maxSearchRadiusM) * 0.35);
  return expandBbox(
    {
      west: Math.min(from.lon, to.lon),
      south: Math.min(from.lat, to.lat),
      east: Math.max(from.lon, to.lon),
      north: Math.max(from.lat, to.lat)
    },
    paddingM
  );
}

function bboxAroundPoint(point: RoutingCoordinate, radiusM: number): BoundingBox {
  return expandBbox({ west: point.lon, south: point.lat, east: point.lon, north: point.lat }, radiusM);
}

function isPointInBbox(lon: number, lat: number, bbox: BoundingBox): boolean {
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

function expandBbox(bbox: BoundingBox, paddingM: number): BoundingBox {
  const centerLat = (bbox.south + bbox.north) / 2;
  const latPad = paddingM / 111_320;
  const lonPad = paddingM / Math.max(1, 111_320 * Math.cos((centerLat * Math.PI) / 180));
  return {
    west: clamp(bbox.west - lonPad, -180, 180),
    south: clamp(bbox.south - latPad, -90, 90),
    east: clamp(bbox.east + lonPad, -180, 180),
    north: clamp(bbox.north + latPad, -90, 90)
  };
}

function parseProfileId(value: unknown): RoutingProfileId {
  if (typeof value === "string" && ROUTING_PROFILES.some((profile) => profile.profileId === value)) {
    return value as RoutingProfileId;
  }
  return "emergency_vehicle";
}

function getRoutingProfile(profileId: RoutingProfileId): RoutingProfile {
  return ROUTING_PROFILES.find((profile) => profile.profileId === profileId) ?? ROUTING_PROFILES[1]!;
}

function parseCoordinate(value: unknown, label: string): RoutingCoordinate {
  if (!value || typeof value !== "object") {
    throw new RoutingError(400, "VALIDATION_ERROR", `${label} coordinate is required.`);
  }
  const record = value as Record<string, unknown>;
  const lon = Number(record.lon ?? record.lng ?? record.longitude);
  const lat = Number(record.lat ?? record.latitude);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new RoutingError(400, "VALIDATION_ERROR", `${label} must contain valid WGS84 lon/lat.`);
  }
  return {
    lon,
    lat,
    label: cleanString(record.label)
  };
}

function parseAvoid(value: unknown): RoutingAvoid[] {
  const allowed = new Set<RoutingAvoid>(["flood", "fire", "road_closure", "unpaved", "tunnel", "bridge"]);
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return raw.map((item) => String(item).trim()).filter((item): item is RoutingAvoid => allowed.has(item as RoutingAvoid));
}

function positiveNumber(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new RoutingError(400, "VALIDATION_ERROR", `${label} must be a positive number.`);
  }
  return parsed;
}

function integerInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function speedForEdge(profile: RoutingProfile, highway: string | undefined, surface: string | undefined, tracktype: string | undefined): number {
  if (profile.transportMode === "walk") {
    const base = highway === "steps" ? 2.5 : profile.defaultSpeedKph;
    return profile.profileId === "evacuation_walking" && (highway === "path" || highway === "track") ? Math.min(base, 3.2) : base;
  }
  const highwaySpeed = highway ? (BASE_SPEED_KPH_BY_HIGHWAY[highway] ?? profile.defaultSpeedKph) : profile.defaultSpeedKph;
  let speed = Math.min(highwaySpeed, profile.defaultSpeedKph * 1.35);
  if (profile.profileId === "emergency_vehicle") {
    speed *= 1.08;
  }
  if (profile.profileId === "large_emergency_vehicle") {
    speed *= 0.86;
  }
  if (profile.profileId === "offroad_4x4" && (highway === "track" || highway === "path")) {
    speed = Math.min(speed, 22);
  }
  if (isLikelyUnpaved(surface, tracktype)) {
    speed *= profile.profileId === "offroad_4x4" ? 0.8 : 0.55;
  }
  return Math.max(2, speed);
}

function isLikelyUnpaved(surface: unknown, tracktype: unknown): boolean {
  const surfaceText = cleanString(surface)?.toLowerCase();
  const trackText = cleanString(tracktype)?.toLowerCase();
  return (
    Boolean(trackText && !["grade1"].includes(trackText)) ||
    Boolean(surfaceText && ["unpaved", "gravel", "dirt", "earth", "grass", "sand", "mud", "ground"].includes(surfaceText))
  );
}

function oneWayDirection(value: unknown): "both" | "forward" | "reverse" {
  const normalized = cleanString(value)?.toLowerCase();
  if (!normalized) {
    return "both";
  }
  if (["yes", "true", "1"].includes(normalized)) {
    return "forward";
  }
  if (normalized === "-1" || normalized === "reverse") {
    return "reverse";
  }
  return "both";
}

function truthyTag(value: unknown): boolean {
  const normalized = cleanString(value)?.toLowerCase();
  return Boolean(normalized && !["no", "false", "0"].includes(normalized));
}

function nodeKey(coordinate: [number, number]): string {
  return `${roundCoord(coordinate[0])},${roundCoord(coordinate[1])}`;
}

function haversineMeters(left: [number, number], right: [number, number]): number {
  const earthRadiusM = 6_371_000;
  const lat1 = (left[1] * Math.PI) / 180;
  const lat2 = (right[1] * Math.PI) / 180;
  const dLat = ((right[1] - left[1]) * Math.PI) / 180;
  const dLon = ((right[0] - left[0]) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return earthRadiusM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDegrees(from: [number, number], to: [number, number]): number {
  const lat1 = (from[1] * Math.PI) / 180;
  const lat2 = (to[1] * Math.PI) / 180;
  const dLon = ((to[0] - from[0]) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function destinationPoint(origin: RoutingCoordinate, distanceM: number, bearingDeg: number): [number, number] {
  const earthRadiusM = 6_371_000;
  const angularDistance = distanceM / earthRadiusM;
  const bearing = (bearingDeg * Math.PI) / 180;
  const lat1 = (origin.lat * Math.PI) / 180;
  const lon1 = (origin.lon * Math.PI) / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angularDistance) + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing));
  const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1), Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2));
  return [(((lon2 * 180) / Math.PI + 540) % 360) - 180, (lat2 * 180) / Math.PI];
}

function approximatePolygonAreaKm2(coordinates: Array<[number, number]>): number | undefined {
  if (coordinates.length < 4) {
    return undefined;
  }
  const lat = coordinates.reduce((sum, coordinate) => sum + coordinate[1], 0) / coordinates.length;
  const metersPerLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const metersPerLat = 111_320;
  let area = 0;
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const [x1, y1] = coordinates[index]!;
    const [x2, y2] = coordinates[index + 1]!;
    area += x1 * metersPerLon * (y2 * metersPerLat) - x2 * metersPerLon * (y1 * metersPerLat);
  }
  return Math.round((Math.abs(area) / 2 / 1_000_000) * 100) / 100;
}

function dedupeConsecutiveCoordinates(coordinates: Array<[number, number]>): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  for (const coordinate of coordinates) {
    const rounded: [number, number] = [roundCoord(coordinate[0]), roundCoord(coordinate[1])];
    const last = result[result.length - 1];
    if (!last || last[0] !== rounded[0] || last[1] !== rounded[1]) {
      result.push(rounded);
    }
  }
  return result.length >= 2 ? result : coordinates;
}

function stablePayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}

function roundCoord(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function numericProperty(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function quoteQualifiedIdentifier(value: string, label = "ROUTING_OSM_ROADS_TABLE"): string {
  const parts = value
    .split(".")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > 2 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
    throw new Error(`Invalid ${label} identifier.`);
  }
  return parts.map((part) => `"${part.replace(/"/g, '""')}"`).join(".");
}

class MinHeap<T> {
  private items: T[] = [];

  constructor(private readonly compare: (left: T, right: T) => number) {}

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop(): T | undefined {
    if (this.items.length === 0) {
      return undefined;
    }
    const first = this.items[0]!;
    const last = this.items.pop();
    if (last !== undefined && this.items.length > 0) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return first;
  }

  private bubbleUp(index: number): void {
    let cursor = index;
    while (cursor > 0) {
      const parent = Math.floor((cursor - 1) / 2);
      if (this.compare(this.items[cursor]!, this.items[parent]!) >= 0) {
        break;
      }
      [this.items[cursor], this.items[parent]] = [this.items[parent]!, this.items[cursor]!];
      cursor = parent;
    }
  }

  private bubbleDown(index: number): void {
    let cursor = index;
    while (true) {
      const left = cursor * 2 + 1;
      const right = cursor * 2 + 2;
      let smallest = cursor;
      if (left < this.items.length && this.compare(this.items[left]!, this.items[smallest]!) < 0) {
        smallest = left;
      }
      if (right < this.items.length && this.compare(this.items[right]!, this.items[smallest]!) < 0) {
        smallest = right;
      }
      if (smallest === cursor) {
        break;
      }
      [this.items[cursor], this.items[smallest]] = [this.items[smallest]!, this.items[cursor]!];
      cursor = smallest;
    }
  }
}
