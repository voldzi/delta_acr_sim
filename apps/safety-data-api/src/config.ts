import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BoundingBox, SafetyDataSourceId } from "./types.js";

export interface HzsIncidentFeedConfig {
  id: string;
  url: string;
  label: string;
  regionName: string;
  fallbackLon: number;
  fallbackLat: number;
  bbox: BoundingBox;
  format?: HzsIncidentFeedFormat;
}

export type HzsIncidentFeedFormat = "html" | "khk-json";

export type MunicipalAlertFeedFormat = "auto" | "rss" | "atom" | "georss" | "geojson" | "pkr-json";

export interface MunicipalAlertFeedConfig {
  id: string;
  url: string;
  label: string;
  authorityName: string;
  fallbackLon: number;
  fallbackLat: number;
  bbox: BoundingBox;
  format: MunicipalAlertFeedFormat;
}

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
  chmiOrpCodelistUrl: string;
  chmiHydroMetadataUrl: string;
  chmiHydroNowBaseUrl: string;
  chmiHydroRecentBaseUrl: string;
  chmiHydroMaxStations: number;
  chmiHydroStationCacheMaxEntries: number;
  chmiHydroCurrentSnapshotCacheTtlSeconds: number;
  chmiHydroDetailDefaultPastHours: number;
  chmiHydroDetailForecastHours: number;
  chmiHydroDetailBackfillDays: number;
  nasaFirmsMapKey?: string;
  nasaFirmsAreaBaseUrl: string;
  nasaFirmsSource: string;
  nasaFirmsDayRange: number;
  gdacsRssUrl: string;
  gdacsCacheTtlSeconds: number;
  hzsIncidentFeeds: HzsIncidentFeedConfig[];
  hzsIncidentsCacheTtlSeconds: number;
  hzsIncidentsDetailCacheTtlSeconds: number;
  hzsIncidentsMaxActiveDetails: number;
  municipalAlertFeeds: MunicipalAlertFeedConfig[];
  municipalAlertsCacheTtlSeconds: number;
  roadSrtiLodSparqlUrl: string;
  roadSrtiLodCacheTtlSeconds: number;
  roadSrtiLodMaxRecords: number;
  adminBoundaryConnectionString?: string;
  adminBoundaryTable: string;
  adminBoundaryCacheTtlSeconds: number;
  corsOrigins?: string[];
}

