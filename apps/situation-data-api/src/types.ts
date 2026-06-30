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
  | "weather_radar_reflectivity"
  | "weather_radar_precipitation"
  | "weather_radar_nowcast"
  | "weather_thunderstorm_risk"
  | "weather_webcams"
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
  | "spravazeleznic_trains"
  | "road_srti_lod"
  | "safety_data"
  | "aviation_weather"
  | "chmi_air_quality"
  | "chmi_weather_stations"
  | "chmi_weather_radar"
  | "chmi_weather_webcams"
  | "ardos_partner";
export type SourceMode = "live" | "mock" | "reference";
export type SituationSeverity = "info" | "advisory" | "warning" | "critical";
export type OsmPostgisBackend = "unconfigured" | "local-postgis" | "patroni-postgis" | "external-postgis";
export type MobileCoverageTechnology = "2G" | "4G" | "5G";
export type MobileNetworkTechnology = MobileCoverageTechnology | "mixed" | "unknown";
export type MobileCoverageQuality = "good" | "fair" | "weak" | "none" | "unknown";
export type MobileNetworkStatus = "ok" | "weak_signal" | "degraded_possible" | "outage_reported" | "unknown";
export type MobileNetworkDataQuality = "observed" | "modelled" | "mixed" | "unknown";
export type MobileBtsStatus = "operator_feed_unavailable" | "unverified" | "reported_outage" | "unknown";
export type ProviderCatalogLayerRole = "primary" | "reference" | "overlay" | "user" | "partner" | "diagnostic";
export type ProviderCatalogSourceRole = "final" | "aggregate" | "reference" | "input" | "projection" | "mock" | "diagnostic";
export type ProviderCatalogAudience = "public" | "authenticated" | "partner" | "admin" | "diagnostic";
export type ProviderCatalogKind =
  | "vector_features"
  | "grid_field"
  | "vector_field"
  | "raster_overlay"
  | "mvt_tiles"
  | "raster_tiles"
  | "track_stream"
  | "user_objects"
  | "static_reference"
  | "aggregate";

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
  geometryTypes: Array<"Point" | "LineString" | "Polygon" | "MultiPolygon">;
  expectedCadenceSeconds?: number;
}

export interface ProviderCatalogFilter {
  filterId: string;
  label?: string;
  type: "single_select" | "multi_select" | "boolean" | "range";
  values?: string[];
  defaultValue?: string | string[] | boolean | number;
}

export interface ProviderCatalogLayer {
  providerLayerId: string;
  recommendedCatalogLayerId: string;
  label: string;
  labelLocalized?: Record<string, string>;
  description: string;
  descriptionLocalized?: Record<string, string>;
  categoryPath: string[];
  categories: string[];
  role: ProviderCatalogLayerRole;
  audience: ProviderCatalogAudience;
  kind: ProviderCatalogKind;
  defaultVisible: boolean;
  selectable: boolean;
  geometryTypes: Array<"Point" | "LineString" | "Polygon" | "MultiPolygon">;
  minZoom: number;
  maxZoom: number;
  refreshSeconds: number;
  cacheTtlSeconds: number;
  styleProfile: string;
  sourceIds: SituationDataSourceId[];
  technicalInputs?: SituationDataSourceId[];
  filters?: ProviderCatalogFilter[];
  query: {
    mode: "bbox";
    providerId: "sim.situation-data";
    streamId: "cop.features";
    providerLayerIds: SituationLayerId[];
    providerSourceIds: SituationDataSourceId[];
    maxFeatures: number;
    categoryFilter?: string[];
  };
  legend?: {
    profile: string;
    unit?: string;
    opacity?: number;
    stops?: Array<{
      value: number | string;
      label: string;
      color: string;
    }>;
  };
  delivery?: {
    mode: "features" | "grid" | "vector_tiles" | "raster_tiles" | "raster_overlay";
    geometryRole?: "feature_geometry" | "grid_cell" | "raster_extent";
    fallbackPolicy?: "hide_if_unsupported" | "hide_if_raster_overlay_unsupported";
    doNotRenderGeometryFill?: boolean;
    valueField?: string;
    stableGrid?: {
      alignment: "wgs84";
      resolutionDegrees?: number;
      resolutionM?: number;
    };
    tileTemplate?: string;
  };
  readModel?: {
    table?: string;
    refreshedBy?: string;
    cacheTtlSeconds?: number;
  };
  model?: {
    modelVersion: string;
    terrainAware: boolean;
    demSource: string;
    confidenceExplanation: string;
  };
  legal: {
    attribution: string;
    notes: string[];
  };
  supersedes?: string[];
  replacedBy?: string;
  compatibilityOnly?: boolean;
  preferredProviderId?: string;
}

