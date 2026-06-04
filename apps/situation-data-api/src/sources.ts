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
const CHMI_WEATHER_GRID_LAYERS = [
  "weather_temperature_grid",
  "weather_wind_field",
  "weather_precipitation_grid",
  "weather_humidity_grid",
  "weather_pressure_grid"
] satisfies SituationLayerId[];
const CHMI_WEATHER_GRID_LAYER_SET = new Set<SituationLayerId>(CHMI_WEATHER_GRID_LAYERS);
const CHMI_AIR_QUALITY_VALIDITY_SECONDS = 4 * 60 * 60;
const CHMI_RADAR_LAYERS = [
  "weather_radar_reflectivity",
  "weather_radar_precipitation",
  "weather_radar_nowcast",
  "weather_thunderstorm_risk"
] satisfies SituationLayerId[];
const CHMI_RADAR_LAYER_SET = new Set<SituationLayerId>(CHMI_RADAR_LAYERS);
const CHMI_RADAR_DATA_BBOX: BoundingBox = { west: 11.267, south: 48.047, east: 19.624, north: 51.458 };
const CHMI_RADAR_IMAGE_BBOX: BoundingBox = { west: 11.267, south: 48.047, east: 20.77, north: 52.167 };
const CHMI_RADAR_REFLECTIVITY_LEGEND_URL = "https://opendata.chmi.cz/meteorology/weather/radar/scl/scl-dbzmmh.png";
const CHMI_RADAR_PRECIPITATION_LEGEND_URL = "https://opendata.chmi.cz/meteorology/weather/radar/scl/scl-mm.png";

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

const CHMI_OPEN_DATA_LICENSE: SituationDataLicense = {
  name: "ČHMÚ Open Data / CC BY 4.0",
  url: "https://opendata.chmi.cz/",
  attribution: "Český hydrometeorologický ústav",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Attribution is required.",
    "SIM caches CHMI Open Data server-side; COM clients must not call CHMI directly.",
    "Use as public situational context, not as a replacement for official warnings or emergency instructions."
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

const CTU_STATIONARY_MOBILE_LICENSE: SituationDataLicense = {
  name: "ČTÚ open data",
  url: "https://data.ctu.gov.cz/tags/mobilni-site",
  attribution: "Český telekomunikační úřad",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Official stationary 2G/4G mobile signal measurements published through the Czech open-data catalog.",
    "Dataset distributions declare no copyright work, no protected database right and no personal data.",
    "Measurements are historical reference observations; they do not confirm current BTS/NOC operational state."
  ]
};

const MOBILE_NETWORK_LICENSE: SituationDataLicense = {
  name: "Unified mobile network assessment",
  attribution: "CSM SIM model; Czech Telecommunication Office / CTU-NetTest / ČTÚ open data; OpenStreetMap contributors where tower hints are used",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Unified assessment from public measurements, official stationary signal measurements, modelled coverage and infrastructure hints.",
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

const IDSJMK_VEHICLE_POSITIONS_LICENSE: SituationDataLicense = {
  name: "IDS JMK / Brno Open Data",
  url: "https://data.gov.cz/datové-sady?klíčová-slova=polohy",
  attribution: "KORDIS JMK / Statutární město Brno open data",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Public transit vehicle positions for IDS JMK are updated roughly every 10 seconds according to NKOD metadata.",
    "SIM caches the feed server-side; COM must not poll the upstream endpoint directly.",
    "Vehicle positions are public transport context, not an emergency or security track source."
  ]
};

const ROAD_SRTI_LOD_LICENSE: SituationDataLicense = {
  name: "NDIC/ŘSD SRTI Linked Open Data",
  url: "https://lod.tamtamresearch.com/docs/",
  attribution: "Ředitelství silnic a dálnic / NDIC; LOD conversion by TamTam Research",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Safety-related road traffic information from NDIC/ŘSD transformed from DATEX II to Linked Open Data.",
    "SIM queries the SPARQL endpoint as a coarse server-side source and filters cached results by COM bbox.",
    "Use as public traffic context; follow official police/emergency instructions for safety decisions."
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
  attribution: "ARDOS / ARDOS partner feed",
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
    ctu_stationary_mobile: new CtuStationaryMobileSource(config),
    pid_gtfs_rt: new PidGtfsRtSource(config),
    idsjmk_vehicle_positions: new IdsjmkVehiclePositionsSource(config),
    road_srti_lod: new RoadSrtiLodSource(config),
    safety_data: new SafetyDataProjectionSource(config),
    aviation_weather: new AviationWeatherSource(config),
    chmi_air_quality: new ChmiAirQualitySource(config),
    chmi_weather_stations: new ChmiWeatherStationsSource(config),
    chmi_weather_radar: new ChmiWeatherRadarSource(config),
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
    new CtuStationaryMobileSource(config).descriptor,
    new PidGtfsRtSource(config).descriptor,
    new IdsjmkVehiclePositionsSource(config).descriptor,
    new RoadSrtiLodSource(config).descriptor,
    new SafetyDataProjectionSource(config).descriptor,
    new AviationWeatherSource(config).descriptor,
    new ChmiAirQualitySource(config).descriptor,
    new ChmiWeatherStationsSource(config).descriptor,
    new ChmiWeatherRadarSource(config).descriptor,
    new ArdosPartnerSource(config).descriptor
  ].map((descriptor) => ({ ...descriptor, enabled: enabled.has(descriptor.sourceId) }));
}

function cacheStatsFor<T>(sourceId: SituationDataSourceId, cache: ManagedResponseCache<T>): SourceCacheStats {
  return {
    sourceId,
    ...cache.stats()
  };
}

function aggregateCacheStatsFor(sourceId: SituationDataSourceId, caches: Array<{ stats(): ManagedResponseCacheStats }>): SourceCacheStats {
  const initial: SourceCacheStats = {
    sourceId,
    entries: 0,
    inflight: 0,
    hits: 0,
    misses: 0,
    coalescedHits: 0,
    staleHits: 0,
    refreshes: 0,
    errors: 0,
    evictions: 0,
    sharedEnabled: false,
    sharedAvailable: false,
    sharedHits: 0,
    sharedMisses: 0,
    sharedStaleHits: 0,
    sharedWrites: 0,
    sharedErrors: 0
  };
  return caches.reduce<SourceCacheStats>((summary, cache) => {
    const stats = cache.stats();
    return {
      sourceId,
      entries: summary.entries + stats.entries,
      inflight: summary.inflight + stats.inflight,
      hits: summary.hits + stats.hits,
      misses: summary.misses + stats.misses,
      coalescedHits: summary.coalescedHits + stats.coalescedHits,
      staleHits: summary.staleHits + stats.staleHits,
      refreshes: summary.refreshes + stats.refreshes,
      errors: summary.errors + stats.errors,
      evictions: summary.evictions + stats.evictions,
      sharedEnabled: summary.sharedEnabled || stats.sharedEnabled,
      sharedAvailable: summary.sharedAvailable || stats.sharedAvailable,
      sharedHits: summary.sharedHits + stats.sharedHits,
      sharedMisses: summary.sharedMisses + stats.sharedMisses,
      sharedStaleHits: summary.sharedStaleHits + stats.sharedStaleHits,
      sharedWrites: summary.sharedWrites + stats.sharedWrites,
      sharedErrors: summary.sharedErrors + stats.sharedErrors
    };
  }, initial);
}

const ctuNettestRecordsCaches = new Map<string, ManagedResponseCache<Array<Record<string, string>>>>();
const ctuStationaryMobileRecordsCaches = new Map<string, ManagedResponseCache<CtuStationaryMobileRecord[]>>();
const chmiAirQualityMetadataCaches = new Map<string, ManagedResponseCache<ChmiAirQualityMetadata>>();
const chmiAirQualityRecordsCaches = new Map<string, ManagedResponseCache<Array<Record<string, string>>>>();
const chmiWeatherIndexCaches = new Map<string, ManagedResponseCache<string>>();
const chmiWeatherMetadataCaches = new Map<string, ManagedResponseCache<ChmiDataCollectionPayload>>();
const chmiWeatherStationFileCaches = new Map<string, ManagedResponseCache<ChmiDataCollectionPayload>>();
const chmiWeatherRadarIndexCaches = new Map<string, ManagedResponseCache<string>>();

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

function ctuStationaryMobileRecordsCache(config: SituationDataConfig): ManagedResponseCache<CtuStationaryMobileRecord[]> {
  const key = `${config.ctuStationaryMobileUrls.join("|")}:${config.requestTimeoutMs}:${config.ctuStationaryMobileCacheTtlSeconds}`;
  const existing = ctuStationaryMobileRecordsCaches.get(key);
  if (existing) {
    return existing;
  }
  const cache = new ManagedResponseCache<CtuStationaryMobileRecord[]>({
    ttlMs: Math.max(3600, config.ctuStationaryMobileCacheTtlSeconds) * 1000,
    staleIfErrorMs: Math.max(config.ctuStationaryMobileCacheTtlSeconds, config.staleIfErrorSeconds, 7 * 24 * 60 * 60) * 1000,
    maxEntries: 1
  });
  ctuStationaryMobileRecordsCaches.set(key, cache);
  return cache;
}

function chmiAirQualityMetadataCache(config: SituationDataConfig): ManagedResponseCache<ChmiAirQualityMetadata> {
  const key = `${config.chmiAirQualityMetadataUrl}:${config.chmiAirQualityCacheTtlSeconds}`;
  const existing = chmiAirQualityMetadataCaches.get(key);
  if (existing) {
    return existing;
  }
  const cache = new ManagedResponseCache<ChmiAirQualityMetadata>({
    ttlMs: Math.max(300, config.chmiAirQualityCacheTtlSeconds) * 1000,
    staleIfErrorMs: Math.max(config.chmiAirQualityCacheTtlSeconds, config.staleIfErrorSeconds, 3600) * 1000,
    maxEntries: 1
  });
  chmiAirQualityMetadataCaches.set(key, cache);
  return cache;
}

function chmiAirQualityRecordsCache(config: SituationDataConfig): ManagedResponseCache<Array<Record<string, string>>> {
  const key = `${config.chmiAirQualityDataUrl}:${config.chmiAirQualityCacheTtlSeconds}`;
  const existing = chmiAirQualityRecordsCaches.get(key);
  if (existing) {
    return existing;
  }
  const cache = new ManagedResponseCache<Array<Record<string, string>>>({
    ttlMs: Math.max(300, config.chmiAirQualityCacheTtlSeconds) * 1000,
    staleIfErrorMs: Math.max(config.chmiAirQualityCacheTtlSeconds, config.staleIfErrorSeconds, 3600) * 1000,
    maxEntries: 1
  });
  chmiAirQualityRecordsCaches.set(key, cache);
  return cache;
}

function chmiWeatherIndexCache(config: SituationDataConfig, kind: "metadata" | "data"): ManagedResponseCache<string> {
  const baseUrl = kind === "metadata" ? config.chmiWeatherMetadataBaseUrl : config.chmiWeatherDataBaseUrl;
  const key = `${kind}:${baseUrl}:${config.chmiWeatherCacheTtlSeconds}`;
  const existing = chmiWeatherIndexCaches.get(key);
  if (existing) {
    return existing;
  }
  const cache = new ManagedResponseCache<string>({
    ttlMs: Math.max(300, config.chmiWeatherCacheTtlSeconds) * 1000,
    staleIfErrorMs: Math.max(config.chmiWeatherCacheTtlSeconds, config.staleIfErrorSeconds, 3600) * 1000,
    maxEntries: 1
  });
  chmiWeatherIndexCaches.set(key, cache);
  return cache;
}

function chmiWeatherMetadataCache(config: SituationDataConfig): ManagedResponseCache<ChmiDataCollectionPayload> {
  const key = `${config.chmiWeatherMetadataBaseUrl}:${config.chmiWeatherCacheTtlSeconds}`;
  const existing = chmiWeatherMetadataCaches.get(key);
  if (existing) {
    return existing;
  }
  const cache = new ManagedResponseCache<ChmiDataCollectionPayload>({
    ttlMs: Math.max(300, config.chmiWeatherCacheTtlSeconds) * 1000,
    staleIfErrorMs: Math.max(config.chmiWeatherCacheTtlSeconds, config.staleIfErrorSeconds, 3600) * 1000,
    maxEntries: 4
  });
  chmiWeatherMetadataCaches.set(key, cache);
  return cache;
}

function chmiWeatherStationFileCache(config: SituationDataConfig): ManagedResponseCache<ChmiDataCollectionPayload> {
  const key = `${config.chmiWeatherDataBaseUrl}:${config.chmiWeatherCacheTtlSeconds}:${config.chmiWeatherMaxStations}`;
  const existing = chmiWeatherStationFileCaches.get(key);
  if (existing) {
    return existing;
  }
  const cache = new ManagedResponseCache<ChmiDataCollectionPayload>({
    ttlMs: Math.max(300, config.chmiWeatherCacheTtlSeconds) * 1000,
    staleIfErrorMs: Math.max(config.chmiWeatherCacheTtlSeconds, config.staleIfErrorSeconds, 3600) * 1000,
    maxEntries: Math.max(64, Math.min(config.cacheMaxEntries, 2048))
  });
  chmiWeatherStationFileCaches.set(key, cache);
  return cache;
}

