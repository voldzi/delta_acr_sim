import { unzipSync } from "fflate";
import gtfsRealtime from "gtfs-realtime-bindings";
import type { transit_realtime } from "gtfs-realtime-bindings";
import { canonicalizeBboxForCache, formatBboxKey, roundPointToGrid } from "./bbox-cache.js";
import type { SituationDataConfig } from "./config.js";
import { MobileCoverageSource } from "./mobile-coverage-source.js";
import { OsmPostgisSource } from "./osm-postgis-source.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type {
  BoundingBox,
  MobileCoverageQuality,
  MobileCoverageTechnology,
  MobileNetworkStatus,
  MobileNetworkTechnology,
  PointGeometry,
  SituationDataLicense,
  SituationDataSourceId,
  SituationFeature,
  SituationLayerId,
  SituationQuery,
  SituationSeverity,
  SourceHealthStatus,
  SourceDescriptor,
  SourceFetchResult
} from "./types.js";

export interface SituationDataSource {
  descriptor: SourceDescriptor;
  fetchFeatures(query: SituationQuery): Promise<SourceFetchResult>;
  cacheStats?(): SourceCacheStats[];
  healthStatus?(): Promise<SourceHealthStatus>;
}

export interface SourceCacheStats extends ManagedResponseCacheStats {
  sourceId: SituationDataSourceId;
}

const DEFAULT_MOBILE_NETWORK_TECHNOLOGIES: MobileCoverageTechnology[] = ["4G"];

const MOCK_LICENSE: SituationDataLicense = {
  name: "Synthetic internal test data",
  attribution: "CSM SIM",
  commercialUse: "allowed",
  operationalUse: "allowed",
  notes: ["Synthetic situation features for COM integration testing."]
};

const OPEN_METEO_LICENSE: SituationDataLicense = {
  name: "CC BY 4.0 / Open-Meteo Terms",
  url: "https://open-meteo.com/en/terms",
  attribution: "Weather data by Open-Meteo.com",
  commercialUse: "requires_license",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Free API is limited to non-commercial use.",
    "Data is provided under CC BY 4.0 conditions.",
    "Commercial use requires a paid Open-Meteo API plan."
  ]
};

const OSM_LICENSE: SituationDataLicense = {
  name: "ODbL 1.0",
  url: "https://opendatacommons.org/licenses/odbl/1-0/",
  attribution: "OpenStreetMap contributors",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Attribution is required.",
    "Public adapted databases must follow ODbL obligations.",
    "Public Overpass instances are shared resources; do not use them as a production runtime backend for high user volumes.",
    "Production deployments should use a local OSM extract/PostGIS-backed provider before enabling this source."
  ]
};

const CTU_NETTEST_LICENSE: SituationDataLicense = {
  name: "CC BY 4.0",
  url: "https://nettest.ctu.gov.cz/en/Opendata",
  attribution: "Czech Telecommunication Office / CTU-NetTest",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Attribution is required.",
    "Crowdsourced measurements are useful for context, not as authoritative outage detection.",
    "Locations can be anonymized or accuracy-limited."
  ]
};

const MOBILE_NETWORK_LICENSE: SituationDataLicense = {
  name: "Unified mobile network assessment",
  attribution: "CSM SIM model; Czech Telecommunication Office / CTU-NetTest; OpenStreetMap contributors where tower hints are used",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Unified assessment from public measurements, modelled coverage and infrastructure hints.",
    "Not a real-time BTS or operator NOC status feed.",
    "Do not present inferred status as confirmed outage of a concrete BTS."
  ]
};

const PID_GTFS_RT_LICENSE: SituationDataLicense = {
  name: "PID/Golemio Open Data",
  url: "https://api.golemio.cz/pid/docs/openapi/",
  attribution: "Prague Integrated Transport / Golemio Prague Data Platform",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Attribution and source-specific open-data terms apply.",
    "GTFS-RT vehicle positions are operational context, not an authoritative emergency source.",
    "Feed availability and cadence can change without notice."
  ]
};

const SAFETY_DATA_LICENSE: SituationDataLicense = {
  name: "Delegated Safety Data aggregate",
  url: "https://opendata.chmi.cz/",
  attribution: "Safety Data API; feature-level attribution preserved from original public sources",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "This source projects /safety-data/api/v1/features into the situation-data contract.",
    "Feature-level license attribution is preserved from Safety Data properties.",
    "Warnings and hydrological observations are public context, not a replacement for official emergency instructions."
  ]
};

const AVIATION_WEATHER_LICENSE: SituationDataLicense = {
  name: "NOAA/NWS Aviation Weather Center public data",
  url: "https://aviationweather.gov/data/api/",
  attribution: "NOAA National Weather Service Aviation Weather Center",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "AWC Data API is rate limited; SIM caches requests and COM must not call AWC directly.",
    "Use a custom user agent and keep requests limited in scope and frequency.",
    "Aviation weather is context only and does not replace official aviation briefing products."
  ]
};

const ARDOS_PARTNER_LICENSE: SituationDataLicense = {
  name: "ARDOS partner data under MoU",
  attribution: "ARDOS / Radioklub ACR partner feed",
  commercialUse: "requires_license",
  operationalUse: "requires_license",
  notes: [
    "Not open data; consume only through an explicit partner agreement.",
    "Do not expose personal identifiers, exact volunteer identities, or sensitive mission details in public COM views.",
    "SIM expects ARDOS to provide a filtered COM projection API with token authentication."
  ]
};

export function createSituationDataSources(config: SituationDataConfig): SituationDataSource[] {
  const allSources: Record<SituationDataSourceId, SituationDataSource> = {
    mock: new MockSituationDataSource(),
    open_meteo: new OpenMeteoSource(config),
    mobile_coverage_model: new MobileCoverageSource(config),
    mobile_network_model: new MobileNetworkSource(config),
    osm_postgis: new OsmPostgisSource(config),
    osm_overpass: new OsmOverpassSource(config),
    ctu_nettest: new CtuNettestSource(config),
    pid_gtfs_rt: new PidGtfsRtSource(config),
    safety_data: new SafetyDataProjectionSource(config),
    aviation_weather: new AviationWeatherSource(config),
    ardos_partner: new ArdosPartnerSource(config)
  };

  return config.enabledSources.map((sourceId) => allSources[sourceId]);
}

export function allSourceDescriptors(config: SituationDataConfig): SourceDescriptor[] {
  const enabled = new Set(config.enabledSources);
  return [
    new MockSituationDataSource().descriptor,
    new OpenMeteoSource(config).descriptor,
    new MobileCoverageSource(config).descriptor,
    new MobileNetworkSource(config).descriptor,
    new OsmPostgisSource(config).descriptor,
    new OsmOverpassSource(config).descriptor,
    new CtuNettestSource(config).descriptor,
    new PidGtfsRtSource(config).descriptor,
    new SafetyDataProjectionSource(config).descriptor,
    new AviationWeatherSource(config).descriptor,
    new ArdosPartnerSource(config).descriptor
  ].map((descriptor) => ({ ...descriptor, enabled: enabled.has(descriptor.sourceId) }));
}

function cacheStatsFor<T>(sourceId: SituationDataSourceId, cache: ManagedResponseCache<T>): SourceCacheStats {
  return {
    sourceId,
    ...cache.stats()
  };
}

const ctuNettestRecordsCaches = new Map<string, ManagedResponseCache<Array<Record<string, string>>>>();

function ctuNettestRecordsCache(config: SituationDataConfig): ManagedResponseCache<Array<Record<string, string>>> {
  const key = `${config.ctuNettestUrl}:${config.requestTimeoutMs}`;
  const existing = ctuNettestRecordsCaches.get(key);
  if (existing) {
    return existing;
  }
  const cache = new ManagedResponseCache<Array<Record<string, string>>>({
    ttlMs: 60 * 60 * 1000,
    staleIfErrorMs: 24 * 60 * 60 * 1000,
    maxEntries: 1
  });
  ctuNettestRecordsCaches.set(key, cache);
  return cache;
}

class MockSituationDataSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor = {
    sourceId: "mock",
    label: "Synthetic local situation feed",
    enabled: true,
    mode: "mock",
    priority: 10,
    layers: ["weather", "ground", "mobile", "traffic"],
    license: MOCK_LICENSE,
    updateCadenceSeconds: 10
  };

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    const features = mockFeatures(fetchedAt)
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

class OpenMeteoSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly payloadCache: ManagedResponseCache<OpenMeteoResponse>;

  constructor(private readonly config: SituationDataConfig) {
    this.payloadCache = new ManagedResponseCache<OpenMeteoResponse>({
      ttlMs: Math.max(1, config.openMeteoCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(60, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(64, config.cacheMaxEntries)
    });
    this.descriptor = {
      sourceId: "open_meteo",
      label: "Open-Meteo current weather",
      enabled: config.enabledSources.includes("open_meteo"),
      mode: "live",
      priority: 70,
      layers: ["weather"],
      license: OPEN_METEO_LICENSE,
      baseUrl: config.openMeteoBaseUrl,
      updateCadenceSeconds: config.openMeteoCacheTtlSeconds
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("open_meteo", this.payloadCache)];
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("weather")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const center = bboxCenter(query.bbox);
    const weatherPoint = roundPointToGrid(center.lon, center.lat, this.config.openMeteoGridDegrees);
    const url = new URL(`${this.config.openMeteoBaseUrl}/v1/forecast`);
    url.searchParams.set("latitude", weatherPoint.lat.toFixed(5));
    url.searchParams.set("longitude", weatherPoint.lon.toFixed(5));
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
    url.searchParams.set("wind_speed_unit", "ms");
    url.searchParams.set("timezone", "UTC");

    const payload = await this.payloadCache.getOrLoad(`open_meteo:${weatherPoint.lat}:${weatherPoint.lon}`, () =>
      requestJson<OpenMeteoResponse>(url.toString(), this.config.requestTimeoutMs)
    );
    const current = payload.current ?? {};
    const observedAt = normalizeOpenMeteoTime(current.time) ?? fetchedAt;
    const windSpeedMps = optionalNumber(current.wind_speed_10m);
    const precipitationMm = optionalNumber(current.precipitation);
    const weatherCode = optionalNumber(current.weather_code);
    const severity = weatherSeverity(windSpeedMps, precipitationMm, weatherCode);

    const feature = makePointFeature({
      id: `weather:open_meteo:${weatherPoint.lat.toFixed(4)}:${weatherPoint.lon.toFixed(4)}`,
      lon: center.lon,
      lat: center.lat,
      layer: "weather",
      category: "weather_observation",
      label: "Weather near map center",
      sourceId: "open_meteo",
      license: OPEN_METEO_LICENSE,
      observedAt,
      confidence: 0.86,
      severity,
      metrics: compactMetrics({
        temperatureC: optionalNumber(current.temperature_2m),
        relativeHumidityPercent: optionalNumber(current.relative_humidity_2m),
        precipitationMm,
        cloudCoverPercent: optionalNumber(current.cloud_cover),
        windSpeedMps,
        windDirectionDeg: optionalNumber(current.wind_direction_10m),
        windGustMps: optionalNumber(current.wind_gusts_10m),
        weatherCode
      }),
      raw: query.includeRaw ? { current, current_units: payload.current_units } : undefined
    });

    return { source: this.descriptor, fetchedAt, features: [feature], warnings: [] };
  }
}

class OsmOverpassSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly payloadCache: ManagedResponseCache<OverpassResponse>;

  constructor(private readonly config: SituationDataConfig) {
    this.payloadCache = new ManagedResponseCache<OverpassResponse>({
      ttlMs: Math.max(1, config.overpassCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.overpassCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(32, Math.min(config.cacheMaxEntries, 2048))
    });
    this.descriptor = {
      sourceId: "osm_overpass",
      label: "OpenStreetMap Overpass ground context",
      enabled: config.enabledSources.includes("osm_overpass"),
      mode: "live",
      priority: 50,
      layers: ["ground", "mobile"],
      license: OSM_LICENSE,
      baseUrl: config.overpassBaseUrl,
      updateCadenceSeconds: config.overpassCacheTtlSeconds
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("osm_overpass", this.payloadCache)];
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    const requestedLayers = query.layers.filter((layer) => this.descriptor.layers.includes(layer));
    if (requestedLayers.length === 0) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const cacheBbox = canonicalizeBboxForCache(query.bbox, this.config.bboxCachePaddingDegrees);
    const width = Math.abs(cacheBbox.east - cacheBbox.west);
    const height = Math.abs(cacheBbox.north - cacheBbox.south);
    if (Math.max(width, height) > this.config.overpassMaxBboxDegrees) {
      return {
        source: this.descriptor,
        fetchedAt,
        features: [],
        warnings: [`osm_overpass skipped: bbox exceeds ${this.config.overpassMaxBboxDegrees} degrees.`]
      };
    }

    const payload = await this.payloadCache.getOrLoad(`osm_overpass:${formatBboxKey(cacheBbox)}`, () =>
      requestOverpass(this.config.overpassBaseUrl, overpassQuery(cacheBbox), this.config.requestTimeoutMs)
    );
    const features = (payload.elements ?? [])
      .map((element) => mapOverpassElement(element, fetchedAt, query.includeRaw))
      .filter((feature): feature is SituationFeature => Boolean(feature))
      .filter((feature) => query.layers.includes(feature.properties.layer))
      .filter((feature) => isFeatureInBbox(feature, query.bbox))
      .slice(0, query.limit);

    return { source: this.descriptor, fetchedAt, features, warnings: [] };
  }
}

class CtuNettestSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly recordsCache: ManagedResponseCache<Array<Record<string, string>>>;

  constructor(private readonly config: SituationDataConfig) {
    this.recordsCache = ctuNettestRecordsCache(config);
    this.descriptor = {
      sourceId: "ctu_nettest",
      label: "CTU NetTest mobile measurements",
      enabled: config.enabledSources.includes("ctu_nettest"),
      mode: "live",
      priority: 65,
      layers: ["mobile"],
      license: CTU_NETTEST_LICENSE,
      baseUrl: config.ctuNettestUrl,
      updateCadenceSeconds: 3600
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("ctu_nettest", this.recordsCache)];
  }

  async healthStatus(): Promise<SourceHealthStatus> {
    try {
      const records = await this.recordsCache.getOrLoad("ctu_nettest_records", () => fetchCtuNettestRecords(this.config));
      const mobileRecords = records.filter(isCtuMobileMeasurement);
      const lastImportAt = latestCtuMeasurementAt(mobileRecords);
      const lastImportAgeSeconds = lastImportAt ? Math.max(0, Math.round((Date.now() - Date.parse(lastImportAt)) / 1000)) : undefined;
      const warnings: string[] = [];
      if (mobileRecords.length === 0) {
        warnings.push("ctu_nettest did not return mobile measurements.");
      }
      if (lastImportAgeSeconds !== undefined && lastImportAgeSeconds > 72 * 60 * 60) {
        warnings.push("ctu_nettest newest mobile measurement is older than 72 hours.");
      }
      return {
        sourceId: "ctu_nettest",
        status: warnings.length === 0 ? "ok" : "degraded",
        backend: "ctu-nettest",
        objectCount: mobileRecords.length,
        lastImportAt,
        lastImportAgeSeconds,
        warnings
      };
    } catch (error) {
      return {
        sourceId: "ctu_nettest",
        status: "degraded",
        backend: "ctu-nettest",
        warnings: [error instanceof Error ? error.message : "Unknown ctu_nettest health check failure."]
      };
    }
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("mobile")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const records = await this.recordsCache.getOrLoad("ctu_nettest_records", () => fetchCtuNettestRecords(this.config));
    const features: SituationFeature[] = [];
    for (const record of records) {
      if (features.length >= query.limit) {
        break;
      }
      const feature = mapCtuNettestRecord(record, query, fetchedAt);
      if (feature) {
        features.push(feature);
      }
    }

    return { source: this.descriptor, fetchedAt, features, warnings: [] };
  }
}

interface MobileNetworkPayload {
  generatedAt: string;
  features: SituationFeature[];
  warnings: string[];
  coverageFeatureCount: number;
  measurementCount: number;
}

interface MeasurementStats {
  count: number;
  medianDownloadMbps?: number;
  medianUploadMbps?: number;
  medianLatencyMs?: number;
  medianSignalDbm?: number;
  averageConfidence: number;
  lastMeasuredAt?: string;
  quality?: MobileCoverageQuality;
  severity: SituationSeverity;
}

