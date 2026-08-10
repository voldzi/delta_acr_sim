import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BoundingBox, OsmPostgisBackend, SituationDataSourceId } from "./types.js";

export interface PublicTransitStaticFeedConfig {
  systemId: string;
  label: string;
  url: string;
}

export interface GeoRoutingPrincipalConfig {
  actor: string;
  token: string;
}

export interface SituationDataConfig {
  port: number;
  dataDir: string;
  enabledSources: SituationDataSourceId[];
  defaultBbox: BoundingBox;
  requestTimeoutMs: number;
  cacheTtlSeconds: number;
  staleIfErrorSeconds: number;
  cacheMaxEntries: number;
  sharedCacheRedisUrl?: string;
  sharedCacheKeyPrefix: string;
  sharedCacheConnectTimeoutMs: number;
  bboxCachePaddingDegrees: number;
  staleAfterSeconds: number;
  openMeteoBaseUrl: string;
  openMeteoCacheTtlSeconds: number;
  openMeteoGridDegrees: number;
  metNorwayBaseUrl: string;
  metNorwayCacheTtlSeconds: number;
  metNorwayUserAgent: string;
  mobileCoverageCacheTtlSeconds: number;
  mobileNetworkCacheTtlSeconds: number;
  mobileCoverageResolutionM: number;
  mobileCoverageMaxCells: number;
  mobileCoverageModelVersion: string;
  mobileCoverageDemSource: string;
  mobileCoverageTerrainAware: boolean;
  mobileCoverageAntennaHeightM: number;
  mobileCoverageReadModelEnabled: boolean;
  mobileCoverageReadModelTable: string;
  mobileCoverageReadModelMaxAgeSeconds: number;
  osmPostgisConnectionString?: string;
  osmPostgisBackend: OsmPostgisBackend;
  osmPostgisTable: string;
  osmPostgisAdminBoundaryTable: string;
  osmPostgisTrailRoutesTable: string;
  osmPostgisTrailPoiTable: string;
  osmPostgisCacheTtlSeconds: number;
  overpassBaseUrl: string;
  overpassCacheTtlSeconds: number;
  overpassMaxBboxDegrees: number;
  ctuNettestUrl: string;
  ctuStationaryMobileUrls: string[];
  ctuStationaryMobileCacheTtlSeconds: number;
  pidGtfsRtVehiclePositionsUrl: string;
  pidGtfsRtTripUpdatesUrl: string;
  pidGtfsRtCacheTtlSeconds: number;
  pidGtfsStaticUrl: string;
  pidGtfsStaticCacheTtlSeconds: number;
  publicTransitStaticGtfsFeeds: PublicTransitStaticFeedConfig[];
  publicTransitStaticGeojsonFeeds: PublicTransitStaticFeedConfig[];
  publicTransitStaticCacheTtlSeconds: number;
  publicTransitStaticMaxStops: number;
  idsjmkVehiclePositionsUrl: string;
  idsjmkVehiclePositionsCacheTtlSeconds: number;
  spravaZeleznicTrainPositionsUrl: string;
  spravaZeleznicTrainPositionsCacheTtlSeconds: number;
  roadSrtiLodSparqlUrl: string;
  roadSrtiLodCacheTtlSeconds: number;
  roadSrtiLodMaxRecords: number;
  safetyDataBaseUrl: string;
  safetyDataCacheTtlSeconds: number;
  aviationWeatherBaseUrl: string;
  aviationWeatherCacheTtlSeconds: number;
  chmiAirQualityMetadataUrl: string;
  chmiAirQualityDataUrl: string;
  chmiAirQualityCacheTtlSeconds: number;
  chmiWeatherMetadataBaseUrl: string;
  chmiWeatherDataBaseUrl: string;
  chmiWeatherCacheTtlSeconds: number;
  chmiWeatherMaxStations: number;
  chmiWeatherRadarBaseUrl: string;
  chmiWeatherRadarCacheTtlSeconds: number;
  chmiWeatherRadarFrameHistoryHours: number;
  chmiWeatherRadarFrameMaxCount: number;
  chmiWeatherRadarFrameStoreEnabled: boolean;
  chmiWeatherRadarFrameStoreDir: string;
  chmiWeatherRadarCleanCropInsetPixels: number;
  chmiWeatherWebcamsMapUrl: string;
  chmiWeatherWebcamsDataBaseUrl: string;
  chmiWeatherWebcamsPublicBaseUrl: string;
  chmiWeatherWebcamsCacheTtlSeconds: number;
  publicCameraFeeds: string[];
  ardosPartnerBaseUrl?: string;
  ardosPartnerToken?: string;
  ardosPartnerCacheTtlSeconds: number;
  searchDataCacheTtlSeconds: number;
  searchDataCacheMaxEntries: number;
  searchDataMaxLimit: number;
  routingCacheTtlSeconds: number;
  routingCacheMaxEntries: number;
  routingEngine: "auto" | "valhalla" | "osm_postgis";
  valhallaBaseUrl?: string;
  routingOsmRoadsTable: string;
  routingMaxGraphEdges: number;
  routingMaxSearchRadiusM: number;
  routingMaxSnapDistanceM: number;
  geoRoutingPrincipals: GeoRoutingPrincipalConfig[];
  geoRoutingAudience: string;
  geoRoutingMaxWaypoints: number;
  geoRoutingMaxTotalDistanceM: number;
  geoRoutingRateLimitPerMinute: number;
  geoRoutingPrecomputeDir: string;
  radioPlanningCacheTtlSeconds: number;
  radioPlanningCacheMaxEntries: number;
  demEnabled: boolean;
  demDatasetId: string;
  demPostgisConnectionString?: string;
  demLocalCacheDir: string;
  demSeaweedfsEndpoint?: string;
  demSeaweedfsBucket: string;
  demSeaweedfsPrefix: string;
  corsOrigins?: string[];
}

