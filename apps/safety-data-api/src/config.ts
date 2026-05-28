import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BoundingBox, SafetyDataSourceId } from "./types.js";

export interface SafetyDataConfig {
  port: number;
  dataDir: string;
  enabledSources: SafetyDataSourceId[];
  defaultBbox: BoundingBox;
  requestTimeoutMs: number;
  cacheTtlSeconds: number;
  staleIfErrorSeconds: number;
  cacheMaxEntries: number;
  staleAfterSeconds: number;
  chmiAlertsCapBaseUrl: string;
  chmiHydroMetadataUrl: string;
  chmiHydroNowBaseUrl: string;
  chmiHydroMaxStations: number;
  nasaFirmsMapKey?: string;
  nasaFirmsAreaBaseUrl: string;
  nasaFirmsSource: string;
  nasaFirmsDayRange: number;
  adminBoundaryConnectionString?: string;
  adminBoundaryTable: string;
  adminBoundaryCacheTtlSeconds: number;
  corsOrigins?: string[];
}

export async function loadConfig(): Promise<SafetyDataConfig> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const dataDir = resolve(process.env.SAFETY_DATA_DIR ?? `${projectRoot}/data/safety-data`);
  await mkdir(dataDir, { recursive: true });

  return {
    port: parseInteger(process.env.SAFETY_DATA_API_PORT, 4030),
    dataDir,
    enabledSources: parseSourceList(process.env.SAFETY_DATA_ENABLED_SOURCES),
    defaultBbox: parseBbox(process.env.SAFETY_DATA_DEFAULT_BBOX) ?? {
      west: 11.8,
      south: 48.5,
      east: 19.2,
      north: 51.2
    },
    requestTimeoutMs: parseInteger(process.env.SAFETY_DATA_REQUEST_TIMEOUT_MS, 8000),
    cacheTtlSeconds: parseInteger(process.env.SAFETY_DATA_CACHE_TTL_SECONDS, 300),
    staleIfErrorSeconds: parseInteger(process.env.SAFETY_DATA_STALE_IF_ERROR_SECONDS, 3600),
    cacheMaxEntries: parseInteger(process.env.SAFETY_DATA_CACHE_MAX_ENTRIES, 512),
    staleAfterSeconds: parseInteger(process.env.SAFETY_DATA_STALE_AFTER_SECONDS, 3600),
    chmiAlertsCapBaseUrl: process.env.CHMI_ALERTS_CAP_BASE_URL ?? "https://opendata.chmi.cz/meteorology/weather/alerts/cap/",
    chmiHydroMetadataUrl: process.env.CHMI_HYDRO_METADATA_URL ?? "https://opendata.chmi.cz/hydrology/historical/metadata/meta1.json",
    chmiHydroNowBaseUrl: process.env.CHMI_HYDRO_NOW_BASE_URL ?? "https://opendata.chmi.cz/hydrology/now/data",
    chmiHydroMaxStations: parseInteger(process.env.CHMI_HYDRO_MAX_STATIONS, 80),
    nasaFirmsMapKey: process.env.NASA_FIRMS_MAP_KEY,
    nasaFirmsAreaBaseUrl: process.env.NASA_FIRMS_AREA_BASE_URL ?? "https://firms.modaps.eosdis.nasa.gov/api/area/csv",
    nasaFirmsSource: process.env.NASA_FIRMS_SOURCE ?? "VIIRS_SNPP_NRT",
    nasaFirmsDayRange: parseInteger(process.env.NASA_FIRMS_DAY_RANGE, 1),
    adminBoundaryConnectionString: emptyToUndefined(process.env.SAFETY_DATA_ADMIN_BOUNDARY_DATABASE_URL) ?? emptyToUndefined(process.env.OSM_POSTGIS_DATABASE_URL),
    adminBoundaryTable: process.env.SAFETY_DATA_ADMIN_BOUNDARY_TABLE ?? "public.osm_admin_boundary",
    adminBoundaryCacheTtlSeconds: parseInteger(process.env.SAFETY_DATA_ADMIN_BOUNDARY_CACHE_TTL_SECONDS, 86_400),
    corsOrigins: parseStringList(process.env.SAFETY_DATA_CORS_ORIGINS)
  };
}

function parseSourceList(value: string | undefined): SafetyDataSourceId[] {
  const allowed = new Set<SafetyDataSourceId>(["mock", "chmi_alerts", "chmi_hydro", "nasa_firms", "admin_boundaries"]);
  const parsed = (value ?? "mock")
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is SafetyDataSourceId => allowed.has(item as SafetyDataSourceId));
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

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