export class MobileNetworkSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly payloadCache: ManagedResponseCache<MobileNetworkPayload>;
  private readonly coverageSource: MobileCoverageSource;
  private readonly ctuNettestSource: CtuNettestSource;

  constructor(private readonly config: SituationDataConfig) {
    this.payloadCache = new ManagedResponseCache<MobileNetworkPayload>({
      ttlMs: Math.max(300, config.mobileNetworkCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.mobileNetworkCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(64, Math.min(config.cacheMaxEntries, 4096))
    });
    this.coverageSource = new MobileCoverageSource(config);
    this.ctuNettestSource = new CtuNettestSource(config);
    this.descriptor = {
      sourceId: "mobile_network_model",
      label: "Unified mobile network assessment",
      enabled: config.enabledSources.includes("mobile_network_model"),
      mode: "live",
      priority: 68,
      layers: ["mobile_network"],
      license: MOBILE_NETWORK_LICENSE,
      baseUrl: publicPostgisBaseUrl(config.osmPostgisConnectionString),
      updateCadenceSeconds: config.mobileNetworkCacheTtlSeconds
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("mobile_network_model", this.payloadCache)];
  }

  async healthStatus(): Promise<SourceHealthStatus> {
    const [coverageHealth, ctuHealth] = await Promise.all([this.coverageSource.healthStatus?.(), this.ctuNettestSource.healthStatus?.()]);
    const warnings = [
      ...(coverageHealth?.warnings ?? ["mobile_network_model could not inspect mobile_coverage_model health."]),
      ...(ctuHealth?.warnings ?? ["mobile_network_model could not inspect ctu_nettest health."]),
      "mobile_network_model has no authorized real-time BTS/NOC status feed."
    ];
    return {
      sourceId: "mobile_network_model",
      status: coverageHealth?.status === "ok" ? "ok" : "degraded",
      backend: this.config.osmPostgisBackend,
      objectCount: coverageHealth?.objectCount,
      lastImportAt: ctuHealth?.lastImportAt ?? coverageHealth?.lastImportAt,
      lastImportAgeSeconds: ctuHealth?.lastImportAgeSeconds ?? coverageHealth?.lastImportAgeSeconds,
      warnings
    };
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("mobile_network")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const operators = query.mobileCoverageOperators?.length ? query.mobileCoverageOperators : ["aggregate"];
    if (!operators.some((operator) => operator === "aggregate" || operator === "unknown")) {
      return {
        source: this.descriptor,
        fetchedAt,
        features: [],
        warnings: ["mobile_network_model currently publishes aggregate/unknown operator assessment only."]
      };
    }

    const technologies = query.mobileCoverageTechnologies?.length ? query.mobileCoverageTechnologies : DEFAULT_MOBILE_NETWORK_TECHNOLOGIES;
    const cacheBbox = canonicalizeBboxForCache(query.bbox, this.config.bboxCachePaddingDegrees);
    const cacheKey = JSON.stringify({
      bbox: formatBboxKey(cacheBbox),
      technologies: [...technologies].sort(),
      operators: ["aggregate"],
      resolutionM: this.config.mobileCoverageResolutionM,
      maxCells: this.config.mobileCoverageMaxCells,
      modelVersion: this.config.mobileCoverageModelVersion
    });
    const payload = await this.payloadCache.getOrLoad(cacheKey, () => this.buildMobileNetwork(cacheBbox, technologies));
    const features = payload.features
      .filter((feature) => featureIntersectsBboxByEnvelope(feature, query.bbox))
      .slice(0, query.limit)
      .map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          raw: query.includeRaw ? feature.properties.raw : undefined
        }
      }));

    return {
      source: this.descriptor,
      fetchedAt,
      features,
      warnings: payload.warnings
    };
  }

  private async buildMobileNetwork(bbox: BoundingBox, technologies: MobileCoverageTechnology[] | undefined): Promise<MobileNetworkPayload> {
    const generatedAt = new Date().toISOString();
    const warnings: string[] = [];
    const coverageLimit = Math.min(1000, Math.max(this.config.mobileCoverageMaxCells, 1));
    const coverageQuery: SituationQuery = {
      bbox,
      layers: ["mobile_coverage"],
      sourceIds: ["mobile_coverage_model"],
      limit: coverageLimit,
      includeRaw: false,
      mobileCoverageTechnologies: technologies
    };
    const measurementQuery: SituationQuery = {
      bbox,
      layers: ["mobile"],
      sourceIds: ["ctu_nettest"],
      limit: 1000,
      includeRaw: false
    };

    const [coverageSettled, measurementSettled] = await Promise.allSettled([
      this.coverageSource.fetchFeatures(coverageQuery),
      this.ctuNettestSource.fetchFeatures(measurementQuery)
    ]);

    const coverageFeatures =
      coverageSettled.status === "fulfilled"
        ? coverageSettled.value.features.filter((feature) => feature.geometry.type === "Polygon")
        : [];
    if (coverageSettled.status === "fulfilled") {
      warnings.push(...coverageSettled.value.warnings.map((warning) => `coverage: ${warning}`));
    } else {
      warnings.push(coverageSettled.reason instanceof Error ? `coverage: ${coverageSettled.reason.message}` : "coverage: unknown failure");
    }

    const measurements =
      measurementSettled.status === "fulfilled"
        ? measurementSettled.value.features.filter((feature) => feature.geometry.type === "Point")
        : [];
    if (measurementSettled.status === "fulfilled") {
      warnings.push(...measurementSettled.value.warnings.map((warning) => `ctu_nettest: ${warning}`));
    } else {
      warnings.push(measurementSettled.reason instanceof Error ? `ctu_nettest: ${measurementSettled.reason.message}` : "ctu_nettest: unknown failure");
    }

    const selectedCoverage = selectCoverageFeatures(coverageFeatures, technologies);
    const features =
      selectedCoverage.length > 0
        ? selectedCoverage.map((coverage) => this.mobileNetworkFeatureFromCoverage(coverage, measurementsInPolygon(measurements, coverage), generatedAt))
        : [this.mobileNetworkFallbackFeature(bbox, measurements, generatedAt)];

    if (measurements.length === 0) {
      warnings.push("mobile_network_model has no CTU NetTest measurements in the requested area; assessment is model-only.");
    }
    warnings.push("mobile_network_model does not contain authorized real-time BTS/NOC status; area status is inferred.");

    return {
      generatedAt,
      features,
      warnings,
      coverageFeatureCount: coverageFeatures.length,
      measurementCount: measurements.length
    };
  }

  private mobileNetworkFeatureFromCoverage(coverage: SituationFeature, measurements: SituationFeature[], generatedAt: string): SituationFeature {
    const stats = summarizeMeasurements(measurements);
    const coverageQuality = coverage.properties.quality ?? "unknown";
    const quality = combineQuality(coverageQuality, stats.quality, stats.count);
    const status = statusForMobileQuality(quality, stats);
    const confidence = mobileNetworkConfidence(coverage.properties.confidence, coverageQuality, stats, quality);
    const technology = networkTechnology(coverage.properties.technology);
    const basis = mobileNetworkBasis(coverage, stats);
    const featureId = coverage.id.replace(/^coverage:mobile:/, "mobile_network:aggregate:");
    const summary = mobileNetworkSummary(quality, status, stats);
    const dataQuality = mobileNetworkDataQuality(stats.count, coverageQuality);

    return {
      type: "Feature",
      id: featureId,
      geometry: coverage.geometry,
      properties: {
        featureId,
        layer: "mobile_network",
        category: "mobile_network",
        label: "Mobile network assessment",
        sourceId: "mobile_network_model",
        observedAt: generatedAt,
        confidence,
        stale: false,
        severity: severityForMobileStatus(status, quality, stats),
        license: {
          name: MOBILE_NETWORK_LICENSE.name,
          attribution: MOBILE_NETWORK_LICENSE.attribution
        },
        operator: "aggregate",
        technology,
        quality,
        status,
        basis,
        summary,
        dataQuality,
        btsStatus: "operator_feed_unavailable",
        btsStatusSource: "none",
        operatorStatusAvailable: false,
        notices: ["Aktuální stav konkrétní BTS není veřejně ověřen bez autorizovaného zdroje operátora."],
        estimatedSignalDbm: estimateSignalFromCoverageAndMeasurements(coverage, stats),
        modelVersion: `${this.config.mobileCoverageModelVersion}+mobile-network-v1`,
        generatedAt,
        resolutionM: coverage.properties.resolutionM,
        demSource: coverage.properties.demSource,
        assumptions: {
          ...(coverage.properties.assumptions ?? {}),
          aggregationModel: "coverage+ctu-nettest-confidence-v1",
          btsRealtimeStatus: false,
          operatorStatusAvailable: false
        },
        disclaimer: "Mobile network quality is an inferred area assessment, not a confirmed BTS or operator outage state.",
        metrics: compactMixedMetrics({
          coverageConfidence: coverage.properties.confidence,
          coverageQuality,
          measurementCount: stats.count,
          medianDownloadMbps: stats.medianDownloadMbps,
          medianUploadMbps: stats.medianUploadMbps,
          medianLatencyMs: stats.medianLatencyMs,
          medianSignalDbm: stats.medianSignalDbm,
          measurementConfidence: stats.count > 0 ? stats.averageConfidence : undefined,
          finalConfidence: confidence,
          distanceToNearestTowerM: coverage.properties.metrics?.distanceToNearestTowerM
        }),
        tags: compactTags({
          basis: basis.join(","),
          status,
          dataQuality,
          btsStatus: "operator_feed_unavailable",
          lastMeasuredAt: stats.lastMeasuredAt,
          sourceCoverageFeatureId: coverage.properties.featureId
        }),
        raw: {
          coverage: coverage.properties,
          measurementStats: stats
        }
      }
    };
  }

  private mobileNetworkFallbackFeature(bbox: BoundingBox, measurements: SituationFeature[], generatedAt: string): SituationFeature {
    const stats = summarizeMeasurements(measurements);
    const quality = stats.quality ?? "unknown";
    const status = statusForMobileQuality(quality, stats);
    const confidence = mobileNetworkConfidence(undefined, "unknown", stats, quality);
    const featureId = `mobile_network:aggregate:mixed:${formatBboxKey(bbox)}`;
    const dataQuality = mobileNetworkDataQuality(stats.count, "unknown");
    return {
      type: "Feature",
      id: featureId,
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [round(bbox.west, 6), round(bbox.south, 6)],
            [round(bbox.east, 6), round(bbox.south, 6)],
            [round(bbox.east, 6), round(bbox.north, 6)],
            [round(bbox.west, 6), round(bbox.north, 6)],
            [round(bbox.west, 6), round(bbox.south, 6)]
          ]
        ]
      },
      properties: {
        featureId,
        layer: "mobile_network",
        category: "mobile_network",
        label: "Mobile network assessment",
        sourceId: "mobile_network_model",
        observedAt: generatedAt,
        confidence,
        stale: false,
        severity: severityForMobileStatus(status, quality, stats),
        license: {
          name: MOBILE_NETWORK_LICENSE.name,
          attribution: MOBILE_NETWORK_LICENSE.attribution
        },
        operator: "aggregate",
        technology: "mixed",
        quality,
        status,
        basis: stats.count > 0 ? ["CTU_NETTEST_MEASUREMENT", "NO_OPERATOR_BTS_STATUS"] : ["UNKNOWN", "NO_OPERATOR_BTS_STATUS"],
        summary: mobileNetworkSummary(quality, status, stats),
        dataQuality,
        btsStatus: "operator_feed_unavailable",
        btsStatusSource: "none",
        operatorStatusAvailable: false,
        notices: [
          "Aktuální stav konkrétní BTS není veřejně ověřen bez autorizovaného zdroje operátora.",
          "V oblasti nebyl dostupný model pokrytí, výsledek je založený jen na dostupných měřeních nebo je neznámý."
        ],
        modelVersion: `${this.config.mobileCoverageModelVersion}+mobile-network-v1`,
        generatedAt,
        resolutionM: undefined,
        demSource: this.config.mobileCoverageDemSource,
        assumptions: {
          aggregationModel: "ctu-nettest-fallback-v1",
          btsRealtimeStatus: false,
          operatorStatusAvailable: false
        },
        disclaimer: "Mobile network quality is an inferred area assessment, not a confirmed BTS or operator outage state.",
        metrics: compactMixedMetrics({
          measurementCount: stats.count,
          medianDownloadMbps: stats.medianDownloadMbps,
          medianUploadMbps: stats.medianUploadMbps,
          medianLatencyMs: stats.medianLatencyMs,
          medianSignalDbm: stats.medianSignalDbm,
          measurementConfidence: stats.count > 0 ? stats.averageConfidence : undefined,
          finalConfidence: confidence
        }),
        tags: compactTags({
          status,
          dataQuality,
          btsStatus: "operator_feed_unavailable",
          lastMeasuredAt: stats.lastMeasuredAt
        }),
        raw: {
          measurementStats: stats
        }
      }
    };
  }
}

class PidGtfsRtSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly feedCache: ManagedResponseCache<transit_realtime.FeedMessage>;

  constructor(private readonly config: SituationDataConfig) {
    this.feedCache = new ManagedResponseCache<transit_realtime.FeedMessage>({
      ttlMs: 20_000,
      staleIfErrorMs: Math.max(60_000, config.staleIfErrorSeconds * 1000),
      maxEntries: 1
    });
    this.descriptor = {
      sourceId: "pid_gtfs_rt",
      label: "PID GTFS-RT vehicle positions",
      enabled: config.enabledSources.includes("pid_gtfs_rt"),
      mode: "live",
      priority: 75,
      layers: ["traffic"],
      license: PID_GTFS_RT_LICENSE,
      baseUrl: config.pidGtfsRtVehiclePositionsUrl,
      updateCadenceSeconds: 20
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("pid_gtfs_rt", this.feedCache)];
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("traffic")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const feed = await this.feedCache.getOrLoad("pid_gtfs_rt_vehicle_positions", () => fetchPidVehiclePositionFeed(this.config));
    const features: SituationFeature[] = [];

    for (const entity of feed.entity ?? []) {
      if (features.length >= query.limit) {
        break;
      }
      const feature = mapPidVehiclePosition(entity, query, fetchedAt);
      if (feature) {
        features.push(feature);
      }
    }

    return { source: this.descriptor, fetchedAt, features, warnings: [] };
  }
}

class SafetyDataProjectionSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly payloadCache: ManagedResponseCache<SafetyProjectionCollection>;

  constructor(private readonly config: SituationDataConfig) {
    this.payloadCache = new ManagedResponseCache<SafetyProjectionCollection>({
      ttlMs: Math.max(1, config.safetyDataCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.safetyDataCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(64, config.cacheMaxEntries)
    });
    this.descriptor = {
      sourceId: "safety_data",
      label: "Safety Data API projection",
      enabled: config.enabledSources.includes("safety_data"),
      mode: "live",
      priority: 95,
      layers: ["warnings", "flood"],
      license: SAFETY_DATA_LICENSE,
      baseUrl: config.safetyDataBaseUrl,
      updateCadenceSeconds: config.safetyDataCacheTtlSeconds
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("safety_data", this.payloadCache)];
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    const layers = query.layers.filter((layer): layer is "warnings" | "flood" => layer === "warnings" || layer === "flood");
    if (layers.length === 0) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const cacheBbox = canonicalizeBboxForCache(query.bbox, this.config.bboxCachePaddingDegrees);
    const fetchLimit = Math.min(1000, Math.max(query.limit, query.limit * 2));
    const url = new URL(`${trimTrailingSlash(this.config.safetyDataBaseUrl)}/api/v1/features`);
    url.searchParams.set("bbox", formatBbox(cacheBbox));
    url.searchParams.set("layers", layers.join(","));
    url.searchParams.set("limit", String(fetchLimit));
    if (query.includeRaw) {
      url.searchParams.set("includeRaw", "1");
    }

    const cacheKey = JSON.stringify({
      bbox: formatBboxKey(cacheBbox),
      layers: [...layers].sort(),
      limit: fetchLimit,
      includeRaw: query.includeRaw
    });
    const payload = await this.payloadCache.getOrLoad(cacheKey, () => requestJson<SafetyProjectionCollection>(url.toString(), this.config.requestTimeoutMs));
    const queryCenter = bboxCenter(query.bbox);
    const features = (payload.features ?? [])
      .map((feature) => mapSafetyProjectionFeature(feature, query.includeRaw, queryCenter))
      .filter((feature): feature is SituationFeature => Boolean(feature))
      .filter((feature) => query.layers.includes(feature.properties.layer))
      .filter((feature) => isFeatureInBbox(feature, query.bbox))
      .slice(0, query.limit);

    return {
      source: this.descriptor,
      fetchedAt,
      features,
      warnings: (payload.warnings ?? []).map((warning) => `safety_data: ${warning}`)
    };
  }
}

class AviationWeatherSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly payloadCache: ManagedResponseCache<AviationWeatherBundle>;

  constructor(private readonly config: SituationDataConfig) {
    this.payloadCache = new ManagedResponseCache<AviationWeatherBundle>({
      ttlMs: Math.max(60, config.aviationWeatherCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.aviationWeatherCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(32, Math.min(config.cacheMaxEntries, 1024))
    });
    this.descriptor = {
      sourceId: "aviation_weather",
      label: "NOAA AWC METAR/TAF aviation weather",
      enabled: config.enabledSources.includes("aviation_weather"),
      mode: "live",
      priority: 72,
      layers: ["weather"],
      license: AVIATION_WEATHER_LICENSE,
      baseUrl: config.aviationWeatherBaseUrl,
      updateCadenceSeconds: config.aviationWeatherCacheTtlSeconds
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("aviation_weather", this.payloadCache)];
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("weather")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const cacheBbox = canonicalizeBboxForCache(query.bbox, this.config.bboxCachePaddingDegrees);
    const cacheKey = `aviation_weather:${formatBboxKey(cacheBbox)}`;
    const bundle = await this.payloadCache.getOrLoad(cacheKey, () => fetchAviationWeatherBundle(this.config, cacheBbox));
    const tafByIcao = new Map(bundle.tafs.map((taf) => [normalizeIcaoId(taf.icaoId), taf]));
    const features = bundle.metars
      .map((metar) => mapAviationWeatherFeature(metar, tafByIcao.get(normalizeIcaoId(metar.icaoId)), query.includeRaw))
      .filter((feature): feature is SituationFeature => Boolean(feature))
      .filter((feature) => isFeatureInBbox(feature, query.bbox))
      .slice(0, query.limit);

    return {
      source: this.descriptor,
      fetchedAt,
      features,
      warnings: bundle.warnings
    };
  }
}

class ArdosPartnerSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly payloadCache: ManagedResponseCache<ArdosPartnerCollection>;

  constructor(private readonly config: SituationDataConfig) {
    this.payloadCache = new ManagedResponseCache<ArdosPartnerCollection>({
      ttlMs: Math.max(5, config.ardosPartnerCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(60, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(32, Math.min(config.cacheMaxEntries, 1024))
    });
    this.descriptor = {
      sourceId: "ardos_partner",
      label: "ARDOS partner field operations",
      enabled: config.enabledSources.includes("ardos_partner"),
      mode: "live",
      priority: 90,
      layers: ["ground", "mobile", "traffic"],
      license: ARDOS_PARTNER_LICENSE,
      baseUrl: config.ardosPartnerBaseUrl,
      updateCadenceSeconds: config.ardosPartnerCacheTtlSeconds
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("ardos_partner", this.payloadCache)];
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    const layers = query.layers.filter((layer): layer is "ground" | "mobile" | "traffic" =>
      layer === "ground" || layer === "mobile" || layer === "traffic"
    );
    if (layers.length === 0) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }
    if (!this.config.ardosPartnerBaseUrl) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: ["ardos_partner is enabled but ARDOS_PARTNER_BASE_URL is not configured."] };
    }
    if (!this.config.ardosPartnerToken) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: ["ardos_partner is enabled but ARDOS_PARTNER_TOKEN is not configured."] };
    }

    const cacheBbox = canonicalizeBboxForCache(query.bbox, this.config.bboxCachePaddingDegrees);
    const url = new URL(`${trimTrailingSlash(this.config.ardosPartnerBaseUrl)}/api/v1/features`);
    url.searchParams.set("bbox", formatBbox(cacheBbox));
    url.searchParams.set("layers", layers.join(","));
    url.searchParams.set("limit", String(query.limit));
    if (query.includeRaw) {
      url.searchParams.set("includeRaw", "1");
    }

    const cacheKey = JSON.stringify({
      bbox: formatBboxKey(cacheBbox),
      layers: [...layers].sort(),
      limit: query.limit,
      includeRaw: query.includeRaw
    });
    const payload = await this.payloadCache.getOrLoad(cacheKey, () =>
      requestJsonWithHeaders<ArdosPartnerCollection>(url.toString(), this.config.requestTimeoutMs, {
        accept: "application/json",
        authorization: `Bearer ${this.config.ardosPartnerToken}`,
        "user-agent": "csm-sim-ardos-partner/0.1"
      })
    );
    const features = (payload.features ?? [])
      .map((feature) => mapArdosPartnerFeature(feature, query.includeRaw))
      .filter((feature): feature is SituationFeature => Boolean(feature))
      .filter((feature) => query.layers.includes(feature.properties.layer))
      .filter((feature) => isFeatureInBbox(feature, query.bbox))
      .slice(0, query.limit);

    return {
      source: this.descriptor,
      fetchedAt,
      features,
      warnings: (payload.warnings ?? []).map((warning) => `ardos_partner: ${warning}`)
    };
  }
}

interface FeatureInput {
  id: string;
  lon: number;
  lat: number;
  layer: SituationLayerId;
  category: string;
  label: string;
  sourceId: SituationDataSourceId;
  license: SituationDataLicense;
  observedAt: string;
  validUntil?: string;
  confidence: number;
  severity: SituationSeverity;
  metrics?: Record<string, number | string | boolean>;
  tags?: Record<string, string>;
  raw?: unknown;
}

function makePointFeature(input: FeatureInput): SituationFeature {
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
      label: input.label,
      sourceId: input.sourceId,
      observedAt: input.observedAt,
      validUntil: input.validUntil,
      confidence: round(Math.max(0, Math.min(1, input.confidence)), 2),
      stale: false,
      severity: input.severity,
      license: {
        name: input.license.name,
        attribution: input.license.attribution,
        url: input.license.url
      },
      metrics: input.metrics,
      tags: input.tags,
      raw: input.raw
    }
  };
}

function mockFeatures(observedAt: string): SituationFeature[] {
  return [
    makePointFeature({
      id: "weather:mock:prague-west",
      lon: 14.2632,
      lat: 50.1008,
      layer: "weather",
      category: "weather_observation",
      label: "Synthetic weather reference",
      sourceId: "mock",
      license: MOCK_LICENSE,
      observedAt,
      confidence: 0.92,
      severity: "info",
      metrics: { temperatureC: 18.2, windSpeedMps: 3.8, precipitationMm: 0 }
    }),
    makePointFeature({
      id: "ground:mock:hospital-motol",
      lon: 14.3405,
      lat: 50.0748,
      layer: "ground",
      category: "hospital",
      label: "Ground reference: major hospital",
      sourceId: "mock",
      license: MOCK_LICENSE,
      observedAt,
      confidence: 0.88,
      severity: "info",
      tags: { role: "reference", sourceKind: "pilot_fixture" }
    }),
    makePointFeature({
      id: "ground:mock:fire-station-smichov",
      lon: 14.4087,
      lat: 50.0732,
      layer: "ground",
      category: "fire_station",
      label: "Ground reference: fire station",
      sourceId: "mock",
      license: MOCK_LICENSE,
      observedAt,
      confidence: 0.84,
      severity: "info",
      tags: { role: "reference", sourceKind: "pilot_fixture" }
    }),
    makePointFeature({
      id: "mobile:mock:ctu-nettest-prague-5",
      lon: 14.3894,
      lat: 50.0719,
      layer: "mobile",
      category: "network_measurement",
      label: "Synthetic mobile network quality sample",
      sourceId: "mock",
      license: MOCK_LICENSE,
      observedAt,
      confidence: 0.72,
      severity: "advisory",
      metrics: { downloadMbps: 38, uploadMbps: 12, latencyMs: 31, signalRsrpDbm: -96 },
      tags: { operator: "pilot", accessTechnology: "LTE" }
    }),
    makePointFeature({
      id: "mobile:mock:cell-reference-zlicin",
      lon: 14.2867,
      lat: 50.0552,
      layer: "mobile",
      category: "cell_site_reference",
      label: "Synthetic mobile cell reference",
      sourceId: "mock",
      license: MOCK_LICENSE,
      observedAt,
      confidence: 0.68,
      severity: "info",
      metrics: { bandMhz: 1800 },
      tags: { accessTechnology: "LTE", role: "coverage_reference" }
    }),
    makePointFeature({
      id: "traffic:mock:d5-restriction",
      lon: 14.2578,
      lat: 50.0525,
      layer: "traffic",
      category: "road_restriction",
      label: "Synthetic road restriction",
      sourceId: "mock",
      license: MOCK_LICENSE,
      observedAt,
      confidence: 0.8,
      severity: "warning",
      metrics: { delayMinutes: 12 },
      tags: { road: "D5", direction: "Prague inbound" }
    })
  ];
}

function mapCtuNettestRecord(record: Record<string, string>, query: SituationQuery, fetchedAt: string): SituationFeature | undefined {
  if (!isCtuMobileMeasurement(record)) {
    return undefined;
  }

  const lat = optionalNumber(record.lat);
  const lon = optionalNumber(record.long);
  if (lat === undefined || lon === undefined || !isPointInBbox(lon, lat, query.bbox)) {
    return undefined;
  }

  const observedAt = parseUtcTimestamp(record.time_utc) ?? fetchedAt;
  const locationAccuracyM = optionalNumber(record.loc_accuracy);
  const downloadMbps = kbpsToMbps(optionalNumber(record.download_kbit));
  const uploadMbps = kbpsToMbps(optionalNumber(record.upload_kbit));
  const latencyMs = optionalNumber(record.ping_ms);
  const lteRsrpDbm = optionalNumber(record.lte_rsrp);
  const lteRsrqDb = optionalNumber(record.lte_rsrq);
  const signalStrengthDbm = optionalNumber(record.signal_strength);
  const implausible = record.implausible === "true";
  const accessTechnology = ctuAccessTechnology(record);
  const measurementId = stableToken(record.open_test_uuid || record.open_uuid || `${observedAt}:${lat}:${lon}`);

  return makePointFeature({
    id: `mobile:ctu_nettest:${measurementId}`,
    lon,
    lat,
    layer: "mobile",
    category: "network_measurement",
    label: `CTU NetTest ${accessTechnology}`,
    sourceId: "ctu_nettest",
    license: CTU_NETTEST_LICENSE,
    observedAt,
    validUntil: addSeconds(observedAt, 72 * 60 * 60),
    confidence: ctuNettestConfidence(locationAccuracyM, implausible, downloadMbps),
    severity: mobileNetworkSeverity(downloadMbps, uploadMbps, latencyMs, lteRsrpDbm ?? signalStrengthDbm, implausible),
    metrics: compactMetrics({
      downloadMbps,
      uploadMbps,
      latencyMs,
      lteRsrpDbm,
      lteRsrqDb,
      signalStrengthDbm,
      locationAccuracyM,
      serverDurationSeconds: optionalNumber(record.test_duration)
    }),
    tags: compactTags({
      accessTechnology,
      catTechnology: optionalString(record.cat_technology),
      networkType: optionalString(record.network_type),
      networkName: optionalString(record.network_name),
      platform: optionalString(record.platform),
      client: optionalString(record.model || record.client_version),
      serverName: optionalString(record.server_name),
      locationSource: optionalString(record.loc_src),
      implausible: implausible ? "true" : undefined
    }),
    raw: query.includeRaw ? record : undefined
  });
}

