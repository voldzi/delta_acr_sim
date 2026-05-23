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
  localAdsbAircraftJsonUrls: string[];
  ourAirportsEnabled: boolean;
  ourAirportsCsvUrl: string;
  ourAirportsCountries: string[];
  ourAirportsCacheTtlSeconds: number;
  aipAirspacesEnabled: boolean;
  aipAirspacesSourceUrl: string;
  aipAirspacesCacheTtlSeconds: number;
  uasGeozonesEnabled: boolean;
  uasGeozonesCatalogUrl: string;
  uasGeozonesLayerIds: string[];
  uasGeozonesCacheTtlSeconds: number;
  airspaceActivationEnabled: boolean;
  airspaceActivationBaseUrl: string;
  airspaceActivationCacheTtlSeconds: number;
  corsOrigins?: string[];
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
    openskyClientSecret: emptyToUndefined(process.env.OPENSKY_CLIENT_SECRET),
    localAdsbAircraftJsonUrls: parseStringList(process.env.LOCAL_ADSB_AIRCRAFT_JSON_URLS ?? process.env.LOCAL_ADSB_AIRCRAFT_JSON_URL),
    ourAirportsEnabled: parseBoolean(process.env.OURAIRPORTS_ENABLED, true),
    ourAirportsCsvUrl: process.env.OURAIRPORTS_AIRPORTS_CSV_URL ?? "https://davidmegginson.github.io/ourairports-data/airports.csv",
    ourAirportsCountries: parseStringList(process.env.OURAIRPORTS_COUNTRIES, ["CZ", "SK", "AT", "DE", "PL", "HU"]),
    ourAirportsCacheTtlSeconds: parseInteger(process.env.OURAIRPORTS_CACHE_TTL_SECONDS, 24 * 60 * 60),
    aipAirspacesEnabled: parseBoolean(process.env.AIP_AIRSPACES_ENABLED, true),
    aipAirspacesSourceUrl: process.env.AIP_AIRSPACES_SOURCE_URL ?? "https://aim.rlp.cz/eaip/html/eAIP/LK-ENR-5.1-en-GB.html",
    aipAirspacesCacheTtlSeconds: parseInteger(process.env.AIP_AIRSPACES_CACHE_TTL_SECONDS, 24 * 60 * 60),
    uasGeozonesEnabled: parseBoolean(process.env.UAS_GEOZONES_ENABLED, true),
    uasGeozonesCatalogUrl: process.env.UAS_GEOZONES_CATALOG_URL ?? "https://aim.rlp.cz/?lang=cz&p=uas-gz",
    uasGeozonesLayerIds: parseStringList(process.env.UAS_GEOZONES_LAYER_IDS, [
      "LKR314A",
      "LKR314B",
      "LKR314C",
      "LKR314D",
      "LKR314E",
      "LKR314F",
      "LKR315A",
      "LKR315B",
      "LKR319",
      "LKR320A"
    ]).map((item) => item.toUpperCase()),
    uasGeozonesCacheTtlSeconds: parseInteger(process.env.UAS_GEOZONES_CACHE_TTL_SECONDS, 24 * 60 * 60),
    airspaceActivationEnabled: parseBoolean(process.env.AIRSPACE_ACTIVATION_ENABLED, true),
    airspaceActivationBaseUrl: process.env.AIRSPACE_ACTIVATION_BASE_URL ?? "https://aup.rlp.cz/",
    airspaceActivationCacheTtlSeconds: parseInteger(process.env.AIRSPACE_ACTIVATION_CACHE_TTL_SECONDS, 5 * 60),
    corsOrigins: parseStringList(process.env.FLIGHT_DATA_CORS_ORIGINS)
  };
}

function parseSourceList(value: string | undefined): FlightDataSourceId[] {
  const allowed = new Set<FlightDataSourceId>(["mock", "adsb_lol", "opensky", "local_adsb"]);
  const parsed = (value ?? "mock")
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is FlightDataSourceId => allowed.has(item as FlightDataSourceId));
  return parsed.length > 0 ? parsed : ["mock"];
}

function parseStringList(value: string | undefined, fallback: string[] = []): string[] {
  const parsed = value
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return parsed && parsed.length > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
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
