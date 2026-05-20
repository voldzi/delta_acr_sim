import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BoundingBox, SituationDataSourceId } from "./types.js";

export interface SituationDataConfig {
  port: number;
  dataDir: string;
  enabledSources: SituationDataSourceId[];
  defaultBbox: BoundingBox;
  requestTimeoutMs: number;
  cacheTtlSeconds: number;
  staleAfterSeconds: number;
  openMeteoBaseUrl: string;
  overpassBaseUrl: string;
  overpassMaxBboxDegrees: number;
  ctuNettestUrl: string;
  pidGtfsRtVehiclePositionsUrl: string;
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
    staleAfterSeconds: parseInteger(process.env.SITUATION_DATA_STALE_AFTER_SECONDS, 900),
    openMeteoBaseUrl: process.env.OPEN_METEO_BASE_URL ?? "https://api.open-meteo.com",
    overpassBaseUrl: process.env.OVERPASS_BASE_URL ?? "https://overpass-api.de/api/interpreter",
    overpassMaxBboxDegrees: parseFloatOr(process.env.OVERPASS_MAX_BBOX_DEGREES, 1.6),
    ctuNettestUrl: process.env.CTU_NETTEST_URL ?? "https://nettest.ctu.gov.cz/RMBTStatisticServer/export/nettest-opendata_hours-048.zip",
    pidGtfsRtVehiclePositionsUrl:
      process.env.PID_GTFS_RT_VEHICLE_POSITIONS_URL ?? "https://api.golemio.cz/v2/vehiclepositions/gtfsrt/vehicle_positions.pb"
  };
}

function parseSourceList(value: string | undefined): SituationDataSourceId[] {
  const allowed = new Set<SituationDataSourceId>(["mock", "open_meteo", "osm_overpass", "ctu_nettest", "pid_gtfs_rt"]);
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