function chmiWeatherRadarIndexCache(config: SituationDataConfig): ManagedResponseCache<string> {
  const key = `${config.chmiWeatherRadarBaseUrl}:${config.chmiWeatherRadarCacheTtlSeconds}`;
  const existing = chmiWeatherRadarIndexCaches.get(key);
  if (existing) {
    return existing;
  }
  const cache = new ManagedResponseCache<string>({
    ttlMs: Math.max(60, config.chmiWeatherRadarCacheTtlSeconds) * 1000,
    staleIfErrorMs: Math.max(config.chmiWeatherRadarCacheTtlSeconds, config.staleIfErrorSeconds, 1800) * 1000,
    maxEntries: 16
  });
  chmiWeatherRadarIndexCaches.set(key, cache);
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

class ChmiAirQualitySource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly metadataCache: ManagedResponseCache<ChmiAirQualityMetadata>;
  private readonly recordsCache: ManagedResponseCache<Array<Record<string, string>>>;

  constructor(private readonly config: SituationDataConfig) {
    this.metadataCache = chmiAirQualityMetadataCache(config);
    this.recordsCache = chmiAirQualityRecordsCache(config);
    this.descriptor = {
      sourceId: "chmi_air_quality",
      label: "CHMI air quality observations",
      enabled: config.enabledSources.includes("chmi_air_quality"),
      mode: "live",
      priority: 84,
      layers: ["air_quality", "air_quality_grid"],
      license: CHMI_OPEN_DATA_LICENSE,
      baseUrl: config.chmiAirQualityDataUrl,
      updateCadenceSeconds: config.chmiAirQualityCacheTtlSeconds
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [aggregateCacheStatsFor("chmi_air_quality", [this.metadataCache, this.recordsCache])];
  }

  async healthStatus(): Promise<SourceHealthStatus> {
    try {
      const [metadata, records] = await Promise.all([
        this.metadataCache.getOrLoad("chmi_air_quality_metadata", () =>
          requestJson<ChmiAirQualityMetadata>(this.config.chmiAirQualityMetadataUrl, this.config.requestTimeoutMs)
        ),
        this.recordsCache.getOrLoad("chmi_air_quality_records", () =>
          requestText(this.config.chmiAirQualityDataUrl, this.config.requestTimeoutMs).then(parseCsvRecords)
        )
      ]);
      const lastImportAt = latestRecordTimestamp(records, "startTime");
      const lastImportAgeSeconds = lastImportAt ? Math.max(0, Math.round((Date.now() - Date.parse(lastImportAt)) / 1000)) : undefined;
      const localityCount = (metadata.data?.Localities ?? []).filter((locality) => chmiLocalityLonLat(locality)).length;
      const warnings: string[] = [];
      if (records.length === 0) {
        warnings.push("chmi_air_quality did not return observation rows.");
      }
      if (localityCount === 0) {
        warnings.push("chmi_air_quality metadata did not contain georeferenced localities.");
      }
      if (lastImportAgeSeconds !== undefined && lastImportAgeSeconds > 4 * 60 * 60) {
        warnings.push("chmi_air_quality newest observation is older than 4 hours.");
      }
      return {
        sourceId: "chmi_air_quality",
        status: warnings.length === 0 ? "ok" : "degraded",
        backend: "chmi-opendata",
        objectCount: localityCount,
        lastImportAt,
        lastImportAgeSeconds,
        warnings
      };
    } catch (error) {
      return {
        sourceId: "chmi_air_quality",
        status: "degraded",
        backend: "chmi-opendata",
        warnings: [error instanceof Error ? error.message : "Unknown chmi_air_quality health check failure."]
      };
    }
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    const includeStationObservations = query.layers.includes("air_quality");
    const includeGrid = query.layers.includes("air_quality_grid");
    if (!includeStationObservations && !includeGrid) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const [metadata, records] = await Promise.all([
      this.metadataCache.getOrLoad("chmi_air_quality_metadata", () =>
        requestJson<ChmiAirQualityMetadata>(this.config.chmiAirQualityMetadataUrl, this.config.requestTimeoutMs)
      ),
      this.recordsCache.getOrLoad("chmi_air_quality_records", () =>
        requestText(this.config.chmiAirQualityDataUrl, this.config.requestTimeoutMs).then(parseCsvRecords)
      )
    ]);
    const registry = chmiAirQualityMeasurementRegistry(metadata);
    const aggregates = aggregateChmiAirQuality(records, registry);
    const stationFeatures = includeStationObservations
      ? Array.from(aggregates.values())
          .map((aggregate) => mapChmiAirQualityFeature(aggregate, query, fetchedAt))
          .filter((feature): feature is SituationFeature => Boolean(feature))
      : [];
    const gridFeatures = includeGrid
      ? Array.from(aggregates.values())
          .map((aggregate) => mapChmiAirQualityGridFeature(aggregate, query, fetchedAt, this.config.openMeteoGridDegrees))
          .filter((feature): feature is SituationFeature => Boolean(feature))
      : [];
    const features = [...stationFeatures.slice(0, query.limit), ...gridFeatures.slice(0, query.limit)];

    const warnings: string[] = [];
    if (features.length === 0) {
      warnings.push("chmi_air_quality returned no georeferenced observations in the requested bbox.");
    }
    return { source: this.descriptor, fetchedAt, features, warnings };
  }
}

class ChmiWeatherStationsSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly metadataIndexCache: ManagedResponseCache<string>;
  private readonly dataIndexCache: ManagedResponseCache<string>;
  private readonly metadataCache: ManagedResponseCache<ChmiDataCollectionPayload>;
  private readonly stationFileCache: ManagedResponseCache<ChmiDataCollectionPayload>;

  constructor(private readonly config: SituationDataConfig) {
    this.metadataIndexCache = chmiWeatherIndexCache(config, "metadata");
    this.dataIndexCache = chmiWeatherIndexCache(config, "data");
    this.metadataCache = chmiWeatherMetadataCache(config);
    this.stationFileCache = chmiWeatherStationFileCache(config);
    this.descriptor = {
      sourceId: "chmi_weather_stations",
      label: "CHMI measured weather stations",
      enabled: config.enabledSources.includes("chmi_weather_stations"),
      mode: "live",
      priority: 83,
      layers: [
        "weather",
        "weather_temperature_grid",
        "weather_wind_field",
        "weather_precipitation_grid",
        "weather_humidity_grid",
        "weather_pressure_grid"
      ],
      license: CHMI_OPEN_DATA_LICENSE,
      baseUrl: config.chmiWeatherDataBaseUrl,
      updateCadenceSeconds: config.chmiWeatherCacheTtlSeconds
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [
      aggregateCacheStatsFor("chmi_weather_stations", [
        this.metadataIndexCache,
        this.dataIndexCache,
        this.metadataCache,
        this.stationFileCache
      ])
    ];
  }

  async healthStatus(): Promise<SourceHealthStatus> {
    try {
      const [metadataIndex, dataIndex] = await Promise.all([
        this.metadataIndexCache.getOrLoad("chmi_weather_metadata_index", () => requestText(this.config.chmiWeatherMetadataBaseUrl, this.config.requestTimeoutMs)),
        this.dataIndexCache.getOrLoad("chmi_weather_data_index", () => requestText(this.config.chmiWeatherDataBaseUrl, this.config.requestTimeoutMs))
      ]);
      const metadataHref = latestHrefFromIndex(metadataIndex, /^meta1-\d{8}\.json$/);
      if (!metadataHref) {
        throw new Error("chmi_weather_stations metadata index did not contain meta1 files.");
      }
      const metadataUrl = joinUrl(this.config.chmiWeatherMetadataBaseUrl, metadataHref);
      const metadata = await this.metadataCache.getOrLoad(metadataUrl, () => requestJson<ChmiDataCollectionPayload>(metadataUrl, this.config.requestTimeoutMs));
      const stations = chmiWeatherStationsFromMetadata(metadata);
      const latestDataDate = latestChmiWeatherDataDate(dataIndex);
      const lastImportAt = latestDataDate ? dateTokenToIso(latestDataDate) : undefined;
      const lastImportAgeSeconds = lastImportAt ? Math.max(0, Math.round((Date.now() - Date.parse(lastImportAt)) / 1000)) : undefined;
      const warnings: string[] = [];
      if (stations.length === 0) {
        warnings.push("chmi_weather_stations metadata did not contain georeferenced stations.");
      }
      if (!latestDataDate) {
        warnings.push("chmi_weather_stations data index did not contain 10m station data files.");
      }
      if (lastImportAgeSeconds !== undefined && lastImportAgeSeconds > 48 * 60 * 60) {
        warnings.push("chmi_weather_stations data files are older than 48 hours.");
      }
      return {
        sourceId: "chmi_weather_stations",
        status: warnings.length === 0 ? "ok" : "degraded",
        backend: "chmi-opendata",
        objectCount: stations.length,
        lastImportAt,
        lastImportAgeSeconds,
        warnings
      };
    } catch (error) {
      return {
        sourceId: "chmi_weather_stations",
        status: "degraded",
        backend: "chmi-opendata",
        warnings: [error instanceof Error ? error.message : "Unknown chmi_weather_stations health check failure."]
      };
    }
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    const requestedWeatherGridLayers = query.layers.filter((layer) => CHMI_WEATHER_GRID_LAYER_SET.has(layer));
    const includeStationObservations = query.layers.includes("weather");
    if (!includeStationObservations && requestedWeatherGridLayers.length === 0) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const [metadataIndex, dataIndex] = await Promise.all([
      this.metadataIndexCache.getOrLoad("chmi_weather_metadata_index", () => requestText(this.config.chmiWeatherMetadataBaseUrl, this.config.requestTimeoutMs)),
      this.dataIndexCache.getOrLoad("chmi_weather_data_index", () => requestText(this.config.chmiWeatherDataBaseUrl, this.config.requestTimeoutMs))
    ]);
    const metadataHref = latestHrefFromIndex(metadataIndex, /^meta1-\d{8}\.json$/);
    if (!metadataHref) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: ["chmi_weather_stations metadata index did not contain meta1 files."] };
    }
    const metadataUrl = joinUrl(this.config.chmiWeatherMetadataBaseUrl, metadataHref);
    const metadata = await this.metadataCache.getOrLoad(metadataUrl, () => requestJson<ChmiDataCollectionPayload>(metadataUrl, this.config.requestTimeoutMs));
    const stationFiles = chmiWeatherStationFileMap(dataIndex);
    const center = bboxCenter(query.bbox);
    const stations = chmiWeatherStationsFromMetadata(metadata)
      .filter((station) => isPointInBbox(station.lon, station.lat, query.bbox))
      .sort((a, b) => distanceSquared(a.lon, a.lat, center.lon, center.lat) - distanceSquared(b.lon, b.lat, center.lon, center.lat))
      .slice(0, Math.max(1, this.config.chmiWeatherMaxStations));

    const warnings: string[] = [];
    const selected = stations.flatMap((station) => {
      const file = stationFiles.get(station.stationId);
      if (!file) {
        return [];
      }
      return [{ station, file }];
    });
    if (selected.length < stations.length) {
      warnings.push(`chmi_weather_stations skipped ${stations.length - selected.length} station(s) without a current 10m data file.`);
    }

    const settled = await Promise.allSettled(
      selected.map(async ({ station, file }) => {
        const url = joinUrl(this.config.chmiWeatherDataBaseUrl, file.href);
        const payload = await this.stationFileCache.getOrLoad(url, () => requestJson<ChmiDataCollectionPayload>(url, this.config.requestTimeoutMs));
        const pointFeature = mapChmiWeatherStationFeature(station, payload, query, fetchedAt);
        const gridFeatures = pointFeature
          ? requestedWeatherGridLayers.flatMap((layer) => mapChmiWeatherGridFeature(layer, station, pointFeature, this.config.openMeteoGridDegrees))
          : [];
        return [...(includeStationObservations && pointFeature ? [pointFeature] : []), ...gridFeatures];
      })
    );
    const features = settled
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
      .slice(0, Math.max(query.limit, query.limit * Math.max(1, requestedWeatherGridLayers.length)));
    for (const result of settled) {
      if (result.status === "rejected") {
        warnings.push(result.reason instanceof Error ? result.reason.message : "Unknown chmi_weather_stations station-file failure.");
      }
    }
    if (features.length === 0) {
      warnings.push("chmi_weather_stations returned no measured station observations in the requested bbox.");
    }

    return { source: this.descriptor, fetchedAt, features, warnings };
  }
}

interface ChmiRadarAsset {
  href: string;
  url: string;
  observedAt: string;
}

interface ChmiRadarProductDefinition {
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

class ChmiWeatherRadarSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly indexCache: ManagedResponseCache<string>;

  constructor(private readonly config: SituationDataConfig) {
    this.indexCache = chmiWeatherRadarIndexCache(config);
    this.descriptor = {
      sourceId: "chmi_weather_radar",
      label: "CHMI weather radar overlays",
      enabled: config.enabledSources.includes("chmi_weather_radar"),
      mode: "live",
      priority: 86,
      layers: [...CHMI_RADAR_LAYERS],
      license: CHMI_OPEN_DATA_LICENSE,
      baseUrl: config.chmiWeatherRadarBaseUrl,
      updateCadenceSeconds: config.chmiWeatherRadarCacheTtlSeconds
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("chmi_weather_radar", this.indexCache)];
  }