function selectCoverageFeatures(features: SituationFeature[], technologies: MobileCoverageTechnology[] | undefined): SituationFeature[] {
  if (technologies?.length === 1) {
    return features.filter((feature) => feature.properties.technology === technologies[0]);
  }

  const grouped = new Map<string, SituationFeature[]>();
  for (const feature of features) {
    const key = coverageCellKey(feature);
    grouped.set(key, [...(grouped.get(key) ?? []), feature]);
  }

  return Array.from(grouped.values()).flatMap((group) => {
    const selected = group.sort(
      (a, b) => qualityRank(b.properties.quality) - qualityRank(a.properties.quality) || (b.properties.confidence ?? 0) - (a.properties.confidence ?? 0)
    )[0];
    return selected ? [selected] : [];
  });
}

function coverageCellKey(feature: SituationFeature): string {
  const id = String(feature.id);
  const suffix = id.split(":").pop();
  if (suffix) {
    return suffix;
  }
  return JSON.stringify(feature.geometry);
}

function measurementsInPolygon(measurements: SituationFeature[], polygon: SituationFeature): SituationFeature[] {
  const bbox = featureEnvelope(polygon);
  if (!bbox) {
    return [];
  }
  return measurements.filter((measurement) => {
    if (measurement.geometry.type !== "Point") {
      return false;
    }
    const [lon, lat] = measurement.geometry.coordinates;
    return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
  });
}

function summarizeMeasurements(measurements: SituationFeature[]): MeasurementStats {
  const download = measurements.map((feature) => numericMetric(feature, "downloadMbps")).filter(isFiniteNumber);
  const upload = measurements.map((feature) => numericMetric(feature, "uploadMbps")).filter(isFiniteNumber);
  const latency = measurements.map((feature) => numericMetric(feature, "latencyMs")).filter(isFiniteNumber);
  const signal = measurements
    .map((feature) => numericMetric(feature, "lteRsrpDbm") ?? numericMetric(feature, "signalStrengthDbm"))
    .filter(isFiniteNumber);
  const averageConfidence =
    measurements.length > 0 ? round(measurements.reduce((sum, feature) => sum + feature.properties.confidence, 0) / measurements.length, 2) : 0;
  const lastMeasuredAt = measurements
    .map((feature) => feature.properties.observedAt)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const medianDownloadMbps = median(download);
  const medianUploadMbps = median(upload);
  const medianLatencyMs = median(latency);
  const medianSignalDbm = median(signal);
  const severity = mobileNetworkSeverity(medianDownloadMbps, medianUploadMbps, medianLatencyMs, medianSignalDbm, false);
  return {
    count: measurements.length,
    medianDownloadMbps,
    medianUploadMbps,
    medianLatencyMs,
    medianSignalDbm,
    averageConfidence,
    lastMeasuredAt,
    quality: measurements.length > 0 ? measurementQuality(medianDownloadMbps, medianUploadMbps, medianLatencyMs, medianSignalDbm) : undefined,
    severity
  };
}

function measurementQuality(
  downloadMbps: number | undefined,
  uploadMbps: number | undefined,
  latencyMs: number | undefined,
  signalDbm: number | undefined
): MobileCoverageQuality {
  if ((downloadMbps ?? Infinity) < 1 || (uploadMbps ?? Infinity) < 0.5 || (latencyMs ?? 0) > 250 || (signalDbm ?? 0) < -118) {
    return "none";
  }
  if ((downloadMbps ?? Infinity) < 5 || (uploadMbps ?? Infinity) < 1.5 || (latencyMs ?? 0) > 150 || (signalDbm ?? 0) < -110) {
    return "weak";
  }
  if ((downloadMbps ?? Infinity) < 15 || (uploadMbps ?? Infinity) < 5 || (latencyMs ?? 0) > 75 || (signalDbm ?? 0) < -100) {
    return "fair";
  }
  return "good";
}

function combineQuality(
  coverageQuality: MobileCoverageQuality,
  measurementQualityValue: MobileCoverageQuality | undefined,
  measurementCount: number
): MobileCoverageQuality {
  if (!measurementQualityValue) {
    return coverageQuality;
  }
  if (coverageQuality === "unknown") {
    return measurementQualityValue;
  }
  if (measurementCount >= 2 && qualityRank(measurementQualityValue) < qualityRank(coverageQuality)) {
    return measurementQualityValue;
  }
  if (measurementCount >= 5 && qualityRank(measurementQualityValue) > qualityRank(coverageQuality)) {
    return measurementQualityValue;
  }
  return coverageQuality;
}

function mobileNetworkConfidence(
  coverageConfidence: number | undefined,
  coverageQuality: MobileCoverageQuality,
  stats: MeasurementStats,
  finalQuality: MobileCoverageQuality
): number {
  const baseCoverageConfidence = typeof coverageConfidence === "number" ? coverageConfidence : 0.25;
  if (stats.count <= 0) {
    const capped = finalQuality === "unknown" ? Math.min(baseCoverageConfidence, 0.42) : Math.min(baseCoverageConfidence * 0.9, 0.68);
    return round(clamp(capped, 0.2, 0.7), 2);
  }

  const measurementDensity = clamp(Math.log2(stats.count + 1) / 4, 0.18, 0.8);
  const agreement = stats.quality && coverageQuality !== "unknown" && stats.quality === coverageQuality ? 0.08 : 0;
  const confidence = baseCoverageConfidence * 0.42 + stats.averageConfidence * 0.38 + measurementDensity * 0.12 + agreement;
  return round(clamp(finalQuality === "unknown" ? Math.min(confidence, 0.45) : confidence, 0.25, 0.9), 2);
}

function mobileNetworkBasis(coverage: SituationFeature, stats: MeasurementStats): string[] {
  const basis = ["INFERRED_COVERAGE", "DISTANCE_PATH_LOSS_MODEL", "NO_OPERATOR_BTS_STATUS"];
  if (coverage.properties.metrics?.distanceToNearestTowerM !== undefined) {
    basis.splice(1, 0, "OSM_INFRASTRUCTURE_HINT");
  }
  if (stats.count > 0) {
    basis.splice(0, 0, "CTU_NETTEST_MEASUREMENT");
  }
  return basis;
}

function mobileNetworkDataQuality(measurementCount: number, coverageQuality: MobileCoverageQuality): "observed" | "modelled" | "mixed" | "unknown" {
  if (measurementCount > 0 && coverageQuality !== "unknown") {
    return "mixed";
  }
  if (measurementCount > 0) {
    return "observed";
  }
  if (coverageQuality !== "unknown") {
    return "modelled";
  }
  return "unknown";
}

function statusForMobileQuality(quality: MobileCoverageQuality, stats: MeasurementStats): MobileNetworkStatus {
  if (quality === "good" || quality === "fair") {
    return stats.count >= 2 && stats.severity === "warning" ? "degraded_possible" : "ok";
  }
  if (quality === "weak") {
    return "weak_signal";
  }
  if (quality === "none") {
    return "degraded_possible";
  }
  return "unknown";
}

function severityForMobileStatus(status: MobileNetworkStatus, quality: MobileCoverageQuality, stats: MeasurementStats): SituationSeverity {
  if (status === "outage_reported" || (quality === "none" && stats.count >= 2)) {
    return "critical";
  }
  if (status === "degraded_possible" || status === "weak_signal" || quality === "weak") {
    return "warning";
  }
  if (status === "unknown") {
    return "advisory";
  }
  return "info";
}

function networkTechnology(value: MobileNetworkTechnology | undefined): MobileNetworkTechnology {
  return value === "2G" || value === "4G" || value === "5G" ? value : "mixed";
}

function estimateSignalFromCoverageAndMeasurements(coverage: SituationFeature, stats: MeasurementStats): number | undefined {
  if (stats.count >= 2 && typeof stats.medianSignalDbm === "number") {
    return Math.round(stats.medianSignalDbm);
  }
  return typeof coverage.properties.estimatedSignalDbm === "number" ? coverage.properties.estimatedSignalDbm : undefined;
}

function mobileNetworkSummary(quality: MobileCoverageQuality, status: MobileNetworkStatus, stats: MeasurementStats): string {
  const qualityText: Record<MobileCoverageQuality, string> = {
    good: "dobrá",
    fair: "použitelná s omezením",
    weak: "slabá",
    none: "pravděpodobně nedostupná",
    unknown: "neověřená"
  };
  const statusText: Record<MobileNetworkStatus, string> = {
    ok: "bez zjevného problému",
    weak_signal: "riziko slabého signálu",
    degraded_possible: "možná degradace služby",
    outage_reported: "hlášený výpadek",
    unknown: "stav nelze z veřejných dat ověřit"
  };
  const measurementText =
    stats.count > 0
      ? ` Závěr je zpřesněn ${stats.count} veřejnými měřeními ČTÚ NetTest${stats.medianDownloadMbps ? `, medián downloadu ${stats.medianDownloadMbps} Mb/s` : ""}.`
      : " V oblasti nejsou v cache dostupná aktuální veřejná měření ČTÚ NetTest.";
  return `Mobilní síť je v oblasti hodnocena jako ${qualityText[quality]} (${statusText[status]}).${measurementText}`;
}

function featureIntersectsBboxByEnvelope(feature: SituationFeature, bbox: BoundingBox): boolean {
  const envelope = featureEnvelope(feature);
  if (!envelope) {
    return false;
  }
  return envelope.west <= bbox.east && envelope.east >= bbox.west && envelope.south <= bbox.north && envelope.north >= bbox.south;
}

function featureEnvelope(feature: SituationFeature): BoundingBox | undefined {
  const coordinates =
    feature.geometry.type === "Point"
      ? [feature.geometry.coordinates]
      : feature.geometry.type === "LineString"
        ? feature.geometry.coordinates
        : feature.geometry.coordinates.flat();
  if (coordinates.length === 0) {
    return undefined;
  }
  return coordinates.reduce(
    (acc, [lon, lat]) => ({
      west: Math.min(acc.west, lon),
      south: Math.min(acc.south, lat),
      east: Math.max(acc.east, lon),
      north: Math.max(acc.north, lat)
    }),
    { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity }
  );
}

