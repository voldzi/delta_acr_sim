import { XMLParser } from "fast-xml-parser";
import type { SafetyDataConfig } from "./config.js";
import { HttpRequestError, requestJson, requestText } from "./http.js";
import { ManagedResponseCache } from "./response-cache.js";
import type {
  BoundingBox,
  SafetyCertainty,
  SafetyDataLicense,
  SafetyDataSourceId,
  SafetyFeature,
  SafetyLayerId,
  SafetyQuery,
  SafetySeverity,
  SafetyUrgency,
  SourceDescriptor,
  SourceFetchResult
} from "./types.js";

export interface SafetyDataSource {
  descriptor: SourceDescriptor;
  fetchFeatures(query: SafetyQuery): Promise<SourceFetchResult>;
}

const MOCK_LICENSE: SafetyDataLicense = {
  name: "Synthetic internal test data",
  attribution: "DELTA ACR SIM",
  commercialUse: "allowed",
  operationalUse: "allowed",
  notes: ["Synthetic safety features for COP integration testing."]
};

const CHMI_OPEN_DATA_LICENSE: SafetyDataLicense = {
  name: "CHMI Open Data",
  url: "https://opendata.chmi.cz/",
  attribution: "Czech Hydrometeorological Institute (CHMI)",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Attribution is required.",
    "Warnings and hydrological observations are public context; operational decisions must rely on official channels.",
    "CAP alerts can carry administrative geocodes without exact polygons; this API preserves geocodes and uses representative map points when polygons are not available."
  ]
};

export function createSafetyDataSources(config: SafetyDataConfig): SafetyDataSource[] {
  const allSources: Record<SafetyDataSourceId, SafetyDataSource> = {
    mock: new MockSafetyDataSource(),
    chmi_alerts: new ChmiAlertsSource(config),
    chmi_hydro: new ChmiHydroSource(config)
  };

  return config.enabledSources.map((sourceId) => allSources[sourceId]);
}

export function allSourceDescriptors(config: SafetyDataConfig): SourceDescriptor[] {
  const enabled = new Set(config.enabledSources);
  return [new MockSafetyDataSource().descriptor, new ChmiAlertsSource(config).descriptor, new ChmiHydroSource(config).descriptor].map(
    (descriptor) => ({ ...descriptor, enabled: enabled.has(descriptor.sourceId) })
  );
}

class MockSafetyDataSource implements SafetyDataSource {
  readonly descriptor: SourceDescriptor = {
    sourceId: "mock",
    label: "Synthetic local safety feed",
    enabled: true,
    mode: "mock",
    priority: 10,
    layers: ["warnings", "flood"],
    license: MOCK_LICENSE,
    updateCadenceSeconds: 10
  };

  async fetchFeatures(query: SafetyQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    const features = mockFeatures(query.bbox, fetchedAt)
      .filter((feature) => query.layers.includes(feature.properties.layer))
      .filter((feature) => isFeatureInBbox(feature, query.bbox))
      .map((feature) => stripRawIfNeeded(feature, query.includeRaw));

    return {
      source: this.descriptor,
      fetchedAt,
      features,
      warnings: []
    };
  }
}

