import type { SituationDataConfig } from "./config.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type {
  BoundingBox,
  SituationDataLicense,
  SituationFeature,
  SituationQuery,
  SituationSeverity,
  SourceDescriptor,
  SourceFetchResult
} from "./types.js";

export const WEATHER_FORECAST_SOURCE_ID = "weather_forecast" as const;
const WEATHER_FORECAST_LAYER_ID = "weather_forecast_area" as const;
const PROVIDER_ID = "sim.situation-data" as const;
const PROVIDER_LAYER_ID = "weather.forecast_area" as const;
const CATALOG_LAYER_ID = "public.weather.forecast_area" as const;
const MAX_FORECAST_AREA_CELLS = 64;
const MAX_FORECAST_AREA_CONCURRENCY = 8;
const DEFAULT_FORECAST_AREA_RESOLUTION_DEGREES = 0.25;
const WEATHER_FORECAST_CZECHIA_BBOX: BoundingBox = {
  west: 11.8,
  south: 48.4,
  east: 19.2,
  north: 51.2
};

export const WEATHER_FORECAST_LICENSE: SituationDataLicense = {
  name: "SIM weather forecast aggregate / Open-Meteo CC BY 4.0",
  url: "https://open-meteo.com/en/terms",
  attribution: "Weather forecast by SIM using Open-Meteo model data",
  commercialUse: "requires_license",
  operationalUse: "allowed_with_obligations",
  notes: [
    "SIM prepares COP-facing forecast areas, symbols, risk summaries and meteogram series server-side.",
    "Open-Meteo is used as the current model input; COP must consume the normalized SIM product and must not call upstream weather providers directly.",
    "Forecast context supports operational awareness and does not replace official ČHMÚ warnings or emergency instructions."
  ]
};

const MET_NORWAY_FORECAST_LICENSE: SituationDataLicense = {
  name: "Norwegian Meteorological Institute Data / CC BY 4.0",
  url: "https://api.met.no/license_data.html",
  attribution: "Norwegian Meteorological Institute",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Attribution and a descriptive User-Agent are required.",
    "SIM uses MET Norway Locationforecast only as a server-side forecast fallback when the primary model is temporarily unavailable.",
    "COP consumes only the normalized SIM weather forecast contract."
  ]
};

interface OpenMeteoForecastResponse {
  latitude?: number;
  longitude?: number;
  generationtime_ms?: number;
  current?: Record<string, unknown>;
  hourly?: Record<string, unknown>;
  daily?: Record<string, unknown>;
}

interface MetNorwayLocationForecastResponse {
  properties?: {
    timeseries?: Array<{
      time?: string;
      data?: {
        instant?: {
          details?: Record<string, unknown>;
        };
        next_1_hours?: {
          summary?: {
            symbol_code?: string;
          };
          details?: Record<string, unknown>;
        };
      };
    }>;
  };
}

interface ForecastCell {
  west: number;
  south: number;
  east: number;
  north: number;
  centerLon: number;
  centerLat: number;
  token: string;
  resolutionDegrees: number;
}

interface ForecastCurrent {
  time: string;
  temperatureC?: number;
  relativeHumidityPercent?: number;
  precipitationMm?: number;
  weatherCode?: number;
  cloudCoverPercent?: number;
  windSpeedMps?: number;
  windDirectionDeg?: number;
  windGustMps?: number;
}

interface ForecastHourlyPoint {
  time: string;
  temperatureC?: number;
  relativeHumidityPercent?: number;
  precipitationMm?: number;
  precipitationProbabilityPercent?: number;
  weatherCode?: number;
  cloudCoverPercent?: number;
  windSpeedMps?: number;
  windDirectionDeg?: number;
  windGustMps?: number;
  symbolKey: string;
  conditionLabel: string;
  conditionLabelEn: string;
  riskScore: number;
}

interface ForecastDailyPoint {
  date: string;
  weatherCode?: number;
  temperatureMaxC?: number;
  temperatureMinC?: number;
  precipitationSumMm?: number;
  precipitationProbabilityMaxPercent?: number;
  windGustMaxMps?: number;
  symbolKey: string;
  conditionLabel: string;
  conditionLabelEn: string;
}

interface ForecastAssessment {
  symbolKey: string;
  conditionLabel: string;
  conditionLabelEn: string;
  headlineCs: string;
  headlineEn: string;
  hazardType: string;
  riskLevel: "normal" | "elevated" | "high" | "severe";
  severity: SituationSeverity;
  confidence: number;
  riskScore: number;
  precipitationNext3hMm?: number;
  precipitationProbabilityNext3hPercent?: number;
  maxWindGustNext6hMps?: number;
}

interface WeatherForecastPayload {
  provider: "open_meteo" | "met_norway";
  providerWarning?: string;
  fetchedAt: string;
  requestedAt: string;
  cell: ForecastCell;
  raw: OpenMeteoForecastResponse | MetNorwayLocationForecastResponse;
  current: ForecastCurrent;
  hourly: ForecastHourlyPoint[];
  daily: ForecastDailyPoint[];
  assessment: ForecastAssessment;
}

interface WeatherForecastCacheStats extends ManagedResponseCacheStats {
  sourceId: typeof WEATHER_FORECAST_SOURCE_ID;
}

export interface WeatherForecastAreaDetail {
  contractVersion: "sim-weather-forecast-area-detail-v1";
  generatedAt: string;
  sourceId: typeof WEATHER_FORECAST_SOURCE_ID;
  providerLayerId: typeof PROVIDER_LAYER_ID;
  catalogLayerId: typeof CATALOG_LAYER_ID;
  area: {
    areaId: string;
    bbox: BoundingBox;
    center: { lat: number; lon: number };
    resolutionDegrees: number;
    label: string;
  };
  summary: {
    symbolKey: string;
    conditionLabel: string;
    conditionLabelEn: string;
    headlineCs: string;
    headlineEn: string;
    hazardType: string;
    riskLevel: string;
    severity: SituationSeverity;
    confidence: number;
    validFrom: string;
    validUntil: string;
  };
  current: ForecastCurrent;
  nowcast: {
    stepMinutes: 60;
    points: ForecastHourlyPoint[];
  };
  hourly: {
    horizonHours: number;
    points: ForecastHourlyPoint[];
  };
  daily: {
    horizonDays: number;
    points: ForecastDailyPoint[];
  };
  charts: WeatherForecastChart[];
  sources: Array<{
    sourceId: string;
    label: string;
    attribution: string;
  }>;
  quality: {
    forecastAvailable: boolean;
    radarNowcastFused: boolean;
    stationObservationFused: boolean;
    warnings: string[];
  };
}