function numericMetric(feature: SituationFeature, metric: string): number | undefined {
  const value = feature.properties.metrics?.[metric];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0 ? (sorted[middle - 1] ?? 0) / 2 + (sorted[middle] ?? 0) / 2 : (sorted[middle] ?? 0);
  return round(value, 2);
}

function qualityRank(value: MobileCoverageQuality | undefined): number {
  switch (value) {
    case "good":
      return 4;
    case "fair":
      return 3;
    case "weak":
      return 2;
    case "none":
      return 1;
    default:
      return 0;
  }
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function publicPostgisBaseUrl(connectionString: string | undefined): string | undefined {
  if (!connectionString) {
    return undefined;
  }
  try {
    const url = new URL(connectionString);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "postgresql://configured";
  }
}

function mapPidVehiclePosition(entity: transit_realtime.IFeedEntity, query: SituationQuery, fetchedAt: string): SituationFeature | undefined {
  const vehicle = entity.vehicle;
  const position = vehicle?.position;
  const lat = optionalNumber(position?.latitude);
  const lon = optionalNumber(position?.longitude);
  if (lat === undefined || lon === undefined || !isPointInBbox(lon, lat, query.bbox)) {
    return undefined;
  }

  const vehicleId = optionalString(vehicle?.vehicle?.id) ?? entity.id;
  const mode = pidVehicleMode(vehicleId, vehicle?.trip?.routeId);
  const routeLabel = pidRouteLabel(vehicle?.trip?.routeId, vehicleId);
  const timestampSeconds = longToNumber(vehicle?.timestamp);
  const observedAt = timestampSeconds && timestampSeconds > 0 ? new Date(timestampSeconds * 1000).toISOString() : fetchedAt;

  return makePointFeature({
    id: `traffic:pid_gtfs_rt:${stableToken(vehicleId || entity.id)}`,
    lon,
    lat,
    layer: "traffic",
    category: mode.category,
    label: routeLabel ? `PID ${mode.label} ${routeLabel}` : `PID ${mode.label}`,
    sourceId: "pid_gtfs_rt",
    license: PID_GTFS_RT_LICENSE,
    observedAt,
    validUntil: addSeconds(observedAt, 120),
    confidence: pidPositionConfidence(observedAt),
    severity: pidTrafficSeverity(vehicle?.congestionLevel),
    metrics: compactMetrics({
      speedMps: optionalNumber(position?.speed),
      headingDeg: optionalNumber(position?.bearing),
      odometerM: optionalNumber(position?.odometer),
      currentStopSequence: optionalNumber(vehicle?.currentStopSequence),
      occupancyPercent: optionalNumber(vehicle?.occupancyPercentage),
      routeTypeCode: mode.routeTypeCode
    }),
    tags: compactTags({
      vehicleId: optionalString(vehicleId),
      vehicleLabel: optionalString(vehicle?.vehicle?.label),
      tripId: optionalString(vehicle?.trip?.tripId),
      routeId: optionalString(vehicle?.trip?.routeId),
      route: optionalString(routeLabel),
      startDate: optionalString(vehicle?.trip?.startDate),
      startTime: optionalString(vehicle?.trip?.startTime),
      stopId: optionalString(vehicle?.stopId),
      currentStatus: pidVehicleStopStatus(vehicle?.currentStatus),
      congestionLevel: pidCongestionLevel(vehicle?.congestionLevel),
      occupancyStatus: pidOccupancyStatus(vehicle?.occupancyStatus),
      transportMode: mode.tag
    }),
    raw: query.includeRaw ? entity : undefined
  });
}

interface OpenMeteoResponse {
  current?: Record<string, unknown>;
  current_units?: Record<string, string>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
}

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: {
    lat?: number;
    lon?: number;
  };
  tags?: Record<string, string>;
}

interface SafetyProjectionCollection {
  features?: SafetyProjectionFeature[];
  warnings?: string[];
}

interface SafetyProjectionFeature {
  type: "Feature";
  id: string;
  geometry: {
    type: "Point" | "Polygon";
    coordinates: unknown;
  };
  properties: {
    featureId: string;
    layer: "warnings" | "flood";
    category: string;
    headline: string;
    description?: string;
    recommendedAction?: string;
    sourceId: string;
    observedAt: string;
    effectiveAt?: string;
    expiresAt?: string;
    confidence: number;
    stale: boolean;
    severity: SituationSeverity;
    urgency?: string;
    certainty?: string;
    license: {
      name: string;
      attribution: string;
      url?: string;
    };
    affectedAreas?: string[];
    geocodes?: Array<{ scheme: string; value: string }>;
    metrics?: Record<string, number | string | boolean>;
    tags?: Record<string, string>;
    raw?: unknown;
  };
}

interface AviationWeatherBundle {
  metars: AviationMetar[];
  tafs: AviationTaf[];
  warnings: string[];
}

interface AviationMetar {
  icaoId?: string;
  receiptTime?: string;
  obsTime?: number;
  reportTime?: string;
  temp?: number;
  dewp?: number;
  wdir?: number | string;
  wspd?: number;
  wgst?: number;
  visib?: number | string;
  altim?: number;
  metarType?: string;
  rawOb?: string;
  lat?: number;
  lon?: number;
  elev?: number;
  name?: string;
  cover?: string;
  ceil?: number;
  fltCat?: string;
}

interface AviationTaf {
  icaoId?: string;
  dbPopTime?: string;
  bulletinTime?: string;
  issueTime?: string;
  validTimeFrom?: number;
  validTimeTo?: number;
  rawTAF?: string;
  mostRecent?: number;
  lat?: number;
  lon?: number;
  elev?: number;
  name?: string;
  fcsts?: Array<{
    timeFrom?: number;
    timeTo?: number;
    fcstChange?: string | null;
    probability?: number | null;
    wdir?: number | null;
    wspd?: number | null;
    wgst?: number | null;
    visib?: number | string | null;
    wxString?: string | null;
    clouds?: Array<{ cover?: string | null; base?: number | null; type?: string | null }>;
  }>;
}

interface ArdosPartnerCollection {
  features?: ArdosPartnerFeature[];
  warnings?: string[];
}

interface ArdosPartnerFeature {
  type: "Feature";
  id?: string;
  geometry?: {
    type?: "Point" | "LineString" | "Polygon";
    coordinates?: unknown;
  };
  properties?: {
    featureId?: string;
    layer?: SituationLayerId;
    category?: string;
    label?: string;
    sourceId?: string;
    observedAt?: string;
    validUntil?: string;
    confidence?: number;
    stale?: boolean;
    severity?: SituationSeverity;
    license?: {
      name?: string;
      attribution?: string;
      url?: string;
    };
    metrics?: Record<string, number | string | boolean>;
    tags?: Record<string, string>;
    raw?: unknown;
  };
}

function mapSafetyProjectionFeature(
  feature: SafetyProjectionFeature,
  includeRaw: boolean,
  warningPoint?: { lon: number; lat: number }
): SituationFeature | undefined {
  const geometry = mapSafetyProjectionGeometry(feature.geometry, feature.properties.layer === "warnings" ? warningPoint : undefined);
  if (!geometry) {
    return undefined;
  }
  const layer = feature.properties.layer;
  const id = `safety_data:${feature.id}`;
  const tags = compactTags({
    ...(feature.properties.tags ?? {}),
    safetySourceId: optionalString(feature.properties.sourceId),
    urgency: optionalString(feature.properties.urgency),
    certainty: optionalString(feature.properties.certainty),
    affectedAreas: feature.properties.affectedAreas?.slice(0, 4).join("; "),
    geocodes: feature.properties.geocodes?.slice(0, 6).map((geocode) => `${geocode.scheme}:${geocode.value}`).join("; ")
  });
  return {
    type: "Feature",
    id,
    geometry,
    properties: {
      featureId: id,
      layer,
      category: feature.properties.category,
      label: feature.properties.headline,
      sourceId: "safety_data",
      observedAt: feature.properties.observedAt,
      validUntil: feature.properties.expiresAt,
      confidence: feature.properties.confidence,
      stale: feature.properties.stale,
      severity: feature.properties.severity,
      license: feature.properties.license,
      metrics: compactMixedMetrics(feature.properties.metrics ?? {}),
      tags,
      raw: includeRaw
        ? {
            ...feature,
            properties: {
              ...feature.properties,
              raw: feature.properties.raw
            }
          }
        : undefined
    }
  };
}

function mapSafetyProjectionGeometry(
  geometry: SafetyProjectionFeature["geometry"],
  pointOverride?: { lon: number; lat: number }
): SituationFeature["geometry"] | undefined {
  if (pointOverride) {
    return { type: "Point", coordinates: [round(pointOverride.lon, 6), round(pointOverride.lat, 6)] };
  }
  if (geometry.type === "Point" && Array.isArray(geometry.coordinates)) {
    const [lon, lat] = geometry.coordinates;
    if (typeof lon === "number" && typeof lat === "number") {
      return { type: "Point", coordinates: [lon, lat] };
    }
  }
  if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates)) {
    return geometry as SituationFeature["geometry"];
  }
  return undefined;
}

async function fetchAviationWeatherBundle(config: SituationDataConfig, bbox: BoundingBox): Promise<AviationWeatherBundle> {
  const metarUrl = new URL(`${trimTrailingSlash(config.aviationWeatherBaseUrl)}/api/data/metar`);
  metarUrl.searchParams.set("bbox", formatAviationWeatherBbox(bbox));
  metarUrl.searchParams.set("format", "json");

  const warnings: string[] = [];
  const metars = await requestJsonArray<AviationMetar>(metarUrl.toString(), config.requestTimeoutMs, {
    accept: "application/json",
    "user-agent": "csm-sim-aviation-weather/0.1"
  });
  const ids = Array.from(new Set(metars.map((metar) => normalizeIcaoId(metar.icaoId)).filter((id) => id.length > 0))).slice(0, 100);
  let tafs: AviationTaf[] = [];
  if (ids.length > 0) {
    const tafUrl = new URL(`${trimTrailingSlash(config.aviationWeatherBaseUrl)}/api/data/taf`);
    tafUrl.searchParams.set("ids", ids.join(","));
    tafUrl.searchParams.set("format", "json");
    try {
      tafs = await requestJsonArray<AviationTaf>(tafUrl.toString(), config.requestTimeoutMs, {
        accept: "application/json",
        "user-agent": "csm-sim-aviation-weather/0.1"
      });
    } catch (error) {
      warnings.push(error instanceof Error ? `aviation_weather TAF fetch failed: ${error.message}` : "aviation_weather TAF fetch failed.");
    }
  }
  return { metars, tafs, warnings };
}

