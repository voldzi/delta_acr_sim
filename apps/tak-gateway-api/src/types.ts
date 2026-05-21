export type TakLayerId = "ground" | "mobile" | "traffic";
export type TakSourceMode = "live" | "mock" | "reference";
export type TakAffiliation = "friend" | "hostile" | "neutral" | "unknown";

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface TakGatewayPublicConfig {
  defaultBbox: BoundingBox;
  staleAfterSeconds: number;
  retentionSeconds: number;
  maxEvents: number;
  exposeRaw: boolean;
  ingestAuthConfigured: boolean;
  readAuthConfigured: boolean;
  publicRead: boolean;
  sourceLabel: string;
}

export interface TakQuery {
  bbox: BoundingBox;
  layers: TakLayerId[];
  limit: number;
  includeRaw: boolean;
}

export interface TakCotEvent {
  uid: string;
  type: string;
  how?: string;
  time?: string;
  start?: string;
  stale?: string;
  receivedAt: string;
  point: {
    lat: number;
    lon: number;
    hae?: number;
    ce?: number;
    le?: number;
  };
  contact?: {
    callsign?: string;
    endpoint?: string;
  };
  group?: {
    name?: string;
    role?: string;
  };
  track?: {
    course?: number;
    speed?: number;
  };
  remarks?: string;
  raw?: unknown;
}

export interface TakSourceDescriptor {
  sourceId: "tak_gateway";
  label: string;
  enabled: boolean;
  mode: TakSourceMode;
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

export interface TakLayerDescriptor {
  layerId: TakLayerId;
  label: string;
  description: string;
  defaultVisible: boolean;
  geometryTypes: Array<"Point">;
  expectedCadenceSeconds?: number;
}

export interface TakFeature {
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
    raw?: unknown;
  };
}

export interface TakFeatureCollection {
  contractVersion: "cop-tak-source-v1";
  type: "FeatureCollection";
  generatedAt: string;
  source: {
    sourceId: "tak-gateway-api";
    sourceType: "TAK_COT_GATEWAY";
    generatedAt: string;
  };
  query: {
    bbox: BoundingBox;
    layers: TakLayerId[];
    limit: number;
  };
  summary: {
    eventCount: number;
    featureCount: number;
    staleFeatureCount: number;
    affiliationCounts: Record<TakAffiliation, number>;
  };
  features: TakFeature[];
  sources: TakSourceDescriptor[];
  warnings: string[];
}

export interface TakGatewayStats {
  acceptedEvents: number;
  invalidEvents: number;
  droppedEvents: number;
  authFailures: number;
  parseErrors: number;
  currentEvents: number;
  staleEvents: number;
  lastIngestAt?: string;
  lastErrorAt?: string;
}
