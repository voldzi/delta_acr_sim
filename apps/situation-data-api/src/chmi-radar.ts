import type { BoundingBox, SituationLayerId, SituationSeverity } from "./types.js";

export const CHMI_RADAR_LAYERS = [
  "weather_radar_reflectivity",
  "weather_radar_precipitation",
  "weather_radar_nowcast",
  "weather_thunderstorm_risk"
] satisfies SituationLayerId[];

export const CHMI_RADAR_DATA_BBOX: BoundingBox = { west: 11.267, south: 48.047, east: 19.624, north: 51.458 };
export const CHMI_RADAR_IMAGE_BBOX: BoundingBox = { west: 11.267, south: 48.047, east: 20.77, north: 52.167 };

const CHMI_RADAR_REFLECTIVITY_LEGEND_URL = "https://opendata.chmi.cz/meteorology/weather/radar/scl/scl-dbzmmh.png";
const CHMI_RADAR_PRECIPITATION_LEGEND_URL = "https://opendata.chmi.cz/meteorology/weather/radar/scl/scl-mm.png";

export interface ChmiRadarAsset {
  href: string;
  url: string;
  observedAt: string;
}

export interface ChmiRadarProductDefinition {
  productId: string;
  layer: SituationLayerId;
  category: string;
  label: string;
  description: string;
  indexPath: string;
  filePattern: RegExp;
  contentType: string;
  hdfIndexPath?: string;
  hdfFilePattern?: RegExp;
  legendUrl?: string;
  updateCadenceSeconds: number;
  validForSeconds: number;
  styleHint: string;
  severity: SituationSeverity;
  confidence: number;
  forecastArchive: boolean;
  forecastHorizonMinutes?: number;
  basis: string[];
}