interface WeatherForecastChart {
  chartId: string;
  titleCs: string;
  titleEn: string;
  unit?: string;
  type: "line" | "bar" | "area";
  series: Array<{
    key: string;
    labelCs: string;
    labelEn: string;
    unit?: string;
    points: Array<{ t: string; v: number | null }>;
  }>;
}

const forecastCaches = new Map<string, ManagedResponseCache<WeatherForecastPayload>>();
const metNorwayForecastCaches = new Map<string, ManagedResponseCache<MetNorwayLocationForecastResponse>>();

export class WeatherForecastSource {
  readonly descriptor: SourceDescriptor;
  private readonly payloadCache: ManagedResponseCache<WeatherForecastPayload>;

  constructor(private readonly config: SituationDataConfig) {
    this.payloadCache = weatherForecastCache(config);
    this.descriptor = {
      sourceId: WEATHER_FORECAST_SOURCE_ID,
      label: "SIM fused weather forecast areas",
      enabled: config.enabledSources.includes(WEATHER_FORECAST_SOURCE_ID),
      mode: "live",
      priority: 76,
      layers: [WEATHER_FORECAST_LAYER_ID],
      license: WEATHER_FORECAST_LICENSE,
      baseUrl: config.openMeteoBaseUrl,
      updateCadenceSeconds: config.openMeteoCacheTtlSeconds
    };
  }

  cacheStats(): WeatherForecastCacheStats[] {
    return [{ sourceId: WEATHER_FORECAST_SOURCE_ID, ...this.payloadCache.stats() }];
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes(WEATHER_FORECAST_LAYER_ID)) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const forecastBbox = intersectBbox(query.bbox, WEATHER_FORECAST_CZECHIA_BBOX);
    if (!forecastBbox) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const cells = forecastCellsForBbox(forecastBbox, query.limit);
    const results = await mapForecastCellsWithConcurrency(cells, (cell) => this.getPayload(cell));
    const warnings = results
      .map((result, index) =>
        result.status === "rejected" ? `weather_forecast area ${cells[index]?.token ?? index} unavailable: ${errorMessage(result.reason)}` : undefined
      )
      .filter((warning): warning is string => Boolean(warning));
    const payloads = results
      .filter((result): result is PromiseFulfilledResult<WeatherForecastPayload> => result.status === "fulfilled")
      .map((result) => result.value);

    if (payloads.length === 0 && cells.length > 0) {
      throw new Error(`Weather forecast provider did not return usable data: ${warnings.join("; ")}`);
    }

    return {
      source: this.descriptor,
      fetchedAt,
      features: payloads.map((payload) => forecastPayloadToFeature(payload, query.includeRaw)),
      warnings: [...warnings, ...payloads.map((payload) => payload.providerWarning).filter((warning): warning is string => Boolean(warning))]
    };
  }

  private async getPayload(cell: ForecastCell): Promise<WeatherForecastPayload> {
    return this.payloadCache.getOrLoad(forecastCacheKey(this.config, cell), () => loadWeatherForecastPayload(this.config, cell));
  }
}

export class WeatherForecastService {
  private readonly payloadCache: ManagedResponseCache<WeatherForecastPayload>;

  constructor(private readonly config: SituationDataConfig) {
    this.payloadCache = weatherForecastCache(config);
  }

  cacheStats(): WeatherForecastCacheStats[] {
    return [{ sourceId: WEATHER_FORECAST_SOURCE_ID, ...this.payloadCache.stats() }];
  }

  async getAreaDetail(areaId: string, options: { bbox?: BoundingBox; hours?: number; days?: number }): Promise<WeatherForecastAreaDetail> {
    const cell = options.bbox ? forecastCellForBbox(options.bbox) : forecastCellFromToken(areaId);
    if (!cell) {
      throw new Error("bbox query parameter is required when areaId is not a SIM forecast area token.");
    }
    const payload = await this.payloadCache.getOrLoad(forecastCacheKey(this.config, cell), () => loadWeatherForecastPayload(this.config, cell));
    return payloadToDetail(payload, {
      areaId,
      hours: options.hours,
      days: options.days
    });
  }
}

function weatherForecastCache(config: SituationDataConfig): ManagedResponseCache<WeatherForecastPayload> {
  const key = `${config.openMeteoBaseUrl}:${config.openMeteoCacheTtlSeconds}:${config.requestTimeoutMs}`;
  const existing = forecastCaches.get(key);
  if (existing) {
    return existing;
  }
  const created = new ManagedResponseCache<WeatherForecastPayload>({
    ttlMs: Math.max(300, config.openMeteoCacheTtlSeconds) * 1000,
    staleIfErrorMs: Math.max(config.staleIfErrorSeconds, config.openMeteoCacheTtlSeconds, 3600) * 1000,
    maxEntries: Math.max(64, Math.min(config.cacheMaxEntries, 4096))
  });
  forecastCaches.set(key, created);
  return created;
}

function metNorwayForecastCache(config: SituationDataConfig): ManagedResponseCache<MetNorwayLocationForecastResponse> {
  const key = `${config.metNorwayBaseUrl}:${config.metNorwayCacheTtlSeconds}:${config.requestTimeoutMs}`;
  const existing = metNorwayForecastCaches.get(key);
  if (existing) {
    return existing;
  }
  const created = new ManagedResponseCache<MetNorwayLocationForecastResponse>({
    ttlMs: Math.max(300, config.metNorwayCacheTtlSeconds) * 1000,
    staleIfErrorMs: Math.max(config.staleIfErrorSeconds, config.metNorwayCacheTtlSeconds, 3600) * 1000,
    maxEntries: Math.max(64, Math.min(config.cacheMaxEntries, 4096))
  });
  metNorwayForecastCaches.set(key, created);
  return created;
}

async function loadWeatherForecastPayload(config: SituationDataConfig, cell: ForecastCell): Promise<WeatherForecastPayload> {
  try {
    return await loadOpenMeteoForecastPayload(config, cell);
  } catch (error) {
    const fallback = await loadMetNorwayForecastPayload(config, cell);
    return {
      ...fallback,
      providerWarning: `Open-Meteo forecast unavailable; using MET Norway fallback: ${errorMessage(error)}`
    };
  }
}

