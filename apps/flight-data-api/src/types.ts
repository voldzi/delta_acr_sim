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
  bboxCacheGridDegrees: number;
  bboxCachePaddingDegrees: number;
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
    flightRouteEnrichmentEnabled: boolean;
    flightRouteCacheTtlSeconds: number;
    flightRouteRoutesCsvUrl: string;
    flightRouteAirportsCsvUrl: string;
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

export type FlightTrackIconHint = "jet" | "turboprop" | "small_aircraft" | "helicopter" | "glider" | "uav" | "unknown";

export interface FlightTrackAircraft {
  typeDesignator?: string;
  manufacturer?: string;
  model?: string;
  category?: string;
  engineType?: string;
  wakeTurbulenceCategory?: string;
  iconHint: FlightTrackIconHint;
}

export interface FlightItineraryAirport {
  icao: string;
  iata?: string;
  name: string;
  city?: string;
  countryCode?: string;
  lat: number;
  lon: number;
  elevationFt?: number;
}

export interface FlightItineraryProgress {
  basis: "great_circle_current_position";
  totalDistanceKm?: number;
  distanceTravelledKm?: number;
  distanceRemainingKm?: number;
  progressRatio?: number;
  progressPercent?: number;
  estimatedRemainingSeconds?: number;
  estimatedArrivalAt?: string;
  groundSpeedMps?: number;
  computedAt: string;
}

export interface FlightItinerary {
  source: {
    sourceId: "vrs_standing_data";
    name: string;
    license: string;
    routesUrl: string;
    airportsUrl: string;
  };
  callsign: string;
  airlineCode?: string;
  flightNumber?: string;
  airportCodes: string[];
  airportIataCodes: string[];
  origin?: FlightItineraryAirport;
  destination?: FlightItineraryAirport;
  waypoints: FlightItineraryAirport[];
  display: {
    title: string;
    originCode?: string;
    destinationCode?: string;
    originCity?: string;
    destinationCity?: string;
  };
  progress?: FlightItineraryProgress;
  timing: {
    scheduledDeparture: { status: "unavailable"; reason: string };
    actualDeparture: { status: "unavailable"; reason: string };
    scheduledArrival: { status: "unavailable"; reason: string };
    estimatedArrival: { status: "estimated" | "unavailable"; value?: string; basis?: "current_position_groundspeed_great_circle"; confidence: number; reason?: string };
  };
  quality: {
    routeMatch: "callsign_exact";
    routeConfidence: number;
    scheduleAvailable: false;
    timingMode: "position_estimate" | "unavailable";
    limitations: string[];
  };
}

export interface FlightTrackPosition {
  lat: number;
  lon: number;
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
  position: FlightTrackPosition;
  altitudeM?: number;
  speedMps?: number;
  headingDeg?: number;
  verticalRateMps?: number;
  lastSeenAt: string;
  originCountry?: string;
  aircraft?: FlightTrackAircraft;
  itinerary?: FlightItinerary;
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