class ChmiAlertsSource implements SafetyDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly listingCache: ManagedResponseCache<string>;
  private readonly capCache: ManagedResponseCache<unknown>;

  constructor(private readonly config: SafetyDataConfig) {
    this.listingCache = new ManagedResponseCache<string>({
      ttlMs: Math.max(60_000, config.cacheTtlSeconds * 1000),
      staleIfErrorMs: Math.max(10 * 60_000, config.staleIfErrorSeconds * 1000),
      maxEntries: 1
    });
    this.capCache = new ManagedResponseCache<unknown>({
      ttlMs: Math.max(60_000, config.cacheTtlSeconds * 1000),
      staleIfErrorMs: Math.max(10 * 60_000, config.staleIfErrorSeconds * 1000),
      maxEntries: 4
    });
    this.descriptor = {
      sourceId: "chmi_alerts",
      label: "CHMI CAP weather warnings",
      enabled: config.enabledSources.includes("chmi_alerts"),
      mode: "live",
      priority: 90,
      layers: ["warnings"],
      license: CHMI_OPEN_DATA_LICENSE,
      baseUrl: config.chmiAlertsCapBaseUrl,
      updateCadenceSeconds: 300
    };
  }

  async fetchFeatures(query: SafetyQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("warnings")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const listing = await this.listingCache.getOrLoad("chmi_alerts_listing", () =>
      requestText(this.config.chmiAlertsCapBaseUrl, this.config.requestTimeoutMs)
    );
    const capUrl = latestCapUrl(listing, this.config.chmiAlertsCapBaseUrl);
    if (!capUrl) {
      return {
        source: this.descriptor,
        fetchedAt,
        features: [],
        warnings: ["chmi_alerts skipped: no CAP XML file was found in the source directory."]
      };
    }

    const parsed = await this.capCache.getOrLoad(capUrl, async () => {
      const xml = await requestText(capUrl, this.config.requestTimeoutMs);
      const parser = new XMLParser({
        ignoreAttributes: false,
        removeNSPrefix: true,
        isArray: (name) => ["info", "area", "geocode", "parameter"].includes(name)
      });
      return parser.parse(xml) as unknown;
    });

    const features = mapCapAlert(parsed, query, fetchedAt, capUrl).filter((feature) => isFeatureInBbox(feature, query.bbox));
    return { source: this.descriptor, fetchedAt, features: features.slice(0, query.limit), warnings: [] };
  }
}

class ChmiHydroSource implements SafetyDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly metadataCache: ManagedResponseCache<HydroStation[]>;
  private readonly stationDataCache: ManagedResponseCache<HydroNowResponse>;
  private readonly missingStationDataUntilMs = new Map<string, number>();

  constructor(private readonly config: SafetyDataConfig) {
    this.metadataCache = new ManagedResponseCache<HydroStation[]>({
      ttlMs: 24 * 60 * 60 * 1000,
      staleIfErrorMs: 7 * 24 * 60 * 60 * 1000,
      maxEntries: 1
    });
    this.stationDataCache = new ManagedResponseCache<HydroNowResponse>({
      ttlMs: Math.max(5 * 60_000, config.cacheTtlSeconds * 1000),
      staleIfErrorMs: Math.max(60 * 60_000, config.staleIfErrorSeconds * 1000),
      maxEntries: Math.max(64, config.cacheMaxEntries)
    });
    this.descriptor = {
      sourceId: "chmi_hydro",
      label: "CHMI hydrological stations",
      enabled: config.enabledSources.includes("chmi_hydro"),
      mode: "live",
      priority: 85,
      layers: ["flood"],
      license: CHMI_OPEN_DATA_LICENSE,
      baseUrl: config.chmiHydroNowBaseUrl,
      updateCadenceSeconds: 600
    };
  }

  async fetchFeatures(query: SafetyQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("flood")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const stations = await this.metadataCache.getOrLoad("chmi_hydro_metadata", () => fetchHydroStations(this.config));
    const selectedStations = stations
      .filter((station) => isPointInBbox(station.lon, station.lat, query.bbox))
      .slice(0, Math.min(query.limit, this.config.chmiHydroMaxStations));

    const features: SafetyFeature[] = [];
    const warnings: string[] = [];
    let missingCurrentDataCount = 0;
    let failedStationCount = 0;
    for (let index = 0; index < selectedStations.length; index += 8) {
      const batch = selectedStations.slice(index, index + 8);
      const settled = await Promise.allSettled(batch.map((station) => this.fetchStationFeature(station, query.includeRaw, fetchedAt)));
      for (const item of settled) {
        if (item.status === "fulfilled") {
          if (item.value.feature) {
            features.push(item.value.feature);
          }
          if (item.value.missingCurrentData) {
            missingCurrentDataCount += 1;
          }
        } else {
          failedStationCount += 1;
        }
      }
    }

    if (failedStationCount > 0) {
      warnings.push(`chmi_hydro: ${failedStationCount} station observation fetches failed.`);
    }
    if (features.length === 0 && missingCurrentDataCount > 0) {
      warnings.push(`chmi_hydro: no current observations are available for ${missingCurrentDataCount} selected stations.`);
    }

    return { source: this.descriptor, fetchedAt, features: features.slice(0, query.limit), warnings };
  }

  private async fetchStationFeature(station: HydroStation, includeRaw: boolean, fetchedAt: string): Promise<HydroStationFetchResult> {
    if (this.isMissingStationDataCached(station.objId)) {
      return { missingCurrentData: true };
    }
    const url = `${trimTrailingSlash(this.config.chmiHydroNowBaseUrl)}/${encodeURIComponent(station.objId)}.json`;
    try {
      const payload = await this.stationDataCache.getOrLoad(url, () => requestJson<HydroNowResponse>(url, this.config.requestTimeoutMs));
      return { feature: mapHydroStation(station, payload, includeRaw, fetchedAt) };
    } catch (error) {
      if (error instanceof HttpRequestError && error.status === 404) {
        this.cacheMissingStationData(station.objId);
        return { missingCurrentData: true };
      }
      throw error;
    }
  }

  private isMissingStationDataCached(stationId: string): boolean {
    const expiresAtMs = this.missingStationDataUntilMs.get(stationId);
    if (!expiresAtMs) {
      return false;
    }
    if (expiresAtMs <= Date.now()) {
      this.missingStationDataUntilMs.delete(stationId);
      return false;
    }
    return true;
  }

  private cacheMissingStationData(stationId: string): void {
    this.missingStationDataUntilMs.set(stationId, Date.now() + 6 * 60 * 60 * 1000);
  }
}

