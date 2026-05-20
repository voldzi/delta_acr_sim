export type SituationLayerId = "weather" | "ground" | "mobile" | "traffic" | "warnings" | "flood" | "air_quality";
export type SituationDataSourceId =
  | "mock"
  | "open_meteo"
  | "osm_postgis"
  | "osm_overpass"
  | "ctu_nettest"
  | "pid_gtfs_rt"
  | "safety_data"
  | "aviation_weather"
  | "ardos_partner";
export type SourceMode = "live" | "mock" | "reference";
export type SituationSeverity = "info" | "advisory" | "warning" | "critical";

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
  }>;
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
