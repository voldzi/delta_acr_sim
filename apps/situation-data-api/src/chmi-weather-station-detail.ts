import type { SituationDataConfig } from "./config.js";
import { ManagedResponseCache } from "./response-cache.js";
import { chmiWeatherPresentation, normalizeChmiPresentWeatherCode } from "./sources.js";

type WeatherDetailSeverity = "info" | "advisory" | "warning" | "critical";

interface ChmiDataCollectionPayload {
  data?: {
    data?: {
      header?: string;
      values?: unknown[][];
    };
  };
}

interface ChmiWeatherStationMetadata {
  stationId: string;
  ghId?: string;
  name: string;
  lon: number;
  lat: number;
  elevationM?: number;
}

interface ChmiWeatherFileRef {
  href: string;
  dateToken: string;
}

interface WeatherHistoryPoint {
  time: string;
  temperatureC?: number;
  relativeHumidityPercent?: number;
  pressureHpa?: number;
  windDirectionDeg?: number;
  windSpeedMps?: number;
  windGustMps?: number;
  precipitation10mMm?: number;
  precipitation1hMm?: number;
  sunshineDurationSeconds?: number;
  sunshineDuration1hTenths?: number;
  presentWeatherCode?: number;
  normalizedPresentWeatherCode?: number;
  cloudCoverOctas?: number;
  cloudCoverPercent?: number;
  visibilityCode?: number;
}

interface WeatherForecastPoint {
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
}

interface WeatherChartSeries {
  seriesId: string;
  label: string;
  source: "chmi" | "open_meteo";
  unit: string;
  style: "solid" | "dashed" | "bar";
  points: Array<{ time: string; value: number }>;
}

interface WeatherChart {
  chartId: string;
  title: string;
  titleEn: string;
  preferredType: "line" | "bar" | "combined";
  xField: "time";
  yUnit: string;
  series: WeatherChartSeries[];
}

interface OpenMeteoForecastResponse {
  hourly?: Record<string, unknown[]>;
  hourly_units?: Record<string, unknown>;
  generationtime_ms?: number;
}

export interface ChmiWeatherStationDetailOptions {
  historyHours?: number;
  forecastHours?: number;
}

export class ChmiWeatherStationDetailService {
  private readonly metadataIndexCache: ManagedResponseCache<string>;
  private readonly dataIndexCache: ManagedResponseCache<string>;
  private readonly metadataCache: ManagedResponseCache<ChmiDataCollectionPayload>;
  private readonly stationFileCache: ManagedResponseCache<ChmiDataCollectionPayload>;
  private readonly forecastCache: ManagedResponseCache<OpenMeteoForecastResponse>;