interface HydroStationFetchResult {
  feature?: SafetyFeature;
  missingCurrentData?: boolean;
}

interface FeatureInput {
  id: string;
  lon: number;
  lat: number;
  layer: SafetyLayerId;
  category: string;
  headline: string;
  description?: string;
  recommendedAction?: string;
  sourceId: SafetyDataSourceId;
  license: SafetyDataLicense;
  observedAt: string;
  effectiveAt?: string;
  expiresAt?: string;
  confidence: number;
  severity: SafetySeverity;
  urgency?: SafetyUrgency;
  certainty?: SafetyCertainty;
  affectedAreas?: string[];
  geocodes?: Array<{ scheme: string; value: string }>;
  metrics?: Record<string, number | string | boolean>;
  tags?: Record<string, string>;
  raw?: unknown;
}

function makePointFeature(input: FeatureInput): SafetyFeature {
  return {
    type: "Feature",
    id: input.id,
    geometry: {
      type: "Point",
      coordinates: [round(input.lon, 6), round(input.lat, 6)]
    },
    properties: {
      featureId: input.id,
      layer: input.layer,
      category: input.category,
      headline: input.headline,
      description: input.description,
      recommendedAction: input.recommendedAction,
      sourceId: input.sourceId,
      observedAt: input.observedAt,
      effectiveAt: input.effectiveAt,
      expiresAt: input.expiresAt,
      confidence: round(Math.max(0, Math.min(1, input.confidence)), 2),
      stale: false,
      severity: input.severity,
      urgency: input.urgency ?? "unknown",
      certainty: input.certainty ?? "unknown",
      license: {
        name: input.license.name,
        attribution: input.license.attribution,
        url: input.license.url
      },
      affectedAreas: input.affectedAreas,
      geocodes: input.geocodes,
      metrics: input.metrics,
      tags: input.tags,
      raw: input.raw
    }
  };
}