async function loadOpenMeteoForecastPayload(config: SituationDataConfig, cell: ForecastCell): Promise<WeatherForecastPayload> {
  const requestedAt = new Date().toISOString();
  const url = new URL(`${config.openMeteoBaseUrl}/v1/forecast`);
  url.searchParams.set("latitude", cell.centerLat.toFixed(5));
  url.searchParams.set("longitude", cell.centerLon.toFixed(5));
  url.searchParams.set(
    "current",
    [
      "temperature_2m",
      "relative_humidity_2m",
      "precipitation",
      "weather_code",
      "cloud_cover",
      "wind_speed_10m",
      "wind_direction_10m",
      "wind_gusts_10m"
    ].join(",")
  );
  url.searchParams.set(
    "hourly",
    [
      "temperature_2m",
      "relative_humidity_2m",
      "precipitation",
      "precipitation_probability",
      "weather_code",
      "cloud_cover",
      "wind_speed_10m",
      "wind_direction_10m",
      "wind_gusts_10m"
    ].join(",")
  );
  url.searchParams.set(
    "daily",
    [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "precipitation_probability_max",
      "wind_gusts_10m_max"
    ].join(",")
  );
  url.searchParams.set("forecast_days", "7");
  url.searchParams.set("forecast_hours", "72");
  url.searchParams.set("wind_speed_unit", "ms");
  url.searchParams.set("timezone", "UTC");

  const raw = await requestJson<OpenMeteoForecastResponse>(url.toString(), config.requestTimeoutMs);
  const current = normalizeCurrent(raw.current, requestedAt);
  const hourly = normalizeHourly(raw.hourly).slice(0, 72);
  const daily = normalizeDaily(raw.daily).slice(0, 7);
  if (!current && hourly.length === 0) {
    throw new Error("Open-Meteo forecast response does not contain current or hourly weather values.");
  }
  const resolvedCurrent = current ?? currentFromHourly(hourly[0], requestedAt);
  return {
    provider: "open_meteo",
    fetchedAt: new Date().toISOString(),
    requestedAt,
    cell,
    raw,
    current: resolvedCurrent,
    hourly,
    daily,
    assessment: assessForecast(resolvedCurrent, hourly, daily)
  };
}

async function loadMetNorwayForecastPayload(config: SituationDataConfig, cell: ForecastCell): Promise<WeatherForecastPayload> {
  const requestedAt = new Date().toISOString();
  const url = new URL(`${config.metNorwayBaseUrl}/weatherapi/locationforecast/2.0/compact`);
  url.searchParams.set("lat", cell.centerLat.toFixed(5));
  url.searchParams.set("lon", cell.centerLon.toFixed(5));
  const raw = await metNorwayForecastCache(config).getOrLoad(forecastMetNorwayCacheKey(config, cell), () =>
    requestJsonWithHeaders<MetNorwayLocationForecastResponse>(url.toString(), config.requestTimeoutMs, {
      accept: "application/json",
      "user-agent": config.metNorwayUserAgent
    })
  );
  const hourly = normalizeMetNorwayHourly(raw).slice(0, 72);
  if (hourly.length === 0) {
    throw new Error("MET Norway forecast response does not contain usable timeseries values.");
  }
  const current = currentFromHourly(hourly[0], requestedAt);
  const daily = metNorwayDailyFromHourly(hourly).slice(0, 7);
  return {
    provider: "met_norway",
    fetchedAt: new Date().toISOString(),
    requestedAt,
    cell,
    raw,
    current,
    hourly,
    daily,
    assessment: assessForecast(current, hourly, daily)
  };
}

function forecastPayloadToFeature(payload: WeatherForecastPayload, includeRaw: boolean): SituationFeature {
  const { cell, assessment, current } = payload;
  const bbox = forecastCellBbox(cell);
  const validUntil = payload.hourly[1]?.time ?? addHours(payload.fetchedAt, 1);
  const detailUrl = `/situation-data/api/v1/weather-forecast/areas/${encodeURIComponent(cell.token)}?bbox=${encodeURIComponent(formatBbox(bbox))}`;
  const serviceDetailUrl = `/api/v1/weather-forecast/areas/${encodeURIComponent(cell.token)}?bbox=${encodeURIComponent(formatBbox(bbox))}`;
  const sourceInputs = [payload.provider === "open_meteo" ? "open_meteo_forecast" : "met_norway_locationforecast"];
  return {
    type: "Feature",
    id: `weather_forecast_area:${cell.token}`,
    geometry: polygonForBbox(bbox),
    properties: {
      featureId: `weather_forecast_area:${cell.token}`,
      layerId: CATALOG_LAYER_ID,
      providerId: PROVIDER_ID,
      providerLayerId: PROVIDER_LAYER_ID,
      layer: WEATHER_FORECAST_LAYER_ID,
      category: "weather_forecast_area",
      label: assessment.headlineCs,
      labelLocalized: {
        cs: assessment.headlineCs,
        en: assessment.headlineEn
      },
      summaryLocalized: {
        cs: `${assessment.conditionLabel}. ${assessment.headlineCs}`,
        en: `${assessment.conditionLabelEn}. ${assessment.headlineEn}`
      },
      sourceId: WEATHER_FORECAST_SOURCE_ID,
      sourceName: "SIM weather forecast",
      observedAt: current.time,
      validFrom: current.time,
      validUntil,
      confidence: assessment.confidence,
      stale: false,
      severity: assessment.severity,
      license: {
        name: WEATHER_FORECAST_LICENSE.name,
        attribution: WEATHER_FORECAST_LICENSE.attribution,
        url: WEATHER_FORECAST_LICENSE.url
      },
      metrics: compactMixedMetrics({
        temperatureC: current.temperatureC,
        relativeHumidityPercent: current.relativeHumidityPercent,
        precipitationMm: current.precipitationMm,
        precipitationNext10MinMm: payload.hourly[0]?.precipitationMm === undefined ? undefined : round(payload.hourly[0].precipitationMm / 6, 2),
        precipitationNext1hMm: payload.hourly[0]?.precipitationMm,
        precipitationNext3hMm: assessment.precipitationNext3hMm,
        precipitationProbabilityNext1hPercent: payload.hourly[0]?.precipitationProbabilityPercent,
        precipitationProbabilityNext3hPercent: assessment.precipitationProbabilityNext3hPercent,
        cloudCoverPercent: current.cloudCoverPercent,
        windSpeedMps: current.windSpeedMps,
        windDirectionDeg: current.windDirectionDeg,
        windGustMps: current.windGustMps,
        maxWindGustNext6hMps: assessment.maxWindGustNext6hMps,
        weatherCode: current.weatherCode,
        thunderstormProbabilityPercent: thunderstormProbabilityPercent(current.weatherCode, payload.hourly[0]?.weatherCode, assessment.riskScore),
        lightningStrikeFeedAvailable: false,
        riskScore: assessment.riskScore,
        resolutionM: Math.round(cell.resolutionDegrees * 111_320)
      }),
      tags: compactTags({
        mapDisplayHint: "weather_forecast_area",
        recommendedCatalogLayerId: CATALOG_LAYER_ID,
        symbolKey: assessment.symbolKey,
        conditionLabel: assessment.conditionLabel,
        conditionLabelEn: assessment.conditionLabelEn,
        hazardType: assessment.hazardType,
        riskLevel: assessment.riskLevel,
        sourceSystem: "sim_weather_forecast_v1"
      }),
      rendering: {
        mode: "feature",
        geometryRole: "grid_cell",
        valueMetric: "riskScore",
        unit: "score",
        opacity: 0.36
      },
      styleHint: "weather-forecast-area-v1",
      iconHint: assessment.symbolKey,
      providerProperties: compactProviderProperties({
        presentation: {
          mapLabel: assessment.headlineCs,
          mapLabelEn: assessment.headlineEn,
          symbolKey: assessment.symbolKey,
          conditionLabel: assessment.conditionLabel,
          conditionLabelEn: assessment.conditionLabelEn,
          riskLevel: assessment.riskLevel,
          colorRamp: "weather-risk-v1"
        },
        display: {
          detailType: "weather_forecast_meteogram",
          detailUrl,
          chartUrl: detailUrl,
          serviceDetailUrl,
          chartSeries: ["temperature", "precipitation", "wind", "risk"]
        },
        weatherForecast: {
          contractVersion: "sim-weather-forecast-area-v1",
          detailAvailable: true,
          detailUrl,
          serviceDetailUrl,
          sourceInputs,
          graphSeries: ["temperature", "precipitation", "wind", "risk"],
          coverageBbox: WEATHER_FORECAST_CZECHIA_BBOX,
          stableGrid: {
            alignment: "wgs84",
            resolutionDegrees: cell.resolutionDegrees
          },
          generatedAt: payload.fetchedAt,
          fallbackUsed: payload.provider === "met_norway",
          providerWarning: payload.providerWarning
        },
        aiContext: {
          dynamicDataRequiresTimestamp: true,
          precipitationNext10MinBasis: "hourly_model_scaled_to_10_minutes",
          lightningNearbyAvailable: false,
          thunderstormProbabilityBasis: "weather_code_and_risk_score_heuristic"
        }
      }),
      raw: includeRaw ? payload.raw : undefined
    }
  };
}