export async function loadConfig(): Promise<SituationDataConfig> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const dataDir = resolve(process.env.SITUATION_DATA_DIR ?? `${projectRoot}/data/situation-data`);
  await mkdir(dataDir, { recursive: true });

  return {
    port: parseInteger(process.env.SITUATION_DATA_API_PORT, 4020),
    dataDir,
    enabledSources: parseSourceList(process.env.SITUATION_DATA_ENABLED_SOURCES),
    defaultBbox: parseBbox(process.env.SITUATION_DATA_DEFAULT_BBOX) ?? {
      west: 13.85,
      south: 49.65,
      east: 15.35,
      north: 50.45
    },
    requestTimeoutMs: parseInteger(process.env.SITUATION_DATA_REQUEST_TIMEOUT_MS, 6000),
    cacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_CACHE_TTL_SECONDS, 30),
    staleIfErrorSeconds: parseInteger(process.env.SITUATION_DATA_STALE_IF_ERROR_SECONDS, 1800),
    cacheMaxEntries: parseInteger(process.env.SITUATION_DATA_CACHE_MAX_ENTRIES, 10000),
    sharedCacheRedisUrl: emptyToUndefined(process.env.SITUATION_DATA_SHARED_CACHE_REDIS_URL),
    sharedCacheKeyPrefix: process.env.SITUATION_DATA_SHARED_CACHE_KEY_PREFIX ?? "csm-sim:situation-data",
    sharedCacheConnectTimeoutMs: parseInteger(process.env.SITUATION_DATA_SHARED_CACHE_CONNECT_TIMEOUT_MS, 1000),
    bboxCachePaddingDegrees: parseFloatOr(process.env.SITUATION_DATA_BBOX_CACHE_PADDING_DEGREES, 0.18),
    staleAfterSeconds: parseInteger(process.env.SITUATION_DATA_STALE_AFTER_SECONDS, 900),
    openMeteoBaseUrl: process.env.OPEN_METEO_BASE_URL ?? "https://api.open-meteo.com",
    openMeteoCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_OPEN_METEO_CACHE_TTL_SECONDS, 600),
    openMeteoGridDegrees: parseFloatOr(process.env.SITUATION_DATA_OPEN_METEO_GRID_DEGREES, 0.05),
    metNorwayBaseUrl: process.env.MET_NORWAY_BASE_URL ?? "https://api.met.no",
    metNorwayCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_MET_NORWAY_CACHE_TTL_SECONDS, 600),
    metNorwayUserAgent: process.env.MET_NORWAY_USER_AGENT ?? "csm-sim/0.1 situation-data contact:ops@zeleznalady.cz",
    mobileCoverageCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_MOBILE_COVERAGE_CACHE_TTL_SECONDS, 21600),
    mobileNetworkCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_MOBILE_NETWORK_CACHE_TTL_SECONDS, 3600),
    mobileCoverageResolutionM: parseInteger(process.env.MOBILE_COVERAGE_RESOLUTION_M, 1000),
    mobileCoverageMaxCells: parseInteger(process.env.MOBILE_COVERAGE_MAX_CELLS, 1000),
    mobileCoverageModelVersion: process.env.MOBILE_COVERAGE_MODEL_VERSION ?? "coverage-v1",
    mobileCoverageDemSource: process.env.MOBILE_COVERAGE_DEM_SOURCE ?? "not-used-phase-1",
    mobileCoverageTerrainAware: parseBoolean(process.env.MOBILE_COVERAGE_TERRAIN_AWARE, false),
    mobileCoverageAntennaHeightM: parseInteger(process.env.MOBILE_COVERAGE_DEFAULT_ANTENNA_HEIGHT_M, 30),
    mobileCoverageReadModelEnabled: parseBoolean(process.env.MOBILE_COVERAGE_READ_MODEL_ENABLED, true),
    mobileCoverageReadModelTable: process.env.MOBILE_COVERAGE_READ_MODEL_TABLE ?? "public.mobile_coverage_cells",
    mobileCoverageReadModelMaxAgeSeconds: parseInteger(process.env.MOBILE_COVERAGE_READ_MODEL_MAX_AGE_SECONDS, 7 * 24 * 60 * 60),
    osmPostgisConnectionString: emptyToUndefined(process.env.OSM_POSTGIS_DATABASE_URL),
    osmPostgisBackend: parseOsmPostgisBackend(process.env.OSM_POSTGIS_BACKEND, process.env.OSM_POSTGIS_DATABASE_URL),
    osmPostgisTable: process.env.OSM_POSTGIS_TABLE ?? "public.osm_poi",
    osmPostgisAdminBoundaryTable: process.env.OSM_POSTGIS_ADMIN_BOUNDARY_TABLE ?? "public.osm_admin_boundary",
    osmPostgisTrailRoutesTable: process.env.OSM_POSTGIS_TRAIL_ROUTES_TABLE ?? "public.osm_trail_routes",
    osmPostgisTrailPoiTable: process.env.OSM_POSTGIS_TRAIL_POI_TABLE ?? "public.osm_trail_poi",
    osmPostgisCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_OSM_POSTGIS_CACHE_TTL_SECONDS, 21600),
    overpassBaseUrl: process.env.OVERPASS_BASE_URL ?? "https://overpass-api.de/api/interpreter",
    overpassCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_OVERPASS_CACHE_TTL_SECONDS, 21600),
    overpassMaxBboxDegrees: parseFloatOr(process.env.OVERPASS_MAX_BBOX_DEGREES, 1.6),
    ctuNettestUrl: process.env.CTU_NETTEST_URL ?? "https://nettest.ctu.gov.cz/RMBTStatisticServer/export/nettest-opendata_hours-048.zip",
    ctuStationaryMobileUrls: parseStringList(process.env.CTU_STATIONARY_MOBILE_URLS, DEFAULT_CTU_STATIONARY_MOBILE_URLS),
    ctuStationaryMobileCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_CTU_STATIONARY_MOBILE_CACHE_TTL_SECONDS, 86400),
    pidGtfsRtVehiclePositionsUrl: process.env.PID_GTFS_RT_VEHICLE_POSITIONS_URL ?? "https://api.golemio.cz/v2/vehiclepositions/gtfsrt/vehicle_positions.pb",
    pidGtfsRtTripUpdatesUrl: emptyToUndefined(process.env.PID_GTFS_RT_TRIP_UPDATES_URL) ?? "https://api.golemio.cz/v2/vehiclepositions/gtfsrt/trip_updates.pb",
    pidGtfsRtCacheTtlSeconds: Math.max(10, parseInteger(process.env.SITUATION_DATA_PID_GTFS_RT_CACHE_TTL_SECONDS, 15)),
    pidGtfsStaticUrl: process.env.PID_GTFS_STATIC_URL ?? "https://data.pid.cz/PID_GTFS.zip",
    pidGtfsStaticCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_PID_GTFS_STATIC_CACHE_TTL_SECONDS, 6 * 60 * 60),
    publicTransitStaticGtfsFeeds: parsePublicTransitStaticFeeds(process.env.PUBLIC_TRANSIT_STATIC_GTFS_FEEDS, DEFAULT_PUBLIC_TRANSIT_STATIC_GTFS_FEEDS),
    publicTransitStaticGeojsonFeeds: parsePublicTransitStaticFeeds(
      process.env.PUBLIC_TRANSIT_STATIC_GEOJSON_FEEDS,
      DEFAULT_PUBLIC_TRANSIT_STATIC_GEOJSON_FEEDS
    ),
    publicTransitStaticCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_PUBLIC_TRANSIT_STATIC_CACHE_TTL_SECONDS, 6 * 60 * 60),
    publicTransitStaticMaxStops: parseInteger(process.env.PUBLIC_TRANSIT_STATIC_MAX_STOPS, 60000),
    idsjmkVehiclePositionsUrl:
      process.env.IDSJMK_VEHICLE_POSITIONS_URL ??
      "https://gis.brno.cz/ags1/rest/services/Hosted/Kordis_26_polohy/FeatureServer/0/query?where=IsInactive%3D%27false%27&outFields=*&orderByFields=TimeUpdated%20DESC&f=geojson&resultRecordCount=10000",
    idsjmkVehiclePositionsCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_IDSJMK_CACHE_TTL_SECONDS, 20),
    spravaZeleznicTrainPositionsUrl:
      process.env.SPRAVAZELEZNIC_TRAIN_POSITIONS_URL ?? "https://mapy.spravazeleznic.cz/serverside/request2.php?module=Layers%5COsVlaky&action=load2",
    spravaZeleznicTrainPositionsCacheTtlSeconds: Math.max(900, parseInteger(process.env.SITUATION_DATA_SPRAVAZELEZNIC_TRAINS_CACHE_TTL_SECONDS, 900)),
    roadSrtiLodSparqlUrl: process.env.ROAD_SRTI_LOD_SPARQL_URL ?? "https://lod.tamtamresearch.com/sparql/",
    roadSrtiLodCacheTtlSeconds: Math.max(60, parseInteger(process.env.SITUATION_DATA_ROAD_SRTI_CACHE_TTL_SECONDS, 60)),
    roadSrtiLodMaxRecords: parseInteger(process.env.ROAD_SRTI_LOD_MAX_RECORDS, 1500),
    safetyDataBaseUrl: process.env.SAFETY_DATA_BASE_URL ?? "http://127.0.0.1:4030",
    safetyDataCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_SAFETY_CACHE_TTL_SECONDS, 300),
    aviationWeatherBaseUrl: process.env.AVIATION_WEATHER_BASE_URL ?? "https://aviationweather.gov",
    aviationWeatherCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_AVIATION_WEATHER_CACHE_TTL_SECONDS, 600),
    chmiAirQualityMetadataUrl: process.env.CHMI_AIR_QUALITY_METADATA_URL ?? "https://opendata.chmi.cz/air_quality/now/metadata/metadata.json",
    chmiAirQualityDataUrl: process.env.CHMI_AIR_QUALITY_DATA_URL ?? "https://opendata.chmi.cz/air_quality/now/data/airquality_1h_avg_CZ.csv",
    chmiAirQualityCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_CHMI_AIR_QUALITY_CACHE_TTL_SECONDS, 900),
    chmiWeatherMetadataBaseUrl: process.env.CHMI_WEATHER_METADATA_BASE_URL ?? "https://opendata.chmi.cz/meteorology/climate/now/metadata/",
    chmiWeatherDataBaseUrl: process.env.CHMI_WEATHER_DATA_BASE_URL ?? "https://opendata.chmi.cz/meteorology/climate/now/data/",
    chmiWeatherCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_CHMI_WEATHER_CACHE_TTL_SECONDS, 600),
    chmiWeatherMaxStations: parseInteger(process.env.SITUATION_DATA_CHMI_WEATHER_MAX_STATIONS, 600),
    chmiWeatherRadarBaseUrl: process.env.CHMI_WEATHER_RADAR_BASE_URL ?? "https://opendata.chmi.cz/meteorology/weather/radar/composite/",
    chmiWeatherRadarCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_CHMI_WEATHER_RADAR_CACHE_TTL_SECONDS, 300),
    chmiWeatherRadarFrameHistoryHours: parseInteger(process.env.SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_HISTORY_HOURS, 6),
    chmiWeatherRadarFrameMaxCount: parseInteger(process.env.SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_MAX_COUNT, 72),
    chmiWeatherRadarFrameStoreEnabled: parseBoolean(process.env.SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_STORE_ENABLED, false),
    chmiWeatherRadarFrameStoreDir: resolve(process.env.SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_STORE_DIR ?? `${dataDir}/weather-radar-frames`),
    chmiWeatherRadarCleanCropInsetPixels: parseInteger(process.env.SITUATION_DATA_CHMI_WEATHER_RADAR_CLEAN_CROP_INSET_PIXELS, 2),
    chmiWeatherWebcamsMapUrl: process.env.CHMI_WEATHER_WEBCAMS_MAP_URL ?? "https://data-provider.chmi.cz/api/kamery/data/map",
    chmiWeatherWebcamsDataBaseUrl: process.env.CHMI_WEATHER_WEBCAMS_DATA_BASE_URL ?? "https://data-provider.chmi.cz",
    chmiWeatherWebcamsPublicBaseUrl: process.env.CHMI_WEATHER_WEBCAMS_PUBLIC_BASE_URL ?? "https://www.chmi.cz",
    chmiWeatherWebcamsCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_CHMI_WEATHER_WEBCAMS_CACHE_TTL_SECONDS, 300),
    publicCameraFeeds: parseStringList(process.env.PUBLIC_CAMERA_FEEDS, DEFAULT_PUBLIC_CAMERA_FEEDS),
    ardosPartnerBaseUrl: emptyToUndefined(process.env.ARDOS_PARTNER_BASE_URL),
    ardosPartnerToken: emptyToUndefined(process.env.ARDOS_PARTNER_TOKEN),
    ardosPartnerCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_ARDOS_CACHE_TTL_SECONDS, 15),
    searchDataCacheTtlSeconds: parseInteger(process.env.SEARCH_DATA_CACHE_TTL_SECONDS, 300),
    searchDataCacheMaxEntries: parseInteger(process.env.SEARCH_DATA_CACHE_MAX_ENTRIES, 256),
    searchDataMaxLimit: parseInteger(process.env.SEARCH_DATA_MAX_LIMIT, 5000),
    routingCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_ROUTING_CACHE_TTL_SECONDS, 300),
    routingCacheMaxEntries: parseInteger(process.env.SITUATION_DATA_ROUTING_CACHE_MAX_ENTRIES, 512),
    routingEngine: parseRoutingEngine(process.env.ROUTING_ENGINE),
    valhallaBaseUrl: emptyToUndefined(process.env.VALHALLA_BASE_URL),
    routingOsmRoadsTable: process.env.ROUTING_OSM_ROADS_TABLE ?? "public.osm_roads",
    routingMaxGraphEdges: parseInteger(process.env.SITUATION_DATA_ROUTING_MAX_GRAPH_EDGES, 45000),
    routingMaxSearchRadiusM: parseInteger(process.env.SITUATION_DATA_ROUTING_MAX_SEARCH_RADIUS_M, 800000),
    routingMaxSnapDistanceM: parseInteger(process.env.SITUATION_DATA_ROUTING_MAX_SNAP_DISTANCE_M, 2500),
    geoRoutingPrincipals: parseGeoRoutingPrincipals(process.env.GEO_ROUTING_SERVICE_TOKENS),
    geoRoutingAudience: process.env.GEO_ROUTING_AUDIENCE ?? "csm-sim-geo-routing-v1",
    geoRoutingMaxWaypoints: Math.max(2, parseInteger(process.env.GEO_ROUTING_MAX_WAYPOINTS, 25)),
    geoRoutingMaxTotalDistanceM: Math.max(1, parseInteger(process.env.GEO_ROUTING_MAX_TOTAL_DISTANCE_M, 1_000_000)),
    geoRoutingRateLimitPerMinute: Math.max(1, parseInteger(process.env.GEO_ROUTING_RATE_LIMIT_PER_MINUTE, 60)),
    geoRoutingPrecomputeDir: resolve(process.env.GEO_ROUTING_PRECOMPUTE_DIR ?? `${dataDir}/geo-routing-v1/precomputed`),
    radioPlanningCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_RADIO_PLANNING_CACHE_TTL_SECONDS, 900),
    radioPlanningCacheMaxEntries: parseInteger(process.env.SITUATION_DATA_RADIO_PLANNING_CACHE_MAX_ENTRIES, 512),
    demEnabled: parseBoolean(process.env.DEM_ENABLED, false),
    demDatasetId: process.env.DEM_DATASET_ID ?? "copernicus-glo30-cz",
    demPostgisConnectionString: emptyToUndefined(process.env.DEM_POSTGIS_DATABASE_URL) ?? emptyToUndefined(process.env.OSM_POSTGIS_DATABASE_URL),
    demLocalCacheDir: process.env.DEM_LOCAL_CACHE_DIR ?? "/dem-cache",
    demSeaweedfsEndpoint: emptyToUndefined(process.env.DEM_SEAWEEDFS_S3_ENDPOINT),
    demSeaweedfsBucket: process.env.DEM_SEAWEEDFS_BUCKET ?? "sim-dem",
    demSeaweedfsPrefix: trimSlashes(process.env.DEM_SEAWEEDFS_PREFIX ?? "copernicus-glo30/2021"),
    corsOrigins: parseStringList(process.env.SITUATION_DATA_CORS_ORIGINS)
  };
}