function mockFeatures(bbox: BoundingBox, observedAt: string): SafetyFeature[] {
  const center = bboxCenter(bbox);
  return [
    makePointFeature({
      id: "warnings:mock:wind-prague-west",
      lon: center.lon,
      lat: center.lat,
      layer: "warnings",
      category: "weather_warning",
      headline: "Synthetic wind warning",
      description: "Synthetic advisory feature used to validate COP safety rendering.",
      recommendedAction: "Validate layer rendering and stale handling only.",
      sourceId: "mock",
      license: MOCK_LICENSE,
      observedAt,
      effectiveAt: observedAt,
      expiresAt: addSeconds(observedAt, 2 * 60 * 60),
      confidence: 0.92,
      severity: "advisory",
      urgency: "expected",
      certainty: "likely",
      affectedAreas: ["Pilot area"],
      metrics: { windGustMps: 19 }
    }),
    makePointFeature({
      id: "flood:mock:vltava-reference",
      lon: Math.min(bbox.east, Math.max(bbox.west, 14.414)),
      lat: Math.min(bbox.north, Math.max(bbox.south, 50.087)),
      layer: "flood",
      category: "water_level",
      headline: "Synthetic Vltava water level",
      description: "Synthetic station observation for flood layer validation.",
      sourceId: "mock",
      license: MOCK_LICENSE,
      observedAt,
      expiresAt: addSeconds(observedAt, 60 * 60),
      confidence: 0.9,
      severity: "info",
      urgency: "unknown",
      certainty: "observed",
      metrics: { waterLevelCm: 142, floodActivityLevel: 0 },
      tags: { streamName: "Vltava", stationName: "Pilot reference" }
    })
  ];
}

function mapCapAlert(payload: unknown, query: SafetyQuery, fetchedAt: string, capUrl: string): SafetyFeature[] {
  const root = asRecord(payload) ?? {};
  const alert = asRecord(root.alert) ?? root;
  const identifier = optionalString(alert.identifier) ?? stableToken(capUrl);
  const sender = optionalString(alert.sender);
  const sent = normalizeTimestamp(optionalString(alert.sent)) ?? fetchedAt;
  const status = optionalString(alert.status);
  const msgType = optionalString(alert.msgType);
  const infos = toArray(alert.info).map(asRecord).filter(Boolean) as Array<Record<string, unknown>>;
  const center = bboxCenter(query.bbox);

  return infos.flatMap((info, index) => {
    const event = optionalString(info.event) ?? "CHMI warning";
    const onset = normalizeTimestamp(optionalString(info.onset));
    const expires = normalizeTimestamp(optionalString(info.expires));
    const description = optionalString(info.description);
    const instruction = optionalString(info.instruction);
    if (isInactiveCapInfo(event, description, optionalString(info.severity), optionalString(info.certainty))) {
      return [];
    }

    const severity = capSeverity(optionalString(info.severity), event);
    const areas = toArray(info.area).map(asRecord).filter(Boolean) as Array<Record<string, unknown>>;
    const affectedAreas = unique(
      areas
        .map((area) => optionalString(area.areaDesc))
        .filter((value): value is string => Boolean(value))
    );
    const geocodes = areas.flatMap((area) =>
      toArray(area.geocode)
        .map(asRecord)
        .filter(Boolean)
        .map((geocode) => ({
          scheme: optionalString(geocode?.valueName) ?? "unknown",
          value: optionalString(geocode?.value) ?? ""
        }))
        .filter((geocode) => geocode.value.length > 0)
    );
    const headline = optionalString(info.headline) ?? event;
    const category = isNoWarning(event, optionalString(info.description)) ? "no_active_warning" : "weather_warning";

    return makePointFeature({
      id: `warnings:chmi_alerts:${stableToken(`${identifier}:${event}:${onset ?? sent}:${index}`)}`,
      lon: center.lon,
      lat: center.lat,
      layer: "warnings",
      category,
      headline,
      description,
      recommendedAction: instruction,
      sourceId: "chmi_alerts",
      license: CHMI_OPEN_DATA_LICENSE,
      observedAt: sent,
      effectiveAt: onset ?? sent,
      expiresAt: expires ?? addSeconds(sent, 24 * 60 * 60),
      confidence: capConfidence(optionalString(info.certainty), severity),
      severity,
      urgency: capUrgency(optionalString(info.urgency)),
      certainty: capCertainty(optionalString(info.certainty)),
      affectedAreas,
      geocodes,
      metrics: compactMetrics({
        areaCount: affectedAreas.length,
        geocodeCount: geocodes.length
      }),
      tags: compactTags({
        sender,
        status,
        msgType,
        language: optionalString(info.language),
        web: optionalString(info.web),
        capUrl
      }),
      raw: query.includeRaw ? info : undefined
    });
  });
}