function payloadToDetail(payload: WeatherForecastPayload, options: { areaId: string; hours?: number; days?: number }): WeatherForecastAreaDetail {
  const horizonHours = clamp(Math.trunc(options.hours ?? 48), 1, 72);
  const horizonDays = clamp(Math.trunc(options.days ?? 7), 1, 7);
  const hourly = payload.hourly.slice(0, horizonHours);
  const daily = payload.daily.slice(0, horizonDays);
  const bbox = forecastCellBbox(payload.cell);
  const validUntil = hourly[1]?.time ?? addHours(payload.fetchedAt, 1);
  return {
    contractVersion: "sim-weather-forecast-area-detail-v1",
    generatedAt: new Date().toISOString(),
    sourceId: WEATHER_FORECAST_SOURCE_ID,
    providerLayerId: PROVIDER_LAYER_ID,
    catalogLayerId: CATALOG_LAYER_ID,
    area: {
      areaId: options.areaId,
      bbox,
      center: { lat: payload.cell.centerLat, lon: payload.cell.centerLon },
      resolutionDegrees: payload.cell.resolutionDegrees,
      label: `Forecast area ${payload.cell.token}`
    },
    summary: {
      symbolKey: payload.assessment.symbolKey,
      conditionLabel: payload.assessment.conditionLabel,
      conditionLabelEn: payload.assessment.conditionLabelEn,
      headlineCs: payload.assessment.headlineCs,
      headlineEn: payload.assessment.headlineEn,
      hazardType: payload.assessment.hazardType,
      riskLevel: payload.assessment.riskLevel,
      severity: payload.assessment.severity,
      confidence: payload.assessment.confidence,
      validFrom: payload.current.time,
      validUntil
    },
    current: payload.current,
    nowcast: {
      stepMinutes: 60,
      points: payload.hourly.slice(0, 6)
    },
    hourly: {
      horizonHours,
      points: hourly
    },
    daily: {
      horizonDays,
      points: daily
    },
    charts: buildForecastCharts(hourly),
    sources: [
      payload.provider === "open_meteo" ? {
        sourceId: "open_meteo_forecast",
        label: "Open-Meteo forecast API",
        attribution: "Weather data by Open-Meteo.com"
      } : {
        sourceId: "met_norway_locationforecast",
        label: "MET Norway Locationforecast",
        attribution: "Norwegian Meteorological Institute"
      },
      {
        sourceId: "sim_weather_forecast_v1",
        label: "SIM forecast normalization",
        attribution: "CSM SIM"
      }
    ],
    quality: {
      forecastAvailable: hourly.length > 0,
      radarNowcastFused: false,
      stationObservationFused: false,
      warnings: [
        payload.providerWarning,
        "Forecast is model-based and normalized by SIM.",
        "ČHMÚ CAP warnings remain in public.safety.weather_alerts and should be displayed separately from this forecast layer."
      ].filter((warning): warning is string => Boolean(warning))
    }
  };
}

function buildForecastCharts(hourly: ForecastHourlyPoint[]): WeatherForecastChart[] {
  return [
    {
      chartId: "temperature",
      titleCs: "Teplota",
      titleEn: "Temperature",
      unit: "°C",
      type: "line",
      series: [
        {
          key: "temperatureC",
          labelCs: "Teplota",
          labelEn: "Temperature",
          unit: "°C",
          points: hourly.map((point) => ({ t: point.time, v: point.temperatureC ?? null }))
        }
      ]
    },
    {
      chartId: "precipitation",
      titleCs: "Srážky a pravděpodobnost",
      titleEn: "Precipitation and probability",
      type: "bar",
      series: [
        {
          key: "precipitationMm",
          labelCs: "Srážky",
          labelEn: "Precipitation",
          unit: "mm/h",
          points: hourly.map((point) => ({ t: point.time, v: point.precipitationMm ?? null }))
        },
        {
          key: "precipitationProbabilityPercent",
          labelCs: "Pravděpodobnost",
          labelEn: "Probability",
          unit: "%",
          points: hourly.map((point) => ({ t: point.time, v: point.precipitationProbabilityPercent ?? null }))
        }
      ]
    },
    {
      chartId: "wind",
      titleCs: "Vítr",
      titleEn: "Wind",
      unit: "m/s",
      type: "line",
      series: [
        {
          key: "windSpeedMps",
          labelCs: "Vítr",
          labelEn: "Wind",
          unit: "m/s",
          points: hourly.map((point) => ({ t: point.time, v: point.windSpeedMps ?? null }))
        },
        {
          key: "windGustMps",
          labelCs: "Nárazy",
          labelEn: "Gusts",
          unit: "m/s",
          points: hourly.map((point) => ({ t: point.time, v: point.windGustMps ?? null }))
        }
      ]
    },
    {
      chartId: "risk",
      titleCs: "Riziko počasí",
      titleEn: "Weather risk",
      unit: "score",
      type: "area",
      series: [
        {
          key: "riskScore",
          labelCs: "Riziko",
          labelEn: "Risk",
          unit: "score",
          points: hourly.map((point) => ({ t: point.time, v: point.riskScore }))
        }
      ]
    }
  ];
}