export async function loadConfig(): Promise<SafetyDataConfig> {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const dataDir = resolve(process.env.SAFETY_DATA_DIR ?? `${projectRoot}/data/safety-data`);
  await mkdir(dataDir, { recursive: true });
  const cacheTtlSeconds = parseInteger(process.env.SAFETY_DATA_CACHE_TTL_SECONDS, 300);
  const cacheMaxEntries = parseInteger(process.env.SAFETY_DATA_CACHE_MAX_ENTRIES, 512);
  const chmiHydroMaxStations = parseInteger(process.env.CHMI_HYDRO_MAX_STATIONS, 600);

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
    cacheTtlSeconds,
    staleIfErrorSeconds: parseInteger(process.env.SAFETY_DATA_STALE_IF_ERROR_SECONDS, 3600),
    cacheMaxEntries,
    staleAfterSeconds: parseInteger(process.env.SAFETY_DATA_STALE_AFTER_SECONDS, 3600),
    chmiAlertsCapBaseUrl: process.env.CHMI_ALERTS_CAP_BASE_URL ?? "https://opendata.chmi.cz/meteorology/weather/alerts/cap/",
    chmiOrpCodelistUrl:
      process.env.CHMI_ORP_CODELIST_URL ??
      "https://apl2.czso.cz/iSMS/do_cis_export?cisjaz=203&cisvaz=61_88&format=2&kodcis=65&separator=,&typdat=1",
    chmiHydroMetadataUrl: process.env.CHMI_HYDRO_METADATA_URL ?? "https://opendata.chmi.cz/hydrology/now/metadata/meta1.json",
    chmiHydroNowBaseUrl: process.env.CHMI_HYDRO_NOW_BASE_URL ?? "https://opendata.chmi.cz/hydrology/now/data",
    chmiHydroRecentBaseUrl: process.env.CHMI_HYDRO_RECENT_BASE_URL ?? "https://opendata.chmi.cz/hydrology/recent/data",
    chmiHydroMaxStations,
    chmiHydroStationCacheMaxEntries: parseInteger(
      process.env.CHMI_HYDRO_STATION_CACHE_MAX_ENTRIES,
      Math.max(cacheMaxEntries, chmiHydroMaxStations + 128)
    ),
    chmiHydroCurrentSnapshotCacheTtlSeconds: parseInteger(
      process.env.CHMI_HYDRO_CURRENT_SNAPSHOT_CACHE_TTL_SECONDS,
      Math.max(300, cacheTtlSeconds)
    ),
    chmiHydroDetailDefaultPastHours: parseInteger(process.env.CHMI_HYDRO_DETAIL_DEFAULT_PAST_HOURS, 168),
    chmiHydroDetailForecastHours: parseInteger(process.env.CHMI_HYDRO_DETAIL_FORECAST_HOURS, 72),
    chmiHydroDetailBackfillDays: parseInteger(process.env.CHMI_HYDRO_DETAIL_BACKFILL_DAYS, 7),
    nasaFirmsMapKey: process.env.NASA_FIRMS_MAP_KEY,
    nasaFirmsAreaBaseUrl: process.env.NASA_FIRMS_AREA_BASE_URL ?? "https://firms.modaps.eosdis.nasa.gov/api/area/csv",
    nasaFirmsSource: process.env.NASA_FIRMS_SOURCE ?? "VIIRS_SNPP_NRT",
    nasaFirmsDayRange: parseInteger(process.env.NASA_FIRMS_DAY_RANGE, 1),
    gdacsRssUrl: process.env.GDACS_RSS_URL ?? "https://www.gdacs.org/xml/rss.xml",
    gdacsCacheTtlSeconds: parseInteger(process.env.GDACS_CACHE_TTL_SECONDS, 900),
    hzsIncidentFeeds: parseHzsIncidentFeeds(process.env.HZS_INCIDENTS_FEEDS),
    hzsIncidentsCacheTtlSeconds: parseInteger(process.env.HZS_INCIDENTS_CACHE_TTL_SECONDS, 180),
    hzsIncidentsDetailCacheTtlSeconds: parseInteger(process.env.HZS_INCIDENTS_DETAIL_CACHE_TTL_SECONDS, 1800),
    hzsIncidentsMaxActiveDetails: parseInteger(process.env.HZS_INCIDENTS_MAX_ACTIVE_DETAILS, 50),
    municipalAlertFeeds: parseMunicipalAlertFeeds(process.env.MUNICIPAL_ALERT_FEEDS),
    municipalAlertsCacheTtlSeconds: parseInteger(process.env.MUNICIPAL_ALERTS_CACHE_TTL_SECONDS, 300),
    roadSrtiLodSparqlUrl: process.env.ROAD_SRTI_LOD_SPARQL_URL ?? "https://lod.tamtamresearch.com/sparql/",
    roadSrtiLodCacheTtlSeconds: parseInteger(process.env.SAFETY_DATA_ROAD_SRTI_CACHE_TTL_SECONDS, 300),
    roadSrtiLodMaxRecords: parseInteger(process.env.ROAD_SRTI_LOD_MAX_RECORDS, 1500),
    adminBoundaryConnectionString: emptyToUndefined(process.env.SAFETY_DATA_ADMIN_BOUNDARY_DATABASE_URL) ?? emptyToUndefined(process.env.OSM_POSTGIS_DATABASE_URL),
    adminBoundaryTable: process.env.SAFETY_DATA_ADMIN_BOUNDARY_TABLE ?? "public.osm_admin_boundary",
    adminBoundaryCacheTtlSeconds: parseInteger(process.env.SAFETY_DATA_ADMIN_BOUNDARY_CACHE_TTL_SECONDS, 86_400),
    corsOrigins: parseStringList(process.env.SAFETY_DATA_CORS_ORIGINS)
  };
}