interface HydroStation {
  objId: string;
  stationCode?: string;
  stationName: string;
  streamName?: string;
  lat: number;
  lon: number;
  spaType?: string;
  dryH?: number;
  spa1H?: number;
  spa2H?: number;
  spa3H?: number;
  spa4H?: number;
}

interface HydroNowResponse {
  objList?: Array<{
    objID?: string;
    tsList?: Array<{
      tsConID?: string;
      unit?: string;
      tsData?: Array<{
        dt?: string;
        value?: number | string | null;
      }>;
    }>;
  }>;
}

interface HydroObservation {
  observedAt: string;
  value: number;
  unit?: string;
}

async function fetchHydroStations(config: SafetyDataConfig): Promise<HydroStation[]> {
  const payload = await requestJson<unknown>(config.chmiHydroMetadataUrl, config.requestTimeoutMs);
  const root = asRecord(payload) ?? {};
  const data = asRecord(asRecord(root.data)?.data);
  const header = optionalString(data?.header);
  const rows = Array.isArray(data?.values) ? data.values : [];
  if (!header || rows.length === 0) {
    throw new Error("CHMI hydrological metadata has unexpected shape.");
  }

  const headers = header.split(",").map((item) => item.trim());
  return rows
    .map((row) => (Array.isArray(row) ? row : []))
    .map((row) => Object.fromEntries(headers.map((key, index) => [key, row[index]])))
    .map(mapHydroStationMetadata)
    .filter((station): station is HydroStation => Boolean(station));
}

function mapHydroStationMetadata(record: Record<string, unknown>): HydroStation | undefined {
  const objId = optionalString(record.objID);
  const stationName = optionalString(record.STATION_NAME);
  const lat = optionalNumber(record.GEOGR1);
  const lon = optionalNumber(record.GEOGR2);
  if (!objId || !stationName || lat === undefined || lon === undefined) {
    return undefined;
  }

  return {
    objId,
    stationCode: optionalString(record.DBC),
    stationName,
    streamName: optionalString(record.STREAM_NAME),
    lat,
    lon,
    spaType: optionalString(record.SPA_TYP),
    dryH: optionalNumber(record.DRYH),
    spa1H: optionalNumber(record.SPA1H),
    spa2H: optionalNumber(record.SPA2H),
    spa3H: optionalNumber(record.SPA3H),
    spa4H: optionalNumber(record.SPA4H)
  };
}