function normalizeCurrent(current: Record<string, unknown> | undefined, fallbackTime: string): ForecastCurrent | undefined {
  if (!current) {
    return undefined;
  }
  return {
    time: normalizeTime(current.time) ?? fallbackTime,
    temperatureC: optionalNumber(current.temperature_2m),
    relativeHumidityPercent: optionalNumber(current.relative_humidity_2m),
    precipitationMm: optionalNumber(current.precipitation),
    weatherCode: optionalNumber(current.weather_code),
    cloudCoverPercent: optionalNumber(current.cloud_cover),
    windSpeedMps: optionalNumber(current.wind_speed_10m),
    windDirectionDeg: optionalNumber(current.wind_direction_10m),
    windGustMps: optionalNumber(current.wind_gusts_10m)
  };
}

function currentFromHourly(point: ForecastHourlyPoint | undefined, fallbackTime: string): ForecastCurrent {
  return {
    time: point?.time ?? fallbackTime,
    temperatureC: point?.temperatureC,
    relativeHumidityPercent: point?.relativeHumidityPercent,
    precipitationMm: point?.precipitationMm,
    weatherCode: point?.weatherCode,
    cloudCoverPercent: point?.cloudCoverPercent,
    windSpeedMps: point?.windSpeedMps,
    windDirectionDeg: point?.windDirectionDeg,
    windGustMps: point?.windGustMps
  };
}

function normalizeHourly(hourly: Record<string, unknown> | undefined): ForecastHourlyPoint[] {
  if (!hourly) {
    return [];
  }
  const times = arrayOfStrings(hourly.time);
  return times.map((time, index) => {
    const weatherCode = numberAt(hourly.weather_code, index);
    const precipitationMm = numberAt(hourly.precipitation, index);
    const windSpeedMps = numberAt(hourly.wind_speed_10m, index);
    const windGustMps = numberAt(hourly.wind_gusts_10m, index);
    const descriptor = weatherDescriptor(weatherCode);
    return {
      time: normalizeTime(time) ?? time,
      temperatureC: numberAt(hourly.temperature_2m, index),
      relativeHumidityPercent: numberAt(hourly.relative_humidity_2m, index),
      precipitationMm,
      precipitationProbabilityPercent: numberAt(hourly.precipitation_probability, index),
      weatherCode,
      cloudCoverPercent: numberAt(hourly.cloud_cover, index),
      windSpeedMps,
      windDirectionDeg: numberAt(hourly.wind_direction_10m, index),
      windGustMps,
      symbolKey: descriptor.symbolKey,
      conditionLabel: descriptor.labelCs,
      conditionLabelEn: descriptor.labelEn,
      riskScore: riskScore({ weatherCode, precipitationMm, windSpeedMps, windGustMps })
    };
  });
}

function normalizeDaily(daily: Record<string, unknown> | undefined): ForecastDailyPoint[] {
  if (!daily) {
    return [];
  }
  const dates = arrayOfStrings(daily.time);
  return dates.map((date, index) => {
    const weatherCode = numberAt(daily.weather_code, index);
    const descriptor = weatherDescriptor(weatherCode);
    return {
      date,
      weatherCode,
      temperatureMaxC: numberAt(daily.temperature_2m_max, index),
      temperatureMinC: numberAt(daily.temperature_2m_min, index),
      precipitationSumMm: numberAt(daily.precipitation_sum, index),
      precipitationProbabilityMaxPercent: numberAt(daily.precipitation_probability_max, index),
      windGustMaxMps: numberAt(daily.wind_gusts_10m_max, index),
      symbolKey: descriptor.symbolKey,
      conditionLabel: descriptor.labelCs,
      conditionLabelEn: descriptor.labelEn
    };
  });
}

function normalizeMetNorwayHourly(payload: MetNorwayLocationForecastResponse): ForecastHourlyPoint[] {
  return (payload.properties?.timeseries ?? [])
    .map((point): ForecastHourlyPoint | undefined => {
      const time = normalizeTime(point.time);
      if (!time) {
        return undefined;
      }
      const details = point.data?.instant?.details ?? {};
      const precipitationMm = optionalNumber(point.data?.next_1_hours?.details?.precipitation_amount);
      const symbolCode = typeof point.data?.next_1_hours?.summary?.symbol_code === "string" ? point.data.next_1_hours.summary.symbol_code : undefined;
      const weatherCode = weatherCodeFromMetNorwaySymbol(symbolCode, precipitationMm);
      const windSpeedMps = optionalNumber(details.wind_speed);
      const windGustMps = optionalNumber(details.wind_speed_of_gust);
      const descriptor = weatherDescriptor(weatherCode);
      return {
        time,
        temperatureC: optionalNumber(details.air_temperature),
        relativeHumidityPercent: optionalNumber(details.relative_humidity),
        precipitationMm,
        weatherCode,
        cloudCoverPercent: optionalNumber(details.cloud_area_fraction),
        windSpeedMps,
        windDirectionDeg: optionalNumber(details.wind_from_direction),
        windGustMps,
        symbolKey: descriptor.symbolKey,
        conditionLabel: descriptor.labelCs,
        conditionLabelEn: descriptor.labelEn,
        riskScore: riskScore({ weatherCode, precipitationMm, windSpeedMps, windGustMps })
      };
    })
    .filter((point): point is ForecastHourlyPoint => Boolean(point));
}