function parseSourceList(value: string | undefined): SafetyDataSourceId[] {
  const allowed = new Set<SafetyDataSourceId>([
    "mock",
    "chmi_alerts",
    "chmi_hydro",
    "nasa_firms",
    "gdacs_alerts",
    "hzs_incidents",
    "municipal_alerts",
    "road_srti_lod",
    "admin_boundaries"
  ]);
  const parsed = (value ?? "mock")
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is SafetyDataSourceId => allowed.has(item as SafetyDataSourceId));
  return parsed.length > 0 ? parsed : ["mock"];
}

function parseHzsIncidentFeeds(value: string | undefined): HzsIncidentFeedConfig[] {
  const fallback: HzsIncidentFeedConfig[] = [
    {
      id: "hzs-pardubice",
      url: "https://www.hzspa.cz/vyjezdy/aktualni-vyjezdy.php",
      label: "HZS Pardubického kraje - aktuální výjezdy",
      regionName: "Pardubický kraj",
      fallbackLon: 15.78,
      fallbackLat: 49.94,
      bbox: { west: 15.3, south: 49.45, east: 16.95, north: 50.35 },
      format: "html"
    },
    {
      id: "hzs-kralovehradecky",
      url: "https://udalostikhk.hzscr.cz/api/",
      label: "HZS Královéhradeckého kraje - veřejné události",
      regionName: "Královéhradecký kraj",
      fallbackLon: 15.83,
      fallbackLat: 50.21,
      bbox: { west: 15.05, south: 49.9, east: 16.75, north: 50.85 },
      format: "khk-json"
    }
  ];
  const raw = emptyToUndefined(value);
  if (!raw) {
    return fallback;
  }
  const parsed = raw
    .split(";")
    .map((entry, index) => parseHzsIncidentFeed(entry, index))
    .filter((entry): entry is HzsIncidentFeedConfig => Boolean(entry));
  return parsed.length > 0 ? parsed : fallback;
}

function parseMunicipalAlertFeeds(value: string | undefined): MunicipalAlertFeedConfig[] {
  const raw = emptyToUndefined(value);
  if (!raw) {
    return defaultMunicipalAlertFeeds();
  }
  return raw
    .split(";")
    .map((entry, index) => parseMunicipalAlertFeed(entry, index))
    .filter((entry): entry is MunicipalAlertFeedConfig => Boolean(entry));
}