function parseGeoRoutingPrincipals(value: string | undefined): GeoRoutingPrincipalConfig[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .flatMap((item) => {
      const separator = item.indexOf(":");
      const actor = separator > 0 ? item.slice(0, separator).trim() : "";
      const token = separator > 0 ? item.slice(separator + 1).trim() : "";
      return actor && token ? [{ actor, token }] : [];
    });
}

function parseRoutingEngine(value: string | undefined): "auto" | "valhalla" | "osm_postgis" {
  const normalized = value?.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "valhalla" || normalized === "osm_postgis" || normalized === "auto") {
    return normalized;
  }
  return "auto";
}

function parseSourceList(value: string | undefined): SituationDataSourceId[] {
  const allowed = new Set<SituationDataSourceId>([
    "mock",
    "open_meteo",
    "weather_forecast",
    "mobile_coverage_model",
    "mobile_network_model",
    "osm_postgis",
    "osm_overpass",
    "ctu_nettest",
    "ctu_stationary_mobile",
    "pid_gtfs_rt",
    "public_transit_static",
    "idsjmk_vehicle_positions",
    "spravazeleznic_trains",
    "road_srti_lod",
    "safety_data",
    "community_context",
    "aviation_weather",
    "chmi_air_quality",
    "chmi_weather_stations",
    "chmi_weather_radar",
    "chmi_weather_webcams",
    "ardos_partner"
  ]);
  const parsed = (value ?? "mock")
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is SituationDataSourceId => allowed.has(item as SituationDataSourceId));
  return parsed.length > 0 ? parsed : ["mock"];
}