function metNorwayDailyFromHourly(hourly: ForecastHourlyPoint[]): ForecastDailyPoint[] {
  const byDate = new Map<string, ForecastHourlyPoint[]>();
  for (const point of hourly) {
    const date = point.time.slice(0, 10);
    const bucket = byDate.get(date) ?? [];
    bucket.push(point);
    byDate.set(date, bucket);
  }
  return Array.from(byDate.entries()).map(([date, points]) => {
    const weatherCode = dominantWeatherCode(points.map((point) => point.weatherCode));
    const descriptor = weatherDescriptor(weatherCode);
    const precipitationSumMm = sumDefined(points.map((point) => point.precipitationMm));
    return {
      date,
      weatherCode,
      temperatureMaxC: maxDefined(points.map((point) => point.temperatureC)),
      temperatureMinC: minDefined(points.map((point) => point.temperatureC)),
      precipitationSumMm: precipitationSumMm === undefined ? undefined : round(precipitationSumMm, 2),
      windGustMaxMps: maxDefined(points.map((point) => point.windGustMps ?? point.windSpeedMps)),
      symbolKey: descriptor.symbolKey,
      conditionLabel: descriptor.labelCs,
      conditionLabelEn: descriptor.labelEn
    };
  });
}

function assessForecast(current: ForecastCurrent, hourly: ForecastHourlyPoint[], daily: ForecastDailyPoint[]): ForecastAssessment {
  const next3h = hourly.slice(0, 3);
  const next6h = hourly.slice(0, 6);
  const precipitationNext3hMm = sumDefined(next3h.map((point) => point.precipitationMm));
  const precipitationProbabilityNext3hPercent = maxDefined(next3h.map((point) => point.precipitationProbabilityPercent));
  const maxWindGustNext6hMps = maxDefined(next6h.map((point) => point.windGustMps ?? point.windSpeedMps));
  const dominant = dominantWeatherCode([current.weatherCode, ...next6h.map((point) => point.weatherCode)]);
  const descriptor = weatherDescriptor(dominant ?? current.weatherCode);
  const score = Math.max(
    riskScore({
      weatherCode: dominant ?? current.weatherCode,
      precipitationMm: Math.max(current.precipitationMm ?? 0, precipitationNext3hMm ?? 0),
      windSpeedMps: current.windSpeedMps,
      windGustMps: maxWindGustNext6hMps
    }),
    temperatureRiskScore(current.temperatureC),
    daily[0] ? dailyRiskScore(daily[0]) : 0
  );
  const severity = riskSeverity(score);
  const riskLevel = riskLevelFromScore(score);
  const hazardType = hazardTypeFromWeather(dominant ?? current.weatherCode, score, precipitationNext3hMm, maxWindGustNext6hMps, current.temperatureC);
  return {
    symbolKey: descriptor.symbolKey,
    conditionLabel: descriptor.labelCs,
    conditionLabelEn: descriptor.labelEn,
    headlineCs: buildHeadlineCs(descriptor.labelCs, hazardType, riskLevel, current),
    headlineEn: buildHeadlineEn(descriptor.labelEn, hazardType, riskLevel, current),
    hazardType,
    riskLevel,
    severity,
    confidence: forecastConfidence(hourly.length, precipitationProbabilityNext3hPercent, riskLevel),
    riskScore: round(score, 2),
    precipitationNext3hMm: precipitationNext3hMm === undefined ? undefined : round(precipitationNext3hMm, 2),
    precipitationProbabilityNext3hPercent,
    maxWindGustNext6hMps
  };
}

function forecastCellsForBbox(bbox: BoundingBox, limit: number): ForecastCell[] {
  const resolution = chooseResolution(bbox, limit);
  const westIndex = Math.floor(bbox.west / resolution);
  const eastIndex = Math.ceil(bbox.east / resolution);
  const southIndex = Math.floor(bbox.south / resolution);
  const northIndex = Math.ceil(bbox.north / resolution);
  const cells: ForecastCell[] = [];
  for (let y = southIndex; y < northIndex; y += 1) {
    for (let x = westIndex; x < eastIndex; x += 1) {
      const west = round(x * resolution, 5);
      const south = round(y * resolution, 5);
      const east = round(west + resolution, 5);
      const north = round(south + resolution, 5);
      if (east < bbox.west || west > bbox.east || north < bbox.south || south > bbox.north) {
        continue;
      }
      cells.push({
        west,
        south,
        east,
        north,
        centerLon: round((west + east) / 2, 5),
        centerLat: round((south + north) / 2, 5),
        token: `${west}:${south}:${resolution}`,
        resolutionDegrees: resolution
      });
    }
  }
  return cells
    .sort((left, right) => distanceToBboxCenter(left, bbox) - distanceToBboxCenter(right, bbox))
    .slice(0, Math.min(Math.max(1, limit), MAX_FORECAST_AREA_CELLS));
}

async function mapForecastCellsWithConcurrency(
  cells: ForecastCell[],
  load: (cell: ForecastCell) => Promise<WeatherForecastPayload>
): Promise<Array<PromiseSettledResult<WeatherForecastPayload>>> {
  const results = new Array<PromiseSettledResult<WeatherForecastPayload>>(cells.length);
  let nextIndex = 0;
  const workerCount = Math.min(MAX_FORECAST_AREA_CONCURRENCY, Math.max(1, cells.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < cells.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = { status: "fulfilled", value: await load(cells[index] as ForecastCell) };
        } catch (error) {
          results[index] = { status: "rejected", reason: error };
        }
      }
    })
  );
  return results;
}

function intersectBbox(a: BoundingBox, b: BoundingBox): BoundingBox | undefined {
  const west = Math.max(a.west, b.west);
  const south = Math.max(a.south, b.south);
  const east = Math.min(a.east, b.east);
  const north = Math.min(a.north, b.north);
  if (west >= east || south >= north) {
    return undefined;
  }
  return { west, south, east, north };
}

function forecastCellForBbox(bbox: BoundingBox): ForecastCell {
  const resolution = round(Math.max(0.01, Math.min(1, Math.max(bbox.east - bbox.west, bbox.north - bbox.south))), 5);
  const west = round(bbox.west, 5);
  const south = round(bbox.south, 5);
  const east = round(bbox.east, 5);
  const north = round(bbox.north, 5);
  return {
    west,
    south,
    east,
    north,
    centerLon: round((west + east) / 2, 5),
    centerLat: round((south + north) / 2, 5),
    token: `${west}:${south}:${resolution}`,
    resolutionDegrees: resolution
  };
}

function forecastCellFromToken(token: string): ForecastCell | undefined {
  const [westRaw, southRaw, resolutionRaw] = token.split(":");
  const west = Number(westRaw);
  const south = Number(southRaw);
  const resolution = Number(resolutionRaw);
  if (![west, south, resolution].every(Number.isFinite) || resolution <= 0) {
    return undefined;
  }
  const east = round(west + resolution, 5);
  const north = round(south + resolution, 5);
  return {
    west,
    south,
    east,
    north,
    centerLon: round((west + east) / 2, 5),
    centerLat: round((south + north) / 2, 5),
    token,
    resolutionDegrees: round(resolution, 5)
  };
}