function defaultMunicipalAlertFeeds(): MunicipalAlertFeedConfig[] {
  return [
    {
      id: "pkr-ustecky-jpo",
      url: "https://pkr.kr-ustecky.cz/pkr/zasahy-jednotek-pozarni-ochrany/?fmt=json",
      label: "PKR Ústecký kraj - zásahy JPO",
      authorityName: "Ústecký kraj",
      fallbackLon: 13.82,
      fallbackLat: 50.52,
      bbox: { west: 12.8, south: 50.05, east: 14.7, north: 51.1 },
      format: "pkr-json"
    },
    {
      id: "pkr-liberecky-udalosti",
      url: "https://pkr.kraj-lbc.cz/pkr/probihajici-udalosti/?fmt=json",
      label: "PKR Liberecký kraj - probíhající události",
      authorityName: "Liberecký kraj",
      fallbackLon: 15.05,
      fallbackLat: 50.72,
      bbox: { west: 14.25, south: 50.45, east: 15.65, north: 51.1 },
      format: "pkr-json"
    },
    {
      id: "pkr-stredocesky-aktuality",
      url: "https://pkr.kr-stredocesky.cz/pkr/aktuality/feed.xml",
      label: "PKR Středočeský kraj - aktuality",
      authorityName: "Středočeský kraj",
      fallbackLon: 14.43,
      fallbackLat: 50.08,
      bbox: { west: 13.35, south: 49.45, east: 15.65, north: 50.75 },
      format: "rss"
    },
    {
      id: "pkr-stredocesky-jpo",
      url: "https://pkr.kr-stredocesky.cz/pkr/zasahy-jpo/feed.xml",
      label: "PKR Středočeský kraj - zásahy JPO",
      authorityName: "Středočeský kraj",
      fallbackLon: 14.43,
      fallbackLat: 50.08,
      bbox: { west: 13.35, south: 49.45, east: 15.65, north: 50.75 },
      format: "rss"
    },
    {
      id: "olkraj-krizove-rizeni",
      url: "https://www.olkraj.cz/rss/6",
      label: "Olomoucký kraj - krizové řízení",
      authorityName: "Olomoucký kraj",
      fallbackLon: 17.25,
      fallbackLat: 49.59,
      bbox: { west: 16.65, south: 49.25, east: 17.95, north: 50.45 },
      format: "rss"
    },
    {
      id: "bruntal-uredni-rss",
      url: "https://www.mubruntal.cz/rss",
      label: "Město Bruntál - oficiální RSS",
      authorityName: "Město Bruntál",
      fallbackLon: 17.4647,
      fallbackLat: 49.9884,
      bbox: { west: 17.2, south: 49.78, east: 17.75, north: 50.2 },
      format: "rss"
    },
    {
      id: "krnov-aktuality-rss",
      url: "https://www.krnov.cz/rss",
      label: "Město Krnov - oficiální RSS",
      authorityName: "Město Krnov",
      fallbackLon: 17.7039,
      fallbackLat: 50.0897,
      bbox: { west: 17.5, south: 49.95, east: 17.9, north: 50.2 },
      format: "rss"
    },
    {
      id: "vrbno-aktuality-rss",
      url: "https://www.vrbnopp.cz/rss.xml",
      label: "Vrbno pod Pradědem - oficiální RSS",
      authorityName: "Město Vrbno pod Pradědem",
      fallbackLon: 17.3833,
      fallbackLat: 50.1206,
      bbox: { west: 17.22, south: 50.0, east: 17.55, north: 50.23 },
      format: "rss"
    }
  ];
}

function parseMunicipalAlertFeed(value: string, index: number): MunicipalAlertFeedConfig | undefined {
  const parts = value.split("|").map((part) => part.trim());
  const [url, label, authorityName, lonRaw, latRaw, bboxRaw, idRaw, formatRaw] = parts;
  if (!url) {
    return undefined;
  }
  const lon = Number(lonRaw);
  const lat = Number(latRaw);
  const bbox = parseBbox(bboxRaw);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !bbox) {
    return undefined;
  }
  const format = parseMunicipalAlertFeedFormat(formatRaw);
  return {
    id: idRaw || `municipal-${index + 1}`,
    url,
    label: label || `Municipal crisis feed ${index + 1}`,
    authorityName: authorityName || label || `Municipal authority ${index + 1}`,
    fallbackLon: lon,
    fallbackLat: lat,
    bbox,
    format
  };
}

function parseMunicipalAlertFeedFormat(value: string | undefined): MunicipalAlertFeedFormat {
  const normalized = value?.trim().toLowerCase();
  return normalized === "rss" || normalized === "atom" || normalized === "georss" || normalized === "geojson" || normalized === "pkr-json"
    ? normalized
    : "auto";
}

function parseHzsIncidentFeed(value: string, index: number): HzsIncidentFeedConfig | undefined {
  const parts = value.split("|").map((part) => part.trim());
  const [url, label, regionName, lonRaw, latRaw, bboxRaw, idRaw, formatRaw] = parts;
  if (!url) {
    return undefined;
  }
  const lon = Number(lonRaw);
  const lat = Number(latRaw);
  const bbox = parseBbox(bboxRaw);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !bbox) {
    return undefined;
  }
  return {
    id: idRaw || `hzs-${index + 1}`,
    url,
    label: label || `HZS incident feed ${index + 1}`,
    regionName: regionName || label || `HZS region ${index + 1}`,
    fallbackLon: lon,
    fallbackLat: lat,
    bbox,
    format: parseHzsIncidentFeedFormat(formatRaw)
  };
}

function parseHzsIncidentFeedFormat(value: string | undefined): HzsIncidentFeedFormat {
  const normalized = value?.trim().toLowerCase();
  return normalized === "khk-json" ? "khk-json" : "html";
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