  async healthStatus(): Promise<SourceHealthStatus> {
    try {
      const products = await this.resolveProducts(chmiRadarProductDefinitions());
      const latest = latestChmiRadarProductTimestamp(products);
      const lastImportAgeSeconds = latest ? Math.max(0, Math.round((Date.now() - Date.parse(latest)) / 1000)) : undefined;
      const warnings = products
        .filter((product) => !product.asset)
        .map((product) => `chmi_weather_radar missing ${product.definition.productId} product in upstream index.`);
      if (lastImportAgeSeconds !== undefined && lastImportAgeSeconds > 2 * 60 * 60) {
        warnings.push("chmi_weather_radar latest product is older than 2 hours.");
      }
      return {
        sourceId: "chmi_weather_radar",
        status: warnings.length === 0 ? "ok" : "degraded",
        backend: "chmi-opendata",
        objectCount: products.filter((product) => product.asset).length,
        lastImportAt: latest,
        lastImportAgeSeconds,
        warnings
      };
    } catch (error) {
      return {
        sourceId: "chmi_weather_radar",
        status: "degraded",
        backend: "chmi-opendata",
        warnings: [error instanceof Error ? error.message : "Unknown chmi_weather_radar health check failure."]
      };
    }
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    const requestedLayers = query.layers.filter((layer) => CHMI_RADAR_LAYER_SET.has(layer));
    if (requestedLayers.length === 0) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }
    if (!bboxIntersects(query.bbox, CHMI_RADAR_IMAGE_BBOX)) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const definitions = chmiRadarProductDefinitions().filter((definition) => requestedLayers.includes(definition.layer));
    const products = await this.resolveProducts(definitions);
    const warnings = products
      .filter((product) => !product.asset)
      .map((product) => `chmi_weather_radar missing ${product.definition.productId} product in upstream index.`);
    const features = products
      .flatMap((product) => {
        if (!product.asset) {
          return [];
        }
        return [makeChmiRadarFeature(product.definition, product.asset, product.hdfAsset, fetchedAt, query.includeRaw)];
      })
      .slice(0, query.limit);