function parsePublicTransitStaticFeeds(value: string | undefined, defaults: PublicTransitStaticFeedConfig[]): PublicTransitStaticFeedConfig[] {
  const raw = parseStringList(value, defaults.map(formatPublicTransitStaticFeed));
  return raw
    .map((item) => {
      const [systemId, label, url] = item.split("|").map((part) => part.trim());
      if (!systemId || !label || !url) {
        return undefined;
      }
      try {
        const parsed = new URL(url);
        return {
          systemId: systemId.replace(/[^a-z0-9_-]/gi, "_").toLowerCase(),
          label,
          url: parsed.toString()
        };
      } catch {
        return undefined;
      }
    })
    .filter((item): item is PublicTransitStaticFeedConfig => Boolean(item));
}

function formatPublicTransitStaticFeed(feed: PublicTransitStaticFeedConfig): string {
  return `${feed.systemId}|${feed.label}|${feed.url}`;
}

const DEFAULT_CTU_STATIONARY_MOBILE_URLS = [
  "https://ctu.gov.cz/sites/default/files/applications/ctu_imports/import_stacionarni_mereni/4g_tm_stacionarni/4g_tm_stacionarni.zip",
  "https://ctu.gov.cz/sites/default/files/applications/ctu_imports/import_stacionarni_mereni/2g_tm_stacionarni/2g_tm_stacionarni.zip",
  "https://ctu.gov.cz/sites/default/files/applications/ctu_imports/import_stacionarni_mereni/4g_vf_stacionarni/4g_vf_stacionarni.zip",
  "https://ctu.gov.cz/sites/default/files/applications/ctu_imports/import_stacionarni_mereni/2g_vf_stacionarni/2g_vf_stacionarni.zip",
  "https://ctu.gov.cz/sites/default/files/applications/ctu_imports/import_stacionarni_mereni/4g_o2_stacionarni/4g_o2_stacionarni.zip",
  "https://ctu.gov.cz/sites/default/files/applications/ctu_imports/import_stacionarni_mereni/2g_o2_stacionarni/2g_o2_stacionarni.zip"
];

