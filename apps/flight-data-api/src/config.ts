import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FlightDataSourceId } from "./types.js";

export interface FlightDataConfig {
  port: number;
  dataDir: string;
  enabledSources: FlightDataSourceId[];
  defaultLat: number;
  defaultLon: number;
  defaultRadiusNm: number;
  requestTimeoutMs: number;
  cacheTtlSeconds: number;
  staleIfErrorSeconds: number;
  cacheMaxEntries: number;
  staleAfterSeconds: number;
  adsbLolBaseUrl: string;
  openskyBaseUrl: string;
  openskyAuthUrl: string;
  openskyAccessToken?: string;
  openskyClientId?: string;
  openskyClientSecret?: string;
}

export async function loadConfig(): Promise<FlightDataConfig> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const dataDir = resolve(process.env.FLIGHT_DATA_DIR ?? `${projectRoot}/data/flight-data`);
  await mkdir(dataDir, { recursive: true });

  return {
    port: parseInteger(process.env.FLIGHT_DATA_API_PORT, 4010),
    dataDir,
    enabledSources: parseSourceList(process.env.FLIGHT_DATA_ENABLED_SOURCES),
    defaultLat: parseFloatOr(process.env.FLIGHT_DATA_DEFAULT_LAT, 50.1008),
    defaultLon: parseFloatOr(process.env.FLIGHT_DATA_DEFAULT_LON, 14.2632),
    defaultRadiusNm: parseInteger(process.env.FLIGHT_DATA_DEFAULT_RADIUS_NM, 120),
    requestTimeoutMs: parseInteger(process.env.FLIGHT_DATA_REQUEST_TIMEOUT_MS, 6000),
    cacheTtlSeconds: parseInteger(process.env.FLIGHT_DATA_CACHE_TTL_SECONDS, 15),
    staleIfErrorSeconds: parseInteger(process.env.FLIGHT_DATA_STALE_IF_ERROR_SECONDS, 60),
    cacheMaxEntries: parseInteger(process.env.FLIGHT_DATA_CACHE_MAX_ENTRIES, 512),
    staleAfterSeconds: parseInteger(process.env.FLIGHT_DATA_STALE_AFTER_SECONDS, 120),
    adsbLolBaseUrl: process.env.ADSB_LOL_BASE_URL ?? "https://api.adsb.lol",
    openskyBaseUrl: process.env.OPENSKY_BASE_URL ?? "https://opensky-network.org/api",
    openskyAuthUrl:
      process.env.OPENSKY_AUTH_URL ?? "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token",
    openskyAccessToken: emptyToUndefined(process.env.OPENSKY_ACCESS_TOKEN),
    openskyClientId: emptyToUndefined(process.env.OPENSKY_CLIENT_ID),
    openskyClientSecret: emptyToUndefined(process.env.OPENSKY_CLIENT_SECRET)
  };
}

function parseSourceList(value: string | undefined): FlightDataSourceId[] {
  const allowed = new Set<FlightDataSourceId>(["mock", "adsb_lol", "opensky"]);
  const parsed = (value ?? "mock")
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is FlightDataSourceId => allowed.has(item as FlightDataSourceId));
  return parsed.length > 0 ? parsed : ["mock"];
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

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim() !== "" ? value : undefined;
}