function chooseResolution(bbox: BoundingBox, limit: number): number {
  const span = Math.max(bbox.east - bbox.west, bbox.north - bbox.south);
  const targetCells = Math.min(Math.max(1, limit), MAX_FORECAST_AREA_CELLS);
  const ideal = Math.sqrt(((bbox.east - bbox.west) * (bbox.north - bbox.south)) / targetCells);
  if (span > 4) {
    return 0.75;
  }
  if (span > 2) {
    return 0.5;
  }
  if (span > 1) {
    return 0.35;
  }
  return round(clamp(ideal || DEFAULT_FORECAST_AREA_RESOLUTION_DEGREES, 0.08, 0.25), 2);
}

function forecastCellBbox(cell: ForecastCell): BoundingBox {
  return { west: cell.west, south: cell.south, east: cell.east, north: cell.north };
}

function forecastCacheKey(config: SituationDataConfig, cell: ForecastCell): string {
  return `open_meteo_forecast:${config.openMeteoBaseUrl}:${cell.centerLat.toFixed(5)}:${cell.centerLon.toFixed(5)}`;
}

function polygonForBbox(bbox: BoundingBox): SituationFeature["geometry"] {
  return {
    type: "Polygon",
    coordinates: [
      [
        [bbox.west, bbox.south],
        [bbox.east, bbox.south],
        [bbox.east, bbox.north],
        [bbox.west, bbox.north],
        [bbox.west, bbox.south]
      ]
    ]
  };
}

function weatherDescriptor(code: number | undefined): { symbolKey: string; labelCs: string; labelEn: string; rank: number } {
  if (code === 0) {
    return { symbolKey: "clear", labelCs: "jasno", labelEn: "clear", rank: 0 };
  }
  if (code === 1) {
    return { symbolKey: "mostly_clear", labelCs: "skoro jasno", labelEn: "mostly clear", rank: 1 };
  }
  if (code === 2) {
    return { symbolKey: "partly_cloudy", labelCs: "polojasno", labelEn: "partly cloudy", rank: 2 };
  }
  if (code === 3) {
    return { symbolKey: "overcast", labelCs: "zataženo", labelEn: "overcast", rank: 3 };
  }
  if (code === 45 || code === 48) {
    return { symbolKey: "fog", labelCs: "mlha", labelEn: "fog", rank: 5 };
  }
  if (code !== undefined && code >= 51 && code <= 57) {
    return { symbolKey: "drizzle", labelCs: "mrholení", labelEn: "drizzle", rank: 6 };
  }
  if (code !== undefined && code >= 61 && code <= 67) {
    return { symbolKey: "rain", labelCs: "déšť", labelEn: "rain", rank: 7 };
  }
  if (code !== undefined && code >= 71 && code <= 77) {
    return { symbolKey: "snow", labelCs: "sněžení", labelEn: "snow", rank: 8 };
  }
  if (code !== undefined && code >= 80 && code <= 82) {
    return { symbolKey: "showers", labelCs: "přeháňky", labelEn: "showers", rank: 9 };
  }
  if (code === 85 || code === 86) {
    return { symbolKey: "snow_showers", labelCs: "sněhové přeháňky", labelEn: "snow showers", rank: 10 };
  }
  if (code === 95) {
    return { symbolKey: "thunderstorm", labelCs: "bouřka", labelEn: "thunderstorm", rank: 11 };
  }
  if (code === 96 || code === 99) {
    return { symbolKey: "severe_thunderstorm", labelCs: "silná bouřka", labelEn: "severe thunderstorm", rank: 12 };
  }
  return { symbolKey: "unknown", labelCs: "neurčené počasí", labelEn: "unknown weather", rank: 0 };
}

function dominantWeatherCode(codes: Array<number | undefined>): number | undefined {
  return codes
    .filter((code): code is number => typeof code === "number")
    .sort((left, right) => weatherDescriptor(right).rank - weatherDescriptor(left).rank)[0];
}

function riskScore(input: { weatherCode?: number; precipitationMm?: number; windSpeedMps?: number; windGustMps?: number }): number {
  const code = input.weatherCode;
  const precipitationScore = clamp((input.precipitationMm ?? 0) / 12, 0, 1);
  const windScore = clamp(Math.max(input.windSpeedMps ?? 0, input.windGustMps ?? 0) / 25, 0, 1);
  const codeScore = code === 96 || code === 99 ? 1 : code === 95 ? 0.85 : code && code >= 80 ? 0.55 : code && code >= 61 ? 0.42 : 0;
  return round(Math.max(precipitationScore, windScore, codeScore), 2);
}

function thunderstormProbabilityPercent(currentCode: number | undefined, nextHourCode: number | undefined, riskScoreValue: number): number {
  const code = Math.max(currentCode ?? 0, nextHourCode ?? 0);
  if (code === 96 || code === 99) {
    return 85;
  }
  if (code === 95) {
    return 70;
  }
  if (riskScoreValue >= 0.75) {
    return 45;
  }
  if (riskScoreValue >= 0.5) {
    return 25;
  }
  return 0;
}

function temperatureRiskScore(temperatureC: number | undefined): number {
  if (temperatureC === undefined) {
    return 0;
  }
  if (temperatureC >= 35 || temperatureC <= -15) {
    return 0.7;
  }
  if (temperatureC >= 30 || temperatureC <= -8) {
    return 0.4;
  }
  return 0;
}

function dailyRiskScore(daily: ForecastDailyPoint): number {
  return Math.max(
    clamp((daily.precipitationSumMm ?? 0) / 30, 0, 0.8),
    clamp((daily.windGustMaxMps ?? 0) / 30, 0, 0.8),
    temperatureRiskScore(daily.temperatureMaxC),
    temperatureRiskScore(daily.temperatureMinC)
  );
}

function riskSeverity(score: number): SituationSeverity {
  if (score >= 0.85) {
    return "critical";
  }
  if (score >= 0.55) {
    return "warning";
  }
  if (score >= 0.25) {
    return "advisory";
  }
  return "info";
}

function riskLevelFromScore(score: number): "normal" | "elevated" | "high" | "severe" {
  if (score >= 0.85) {
    return "severe";
  }
  if (score >= 0.55) {
    return "high";
  }
  if (score >= 0.25) {
    return "elevated";
  }
  return "normal";
}