function mapHydroStation(station: HydroStation, payload: HydroNowResponse, includeRaw: boolean, fetchedAt: string): SafetyFeature | undefined {
  const object = payload.objList?.find((item) => item.objID === station.objId) ?? payload.objList?.[0];
  const waterLevel = latestObservation(object?.tsList?.find((series) => series.tsConID === "H"));
  const flow = latestObservation(object?.tsList?.find((series) => series.tsConID === "Q"));
  if (!waterLevel && !flow) {
    return undefined;
  }

  const observed = waterLevel ?? flow;
  if (!observed) {
    return undefined;
  }

  const floodActivityLevel = floodLevel(waterLevel?.value, station);
  const severity = floodSeverity(floodActivityLevel);
  const stream = station.streamName ? ` - ${station.streamName}` : "";

  return makePointFeature({
    id: `flood:chmi_hydro:${stableToken(station.objId)}`,
    lon: station.lon,
    lat: station.lat,
    layer: "flood",
    category: "water_level",
    headline: `${station.stationName}${stream}`,
    description:
      waterLevel !== undefined
        ? `CHMI hydrological station water level ${Math.round(waterLevel.value)} ${waterLevel.unit ?? "cm"}.`
        : "CHMI hydrological station discharge observation.",
    sourceId: "chmi_hydro",
    license: CHMI_OPEN_DATA_LICENSE,
    observedAt: observed.observedAt,
    expiresAt: addSeconds(fetchedAt, 2 * 60 * 60),
    confidence: hydroConfidence(observed.observedAt),
    severity,
    urgency: floodActivityLevel >= 2 ? "expected" : "unknown",
    certainty: "observed",
    metrics: compactMetrics({
      waterLevelCm: waterLevel?.value,
      flowM3s: flow?.value,
      floodActivityLevel,
      dryLevelCm: station.dryH,
      spa1Cm: station.spa1H,
      spa2Cm: station.spa2H,
      spa3Cm: station.spa3H,
      spa4Cm: station.spa4H
    }),
    tags: compactTags({
      stationId: station.objId,
      stationCode: station.stationCode,
      stationName: station.stationName,
      streamName: station.streamName,
      spaType: station.spaType
    }),
    raw: includeRaw ? payload : undefined
  });
}

type HydroSeries = NonNullable<NonNullable<HydroNowResponse["objList"]>[number]["tsList"]>[number];

function latestObservation(series: HydroSeries | undefined): HydroObservation | undefined {
  const data = series?.tsData ?? [];
  const sorted = data
    .map((point) => ({
      observedAt: normalizeTimestamp(optionalString(point.dt)),
      value: optionalNumber(point.value)
    }))
    .filter((point): point is { observedAt: string; value: number } => point.observedAt !== undefined && point.value !== undefined)
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const latest = sorted[0];
  return latest ? { ...latest, unit: series?.unit } : undefined;
}

function latestCapUrl(listing: string, baseUrl: string): string | undefined {
  const entries: Array<{ href: string; dateMs: number }> = [];
  const pattern = /href="([^"]+\.xml)"[^>]*>.*?<\/a>\s*([0-9]{2}-[A-Za-z]{3}-[0-9]{4}\s+[0-9]{2}:[0-9]{2})?/gims;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(listing))) {
    const href = match[1];
    if (!href) {
      continue;
    }
    entries.push({
      href,
      dateMs: parseDirectoryDate(match[2]) ?? 0
    });
  }

  const latest = entries.sort((a, b) => {
    const dateDelta = b.dateMs - a.dateMs;
    return dateDelta !== 0 ? dateDelta : a.href.localeCompare(b.href);
  })[0];
  return latest ? new URL(latest.href, baseUrl).toString() : undefined;
}

function parseDirectoryDate(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^([0-9]{2})-([A-Za-z]{3})-([0-9]{4})\s+([0-9]{2}):([0-9]{2})$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const [, day, monthName, year, hour, minute] = match;
  const months: Record<string, number> = {
    Jan: 0,
    Feb: 1,
    Mar: 2,
    Apr: 3,
    May: 4,
    Jun: 5,
    Jul: 6,
    Aug: 7,
    Sep: 8,
    Oct: 9,
    Nov: 10,
    Dec: 11
  };
  const month = months[monthName ?? ""];
  if (month === undefined) {
    return undefined;
  }
  return Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute));
}

function floodLevel(waterLevelCm: number | undefined, station: HydroStation): number {
  if (waterLevelCm === undefined) {
    return 0;
  }
  if (station.spa4H !== undefined && waterLevelCm >= station.spa4H) {
    return 4;
  }
  if (station.spa3H !== undefined && waterLevelCm >= station.spa3H) {
    return 3;
  }
  if (station.spa2H !== undefined && waterLevelCm >= station.spa2H) {
    return 2;
  }
  if (station.spa1H !== undefined && waterLevelCm >= station.spa1H) {
    return 1;
  }
  return 0;
}

function floodSeverity(level: number): SafetySeverity {
  if (level >= 3) {
    return "critical";
  }
  if (level === 2) {
    return "warning";
  }
  if (level === 1) {
    return "advisory";
  }
  return "info";
}

