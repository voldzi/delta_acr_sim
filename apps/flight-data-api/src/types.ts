export type FlightDataSourceId = "mock" | "adsb_lol" | "opensky" | "local_adsb";

export interface BoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface FlightQuery {
  bbox?: BoundingBox;
  limit: number;
  sourceIds: FlightDataSourceId[];
  includeStale: boolean;
}

export interface FlightDataLicense {
  name: string;
  url?: string;
  attribution: string;
  commercialUse: "allowed" | "allowed_with_obligations" | "requires_license" | "unknown";
  operationalUse: "allowed" | "allowed_with_obligations" | "requires_license" | "unknown";
  notes: string[];
}

export interface SourceDescriptor {
  sourceId: FlightDataSourceId;
  label: string;
  enabled: boolean;
  mode: "live" | "mock" | "reference";
  priority: number;
  license: FlightDataLicense;
  baseUrl?: string;
}

export interface FlightDataPublicConfig {
  enabledSources: FlightDataSourceId[];
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
    sourceId: FlightDataSourceId;
    baseUrl?: string;
    authConfigured: boolean;
  }>;
  referenceData: {
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

export interface RawFlightObservation {
  sourceId: FlightDataSourceId;
  sourceRecordId: string;
  sourcePriority: number;
  fetchedAt: string;
  seenAt: string;
  icao24: string;
  callsign?: string;
  registration?: string;
  typeDesignator?: string;
  originCountry?: string;
  lat?: number;
  lon?: number;
  altitudeM?: number;
  speedMps?: number;
  headingDeg?: number;
  verticalRateMps?: number;
  onGround?: boolean;
  squawk?: string;
  emergency?: string;
  category?: string;
  raw?: unknown;
}

export interface SourceFetchResult {
  source: SourceDescriptor;
  fetchedAt: string;
  observations: RawFlightObservation[];
  warnings: string[];
}

export interface FlightTrackSourceRef {
  sourceId: FlightDataSourceId;
  sourceRecordId: string;
  fetchedAt: string;
  seenAt: string;
}

export interface FlightTrackAircraft {
  typeDesignator?: string;
  manufacturer?: string;
  model?: string;
  category?: string;
  engineType?: string;
  wakeTurbulenceCategory?: string;
}

export interface AggregatedFlightTrack {
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
  aircraft?: FlightTrackAircraft;
  sources: FlightTrackSourceRef[];
  deduplication: {
    key: "icao24";
    mergedRecordCount: number;
    primarySourceId: FlightDataSourceId;
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

export interface FlightTrackResponse {
  generatedAt: string;
  query: {
    bbox?: BoundingBox;
    limit: number;
    includeStale: boolean;
    sources: FlightDataSourceId[];
  };
  summary: {
    rawObservationCount: number;
    deduplicatedTrackCount: number;
    droppedWithoutPositionCount: number;
    staleTrackCount: number;
  };
  sources: SourceDescriptor[];
  tracks: AggregatedFlightTrack[];
  warnings: string[];
}

export interface AirportReference {
  ident: string;
  iata?: string;
  name: string;
  municipality?: string;
  countryCode: string;
  type: "large_airport" | "medium_airport" | "small_airport" | "heliport" | "closed_airport" | "seaplane_base" | "balloonport";
  lat: number;
  lon: number;
  elevationFt?: number;
  dataSource: string;
}

export interface AircraftTypeReference {
  designator: string;
  manufacturer: string;
  model: string;
  category: string;
  engineType?: string;
  wakeTurbulenceCategory?: string;
  dataSource: string;
}

export interface GeoJsonPolygon {
  type: "Polygon";
  coordinates: Array<Array<[number, number]>>;
}

export interface GeoJsonMultiPolygon {
  type: "MultiPolygon";
  coordinates: Array<Array<Array<[number, number]>>>;
}

export interface GeoJsonPoint {
  type: "Point";
  coordinates: [number, number];
}

export interface GeoJsonLineString {
  type: "LineString";
  coordinates: Array<[number, number]>;
}

export type GeoJsonGeometry = GeoJsonPoint | GeoJsonLineString | GeoJsonPolygon | GeoJsonMultiPolygon;

export type AviationAirspaceType = "prohibited" | "restricted" | "danger" | "temporary_reserved" | "temporary_segregated" | "other";

export interface AirspaceReference {
  airspaceId: string;
  designator: string;
  name: string;
  type: AviationAirspaceType;
  geometry: GeoJsonPolygon;
  geometryQuality: "official_vertices" | "official_circle_approximation" | "official_vertices_with_boundary_simplification" | "seed_fallback";
  lowerLimit: string;
  upperLimit: string;
  verticalLimitText: string;
  activity?: string;
  time?: string;
  remarks?: string;
  sourceUrl: string;
  sourceSection: string;
  dataSource: string;
  loadedAt: string;
  notForNavigation: true;
}