function hazardTypeFromWeather(
  weatherCode: number | undefined,
  riskScoreValue: number,
  precipitationNext3hMm: number | undefined,
  maxWindGustNext6hMps: number | undefined,
  temperatureC: number | undefined
): string {
  if (weatherCode === 95 || weatherCode === 96 || weatherCode === 99) {
    return "thunderstorm";
  }
  if ((precipitationNext3hMm ?? 0) >= 8 || (weatherCode !== undefined && weatherCode >= 61 && weatherCode <= 82 && riskScoreValue >= 0.4)) {
    return "rain";
  }
  if (weatherCode !== undefined && weatherCode >= 71 && weatherCode <= 86) {
    return "snow";
  }
  if ((maxWindGustNext6hMps ?? 0) >= 15) {
    return "wind";
  }
  if ((temperatureC ?? 0) >= 30) {
    return "heat";
  }
  if ((temperatureC ?? 99) <= -8) {
    return "frost";
  }
  if (weatherCode === 45 || weatherCode === 48) {
    return "fog";
  }
  return "normal_weather";
}

function buildHeadlineCs(condition: string, hazardType: string, riskLevel: string, current: ForecastCurrent): string {
  const suffix = typeof current.temperatureC === "number" ? `, ${round(current.temperatureC, 0)} °C` : "";
  if (riskLevel === "severe" || riskLevel === "high") {
    const hazard = {
      thunderstorm: "riziko bouřek",
      rain: "riziko intenzivních srážek",
      snow: "riziko sněžení",
      wind: "riziko silného větru",
      heat: "vysoké teploty",
      frost: "nízké teploty",
      fog: "snížená dohlednost"
    }[hazardType] ?? "zhoršené počasí";
    return `${hazard}${suffix}`;
  }
  return `${condition}${suffix}`;
}

function buildHeadlineEn(condition: string, hazardType: string, riskLevel: string, current: ForecastCurrent): string {
  const suffix = typeof current.temperatureC === "number" ? `, ${round(current.temperatureC, 0)} °C` : "";
  if (riskLevel === "severe" || riskLevel === "high") {
    const hazard = {
      thunderstorm: "thunderstorm risk",
      rain: "heavy precipitation risk",
      snow: "snow risk",
      wind: "strong wind risk",
      heat: "high temperatures",
      frost: "low temperatures",
      fog: "reduced visibility"
    }[hazardType] ?? "adverse weather";
    return `${hazard}${suffix}`;
  }
  return `${condition}${suffix}`;
}

function forecastConfidence(hourlyCount: number, precipitationProbability: number | undefined, riskLevel: string): number {
  const base = hourlyCount >= 48 ? 0.82 : hourlyCount >= 12 ? 0.74 : 0.62;
  const uncertaintyPenalty = precipitationProbability !== undefined && precipitationProbability > 40 && precipitationProbability < 70 ? 0.06 : 0;
  const riskPenalty = riskLevel === "severe" || riskLevel === "high" ? 0.04 : 0;
  return round(clamp(base - uncertaintyPenalty - riskPenalty, 0.45, 0.9), 2);
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberAt(value: unknown, index: number): number | undefined {
  return Array.isArray(value) ? optionalNumber(value[index]) : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function requestJson<T>(url: string, timeoutMs: number): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return (await response.json()) as T;
}

async function requestJsonWithHeaders<T>(url: string, timeoutMs: number, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return (await response.json()) as T;
}

function normalizeTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  const date = new Date(trimmed.endsWith("Z") ? trimmed : `${trimmed}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function sumDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => typeof value === "number");
  return defined.length > 0 ? defined.reduce((sum, value) => sum + value, 0) : undefined;
}

function maxDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => typeof value === "number");
  return defined.length > 0 ? Math.max(...defined) : undefined;
}

function minDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => typeof value === "number");
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

function distanceToBboxCenter(cell: ForecastCell, bbox: BoundingBox): number {
  const lon = (bbox.west + bbox.east) / 2;
  const lat = (bbox.south + bbox.north) / 2;
  return Math.hypot(cell.centerLon - lon, cell.centerLat - lat);
}

function formatBbox(bbox: BoundingBox): string {
  return [bbox.west, bbox.south, bbox.east, bbox.north].map((value) => round(value, 5)).join(",");
}

function addHours(isoTimestamp: string, hours: number): string {
  const base = Date.parse(isoTimestamp);
  return new Date((Number.isNaN(base) ? Date.now() : base) + hours * 60 * 60 * 1000).toISOString();
}

function compactMixedMetrics(values: Record<string, number | string | boolean | undefined>): Record<string, number | string | boolean> | undefined {
  const entries = Object.entries(values).filter(
    (entry): entry is [string, number | string | boolean] =>
      typeof entry[1] === "number" || typeof entry[1] === "string" || typeof entry[1] === "boolean"
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactTags(values: Record<string, string | undefined>): Record<string, string> | undefined {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactProviderProperties(values: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(values).filter(([, value]) => {
    if (value === undefined || value === null) {
      return false;
    }
    if (typeof value === "string") {
      return value.length > 0;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return true;
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function round(value: number, precision: number): number {
  const multiplier = 10 ** precision;
  return Math.round(value * multiplier) / multiplier;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function forecastMetNorwayCacheKey(config: SituationDataConfig, cell: ForecastCell): string {
  return `met_norway_forecast:${config.metNorwayBaseUrl}:${cell.centerLat.toFixed(5)}:${cell.centerLon.toFixed(5)}`;
}

function weatherCodeFromMetNorwaySymbol(symbolCode: string | undefined, precipitationMm: number | undefined): number | undefined {
  if (!symbolCode) {
    return undefined;
  }
  if (symbolCode.includes("thunder")) {
    return 95;
  }
  if (symbolCode.includes("heavyrain")) {
    return 65;
  }
  if (symbolCode.includes("rainshowers")) {
    return 80;
  }
  if (symbolCode.includes("rain")) {
    return 61;
  }
  if (symbolCode.includes("heavysnow")) {
    return 75;
  }
  if (symbolCode.includes("snow")) {
    return 71;
  }
  if (symbolCode.includes("sleet")) {
    return 69;
  }
  if (symbolCode.includes("fog")) {
    return 45;
  }
  if (symbolCode.includes("cloudy")) {
    return symbolCode.includes("partly") ? 2 : 3;
  }
  if (symbolCode.includes("fair")) {
    return 1;
  }
  if (symbolCode.includes("clearsky")) {
    return 0;
  }
  return (precipitationMm ?? 0) > 0 ? 61 : undefined;
}