  constructor(private readonly config: SituationDataConfig) {
    this.metadataIndexCache = new ManagedResponseCache<string>({
      ttlMs: Math.max(300, config.chmiWeatherCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(3600, config.staleIfErrorSeconds) * 1000,
      maxEntries: 1
    });
    this.dataIndexCache = new ManagedResponseCache<string>({
      ttlMs: Math.max(300, config.chmiWeatherCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(3600, config.staleIfErrorSeconds) * 1000,
      maxEntries: 1
    });
    this.metadataCache = new ManagedResponseCache<ChmiDataCollectionPayload>({
      ttlMs: Math.max(300, config.chmiWeatherCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(3600, config.staleIfErrorSeconds) * 1000,
      maxEntries: 4
    });
    this.stationFileCache = new ManagedResponseCache<ChmiDataCollectionPayload>({
      ttlMs: Math.max(300, config.chmiWeatherCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(3600, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(128, Math.min(config.cacheMaxEntries, 2048))
    });
    this.forecastCache = new ManagedResponseCache<OpenMeteoForecastResponse>({
      ttlMs: Math.max(300, config.openMeteoCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(3600, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(128, Math.min(config.cacheMaxEntries, 2048))
    });
  }

  async getDetail(stationId: string, options: ChmiWeatherStationDetailOptions = {}): Promise<Record<string, unknown> | undefined> {
    const normalizedStationId = stationId.trim();
    if (!/^[A-Za-z0-9_.:-]{3,96}$/.test(normalizedStationId)) {
      return undefined;
    }

    const generatedAt = new Date().toISOString();
    const historyHours = clampInteger(options.historyHours, 48, 1, 72);
    const forecastHours = clampInteger(options.forecastHours, 24, 1, 72);
    const [metadataIndex, dataIndex] = await Promise.all([
      this.metadataIndexCache.getOrLoad("chmi_weather_detail_metadata_index", () =>
        requestText(this.config.chmiWeatherMetadataBaseUrl, this.config.requestTimeoutMs)
      ),
      this.dataIndexCache.getOrLoad("chmi_weather_detail_data_index", () => requestText(this.config.chmiWeatherDataBaseUrl, this.config.requestTimeoutMs))
    ]);

    const metadataHref = latestHrefFromIndex(metadataIndex, /^meta1-\d{8}\.json$/);
    if (!metadataHref) {
      throw new Error("CHMI weather metadata index did not contain meta1 files.");
    }
    const metadataUrl = joinUrl(this.config.chmiWeatherMetadataBaseUrl, metadataHref);
    const metadata = await this.metadataCache.getOrLoad(metadataUrl, () => requestJson<ChmiDataCollectionPayload>(metadataUrl, this.config.requestTimeoutMs));
    const station = chmiWeatherStationsFromMetadata(metadata).find((item) => item.stationId === normalizedStationId);
    if (!station) {
      return undefined;
    }

    const historyFiles = chmiWeatherStationFiles(dataIndex, normalizedStationId, "10m").slice(-4);
    const hourlyFiles = chmiWeatherStationFiles(dataIndex, normalizedStationId, "1h").slice(-4);
    const [historyPayloads, hourlyPayloads] = await Promise.all([
      Promise.all(historyFiles.map((file) => this.loadStationFile(file))),
      Promise.all(hourlyFiles.map((file) => this.loadStationFile(file).catch(() => undefined)))
    ]);

    const history = mergeWeatherHistory(
      historyPayloads.flatMap((payload) => stationHistoryPoints(payload, CHMI_WEATHER_10M_ELEMENTS)),
      hourlyPayloads.flatMap((payload) => (payload ? stationHistoryPoints(payload, CHMI_WEATHER_1H_ELEMENTS) : [])),
      historyHours
    );
    const forecast = await this.loadForecast(station, forecastHours).catch(() => []);
    const currentObserved = [...history]
      .reverse()
      .find(
        (point) =>
          point.temperatureC !== undefined ||
          point.windSpeedMps !== undefined ||
          point.windGustMps !== undefined ||
          point.relativeHumidityPercent !== undefined ||
          point.precipitation10mMm !== undefined
      );
    const hourlyCurrent = [...history]
      .reverse()
      .find(
        (point) =>
          point.presentWeatherCode !== undefined ||
          point.cloudCoverOctas !== undefined ||
          point.visibilityCode !== undefined ||
          point.precipitation1hMm !== undefined ||
          point.sunshineDuration1hTenths !== undefined
      );
    const current = compactObject({
      ...(hourlyCurrent ?? {}),
      ...(currentObserved ?? {}),
      time: currentObserved?.time ?? hourlyCurrent?.time
    }) as unknown as WeatherHistoryPoint;

    const presentation = chmiWeatherPresentation({
      stationName: station.name,
      temperatureC: current?.temperatureC,
      windSpeedMps: current?.windSpeedMps,
      windGustMps: current?.windGustMps,
      precipitation10mMm: current?.precipitation10mMm,
      precipitation1hMm: hourlyCurrent?.precipitation1hMm,
      relativeHumidityPercent: current?.relativeHumidityPercent,
      sunshineDurationSeconds: current?.sunshineDurationSeconds,
      sunshineDuration1hTenths: hourlyCurrent?.sunshineDuration1hTenths,
      presentWeatherCode: hourlyCurrent?.presentWeatherCode,
      cloudCoverOctas: hourlyCurrent?.cloudCoverOctas,
      visibilityCode: hourlyCurrent?.visibilityCode
    });
    const severity = weatherSeverity(current?.windGustMps ?? current?.windSpeedMps, current?.precipitation10mMm, presentation.symbolKey);

    return {
      contractVersion: "sim-weather-station-detail-v1",
      generatedAt,
      station: {
        stationId: station.stationId,
        featureId: `weather:chmi_weather_stations:${stableToken(station.stationId)}`,
        ghId: station.ghId,
        name: station.name,
        lon: station.lon,
        lat: station.lat,
        elevationM: station.elevationM
      },
      current: {
        observedAt: current.time,
        validUntil: current.time ? addSeconds(current.time, 2 * 60 * 60) : undefined,
        severity,
        metrics: current,
        display: weatherDisplay(station, presentation, severity)
      },
      history: {
        source: "chmi_meteorology_climate_now",
        cadence: "10m + 1h",
        hours: historyHours,
        pointCount: history.length,
        from: history[0]?.time,
        to: history.at(-1)?.time,
        points: history
      },
      forecast: {
        source: "open_meteo",
        role: "model_forecast",
        hours: forecastHours,
        pointCount: forecast.length,
        from: forecast[0]?.time,
        to: forecast.at(-1)?.time,
        modelPoint: { lon: station.lon, lat: station.lat },
        points: forecast
      },
      charts: buildWeatherCharts(history, forecast),
      attribution: [
        {
          sourceId: "chmi_weather_stations",
          label: "ČHMÚ měřená meteorologická stanice",
          role: "observation"
        },
        {
          sourceId: "open_meteo",
          label: "Open-Meteo modelová předpověď",
          role: "forecast"
        }
      ],
      copInstructions: {
        renderMode: "weather_station_detail",
        renderOnly: true,
        preferredCharts: ["temperature", "precipitation", "wind", "humidity_cloud"],
        note: "COP renders supplied display and chart series. Weather condition inference is owned by SIM."
      }
    };
  }

  private async loadStationFile(file: ChmiWeatherFileRef): Promise<ChmiDataCollectionPayload> {
    const url = joinUrl(this.config.chmiWeatherDataBaseUrl, file.href);
    return this.stationFileCache.getOrLoad(url, () => requestJson<ChmiDataCollectionPayload>(url, this.config.requestTimeoutMs));
  }

  private async loadForecast(station: ChmiWeatherStationMetadata, forecastHours: number): Promise<WeatherForecastPoint[]> {
    const url = new URL(`${trimTrailingSlash(this.config.openMeteoBaseUrl)}/v1/forecast`);
    url.searchParams.set("latitude", station.lat.toFixed(5));
    url.searchParams.set("longitude", station.lon.toFixed(5));
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
    url.searchParams.set("wind_speed_unit", "ms");
    url.searchParams.set("timezone", "UTC");
    url.searchParams.set("forecast_days", "3");

    const payload = await this.forecastCache.getOrLoad(`open_meteo_station_forecast:${station.stationId}:${forecastHours}`, () =>
      requestJson<OpenMeteoForecastResponse>(url.toString(), this.config.requestTimeoutMs)
    );
    const hourly = payload.hourly ?? {};
    const times = arrayValues(hourly.time);
    const cutoff = Date.now() - 60 * 60 * 1000;
    return times
      .map((time, index): WeatherForecastPoint | undefined => {
        const iso = normalizeOpenMeteoTime(time);
        if (!iso || Date.parse(iso) < cutoff) {
          return undefined;
        }
        return compactObject({
          time: iso,
          temperatureC: numberAt(hourly.temperature_2m, index),
          relativeHumidityPercent: numberAt(hourly.relative_humidity_2m, index),
          precipitationMm: numberAt(hourly.precipitation, index),
          precipitationProbabilityPercent: numberAt(hourly.precipitation_probability, index),
          weatherCode: numberAt(hourly.weather_code, index),
          cloudCoverPercent: numberAt(hourly.cloud_cover, index),
          windSpeedMps: numberAt(hourly.wind_speed_10m, index),
          windDirectionDeg: numberAt(hourly.wind_direction_10m, index),
          windGustMps: numberAt(hourly.wind_gusts_10m, index)
        }) as unknown as WeatherForecastPoint;
      })
      .filter((point): point is WeatherForecastPoint => Boolean(point))
      .slice(0, forecastHours);
  }
}

const CHMI_WEATHER_10M_ELEMENTS = new Set(["T", "H", "P", "D", "F", "Fmax", "SRA10M", "SSV10M"]);
const CHMI_WEATHER_1H_ELEMENTS = new Set(["ww", "N", "VV", "SRA1H", "SSV1H"]);

function stationHistoryPoints(payload: ChmiDataCollectionPayload, selectedElements: Set<string>): WeatherHistoryPoint[] {
  const data = payload.data?.data;
  const headers = splitHeader(data?.header);
  const values = data?.values ?? [];
  const stationIndex = headers.indexOf("STATION");
  const elementIndex = headers.indexOf("ELEMENT");
  const timeIndex = headers.indexOf("DT");
  const valueIndex = headers.indexOf("VAL");
  const points = new Map<string, WeatherHistoryPoint>();

  for (const row of values) {
    const element = stringCell(row, elementIndex);
    if (!element || !selectedElements.has(element)) {
      continue;
    }
    const time = parseTimestamp(stringCell(row, timeIndex));
    const value = numberCell(row, valueIndex);
    if (!time || value === undefined || !stringCell(row, stationIndex)) {
      continue;
    }
    const point = points.get(time) ?? { time };
    applyWeatherValue(point, element, value);
    points.set(time, point);
  }

  return Array.from(points.values()).sort((a, b) => a.time.localeCompare(b.time));
}

function applyWeatherValue(point: WeatherHistoryPoint, element: string, value: number): void {
  switch (element) {
    case "T":
      point.temperatureC = round(value, 1);
      return;
    case "H":
      point.relativeHumidityPercent = round(value, 0);
      return;
    case "P":
      point.pressureHpa = round(value, 1);
      return;
    case "D":
      point.windDirectionDeg = round(value, 0);
      return;
    case "F":
      point.windSpeedMps = round(value, 1);
      return;
    case "Fmax":
      point.windGustMps = round(value, 1);
      return;
    case "SRA10M":
      point.precipitation10mMm = round(value, 2);
      return;
    case "SSV10M":
      point.sunshineDurationSeconds = round(value, 0);
      return;
    case "ww":
      point.presentWeatherCode = round(value, 0);
      point.normalizedPresentWeatherCode = normalizeChmiPresentWeatherCode(value);
      return;
    case "N":
      point.cloudCoverOctas = round(value, 0);
      point.cloudCoverPercent = Math.round((value / 8) * 100);
      return;
    case "VV":
      point.visibilityCode = round(value, 0);
      return;
    case "SRA1H":
      point.precipitation1hMm = round(value, 2);
      return;
    case "SSV1H":
      point.sunshineDuration1hTenths = round(value, 0);
      return;
  }
}

function mergeWeatherHistory(tenMinute: WeatherHistoryPoint[], hourly: WeatherHistoryPoint[], historyHours: number): WeatherHistoryPoint[] {
  const points = new Map<string, WeatherHistoryPoint>();
  for (const point of [...tenMinute, ...hourly]) {
    points.set(point.time, { ...(points.get(point.time) ?? { time: point.time }), ...point });
  }
  const cutoff = Date.now() - historyHours * 60 * 60 * 1000;
  return Array.from(points.values())
    .filter((point) => Date.parse(point.time) >= cutoff)
    .sort((a, b) => a.time.localeCompare(b.time));
}

function buildWeatherCharts(history: WeatherHistoryPoint[], forecast: WeatherForecastPoint[]): WeatherChart[] {
  return [
    {
      chartId: "temperature",
      title: "Teplota",
      titleEn: "Temperature",
      preferredType: "line",
      xField: "time",
      yUnit: "°C",
      series: [
        chartSeries("observed_temperature", "měření", "chmi", "°C", "solid", history, "temperatureC"),
        chartSeries("forecast_temperature", "předpověď", "open_meteo", "°C", "dashed", forecast, "temperatureC")
      ].filter((series): series is WeatherChartSeries => Boolean(series))
    },
    {
      chartId: "precipitation",
      title: "Srážky",
      titleEn: "Precipitation",
      preferredType: "bar",
      xField: "time",
      yUnit: "mm",
      series: [
        chartSeries("observed_precipitation_10m", "měření 10 min", "chmi", "mm/10 min", "bar", history, "precipitation10mMm"),
        chartSeries("forecast_precipitation", "předpověď", "open_meteo", "mm/h", "bar", forecast, "precipitationMm")
      ].filter((series): series is WeatherChartSeries => Boolean(series))
    },
    {
      chartId: "wind",
      title: "Vítr",
      titleEn: "Wind",
      preferredType: "line",
      xField: "time",
      yUnit: "m/s",
      series: [
        chartSeries("observed_wind_speed", "rychlost", "chmi", "m/s", "solid", history, "windSpeedMps"),
        chartSeries("observed_wind_gust", "náraz", "chmi", "m/s", "solid", history, "windGustMps"),
        chartSeries("forecast_wind_speed", "předpověď", "open_meteo", "m/s", "dashed", forecast, "windSpeedMps")
      ].filter((series): series is WeatherChartSeries => Boolean(series))
    },
    {
      chartId: "humidity_cloud",
      title: "Vlhkost a oblačnost",
      titleEn: "Humidity and cloud cover",
      preferredType: "line",
      xField: "time",
      yUnit: "%",
      series: [
        chartSeries("observed_humidity", "vlhkost", "chmi", "%", "solid", history, "relativeHumidityPercent"),
        chartSeries("observed_cloud_cover", "oblačnost", "chmi", "%", "solid", history, "cloudCoverPercent"),
        chartSeries("forecast_cloud_cover", "předpověď oblačnosti", "open_meteo", "%", "dashed", forecast, "cloudCoverPercent")
      ].filter((series): series is WeatherChartSeries => Boolean(series))
    }
  ];
}

function chartSeries(
  seriesId: string,
  label: string,
  source: "chmi" | "open_meteo",
  unit: string,
  style: "solid" | "dashed" | "bar",
  points: Array<WeatherHistoryPoint | WeatherForecastPoint>,
  field: string
): WeatherChartSeries | undefined {
  const data: Array<{ time: string; value: number }> = [];
  for (const point of points) {
    const value = (point as unknown as Record<string, unknown>)[field];
    if (typeof value === "number") {
      data.push({ time: point.time, value });
    }
  }
  return data.length > 0 ? { seriesId, label, source, unit, style, points: data } : undefined;
}

function weatherDisplay(
  station: ChmiWeatherStationMetadata,
  presentation: ReturnType<typeof chmiWeatherPresentation>,
  severity: WeatherDetailSeverity
): Record<string, unknown> {
  return compactObject({
    contractVersion: "sim-cop-weather-display-v1",
    renderer: "weather_station_detail_v1",
    iconKey: presentation.symbolKey,
    iconSet: "weather-symbol-v1",
    title: station.name,
    label: presentation.mapLabel,
    subtitle: presentation.detailSummary,
    badgeLabel: presentation.conditionLabel,
    badgeLabelEn: presentation.conditionLabelEn,
    badgeTone: displayTone(presentation.symbolKey, presentation.conditionMode, severity),
    primaryValue: presentation.primaryValue,
    secondaryValue: presentation.secondaryValue,
    tertiaryValue: presentation.tertiaryValue,
    conditionMode: presentation.conditionMode,
    confidence: presentation.confidence,
    confidencePercent: Math.round(presentation.confidence * 100),
    authoritativeCondition: presentation.authoritativeCondition,
    sourceInputs: presentation.sourceInputs
  });
}

function weatherSeverity(windSpeedMps: number | undefined, precipitationMm: number | undefined, symbolKey: string): WeatherDetailSeverity {
  if (symbolKey === "storm" || (windSpeedMps !== undefined && windSpeedMps >= 25) || (precipitationMm !== undefined && precipitationMm >= 15)) {
    return "critical";
  }
  if (
    symbolKey === "rain" ||
    symbolKey === "snow" ||
    symbolKey === "fog" ||
    symbolKey === "wind" ||
    (windSpeedMps !== undefined && windSpeedMps >= 10) ||
    (precipitationMm !== undefined && precipitationMm >= 2)
  ) {
    return "warning";
  }
  return "info";
}

function displayTone(symbolKey: string, conditionMode: string, severity: WeatherDetailSeverity): string {
  if (severity === "critical" || symbolKey === "storm") {
    return "critical";
  }
  if (severity === "warning") {
    return "warning";
  }
  if (conditionMode === "estimated") {
    return "advisory";
  }
  if (conditionMode === "unclassified") {
    return "neutral";
  }
  return "ok";
}

function chmiWeatherStationsFromMetadata(payload: ChmiDataCollectionPayload): ChmiWeatherStationMetadata[] {
  const data = payload.data?.data;
  const headers = splitHeader(data?.header);
  const rows = data?.values ?? [];
  const stationIndex = headers.indexOf("WSI");
  const ghIndex = headers.indexOf("GH_ID");
  const nameIndex = headers.indexOf("FULL_NAME");
  const lonIndex = headers.indexOf("GEOGR1");
  const latIndex = headers.indexOf("GEOGR2");
  const elevationIndex = headers.indexOf("ELEVATION");
  return rows
    .map((row): ChmiWeatherStationMetadata | undefined => {
      const stationId = stringCell(row, stationIndex);
      const name = stringCell(row, nameIndex);
      const lon = numberCell(row, lonIndex);
      const lat = numberCell(row, latIndex);
      if (!stationId || !name || lon === undefined || lat === undefined) {
        return undefined;
      }
      return {
        stationId,
        ghId: stringCell(row, ghIndex),
        name,
        lon,
        lat,
        elevationM: numberCell(row, elevationIndex)
      };
    })
    .filter((station): station is ChmiWeatherStationMetadata => Boolean(station));
}

function chmiWeatherStationFiles(indexHtml: string, stationId: string, cadence: "10m" | "1h"): ChmiWeatherFileRef[] {
  const pattern = new RegExp(`^${cadence}-${escapeRegExp(stationId)}-(\\d{8})\\.json$`);
  return hrefsFromHtmlIndex(indexHtml)
    .map((href) => {
      const fileName = href.split("/").pop() ?? href;
      const match = pattern.exec(fileName);
      return match?.[1] ? { href, dateToken: match[1] } : undefined;
    })
    .filter((file): file is ChmiWeatherFileRef => Boolean(file))
    .sort((a, b) => a.dateToken.localeCompare(b.dateToken));
}

function latestHrefFromIndex(indexHtml: string, pattern: RegExp): string | undefined {
  return hrefsFromHtmlIndex(indexHtml)
    .map((href) => href.split("/").pop() ?? href)
    .filter((href) => pattern.test(href))
    .sort()
    .pop();
}

function hrefsFromHtmlIndex(indexHtml: string): string[] {
  return Array.from(indexHtml.matchAll(/href="([^"]+)"/g))
    .map((match) => match[1])
    .filter((href): href is string => typeof href === "string" && href.length > 0);
}

async function requestJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`GET ${url} failed with ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "text/html,text/plain" } });
    if (!response.ok) {
      throw new Error(`GET ${url} failed with ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function splitHeader(header: string | undefined): string[] {
  return header?.split(",").map((item) => item.trim()) ?? [];
}

function stringCell(row: unknown[], index: number): string | undefined {
  if (index < 0) {
    return undefined;
  }
  const value = row[index];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function numberCell(row: unknown[], index: number): number | undefined {
  if (index < 0) {
    return undefined;
  }
  return optionalNumber(row[index]);
}

function numberAt(values: unknown, index: number): number | undefined {
  return Array.isArray(values) ? optionalNumber(values[index]) : undefined;
}

function arrayValues(values: unknown): unknown[] {
  return Array.isArray(values) ? values : [];
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function normalizeOpenMeteoTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const iso = value.endsWith("Z") ? value : `${value}Z`;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function addSeconds(isoTimestamp: string, seconds: number): string {
  const parsed = Date.parse(isoTimestamp);
  return new Date(parsed + seconds * 1000).toISOString();
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(value as number)));
}

function compactObject(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => {
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
    })
  );
}

function stableToken(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, "_")
    .slice(0, 96);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlash(baseUrl)}/${path.replace(/^\/+/, "")}`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