    return { source: this.descriptor, fetchedAt, features, warnings };
  }

  private async resolveProducts(
    definitions: ChmiRadarProductDefinition[]
  ): Promise<Array<{ definition: ChmiRadarProductDefinition; asset?: ChmiRadarAsset; hdfAsset?: ChmiRadarAsset }>> {
    return Promise.all(
      definitions.map(async (definition) => {
        const [asset, hdfAsset] = await Promise.all([
          this.resolveLatestAsset(definition.indexPath, definition.filePattern),
          definition.hdfIndexPath && definition.hdfFilePattern ? this.resolveLatestAsset(definition.hdfIndexPath, definition.hdfFilePattern) : Promise.resolve(undefined)
        ]);
        return { definition, asset, hdfAsset };
      })
    );
  }

  private async resolveLatestAsset(indexPath: string, pattern: RegExp): Promise<ChmiRadarAsset | undefined> {
    const indexUrl = joinUrl(this.config.chmiWeatherRadarBaseUrl, indexPath);
    const html = await this.indexCache.getOrLoad(indexUrl, () => requestText(indexUrl, this.config.requestTimeoutMs));
    const href = latestChmiRadarHrefFromIndex(html, pattern);
    if (!href) {
      return undefined;
    }
    const observedAt = parseChmiRadarTimestampFromHref(href);
    if (!observedAt) {
      return undefined;
    }
    return {
      href,
      url: joinUrl(indexUrl, href),
      observedAt
    };
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

interface CtuStationaryMobileRecord {
  record: Record<string, string>;
  operator: "O2" | "T-Mobile" | "Vodafone" | "unknown";
  technology: MobileCoverageTechnology;
  datasetUrl: string;
}

class CtuStationaryMobileSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly recordsCache: ManagedResponseCache<CtuStationaryMobileRecord[]>;

  constructor(private readonly config: SituationDataConfig) {
    this.recordsCache = ctuStationaryMobileRecordsCache(config);
    this.descriptor = {
      sourceId: "ctu_stationary_mobile",
      label: "CTU stationary mobile signal measurements",
      enabled: config.enabledSources.includes("ctu_stationary_mobile"),
      mode: "reference",
      priority: 63,
      layers: ["mobile"],
      license: CTU_STATIONARY_MOBILE_LICENSE,
      baseUrl: "https://ctu.gov.cz",
      updateCadenceSeconds: config.ctuStationaryMobileCacheTtlSeconds
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("ctu_stationary_mobile", this.recordsCache)];
  }

  async healthStatus(): Promise<SourceHealthStatus> {
    try {
      const records = await this.recordsCache.getOrLoad("ctu_stationary_mobile_records", () => fetchCtuStationaryMobileRecords(this.config));
      const lastImportAt = latestCtuStationaryMeasurementAt(records);
      const lastImportAgeSeconds = lastImportAt ? Math.max(0, Math.round((Date.now() - Date.parse(lastImportAt)) / 1000)) : undefined;
      const warnings: string[] = [];
      if (records.length === 0) {
        warnings.push("ctu_stationary_mobile did not return measurements.");
      }
      warnings.push("ctu_stationary_mobile contains official historical measurements, not current BTS/NOC state.");
      return {
        sourceId: "ctu_stationary_mobile",
        status: records.length > 0 ? "ok" : "degraded",
        backend: "ctu-stationary-mobile",
        objectCount: records.length,
        lastImportAt,
        lastImportAgeSeconds,
        warnings
      };
    } catch (error) {
      return {
        sourceId: "ctu_stationary_mobile",
        status: "degraded",
        backend: "ctu-stationary-mobile",
        warnings: [error instanceof Error ? error.message : "Unknown ctu_stationary_mobile health check failure."]
      };
    }
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("mobile")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const records = await this.recordsCache.getOrLoad("ctu_stationary_mobile_records", () => fetchCtuStationaryMobileRecords(this.config));
    const features: SituationFeature[] = [];
    for (const item of records) {
      if (features.length >= query.limit) {
        break;
      }
      const feature = mapCtuStationaryMobileRecord(item, query, fetchedAt);
      if (feature) {
        features.push(feature);
      }
    }

    return {
      source: this.descriptor,
      fetchedAt,
      features,
      warnings: ["ctu_stationary_mobile is a historical reference measurement source; it is not a confirmed current BTS status feed."]
    };
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
  ctuNettestCount: number;
  ctuStationaryCount: number;
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
  private readonly ctuStationaryMobileSource: CtuStationaryMobileSource;

  constructor(private readonly config: SituationDataConfig) {
    this.payloadCache = new ManagedResponseCache<MobileNetworkPayload>({
      ttlMs: Math.max(300, config.mobileNetworkCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.mobileNetworkCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(64, Math.min(config.cacheMaxEntries, 4096))
    });
    this.coverageSource = new MobileCoverageSource(config);
    this.ctuNettestSource = new CtuNettestSource(config);
    this.ctuStationaryMobileSource = new CtuStationaryMobileSource(config);
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
    const [coverageHealth, ctuHealth, ctuStationaryHealth] = await Promise.all([
      this.coverageSource.healthStatus?.(),
      this.ctuNettestSource.healthStatus?.(),
      this.config.enabledSources.includes("ctu_stationary_mobile") ? this.ctuStationaryMobileSource.healthStatus?.() : undefined
    ]);
    const warnings = [
      ...(coverageHealth?.warnings ?? ["mobile_network_model could not inspect mobile_coverage_model health."]),
      ...(ctuHealth?.warnings ?? ["mobile_network_model could not inspect ctu_nettest health."]),
      ...(ctuStationaryHealth?.warnings ?? []),
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
    const stationaryMeasurementQuery: SituationQuery = {
      bbox,
      layers: ["mobile"],
      sourceIds: ["ctu_stationary_mobile"],
      limit: 1000,
      includeRaw: false
    };

    const sourcePromises = [
      this.coverageSource.fetchFeatures(coverageQuery),
      this.ctuNettestSource.fetchFeatures(measurementQuery),
      this.config.enabledSources.includes("ctu_stationary_mobile")
        ? this.ctuStationaryMobileSource.fetchFeatures(stationaryMeasurementQuery)
        : Promise.resolve(undefined)
    ] as const;

    const [coverageSettled, measurementSettled, stationaryMeasurementSettled] = (await Promise.allSettled(sourcePromises)) as [
      PromiseSettledResult<SourceFetchResult>,
      PromiseSettledResult<SourceFetchResult>,
      PromiseSettledResult<SourceFetchResult | undefined>
    ];

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

    const stationaryMeasurements =
      stationaryMeasurementSettled.status === "fulfilled" && stationaryMeasurementSettled.value
        ? stationaryMeasurementSettled.value.features.filter((feature) => feature.geometry.type === "Point")
        : [];
    if (stationaryMeasurementSettled.status === "fulfilled" && stationaryMeasurementSettled.value) {
      warnings.push(...stationaryMeasurementSettled.value.warnings.map((warning) => `ctu_stationary_mobile: ${warning}`));
    } else if (stationaryMeasurementSettled.status === "rejected") {
      warnings.push(
        stationaryMeasurementSettled.reason instanceof Error
          ? `ctu_stationary_mobile: ${stationaryMeasurementSettled.reason.message}`
          : "ctu_stationary_mobile: unknown failure"
      );
    }

    const selectedCoverage = selectCoverageFeatures(coverageFeatures, technologies);
    const combinedMeasurements = [...measurements, ...stationaryMeasurements];
    const features =
      selectedCoverage.length > 0
        ? selectedCoverage.map((coverage) =>
            this.mobileNetworkFeatureFromCoverage(coverage, measurementsInPolygon(combinedMeasurements, coverage), generatedAt)
          )
        : [this.mobileNetworkFallbackFeature(bbox, combinedMeasurements, generatedAt)];

    if (combinedMeasurements.length === 0) {
      warnings.push("mobile_network_model has no CTU public measurements in the requested area; assessment is model-only.");
    }
    warnings.push("mobile_network_model does not contain authorized real-time BTS/NOC status; area status is inferred.");

    return {
      generatedAt,
      features,
      warnings,
      coverageFeatureCount: coverageFeatures.length,
      measurementCount: combinedMeasurements.length
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
        sourceRevision: coverage.properties.sourceRevision,
        readModel: coverage.properties.readModel === true,
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
          ctuNettestMeasurementCount: stats.ctuNettestCount,
          ctuStationaryMeasurementCount: stats.ctuStationaryCount,
          medianDownloadMbps: stats.medianDownloadMbps,
          medianUploadMbps: stats.medianUploadMbps,
          medianLatencyMs: stats.medianLatencyMs,
          medianSignalDbm: stats.medianSignalDbm,
          measurementConfidence: stats.count > 0 ? stats.averageConfidence : undefined,
          finalConfidence: confidence,
          distanceToNearestTowerM: coverage.properties.metrics?.distanceToNearestTowerM,
          coverageReadModel: coverage.properties.readModel === true
        }),
        tags: compactTags({
          basis: basis.join(","),
          status,
          dataQuality,
          btsStatus: "operator_feed_unavailable",
          coverageReadModel: coverage.properties.readModel === true ? "true" : undefined,
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
        basis: mobileNetworkFallbackBasis(stats),
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
        readModel: false,
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
          ctuNettestMeasurementCount: stats.ctuNettestCount,
          ctuStationaryMeasurementCount: stats.ctuStationaryCount,
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

class IdsjmkVehiclePositionsSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly feedCache: ManagedResponseCache<IdsjmkVehicleFeed>;

  constructor(private readonly config: SituationDataConfig) {
    this.feedCache = new ManagedResponseCache<IdsjmkVehicleFeed>({
      ttlMs: Math.max(10, config.idsjmkVehiclePositionsCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(300, config.staleIfErrorSeconds) * 1000,
      maxEntries: 1
    });
    this.descriptor = {
      sourceId: "idsjmk_vehicle_positions",
      label: "IDS JMK vehicle positions",
      enabled: config.enabledSources.includes("idsjmk_vehicle_positions"),
      mode: "live",
      priority: 74,
      layers: ["traffic"],
      license: IDSJMK_VEHICLE_POSITIONS_LICENSE,
      baseUrl: config.idsjmkVehiclePositionsUrl,
      updateCadenceSeconds: config.idsjmkVehiclePositionsCacheTtlSeconds
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("idsjmk_vehicle_positions", this.feedCache)];
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("traffic")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const feed = await this.feedCache.getOrLoad("idsjmk_vehicle_positions", () => fetchIdsjmkVehicleFeed(this.config));
    const observedAt = parseTimestamp(feed.LastUpdate ?? feed.lastUpdate) ?? fetchedAt;
    const vehicles = normalizeIdsjmkVehicles(feed);
    const features = vehicles
      .map((vehicle) => mapIdsjmkVehiclePosition(vehicle, query, observedAt))
      .filter((feature): feature is SituationFeature => Boolean(feature))
      .slice(0, query.limit);

    return { source: this.descriptor, fetchedAt, features, warnings: [] };
  }
}

class RoadSrtiLodSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly eventsCache: ManagedResponseCache<RoadSrtiLodEvent[]>;

  constructor(private readonly config: SituationDataConfig) {
    this.eventsCache = new ManagedResponseCache<RoadSrtiLodEvent[]>({
      ttlMs: Math.max(60, config.roadSrtiLodCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.roadSrtiLodCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: 1
    });
    this.descriptor = {
      sourceId: "road_srti_lod",
      label: "NDIC/ŘSD SRTI road events",
      enabled: config.enabledSources.includes("road_srti_lod"),
      mode: "live",
      priority: 82,
      layers: ["traffic"],
      license: ROAD_SRTI_LOD_LICENSE,
      baseUrl: config.roadSrtiLodSparqlUrl,
      updateCadenceSeconds: config.roadSrtiLodCacheTtlSeconds
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("road_srti_lod", this.eventsCache)];
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("traffic")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const events = await this.eventsCache.getOrLoad("road_srti_lod_recent", () => fetchRoadSrtiLodEvents(this.config));
    const features = events
      .map((event) => mapRoadSrtiLodFeature(event, query, fetchedAt))
      .filter((feature): feature is SituationFeature => Boolean(feature))
      .slice(0, query.limit);

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
      layers: ["warnings", "fire", "flood", "boundary_admin"],
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
    const layers = query.layers.filter(
      (layer): layer is SafetyProjectionLayer => layer === "warnings" || layer === "fire" || layer === "flood" || layer === "boundary_admin"
    );
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
  transportMode?: string;
  routeShortName?: string;
  destination?: string;
  delaySeconds?: number;
  vehicleId?: string;
  tripId?: string;
  occupancyStatus?: string;
  occupancyPercent?: number;
  headingDeg?: number;
  speedMps?: number;
  operator?: string;
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
      transportMode: input.transportMode,
      routeShortName: input.routeShortName,
      destination: input.destination,
      delaySeconds: input.delaySeconds,
      vehicleId: input.vehicleId,
      tripId: input.tripId,
      occupancyStatus: input.occupancyStatus,
      occupancyPercent: input.occupancyPercent,
      headingDeg: input.headingDeg,
      speedMps: input.speedMps,
      operator: input.operator,
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

function mapCtuStationaryMobileRecord(item: CtuStationaryMobileRecord, query: SituationQuery, fetchedAt: string): SituationFeature | undefined {
  const record = item.record;
  const lat = optionalNumber(record.y);
  const lon = optionalNumber(record.x);
  if (lat === undefined || lon === undefined || !isPointInBbox(lon, lat, query.bbox)) {
    return undefined;
  }

  const observedAt = parseCtuStationaryObservedAt(record) ?? fetchedAt;
  const rsrpAvg = optionalNumber(record.rsrp_avg);
  const sinrAvg = optionalNumber(record.sinr_avg);
  const downloadMbps = kbpsToMbps(optionalNumber(record.dl_speed_avg));
  const measurementId = stableToken(`${item.operator}:${item.technology}:${record.date}:${record.time_start}:${record.cell_id}:${record.pci}:${lon}:${lat}`);

  return makePointFeature({
    id: `mobile:ctu_stationary:${item.technology.toLowerCase()}:${stableToken(item.operator)}:${measurementId}`,
    lon,
    lat,
    layer: "mobile",
    category: "network_stationary_measurement",
    label: `ČTÚ ${item.technology} ${item.operator} stationary signal`,
    sourceId: "ctu_stationary_mobile",
    license: CTU_STATIONARY_MOBILE_LICENSE,
    observedAt,
    confidence: ctuStationaryMobileConfidence(rsrpAvg, downloadMbps),
    severity: mobileNetworkSeverity(downloadMbps, undefined, undefined, rsrpAvg, false),
    metrics: compactMixedMetrics({
      frequencyMhz: optionalNumber(record.freq),
      frequencyBandMhz: optionalNumber(record.freq_band),
      bandwidthMhz: optionalNumber(record.band_width),
      lteRsrpDbm: rsrpAvg,
      lteRsrpMinDbm: optionalNumber(record.rsrp_min),
      lteRsrpMaxDbm: optionalNumber(record.rsrp_max),
      sinrDb: sinrAvg,
      sinrMinDb: optionalNumber(record.sinr_min),
      sinrMaxDb: optionalNumber(record.sinr_max),
      downloadMbps,
      downloadMinMbps: kbpsToMbps(optionalNumber(record.dl_speed_min)),
      downloadP50Mbps: kbpsToMbps(optionalNumber(record.dl_speed_p50)),
      downloadMaxMbps: kbpsToMbps(optionalNumber(record.dl_speed_max)),
      cellId: optionalString(record.cell_id),
      pci: optionalNumber(record.pci),
      earfcn: optionalNumber(record.earfcn)
    }),
    tags: compactTags({
      operator: item.operator,
      technology: item.technology,
      location: optionalString(record.location),
      sourceKind: "official_stationary_measurement",
      measurementAge: "historical",
      btsStatus: "not_operator_status",
      datasetUrl: item.datasetUrl
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
    ctuNettestCount: measurements.filter((feature) => feature.properties.sourceId === "ctu_nettest").length,
    ctuStationaryCount: measurements.filter((feature) => feature.properties.sourceId === "ctu_stationary_mobile").length,
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
  if (measurementCount >= 3 && qualityRank(measurementQualityValue) > qualityRank(coverageQuality)) {
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
  if (coverage.properties.readModel === true) {
    basis.unshift("PRECOMPUTED_COVERAGE_READ_MODEL");
  }
  if (coverage.properties.metrics?.distanceToNearestTowerM !== undefined) {
    basis.splice(1, 0, "OSM_INFRASTRUCTURE_HINT");
  }
  if (stats.ctuNettestCount > 0) {
    basis.splice(0, 0, "CTU_NETTEST_MEASUREMENT");
  }
  if (stats.ctuStationaryCount > 0) {
    basis.splice(0, 0, "CTU_STATIONARY_SIGNAL_MEASUREMENT");
  }
  return basis;
}

function mobileNetworkFallbackBasis(stats: MeasurementStats): string[] {
  const basis = ["NO_OPERATOR_BTS_STATUS"];
  if (stats.ctuStationaryCount > 0) {
    basis.unshift("CTU_STATIONARY_SIGNAL_MEASUREMENT");
  }
  if (stats.ctuNettestCount > 0) {
    basis.unshift("CTU_NETTEST_MEASUREMENT");
  }
  return basis.length > 1 ? basis : ["UNKNOWN", "NO_OPERATOR_BTS_STATUS"];
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
      ? ` Závěr je zpřesněn veřejnými měřeními ČTÚ (${stats.ctuNettestCount} NetTest, ${stats.ctuStationaryCount} stacionární)${
          stats.medianDownloadMbps ? `, medián downloadu ${stats.medianDownloadMbps} Mb/s` : ""
        }.`
      : " V oblasti nejsou v cache dostupná veřejná měření ČTÚ.";
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
  const coordinates = featureCoordinates(feature.geometry);
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

function featureCoordinates(geometry: SituationFeature["geometry"]): Array<[number, number]> {
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "LineString":
      return geometry.coordinates;
    case "Polygon":
      return geometry.coordinates.flat();
    case "MultiPolygon":
      return geometry.coordinates.flat(2);
  }
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
  const speedMps = optionalNumber(position?.speed);
  const headingDeg = optionalNumber(position?.bearing);
  const occupancyPercent = optionalNumber(vehicle?.occupancyPercentage);
  const occupancyStatus = pidOccupancyStatus(vehicle?.occupancyStatus);
  const tripId = optionalString(vehicle?.trip?.tripId);

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
      speedMps,
      headingDeg,
      odometerM: optionalNumber(position?.odometer),
      currentStopSequence: optionalNumber(vehicle?.currentStopSequence),
      occupancyPercent,
      routeTypeCode: mode.routeTypeCode
    }),
    tags: compactTags({
      vehicleId: optionalString(vehicleId),
      vehicleLabel: optionalString(vehicle?.vehicle?.label),
      tripId,
      routeId: optionalString(vehicle?.trip?.routeId),
      route: optionalString(routeLabel),
      startDate: optionalString(vehicle?.trip?.startDate),
      startTime: optionalString(vehicle?.trip?.startTime),
      stopId: optionalString(vehicle?.stopId),
      currentStatus: pidVehicleStopStatus(vehicle?.currentStatus),
      congestionLevel: pidCongestionLevel(vehicle?.congestionLevel),
      occupancyStatus,
      transportMode: mode.tag
    }),
    transportMode: mode.tag,
    routeShortName: routeLabel,
    vehicleId: optionalString(vehicleId),
    tripId,
    occupancyStatus,
    occupancyPercent,
    headingDeg,
    speedMps,
    operator: "PID",
    raw: query.includeRaw ? entity : undefined
  });
}

function mapIdsjmkVehiclePosition(record: IdsjmkVehicleRecord, query: SituationQuery, sourceObservedAt: string): SituationFeature | undefined {
  const position = idsjmkVehicleLonLat(record);
  if (!position || !isPointInBbox(position.lon, position.lat, query.bbox)) {
    return undefined;
  }

  const observedAt =
    parseTimestamp(recordValue(record, ["lastUpdate", "LastUpdate", "last_update", "timestamp", "Timestamp", "time", "Time", "updatedAt", "UpdatedAt"])) ??
    sourceObservedAt;
  const vehicleId =
    stringFromRecord(record, ["vehicleId", "VehicleId", "vehicle_id", "id", "Id", "ID", "objectId", "OBJECTID", "vehicle", "Vehicle"]) ??
    stableToken(`${position.lon}:${position.lat}:${observedAt}`);
  const line = stringFromRecord(record, ["line", "Line", "lineName", "LineName", "lineNumber", "LineNumber", "route", "Route", "routeId", "RouteId"]);
  const tripId = stringFromRecord(record, ["tripId", "TripId", "trip_id", "course", "Course"]);
  const mode = idsjmkVehicleMode(record);
  const speedMps = numberFromRecord(record, ["speed", "Speed", "speedMps", "SpeedMps", "velocity", "Velocity"]);
  const headingDeg = numberFromRecord(record, ["bearing", "Bearing", "heading", "Heading", "course", "Course", "azimuth", "Azimuth"]);
  const delaySeconds = numberFromRecord(record, ["delay", "Delay", "delaySeconds", "DelaySeconds"]);
  const destination = stringFromRecord(record, ["destination", "Destination", "headsign", "Headsign", "tripHeadsign", "TripHeadsign"]);
  const operator = stringFromRecord(record, ["operator", "Operator", "agency", "Agency"]) ?? "IDS JMK";

  return makePointFeature({
    id: `traffic:idsjmk_vehicle_positions:${stableToken(vehicleId)}`,
    lon: position.lon,
    lat: position.lat,
    layer: "traffic",
    category: mode.category,
    label: line ? `IDS JMK ${mode.label} ${line}` : `IDS JMK ${mode.label}`,
    sourceId: "idsjmk_vehicle_positions",
    license: IDSJMK_VEHICLE_POSITIONS_LICENSE,
    observedAt,
    validUntil: addSeconds(observedAt, 120),
    confidence: pidPositionConfidence(observedAt),
    severity: "info",
    metrics: compactMetrics({
      speedMps,
      headingDeg,
      delaySeconds
    }),
    tags: compactTags({
      vehicleId,
      line,
      routeId: stringFromRecord(record, ["routeId", "RouteId", "route_id"]),
      tripId,
      operator,
      transportMode: mode.tag,
      sourceSystem: "idsjmk"
    }),
    transportMode: mode.tag,
    routeShortName: line,
    destination,
    delaySeconds,
    vehicleId,
    tripId,
    operator,
    headingDeg,
    speedMps,
    raw: query.includeRaw ? record : undefined
  });
}

function mapRoadSrtiLodFeature(event: RoadSrtiLodEvent, query: SituationQuery, fetchedAt: string): SituationFeature | undefined {
  if (!isPointInBbox(event.lon, event.lat, query.bbox)) {
    return undefined;
  }
  const category = roadSrtiCategory(event.typeLabel);
  const observedAt = event.observedAt || fetchedAt;
  const label = roadSrtiLabel(event.typeLabel);

  return makePointFeature({
    id: `traffic:road_srti_lod:${stableToken(event.iri)}`,
    lon: event.lon,
    lat: event.lat,
    layer: "traffic",
    category,
    label: `Silniční událost: ${label}`,
    sourceId: "road_srti_lod",
    license: ROAD_SRTI_LOD_LICENSE,
    observedAt,
    validUntil: addSeconds(observedAt, 2 * 60 * 60),
    confidence: 0.82,
    severity: roadSrtiSeverity(category, event.typeLabel),
    metrics: compactMetrics({
      ageSeconds: Math.max(0, Math.round((Date.now() - Date.parse(observedAt)) / 1000))
    }),
    tags: compactTags({
      situationRecord: event.iri,
      srtiType: event.typeLabel,
      srtiTypeUri: event.typeUri,
      sourceSystem: "ndic_srti_lod"
    }),
    transportMode: "road",
    operator: "NDIC/ŘSD",
    raw: query.includeRaw ? event.raw ?? event : undefined
  });
}

function chmiAirQualityMeasurementRegistry(metadata: ChmiAirQualityMetadata): Map<string, ChmiAirQualityMeasurementRef> {
  const registry = new Map<string, ChmiAirQualityMeasurementRef>();
  for (const locality of metadata.data?.Localities ?? []) {
    for (const program of locality.MeasuringPrograms ?? []) {
      for (const measurement of program.Measurements ?? []) {
        const id = measurement.IdRegistration;
        if (id !== undefined && id !== null) {
          registry.set(String(id), { locality, measurement });
        }
      }
    }
  }
  return registry;
}

function aggregateChmiAirQuality(
  records: Array<Record<string, string>>,
  registry: Map<string, ChmiAirQualityMeasurementRef>
): Map<string, ChmiAirQualityAggregate> {
  const aggregates = new Map<string, ChmiAirQualityAggregate>();
  const allowedValueTypes = new Set(["8", "9", "10", "11", "148"]);
  for (const record of records) {
    const id = record.idRegistration?.trim();
    const ref = id ? registry.get(id) : undefined;
    const value = optionalNumber(record.value);
    if (!ref || value === undefined) {
      continue;
    }
    const valueType = record.idValueType?.trim();
    if (valueType && !allowedValueTypes.has(valueType)) {
      continue;
    }
    const position = chmiLocalityLonLat(ref.locality);
    if (!position) {
      continue;
    }
    const localityCode = ref.locality.LocalityCode ?? stableToken(ref.locality.Name ?? `${position.lon}:${position.lat}`);
    const aggregate =
      aggregates.get(localityCode) ??
      ({
        locality: ref.locality,
        observedAt: undefined,
        values: {},
        components: {},
        units: {},
        valueTypes: new Set<string>(),
        measurementCount: 0,
        rawRows: []
      } satisfies ChmiAirQualityAggregate);
    const observedAt = parseTimestamp(record.startTime) ?? aggregate.observedAt;
    if (observedAt && (!aggregate.observedAt || Date.parse(observedAt) >= Date.parse(aggregate.observedAt))) {
      aggregate.observedAt = observedAt;
    }
    const componentCode = normalizeChmiComponentCode(ref.measurement.ComponentCode);
    if (componentCode === "INDX" || valueType === "148") {
      aggregate.airQualityIndex = value;
    } else {
      const metricName = airQualityMetricName(componentCode);
      if (metricName) {
        aggregate.values[metricName] = round(value, 2);
        aggregate.components[metricName] = componentCode;
        aggregate.units[metricName] = ref.measurement.UnitAsASCII ?? ref.measurement.UnitAsUNICODE ?? "";
      }
    }
    if (valueType) {
      aggregate.valueTypes.add(valueType);
    }
    aggregate.measurementCount += 1;
    if (aggregate.rawRows.length < 24) {
      aggregate.rawRows.push(record);
    }
    aggregates.set(localityCode, aggregate);
  }
  return aggregates;
}

function mapChmiAirQualityFeature(aggregate: ChmiAirQualityAggregate, query: SituationQuery, fetchedAt: string): SituationFeature | undefined {
  const position = chmiLocalityLonLat(aggregate.locality);
  if (!position || !isPointInBbox(position.lon, position.lat, query.bbox)) {
    return undefined;
  }
  const localityCode = aggregate.locality.LocalityCode ?? stableToken(aggregate.locality.Name ?? `${position.lon}:${position.lat}`);
  const observedAt = aggregate.observedAt ?? fetchedAt;
  const severity = maxSeverity([airQualityIndexSeverity(aggregate.airQualityIndex), pollutantSeverity(aggregate.values)]);
  const dominant = dominantAirPollutant(aggregate.values);
  const level = airQualityLevel(aggregate.airQualityIndex);
  const localityName = aggregate.locality.Name ?? aggregate.locality.BasicInfo?.LocalityName ?? "CHMI air quality station";

  return makePointFeature({
    id: `air_quality:chmi_air_quality:${stableToken(localityCode)}`,
    lon: position.lon,
    lat: position.lat,
    layer: "air_quality",
    category: "air_quality_observation",
    label: localityName,
    sourceId: "chmi_air_quality",
    license: CHMI_OPEN_DATA_LICENSE,
    observedAt,
    validUntil: addSeconds(observedAt, CHMI_AIR_QUALITY_VALIDITY_SECONDS),
    confidence: aggregate.airQualityIndex !== undefined ? 0.9 : 0.82,
    severity,
    metrics: compactMixedMetrics({
      airQualityIndex: aggregate.airQualityIndex,
      measurementCount: aggregate.measurementCount,
      ...aggregate.values
    }),
    tags: compactTags({
      stationCode: localityCode,
      region: optionalString(aggregate.locality.BasicInfo?.Region),
      district: optionalString(aggregate.locality.BasicInfo?.District),
      municipality: optionalString(aggregate.locality.BasicInfo?.BasicAdministrativeUnit),
      airQualityLevel: level,
      dominantPollutant: dominant,
      valueTypes: Array.from(aggregate.valueTypes).sort().join(",")
    }),
    raw: query.includeRaw
      ? {
          locality: aggregate.locality,
          components: aggregate.components,
          units: aggregate.units,
          rows: aggregate.rawRows
        }
      : undefined
  });
}

function chmiWeatherStationsFromMetadata(payload: ChmiDataCollectionPayload): ChmiWeatherStation[] {
  const collection = chmiCollectionData(payload);
  const values = collection?.values ?? [];
  const headers = splitDataCollectionHeader(collection?.header);
  const stationIndex = headers.indexOf("WSI");
  const ghIndex = headers.indexOf("GH_ID");
  const nameIndex = headers.indexOf("FULL_NAME");
  const lonIndex = headers.indexOf("GEOGR1");
  const latIndex = headers.indexOf("GEOGR2");
  const elevationIndex = headers.indexOf("ELEVATION");
  const beginDateIndex = headers.indexOf("BEGIN_DATE");

  return values
    .map((row): ChmiWeatherStation | undefined => {
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
        elevationM: numberCell(row, elevationIndex),
        beginDate: parseTimestamp(stringCell(row, beginDateIndex))
      };
    })
    .filter((station): station is ChmiWeatherStation => Boolean(station));
}

function mapChmiWeatherStationFeature(
  station: ChmiWeatherStation,
  payload: ChmiDataCollectionPayload,
  query: SituationQuery,
  fetchedAt: string
): SituationFeature | undefined {
  const observations = chmiWeatherObservations(payload);
  if (observations.size === 0) {
    return undefined;
  }
  const observedAt = latestObservationTime(observations) ?? fetchedAt;
  const windSpeedMps = observations.get("F")?.value;
  const windGustMps = observations.get("Fmax")?.value;
  const precipitation10mMm = observations.get("SRA10M")?.value;
  const severity = weatherSeverity(windGustMps ?? windSpeedMps, precipitation10mMm, undefined);
  const qualityValues = Array.from(observations.values()).map((observation) => observation.quality).filter(isFiniteNumber);
  const qualityCode = qualityValues.length > 0 ? Math.max(...qualityValues) : undefined;

  return makePointFeature({
    id: `weather:chmi_weather_stations:${stableToken(station.stationId)}`,
    lon: station.lon,
    lat: station.lat,
    layer: "weather",
    category: "weather_station_observation",
    label: station.name,
    sourceId: "chmi_weather_stations",
    license: CHMI_OPEN_DATA_LICENSE,
    observedAt,
    validUntil: addSeconds(observedAt, 2 * 60 * 60),
    confidence: chmiWeatherConfidence(observedAt, qualityCode),
    severity,
    metrics: compactMixedMetrics({
      temperatureC: observations.get("T")?.value,
      temperatureMaxC: observations.get("TMA")?.value,
      temperatureMinC: observations.get("TMI")?.value,
      grassTemperatureC: observations.get("TPM")?.value,
      relativeHumidityPercent: observations.get("H")?.value,
      pressureHpa: observations.get("P")?.value,
      windDirectionDeg: observations.get("D")?.value,
      windSpeedMps,
      windGustMps,
      precipitation10mMm,
      sunshineDurationSeconds: observations.get("SSV10M")?.value,
      elevationM: station.elevationM,
      qualityCode
    }),
    tags: compactTags({
      stationId: station.stationId,
      ghId: station.ghId,
      sourceSystem: "chmi_meteorology_climate_now",
      hasWind: windSpeedMps !== undefined ? "true" : undefined,
      hasPrecipitation: precipitation10mMm !== undefined ? "true" : undefined
    }),
    raw: query.includeRaw
      ? {
          station,
          observations: Object.fromEntries(observations)
        }
      : undefined
  });
}

function mapChmiWeatherGridFeature(
  layer: SituationLayerId,
  station: ChmiWeatherStation,
  stationFeature: SituationFeature,
  resolutionDegrees: number
): SituationFeature[] {
  const metrics = stationFeature.properties.metrics ?? {};
  const observedAt = stationFeature.properties.observedAt;
  const validUntil = stationFeature.properties.validUntil;
  const confidence = Math.max(0, stationFeature.properties.confidence - 0.08);
  const resolution = normalizeGridResolutionDegrees(resolutionDegrees);
  const base = {
    station,
    observedAt,
    validUntil,
    confidence,
    resolutionDegrees: resolution,
    resolutionM: approximateGridResolutionM(resolution),
    sourceRevision: observedAt
  };

  switch (layer) {
    case "weather_temperature_grid": {
      const value = numberMetric(metrics, "temperatureC");
      if (value === undefined) {
        return [];
      }
      return [
        makeStationBackedGridFeature({
          ...base,
          idPrefix: "weather_temperature_grid",
          layer,
          category: "weather_temperature_cell",
          label: `${station.name} temperature`,
          valueMetric: "temperatureC",
          value,
          unit: "°C",
          severity: temperatureSeverity(value),
          styleHint: "weather-temperature-grid-v1"
        })
      ];
    }
    case "weather_precipitation_grid": {
      const value = numberMetric(metrics, "precipitation10mMm");
      if (value === undefined) {
        return [];
      }
      return [
        makeStationBackedGridFeature({
          ...base,
          idPrefix: "weather_precipitation_grid",
          layer,
          category: "weather_precipitation_cell",
          label: `${station.name} precipitation`,
          valueMetric: "precipitation10mMm",
          value,
          unit: "mm/10min",
          severity: weatherSeverity(undefined, value, undefined),
          styleHint: "weather-precipitation-grid-v1"
        })
      ];
    }
    case "weather_humidity_grid": {
      const value = numberMetric(metrics, "relativeHumidityPercent");
      if (value === undefined) {
        return [];
      }
      return [
        makeStationBackedGridFeature({
          ...base,
          idPrefix: "weather_humidity_grid",
          layer,
          category: "weather_humidity_cell",
          label: `${station.name} humidity`,
          valueMetric: "relativeHumidityPercent",
          value,
          unit: "%",
          severity: "info",
          styleHint: "weather-humidity-grid-v1"
        })
      ];
    }
    case "weather_pressure_grid": {
      const value = numberMetric(metrics, "pressureHpa");
      if (value === undefined) {
        return [];
      }
      return [
        makeStationBackedGridFeature({
          ...base,
          idPrefix: "weather_pressure_grid",
          layer,
          category: "weather_pressure_cell",
          label: `${station.name} pressure`,
          valueMetric: "pressureHpa",
          value,
          unit: "hPa",
          severity: pressureSeverity(value),
          styleHint: "weather-pressure-grid-v1"
        })
      ];
    }
    case "weather_wind_field":
      return mapChmiWeatherWindFeature(station, stationFeature, resolution);
    default:
      return [];
  }
}

function mapChmiWeatherWindFeature(station: ChmiWeatherStation, stationFeature: SituationFeature, resolutionDegrees: number): SituationFeature[] {
  const metrics = stationFeature.properties.metrics ?? {};
  const windSpeedMps = numberMetric(metrics, "windSpeedMps");
  const windGustMps = numberMetric(metrics, "windGustMps");
  const windDirectionDeg = numberMetric(metrics, "windDirectionDeg");
  if (windSpeedMps === undefined) {
    return [];
  }
  const severity = weatherSeverity(windGustMps ?? windSpeedMps, undefined, undefined);
  const sourceRevision = stationFeature.properties.observedAt;
  const id = `weather_wind_field:chmi_weather_stations:${stableGridCellToken(station.lon, station.lat, resolutionDegrees)}`;
  const properties = {
    featureId: id,
    layer: "weather_wind_field" as const,
    category: "weather_wind_vector",
    label: `${station.name} wind`,
    sourceId: "chmi_weather_stations" as const,
    source: "chmi_weather_stations",
    sourceName: "ČHMÚ measured meteorological station",
    observedAt: stationFeature.properties.observedAt,
    validUntil: stationFeature.properties.validUntil,
    confidence: round(Math.max(0, stationFeature.properties.confidence - 0.08), 2),
    stale: false,
    severity,
    license: {
      name: CHMI_OPEN_DATA_LICENSE.name,
      attribution: CHMI_OPEN_DATA_LICENSE.attribution,
      url: CHMI_OPEN_DATA_LICENSE.url
    },
    metrics: compactMixedMetrics({
      value: windSpeedMps,
      windSpeedMps,
      windGustMps,
      windDirectionDeg,
      resolutionDegrees,
      resolutionM: approximateGridResolutionM(resolutionDegrees)
    }),
    tags: compactTags({
      stationId: station.stationId,
      ghId: station.ghId,
      sourceSystem: "chmi_meteorology_climate_now",
      unit: "m/s"
    }),
    basis: ["chmi_measured_station", "station_backed_vector_field"],
    styleHint: "weather-wind-field-v1",
    sourceRevision,
    readModel: true,
    generatedAt: new Date().toISOString(),
    resolutionM: approximateGridResolutionM(resolutionDegrees),
    providerProperties: compactProviderProperties({
      upstreamFeatureId: stationFeature.id,
      upstreamStationId: station.stationId,
      upstreamStationName: station.name,
      gridResolutionDegrees: resolutionDegrees
    })
  };

  if (windDirectionDeg === undefined) {
    return [
      {
        type: "Feature",
        id,
        geometry: { type: "Point", coordinates: [round(station.lon, 6), round(station.lat, 6)] },
        properties
      }
    ];
  }

  const end = windVectorEndpoint(station.lon, station.lat, windDirectionDeg, windSpeedMps, resolutionDegrees);
  return [
    {
      type: "Feature",
      id,
      geometry: {
        type: "LineString",
        coordinates: [
          [round(station.lon, 6), round(station.lat, 6)],
          [round(end.lon, 6), round(end.lat, 6)]
        ]
      },
      properties
    }
  ];
}

function mapChmiAirQualityGridFeature(
  aggregate: ChmiAirQualityAggregate,
  query: SituationQuery,
  fetchedAt: string,
  resolutionDegrees: number
): SituationFeature | undefined {
  const position = chmiLocalityLonLat(aggregate.locality);
  if (!position || !isPointInBbox(position.lon, position.lat, query.bbox)) {
    return undefined;
  }
  const observedAt = aggregate.observedAt ?? fetchedAt;
  const dominant = dominantAirPollutant(aggregate.values);
  const value = aggregate.airQualityIndex ?? (dominant ? aggregate.values[dominant] : undefined);
  if (value === undefined) {
    return undefined;
  }
  const localityCode = aggregate.locality.LocalityCode ?? stableToken(aggregate.locality.Name ?? `${position.lon}:${position.lat}`);
  const localityName = aggregate.locality.Name ?? aggregate.locality.BasicInfo?.LocalityName ?? "CHMI air quality station";
  const severity = maxSeverity([airQualityIndexSeverity(aggregate.airQualityIndex), pollutantSeverity(aggregate.values)]);
  return makeStationBackedGridFeature({
    idPrefix: "air_quality_grid",
    layer: "air_quality_grid",
    category: "air_quality_cell",
    label: `${localityName} air quality`,
    station: {
      stationId: localityCode,
      name: localityName,
      lon: position.lon,
      lat: position.lat
    },
    observedAt,
    validUntil: addSeconds(observedAt, CHMI_AIR_QUALITY_VALIDITY_SECONDS),
    confidence: aggregate.airQualityIndex !== undefined ? 0.82 : 0.74,
    resolutionDegrees: normalizeGridResolutionDegrees(resolutionDegrees),
    resolutionM: approximateGridResolutionM(normalizeGridResolutionDegrees(resolutionDegrees)),
    sourceRevision: observedAt,
    valueMetric: aggregate.airQualityIndex !== undefined ? "airQualityIndex" : dominant ?? "pollutantValue",
    value,
    unit: aggregate.airQualityIndex !== undefined ? "AQI" : undefined,
    severity,
    styleHint: "air-quality-grid-v1",
    sourceId: "chmi_air_quality",
    sourceName: "ČHMÚ measured air-quality station",
    extraMetrics: {
      airQualityIndex: aggregate.airQualityIndex,
      dominantPollutant: dominant,
      ...(aggregate.values ?? {})
    },
    tags: compactTags({
      stationCode: localityCode,
      region: optionalString(aggregate.locality.BasicInfo?.Region),
      district: optionalString(aggregate.locality.BasicInfo?.District),
      airQualityLevel: airQualityLevel(aggregate.airQualityIndex),
      dominantPollutant: dominant
    }),
    providerProperties: compactProviderProperties({
      upstreamStationId: localityCode,
      upstreamStationName: localityName,
      components: aggregate.components
    })
  });
}

interface StationBackedGridFeatureInput {
  idPrefix: string;
  layer: SituationLayerId;
  category: string;
  label: string;
  station: Pick<ChmiWeatherStation, "stationId" | "ghId" | "name" | "lon" | "lat">;
  observedAt: string;
  validUntil?: string;
  confidence: number;
  resolutionDegrees: number;
  resolutionM: number;
  sourceRevision: string;
  valueMetric: string;
  value: number;
  unit?: string;
  severity: SituationSeverity;
  styleHint: string;
  sourceId?: SituationDataSourceId;
  sourceName?: string;
  extraMetrics?: Record<string, number | string | boolean | undefined>;
  tags?: Record<string, string> | undefined;
  providerProperties?: Record<string, unknown> | undefined;
}

function makeStationBackedGridFeature(input: StationBackedGridFeatureInput): SituationFeature {
  const cell = stableGridCell(input.station.lon, input.station.lat, input.resolutionDegrees);
  const id = `${input.idPrefix}:${input.sourceId ?? "chmi_weather_stations"}:${cell.token}`;
  const sourceId = input.sourceId ?? "chmi_weather_stations";
  const ring: Array<[number, number]> = [
    [cell.west, cell.south],
    [cell.east, cell.south],
    [cell.east, cell.north],
    [cell.west, cell.north],
    [cell.west, cell.south]
  ];
  return {
    type: "Feature",
    id,
    geometry: {
      type: "Polygon",
      coordinates: [ring.map(([lon, lat]) => [round(lon, 6), round(lat, 6)] as [number, number])]
    },
    properties: {
      featureId: id,
      layer: input.layer,
      category: input.category,
      label: input.label,
      sourceId,
      source: sourceId,
      sourceName: input.sourceName ?? "ČHMÚ measured meteorological station",
      observedAt: input.observedAt,
      validUntil: input.validUntil,
      confidence: round(Math.max(0, Math.min(1, input.confidence)), 2),
      stale: false,
      severity: input.severity,
      license: {
        name: CHMI_OPEN_DATA_LICENSE.name,
        attribution: CHMI_OPEN_DATA_LICENSE.attribution,
        url: CHMI_OPEN_DATA_LICENSE.url
      },
      metrics: compactMixedMetrics({
        value: input.value,
        [input.valueMetric]: input.value,
        unit: input.unit,
        resolutionDegrees: input.resolutionDegrees,
        resolutionM: input.resolutionM,
        ...input.extraMetrics
      }),
      tags: {
        ...(input.tags ?? {}),
        ...compactTags({
          stationId: input.station.stationId,
          ghId: input.station.ghId,
          sourceSystem: sourceId === "chmi_air_quality" ? "chmi_air_quality_now" : "chmi_meteorology_climate_now"
        })
      },
      basis: ["chmi_measured_station", "station_backed_grid_cell"],
      styleHint: input.styleHint,
      sourceRevision: input.sourceRevision,
      readModel: true,
      generatedAt: new Date().toISOString(),
      resolutionM: input.resolutionM,
      providerProperties: compactProviderProperties({
        upstreamStationId: input.station.stationId,
        upstreamStationName: input.station.name,
        gridResolutionDegrees: input.resolutionDegrees,
        ...input.providerProperties
      })
    }
  };
}

function chmiWeatherObservations(payload: ChmiDataCollectionPayload): Map<string, ChmiStationObservation> {
  const collection = chmiCollectionData(payload);
  const values = collection?.values ?? [];
  const headers = splitDataCollectionHeader(collection?.header);
  const elementIndex = headers.indexOf("ELEMENT");
  const dtIndex = headers.indexOf("DT");
  const valueIndex = headers.indexOf("VAL");
  const qualityIndex = headers.indexOf("QUALITY");
  const selectedElements = new Set(["T", "TMA", "TMI", "TPM", "H", "P", "D", "F", "Fmax", "SRA10M", "SSV10M"]);
  const observations = new Map<string, ChmiStationObservation>();

  for (const row of values) {
    const element = stringCell(row, elementIndex);
    if (!element || !selectedElements.has(element)) {
      continue;
    }
    const value = numberCell(row, valueIndex);
    const observedAt = parseTimestamp(stringCell(row, dtIndex));
    if (value === undefined || !observedAt) {
      continue;
    }
    const existing = observations.get(element);
    if (existing && Date.parse(existing.observedAt) > Date.parse(observedAt)) {
      continue;
    }
    observations.set(element, {
      value: round(value, 2),
      observedAt,
      quality: numberCell(row, qualityIndex)
    });
  }
  return observations;
}

function chmiWeatherStationFileMap(indexHtml: string): Map<string, ChmiWeatherFileRef> {
  const files = new Map<string, ChmiWeatherFileRef>();
  for (const href of hrefsFromHtmlIndex(indexHtml)) {
    const fileName = href.split("/").pop() ?? href;
    const match = /^10m-(.+)-(\d{8})\.json$/.exec(fileName);
    const stationId = match?.[1];
    const dateToken = match?.[2];
    if (!stationId || !dateToken) {
      continue;
    }
    const existing = files.get(stationId);
    if (!existing || dateToken > existing.dateToken) {
      files.set(stationId, { href, dateToken });
    }
  }
  return files;
}

function latestChmiWeatherDataDate(indexHtml: string): string | undefined {
  return Array.from(chmiWeatherStationFileMap(indexHtml).values())
    .map((file) => file.dateToken)
    .sort()
    .pop();
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

function chmiCollectionData(payload: ChmiDataCollectionPayload): { header?: string; values?: unknown[][] } | undefined {
  return payload.data?.data;
}

function splitDataCollectionHeader(header: string | undefined): string[] {
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

function chmiLocalityLonLat(locality: ChmiAirQualityLocality): { lon: number; lat: number } | undefined {
  const lon = optionalNumber(locality.Localization?.LonAsNumber);
  const lat = optionalNumber(locality.Localization?.LatAsNumber);
  return lon !== undefined && lat !== undefined ? { lon, lat } : undefined;
}

function normalizeChmiComponentCode(value: string | undefined): string {
  return value?.trim().toUpperCase().replace(/\./g, "_") ?? "";
}

function airQualityMetricName(componentCode: string): string | undefined {
  const metricByComponent: Record<string, string> = {
    PM10: "pm10UgM3",
    PM2_5: "pm25UgM3",
    NO2: "no2UgM3",
    NOX: "noxUgM3",
    O3: "o3UgM3",
    SO2: "so2UgM3",
    CO: "coUgM3"
  };
  return metricByComponent[componentCode];
}

function airQualityIndexSeverity(value: number | undefined): SituationSeverity {
  if (value === undefined) {
    return "info";
  }
  if (value >= 6) {
    return "critical";
  }
  if (value >= 5) {
    return "warning";
  }
  if (value >= 3) {
    return "advisory";
  }
  return "info";
}

function airQualityLevel(value: number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value >= 6) {
    return "very_bad";
  }
  if (value >= 5) {
    return "bad";
  }
  if (value >= 3) {
    return "acceptable";
  }
  if (value >= 1) {
    return "good";
  }
  return "incomplete";
}

function pollutantSeverity(values: Record<string, number>): SituationSeverity {
  const severityByMetric = Object.entries(values).map(([metric, value]) => {
    switch (metric) {
      case "pm10UgM3":
        return thresholdSeverity(value, 25, 50, 100);
      case "pm25UgM3":
        return thresholdSeverity(value, 15, 25, 50);
      case "no2UgM3":
        return thresholdSeverity(value, 50, 100, 200);
      case "o3UgM3":
        return thresholdSeverity(value, 80, 120, 180);
      case "so2UgM3":
        return thresholdSeverity(value, 50, 125, 350);
      case "coUgM3":
        return thresholdSeverity(value, 3000, 7000, 10000);
      default:
        return "info" satisfies SituationSeverity;
    }
  });
  return maxSeverity(severityByMetric);
}

function thresholdSeverity(value: number, advisory: number, warning: number, critical: number): SituationSeverity {
  if (value >= critical) {
    return "critical";
  }
  if (value >= warning) {
    return "warning";
  }
  if (value >= advisory) {
    return "advisory";
  }
  return "info";
}

function dominantAirPollutant(values: Record<string, number>): string | undefined {
  const warningThresholds: Record<string, number> = {
    pm10UgM3: 50,
    pm25UgM3: 25,
    no2UgM3: 100,
    noxUgM3: 200,
    o3UgM3: 120,
    so2UgM3: 125,
    coUgM3: 7000
  };
  return Object.entries(values)
    .map(([metric, value]) => ({ metric, score: value / (warningThresholds[metric] ?? Infinity) }))
    .filter((item) => Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)[0]?.metric;
}

function maxSeverity(values: SituationSeverity[]): SituationSeverity {
  return values.sort((a, b) => severityRank(b) - severityRank(a))[0] ?? "info";
}

function severityRank(value: SituationSeverity): number {
  return { info: 0, advisory: 1, warning: 2, critical: 3 }[value];
}

function latestObservationTime(observations: Map<string, ChmiStationObservation>): string | undefined {
  return Array.from(observations.values())
    .map((observation) => observation.observedAt)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

function chmiWeatherConfidence(observedAt: string, qualityCode: number | undefined): number {
  const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(observedAt)) / 1000));
  const ageFactor = ageSeconds <= 2 * 60 * 60 ? 0.9 : ageSeconds <= 12 * 60 * 60 ? 0.76 : 0.55;
  const qualityFactor = qualityCode === undefined ? 0 : Math.min(0.04, Math.max(0, qualityCode) / 100);
  return round(Math.min(0.94, ageFactor + qualityFactor), 2);
}

function latestRecordTimestamp(records: Array<Record<string, string>>, field: string): string | undefined {
  return records
    .map((record) => parseTimestamp(record[field]))
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

function dateTokenToIso(value: string): string | undefined {
  if (!/^\d{8}$/.test(value)) {
    return undefined;
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00.000Z`;
}

function joinUrl(baseUrl: string, href: string): string {
  return new URL(href, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function chmiRadarProductDefinitions(): ChmiRadarProductDefinition[] {
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

function latestChmiRadarHrefFromIndex(indexHtml: string, pattern: RegExp): string | undefined {
  return hrefsFromHtmlIndex(indexHtml)
    .map((href) => href.split("/").pop() ?? href)
    .filter((href) => pattern.test(href) && parseChmiRadarTimestampFromHref(href))
    .sort((a, b) => Date.parse(parseChmiRadarTimestampFromHref(b) ?? "") - Date.parse(parseChmiRadarTimestampFromHref(a) ?? ""))
    [0];
}

function parseChmiRadarTimestampFromHref(href: string): string | undefined {
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

function latestChmiRadarProductTimestamp(
  products: Array<{ asset?: ChmiRadarAsset; hdfAsset?: ChmiRadarAsset }>
): string | undefined {
  return products
    .flatMap((product) => [product.asset?.observedAt, product.hdfAsset?.observedAt])
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

function makeChmiRadarFeature(
  definition: ChmiRadarProductDefinition,
  asset: ChmiRadarAsset,
  hdfAsset: ChmiRadarAsset | undefined,
  fetchedAt: string,
  includeRaw: boolean
): SituationFeature {
  const id = `weather_radar:chmi_weather_radar:${definition.productId}:${stableToken(asset.href)}`;
  const observedAt = asset.observedAt;
  const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(observedAt)) / 1000));
  const validUntil = addSecondsIso(observedAt, definition.validForSeconds);
  const feature: SituationFeature = {
    type: "Feature",
    id,
    geometry: bboxPolygon(CHMI_RADAR_IMAGE_BBOX),
    properties: {
      featureId: id,
      layer: definition.layer,
      category: definition.category,
      label: definition.label,
      sourceId: "chmi_weather_radar",
      source: "chmi_weather_radar",
      sourceName: "ČHMÚ weather radar Open Data",
      observedAt,
      validUntil,
      updatedAt: fetchedAt,
      confidence: radarConfidence(definition, ageSeconds),
      stale: ageSeconds > definition.validForSeconds,
      severity: definition.severity,
      license: {
        name: CHMI_OPEN_DATA_LICENSE.name,
        attribution: CHMI_OPEN_DATA_LICENSE.attribution,
        url: CHMI_OPEN_DATA_LICENSE.url
      },
      metrics: compactMixedMetrics({
        productAgeSeconds: ageSeconds,
        updateCadenceSeconds: definition.updateCadenceSeconds,
        validitySeconds: definition.validForSeconds,
        resolutionM: 1000,
        forecastArchive: definition.forecastArchive,
        forecastHorizonMinutes: definition.forecastHorizonMinutes
      }),
      tags: compactTags({
        sourceSystem: "chmi_weather_radar",
        productId: definition.productId,
        productFormat: definition.forecastArchive ? "tar" : "png",
        projection: "EPSG:3857",
        lightningStrikeFeed: "false"
      }),
      basis: definition.basis,
      summary: definition.description,
      notices: [
        "Radar overlay metadata only; COM must render the supplied raster URL or request a future SIM tile/proxy endpoint.",
        "Raw lightning strike positions are not included."
      ],
      styleHint: definition.styleHint,
      iconHint: definition.layer === "weather_thunderstorm_risk" ? "thunderstorm" : "radar",
      sourceRevision: asset.href,
      readModel: true,
      generatedAt: fetchedAt,
      resolutionM: 1000,
      providerProperties: compactProviderProperties({
        productId: definition.productId,
        productDescription: definition.description,
        raster: {
          url: definition.forecastArchive ? undefined : asset.url,
          archiveUrl: definition.forecastArchive ? asset.url : undefined,
          contentType: definition.contentType,
          projection: "EPSG:3857",
          boundsWgs84: bboxToArray(CHMI_RADAR_IMAGE_BBOX),
          dataBoundsWgs84: bboxToArray(CHMI_RADAR_DATA_BBOX),
          opacity: definition.layer === "weather_thunderstorm_risk" ? 0.64 : 0.58,
          renderMode: definition.forecastArchive ? "archive_sequence" : "image_overlay"
        },
        hdf5: hdfAsset
          ? {
              url: hdfAsset.url,
              observedAt: hdfAsset.observedAt,
              contentType: "application/x-hdf5"
            }
          : undefined,
        colorScaleUrl: definition.legendUrl,
        cadenceSeconds: definition.updateCadenceSeconds,
        forecastHorizonMinutes: definition.forecastHorizonMinutes,
        lightningStrikeFeed: false,
        sourceLimitation: definition.layer === "weather_thunderstorm_risk" ? "No redistributable official raw lightning-strike feed is configured." : undefined
      }),
      disclaimer: "Radarová vrstva je situační kontext z ČHMÚ Open Data, ne náhrada oficiálních výstrah a pokynů krizových orgánů.",
      raw: includeRaw
        ? {
            definition,
            asset,
            hdfAsset,
            dataBbox: CHMI_RADAR_DATA_BBOX,
            imageBbox: CHMI_RADAR_IMAGE_BBOX
          }
        : undefined
    }
  };
  return stripRawIfNeeded(feature, includeRaw);
}

function radarConfidence(definition: ChmiRadarProductDefinition, ageSeconds: number): number {
  const agePenalty = ageSeconds <= definition.updateCadenceSeconds * 2 ? 0 : ageSeconds <= definition.validForSeconds ? 0.08 : 0.22;
  return round(Math.max(0.35, definition.confidence - agePenalty), 2);
}

function bboxPolygon(bbox: BoundingBox): SituationFeature["geometry"] {
  return {
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
  };
}

function bboxToArray(bbox: BoundingBox): [number, number, number, number] {
  return [bbox.west, bbox.south, bbox.east, bbox.north];
}

function bboxIntersects(a: BoundingBox, b: BoundingBox): boolean {
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
}

function addSecondsIso(value: string, seconds: number): string | undefined {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return new Date(timestamp + seconds * 1000).toISOString();
}

function distanceSquared(lonA: number, latA: number, lonB: number, latB: number): number {
  return (lonA - lonB) ** 2 + (latA - latB) ** 2;
}

interface ChmiAirQualityMetadata {
  datumVytvoreni?: string;
  verzeDat?: string;
  data?: {
    Localities?: ChmiAirQualityLocality[];
  };
}

interface ChmiAirQualityLocality {
  LocalityCode?: string;
  Name?: string;
  Localization?: {
    LatAsNumber?: number;
    LonAsNumber?: number;
    Alt?: string;
  };
  BasicInfo?: {
    LocalityName?: string;
    Region?: string;
    District?: string;
    BasicAdministrativeUnit?: string;
    State?: string;
    [key: string]: unknown;
  };
  MeasuringPrograms?: ChmiAirQualityProgram[];
}

interface ChmiAirQualityProgram {
  Code?: string;
  Type?: string;
  Measurements?: ChmiAirQualityMeasurement[];
}

interface ChmiAirQualityMeasurement {
  IdRegistration?: number | string;
  ComponentCode?: string;
  ComponentName?: string;
  UnitAsASCII?: string;
  UnitAsUNICODE?: string;
  HasRealTimeData?: string;
  IsAuthorized?: string;
}

interface ChmiAirQualityMeasurementRef {
  locality: ChmiAirQualityLocality;
  measurement: ChmiAirQualityMeasurement;
}

interface ChmiAirQualityAggregate {
  locality: ChmiAirQualityLocality;
  observedAt?: string;
  airQualityIndex?: number;
  values: Record<string, number>;
  components: Record<string, string>;
  units: Record<string, string>;
  valueTypes: Set<string>;
  measurementCount: number;
  rawRows: Array<Record<string, string>>;
}

interface ChmiDataCollectionPayload {
  data?: {
    data?: {
      header?: string;
      values?: unknown[][];
    };
  };
}

interface ChmiWeatherStation {
  stationId: string;
  ghId?: string;
  name: string;
  lon: number;
  lat: number;
  elevationM?: number;
  beginDate?: string;
}

interface ChmiWeatherFileRef {
  href: string;
  dateToken: string;
}

interface ChmiStationObservation {
  value: number;
  observedAt: string;
  quality?: number;
}

interface OpenMeteoResponse {
  current?: Record<string, unknown>;
  current_units?: Record<string, string>;
}

interface IdsjmkVehicleFeed extends Record<string, unknown> {
  LastUpdate?: unknown;
  lastUpdate?: unknown;
  Vehicles?: unknown;
  vehicles?: unknown;
  features?: Array<{
    attributes?: Record<string, unknown>;
    geometry?: Record<string, unknown>;
  }>;
}

type IdsjmkVehicleRecord = Record<string, unknown>;

interface RoadSrtiLodEvent {
  iri: string;
  typeUri: string;
  typeLabel: string;
  observedAt: string;
  wkt: string;
  lon: number;
  lat: number;
  raw?: unknown;
}

interface SparqlBindingValue {
  type?: string;
  value?: string;
  datatype?: string;
  "xml:lang"?: string;
}

interface SparqlResults {
  head?: {
    vars?: string[];
  };
  results?: {
    bindings?: Array<Record<string, SparqlBindingValue>>;
  };
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

type SafetyProjectionLayer = "warnings" | "fire" | "flood" | "boundary_admin";

interface SafetyProjectionFeature {
  type: "Feature";
  id: string;
  geometry: {
    type: "Point" | "Polygon" | "MultiPolygon";
    coordinates: unknown;
  };
  properties: {
    featureId: string;
    layerId?: string;
    providerId?: string;
    providerLayerId?: string;
    layer: SafetyProjectionLayer;
    category: string;
    hazardType?: string;
    headline: string;
    description?: string;
    recommendedAction?: string;
    sourceId: string;
    source?: string;
    sourceName?: string;
    observedAt: string;
    effectiveAt?: string;
    expiresAt?: string;
    validFrom?: string;
    validUntil?: string;
    updatedAt?: string;
    confidence: number;
    stale: boolean;
    severity: SituationSeverity;
    status?: string;
    urgency?: string;
    certainty?: string;
    areaName?: string;
    adminLevel?: number | string;
    name?: string;
    code?: string;
    countryCode?: string;
    styleHint?: string;
    iconHint?: string;
    basis?: string[];
    fireStatus?: string;
    detectedAt?: string;
    sourceSatellite?: string;
    sourceIncident?: string;
    intensity?: number;
    frp?: number;
    riverName?: string;
    stationId?: string;
    waterLevelCm?: number;
    discharge?: number;
    floodStage?: number | string;
    trend?: string;
    basin?: string;
    affectedArea?: string;
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
  const providerProperties = compactProviderProperties({
    nativeFeatureId: feature.properties.featureId,
    nativeLayerId: feature.properties.layerId,
    nativeProviderId: feature.properties.providerId,
    nativeProviderLayerId: feature.properties.providerLayerId,
    nativeSourceId: feature.properties.sourceId,
    source: feature.properties.source,
    sourceName: feature.properties.sourceName,
    headline: feature.properties.headline,
    description: feature.properties.description,
    recommendedAction: feature.properties.recommendedAction,
    hazardType: feature.properties.hazardType,
    status: feature.properties.status,
    urgency: feature.properties.urgency,
    certainty: feature.properties.certainty,
    validFrom: feature.properties.validFrom,
    validUntil: feature.properties.validUntil,
    updatedAt: feature.properties.updatedAt,
    areaName: feature.properties.areaName,
    adminLevel: feature.properties.adminLevel,
    name: feature.properties.name,
    code: feature.properties.code,
    countryCode: feature.properties.countryCode,
    styleHint: feature.properties.styleHint,
    iconHint: feature.properties.iconHint,
    basis: feature.properties.basis,
    fireStatus: feature.properties.fireStatus,
    detectedAt: feature.properties.detectedAt,
    sourceSatellite: feature.properties.sourceSatellite,
    sourceIncident: feature.properties.sourceIncident,
    intensity: feature.properties.intensity,
    frp: feature.properties.frp,
    riverName: feature.properties.riverName,
    stationId: feature.properties.stationId,
    waterLevelCm: feature.properties.waterLevelCm,
    discharge: feature.properties.discharge,
    floodStage: feature.properties.floodStage,
    trend: feature.properties.trend,
    basin: feature.properties.basin,
    affectedArea: feature.properties.affectedArea
  });
  return {
    type: "Feature",
    id,
    geometry,
    properties: {
      featureId: id,
      layerId: safetyProjectionCatalogLayerId(layer),
      providerId: "sim.situation-data",
      providerLayerId: safetyProjectionProviderLayerId(layer),
      layer,
      category: feature.properties.category,
      label: feature.properties.headline || feature.properties.name || layer,
      sourceId: "safety_data",
      observedAt: feature.properties.observedAt,
      validUntil: feature.properties.validUntil ?? feature.properties.expiresAt,
      confidence: feature.properties.confidence,
      stale: feature.properties.stale,
      severity: feature.properties.severity,
      license: feature.properties.license,
      metrics: compactMixedMetrics(feature.properties.metrics ?? {}),
      tags,
      providerProperties,
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
  if (pointOverride && geometry.type === "Point") {
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
  if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
    return geometry as SituationFeature["geometry"];
  }
  return undefined;
}

function safetyProjectionCatalogLayerId(layer: SafetyProjectionLayer): string {
  switch (layer) {
    case "fire":
      return "public.safety.fire";
    case "flood":
      return "public.safety.flood";
    case "boundary_admin":
      return "public.boundary.admin";
    case "warnings":
      return "public.safety.warnings";
  }
}

function safetyProjectionProviderLayerId(layer: SafetyProjectionLayer): string {
  switch (layer) {
    case "fire":
      return "fire.safety_data_projection";
    case "flood":
      return "flood.safety_data_projection";
    case "boundary_admin":
      return "boundary_admin.safety_data_projection";
    case "warnings":
      return "warnings.safety_data_projection";
  }
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

async function requestText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: "text/plain,text/csv,text/html,application/json,*/*",
      "user-agent": "csm-sim-situation-data/0.1"
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return response.text();
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

async function fetchCtuStationaryMobileRecords(config: SituationDataConfig): Promise<CtuStationaryMobileRecord[]> {
  const urls = config.ctuStationaryMobileUrls;
  if (urls.length === 0) {
    return [];
  }
  const settled = await Promise.allSettled(urls.map((url) => fetchCtuStationaryMobileDataset(url, config.requestTimeoutMs)));
  const records = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  if (records.length === 0) {
    const errors = settled
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => (result.reason instanceof Error ? result.reason.message : "unknown failure"));
    throw new Error(`ctu_stationary_mobile did not load any dataset${errors.length ? `: ${errors.join("; ")}` : "."}`);
  }
  return records;
}

async function fetchCtuStationaryMobileDataset(url: string, timeoutMs: number): Promise<CtuStationaryMobileRecord[]> {
  const metadata = ctuStationaryMetadataFromUrl(url);
  const archive = await requestBytes(url, timeoutMs);
  const files = unzipSync(archive);
  const csvName = Object.keys(files).find((name) => name.toLowerCase().endsWith(".csv"));
  if (!csvName) {
    throw new Error(`ctu_stationary_mobile archive did not contain a CSV file: ${url}`);
  }
  const csvFile = files[csvName];
  if (!csvFile) {
    throw new Error(`ctu_stationary_mobile CSV file was empty: ${url}`);
  }
  return parseCsvRecords(new TextDecoder().decode(csvFile)).map((record) => ({
    record,
    datasetUrl: url,
    operator: metadata.operator,
    technology: metadata.technology
  }));
}

async function fetchPidVehiclePositionFeed(config: SituationDataConfig): Promise<transit_realtime.FeedMessage> {
  const payload = await requestBytes(config.pidGtfsRtVehiclePositionsUrl, config.requestTimeoutMs, {
    accept: "application/x-protobuf,application/octet-stream"
  });
  return gtfsRealtime.transit_realtime.FeedMessage.decode(payload);
}

async function fetchIdsjmkVehicleFeed(config: SituationDataConfig): Promise<IdsjmkVehicleFeed> {
  return requestJsonWithHeaders<IdsjmkVehicleFeed>(config.idsjmkVehiclePositionsUrl, config.requestTimeoutMs, {
    accept: "application/json",
    "user-agent": "csm-sim-situation-data/0.1"
  });
}

function normalizeIdsjmkVehicles(feed: IdsjmkVehicleFeed): IdsjmkVehicleRecord[] {
  if (Array.isArray(feed)) {
    return feed.filter(isRecord);
  }
  const explicitVehicles = feed.Vehicles ?? feed.vehicles ?? feed.items ?? feed.data;
  if (Array.isArray(explicitVehicles)) {
    return explicitVehicles.filter(isRecord);
  }
  if (Array.isArray(feed.features)) {
    return feed.features.map((feature) => ({ ...(feature.attributes ?? {}), geometry: feature.geometry })).filter(isRecord);
  }
  return [];
}

async function fetchRoadSrtiLodEvents(config: SituationDataConfig): Promise<RoadSrtiLodEvent[]> {
  const limit = Math.max(100, Math.min(config.roadSrtiLodMaxRecords, 5000));
  const query = `
PREFIX dtx_srti: <http://cef.uv.es/lodroadtran18/def/transporte/dtx_srti#>
PREFIX geosparql: <http://www.opengis.net/ont/geosparql#>
SELECT DISTINCT ?SituationRecord ?Type ?VersionTime ?GeometryWKT WHERE {
  ?SituationRecord a ?Type ;
    dtx_srti:situationRecordVersionTime ?VersionTime ;
    geosparql:hasGeometry / geosparql:asWKT ?GeometryWKT .
}
ORDER BY DESC(?VersionTime)
LIMIT ${limit}
`;
  const results = await requestSparqlJson(config.roadSrtiLodSparqlUrl, query, config.requestTimeoutMs);
  return (results.results?.bindings ?? [])
    .map((binding): RoadSrtiLodEvent | undefined => {
      const iri = sparqlValue(binding, "SituationRecord");
      const typeUri = sparqlValue(binding, "Type");
      const observedAt = parseTimestamp(sparqlValue(binding, "VersionTime"));
      const wkt = sparqlValue(binding, "GeometryWKT");
      const point = wkt ? representativePointFromWkt(wkt) : undefined;
      if (!iri || !typeUri || !observedAt || !wkt || !point) {
        return undefined;
      }
      return {
        iri,
        typeUri,
        typeLabel: roadSrtiLabel(typeUri),
        observedAt,
        wkt,
        lon: point.lon,
        lat: point.lat,
        raw: binding
      };
    })
    .filter((event): event is RoadSrtiLodEvent => Boolean(event));
}

async function requestSparqlJson(baseUrl: string, query: string, timeoutMs: number): Promise<SparqlResults> {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      accept: "application/sparql-results+json,application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "csm-sim-situation-data/0.1"
    },
    body: new URLSearchParams({ query, format: "application/sparql-results+json" }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(baseUrl).hostname}`);
  }
  return (await response.json()) as SparqlResults;
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

function normalizeGridResolutionDegrees(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0.05;
  }
  return round(Math.max(0.01, Math.min(0.5, value)), 4);
}

function stableGridCell(lon: number, lat: number, resolutionDegrees: number): { west: number; south: number; east: number; north: number; token: string } {
  const resolution = normalizeGridResolutionDegrees(resolutionDegrees);
  const west = Math.floor(lon / resolution) * resolution;
  const south = Math.floor(lat / resolution) * resolution;
  const east = west + resolution;
  const north = south + resolution;
  return {
    west,
    south,
    east,
    north,
    token: `${round(west, 5)}:${round(south, 5)}:${resolution}`
  };
}

function stableGridCellToken(lon: number, lat: number, resolutionDegrees: number): string {
  return stableGridCell(lon, lat, resolutionDegrees).token;
}

function approximateGridResolutionM(resolutionDegrees: number): number {
  return Math.round(normalizeGridResolutionDegrees(resolutionDegrees) * 111_320);
}

function numberMetric(metrics: Record<string, number | string | boolean>, key: string): number | undefined {
  const value = metrics[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function temperatureSeverity(value: number): SituationSeverity {
  if (value <= -15 || value >= 35) {
    return "warning";
  }
  if (value <= -8 || value >= 30) {
    return "advisory";
  }
  return "info";
}

function pressureSeverity(value: number): SituationSeverity {
  if (value <= 985 || value >= 1040) {
    return "advisory";
  }
  return "info";
}

function windVectorEndpoint(lon: number, lat: number, windDirectionDeg: number, windSpeedMps: number, resolutionDegrees: number): { lon: number; lat: number } {
  const travelDirectionDeg = (windDirectionDeg + 180) % 360;
  const radians = (travelDirectionDeg * Math.PI) / 180;
  const length = normalizeGridResolutionDegrees(resolutionDegrees) * clamp(0.25 + windSpeedMps / 40, 0.25, 0.9);
  const latScale = Math.max(0.25, Math.cos((lat * Math.PI) / 180));
  return {
    lon: lon + (Math.sin(radians) * length) / latScale,
    lat: lat + Math.cos(radians) * length
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) {
      return record[key];
    }
  }
  return undefined;
}

function numberFromRecord(record: Record<string, unknown>, keys: string[]): number | undefined {
  return optionalNumber(recordValue(record, keys));
}

function stringFromRecord(record: Record<string, unknown>, keys: string[]): string | undefined {
  const value = recordValue(record, keys);
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value).trim() || undefined;
}

function idsjmkVehicleLonLat(record: IdsjmkVehicleRecord): { lon: number; lat: number } | undefined {
  const geometry = isRecord(record.geometry) ? record.geometry : undefined;
  const rawLon =
    numberFromRecord(record, ["lon", "lng", "longitude", "Longitude", "LON", "LNG", "GPSX", "gpsX", "x", "X"]) ??
    (geometry ? numberFromRecord(geometry, ["lon", "lng", "longitude", "Longitude", "x", "X"]) : undefined);
  const rawLat =
    numberFromRecord(record, ["lat", "latitude", "Latitude", "LAT", "GPSY", "gpsY", "y", "Y"]) ??
    (geometry ? numberFromRecord(geometry, ["lat", "latitude", "Latitude", "y", "Y"]) : undefined);
  if (rawLon === undefined || rawLat === undefined) {
    return undefined;
  }
  if (Math.abs(rawLon) <= 180 && Math.abs(rawLat) <= 90) {
    return { lon: rawLon, lat: rawLat };
  }
  return webMercatorToLonLat(rawLon, rawLat);
}

function webMercatorToLonLat(x: number, y: number): { lon: number; lat: number } | undefined {
  const max = 20_037_508.342789244;
  if (Math.abs(x) > max || Math.abs(y) > max) {
    return undefined;
  }
  const lon = (x / max) * 180;
  const lat = (180 / Math.PI) * (2 * Math.atan(Math.exp(((y / max) * 180 * Math.PI) / 180)) - Math.PI / 2);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return undefined;
  }
  return { lon, lat };
}

function idsjmkVehicleMode(record: IdsjmkVehicleRecord): { category: string; label: string; tag: string } {
  const routeType = numberFromRecord(record, ["routeType", "RouteType", "route_type", "gtfsRouteType"]);
  if (routeType !== undefined) {
    const pidMode = pidModeFromRouteType(routeType);
    return { category: pidMode.category, label: pidMode.label, tag: pidMode.tag };
  }
  const type = (stringFromRecord(record, ["vehicleType", "VehicleType", "type", "Type", "mode", "Mode", "transportMode"]) ?? "").toLowerCase();
  if (type.includes("tram") || type.includes("šalina")) {
    return { category: "public_transport_tram", label: "tram", tag: "tram" };
  }
  if (type.includes("train") || type.includes("vlak")) {
    return { category: "public_transport_train", label: "train", tag: "train" };
  }
  if (type.includes("trolley") || type.includes("trolej")) {
    return { category: "public_transport_trolleybus", label: "trolleybus", tag: "trolleybus" };
  }
  return { category: "public_transport_bus", label: "bus", tag: "bus" };
}

function sparqlValue(binding: Record<string, SparqlBindingValue>, key: string): string | undefined {
  return optionalString(binding[key]?.value);
}

function representativePointFromWkt(wkt: string): { lon: number; lat: number } | undefined {
  const coordinatePairs = Array.from(wkt.matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)(?:\s+-?\d+(?:\.\d+)?)?/g))
    .map((match) => ({ lon: Number(match[1]), lat: Number(match[2]) }))
    .filter((point) => Number.isFinite(point.lon) && Number.isFinite(point.lat));
  if (coordinatePairs.length === 0) {
    return undefined;
  }
  const sum = coordinatePairs.reduce(
    (acc, point) => ({
      lon: acc.lon + point.lon,
      lat: acc.lat + point.lat
    }),
    { lon: 0, lat: 0 }
  );
  return {
    lon: sum.lon / coordinatePairs.length,
    lat: sum.lat / coordinatePairs.length
  };
}

function roadSrtiLabel(value: string): string {
  const localName = decodeURIComponent(value.split(/[\/#]/).filter(Boolean).pop() ?? value);
  return localName
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
}

function roadSrtiCategory(typeLabel: string): string {
  const normalized = typeLabel.toLowerCase();
  if (normalized.includes("accident")) {
    return "road_accident";
  }
  if (normalized.includes("roadwork") || normalized.includes("maintenance") || normalized.includes("construction")) {
    return "roadworks";
  }
  if (normalized.includes("weather")) {
    return "road_weather";
  }
  if (normalized.includes("obstruction") || normalized.includes("closure")) {
    return "road_obstruction";
  }
  if (normalized.includes("abnormal") || normalized.includes("traffic")) {
    return "road_traffic_abnormal";
  }
  return "road_event";
}

function roadSrtiSeverity(category: string, typeLabel: string): SituationSeverity {
  const normalized = typeLabel.toLowerCase();
  if (category === "road_accident" || normalized.includes("closure") || normalized.includes("blocked")) {
    return "warning";
  }
  if (category === "road_obstruction" || category === "road_weather" || category === "road_traffic_abnormal") {
    return "advisory";
  }
  return "info";
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

function latestCtuStationaryMeasurementAt(records: CtuStationaryMobileRecord[]): string | undefined {
  return records
    .map((item) => parseCtuStationaryObservedAt(item.record))
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

function parseCtuStationaryObservedAt(record: Record<string, string>): string | undefined {
  const date = optionalString(record.date);
  if (!date) {
    return undefined;
  }
  const time = optionalString(record.time_start) ?? "00:00:00";
  return parseUtcTimestamp(`${date} ${time}`);
}

function ctuAccessTechnology(record: Record<string, string>): string {
  return optionalString(record.cat_technology) ?? optionalString(record.network_type) ?? "mobile";
}

function ctuStationaryMetadataFromUrl(url: string): Pick<CtuStationaryMobileRecord, "operator" | "technology"> {
  const normalized = url.toLowerCase();
  const technology: MobileCoverageTechnology = normalized.includes("/2g_") || normalized.includes("2g_") ? "2G" : "4G";
  const operator = normalized.includes("_tm_")
    ? "T-Mobile"
    : normalized.includes("_vf_")
      ? "Vodafone"
      : normalized.includes("_o2_")
        ? "O2"
        : "unknown";
  return { operator, technology };
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

function ctuStationaryMobileConfidence(signalDbm: number | undefined, downloadMbps: number | undefined): number {
  let confidence = 0.68;
  if (signalDbm === undefined) {
    confidence -= 0.16;
  }
  if (downloadMbps === undefined) {
    confidence -= 0.08;
  }
  return clamp(confidence, 0.35, 0.68);
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
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