function mapAviationWeatherFeature(metar: AviationMetar, taf: AviationTaf | undefined, includeRaw: boolean): SituationFeature | undefined {
  const lat = optionalNumber(metar.lat);
  const lon = optionalNumber(metar.lon);
  const icaoId = normalizeIcaoId(metar.icaoId);
  if (!icaoId || lat === undefined || lon === undefined) {
    return undefined;
  }
  const observedAt = parseAviationTime(metar.reportTime) ?? epochSecondsToIso(metar.obsTime) ?? parseAviationTime(metar.receiptTime) ?? new Date().toISOString();
  const validUntil = taf?.validTimeTo ? epochSecondsToIso(taf.validTimeTo) : addSeconds(observedAt, 90 * 60);
  const flightCategory = optionalString(metar.fltCat)?.toUpperCase();
  const severity = aviationWeatherSeverity(flightCategory, taf);

  return makePointFeature({
    id: `weather:aviation_weather:${icaoId}`,
    lon,
    lat,
    layer: "weather",
    category: "aviation_weather_station",
    label: `${icaoId} ${flightCategory ?? "METAR"}`,
    sourceId: "aviation_weather",
    license: AVIATION_WEATHER_LICENSE,
    observedAt,
    validUntil,
    confidence: flightCategory ? 0.88 : 0.8,
    severity,
    metrics: compactMetrics({
      temperatureC: optionalNumber(metar.temp),
      dewpointC: optionalNumber(metar.dewp),
      windDirectionDeg: optionalNumber(metar.wdir),
      windSpeedKt: optionalNumber(metar.wspd),
      windSpeedMps: knotsToMps(optionalNumber(metar.wspd)),
      windGustKt: optionalNumber(metar.wgst),
      windGustMps: knotsToMps(optionalNumber(metar.wgst)),
      visibilitySm: optionalNumber(metar.visib),
      altimeterHpa: optionalNumber(metar.altim),
      ceilingFt: optionalNumber(metar.ceil),
      elevationM: optionalNumber(metar.elev)
    }),
    tags: compactTags({
      icaoId,
      stationName: optionalString(metar.name),
      metarType: optionalString(metar.metarType),
      flightCategory,
      cloudCover: optionalString(metar.cover),
      tafAvailable: taf ? "true" : undefined
    }),
    raw: includeRaw ? { metar, taf } : undefined
  });
}

function mapArdosPartnerFeature(feature: ArdosPartnerFeature, includeRaw: boolean): SituationFeature | undefined {
  const geometry = mapPartnerGeometry(feature.geometry);
  const properties = feature.properties;
  if (!geometry || !properties) {
    return undefined;
  }
  const layer = properties.layer;
  if (layer !== "ground" && layer !== "mobile" && layer !== "traffic") {
    return undefined;
  }
  const observedAt = parseAviationTime(properties.observedAt) ?? new Date().toISOString();
  const sourceFeatureId = optionalString(properties.featureId) ?? optionalString(feature.id) ?? stableToken(`${layer}:${properties.category ?? "feature"}:${observedAt}`);
  const id = `ardos_partner:${sourceFeatureId}`;

  return {
    type: "Feature",
    id,
    geometry,
    properties: {
      featureId: id,
      layer,
      category: optionalString(properties.category) ?? "partner_feature",
      label: optionalString(properties.label) ?? "ARDOS partner feature",
      sourceId: "ardos_partner",
      observedAt,
      validUntil: parseAviationTime(properties.validUntil),
      confidence: clamp(optionalNumber(properties.confidence) ?? 0.72, 0.1, 0.95),
      stale: Boolean(properties.stale),
      severity: parseSeverity(properties.severity),
      license: {
        name: properties.license?.name || ARDOS_PARTNER_LICENSE.name,
        attribution: properties.license?.attribution || ARDOS_PARTNER_LICENSE.attribution,
        url: properties.license?.url || ARDOS_PARTNER_LICENSE.url
      },
      metrics: compactMixedMetrics(properties.metrics ?? {}),
      tags: compactTags({
        ...(properties.tags ?? {}),
        partnerSourceId: optionalString(properties.sourceId),
        partnerFeatureId: sourceFeatureId
      }),
      raw: includeRaw ? feature : undefined
    }
  };
}

function mapPartnerGeometry(geometry: ArdosPartnerFeature["geometry"]): SituationFeature["geometry"] | undefined {
  if (!geometry?.type || !geometry.coordinates) {
    return undefined;
  }
  if (geometry.type === "Point" && Array.isArray(geometry.coordinates)) {
    const [lon, lat] = geometry.coordinates;
    if (typeof lon === "number" && typeof lat === "number") {
      return { type: "Point", coordinates: [round(lon, 6), round(lat, 6)] };
    }
  }
  if (geometry.type === "LineString" && Array.isArray(geometry.coordinates)) {
    const coordinates = geometry.coordinates.filter(isLonLatPair).map(([lon, lat]) => [round(lon, 6), round(lat, 6)] as [number, number]);
    return coordinates.length > 0 ? { type: "LineString", coordinates } : undefined;
  }
  if (geometry.type === "Polygon" && Array.isArray(geometry.coordinates)) {
    const rings = geometry.coordinates
      .filter(Array.isArray)
      .map((ring) => ring.filter(isLonLatPair).map(([lon, lat]) => [round(lon, 6), round(lat, 6)] as [number, number]))
      .filter((ring) => ring.length >= 4);
    return rings.length > 0 ? { type: "Polygon", coordinates: rings } : undefined;
  }
  return undefined;
}

async function requestJson<T>(url: string, timeoutMs: number): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return (await response.json()) as T;
}

async function requestJsonWithHeaders<T>(url: string, timeoutMs: number, headers: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return (await response.json()) as T;
}

async function requestJsonArray<T>(url: string, timeoutMs: number, headers: Record<string, string>): Promise<T[]> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (response.status === 204) {
    return [];
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  const payload = (await response.json()) as unknown;
  return Array.isArray(payload) ? (payload as T[]) : [];
}

