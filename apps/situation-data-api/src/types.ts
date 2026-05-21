export type SituationLayerId = "weather" | "ground" | "mobile" | "mobile_coverage" | "traffic" | "warnings" | "flood" | "air_quality";
export type SituationDataSourceId =
  | "mock"
  | "open_meteo"
  | "mobile_coverage_model"
  | "osm_postgis"
  | "osm_overpass"
  | "ctu_nettest"
  | "pid_gtfs_rt"
  | "safety_data"
  | "aviation_weather"
  | "ardos_partner";
export type SourceMode = "live" | "mock" | "reference";
export type SituationSeverity = "info" | "advisory" | "warning" | "critical";
export type OsmPostgisBackend = "unconfigured" | "local-postgis" | "patroni-postgis" | "external-postgis";
export type MobileCoverageTechnology = "2G" | "4G" | "5G";
export type MobileCoverageQuality = "good" | "fair" | "weak" | "none" | "unknown";

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface SituationQuery {
  bbox: BoundingBox;
  layers: SituationLayerId[];
  sourceIds: SituationDataSourceId[];
  limit: number;
  includeRaw: boolean;
  mobileCoverageTechnologies?: MobileCoverageTechnology[];
  mobileCoverageOperators?: string[];
}

export interface SituationDataLicense {
  name: string;
  url?: string;
  attribution: string;
  commercialUse: "allowed" | "allowed_with_obligations" | "requires_license" | "unknown";
  operationalUse: "allowed" | "allowed_with_obligations" | "requires_license" | "unknown";
  notes: string[];
}

export interface SourceDescriptor {
  sourceId: SituationDataSourceId;
  label: string;
  enabled: boolean;
  mode: SourceMode;
  priority: number;
  layers: SituationLayerId[];
  license: SituationDataLicense;
  baseUrl?: string;
  updateCadenceSeconds?: number;
}

export interface LayerDescriptor {
  layerId: SituationLayerId;
  label: string;
  description: string;
  defaultVisible: boolean;
  geometryTypes: Array<"Point" | "LineString" | "Polygon">;
  expectedCadenceSeconds?: number;
}

export interface SituationDataPublicConfig {
  enabledSources: SituationDataSourceId[];
  defaultBbox: BoundingBox;
  cacheTtlSeconds: number;
  staleIfErrorSeconds: number;
  cacheMaxEntries: number;
  bboxCachePaddingDegrees: number;
  staleAfterSeconds: number;
  requestTimeoutMs: number;
  sourceCacheTtlSeconds: {
    openMeteo: number;
    mobileCoverage: number;
    osmPostgis: number;
    osmOverpass: number;
    safetyData: number;
    aviationWeather: number;
    ardosPartner: number;
  };
  providers: Array<{
    sourceId: SituationDataSourceId;
    baseUrl?: string;
    authConfigured: boolean;
    backend?: string;
  }>;
}

export interface SourceHealthStatus {
  sourceId: SituationDataSourceId;
  status: "ok" | "degraded";
  backend?: string;
  objectCount?: number;
  lastImportAt?: string;
  lastImportAgeSeconds?: number;
  warnings: string[];
}

export interface DemCatalogStatus {
  enabled: boolean;
  status: "ok" | "degraded" | "disabled";
  datasetId: string;
  source?: string;
  version?: string;
  resolutionM?: number;
  tileCount?: number;
  localTileCount?: number;
  objectStoreTileCount?: number;
  importedAt?: string;
  bbox?: BoundingBox;
  localCacheDir?: string;
  objectStore?: {
    endpoint?: string;
    bucket: string;
    prefix: string;
  };
  warnings: string[];
}

export interface PointGeometry {
  type: "Point";
  coordinates: [number, number];
}

export interface LineStringGeometry {
  type: "LineString";
  coordinates: Array<[number, number]>;
}

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: Array<Array<[number, number]>>;
}

export type SituationGeometry = PointGeometry | LineStringGeometry | PolygonGeometry;

export interface SituationFeatureProperties {
  featureId: string;
  layer: SituationLayerId;
  category: string;
  label: string;
  sourceId: SituationDataSourceId;
  observedAt: string;
  validUntil?: string;
  confidence: number;
  stale: boolean;
  severity: SituationSeverity;
  license: {
    name: string;
    attribution: string;
    url?: string;
  };
  metrics?: Record<string, number | string | boolean>;
  tags?: Record<string, string>;
  operator?: string;
  technology?: MobileCoverageTechnology;
  quality?: MobileCoverageQuality;
  estimatedSignalDbm?: number;
  modelVersion?: string;
  generatedAt?: string;
  resolutionM?: number;
  demSource?: string;
  assumptions?: Record<string, string | number | boolean>;
  disclaimer?: string;
  raw?: unknown;
}

export interface SituationFeature {
  type: "Feature";
  id: string;
  geometry: SituationGeometry;
  properties: SituationFeatureProperties;
}

export interface SourceFetchResult {
  source: SourceDescriptor;
  fetchedAt: string;
  features: SituationFeature[];
  warnings: string[];
}

export interface SituationFeatureCollection {
  contractVersion: "cop-situation-source-v1";
  type: "FeatureCollection";
  generatedAt: string;
  source: {
    sourceId: "situation-data-api";
    sourceType: "PUBLIC_SITUATION_AGGREGATE";
    generatedAt: string;
  };
  query: {
    bbox: BoundingBox;
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
  features: SituationFeature[];
  sources: SourceDescriptor[];
  warnings: string[];
}