const DEFAULT_PUBLIC_TRANSIT_STATIC_GTFS_FEEDS: PublicTransitStaticFeedConfig[] = [
  {
    systemId: "pid",
    label: "PID statický GTFS",
    url: "https://data.pid.cz/PID_GTFS.zip"
  },
  {
    systemId: "idsjmk",
    label: "IDS JMK statický GTFS",
    url: "https://kordis-jmk.cz/gtfs/gtfs.zip"
  },
  {
    systemId: "dpmo",
    label: "DPMO Olomouc statický GTFS",
    url: "https://www.dpmo.cz/doc/dpmo-olomouc-cz.zip"
  },
  {
    systemId: "pmdp",
    label: "PMDP Plzeň statický GTFS",
    url: "https://jizdnirady.pmdp.cz/jr/gtfs"
  },
  {
    systemId: "dpmlj",
    label: "DPMLJ Liberec/Jablonec statický GTFS",
    url: "https://www.dpmlj.cz/gtfs.zip"
  }
];

const DEFAULT_PUBLIC_TRANSIT_STATIC_GEOJSON_FEEDS: PublicTransitStaticFeedConfig[] = [
  {
    systemId: "dpo_ostrava",
    label: "DPO Ostrava zastávky MHD GeoJSON",
    url: "https://mapy.ostrava.cz/opendata/data/opendata/zastavky_MHD_WGS84_gjson.zip"
  }
];