async function requestBytes(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchCtuNettestRecords(config: SituationDataConfig): Promise<Array<Record<string, string>>> {
  const archive = await requestBytes(config.ctuNettestUrl, config.requestTimeoutMs);
  const files = unzipSync(archive);
  const csvName = Object.keys(files).find((name) => name.toLowerCase().endsWith(".csv"));
  if (!csvName) {
    throw new Error("ctu_nettest archive did not contain a CSV file.");
  }
  const csvFile = files[csvName];
  if (!csvFile) {
    throw new Error("ctu_nettest CSV file was empty.");
  }
  return parseCsvRecords(new TextDecoder().decode(csvFile));
}

async function fetchPidVehiclePositionFeed(config: SituationDataConfig): Promise<transit_realtime.FeedMessage> {
  const payload = await requestBytes(config.pidGtfsRtVehiclePositionsUrl, config.requestTimeoutMs, {
    accept: "application/x-protobuf,application/octet-stream"
  });
  return gtfsRealtime.transit_realtime.FeedMessage.decode(payload);
}

async function requestOverpass(baseUrl: string, query: string, timeoutMs: number): Promise<OverpassResponse> {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "csm-sim-situation-data/0.1"
    },
    body: new URLSearchParams({ data: query }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(baseUrl).hostname}`);
  }
  return (await response.json()) as OverpassResponse;
}

function parseCsvRecords(text: string): Array<Record<string, string>> {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = detectDelimiter(firstLine);
  const rows = parseDelimitedRows(text, delimiter).filter((row) => row.some((cell) => cell.trim().length > 0));
  const headers = rows[0]?.map((header) => header.replace(/^\uFEFF/, "").trim());
  if (!headers || headers.length === 0) {
    return [];
  }

  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = row[index]?.trim() ?? "";
    });
    return record;
  });
}

function parseDelimitedRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === delimiter && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function detectDelimiter(headerLine: string): string {
  const candidates = [",", ";", "\t"];
  return candidates
    .map((delimiter) => ({ delimiter, count: headerLine.split(delimiter).length }))
    .sort((a, b) => b.count - a.count)[0]?.delimiter ?? ",";
}

function overpassQuery(bbox: BoundingBox): string {
  const box = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `
[out:json][timeout:8];
(
  node["amenity"~"^(hospital|police|fire_station)$"](${box});
  way["amenity"~"^(hospital|police|fire_station)$"](${box});
  relation["amenity"~"^(hospital|police|fire_station)$"](${box});
  node["emergency"~"^(ambulance_station|fire_hydrant)$"](${box});
  node["man_made"~"^(communications_tower|tower)$"](${box});
  node["tower:type"="communication"](${box});
);
out center 120;
`;
}

function mapOverpassElement(element: OverpassElement, observedAt: string, includeRaw: boolean): SituationFeature | undefined {
  const lon = optionalNumber(element.lon ?? element.center?.lon);
  const lat = optionalNumber(element.lat ?? element.center?.lat);
  if (lon === undefined || lat === undefined) {
    return undefined;
  }
  const tags = element.tags ?? {};
  const category = osmCategory(tags);
  const layer: SituationLayerId = category === "communications_tower" ? "mobile" : "ground";
  const label = tags.name || labelForCategory(category);
  const id = `${layer}:osm:${element.type}:${element.id}`;

  return makePointFeature({
    id,
    lon,
    lat,
    layer,
    category,
    label,
    sourceId: "osm_overpass",
    license: OSM_LICENSE,
    observedAt,
    confidence: element.type === "node" ? 0.82 : 0.74,
    severity: "info",
    tags: compactTags({
      osmType: element.type,
      amenity: tags.amenity,
      emergency: tags.emergency,
      man_made: tags.man_made,
      towerType: tags["tower:type"]
    }),
    raw: includeRaw ? element : undefined
  });
}

function osmCategory(tags: Record<string, string>): string {
  if (tags.amenity === "hospital") {
    return "hospital";
  }
  if (tags.amenity === "police") {
    return "police";
  }
  if (tags.amenity === "fire_station") {
    return "fire_station";
  }
  if (tags.emergency) {
    return tags.emergency;
  }
  if (tags.man_made === "communications_tower" || tags["tower:type"] === "communication") {
    return "communications_tower";
  }
  return "ground_reference";
}

function labelForCategory(category: string): string {
  const labels: Record<string, string> = {
    hospital: "Hospital",
    police: "Police station",
    fire_station: "Fire station",
    ambulance_station: "Ambulance station",
    fire_hydrant: "Fire hydrant",
    communications_tower: "Communication tower"
  };
  return labels[category] ?? "Ground reference";
}

function stripRawIfNeeded(feature: SituationFeature, includeRaw: boolean): SituationFeature {
  if (includeRaw || !feature.properties.raw) {
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

function bboxCenter(bbox: BoundingBox): { lat: number; lon: number } {
  return {
    lat: (bbox.south + bbox.north) / 2,
    lon: (bbox.west + bbox.east) / 2
  };
}

function isFeatureInBbox(feature: SituationFeature, bbox: BoundingBox): boolean {
  const point = pointGeometry(feature.geometry);
  if (!point) {
    return true;
  }
  const [lon, lat] = point.coordinates;
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

function pointGeometry(geometry: SituationFeature["geometry"]): PointGeometry | undefined {
  return geometry.type === "Point" ? geometry : undefined;
}

function weatherSeverity(windSpeedMps: number | undefined, precipitationMm: number | undefined, weatherCode: number | undefined): SituationSeverity {
  if ((windSpeedMps ?? 0) >= 25 || (precipitationMm ?? 0) >= 20 || severeWeatherCodes.has(weatherCode ?? -1)) {
    return "critical";
  }
  if ((windSpeedMps ?? 0) >= 15 || (precipitationMm ?? 0) >= 5 || warningWeatherCodes.has(weatherCode ?? -1)) {
    return "warning";
  }
  if ((windSpeedMps ?? 0) >= 10 || (precipitationMm ?? 0) > 0) {
    return "advisory";
  }
  return "info";
}

const warningWeatherCodes = new Set([51, 53, 55, 61, 63, 65, 71, 73, 75, 80, 81, 82]);
const severeWeatherCodes = new Set([95, 96, 99]);

function normalizeOpenMeteoTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const withZone = value.endsWith("Z") ? value : `${value}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseUtcTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  const withZone = trimmed.includes("T") ? trimmed : `${trimmed.replace(" ", "T")}Z`;
  const date = new Date(withZone.endsWith("Z") ? withZone : `${withZone}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function addSeconds(isoTimestamp: string, seconds: number): string {
  const base = Date.parse(isoTimestamp);
  const date = Number.isNaN(base) ? new Date() : new Date(base + seconds * 1000);
  return date.toISOString();
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function kbpsToMbps(value: number | undefined): number | undefined {
  return value === undefined ? undefined : round(value / 1000, 2);
}

function isPointInBbox(lon: number, lat: number, bbox: BoundingBox): boolean {
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

function isCtuMobileMeasurement(record: Record<string, string>): boolean {
  const cat = (record.cat_technology ?? "").toUpperCase();
  const networkType = (record.network_type ?? "").toUpperCase();
  const combined = `${cat} ${networkType}`;
  if (["LAN", "WLAN", "ETHERNET", "BLUETOOTH"].some((blocked) => cat === blocked || networkType === blocked)) {
    return false;
  }
  return /\b(MOBILE|CELLULAR|2G|3G|4G|5G|LTE|NR|EDGE|GPRS|UMTS|HSPA)\b/.test(combined);
}

function latestCtuMeasurementAt(records: Array<Record<string, string>>): string | undefined {
  return records
    .map((record) => parseUtcTimestamp(record.time_utc))
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

function ctuAccessTechnology(record: Record<string, string>): string {
  return optionalString(record.cat_technology) ?? optionalString(record.network_type) ?? "mobile";
}

function mobileNetworkSeverity(
  downloadMbps: number | undefined,
  uploadMbps: number | undefined,
  latencyMs: number | undefined,
  signalDbm: number | undefined,
  implausible: boolean
): SituationSeverity {
  if ((downloadMbps ?? Infinity) < 1 || (uploadMbps ?? Infinity) < 0.5 || (latencyMs ?? 0) > 250 || (signalDbm ?? 0) < -118) {
    return "critical";
  }
  if ((downloadMbps ?? Infinity) < 5 || (uploadMbps ?? Infinity) < 1.5 || (latencyMs ?? 0) > 150 || (signalDbm ?? 0) < -110) {
    return "warning";
  }
  if (implausible || (downloadMbps ?? Infinity) < 15 || (uploadMbps ?? Infinity) < 5 || (latencyMs ?? 0) > 75 || (signalDbm ?? 0) < -100) {
    return "advisory";
  }
  return "info";
}

function ctuNettestConfidence(locationAccuracyM: number | undefined, implausible: boolean, downloadMbps: number | undefined): number {
  let confidence = 0.8;
  if (locationAccuracyM === undefined) {
    confidence -= 0.18;
  } else if (locationAccuracyM > 500) {
    confidence -= 0.25;
  } else if (locationAccuracyM > 100) {
    confidence -= 0.12;
  }
  if (implausible) {
    confidence -= 0.35;
  }
  if (downloadMbps === undefined) {
    confidence -= 0.1;
  }
  return clamp(confidence, 0.2, 0.88);
}

function pidVehicleMode(
  vehicleId: string | undefined,
  routeId: string | null | undefined
): { category: string; label: string; tag: string; routeTypeCode?: number } {
  const normalizedVehicleId = vehicleId?.toLowerCase() ?? "";
  const serviceMatch = normalizedVehicleId.match(/^service-(\d+)-/);
  const routeTypeCode = serviceMatch ? Number(serviceMatch[1]) : undefined;
  if (routeTypeCode !== undefined) {
    return pidModeFromRouteType(routeTypeCode);
  }
  if (normalizedVehicleId.startsWith("metro-") || /^L?[ABC]$/i.test(routeId ?? "")) {
    return pidModeFromRouteType(1);
  }
  if (normalizedVehicleId.startsWith("train-")) {
    return pidModeFromRouteType(2);
  }
  if (normalizedVehicleId.startsWith("tram-")) {
    return pidModeFromRouteType(0);
  }
  return pidModeFromRouteType(3);
}

function pidModeFromRouteType(routeTypeCode: number): { category: string; label: string; tag: string; routeTypeCode: number } {
  switch (routeTypeCode) {
    case 0:
      return { category: "public_transport_tram", label: "tram", tag: "tram", routeTypeCode };
    case 1:
      return { category: "public_transport_metro", label: "metro", tag: "metro", routeTypeCode };
    case 2:
      return { category: "public_transport_train", label: "train", tag: "train", routeTypeCode };
    case 11:
      return { category: "public_transport_trolleybus", label: "trolleybus", tag: "trolleybus", routeTypeCode };
    case 3:
    default:
      return { category: "public_transport_bus", label: "bus", tag: "bus", routeTypeCode };
  }
}

function pidRouteLabel(routeId: string | null | undefined, vehicleId: string | undefined): string | undefined {
  const route = optionalString(routeId)?.replace(/^L(?=[A-Z0-9])/i, "");
  if (route) {
    return route;
  }
  const metroMatch = vehicleId?.match(/^metro-([A-Z])-/i);
  return metroMatch?.[1]?.toUpperCase();
}

function pidTrafficSeverity(value: transit_realtime.VehiclePosition.CongestionLevel | null | undefined): SituationSeverity {
  switch (value) {
    case gtfsRealtime.transit_realtime.VehiclePosition.CongestionLevel.SEVERE_CONGESTION:
      return "critical";
    case gtfsRealtime.transit_realtime.VehiclePosition.CongestionLevel.CONGESTION:
      return "warning";
    case gtfsRealtime.transit_realtime.VehiclePosition.CongestionLevel.STOP_AND_GO:
      return "advisory";
    default:
      return "info";
  }
}

function pidPositionConfidence(observedAt: string): number {
  const ageSeconds = Math.max(0, (Date.now() - Date.parse(observedAt)) / 1000);
  if (ageSeconds <= 60) {
    return 0.88;
  }
  if (ageSeconds <= 180) {
    return 0.76;
  }
  return 0.55;
}

function pidVehicleStopStatus(value: transit_realtime.VehiclePosition.VehicleStopStatus | null | undefined): string | undefined {
  switch (value) {
    case gtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.INCOMING_AT:
      return "incoming_at";
    case gtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.STOPPED_AT:
      return "stopped_at";
    case gtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.IN_TRANSIT_TO:
      return "in_transit_to";
    default:
      return undefined;
  }
}

function pidCongestionLevel(value: transit_realtime.VehiclePosition.CongestionLevel | null | undefined): string | undefined {
  switch (value) {
    case gtfsRealtime.transit_realtime.VehiclePosition.CongestionLevel.RUNNING_SMOOTHLY:
      return "running_smoothly";
    case gtfsRealtime.transit_realtime.VehiclePosition.CongestionLevel.STOP_AND_GO:
      return "stop_and_go";
    case gtfsRealtime.transit_realtime.VehiclePosition.CongestionLevel.CONGESTION:
      return "congestion";
    case gtfsRealtime.transit_realtime.VehiclePosition.CongestionLevel.SEVERE_CONGESTION:
      return "severe_congestion";
    default:
      return undefined;
  }
}

function pidOccupancyStatus(value: transit_realtime.VehiclePosition.OccupancyStatus | null | undefined): string | undefined {
  switch (value) {
    case gtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.EMPTY:
      return "empty";
    case gtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.MANY_SEATS_AVAILABLE:
      return "many_seats_available";
    case gtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.FEW_SEATS_AVAILABLE:
      return "few_seats_available";
    case gtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.STANDING_ROOM_ONLY:
      return "standing_room_only";
    case gtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.CRUSHED_STANDING_ROOM_ONLY:
      return "crushed_standing_room_only";
    case gtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.FULL:
      return "full";
    case gtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.NOT_ACCEPTING_PASSENGERS:
      return "not_accepting_passengers";
    case gtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus.NOT_BOARDABLE:
      return "not_boardable";
    default:
      return undefined;
  }
}

function longToNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "object" && value !== null && "toNumber" in value && typeof value.toNumber === "function") {
    const parsed = value.toNumber();
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stableToken(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 96);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function formatBbox(bbox: BoundingBox): string {
  return [bbox.west, bbox.south, bbox.east, bbox.north].map((value) => round(value, 6)).join(",");
}

function formatAviationWeatherBbox(bbox: BoundingBox): string {
  return [bbox.south, bbox.west, bbox.north, bbox.east].map((value) => round(value, 6)).join(",");
}

function normalizeIcaoId(value: string | undefined): string {
  return value?.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") ?? "";
}

function epochSecondsToIso(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseAviationTime(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function aviationWeatherSeverity(flightCategory: string | undefined, taf: AviationTaf | undefined): SituationSeverity {
  if (flightCategory === "LIFR") {
    return "critical";
  }
  if (flightCategory === "IFR") {
    return "warning";
  }
  if (flightCategory === "MVFR") {
    return "advisory";
  }
  const tafText = `${taf?.rawTAF ?? ""} ${(taf?.fcsts ?? []).map((forecast) => forecast.wxString ?? "").join(" ")}`.toUpperCase();
  if (/\b(TS|TSRA|\+TSRA|FZ|GR|CB)\b/.test(tafText)) {
    return "warning";
  }
  if (/\b(SHRA|SN|FG|BR|BKN00|OVC00)\b/.test(tafText)) {
    return "advisory";
  }
  return "info";
}

function parseSeverity(value: SituationSeverity | undefined): SituationSeverity {
  switch (value) {
    case "critical":
    case "warning":
    case "advisory":
    case "info":
      return value;
    default:
      return "info";
  }
}

function knotsToMps(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? round(value * 0.514444, 2) : undefined;
}

function isLonLatPair(value: unknown): value is [number, number] {
  return Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function compactMetrics(values: Record<string, number | undefined>): Record<string, number> | undefined {
  const entries = Object.entries(values).filter((entry): entry is [string, number] => typeof entry[1] === "number");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
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

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