function capSeverity(value: string | undefined, event: string): SafetySeverity {
  if (isNoWarning(event)) {
    return "info";
  }
  switch ((value ?? "").toLowerCase()) {
    case "extreme":
    case "severe":
      return "critical";
    case "moderate":
      return "warning";
    case "minor":
      return "advisory";
    default:
      return "info";
  }
}

function capUrgency(value: string | undefined): SafetyUrgency {
  switch ((value ?? "").toLowerCase()) {
    case "immediate":
      return "immediate";
    case "expected":
      return "expected";
    case "future":
      return "future";
    case "past":
      return "past";
    default:
      return "unknown";
  }
}

function capCertainty(value: string | undefined): SafetyCertainty {
  switch ((value ?? "").toLowerCase()) {
    case "observed":
      return "observed";
    case "likely":
      return "likely";
    case "possible":
      return "possible";
    case "unlikely":
      return "unlikely";
    default:
      return "unknown";
  }
}

function capConfidence(certainty: string | undefined, severity: SafetySeverity): number {
  const base =
    capCertainty(certainty) === "observed"
      ? 0.95
      : capCertainty(certainty) === "likely"
        ? 0.86
        : capCertainty(certainty) === "possible"
          ? 0.68
          : capCertainty(certainty) === "unlikely"
            ? 0.45
            : 0.6;
  return severity === "info" ? Math.min(0.95, base + 0.05) : base;
}

function hydroConfidence(observedAt: string): number {
  const ageSeconds = Math.max(0, (Date.now() - Date.parse(observedAt)) / 1000);
  if (ageSeconds <= 60 * 60) {
    return 0.92;
  }
  if (ageSeconds <= 3 * 60 * 60) {
    return 0.78;
  }
  if (ageSeconds <= 12 * 60 * 60) {
    return 0.58;
  }
  return 0.35;
}

function isNoWarning(event: string | undefined, description?: string): boolean {
  const text = `${event ?? ""} ${description ?? ""}`.toLowerCase();
  return text.includes("žádná výstraha") || text.includes("zadna vystraha") || text.includes("no warning");
}

function isInactiveCapInfo(event: string | undefined, description: string | undefined, severity: string | undefined, certainty: string | undefined): boolean {
  if (isNoWarning(event, description)) {
    return true;
  }
  const normalizedEvent = (event ?? "").toLowerCase();
  return !description && severity?.toLowerCase() === "minor" && certainty?.toLowerCase() === "unlikely" && normalizedEvent.includes("warning");
}

function stripRawIfNeeded(feature: SafetyFeature, includeRaw: boolean): SafetyFeature {
  if (includeRaw) {
    return feature;
  }
  return {
    ...feature,
    properties: {
      ...feature.properties,
      raw: undefined
    }
  };
}

function isFeatureInBbox(feature: SafetyFeature, bbox: BoundingBox): boolean {
  if (feature.geometry.type !== "Point") {
    return true;
  }
  const [lon, lat] = feature.geometry.coordinates;
  return isPointInBbox(lon, lat, bbox);
}

function isPointInBbox(lon: number, lat: number, bbox: BoundingBox): boolean {
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

function bboxCenter(bbox: BoundingBox): { lon: number; lat: number } {
  return {
    lon: (bbox.west + bbox.east) / 2,
    lat: (bbox.south + bbox.north) / 2
  };
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function addSeconds(value: string, seconds: number): string {
  return new Date(Date.parse(value) + seconds * 1000).toISOString();
}

function compactMetrics(input: Record<string, number | string | boolean | undefined>): Record<string, number | string | boolean> | undefined {
  const output = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  return Object.keys(output).length > 0 ? (output as Record<string, number | string | boolean>) : undefined;
}

function compactTags(input: Record<string, string | undefined>): Record<string, string> | undefined {
  const output = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ""));
  return Object.keys(output).length > 0 ? (output as Record<string, string>) : undefined;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stableToken(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
