export type FlightDataSourceId = "mock" | "adsb_lol" | "opensky" | "local_adsb" | "partner_air_tracks";
export type FlightTrackKeyKind = "icao24" | "remote_id" | "radar_track" | "partner_track";
export type PartnerAirTrackSourceKind = "remote_id" | "u_space" | "radar" | "partner";

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
  partnerAirTracks: {
    ingestEnabled: boolean;
    ttlSeconds: number;
    maxRecords: number;
  };
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
  icao24?: string;
  trackKey?: string;
  trackKeyKind?: FlightTrackKeyKind;
  callsign?: string;
  registration?: string;
  typeDesignator?: string;
  originCountry?: string;
  objectType?: "AIRCRAFT" | "UAV" | "UNKNOWN";
  sourceKind?: PartnerAirTrackSourceKind;
  sensorId?: string;
  remoteId?: string;
  uasRegistration?: string;
  operatorRegistration?: string;
  serialNumber?: string;
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
  sensorId?: string;
}

export type FlightTrackIconHint = "jet" | "turboprop" | "small_aircraft" | "helicopter" | "glider" | "uav" | "unknown";

export type FlightTrackIconKey =
  | "aircraft_01_small_ga"
  | "aircraft_02_light_twin"
  | "aircraft_03_turboprop"
  | "aircraft_04_business_jet"
  | "aircraft_05_regional_jet"
  | "aircraft_06_narrowbody_airliner"
  | "aircraft_07_widebody_airliner"
  | "aircraft_08_jumbo_airliner"
  | "aircraft_09_cargo_freighter"
  | "aircraft_10_glider"
  | "aircraft_11_military_fighter"
  | "aircraft_12_military_transport"
  | "aircraft_13_military_bomber"
  | "aircraft_14_aerobatic_prop"
  | "aircraft_15_seaplane"
  | "aircraft_16_ultralight"
  | "aircraft_17_helicopter_light"
  | "aircraft_18_helicopter_medium"
  | "aircraft_19_helicopter_heavy"
  | "aircraft_20_helicopter_military"
  | "drone_01_quadcopter"
  | "drone_02_hexacopter"
  | "drone_03_fixed_wing_uav"
  | "drone_04_fpv_racing"
  | "drone_05_vtol_hybrid";

export type FlightTrackAircraftClass =
  | "small_ga"
  | "light_twin"
  | "turboprop"
  | "business_jet"
  | "regional_jet"
  | "narrowbody_airliner"
  | "widebody_airliner"
  | "jumbo_airliner"
  | "cargo_freighter"
  | "glider"
  | "military_fighter"
  | "military_transport"
  | "military_bomber"
  | "aerobatic_prop"
  | "seaplane"
  | "ultralight"
  | "helicopter_light"
  | "helicopter_medium"
  | "helicopter_heavy"
  | "helicopter_military"
  | "uav_multirotor"
  | "uav_fixed_wing"
  | "uav_vtol"
  | "unknown";

export interface FlightAdsbEmitterCategory {
  code: string;
  label: string;
  group: "aircraft" | "rotorcraft" | "uav" | "surface" | "obstacle" | "unknown";
}

export interface FlightTrackAircraft {
  typeDesignator?: string;
  manufacturer?: string;
  model?: string;
  category?: string;
  sourceCategory?: string;
  adsbCategory?: FlightAdsbEmitterCategory;
  engineType?: string;
  wakeTurbulenceCategory?: string;
  classKey: FlightTrackAircraftClass;
  iconHint: FlightTrackIconHint;
  iconKey: FlightTrackIconKey;
  iconFile: string;
  iconSet: "airspace-icons-mono-v1";
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

export interface FlightTrackOperationalStatus {
  emergency: {
    active: boolean;
    code?: "general" | "radio_failure" | "unlawful_interference" | "minimum_fuel" | "lifeguard" | "downed" | "reserved" | "unknown";
    label: string;
    source: "adsb_emergency" | "squawk" | "none";
    squawk?: string;
    rawEmergency?: string;
  };
  delay: {
    status: "unknown" | "on_time" | "delayed";
    minutes?: number;
    source: "not_available" | "schedule_feed";
    reason?: string;
  };
  phase: "ground" | "climb" | "cruise" | "descent" | "unknown";
}

export interface FlightTrackPresentation {
  label: string;
  iconSet: "airspace-icons-mono-v1";
  iconKey: FlightTrackIconKey;
  iconFile: string;
  iconHint: FlightTrackIconHint;
  rotateWithHeading: true;
  rotationDeg?: number;
  colorKey: "normal" | "delayed" | "emergency";
  colorHex: "#22c55e" | "#eab308" | "#ef4444";
  colorReason: "normal" | "delay_detected" | "emergency_detected" | "delay_not_available";
  zIndexPriority: number;
}

export interface AggregatedFlightTrack {
  trackId: string;
  trackKey: string;
  trackKeyKind: FlightTrackKeyKind;
  icao24?: string;
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
  status: FlightTrackOperationalStatus;
  presentation: FlightTrackPresentation;
  sources: FlightTrackSourceRef[];
  deduplication: {
    key: FlightTrackKeyKind;
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
    sourceCategory?: string;
    sourceKind?: PartnerAirTrackSourceKind;
    sensorId?: string;
    remoteId?: string;
    uasRegistration?: string;
    operatorRegistration?: string;
    serialNumber?: string;
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