const DEFAULT_PUBLIC_CAMERA_FEEDS = [
  [
    "sps_lavdis_cameras",
    "Státní plavební správa / LAVDIS kamery",
    "waterway",
    "Státní plavební správa",
    "https://www.lavdis.cz/",
    "arcgis_lavdis",
    "https://geoportal.plavebniurad.cz/arcgis/rest/services/kamery/MapServer/0/query?where=1%3D1&outFields=*&returnGeometry=true&f=geojson&resultRecordCount=2000"
  ].join("|"),
  [
    "ostrava_traffic_cameras",
    "Dopravní kamery Ostrava",
    "traffic",
    "Statutární město Ostrava",
    "http://kamery.ostrava.cz/",
    "ostrava_asmx",
    "http://kamery.ostrava.cz/GoogleMapService.asmx/GetKamery"
  ].join("|"),
  [
    "cz_verified_origin_webcams",
    "Ověřené turistické webkamery ČR",
    "outdoor_webcam",
    "Jednotliví veřejní provozovatelé kamer v ČR",
    "https://www.webcamlive.cz/webkamery/ceska-republika/2",
    "static_json",
    "builtin:curated_outdoor_webcams_cz"
  ].join("|")
];

function parseBbox(value: string | undefined): BoundingBox | undefined {
  if (!value) {
    return undefined;
  }
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return undefined;
  }
  const [west, south, east, north] = parts as [number, number, number, number];
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
    return undefined;
  }
  return { west, south, east, north };
}

function parseStringList(value: string | undefined, fallback: string[] = []): string[] {
  const parsed = value
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return parsed && parsed.length > 0 ? parsed : fallback;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function parseFloatOr(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim() !== "" ? value : undefined;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function parseOsmPostgisBackend(value: string | undefined, connectionString: string | undefined): OsmPostgisBackend {
  const normalized = value?.trim();
  if (normalized === "local-postgis" || normalized === "patroni-postgis" || normalized === "external-postgis") {
    return normalized;
  }
  const rawUrl = connectionString?.trim();
  if (!rawUrl) {
    return "unconfigured";
  }
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (host === "osm-postgis" || host === "localhost" || host === "127.0.0.1") {
      return "local-postgis";
    }
    if (host === "haproxy.home.cz" || host.includes("patroni")) {
      return "patroni-postgis";
    }
  } catch {
    return "external-postgis";
  }
  return "external-postgis";
}