export function joinUrl(baseUrl: string, href: string): string {
  return new URL(href, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

export function chmiRadarProductDefinitions(): ChmiRadarProductDefinition[] {
  return [
    {
      productId: "maxz",
      layer: "weather_radar_reflectivity",
      category: "weather_radar_reflectivity",
      label: "ČHMÚ radar MAX_Z",
      description: "Maximum radar reflectivity over the Czech Republic territory.",
      indexPath: "maxz/png/",
      filePattern: /^pacz2gmaps3\.z_max3d\.\d{8}\.\d{4}\.0\.png$/,
      contentType: "image/png",
      hdfIndexPath: "maxz/hdf5/",
      hdfFilePattern: /^T_PABV23_C_OKPR_\d{14}\.hdf$/,
      legendUrl: CHMI_RADAR_REFLECTIVITY_LEGEND_URL,
      updateCadenceSeconds: 300,
      validForSeconds: 900,
      styleHint: "weather-radar-reflectivity-v1",
      severity: "info",
      confidence: 0.9,
      forecastArchive: false,
      basis: ["chmi_radar_maxz_png", "chmi_radar_hdf5_metadata"]
    },
    {
      productId: "pseudocappi2km",
      layer: "weather_radar_precipitation",
      category: "weather_radar_precipitation_intensity",
      label: "ČHMÚ radar PseudoCAPPI 2 km",
      description: "Radar reflectivity at 2 km constant altitude, used for surface precipitation intensity estimate.",
      indexPath: "pseudocappi2km/png/",
      filePattern: /^pacz2gmaps3\.z_cappi020\.\d{8}\.\d{4}\.0\.png$/,
      contentType: "image/png",
      hdfIndexPath: "pseudocappi2km/hdf5/",
      hdfFilePattern: /^T_PANV23_C_OKPR_\d{14}\.hdf$/,
      legendUrl: CHMI_RADAR_REFLECTIVITY_LEGEND_URL,
      updateCadenceSeconds: 300,
      validForSeconds: 900,
      styleHint: "weather-radar-precipitation-v1",
      severity: "info",
      confidence: 0.88,
      forecastArchive: false,
      basis: ["chmi_radar_pseudocappi2km_png", "chmi_radar_hdf5_metadata"]
    },
    {
      productId: "merge1h",
      layer: "weather_radar_precipitation",
      category: "weather_radar_precipitation_1h",
      label: "ČHMÚ MERGE 1h precipitation",
      description: "Merged 1h precipitation estimate from radar and rain gauges.",
      indexPath: "merge1h/png/",
      filePattern: /^pacz2gmaps3\.merge\.\d{8}\.\d{4}\.60\.png$/,
      contentType: "image/png",
      hdfIndexPath: "merge1h/hdf5/",
      hdfFilePattern: /^T_PASV23_C_OKPR_\d{14}\.hdf$/,
      legendUrl: CHMI_RADAR_PRECIPITATION_LEGEND_URL,
      updateCadenceSeconds: 600,
      validForSeconds: 1800,
      styleHint: "weather-radar-precipitation-1h-v1",
      severity: "info",
      confidence: 0.9,
      forecastArchive: false,
      basis: ["chmi_radar_merge1h_png", "chmi_rain_gauge_kriging_context"]
    },
    {
      productId: "fct_maxz",
      layer: "weather_radar_nowcast",
      category: "weather_radar_nowcast_reflectivity",
      label: "ČHMÚ radar MAX_Z nowcast",
      description: "Extrapolation forecast archive for maximum radar reflectivity, +10 to +60 minutes.",
      indexPath: "fct_maxz/png/",
      filePattern: /^pacz2gmaps3\.fct_z_max\.\d{8}\.\d{4}\.ft60s10\.tar$/,
      contentType: "application/x-tar",
      legendUrl: CHMI_RADAR_REFLECTIVITY_LEGEND_URL,
      updateCadenceSeconds: 300,
      validForSeconds: 3600,
      styleHint: "weather-radar-nowcast-v1",
      severity: "info",
      confidence: 0.72,
      forecastArchive: true,
      forecastHorizonMinutes: 60,
      basis: ["chmi_radar_cotrec_nowcast", "forecast_archive_metadata"]
    },
    {
      productId: "fct_pseudocappi2km",
      layer: "weather_radar_nowcast",
      category: "weather_radar_nowcast_precipitation",
      label: "ČHMÚ PseudoCAPPI 2 km nowcast",
      description: "Extrapolation forecast archive for PseudoCAPPI 2 km, +10 to +60 minutes.",
      indexPath: "fct_pseudocappi2km/png/",
      filePattern: /^pacz2gmaps3\.fct_z_cappi020\.\d{8}\.\d{4}\.ft60s10\.tar$/,
      contentType: "application/x-tar",
      legendUrl: CHMI_RADAR_REFLECTIVITY_LEGEND_URL,
      updateCadenceSeconds: 300,
      validForSeconds: 3600,
      styleHint: "weather-radar-nowcast-v1",
      severity: "info",
      confidence: 0.7,
      forecastArchive: true,
      forecastHorizonMinutes: 60,
      basis: ["chmi_radar_cotrec_nowcast", "forecast_archive_metadata"]
    },
    {
      productId: "thunderstorm_risk",
      layer: "weather_thunderstorm_risk",
      category: "weather_thunderstorm_risk",
      label: "ČHMÚ radar thunderstorm context",
      description: "Radar context for convective cores from MAX_Z masked PNG and EchoTop HDF5 metadata. No raw lightning strikes.",
      indexPath: "maxz/png_masked/",
      filePattern: /^pacz2gmaps3\.z_max3d\.\d{8}\.\d{4}\.0\.png$/,
      contentType: "image/png",
      hdfIndexPath: "echotop/hdf5/",
      hdfFilePattern: /^T_PADV23_C_OKPR_\d{14}\.hdf$/,
      legendUrl: CHMI_RADAR_REFLECTIVITY_LEGEND_URL,
      updateCadenceSeconds: 300,
      validForSeconds: 900,
      styleHint: "weather-thunderstorm-risk-v1",
      severity: "advisory",
      confidence: 0.68,
      forecastArchive: false,
      basis: ["chmi_radar_maxz_masked_png", "chmi_radar_echotop_hdf5", "no_public_raw_lightning_feed"]
    }
  ];
}

export function chmiRadarHrefsFromIndex(indexHtml: string, pattern: RegExp): string[] {
  return hrefsFromHtmlIndex(indexHtml)
    .map((href) => href.split("/").pop() ?? href)
    .filter((href) => pattern.test(href) && parseChmiRadarTimestampFromHref(href))
    .sort((a, b) => Date.parse(parseChmiRadarTimestampFromHref(b) ?? "") - Date.parse(parseChmiRadarTimestampFromHref(a) ?? ""));
}

export function latestChmiRadarHrefFromIndex(indexHtml: string, pattern: RegExp): string | undefined {
  return chmiRadarHrefsFromIndex(indexHtml, pattern)[0];
}

export function parseChmiRadarTimestampFromHref(href: string): string | undefined {
  const pngOrTar = href.match(/(\d{8})\.(\d{4})/);
  const date = pngOrTar?.[1];
  const time = pngOrTar?.[2];
  if (date && time) {
    return parseTimestamp(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:00Z`);
  }
  const hdf = href.match(/_(\d{14})\.hdf$/);
  const token = hdf?.[1];
  if (token) {
    return parseTimestamp(
      `${token.slice(0, 4)}-${token.slice(4, 6)}-${token.slice(6, 8)}T${token.slice(8, 10)}:${token.slice(10, 12)}:${token.slice(12, 14)}Z`
    );
  }
  return undefined;
}

function hrefsFromHtmlIndex(indexHtml: string): string[] {
  return Array.from(indexHtml.matchAll(/href="([^"]+)"/g))
    .map((match) => match[1])
    .filter((href): href is string => typeof href === "string" && href.length > 0);
}

function parseTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(trimmed)) {
    return parseTimestamp(numeric);
  }
  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
