import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BoundingBox, OsmPostgisBackend, SituationDataSourceId } from "./types.js";

export interface SituationDataConfig {
  port: number;
  dataDir: string;
  enabledSources: SituationDataSourceId[];
  defaultBbox: BoundingBox;
  requestTimeoutMs: number;
  cacheTtlSeconds: number;
  staleIfErrorSeconds: number;
  cacheMaxEntries: number;
  bboxCachePaddingDegrees: number;
  staleAfterSeconds: number;
  openMeteoBaseUrl: string;
  openMeteoCacheTtlSeconds: number;
  openMeteoGridDegrees: number;
  mobileCoverageCacheTtlSeconds: number;
  mobileCoverageResolutionM: number;
  mobileCoverageMaxCells: number;
  mobileCoverageModelVersion: string;
  mobileCoverageDemSource: string;
  mobileCoverageTerrainAware: boolean;
  mobileCoverageAntennaHeightM: number;
  osmPostgisConnectionString?: string;
  osmPostgisBackend: OsmPostgisBackend;
  osmPostgisTable: string;
  osmPostgisCacheTtlSeconds: number;
  overpassBaseUrl: string;
  overpassCacheTtlSeconds: number;
  overpassMaxBboxDegrees: number;
  ctuNettestUrl: string;
  pidGtfsRtVehiclePositionsUrl: string;
  safetyDataBaseUrl: string;
  safetyDataCacheTtlSeconds: number;
  aviationWeatherBaseUrl: string;
  aviationWeatherCacheTtlSeconds: number;
  ardosPartnerBaseUrl?: string;
  ardosPartnerToken?: string;
  ardosPartnerCacheTtlSeconds: number;
  demEnabled: boolean;
  demDatasetId: string;
  demPostgisConnectionString?: string;
  demLocalCacheDir: string;
  demSeaweedfsEndpoint?: string;
  demSeaweedfsBucket: string;
  demSeaweedfsPrefix: string;
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
    bboxCachePaddingDegrees: parseFloatOr(process.env.SITUATION_DATA_BBOX_CACHE_PADDING_DEGREES, 0.18),
    staleAfterSeconds: parseInteger(process.env.SITUATION_DATA_STALE_AFTER_SECONDS, 900),
    openMeteoBaseUrl: process.env.OPEN_METEO_BASE_URL ?? "https://api.open-meteo.com",
    openMeteoCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_OPEN_METEO_CACHE_TTL_SECONDS, 600),
    openMeteoGridDegrees: parseFloatOr(process.env.SITUATION_DATA_OPEN_METEO_GRID_DEGREES, 0.05),
    mobileCoverageCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_MOBILE_COVERAGE_CACHE_TTL_SECONDS, 21600),
    mobileCoverageResolutionM: parseInteger(process.env.MOBILE_COVERAGE_RESOLUTION_M, 1000),
    mobileCoverageMaxCells: parseInteger(process.env.MOBILE_COVERAGE_MAX_CELLS, 1000),
    mobileCoverageModelVersion: process.env.MOBILE_COVERAGE_MODEL_VERSION ?? "coverage-v1",
    mobileCoverageDemSource: process.env.MOBILE_COVERAGE_DEM_SOURCE ?? "not-used-phase-1",
    mobileCoverageTerrainAware: parseBoolean(process.env.MOBILE_COVERAGE_TERRAIN_AWARE, false),
    mobileCoverageAntennaHeightM: parseInteger(process.env.MOBILE_COVERAGE_DEFAULT_ANTENNA_HEIGHT_M, 30),
    osmPostgisConnectionString: emptyToUndefined(process.env.OSM_POSTGIS_DATABASE_URL),
    osmPostgisBackend: parseOsmPostgisBackend(process.env.OSM_POSTGIS_BACKEND, process.env.OSM_POSTGIS_DATABASE_URL),
    osmPostgisTable: process.env.OSM_POSTGIS_TABLE ?? "public.osm_poi",
    osmPostgisCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_OSM_POSTGIS_CACHE_TTL_SECONDS, 21600),
    overpassBaseUrl: process.env.OVERPASS_BASE_URL ?? "https://overpass-api.de/api/interpreter",
    overpassCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_OVERPASS_CACHE_TTL_SECONDS, 21600),
    overpassMaxBboxDegrees: parseFloatOr(process.env.OVERPASS_MAX_BBOX_DEGREES, 1.6),
    ctuNettestUrl: process.env.CTU_NETTEST_URL ?? "https://nettest.ctu.gov.cz/RMBTStatisticServer/export/nettest-opendata_hours-048.zip",
    pidGtfsRtVehiclePositionsUrl:
      process.env.PID_GTFS_RT_VEHICLE_POSITIONS_URL ?? "https://api.golemio.cz/v2/vehiclepositions/gtfsrt/vehicle_positions.pb",
    safetyDataBaseUrl: process.env.SAFETY_DATA_BASE_URL ?? "http://127.0.0.1:4030",
    safetyDataCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_SAFETY_CACHE_TTL_SECONDS, 300),
    aviationWeatherBaseUrl: process.env.AVIATION_WEATHER_BASE_URL ?? "https://aviationweather.gov",
    aviationWeatherCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_AVIATION_WEATHER_CACHE_TTL_SECONDS, 600),
    ardosPartnerBaseUrl: emptyToUndefined(process.env.ARDOS_PARTNER_BASE_URL),
    ardosPartnerToken: emptyToUndefined(process.env.ARDOS_PARTNER_TOKEN),
    ardosPartnerCacheTtlSeconds: parseInteger(process.env.SITUATION_DATA_ARDOS_CACHE_TTL_SECONDS, 15),
    demEnabled: parseBoolean(process.env.DEM_ENABLED, false),
    demDatasetId: process.env.DEM_DATASET_ID ?? "copernicus-glo30-cz",
    demPostgisConnectionString: emptyToUndefined(process.env.DEM_POSTGIS_DATABASE_URL) ?? emptyToUndefined(process.env.OSM_POSTGIS_DATABASE_URL),
    demLocalCacheDir: process.env.DEM_LOCAL_CACHE_DIR ?? "/dem-cache",
    demSeaweedfsEndpoint: emptyToUndefined(process.env.DEM_SEAWEEDFS_S3_ENDPOINT),
    demSeaweedfsBucket: process.env.DEM_SEAWEEDFS_BUCKET ?? "sim-dem",
    demSeaweedfsPrefix: trimSlashes(process.env.DEM_SEAWEEDFS_PREFIX ?? "copernicus-glo30/2021")
  };
}

function parseSourceList(value: string | undefined): SituationDataSourceId[] {
  const allowed = new Set<SituationDataSourceId>([
    "mock",
    "open_meteo",
    "mobile_coverage_model",
    "osm_postgis",
    "osm_overpass",
    "ctu_nettest",
    "pid_gtfs_rt",
    "safety_data",
    "aviation_weather",
    "ardos_partner"
  ]);
  const parsed = (value ?? "mock")
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is SituationDataSourceId => allowed.has(item as SituationDataSourceId));
  return parsed.length > 0 ? parsed : ["mock"];
}

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
