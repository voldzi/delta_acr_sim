export type SafetyLayerId = "warnings" | "flood";
export type SafetyDataSourceId = "mock" | "chmi_alerts" | "chmi_hydro";
export type SourceMode = "live" | "mock" | "reference";
export type SafetySeverity = "info" | "advisory" | "warning" | "critical";
export type SafetyUrgency = "immediate" | "expected" | "future" | "past" | "unknown";
export type SafetyCertainty = "observed" | "likely" | "possible" | "unlikely" | "unknown";

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface SafetyQuery {
  bbox: BoundingBox;
  layers: SafetyLayerId[];
  sourceIds: SafetyDataSourceId[];
  limit: number;
  includeRaw: boolean;
}

export interface SafetyDataLicense {
  name: string;
  url?: string;
  attribution: string;
  commercialUse: "allowed" | "allowed_with_obligations" | "requires_license" | "unknown";
  operationalUse: "allowed" | "allowed_with_obligations" | "requires_license" | "unknown";
  notes: string[];
}

export interface SourceDescriptor {
  sourceId: SafetyDataSourceId;
  label: string;
  enabled: boolean;
  mode: SourceMode;
  priority: number;
  layers: SafetyLayerId[];
  license: SafetyDataLicense;
  baseUrl?: string;
  updateCadenceSeconds?: number;
}

export interface LayerDescriptor {
  layerId: SafetyLayerId;
  label: string;
  description: string;
  defaultVisible: boolean;
  geometryTypes: Array<"Point" | "LineString" | "Polygon">;
  expectedCadenceSeconds?: number;
}

export interface SafetyDataPublicConfig {
  enabledSources: SafetyDataSourceId[];
  defaultBbox: BoundingBox;
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

export interface PointGeometry {
  type: "Point";
  coordinates: [number, number];
}

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: Array<Array<[number, number]>>;
}

export type SafetyGeometry = PointGeometry | PolygonGeometry;

export interface SafetyFeatureProperties {
  featureId: string;
  layerId?: string;
  providerId?: "sim.safety-data";
  providerLayerId?: string;
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
  severity: SafetySeverity;
  urgency: SafetyUrgency;
  certainty: SafetyCertainty;
  license: {
    name: string;
    attribution: string;
    url?: string;
  };
  affectedAreas?: string[];
  geocodes?: Array<{ scheme: string; value: string }>;
  metrics?: Record<string, number | string | boolean>;
  tags?: Record<string, string>;
  providerProperties?: Record<string, unknown>;
  raw?: unknown;
}

export interface SafetyFeature {
  type: "Feature";
  id: string;
  geometry: SafetyGeometry;
  properties: SafetyFeatureProperties;
}

export interface SourceFetchResult {
  source: SourceDescriptor;
  fetchedAt: string;
  features: SafetyFeature[];
  warnings: string[];
}

export interface SafetyFeatureCollection {
  contractVersion: "cop-safety-source-v1";
  type: "FeatureCollection";
  generatedAt: string;
  source: {
    sourceId: "safety-data-api";
    sourceType: "PUBLIC_SAFETY_AGGREGATE";
    generatedAt: string;
  };
  query: {
    bbox: BoundingBox;
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
  features: SafetyFeature[];
  sources: SourceDescriptor[];
  warnings: string[];
}