export interface ProviderCatalogSource {
  sourceId: SituationDataSourceId;
  label: string;
  enabled: boolean;
  mode: SourceMode;
  layers: SituationLayerId[];
  sourceRole: ProviderCatalogSourceRole;
  audience: ProviderCatalogAudience;
  selectableInMap: boolean;
  visibleInDiagnostics: boolean;
  feedsLayerIds: string[];
  feedsCatalogLayerIds: string[];
  usedByLayerIds?: string[];
  usedByCatalogLayerIds?: string[];
  technicalInputs?: SituationDataSourceId[];
  replacedBy?: SituationDataSourceId;
  preferredProviderId?: string;
  updateCadenceSeconds?: number;
  cacheTtlSeconds: number;
  baseUrl?: string;
  backend?: string;
  license: SituationDataLicense;
  notes?: string[];
}

export interface ProviderMapCatalog {
  contractVersion: "provider-map-catalog-v1";
  catalogVersion: "provider-map-catalog-v1";
  providerId: "sim.situation-data";
  generatedAt: string;
  status: "online";
  authority: {
    contractVersion: "map-catalog-v1";
    catalogVersion: "map-catalog-v1";
    document: string;
  };
  layers: ProviderCatalogLayer[];
  sources: ProviderCatalogSource[];
}

export interface SituationDataPublicConfig {
  enabledSources: SituationDataSourceId[];
  defaultBbox: BoundingBox;
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
    metNorway: number;
    mobileNetwork: number;
    mobileCoverage: number;
    osmPostgis: number;
    osmOverpass: number;
    ctuStationaryMobile: number;
    pidGtfsRt: number;
    pidGtfsStatic: number;
    idsjmkVehiclePositions: number;
    spravaZeleznicTrains: number;
    roadSrtiLod: number;
    safetyData: number;
    aviationWeather: number;
    chmiAirQuality: number;
    chmiWeatherStations: number;
    chmiWeatherRadar: number;
    chmiWeatherWebcams: number;
    ardosPartner: number;
    radioPlanning: number;
  };
  weatherRadarFrames: {
    historyHours: number;
    maxCount: number;
    storeEnabled: boolean;
    mode: "metadata_only" | "local_filesystem";
    cleanCropInsetPixels: number;
  };
  providers: Array<{
    sourceId: SituationDataSourceId;
    baseUrl?: string;
    fallbackBaseUrl?: string;
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
  boundaryFeatureCount?: number;
  boundaryLevels?: string[];
  boundaryLastImportAt?: string;
  boundaryLastImportAgeSeconds?: number;
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

export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: Array<Array<Array<[number, number]>>>;
}

export type SituationGeometry = PointGeometry | LineStringGeometry | PolygonGeometry | MultiPolygonGeometry;

export interface SituationFeatureProperties {
  featureId: string;
  layerId?: string;
  providerId?: "sim.situation-data";
  providerLayerId?: string;
  layer: SituationLayerId;
  category: string;
  label: string;
  labelLocalized?: Record<string, string>;
  summaryLocalized?: Record<string, string>;
  hazardType?: string;
  typeCode?: string;
  sourceCode?: string;
  sourceSystem?: string;
  localized?: Record<string, Record<string, unknown>>;
  sourceId: SituationDataSourceId;
  source?: string;
  sourceName?: string;
  observedAt: string;
  validFrom?: string;
  validUntil?: string;
  updatedAt?: string;
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
  rendering?: {
    mode: "feature" | "grid_field" | "vector_field" | "raster_overlay";
    geometryRole: "feature_geometry" | "grid_cell" | "raster_extent" | "wind_vector";
    valueMetric?: string;
    unit?: string;
    opacity?: number;
    doNotRenderGeometryFill?: boolean;
    fallbackPolicy?: "hide_if_unsupported" | "hide_if_raster_overlay_unsupported";
  };
  transportMode?: string;
  routeShortName?: string;
  destination?: string;
  delaySeconds?: number;
  vehicleId?: string;
  tripId?: string;
  occupancyStatus?: string;
  occupancyPercent?: number;
  headingDeg?: number;
  speedMps?: number;
  operator?: string;
  technology?: MobileNetworkTechnology;
  quality?: MobileCoverageQuality;
  status?: MobileNetworkStatus;
  basis?: string[];
  summary?: string;
  notices?: string[];
  dataQuality?: MobileNetworkDataQuality;
  adminLevel?: number;
  name?: string;
  code?: string;
  countryCode?: string;
  areaName?: string;
  styleHint?: string;
  iconHint?: string;
  btsStatus?: MobileBtsStatus;
  btsStatusSource?: string;
  operatorStatusAvailable?: boolean;
  estimatedSignalDbm?: number;
  modelVersion?: string;
  sourceRevision?: string;
  readModel?: boolean;
  generatedAt?: string;
  resolutionM?: number;
  demSource?: string;
  assumptions?: Record<string, string | number | boolean>;
  disclaimer?: string;
  providerProperties?: Record<string, unknown>;
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
