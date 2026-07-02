import { XMLParser } from "fast-xml-parser";
import { Pool } from "pg";
import { ChmiHydroHistoryStore, type ChmiHydroHistoryRecord, type ChmiHydroSourceKind } from "./chmi-hydro-history.js";
import {
  chmiAwarenessLevel,
  chmiParameterValue,
  classifyChmiAlert,
  type ChmiAlertClassification,
  type ChmiEventCode,
  type ChmiParameter
} from "./chmi-taxonomy.js";
import type { HzsIncidentFeedConfig, SafetyDataConfig } from "./config.js";
import { HttpRequestError, requestJson, requestText } from "./http.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type {
  BoundingBox,
  HydroSeriesId,
  HydroSeriesRole,
  HydroStationDetail,
  HydroStationDetailQuery,
  SafetyCertainty,
  SafetyDataLicense,
  SafetyDataSourceId,
  SafetyFeature,
  SafetyGeometry,
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
  cacheStats?(): SourceCacheStats[];
  getHydroStationDetail?(stationId: string, query: HydroStationDetailQuery): Promise<HydroStationDetail | undefined>;
}

export interface SourceCacheStats extends ManagedResponseCacheStats {
  sourceId: SafetyDataSourceId;
}

const MOCK_LICENSE: SafetyDataLicense = {
  name: "Synthetic internal test data",
  attribution: "CSM SIM",
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
    "CAP alerts can carry administrative geocodes; this API resolves CISORP areas to local/PostGIS administrative polygons when available and falls back to representative map points when polygons are not available."
  ]
};

const NASA_FIRMS_LICENSE: SafetyDataLicense = {
  name: "NASA FIRMS active fire detections",
  url: "https://firms.modaps.eosdis.nasa.gov/",
  attribution: "NASA FIRMS",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Requires a FIRMS MAP_KEY for API access.",
    "Satellite fire detections are situational context and can include false positives, delayed detections or missed fires.",
    "Operational response must use official fire and emergency services channels."
  ]
};

const GDACS_LICENSE: SafetyDataLicense = {
  name: "GDACS disaster alerts",
  url: "https://www.gdacs.org/",
  attribution: "Global Disaster Alert and Coordination System (GDACS)",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "GDACS provides near-real-time global disaster alerts with potential humanitarian impact.",
    "GDACS resources are public; EU/JRC resource entries require attribution where stated.",
    "Use as strategic/public situational context. Local operational decisions must rely on official Czech IZS and competent authority channels."
  ]
};

const HZS_INCIDENTS_LICENSE: SafetyDataLicense = {
  name: "HZS public incident dispatch feed",
  url: "https://www.hzscr.cz/",
  attribution: "Hasičský záchranný sbor České republiky",
  commercialUse: "unknown",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Public incident feed intended for situational awareness.",
    "The public feed can omit exact coordinates and operational detail; SIM marks geocoding precision explicitly.",
    "Operational response must use official IZS/HZS command channels."
  ]
};

const ROAD_SRTI_LOD_LICENSE: SafetyDataLicense = {
  name: "NDIC/ŘSD SRTI Linked Open Data",
  url: "https://lod.tamtamresearch.com/docs/",
  attribution: "Ředitelství silnic a dálnic / NDIC; LOD conversion by TamTam Research",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Safety-related road traffic information from NDIC/ŘSD transformed from DATEX II to Linked Open Data.",
    "SIM caches the SPARQL source server-side and exposes only normalized warning features to COP.",
    "Use as public traffic-safety context; operational decisions must rely on police, IZS and road authority channels."
  ]
};

const ADMIN_BOUNDARY_SEED_LICENSE: SafetyDataLicense = {
  name: "SIM seed administrative boundary reference",
  attribution: "CSM SIM",
  commercialUse: "allowed",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Built-in coarse Czechia boundary seed for contract validation.",
    "Production-grade administrative boundaries should be imported from an authoritative dataset such as RUIAN or another licensed boundary source."
  ]
};

const OSM_ADMIN_BOUNDARY_LICENSE: SafetyDataLicense = {
  name: "ODbL 1.0",
  url: "https://opendatacommons.org/licenses/odbl/1-0/",
  attribution: "OpenStreetMap contributors",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Attribution is required.",
    "Public adapted databases must follow ODbL obligations.",
    "Administrative boundaries are served from a local/PostGIS read-model, not from public Overpass."
  ]
};

export function createSafetyDataSources(config: SafetyDataConfig): SafetyDataSource[] {
  const allSources: Record<SafetyDataSourceId, SafetyDataSource> = {
    mock: new MockSafetyDataSource(),
    chmi_alerts: new ChmiAlertsSource(config),
    chmi_hydro: new ChmiHydroSource(config),
    nasa_firms: new NasaFirmsSource(config),
    gdacs_alerts: new GdacsAlertsSource(config),
    hzs_incidents: new HzsIncidentsSource(config),
    road_srti_lod: new RoadSrtiLodWarningsSource(config),
    admin_boundaries: new AdminBoundarySource(config)
  };

  return config.enabledSources.map((sourceId) => allSources[sourceId]);
}

export function allSourceDescriptors(config: SafetyDataConfig): SourceDescriptor[] {
  const enabled = new Set(config.enabledSources);
  return [
    new MockSafetyDataSource().descriptor,
    new ChmiAlertsSource(config).descriptor,
    new ChmiHydroSource(config).descriptor,
    new NasaFirmsSource(config).descriptor,
    new GdacsAlertsSource(config).descriptor,
    new HzsIncidentsSource(config).descriptor,
    new RoadSrtiLodWarningsSource(config).descriptor,
    new AdminBoundarySource(config).descriptor
  ].map((descriptor) => ({ ...descriptor, enabled: enabled.has(descriptor.sourceId) }));
}

function cacheStatsFor(sourceId: SafetyDataSourceId, caches: Array<{ stats(): ManagedResponseCacheStats }>): SourceCacheStats {
  return caches.reduce<SourceCacheStats>(
    (summary, cache) => {
      const stats = cache.stats();
      summary.entries += stats.entries;
      summary.inflight += stats.inflight;
      summary.maxEntries += stats.maxEntries;
      summary.hits += stats.hits;
      summary.misses += stats.misses;
      summary.coalescedHits += stats.coalescedHits;
      summary.staleHits += stats.staleHits;
      summary.refreshes += stats.refreshes;
      summary.errors += stats.errors;
      summary.evictions += stats.evictions;
      const lastSuccessAt = newestIsoTimestamp(summary.lastSuccessAt, stats.lastSuccessAt);
      const lastErrorAt = newestIsoTimestamp(summary.lastErrorAt, stats.lastErrorAt);
      if (lastSuccessAt) {
        summary.lastSuccessAt = lastSuccessAt;
      }
      if (lastErrorAt) {
        summary.lastErrorAt = lastErrorAt;
      }
      return summary;
    },
    {
      sourceId,
      entries: 0,
      inflight: 0,
      maxEntries: 0,
      hits: 0,
      misses: 0,
      coalescedHits: 0,
      staleHits: 0,
      refreshes: 0,
      errors: 0,
      evictions: 0
    }
  );
}

function newestIsoTimestamp(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (!Number.isFinite(leftTime)) {
    return right;
  }
  if (!Number.isFinite(rightTime)) {
    return left;
  }
  return rightTime > leftTime ? right : left;
}

class MockSafetyDataSource implements SafetyDataSource {
  readonly descriptor: SourceDescriptor = {
    sourceId: "mock",
    label: "Synthetic local safety feed",
    enabled: true,
    mode: "mock",
    priority: 10,
    layers: ["weather_alerts", "fire", "flood", "boundary_admin"],
    license: MOCK_LICENSE,
    updateCadenceSeconds: 10
  };

  async fetchFeatures(query: SafetyQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    const features = mockFeatures(query.bbox, fetchedAt)
      .filter((feature) => layerRequested(query.layers, feature.properties.layer))
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
  private readonly orpCodelistCache: ManagedResponseCache<ChmiOrpCodelistEntry[]>;
  private readonly boundaryMatchCache: ManagedResponseCache<ChmiBoundaryMatchRow[]>;
  private boundaryPool?: Pool;

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
    this.orpCodelistCache = new ManagedResponseCache<ChmiOrpCodelistEntry[]>({
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      staleIfErrorMs: 30 * 24 * 60 * 60 * 1000,
      maxEntries: 1
    });
    this.boundaryMatchCache = new ManagedResponseCache<ChmiBoundaryMatchRow[]>({
      ttlMs: Math.max(300, config.adminBoundaryCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.adminBoundaryCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(32, Math.min(512, config.cacheMaxEntries))
    });
    this.descriptor = {
      sourceId: "chmi_alerts",
      label: "CHMI CAP weather warnings",
      enabled: config.enabledSources.includes("chmi_alerts"),
      mode: "live",
      priority: 90,
      layers: ["weather_alerts", "fire"],
      license: CHMI_OPEN_DATA_LICENSE,
      baseUrl: config.chmiAlertsCapBaseUrl,
      updateCadenceSeconds: 300
    };
  }

  async fetchFeatures(query: SafetyQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    const weatherRequested = isWeatherAlertsRequested(query.layers);
    const fireRequested = query.layers.includes("fire");
    if (!weatherRequested && !fireRequested) {
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
        isArray: (name) => ["info", "area", "geocode", "parameter", "eventCode", "responseType"].includes(name)
      });
      return parser.parse(xml) as unknown;
    });

    const pointFeatures = mapCapAlert(parsed, query, fetchedAt, capUrl).filter((feature) => isFeatureInBbox(feature, query.bbox));
    const polygonized = await this.polygonizeCapFeatures(pointFeatures, query);
    const weatherFeatures = weatherRequested ? polygonized.features : [];
    const fireRiskFeatures = fireRequested
      ? polygonized.features.map((feature) => mapCapFireRiskFeature(feature)).filter((feature): feature is SafetyFeature => Boolean(feature))
      : [];
    const features = [...weatherFeatures, ...fireRiskFeatures].filter((feature) => isFeatureInBbox(feature, query.bbox));
    return { source: this.descriptor, fetchedAt, features: features.slice(0, query.limit), warnings: polygonized.warnings };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("chmi_alerts", [this.listingCache, this.capCache, this.orpCodelistCache, this.boundaryMatchCache])];
  }

  private async polygonizeCapFeatures(features: SafetyFeature[], query: SafetyQuery): Promise<{ features: SafetyFeature[]; warnings: string[] }> {
    const requestedCodes = unique(features.flatMap((feature) => capOrpCodes(feature.properties.geocodes)));
    if (requestedCodes.length === 0) {
      return { features, warnings: [] };
    }

    if (!this.config.adminBoundaryConnectionString) {
      return {
        features: features.map((feature) => markCapPointFallback(feature, requestedCodes.length, 0, "postgis_not_configured")),
        warnings: ["chmi_alerts CAP polygonization disabled: configure SAFETY_DATA_ADMIN_BOUNDARY_DATABASE_URL or OSM_POSTGIS_DATABASE_URL to resolve CISORP areas."]
      };
    }

    try {
      const codelist = await this.orpCodelistCache.getOrLoad("chmi_cisorp_codelist", () => fetchChmiOrpCodelist(this.config));
      const boundaryRows = await this.fetchBoundaryMatches(query.bbox, requestedCodes, codelist);
      const boundaryByCode = new Map<string, ChmiBoundaryMatchRow>();
      for (const row of boundaryRows) {
        if (!boundaryByCode.has(row.cisorp_code)) {
          boundaryByCode.set(row.cisorp_code, row);
        }
      }

      const transformed = features
        .map((feature) => polygonizeCapFeature(feature, boundaryByCode))
        .filter((feature): feature is SafetyFeature => Boolean(feature));
      return { features: transformed, warnings: [] };
    } catch (error) {
      return {
        features: features.map((feature) => markCapPointFallback(feature, requestedCodes.length, 0, "polygonization_failed")),
        warnings: [
          error instanceof Error
            ? `chmi_alerts CAP polygonization failed; using representative points: ${error.message}`
            : "chmi_alerts CAP polygonization failed; using representative points."
        ]
      };
    }
  }

  private async fetchBoundaryMatches(bbox: BoundingBox, requestedCodes: string[], codelist: ChmiOrpCodelistEntry[]): Promise<ChmiBoundaryMatchRow[]> {
    const codelistByCode = new Map(codelist.map((entry) => [entry.code, entry]));
    const requested = requestedCodes
      .map((code) => codelistByCode.get(code) ?? (code === "1100" ? { code: "1100", name: "Praha" } : undefined))
      .filter((entry): entry is ChmiOrpCodelistEntry => Boolean(entry));
    if (requested.length === 0) {
      return [];
    }

    const geometryColumn = boundaryLevelsForBbox(bbox).geometryColumn;
    const cacheKey = JSON.stringify({
      bbox: roundBbox(bbox),
      codes: requested.map((entry) => entry.code).sort(),
      simplification: geometryColumn
    });
    return this.boundaryMatchCache.getOrLoad(cacheKey, () => this.fetchBoundaryMatchRows(bbox, requested, geometryColumn));
  }

  private async fetchBoundaryMatchRows(
    bbox: BoundingBox,
    requested: ChmiOrpCodelistEntry[],
    geometryColumn: AdminBoundaryGeometryColumn
  ): Promise<ChmiBoundaryMatchRow[]> {
    const pool = this.getBoundaryPool();
    const table = quoteQualifiedIdentifier(this.config.adminBoundaryTable);
    const geomColumn = `boundary.${quoteIdentifier(geometryColumn)}`;
    const sql = `
      with requested(cisorp_code, cisorp_name) as (
        select * from unnest($5::text[], $6::text[])
      )
      select
        requested.cisorp_code,
        requested.cisorp_name,
        boundary.osm_id::text,
        boundary.admin_level,
        boundary.name,
        boundary.code,
        boundary.country_code,
        boundary.source,
        boundary.imported_at,
        st_asgeojson(${geomColumn}, 6) as geometry_geojson,
        boundary.tags
      from requested
      join ${table} boundary on (
        (requested.cisorp_name = 'Praha' and boundary.admin_level = 4 and boundary.name = 'Praha')
        or (
          boundary.admin_level = 6
          and (
            regexp_replace(coalesce(boundary.name, ''), '^SO ORP\\s+', '') = requested.cisorp_name
            or boundary.tags->>'short_name' = requested.cisorp_name
            or boundary.tags->>'full_name' = concat('správní obvod obce s rozšířenou působností ', requested.cisorp_name)
          )
        )
      )
      where boundary.geom && st_makeenvelope($1, $2, $3, $4, 4326)
        and st_intersects(boundary.geom, st_makeenvelope($1, $2, $3, $4, 4326))
      order by requested.cisorp_code, boundary.admin_level asc, st_area(boundary.geom::geography) desc
    `;
    const result = await pool.query<ChmiBoundaryMatchRow>(sql, [
      bbox.west,
      bbox.south,
      bbox.east,
      bbox.north,
      requested.map((entry) => entry.code),
      requested.map((entry) => entry.name)
    ]);
    return result.rows;
  }

  private getBoundaryPool(): Pool {
    if (!this.boundaryPool) {
      this.boundaryPool = new Pool({
        connectionString: this.config.adminBoundaryConnectionString,
        max: 3,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: this.config.requestTimeoutMs
      });
    }
    return this.boundaryPool;
  }
}

class ChmiHydroSource implements SafetyDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly metadataCache: ManagedResponseCache<HydroStation[]>;
  private readonly currentSnapshotCache: ManagedResponseCache<HydroCurrentSnapshot>;
  private readonly stationDataCache: ManagedResponseCache<HydroNowResponse>;
  private readonly recentDataCache: ManagedResponseCache<HydroNowResponse | undefined>;
  private readonly historyStore: ChmiHydroHistoryStore;
  private readonly missingStationDataUntilMs = new Map<string, number>();

  constructor(private readonly config: SafetyDataConfig) {
    this.historyStore = new ChmiHydroHistoryStore(config.dataDir);
    this.metadataCache = new ManagedResponseCache<HydroStation[]>({
      ttlMs: 24 * 60 * 60 * 1000,
      staleIfErrorMs: 7 * 24 * 60 * 60 * 1000,
      maxEntries: 1
    });
    this.stationDataCache = new ManagedResponseCache<HydroNowResponse>({
      ttlMs: Math.max(5 * 60_000, config.cacheTtlSeconds * 1000),
      staleIfErrorMs: Math.max(60 * 60_000, config.staleIfErrorSeconds * 1000),
      maxEntries: Math.max(64, config.chmiHydroStationCacheMaxEntries)
    });
    this.currentSnapshotCache = new ManagedResponseCache<HydroCurrentSnapshot>({
      ttlMs: Math.max(5 * 60_000, config.chmiHydroCurrentSnapshotCacheTtlSeconds * 1000),
      staleIfErrorMs: Math.max(60 * 60_000, config.staleIfErrorSeconds * 1000),
      maxEntries: 1
    });
    this.recentDataCache = new ManagedResponseCache<HydroNowResponse | undefined>({
      ttlMs: Math.max(10 * 60_000, config.cacheTtlSeconds * 1000),
      staleIfErrorMs: Math.max(60 * 60_000, config.staleIfErrorSeconds * 1000),
      maxEntries: Math.max(64, Math.min(1024, config.cacheMaxEntries * 2))
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

    if (!query.includeRaw) {
      const snapshot = await this.currentSnapshotCache.getOrLoad("chmi_hydro_current_snapshot", () => this.fetchCurrentSnapshot(stations));
      const selectedStationIds = new Set(selectedStations.map((station) => station.objId));
      const features = snapshot.features
        .filter((feature) => typeof feature.properties.stationId === "string" && selectedStationIds.has(feature.properties.stationId))
        .slice(0, query.limit);
      const missingCurrentDataCount = countMatchingIds(snapshot.missingStationIds, selectedStationIds);
      const failedStationCount = countMatchingIds(snapshot.failedStationIds, selectedStationIds);
      const warnings: string[] = [];
      if (failedStationCount > 0) {
        warnings.push(`chmi_hydro: ${failedStationCount} station observation fetches failed.`);
      }
      if (features.length === 0 && missingCurrentDataCount > 0) {
        warnings.push(`chmi_hydro: no current observations are available for ${missingCurrentDataCount} selected stations.`);
      }
      return { source: this.descriptor, fetchedAt: snapshot.fetchedAt, features, warnings };
    }

    const batch = await this.fetchStationFeatures(selectedStations, query.includeRaw, fetchedAt);
    const warnings = hydroFetchWarnings(batch);
    return { source: this.descriptor, fetchedAt, features: batch.features.slice(0, query.limit), warnings };
  }

  private async fetchCurrentSnapshot(stations: HydroStation[]): Promise<HydroCurrentSnapshot> {
    const fetchedAt = new Date().toISOString();
    const batch = await this.fetchStationFeatures(stations, false, fetchedAt);
    return {
      fetchedAt,
      ...batch
    };
  }

  private async fetchStationFeatures(stations: HydroStation[], includeRaw: boolean, fetchedAt: string): Promise<HydroStationFeatureBatch> {
    const features: SafetyFeature[] = [];
    const missingStationIds: string[] = [];
    const failedStationIds: string[] = [];
    for (let index = 0; index < stations.length; index += 8) {
      const batch = stations.slice(index, index + 8);
      const settled = await Promise.allSettled(batch.map((station) => this.fetchStationFeature(station, includeRaw, fetchedAt)));
      settled.forEach((item, settledIndex) => {
        const station = batch[settledIndex];
        if (!station) {
          return;
        }
        if (item.status === "fulfilled") {
          if (item.value.feature) {
            features.push(item.value.feature);
          }
          if (item.value.missingCurrentData) {
            missingStationIds.push(station.objId);
          }
        } else {
          failedStationIds.push(station.objId);
        }
      });
    }
    return { features, missingStationIds, failedStationIds };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("chmi_hydro", [this.metadataCache, this.currentSnapshotCache, this.stationDataCache, this.recentDataCache])];
  }

  async getHydroStationDetail(stationId: string, query: HydroStationDetailQuery): Promise<HydroStationDetail | undefined> {
    const generatedAt = new Date().toISOString();
    const stations = await this.metadataCache.getOrLoad("chmi_hydro_metadata", () => fetchHydroStations(this.config));
    const station = findHydroStation(stations, stationId);
    if (!station) {
      return undefined;
    }

    const window = hydroDetailWindow(query, this.config, generatedAt);
    const warnings: string[] = [];
    await this.backfillRecentStation(station, window.from, window.to, generatedAt, warnings);
    await this.persistCurrentStationData(station, generatedAt, warnings);
    const seriesIds = query.seriesIds ?? DEFAULT_HYDRO_DETAIL_SERIES;
    const records = await this.historyStore.readStationRecords(station.objId, {
      from: window.from,
      to: window.to,
      seriesIds
    });

    return buildHydroStationDetail(station, records, seriesIds, window, generatedAt, warnings);
  }

  private async fetchStationFeature(station: HydroStation, includeRaw: boolean, fetchedAt: string): Promise<HydroStationFetchResult> {
    if (this.isMissingStationDataCached(station.objId)) {
      return { missingCurrentData: true };
    }
    const url = `${trimTrailingSlash(this.config.chmiHydroNowBaseUrl)}/${encodeURIComponent(station.objId)}.json`;
    try {
      const payload = await this.stationDataCache.getOrLoad(url, () => requestJson<HydroNowResponse>(url, this.config.requestTimeoutMs));
      await this.persistHydroPayload(payload, url, "now", fetchedAt);
      return { feature: mapHydroStation(station, payload, includeRaw, fetchedAt) };
    } catch (error) {
      if (error instanceof HttpRequestError && error.status === 404) {
        this.cacheMissingStationData(station.objId);
        return { missingCurrentData: true };
      }
      throw error;
    }
  }

  private async persistCurrentStationData(station: HydroStation, fetchedAt: string, warnings: string[]): Promise<void> {
    const url = `${trimTrailingSlash(this.config.chmiHydroNowBaseUrl)}/${encodeURIComponent(station.objId)}.json`;
    try {
      const payload = await this.stationDataCache.getOrLoad(url, () => requestJson<HydroNowResponse>(url, this.config.requestTimeoutMs));
      await this.persistHydroPayload(payload, url, "now", fetchedAt, warnings);
    } catch (error) {
      if (error instanceof HttpRequestError && error.status === 404) {
        this.cacheMissingStationData(station.objId);
        warnings.push("Current CHMI hydro payload is not available for this station.");
        return;
      }
      throw error;
    }
  }

  private async backfillRecentStation(station: HydroStation, from: string, to: string, fetchedAt: string, warnings: string[]): Promise<void> {
    const dates = recentBackfillDates(from, to, this.config.chmiHydroDetailBackfillDays, fetchedAt);
    if (dates.length === 0) {
      return;
    }
    const settled = await Promise.allSettled(dates.map((date) => this.fetchRecentStationDay(station.objId, date, fetchedAt)));
    const failedCount = settled.filter((item) => item.status === "rejected").length;
    if (failedCount > 0) {
      warnings.push(`Recent CHMI hydro backfill skipped ${failedCount} day(s) because the upstream request failed.`);
    }
  }

  private async fetchRecentStationDay(stationId: string, date: string, fetchedAt: string): Promise<void> {
    const url = `${trimTrailingSlash(this.config.chmiHydroRecentBaseUrl)}/${date}_${encodeURIComponent(stationId)}.json`;
    const payload = await this.recentDataCache.getOrLoad(url, async () => {
      try {
        return await requestJson<HydroNowResponse>(url, this.config.requestTimeoutMs);
      } catch (error) {
        if (error instanceof HttpRequestError && error.status === 404) {
          return undefined;
        }
        throw error;
      }
    });
    if (payload) {
      await this.persistHydroPayload(payload, url, "recent", fetchedAt);
    }
  }

  private async persistHydroPayload(
    payload: HydroNowResponse,
    url: string,
    sourceKind: ChmiHydroSourceKind,
    fetchedAt: string,
    warnings?: string[]
  ): Promise<void> {
    try {
      await this.historyStore.persistPayload(payload, url, sourceKind, fetchedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      warnings?.push(`Local CHMI hydro history persist failed: ${message}`);
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

class NasaFirmsSource implements SafetyDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly responseCache: ManagedResponseCache<string>;

  constructor(private readonly config: SafetyDataConfig) {
    this.responseCache = new ManagedResponseCache<string>({
      ttlMs: Math.max(10 * 60_000, config.cacheTtlSeconds * 1000),
      staleIfErrorMs: Math.max(60 * 60_000, config.staleIfErrorSeconds * 1000),
      maxEntries: Math.max(16, Math.min(256, config.cacheMaxEntries))
    });
    this.descriptor = {
      sourceId: "nasa_firms",
      label: "NASA FIRMS active fire detections",
      enabled: config.enabledSources.includes("nasa_firms"),
      mode: "live",
      priority: 70,
      layers: ["fire"],
      license: NASA_FIRMS_LICENSE,
      baseUrl: config.nasaFirmsAreaBaseUrl,
      updateCadenceSeconds: 600
    };
  }

  async fetchFeatures(query: SafetyQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("fire")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    if (!this.config.nasaFirmsMapKey) {
      return {
        source: this.descriptor,
        fetchedAt,
        features: [],
        warnings: ["nasa_firms skipped: NASA_FIRMS_MAP_KEY is not configured."]
      };
    }

    const bbox = `${round(query.bbox.west, 4)},${round(query.bbox.south, 4)},${round(query.bbox.east, 4)},${round(query.bbox.north, 4)}`;
    const dayRange = Math.max(1, Math.min(10, this.config.nasaFirmsDayRange));
    const url = `${trimTrailingSlash(this.config.nasaFirmsAreaBaseUrl)}/${encodeURIComponent(this.config.nasaFirmsMapKey)}/${encodeURIComponent(
      this.config.nasaFirmsSource
    )}/${bbox}/${dayRange}`;
    const cacheKey = `nasa_firms:${this.config.nasaFirmsSource}:${bbox}:${dayRange}`;
    const csv = await this.responseCache.getOrLoad(cacheKey, () => requestText(url, this.config.requestTimeoutMs));
    const rows = parseCsv(csv);
    const features = rows
      .map((row, index) => mapFirmsDetection(row, index, query, fetchedAt, this.config.nasaFirmsSource))
      .filter((feature): feature is SafetyFeature => Boolean(feature))
      .filter((feature) => isFeatureInBbox(feature, query.bbox))
      .slice(0, query.limit)
      .map((feature) => stripRawIfNeeded(feature, query.includeRaw));

    return { source: this.descriptor, fetchedAt, features, warnings: [] };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("nasa_firms", [this.responseCache])];
  }
}

class GdacsAlertsSource implements SafetyDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly responseCache: ManagedResponseCache<unknown>;

  constructor(private readonly config: SafetyDataConfig) {
    this.responseCache = new ManagedResponseCache<unknown>({
      ttlMs: Math.max(300, config.gdacsCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(60 * 60_000, config.staleIfErrorSeconds * 1000),
      maxEntries: Math.max(8, Math.min(128, config.cacheMaxEntries))
    });
    this.descriptor = {
      sourceId: "gdacs_alerts",
      label: "GDACS global disaster alerts",
      enabled: config.enabledSources.includes("gdacs_alerts"),
      mode: "live",
      priority: 65,
      layers: ["warnings", "fire", "flood"],
      license: GDACS_LICENSE,
      baseUrl: config.gdacsRssUrl,
      updateCadenceSeconds: config.gdacsCacheTtlSeconds
    };
  }

  async fetchFeatures(query: SafetyQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.some((layer) => layer === "warnings" || layer === "fire" || layer === "flood")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const parsed = await this.responseCache.getOrLoad(this.config.gdacsRssUrl, async () => {
      const xml = await requestText(this.config.gdacsRssUrl, this.config.requestTimeoutMs);
      const parser = new XMLParser({
        ignoreAttributes: false,
        removeNSPrefix: true,
        isArray: (name) => ["item", "resource"].includes(name)
      });
      return parser.parse(xml) as unknown;
    });

    const features = gdacsItems(parsed)
      .flatMap((item) => mapGdacsItem(item, query, fetchedAt))
      .filter((feature): feature is SafetyFeature => Boolean(feature))
      .filter((feature) => isFeatureInBbox(feature, query.bbox))
      .slice(0, query.limit)
      .map((feature) => stripRawIfNeeded(feature, query.includeRaw));

    return { source: this.descriptor, fetchedAt, features, warnings: [] };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("gdacs_alerts", [this.responseCache])];
  }
}

class HzsIncidentsSource implements SafetyDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly feedCache: ManagedResponseCache<HzsIncidentRecord[]>;
  private readonly detailCache: ManagedResponseCache<HzsIncidentDetail>;
  private readonly geocodeCache: ManagedResponseCache<HzsIncidentGeocode>;
  private pool?: Pool;

  constructor(private readonly config: SafetyDataConfig) {
    this.feedCache = new ManagedResponseCache<HzsIncidentRecord[]>({
      ttlMs: Math.max(60, config.hzsIncidentsCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(600, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(8, Math.min(128, config.cacheMaxEntries))
    });
    this.detailCache = new ManagedResponseCache<HzsIncidentDetail>({
      ttlMs: Math.max(300, config.hzsIncidentsDetailCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(1800, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(64, Math.min(1024, config.cacheMaxEntries * 2))
    });
    this.geocodeCache = new ManagedResponseCache<HzsIncidentGeocode>({
      ttlMs: Math.max(1800, config.adminBoundaryCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(3600, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(64, Math.min(2048, config.cacheMaxEntries * 4))
    });
    this.descriptor = {
      sourceId: "hzs_incidents",
      label: "HZS public incident dispatches",
      enabled: config.enabledSources.includes("hzs_incidents"),
      mode: "live",
      priority: 80,
      layers: ["warnings", "fire"],
      license: HZS_INCIDENTS_LICENSE,
      baseUrl: config.hzsIncidentFeeds[0]?.url,
      updateCadenceSeconds: config.hzsIncidentsCacheTtlSeconds
    };
  }

  async fetchFeatures(query: SafetyQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.some((layer) => layer === "warnings" || layer === "fire")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const warnings: string[] = [];
    const records: HzsIncidentRecord[] = [];
    for (const feed of this.config.hzsIncidentFeeds) {
      if (!bboxIntersects(feed.bbox, query.bbox)) {
        continue;
      }
      try {
        records.push(...(await this.feedCache.getOrLoad(feed.id, () => this.fetchFeed(feed, fetchedAt))));
      } catch (error) {
        warnings.push(error instanceof Error ? `hzs_incidents feed ${feed.label} failed: ${error.message}` : `hzs_incidents feed ${feed.label} failed.`);
      }
    }

    const limitedRecords = records.slice(0, Math.max(1, this.config.hzsIncidentsMaxActiveDetails));
    const features: SafetyFeature[] = [];
    for (const record of limitedRecords) {
      const detail = await this.fetchDetailSafe(record);
      const geocode = await this.geocodeIncident(record, detail);
      features.push(...mapHzsIncident(record, detail, geocode, query, fetchedAt));
      if (features.length >= query.limit) {
        break;
      }
    }

    return {
      source: this.descriptor,
      fetchedAt,
      features: features
        .filter((feature) => isFeatureInBbox(feature, query.bbox))
        .slice(0, query.limit)
        .map((feature) => stripRawIfNeeded(feature, query.includeRaw)),
      warnings
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("hzs_incidents", [this.feedCache, this.detailCache, this.geocodeCache])];
  }

  private async fetchFeed(feed: HzsIncidentFeedConfig, fetchedAt: string): Promise<HzsIncidentRecord[]> {
    const html = await requestText(feed.url, this.config.requestTimeoutMs);
    return parseHzsActiveIncidentRows(html, feed, fetchedAt);
  }

  private async fetchDetailSafe(record: HzsIncidentRecord): Promise<HzsIncidentDetail> {
    const detailUrl = record.detailUrl;
    if (!detailUrl) {
      return {};
    }
    try {
      return await this.detailCache.getOrLoad(detailUrl, async () => {
        const html = await requestText(detailUrl, this.config.requestTimeoutMs);
        return parseHzsIncidentDetail(html);
      });
    } catch {
      return {};
    }
  }

  private async geocodeIncident(record: HzsIncidentRecord, detail: HzsIncidentDetail): Promise<HzsIncidentGeocode> {
    const candidates = hzsGeocodeCandidates(record, detail);
    const cacheKey = `${record.feed.id}:${candidates.join("|")}`;
    return this.geocodeCache.getOrLoad(cacheKey, async () => {
      if (this.config.adminBoundaryConnectionString) {
        try {
          for (const candidate of candidates) {
            const row = await this.fetchBoundaryPoint(candidate, record.feed);
            if (row) {
              return {
                lon: row.lon,
                lat: row.lat,
                precision: row.admin_level === 8 || row.admin_level === "8" ? "municipality_centroid" : "admin_boundary_centroid",
                label: optionalString(row.name) ?? candidate,
                confidence: 0.78,
                adminLevel: optionalString(row.admin_level),
                code: optionalString(row.code),
                countryCode: optionalString(row.country_code) ?? "CZ",
                source: "admin_boundaries_postgis"
              };
            }
          }
        } catch {
          // Fall through to the explicit low-confidence regional fallback. The
          // HZS incident itself is still useful even when administrative
          // geocoding is temporarily unavailable.
        }
      }
      return {
        lon: record.feed.fallbackLon,
        lat: record.feed.fallbackLat,
        precision: "region_centroid",
        label: record.feed.regionName,
        confidence: 0.52,
        countryCode: "CZ",
        source: "feed_region_fallback"
      };
    });
  }

  private async fetchBoundaryPoint(name: string, feed: HzsIncidentFeedConfig): Promise<HzsBoundaryPointRow | undefined> {
    const pool = this.getPool();
    const table = quoteQualifiedIdentifier(this.config.adminBoundaryTable);
    const sql = `
      select
        name,
        admin_level,
        code,
        country_code,
        st_x(st_pointonsurface(geom)) as lon,
        st_y(st_pointonsurface(geom)) as lat
      from ${table}
      where lower(name) = lower($1)
        and geom && st_makeenvelope($2, $3, $4, $5, 4326)
        and st_intersects(geom, st_makeenvelope($2, $3, $4, $5, 4326))
      order by
        case admin_level
          when 8 then 0
          when 9 then 1
          when 10 then 2
          when 7 then 3
          when 6 then 4
          else 5
        end,
        st_area(geom::geography) asc
      limit 1
    `;
    const result = await pool.query<HzsBoundaryPointRow>(sql, [name, feed.bbox.west, feed.bbox.south, feed.bbox.east, feed.bbox.north]);
    return result.rows[0];
  }

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: this.config.adminBoundaryConnectionString,
        max: 2,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: this.config.requestTimeoutMs
      });
    }
    return this.pool;
  }
}

class RoadSrtiLodWarningsSource implements SafetyDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly responseCache: ManagedResponseCache<RoadSrtiLodEvent[]>;

  constructor(private readonly config: SafetyDataConfig) {
    this.responseCache = new ManagedResponseCache<RoadSrtiLodEvent[]>({
      ttlMs: Math.max(60, config.roadSrtiLodCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(600, config.staleIfErrorSeconds) * 1000,
      maxEntries: 1
    });
    this.descriptor = {
      sourceId: "road_srti_lod",
      label: "NDIC/ŘSD traffic safety events",
      enabled: config.enabledSources.includes("road_srti_lod"),
      mode: "live",
      priority: 58,
      layers: ["warnings"],
      license: ROAD_SRTI_LOD_LICENSE,
      baseUrl: config.roadSrtiLodSparqlUrl,
      updateCadenceSeconds: config.roadSrtiLodCacheTtlSeconds
    };
  }

  async fetchFeatures(query: SafetyQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("warnings")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const events = await this.responseCache.getOrLoad("road_srti_lod_recent", () => fetchRoadSrtiLodEvents(this.config));
    const features = events
      .map((event) => mapRoadSrtiLodWarning(event, query, fetchedAt))
      .filter((feature): feature is SafetyFeature => Boolean(feature))
      .slice(0, query.limit)
      .map((feature) => stripRawIfNeeded(feature, query.includeRaw));

    return { source: this.descriptor, fetchedAt, features, warnings: [] };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("road_srti_lod", [this.responseCache])];
  }
}

class AdminBoundarySource implements SafetyDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly payloadCache: ManagedResponseCache<AdminBoundaryRow[]>;
  private pool?: Pool;

  constructor(private readonly config: SafetyDataConfig) {
    this.payloadCache = new ManagedResponseCache<AdminBoundaryRow[]>({
      ttlMs: Math.max(300, config.adminBoundaryCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.adminBoundaryCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(16, Math.min(512, config.cacheMaxEntries))
    });
    this.descriptor = {
      sourceId: "admin_boundaries",
      label: "Administrative boundary reference",
      enabled: config.enabledSources.includes("admin_boundaries"),
      mode: "reference",
      priority: 45,
      layers: ["boundary_admin"],
      license: config.adminBoundaryConnectionString ? OSM_ADMIN_BOUNDARY_LICENSE : ADMIN_BOUNDARY_SEED_LICENSE,
      baseUrl: publicPostgisBaseUrl(config.adminBoundaryConnectionString),
      updateCadenceSeconds: config.adminBoundaryCacheTtlSeconds
    };
  }

  async fetchFeatures(query: SafetyQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("boundary_admin")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    if (this.config.adminBoundaryConnectionString) {
      try {
        const levelSet = boundaryLevelsForBbox(query.bbox);
        const cacheKey = JSON.stringify({
          bbox: roundBbox(query.bbox),
          levels: levelSet.levels,
          simplification: levelSet.geometryColumn
        });
        const rows = await this.payloadCache.getOrLoad(cacheKey, () => this.fetchRows(query.bbox, levelSet.levels, levelSet.geometryColumn, query.limit));
        const features = rows
          .map((row) => mapAdminBoundaryRow(row, fetchedAt, query.includeRaw))
          .filter((feature): feature is SafetyFeature => Boolean(feature))
          .slice(0, query.limit);
        return {
          source: this.descriptor,
          fetchedAt,
          features,
          warnings: features.length === 0 ? ["admin_boundaries PostGIS read-model returned no boundaries for the requested bbox."] : []
        };
      } catch (error) {
        return {
          source: this.descriptor,
          fetchedAt,
          features: seedAdminBoundaryFeatures(query.bbox, fetchedAt),
          warnings: [error instanceof Error ? `admin_boundaries PostGIS read-model failed; using coarse seed fallback: ${error.message}` : "admin_boundaries PostGIS read-model failed; using coarse seed fallback."]
        };
      }
    }

    return {
      source: this.descriptor,
      fetchedAt,
      features: seedAdminBoundaryFeatures(query.bbox, fetchedAt),
      warnings: ["admin_boundaries is using a coarse seed fallback; configure SAFETY_DATA_ADMIN_BOUNDARY_DATABASE_URL or OSM_POSTGIS_DATABASE_URL for production PostGIS boundaries."]
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [cacheStatsFor("admin_boundaries", [this.payloadCache])];
  }

  private async fetchRows(bbox: BoundingBox, adminLevels: number[], geometryColumn: AdminBoundaryGeometryColumn, limit: number): Promise<AdminBoundaryRow[]> {
    const pool = this.getPool();
    const table = quoteQualifiedIdentifier(this.config.adminBoundaryTable);
    const geomColumn = quoteIdentifier(geometryColumn);
    const sql = `
      select
        osm_id::text,
        admin_level,
        name,
        code,
        country_code,
        source,
        imported_at,
        st_asgeojson(${geomColumn}, 6) as geometry_geojson,
        tags
      from ${table}
      where geom && st_makeenvelope($1, $2, $3, $4, 4326)
        and st_intersects(geom, st_makeenvelope($1, $2, $3, $4, 4326))
        and admin_level = any($5::int[])
      order by admin_level asc, st_area(geom::geography) asc, name nulls last
      limit $6
    `;
    const result = await pool.query<AdminBoundaryRow>(sql, [
      bbox.west,
      bbox.south,
      bbox.east,
      bbox.north,
      adminLevels,
      Math.max(1, Math.min(500, limit))
    ]);
    return result.rows;
  }

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: this.config.adminBoundaryConnectionString,
        max: 3,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: this.config.requestTimeoutMs
      });
    }
    return this.pool;
  }
}

interface AdminBoundaryRow {
  osm_id: string;
  admin_level: number | string;
  name: string | null;
  code: string | null;
  country_code: string | null;
  source: string | null;
  imported_at: Date | string | null;
  geometry_geojson: string | null;
  tags: Record<string, unknown> | null;
}

type AdminBoundaryGeometryColumn = "geom_z5" | "geom_z8" | "geom_z11" | "geom";

interface HzsIncidentRecord {
  id: string;
  feed: HzsIncidentFeedConfig;
  location: string;
  type: string;
  status?: string;
  announcedAt: string;
  detailUrl?: string;
  iconAlt?: string;
  raw: Record<string, unknown>;
}

interface HzsIncidentDetail {
  description?: string;
  type?: string;
  subtype?: string;
  district?: string;
  municipality?: string;
  municipalityPart?: string;
  street?: string;
  units?: string;
  status?: string;
}

interface HzsIncidentGeocode {
  lon: number;
  lat: number;
  precision: "municipality_centroid" | "admin_boundary_centroid" | "region_centroid";
  label: string;
  confidence: number;
  adminLevel?: string;
  code?: string;
  countryCode?: string;
  source: string;
}

interface HzsBoundaryPointRow {
  name: string | null;
  admin_level: number | string | null;
  code: string | null;
  country_code: string | null;
  lon: number;
  lat: number;
}

interface RoadSrtiLodEvent {
  iri: string;
  typeUri: string;
  typeLabel: string;
  observedAt: string;
  lon: number;
  lat: number;
  wkt: string;
  raw: Record<string, unknown>;
}

interface SparqlResults {
  results?: {
    bindings?: Array<Record<string, SparqlBindingValue>>;
  };
}

interface SparqlBindingValue {
  value?: string;
}

interface ChmiOrpCodelistEntry {
  code: string;
  name: string;
}

interface ChmiBoundaryMatchRow extends AdminBoundaryRow {
  cisorp_code: string;
  cisorp_name: string;
}

interface HydroStationFetchResult {
  feature?: SafetyFeature;
  missingCurrentData?: boolean;
}

interface HydroStationFeatureBatch {
  features: SafetyFeature[];
  missingStationIds: string[];
  failedStationIds: string[];
}

interface HydroCurrentSnapshot extends HydroStationFeatureBatch {
  fetchedAt: string;
}

interface FeatureInput {
  id: string;
  lon: number;
  lat: number;
  layer: SafetyLayerId;
  category: string;
  hazardType?: string;
  typeCode?: string;
  sourceCode?: string;
  sourceSystem?: string;
  headline: string;
  description?: string;
  recommendedAction?: string;
  sourceId: SafetyDataSourceId;
  source?: string;
  sourceName?: string;
  license: SafetyDataLicense;
  observedAt: string;
  effectiveAt?: string;
  expiresAt?: string;
  validFrom?: string;
  validUntil?: string;
  updatedAt?: string;
  confidence: number;
  severity: SafetySeverity;
  status?: string;
  urgency?: SafetyUrgency;
  certainty?: SafetyCertainty;
  areaName?: string;
  adminLevel?: number | string;
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
  waterTemperatureC?: number;
  floodStage?: number | string;
  trend?: string;
  detailUrl?: string;
  timelineUrl?: string;
  forecastAvailable?: boolean;
  forecastUntil?: string;
  basin?: string;
  affectedArea?: string;
  name?: string;
  code?: string;
  countryCode?: string;
  affectedAreas?: string[];
  geocodes?: Array<{ scheme: string; value: string }>;
  metrics?: Record<string, number | string | boolean>;
  tags?: Record<string, string>;
  localized?: Record<string, Record<string, unknown>>;
  providerProperties?: Record<string, unknown>;
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
    properties: makeFeatureProperties(input)
  };
}

function makePolygonFeature(input: Omit<FeatureInput, "lon" | "lat"> & { coordinates: Array<Array<[number, number]>> }): SafetyFeature {
  return {
    type: "Feature",
    id: input.id,
    geometry: {
      type: "Polygon",
      coordinates: input.coordinates.map((ring) => ring.map(([lon, lat]) => [round(lon, 6), round(lat, 6)] as [number, number]))
    },
    properties: makeFeatureProperties(input)
  };
}

function makeGeometryFeature(input: Omit<FeatureInput, "lon" | "lat"> & { geometry: SafetyGeometry }): SafetyFeature {
  return {
    type: "Feature",
    id: input.id,
    geometry: input.geometry,
    properties: makeFeatureProperties(input)
  };
}

function makeFeatureProperties(input: Omit<FeatureInput, "lon" | "lat">): SafetyFeature["properties"] {
  return {
    featureId: input.id,
    layer: input.layer,
    category: input.category,
    hazardType: input.hazardType ?? input.category,
    typeCode: input.typeCode,
    sourceCode: input.sourceCode,
    sourceSystem: input.sourceSystem,
    headline: input.headline,
    description: input.description,
    recommendedAction: input.recommendedAction,
    sourceId: input.sourceId,
    source: input.source ?? input.sourceId,
    sourceName: input.sourceName ?? input.license.attribution,
    observedAt: input.observedAt,
    effectiveAt: input.effectiveAt,
    expiresAt: input.expiresAt,
    validFrom: input.validFrom ?? input.effectiveAt ?? input.observedAt,
    validUntil: input.validUntil ?? input.expiresAt,
    updatedAt: input.updatedAt ?? input.observedAt,
    confidence: round(Math.max(0, Math.min(1, input.confidence)), 2),
    stale: false,
    severity: input.severity,
    status: input.status ?? "active",
    urgency: input.urgency ?? "unknown",
    certainty: input.certainty ?? "unknown",
    areaName: input.areaName,
    adminLevel: input.adminLevel,
    styleHint: input.styleHint ?? styleHint(input.layer, input.severity),
    iconHint: input.iconHint ?? iconHint(input.layer, input.category),
    basis: input.basis ?? [input.sourceId],
    fireStatus: input.fireStatus,
    detectedAt: input.detectedAt,
    sourceSatellite: input.sourceSatellite,
    sourceIncident: input.sourceIncident,
    intensity: input.intensity,
    frp: input.frp,
    riverName: input.riverName,
    stationId: input.stationId,
    waterLevelCm: input.waterLevelCm,
    discharge: input.discharge,
    waterTemperatureC: input.waterTemperatureC,
    floodStage: input.floodStage,
    trend: input.trend,
    detailUrl: input.detailUrl,
    timelineUrl: input.timelineUrl,
    forecastAvailable: input.forecastAvailable,
    forecastUntil: input.forecastUntil,
    basin: input.basin,
    affectedArea: input.affectedArea,
    name: input.name,
    code: input.code,
    countryCode: input.countryCode,
    license: {
      name: input.license.name,
      attribution: input.license.attribution,
      url: input.license.url
    },
    affectedAreas: input.affectedAreas,
    geocodes: input.geocodes,
    metrics: input.metrics,
    tags: input.tags,
    localized: input.localized,
    providerProperties: input.providerProperties,
    raw: input.raw
  };
}

function mockFeatures(bbox: BoundingBox, observedAt: string): SafetyFeature[] {
  const center = bboxCenter(bbox);
  return [
    makePointFeature({
      id: "weather_alerts:mock:wind-prague-west",
      lon: center.lon,
      lat: center.lat,
      layer: "weather_alerts",
      category: "weather_warning",
      hazardType: "wind",
      headline: "Synthetic wind warning",
      description: "Synthetic advisory feature used to validate COP safety rendering.",
      recommendedAction: "Validate layer rendering and stale handling only.",
      sourceId: "mock",
      sourceName: "Synthetic local safety feed",
      license: MOCK_LICENSE,
      observedAt,
      effectiveAt: observedAt,
      expiresAt: addSeconds(observedAt, 2 * 60 * 60),
      confidence: 0.92,
      severity: "advisory",
      urgency: "expected",
      certainty: "likely",
      status: "active",
      areaName: "Pilot area",
      adminLevel: "synthetic",
      iconHint: "wind",
      basis: ["synthetic_fixture", "weather_alerts"],
      affectedAreas: ["Pilot area"],
      metrics: { windGustMps: 19 }
    }),
    makePointFeature({
      id: "fire:mock:thermal-hotspot",
      lon: Math.min(bbox.east, Math.max(bbox.west, center.lon + 0.08)),
      lat: Math.min(bbox.north, Math.max(bbox.south, center.lat - 0.05)),
      layer: "fire",
      category: "active_fire",
      hazardType: "fire",
      headline: "Synthetic thermal fire detection",
      description: "Synthetic NASA FIRMS-like active fire detection for COM rendering validation.",
      recommendedAction: "Validate fire icon, severity color and detail panel only.",
      sourceId: "mock",
      sourceName: "Synthetic local safety feed",
      license: MOCK_LICENSE,
      observedAt,
      effectiveAt: observedAt,
      expiresAt: addSeconds(observedAt, 3 * 60 * 60),
      confidence: 0.74,
      severity: "warning",
      urgency: "expected",
      certainty: "possible",
      status: "active",
      fireStatus: "detected",
      detectedAt: observedAt,
      sourceSatellite: "synthetic-viirs",
      intensity: 13.5,
      frp: 13.5,
      areaName: "Pilot area",
      adminLevel: "synthetic",
      iconHint: "fire",
      basis: ["synthetic_fixture", "fire"]
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
      sourceName: "Synthetic local safety feed",
      license: MOCK_LICENSE,
      observedAt,
      expiresAt: addSeconds(observedAt, 60 * 60),
      confidence: 0.9,
      severity: "info",
      urgency: "unknown",
      certainty: "observed",
      status: "monitoring",
      riverName: "Vltava",
      stationId: "synthetic-vltava",
      waterLevelCm: 142,
      floodStage: 0,
      affectedArea: "Pilot reference",
      areaName: "Pilot reference",
      adminLevel: "synthetic",
      iconHint: "flood",
      basis: ["synthetic_fixture", "flood"],
      metrics: { waterLevelCm: 142, floodActivityLevel: 0 },
      tags: { streamName: "Vltava", stationName: "Pilot reference" }
    }),
    makePolygonFeature({
      id: "boundary_admin:mock:czechia-seed",
      layer: "boundary_admin",
      category: "admin_boundary",
      hazardType: "admin_boundary",
      headline: "Czechia coarse reference boundary",
      description: "Coarse synthetic administrative boundary seed used for COM contract validation.",
      sourceId: "mock",
      sourceName: "Synthetic local safety feed",
      license: MOCK_LICENSE,
      observedAt,
      effectiveAt: observedAt,
      confidence: 0.4,
      severity: "info",
      urgency: "unknown",
      certainty: "unknown",
      status: "reference",
      areaName: "Czechia",
      adminLevel: 2,
      name: "Czechia",
      code: "CZ",
      countryCode: "CZ",
      styleHint: "boundary-admin-country-v1",
      iconHint: "boundary",
      basis: ["synthetic_fixture", "boundary_admin"],
      coordinates: [
        [
          [12.09, 48.55],
          [18.86, 48.55],
          [18.86, 51.06],
          [12.09, 51.06],
          [12.09, 48.55]
        ]
      ],
      tags: { boundaryType: "country", precision: "coarse_seed" }
    })
  ];
}

interface CapLocalizedInfo {
  [key: string]: unknown;
  language: string;
  event?: string;
  headline?: string;
  description?: string;
  instruction?: string;
  web?: string;
  areaNames: string[];
}

interface CapInfoProjection {
  index: number;
  info: Record<string, unknown>;
  language: string;
  event: string;
  headline: string;
  description?: string;
  instruction?: string;
  web?: string;
  onset?: string;
  expires?: string;
  severityRaw?: string;
  urgencyRaw?: string;
  certaintyRaw?: string;
  classification: ChmiAlertClassification;
  eventCodes: ChmiEventCode[];
  parameters: ChmiParameter[];
  responseTypes: string[];
  affectedAreas: string[];
  geocodes: Array<{ scheme: string; value: string }>;
}

interface CapInfoGroup {
  key: string;
  primary: CapInfoProjection;
  localized: Record<string, CapLocalizedInfo>;
  rawInfos: Record<string, unknown>[];
  affectedAreas: string[];
  geocodes: Array<{ scheme: string; value: string }>;
  languages: string[];
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
  const groups = new Map<string, CapInfoGroup>();

  infos.forEach((info, index) => {
    const projection = projectCapInfo(info, index);
    if (isInactiveCapInfo(projection.event, projection.description, projection.severityRaw, projection.certaintyRaw, projection.classification)) {
      return;
    }

    const key = capInfoGroupKey(identifier, projection, sent);
    const group = groups.get(key);
    const localized = localizedCapInfo(projection);
    if (group) {
      group.localized[projection.language] = localized;
      group.rawInfos.push(info);
      group.affectedAreas = unique([...group.affectedAreas, ...projection.affectedAreas]);
      group.geocodes = uniqueGeocodes([...group.geocodes, ...projection.geocodes]);
      group.languages = unique([...group.languages, projection.language]);
      if (projection.language === "cs") {
        group.primary = projection;
      }
      return;
    }

    groups.set(key, {
      key,
      primary: projection,
      localized: { [projection.language]: localized },
      rawInfos: [info],
      affectedAreas: projection.affectedAreas,
      geocodes: projection.geocodes,
      languages: [projection.language]
    });
  });

  return Array.from(groups.values()).map((group) => {
    const primary = group.localized.cs ? group.primary : preferredCapProjection(group);
    const classification = primary.classification;
    const awarenessLevel = chmiAwarenessLevel(chmiParameterValue(primary.parameters, "awareness_level"));
    const severity = capSeverity(primary.severityRaw, primary.event, awarenessLevel.code);
    const primaryArea = group.affectedAreas[0];
    const category = classification.category;
    const sourceCode = classification.sourceCode;
    const typeCode = classification.typeCode;
    const localized = group.localized;
    const primaryLanguage = localized.cs ? "cs" : primary.language;

    return makePointFeature({
      id: `weather_alerts:chmi_alerts:${stableToken(group.key)}`,
      lon: center.lon,
      lat: center.lat,
      layer: "weather_alerts",
      category,
      hazardType: classification.hazardType,
      typeCode,
      sourceCode,
      sourceSystem: classification.sourceSystem,
      headline: localized[primaryLanguage]?.headline ?? primary.headline,
      description: localized[primaryLanguage]?.description ?? primary.description,
      recommendedAction: localized[primaryLanguage]?.instruction ?? primary.instruction,
      sourceId: "chmi_alerts",
      sourceName: "CHMI CAP weather warnings",
      license: CHMI_OPEN_DATA_LICENSE,
      observedAt: sent,
      effectiveAt: primary.onset ?? sent,
      expiresAt: primary.expires ?? addSeconds(sent, 24 * 60 * 60),
      confidence: capConfidence(primary.certaintyRaw, severity),
      severity,
      status: capStatus(status, msgType),
      urgency: capUrgency(primary.urgencyRaw),
      certainty: capCertainty(primary.certaintyRaw),
      areaName: primaryArea,
      adminLevel: primaryArea ? "cap_area" : "unknown",
      iconHint: classification.iconKey,
      basis: ["chmi_cap", capUrl, classification.classificationBasis],
      affectedAreas: group.affectedAreas,
      geocodes: group.geocodes,
      metrics: compactMetrics({
        areaCount: group.affectedAreas.length,
        geocodeCount: group.geocodes.length,
        languageCount: group.languages.length
      }),
      tags: compactTags({
        sender,
        status,
        msgType,
        language: primary.language,
        languages: group.languages.join(","),
        web: localized[primaryLanguage]?.web ?? primary.web,
        sourceSystem: classification.sourceSystem,
        sourceCode,
        sourceCodeName: classification.sourceCodeName,
        typeCode,
        domain: classification.domain,
        canonicalCategory: classification.category,
        classificationBasis: classification.classificationBasis,
        awarenessLevelCode: awarenessLevel.code,
        awarenessLevelColor: awarenessLevel.color,
        awarenessLevelLabel: awarenessLevel.label,
        capUrl
      }),
      localized,
      providerProperties: compactUnknownRecord({
        schemaVersion: "sim.provider.v2",
        kind: classification.isOutlook ? "official_outlook" : "official_alert",
        domain: classification.domain,
        category: classification.category,
        typeCode,
        sourceSystem: classification.sourceSystem,
        sourceCode,
        sourceCodeName: classification.sourceCodeName,
        taxonomy: compactUnknownRecord({
          provider: "CHMI",
          codeSystem: classification.sourceSystem,
          sourceCode,
          typeCode,
          domain: classification.domain,
          category: classification.category,
          hazardType: classification.hazardType,
          classificationBasis: classification.classificationBasis,
          awarenessType: chmiParameterValue(primary.parameters, "awareness_type"),
          awarenessLevel: chmiParameterValue(primary.parameters, "awareness_level"),
          awarenessLevelCode: awarenessLevel.code,
          awarenessLevelColor: awarenessLevel.color,
          criterion: chmiParameterValue(primary.parameters, "criterion")
        }),
        localized,
        presentation: compactUnknownRecord({
          primaryLanguage,
          iconKey: classification.iconKey,
          styleKey: `alert.${severity}`,
          detailTemplate: classification.domain === "air_quality" ? "official-air-quality-alert" : "official-alert",
          label: localized[primaryLanguage]?.headline ?? primary.headline
        }),
        notification: compactUnknownRecord({
          eligible: classification.notificationEligible && severity !== "info",
          reason: classification.notificationEligible ? "official_warning" : "non_notifiable_product"
        }),
        cap: compactUnknownRecord({
          identifier,
          sender,
          sent,
          status,
          msgType,
          url: capUrl,
          eventCodes: primary.eventCodes,
          parameters: primary.parameters,
          responseTypes: primary.responseTypes
        })
      }),
      raw: query.includeRaw ? group.rawInfos : undefined
    });
  });
}

function projectCapInfo(info: Record<string, unknown>, index: number): CapInfoProjection {
  const event = optionalString(info.event) ?? "CHMI warning";
  const headline = optionalString(info.headline) ?? event;
  const eventCodes = parseCapEventCodes(info.eventCode);
  const parameters = parseCapParameters(info.parameter);
  const classification = classifyChmiAlert({ event, headline, eventCodes, parameters });
  const areas = toArray(info.area).map(asRecord).filter(Boolean) as Array<Record<string, unknown>>;
  const affectedAreas = unique(
    areas
      .map((area) => optionalString(area.areaDesc))
      .filter((value): value is string => Boolean(value))
  );
  const geocodes = uniqueGeocodes(
    areas.flatMap((area) =>
      toArray(area.geocode)
        .map(asRecord)
        .filter(Boolean)
        .map((geocode) => ({
          scheme: optionalString(geocode?.valueName) ?? "unknown",
          value: optionalString(geocode?.value) ?? ""
        }))
        .filter((geocode) => geocode.value.length > 0)
    )
  );

  return {
    index,
    info,
    language: normalizeCapLanguage(optionalString(info.language)),
    event,
    headline,
    description: optionalString(info.description),
    instruction: optionalString(info.instruction),
    web: optionalString(info.web),
    onset: normalizeTimestamp(optionalString(info.onset)),
    expires: normalizeTimestamp(optionalString(info.expires)),
    severityRaw: optionalString(info.severity),
    urgencyRaw: optionalString(info.urgency),
    certaintyRaw: optionalString(info.certainty),
    classification,
    eventCodes,
    parameters,
    responseTypes: toArray(info.responseType).map(optionalString).filter((value): value is string => Boolean(value)),
    affectedAreas,
    geocodes
  };
}

function parseCapEventCodes(value: unknown): ChmiEventCode[] {
  return toArray(value)
    .map(asRecord)
    .filter(Boolean)
    .map((eventCode) => ({
      valueName: optionalString(eventCode?.valueName),
      value: optionalString(eventCode?.value)
    }))
    .filter((eventCode) => Boolean(eventCode.value));
}

function parseCapParameters(value: unknown): ChmiParameter[] {
  return toArray(value)
    .map(asRecord)
    .filter(Boolean)
    .map((parameter) => ({
      valueName: optionalString(parameter?.valueName),
      value: optionalString(parameter?.value)
    }))
    .filter((parameter) => Boolean(parameter.valueName) || Boolean(parameter.value));
}

function capInfoGroupKey(identifier: string, projection: CapInfoProjection, sent: string): string {
  const classification = projection.classification;
  const classificationKey = classification.sourceCode ?? classification.typeCode;
  const geocodeKey = projection.geocodes
    .map((geocode) => `${geocode.scheme}:${geocode.value}`)
    .sort()
    .join(",");
  return [
    identifier,
    classificationKey,
    projection.onset ?? sent,
    projection.expires ?? "",
    projection.severityRaw ?? "",
    projection.urgencyRaw ?? "",
    projection.certaintyRaw ?? "",
    geocodeKey || projection.affectedAreas.join(","),
    projection.responseTypes.join(",")
  ].join("|");
}

function localizedCapInfo(projection: CapInfoProjection): CapLocalizedInfo {
  return {
    language: projection.language,
    event: projection.event,
    headline: projection.headline,
    description: projection.description,
    instruction: projection.instruction,
    web: projection.web,
    areaNames: projection.affectedAreas
  };
}

function preferredCapProjection(group: CapInfoGroup): CapInfoProjection {
  if (group.primary.language === "cs") {
    return group.primary;
  }
  return group.primary;
}

function normalizeCapLanguage(value: string | undefined): string {
  const normalized = (value ?? "und").trim().toLowerCase();
  if (normalized === "cs" || normalized === "cs-cz" || normalized === "cz") {
    return "cs";
  }
  if (normalized === "en" || normalized === "en-gb" || normalized === "en-us") {
    return "en";
  }
  return normalized || "und";
}

function uniqueGeocodes(values: Array<{ scheme: string; value: string }>): Array<{ scheme: string; value: string }> {
  const seen = new Set<string>();
  const output: Array<{ scheme: string; value: string }> = [];
  for (const geocode of values) {
    const key = `${geocode.scheme}:${geocode.value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(geocode);
  }
  return output;
}

function compactUnknownRecord(input: Record<string, unknown>): Record<string, unknown> | undefined {
  const output = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  return Object.keys(output).length > 0 ? output : undefined;
}

function mapCapFireRiskFeature(feature: SafetyFeature): SafetyFeature | undefined {
  if (feature.properties.hazardType !== "fire_weather" && feature.properties.typeCode !== "weather.fire_danger") {
    return undefined;
  }
  const providerProperties = feature.properties.providerProperties ?? {};

  return makeGeometryFeature({
    id: `fire:chmi_alerts:${stableToken(feature.id)}`,
    layer: "fire",
    category: "fire_weather_risk",
    hazardType: "fire_weather",
    typeCode: feature.properties.typeCode,
    sourceCode: feature.properties.sourceCode,
    sourceSystem: feature.properties.sourceSystem,
    headline: feature.properties.headline,
    description: feature.properties.description,
    recommendedAction: feature.properties.recommendedAction,
    sourceId: "chmi_alerts",
    sourceName: "CHMI CAP fire danger warnings",
    license: CHMI_OPEN_DATA_LICENSE,
    observedAt: feature.properties.observedAt,
    effectiveAt: feature.properties.effectiveAt,
    expiresAt: feature.properties.expiresAt,
    validFrom: feature.properties.validFrom,
    validUntil: feature.properties.validUntil,
    updatedAt: feature.properties.updatedAt,
    confidence: feature.properties.confidence,
    severity: feature.properties.severity,
    status: "risk",
    urgency: feature.properties.urgency,
    certainty: feature.properties.certainty,
    areaName: feature.properties.areaName,
    adminLevel: feature.properties.adminLevel,
    fireStatus: "risk",
    sourceIncident: "CHMI_CAP_FIRE_DANGER",
    iconHint: "fire",
    basis: unique([...feature.properties.basis, "chmi_cap_fire_weather"]),
    geometry: feature.geometry,
    affectedAreas: feature.properties.affectedAreas,
    geocodes: feature.properties.geocodes,
    metrics: compactMetrics({
      ...(feature.properties.metrics ?? {}),
      fireRiskFromWeatherWarning: true
    }),
    tags: compactTags({
      ...(feature.properties.tags ?? {}),
      sourceLayer: feature.properties.layer,
      fireRiskSource: "chmi_cap"
    }),
    localized: feature.properties.localized,
    providerProperties: compactUnknownRecord({
      ...providerProperties,
      kind: "official_fire_danger_projection",
      relatedFeatureId: feature.id,
      relation: "derived_projection",
      presentation: compactUnknownRecord({
        ...(asRecord(providerProperties.presentation) ?? {}),
        iconKey: "fire",
        detailTemplate: "official-fire-danger-alert"
      }),
      notification: asRecord(providerProperties.notification) ?? { eligible: feature.properties.severity !== "info", reason: "official_warning" }
    }),
    raw: feature.properties.raw
  });
}

async function fetchChmiOrpCodelist(config: SafetyDataConfig): Promise<ChmiOrpCodelistEntry[]> {
  const text = await requestText(config.chmiOrpCodelistUrl, config.requestTimeoutMs);
  const rows = parseCsv(text);
  const byCode = new Map<string, ChmiOrpCodelistEntry>();
  for (const row of rows) {
    const code = normalizeCisorpCode(row.chodnota1);
    const name = optionalString(row.text1);
    if (!code || !name || byCode.has(code)) {
      continue;
    }
    byCode.set(code, { code, name });
  }

  const prague = byCode.get("1000")?.name ?? "Praha";
  byCode.set("1000", { code: "1000", name: prague });
  byCode.set("1100", { code: "1100", name: prague });
  return Array.from(byCode.values());
}

function polygonizeCapFeature(feature: SafetyFeature, boundaryByCode: Map<string, ChmiBoundaryMatchRow>): SafetyFeature | undefined {
  const requestedCodes = capOrpCodes(feature.properties.geocodes);
  if (requestedCodes.length === 0) {
    return feature;
  }

  const matchedRows = requestedCodes
    .map((code) => boundaryByCode.get(code))
    .filter((row): row is ChmiBoundaryMatchRow => Boolean(row));
  const geometry = mergeBoundaryGeometries(matchedRows);
  if (!geometry) {
    return undefined;
  }

  const adminLevels = unique(matchedRows.map((row) => String(row.admin_level)).filter(Boolean));
  const matchedNames = unique(matchedRows.map((row) => row.cisorp_name).filter(Boolean));
  const matchStatus = matchedRows.length === requestedCodes.length ? "full" : "bbox_subset";
  return {
    ...feature,
    geometry,
    properties: {
      ...feature.properties,
      areaName: feature.properties.areaName ?? boundaryAreaName(matchedNames),
      adminLevel: adminLevels.length === 1 ? adminLevels[0] : "mixed",
      basis: unique([...feature.properties.basis, "chmi_cap_cisorp", "osm_postgis_admin_boundary_match"]),
      metrics: compactMetrics({
        ...(feature.properties.metrics ?? {}),
        boundaryRequestedCount: requestedCodes.length,
        boundaryMatchCount: matchedRows.length,
        geometryMode: "admin_boundary"
      }),
      tags: compactTags({
        ...(feature.properties.tags ?? {}),
        geometryMode: "admin_boundary",
        boundaryMatch: matchStatus,
        boundarySource: "osm_postgis_admin_boundary"
      })
    }
  };
}

function markCapPointFallback(feature: SafetyFeature, requestedCount: number, matchedCount: number, reason: string): SafetyFeature {
  return {
    ...feature,
    properties: {
      ...feature.properties,
      basis: unique([...feature.properties.basis, "chmi_cap_representative_point"]),
      metrics: compactMetrics({
        ...(feature.properties.metrics ?? {}),
        boundaryRequestedCount: requestedCount,
        boundaryMatchCount: matchedCount,
        geometryMode: "representative_point"
      }),
      tags: compactTags({
        ...(feature.properties.tags ?? {}),
        geometryMode: "representative_point",
        boundaryMatch: matchedCount > 0 ? "partial" : "none",
        boundaryFallbackReason: reason
      })
    }
  };
}

function capOrpCodes(geocodes: Array<{ scheme: string; value: string }> | undefined): string[] {
  return unique(
    (geocodes ?? [])
      .flatMap((geocode) => {
        const scheme = geocode.scheme.toUpperCase();
        if (scheme.includes("CISORP")) {
          return [normalizeCisorpCode(geocode.value)];
        }
        if (scheme.includes("EMMA")) {
          return [normalizeEmmaOrpCode(geocode.value)];
        }
        return [];
      })
      .filter((code): code is string => Boolean(code))
  );
}

function normalizeCisorpCode(value: string | undefined): string | undefined {
  const digits = value?.replace(/\D/g, "");
  if (!digits) {
    return undefined;
  }
  return digits.length >= 4 ? digits.slice(-4) : digits.padStart(4, "0");
}

function normalizeEmmaOrpCode(value: string | undefined): string | undefined {
  const digits = value?.replace(/\D/g, "");
  return digits && digits.length >= 4 ? digits.slice(-4) : undefined;
}

function mergeBoundaryGeometries(rows: ChmiBoundaryMatchRow[]): SafetyGeometry | undefined {
  const polygons: Array<Array<Array<[number, number]>>> = [];
  for (const row of rows) {
    const geometry = parseSafetyGeometry(row.geometry_geojson);
    if (!geometry) {
      continue;
    }
    if (geometry.type === "Polygon") {
      polygons.push(geometry.coordinates);
    } else if (geometry.type === "MultiPolygon") {
      polygons.push(...geometry.coordinates);
    }
  }
  if (polygons.length === 0) {
    return undefined;
  }
  if (polygons.length === 1) {
    return { type: "Polygon", coordinates: polygons[0] ?? [] };
  }
  return { type: "MultiPolygon", coordinates: polygons };
}

function boundaryAreaName(names: string[]): string | undefined {
  if (names.length === 0) {
    return undefined;
  }
  if (names.length === 1) {
    return names[0];
  }
  return `${names.length} správních území`;
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
  dryQ?: number;
  spa1Q?: number;
  spa2Q?: number;
  spa3Q?: number;
  spa4Q?: number;
  catchmentAreaKm2?: number;
  hydrologicalOrder?: string;
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

interface HydroTrend {
  trend: string;
  delta: number;
  ratePerHour: number;
  windowMinutes: number;
}

const DEFAULT_HYDRO_DETAIL_SERIES: HydroSeriesId[] = ["H", "Q", "TH", "H_F", "Q_F"];

const HYDRO_SERIES_META: Record<HydroSeriesId, { label: string; unit: string; role: HydroSeriesRole }> = {
  H: { label: "Vodní stav", unit: "cm", role: "observation" },
  Q: { label: "Průtok", unit: "m3/s", role: "observation" },
  TH: { label: "Teplota vody", unit: "°C", role: "observation" },
  H_F: { label: "Předpověď vodního stavu", unit: "cm", role: "forecast" },
  Q_F: { label: "Předpověď průtoku", unit: "m3/s", role: "forecast" }
};

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
    spa4H: optionalNumber(record.SPA4H),
    dryQ: optionalNumber(record.DRYQ),
    spa1Q: optionalNumber(record.SPA1Q),
    spa2Q: optionalNumber(record.SPA2Q),
    spa3Q: optionalNumber(record.SPA3Q),
    spa4Q: optionalNumber(record.SPA4Q),
    catchmentAreaKm2: optionalNumber(record.PLO_STA),
    hydrologicalOrder: optionalString(record.HLGP4)
  };
}

function mapHydroStation(station: HydroStation, payload: HydroNowResponse, includeRaw: boolean, fetchedAt: string): SafetyFeature | undefined {
  const object = payload.objList?.find((item) => item.objID === station.objId) ?? payload.objList?.[0];
  const waterLevelSeries = object?.tsList?.find((series) => series.tsConID === "H");
  const flowSeries = object?.tsList?.find((series) => series.tsConID === "Q");
  const temperatureSeries = object?.tsList?.find((series) => series.tsConID === "TH");
  const waterLevelForecastSeries = object?.tsList?.find((series) => series.tsConID === "H_F");
  const flowForecastSeries = object?.tsList?.find((series) => series.tsConID === "Q_F");
  const waterLevel = latestObservation(waterLevelSeries);
  const flow = latestObservation(flowSeries);
  const waterTemperature = latestObservation(temperatureSeries);
  if (!waterLevel && !flow) {
    return undefined;
  }

  const observed = waterLevel ?? flow;
  if (!observed) {
    return undefined;
  }

  const waterTrend = hydroTrend(waterLevelSeries, "H");
  const flowTrend = hydroTrend(flowSeries, "Q");
  const selectedTrend = waterTrend ?? flowTrend;
  const floodActivityLevel = floodLevel(waterLevel?.value, flow?.value, station);
  const severity = floodSeverity(floodActivityLevel);
  const stream = station.streamName ? ` - ${station.streamName}` : "";
  const status = floodActivityLevel > 0 ? "active" : "monitoring";
  const forecastUntil = latestForecastTimestamp([waterLevelForecastSeries, flowForecastSeries]);
  const forecastHorizonHours = forecastUntil ? Math.max(0, (Date.parse(forecastUntil) - Date.parse(fetchedAt)) / (60 * 60 * 1000)) : undefined;
  const detailUrl = hydroDetailUrl(station.objId);

  return makePointFeature({
    id: `flood:chmi_hydro:${stableToken(station.objId)}`,
    lon: station.lon,
    lat: station.lat,
    layer: "flood",
    category: "water_level",
    hazardType: "flood",
    headline: `${station.stationName}${stream}`,
    description:
      waterLevel !== undefined
        ? `CHMI hydrological station water level ${Math.round(waterLevel.value)} ${waterLevel.unit ?? "cm"}.`
        : "CHMI hydrological station discharge observation.",
    sourceId: "chmi_hydro",
    sourceName: "CHMI hydrological stations",
    license: CHMI_OPEN_DATA_LICENSE,
    observedAt: observed.observedAt,
    expiresAt: addSeconds(fetchedAt, 2 * 60 * 60),
    confidence: hydroConfidence(observed.observedAt),
    severity,
    status,
    urgency: floodActivityLevel >= 2 ? "expected" : "unknown",
    certainty: "observed",
    areaName: station.stationName,
    adminLevel: "station",
    riverName: station.streamName,
    stationId: station.objId,
    waterLevelCm: waterLevel?.value,
    discharge: flow?.value,
    waterTemperatureC: waterTemperature?.value,
    floodStage: floodActivityLevel,
    trend: selectedTrend?.trend ?? "unknown",
    detailUrl,
    timelineUrl: detailUrl,
    forecastAvailable: Boolean(forecastUntil),
    forecastUntil,
    basin: station.hydrologicalOrder,
    affectedArea: station.streamName ? `${station.streamName} - ${station.stationName}` : station.stationName,
    iconHint: "flood",
    basis: ["chmi_hydro_now", station.objId],
    metrics: compactMetrics({
      waterLevelCm: waterLevel?.value,
      flowM3s: flow?.value,
      waterTemperatureC: waterTemperature?.value,
      floodActivityLevel,
      forecastAvailable: Boolean(forecastUntil),
      forecastHorizonHours: forecastHorizonHours !== undefined ? round(forecastHorizonHours, 2) : undefined,
      waterLevelDeltaCm: waterTrend?.delta,
      waterLevelRateCmPerHour: waterTrend?.ratePerHour,
      flowDeltaM3s: flowTrend?.delta,
      flowRateM3sPerHour: flowTrend?.ratePerHour,
      trendWindowMinutes: selectedTrend?.windowMinutes,
      observationAgeSeconds: Math.round(Math.max(0, (Date.parse(fetchedAt) - Date.parse(observed.observedAt)) / 1000)),
      catchmentAreaKm2: station.catchmentAreaKm2,
      dryLevelCm: station.dryH,
      spa1Cm: station.spa1H,
      spa2Cm: station.spa2H,
      spa3Cm: station.spa3H,
      spa4Cm: station.spa4H,
      dryFlowM3s: station.dryQ,
      spa1FlowM3s: station.spa1Q,
      spa2FlowM3s: station.spa2Q,
      spa3FlowM3s: station.spa3Q,
      spa4FlowM3s: station.spa4Q
    }),
    tags: compactTags({
      stationId: station.objId,
      stationCode: station.stationCode,
      stationName: station.stationName,
      streamName: station.streamName,
      detailUrl,
      spaType: station.spaType,
      hydrologicalOrder: station.hydrologicalOrder,
      trendBasis: selectedTrend ? (waterTrend ? "water_level" : "discharge") : undefined
    }),
    raw: includeRaw ? payload : undefined
  });
}

function hydroFetchWarnings(batch: HydroStationFeatureBatch): string[] {
  const warnings: string[] = [];
  if (batch.failedStationIds.length > 0) {
    warnings.push(`chmi_hydro: ${batch.failedStationIds.length} station observation fetches failed.`);
  }
  if (batch.features.length === 0 && batch.missingStationIds.length > 0) {
    warnings.push(`chmi_hydro: no current observations are available for ${batch.missingStationIds.length} selected stations.`);
  }
  return warnings;
}

function countMatchingIds(ids: string[], selectedIds: Set<string>): number {
  return ids.reduce((count, id) => count + (selectedIds.has(id) ? 1 : 0), 0);
}

function mapFirmsDetection(
  row: Record<string, string>,
  index: number,
  query: SafetyQuery,
  fetchedAt: string,
  sourceProduct: string
): SafetyFeature | undefined {
  const lat = optionalNumber(row.latitude);
  const lon = optionalNumber(row.longitude);
  if (lat === undefined || lon === undefined || !isPointInBbox(lon, lat, query.bbox)) {
    return undefined;
  }

  const detectedAt = firmsDetectedAt(row.acq_date, row.acq_time) ?? fetchedAt;
  const confidence = firmsConfidence(row.confidence);
  const frp = optionalNumber(row.frp);
  const brightTi4 = optionalNumber(row.bright_ti4);
  const satellite = [optionalString(row.satellite), optionalString(row.instrument)].filter(Boolean).join(" ");
  const severity = fireSeverity(confidence, frp);
  const token = stableToken(`${sourceProduct}:${detectedAt}:${lon}:${lat}:${frp ?? ""}:${index}`);

  return makePointFeature({
    id: `fire:nasa_firms:${token}`,
    lon,
    lat,
    layer: "fire",
    category: "active_fire",
    hazardType: "fire",
    headline: "Satellite fire detection",
    description: `NASA FIRMS ${sourceProduct} active fire or thermal anomaly detection.`,
    recommendedAction: "Treat as situational context; verify through official fire and emergency services channels.",
    sourceId: "nasa_firms",
    sourceName: "NASA FIRMS active fire detections",
    license: NASA_FIRMS_LICENSE,
    observedAt: detectedAt,
    effectiveAt: detectedAt,
    expiresAt: addSeconds(fetchedAt, 6 * 60 * 60),
    confidence,
    severity,
    status: "active",
    urgency: severity === "critical" || severity === "warning" ? "expected" : "unknown",
    certainty: confidence >= 0.8 ? "likely" : confidence >= 0.55 ? "possible" : "unknown",
    fireStatus: "detected",
    detectedAt,
    sourceSatellite: satellite || sourceProduct,
    sourceIncident: sourceProduct,
    intensity: frp ?? brightTi4,
    frp,
    areaName: "satellite detection",
    adminLevel: "unknown",
    iconHint: "fire",
    basis: ["nasa_firms_area_csv", sourceProduct],
    metrics: compactMetrics({
      frp,
      brightTi4,
      brightTi5: optionalNumber(row.bright_ti5),
      scan: optionalNumber(row.scan),
      track: optionalNumber(row.track)
    }),
    tags: compactTags({
      satellite: optionalString(row.satellite),
      instrument: optionalString(row.instrument),
      daynight: optionalString(row.daynight),
      confidenceRaw: optionalString(row.confidence),
      version: optionalString(row.version)
    }),
    raw: query.includeRaw ? row : undefined
  });
}

function parseHzsActiveIncidentRows(html: string, feed: HzsIncidentFeedConfig, fetchedAt: string): HzsIncidentRecord[] {
  const activeSection = sectionBetween(html, "Probíhající výjezdy", "Ukončené výjezdy");
  if (!activeSection) {
    return [];
  }
  const rows = Array.from(activeSection.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)).map((match) => match[1] ?? "");
  return rows
    .map((row) => parseHzsActiveIncidentRow(row, feed, fetchedAt))
    .filter((record): record is HzsIncidentRecord => Boolean(record));
}

function parseHzsActiveIncidentRow(row: string, feed: HzsIncidentFeedConfig, fetchedAt: string): HzsIncidentRecord | undefined {
  if (/aktualizovat|Sledovat přes RSS|Sledovat pres RSS/i.test(row)) {
    return undefined;
  }
  const cells = Array.from(row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)).map((match) => match[1] ?? "");
  if (cells.length < 5) {
    return undefined;
  }
  const [iconCell = "", dayCell = "", timeCell = "", locationCell = "", typeCell = "", statusCell = ""] = cells;
  const iconAlt = imageAlt(iconCell);
  const dayLabel = htmlText(dayCell);
  const timeLabel = htmlText(timeCell);
  const location = htmlText(locationCell);
  const type = htmlText(typeCell) || iconAlt;
  const status = htmlText(statusCell);
  if (!location || !type) {
    return undefined;
  }
  const detailUrl = linkHref(locationCell, feed.url);
  const id = detailUrl ? hzsIncidentIdFromUrl(detailUrl) : stableToken(`${feed.id}:${location}:${type}:${dayLabel}:${timeLabel}`);
  return {
    id,
    feed,
    location,
    type,
    status,
    announcedAt: parseHzsRelativeTimestamp(dayLabel, timeLabel, fetchedAt) ?? fetchedAt,
    detailUrl,
    iconAlt,
    raw: {
      feedId: feed.id,
      dayLabel,
      timeLabel,
      location,
      type,
      status,
      detailUrl,
      iconAlt
    }
  };
}

function parseHzsIncidentDetail(html: string): HzsIncidentDetail {
  const fields = new Map<string, string>();
  for (const match of html.matchAll(/<p>\s*<strong>([\s\S]*?):<\/strong>\s*([\s\S]*?)<\/p>/gi)) {
    const key = normalizeCzechKey(htmlText(match[1] ?? ""));
    const value = normalizeMissingText(htmlText(match[2] ?? ""));
    if (key && value) {
      fields.set(key, value);
    }
  }
  return {
    description: fields.get("popis"),
    type: fields.get("typ"),
    subtype: fields.get("podtyp"),
    district: fields.get("okres"),
    municipality: fields.get("obec"),
    municipalityPart: fields.get("cast obce"),
    street: fields.get("ulice"),
    units: fields.get("jednotky"),
    status: fields.get("stav")
  };
}

function mapHzsIncident(record: HzsIncidentRecord, detail: HzsIncidentDetail, geocode: HzsIncidentGeocode, query: SafetyQuery, fetchedAt: string): SafetyFeature[] {
  const classification = classifyHzsIncident(detail.type ?? record.type, detail.subtype, detail.description);
  const targetLayers = hzsRequestedLayers(classification.primaryLayer, query.layers);
  if (targetLayers.length === 0) {
    return [];
  }
  const observedAt = record.announcedAt;
  const expiresAt = addSeconds(fetchedAt, 30 * 60);
  const address = hzsAddress(record, detail);
  const status = detail.status ?? record.status ?? "probíhá";
  const description = hzsDescription(detail, status);
  const sourceIncident = `HZS-${record.id}`;

  return targetLayers.map((layer) =>
    makePointFeature({
      id: `${layer}:hzs_incidents:${stableToken(`${record.feed.id}:${record.id}:${layer}`)}`,
      lon: geocode.lon,
      lat: geocode.lat,
      layer,
      category: layer === "fire" ? "active_fire_incident" : classification.category,
      hazardType: classification.hazardType,
      typeCode: classification.typeCode,
      sourceCode: classification.typeCode,
      sourceSystem: "HZS_INCIDENT_TYPE",
      headline: `${detail.type ?? record.type} - ${record.location}`,
      description,
      recommendedAction: "Veřejný situační kontext z HZS; pro zásahové rozhodnutí používejte oficiální operační kanály IZS/HZS.",
      sourceId: "hzs_incidents",
      sourceName: "HZS public incident dispatches",
      license: HZS_INCIDENTS_LICENSE,
      observedAt,
      effectiveAt: observedAt,
      expiresAt,
      validFrom: observedAt,
      validUntil: expiresAt,
      updatedAt: fetchedAt,
      confidence: Math.min(0.95, classification.confidence * geocode.confidence),
      severity: classification.severity,
      status: hzsStatusCode(status),
      urgency: "immediate",
      certainty: "observed",
      fireStatus: layer === "fire" ? "reported" : undefined,
      detectedAt: layer === "fire" ? observedAt : undefined,
      sourceIncident,
      areaName: address || record.location,
      adminLevel: geocode.adminLevel,
      affectedArea: address || record.location,
      code: geocode.code,
      countryCode: geocode.countryCode ?? "CZ",
      detailUrl: record.detailUrl,
      iconHint: classification.iconHint,
      basis: ["hzs_active_dispatch_table", record.feed.id, classification.typeCode],
      metrics: compactMetrics({
        locationConfidence: geocode.confidence
      }),
      tags: compactTags({
        eventType: detail.type ?? record.type,
        subtype: detail.subtype,
        status,
        district: detail.district,
        municipality: detail.municipality,
        municipalityPart: detail.municipalityPart,
        street: detail.street,
        units: detail.units,
        locationPrecision: geocode.precision,
        locationSource: geocode.source,
        geocodeLabel: geocode.label,
        feedId: record.feed.id,
        feedRegion: record.feed.regionName
      }),
      providerProperties: {
        hzs: {
          id: record.id,
          feedId: record.feed.id,
          feedLabel: record.feed.label,
          regionName: record.feed.regionName,
          locationPrecision: geocode.precision,
          locationSource: geocode.source,
          detail
        }
      },
      raw: {
        record: record.raw,
        detail
      }
    })
  );
}

function mapRoadSrtiLodWarning(event: RoadSrtiLodEvent, query: SafetyQuery, fetchedAt: string): SafetyFeature | undefined {
  if (!isPointInBbox(event.lon, event.lat, query.bbox)) {
    return undefined;
  }
  const classification = classifyRoadSrtiEvent(event.typeLabel);
  if (!classification) {
    return undefined;
  }
  const ageSeconds = Math.max(0, Math.round((Date.parse(fetchedAt) - Date.parse(event.observedAt)) / 1000));
  const validUntil = addSeconds(event.observedAt, 2 * 60 * 60);
  const descriptionCs = `${classification.descriptionCs} Poloha je reprezentativní bod z geometrie SRTI/DATEX II.`;
  const descriptionEn = `${classification.descriptionEn} Location is a representative point derived from SRTI/DATEX II geometry.`;

  return makePointFeature({
    id: `warnings:road_srti_lod:${stableToken(event.iri)}`,
    lon: event.lon,
    lat: event.lat,
    layer: "warnings",
    category: classification.category,
    hazardType: "road_incident",
    typeCode: classification.typeCode,
    sourceCode: classification.sourceCode,
    sourceSystem: "NDIC_SRTI_LOD",
    headline: classification.headlineCs,
    description: descriptionCs,
    recommendedAction: classification.recommendedActionCs,
    sourceId: "road_srti_lod",
    sourceName: "NDIC/ŘSD traffic safety events",
    license: ROAD_SRTI_LOD_LICENSE,
    observedAt: event.observedAt,
    effectiveAt: event.observedAt,
    expiresAt: validUntil,
    validFrom: event.observedAt,
    validUntil,
    updatedAt: fetchedAt,
    confidence: classification.confidence,
    severity: classification.severity,
    status: "active",
    urgency: classification.severity === "warning" || classification.severity === "critical" ? "immediate" : "expected",
    certainty: "observed",
    areaName: "silniční síť",
    affectedArea: "silniční síť",
    iconHint: "road-warning",
    basis: ["ndic_srti_lod", classification.typeCode],
    metrics: compactMetrics({
      ageSeconds
    }),
    tags: compactTags({
      srtiType: event.typeLabel,
      srtiTypeUri: event.typeUri,
      locationPrecision: "source_geometry_representative_point",
      sourceSystem: "ndic_srti_lod"
    }),
    localized: {
      cs: {
        headline: classification.headlineCs,
        description: descriptionCs,
        recommendedAction: classification.recommendedActionCs
      },
      en: {
        headline: classification.headlineEn,
        description: descriptionEn,
        recommendedAction: classification.recommendedActionEn
      }
    },
    providerProperties: {
      roadSrti: {
        situationRecord: event.iri,
        type: event.typeLabel,
        typeUri: event.typeUri,
        geometryWkt: event.wkt
      }
    },
    raw: query.includeRaw ? event.raw : undefined
  });
}

async function fetchRoadSrtiLodEvents(config: SafetyDataConfig): Promise<RoadSrtiLodEvent[]> {
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
      const observedAt = normalizeSparqlTimestamp(sparqlValue(binding, "VersionTime"));
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

function classifyHzsIncident(type: string, subtype: string | undefined, description: string | undefined): {
  primaryLayer: SafetyLayerId;
  category: string;
  hazardType: string;
  typeCode: string;
  severity: SafetySeverity;
  confidence: number;
  iconHint: string;
} {
  const text = normalizeCzechKey([type, subtype, description].filter(Boolean).join(" "));
  if (text.includes("pozar")) {
    return { primaryLayer: "fire", category: "active_fire_incident", hazardType: "fire", typeCode: "HZS_FIRE", severity: "warning", confidence: 0.92, iconHint: "fire" };
  }
  if (text.includes("unik nebezpecnych latek") || text.includes("nebezpecn")) {
    return { primaryLayer: "warnings", category: "hazmat_incident", hazardType: "hazmat", typeCode: "HZS_HAZMAT", severity: "warning", confidence: 0.9, iconHint: "hazmat" };
  }
  if (text.includes("dopravni nehoda") || /\bdn\b/.test(text)) {
    return { primaryLayer: "warnings", category: "traffic_accident", hazardType: "traffic_accident", typeCode: "HZS_TRAFFIC_ACCIDENT", severity: "warning", confidence: 0.88, iconHint: "traffic-accident" };
  }
  if (text.includes("zachrana osob") || text.includes("zachrana zvirat")) {
    return { primaryLayer: "warnings", category: "rescue_incident", hazardType: "rescue", typeCode: "HZS_RESCUE", severity: "warning", confidence: 0.86, iconHint: "rescue" };
  }
  if (text.includes("technicka pomoc")) {
    return { primaryLayer: "warnings", category: "technical_assistance", hazardType: "technical_assistance", typeCode: "HZS_TECHNICAL_ASSISTANCE", severity: "advisory", confidence: 0.82, iconHint: "technical-assistance" };
  }
  if (text.includes("plany poplach")) {
    return { primaryLayer: "warnings", category: "false_alarm", hazardType: "false_alarm", typeCode: "HZS_FALSE_ALARM", severity: "info", confidence: 0.84, iconHint: "info" };
  }
  return { primaryLayer: "warnings", category: "emergency_incident", hazardType: "emergency_incident", typeCode: "HZS_INCIDENT", severity: "advisory", confidence: 0.78, iconHint: "warning" };
}

function classifyRoadSrtiEvent(typeLabel: string):
  | {
      category: string;
      typeCode: string;
      sourceCode: string;
      headlineCs: string;
      headlineEn: string;
      descriptionCs: string;
      descriptionEn: string;
      recommendedActionCs: string;
      recommendedActionEn: string;
      severity: SafetySeverity;
      confidence: number;
    }
  | undefined {
  const normalized = typeLabel.toLowerCase().replace(/\s+/g, "");
  const actionCs = "Ověřte průjezdnost v oficiálních dopravních kanálech a zvažte objízdnou trasu.";
  const actionEn = "Verify passability through official traffic channels and consider an alternate route.";

  if (normalized.includes("accident")) {
    return {
      category: "road_accident",
      typeCode: "road.accident",
      sourceCode: "SRTI_ACCIDENT",
      headlineCs: "Dopravní nehoda",
      headlineEn: "Road traffic accident",
      descriptionCs: "NDIC/ŘSD eviduje dopravní nehodu nebo incident s dopadem na provoz.",
      descriptionEn: "NDIC/RSD reports a road accident or incident affecting traffic.",
      recommendedActionCs: actionCs,
      recommendedActionEn: actionEn,
      severity: "warning",
      confidence: 0.86
    };
  }
  if (normalized.includes("closure") || normalized.includes("blocked")) {
    return {
      category: "road_closure",
      typeCode: "road.closure",
      sourceCode: "SRTI_ROAD_CLOSURE",
      headlineCs: "Uzavírka nebo blokace silnice",
      headlineEn: "Road closure or blockage",
      descriptionCs: "NDIC/ŘSD eviduje uzavírku, blokaci nebo omezení průjezdu.",
      descriptionEn: "NDIC/RSD reports a closure, blockage or passability restriction.",
      recommendedActionCs: actionCs,
      recommendedActionEn: actionEn,
      severity: "warning",
      confidence: 0.84
    };
  }
  if (normalized.includes("obstruction")) {
    return {
      category: "road_obstruction",
      typeCode: "road.obstruction",
      sourceCode: "SRTI_ROAD_OBSTRUCTION",
      headlineCs: "Překážka na silnici",
      headlineEn: "Road obstruction",
      descriptionCs: "NDIC/ŘSD eviduje překážku nebo nebezpečí v silničním provozu.",
      descriptionEn: "NDIC/RSD reports an obstruction or road traffic hazard.",
      recommendedActionCs: actionCs,
      recommendedActionEn: actionEn,
      severity: "advisory",
      confidence: 0.82
    };
  }
  if (normalized.includes("weather") || normalized.includes("condition")) {
    return {
      category: "road_weather",
      typeCode: "road.weather_condition",
      sourceCode: "SRTI_ROAD_WEATHER",
      headlineCs: "Nebezpečné podmínky na vozovce",
      headlineEn: "Hazardous road conditions",
      descriptionCs: "NDIC/ŘSD eviduje počasím nebo stavem vozovky ovlivněnou dopravní událost.",
      descriptionEn: "NDIC/RSD reports a weather-related or road-surface traffic safety event.",
      recommendedActionCs: "Přizpůsobte jízdu stavu vozovky a sledujte oficiální dopravní informace.",
      recommendedActionEn: "Adapt driving to road conditions and monitor official traffic information.",
      severity: "advisory",
      confidence: 0.8
    };
  }
  if (normalized.includes("abnormaltraffic") || normalized.includes("traffic")) {
    return {
      category: "road_traffic_abnormal",
      typeCode: "road.abnormal_traffic",
      sourceCode: "SRTI_ABNORMAL_TRAFFIC",
      headlineCs: "Mimořádná dopravní situace",
      headlineEn: "Abnormal traffic situation",
      descriptionCs: "NDIC/ŘSD eviduje mimořádnou dopravní situaci s možným dopadem na průjezdnost.",
      descriptionEn: "NDIC/RSD reports an abnormal traffic situation with potential passability impact.",
      recommendedActionCs: actionCs,
      recommendedActionEn: actionEn,
      severity: "advisory",
      confidence: 0.76
    };
  }
  if (normalized.includes("roadwork") || normalized.includes("maintenance") || normalized.includes("construction")) {
    return {
      category: "roadworks",
      typeCode: "road.roadworks",
      sourceCode: "SRTI_ROADWORKS",
      headlineCs: "Práce na silnici",
      headlineEn: "Roadworks",
      descriptionCs: "NDIC/ŘSD eviduje práce na silnici nebo údržbu s možným dopadem na provoz.",
      descriptionEn: "NDIC/RSD reports roadworks or maintenance with possible traffic impact.",
      recommendedActionCs: actionCs,
      recommendedActionEn: actionEn,
      severity: "info",
      confidence: 0.74
    };
  }
  return undefined;
}

function hzsRequestedLayers(primaryLayer: SafetyLayerId, requestedLayers: SafetyLayerId[]): SafetyLayerId[] {
  const layers: SafetyLayerId[] = [];
  if (requestedLayers.includes(primaryLayer)) {
    layers.push(primaryLayer);
  }
  if (primaryLayer !== "warnings" && requestedLayers.includes("warnings")) {
    layers.push("warnings");
  }
  return layers;
}

function hzsGeocodeCandidates(record: HzsIncidentRecord, detail: HzsIncidentDetail): string[] {
  const locationCity = record.location.split(" - ")[0]?.trim();
  return unique(
    [detail.municipalityPart, detail.municipality, locationCity, detail.district, record.feed.regionName]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))
  );
}

function hzsAddress(record: HzsIncidentRecord, detail: HzsIncidentDetail): string {
  return [detail.street, detail.municipalityPart, detail.municipality, detail.district ? `okres ${detail.district}` : undefined]
    .filter(Boolean)
    .join(", ") || record.location;
}

function hzsDescription(detail: HzsIncidentDetail, status: string): string {
  const parts = [
    detail.subtype ? `Podtyp: ${detail.subtype}.` : undefined,
    detail.description ? `Popis: ${detail.description}.` : undefined,
    status ? `Stav: ${status}.` : undefined,
    detail.units ? `Jednotky: ${detail.units}.` : undefined
  ].filter(Boolean);
  return parts.join(" ");
}

function hzsStatusCode(status: string): string {
  const normalized = normalizeCzechKey(status);
  if (normalized.includes("na miste")) {
    return "on_scene";
  }
  if (normalized.includes("ukoncen")) {
    return "closed";
  }
  if (normalized.includes("vyhlasen") || normalized.includes("vyslan")) {
    return "dispatched";
  }
  return "active";
}

function sectionBetween(value: string, startMarker: string, endMarker: string): string | undefined {
  const start = value.indexOf(startMarker);
  if (start < 0) {
    return undefined;
  }
  const end = value.indexOf(endMarker, start + startMarker.length);
  return end > start ? value.slice(start, end) : value.slice(start);
}

function imageAlt(value: string): string | undefined {
  const match = value.match(/<img\b[^>]*\balt=["']([^"']+)["'][^>]*>/i);
  return match?.[1] ? htmlText(match[1]) : undefined;
}

function linkHref(value: string, baseUrl: string): string | undefined {
  const match = value.match(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i);
  if (!match?.[1]) {
    return undefined;
  }
  try {
    const url = new URL(decodeHtmlEntities(match[1]), baseUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function hzsIncidentIdFromUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.searchParams.get("id") ?? stableToken(value);
  } catch {
    return stableToken(value);
  }
}

function htmlText(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function normalizeMissingText(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || normalizeCzechKey(trimmed) === "nezadan") {
    return undefined;
  }
  return trimmed;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    nbsp: " ",
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    aacute: "á",
    Aacute: "Á",
    ccaron: "č",
    Ccaron: "Č",
    dcaron: "ď",
    Dcaron: "Ď",
    eacute: "é",
    Eacute: "É",
    ecaron: "ě",
    Ecaron: "Ě",
    iacute: "í",
    Iacute: "Í",
    ncaron: "ň",
    Ncaron: "Ň",
    oacute: "ó",
    Oacute: "Ó",
    rcaron: "ř",
    Rcaron: "Ř",
    scaron: "š",
    Scaron: "Š",
    tcaron: "ť",
    Tcaron: "Ť",
    uacute: "ú",
    Uacute: "Ú",
    uring: "ů",
    Uring: "Ů",
    yacute: "ý",
    Yacute: "Ý",
    zcaron: "ž",
    Zcaron: "Ž"
  };
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x")) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (entity.startsWith("#")) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return named[entity] ?? match;
  });
}

function normalizeCzechKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parseHzsRelativeTimestamp(dayLabel: string, timeLabel: string, fetchedAt: string): string | undefined {
  const timeMatch = timeLabel.match(/(\d{1,2}):(\d{2})/);
  if (!timeMatch) {
    return undefined;
  }
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return undefined;
  }
  const current = pragueDateParts(new Date(fetchedAt));
  const normalizedDay = normalizeCzechKey(dayLabel);
  let year = current.year;
  let month = current.month;
  let day = current.day;

  if (normalizedDay === "vcera") {
    const previous = new Date(Date.UTC(year, month - 1, day - 1, 12, 0, 0));
    const parts = pragueDateParts(previous);
    year = parts.year;
    month = parts.month;
    day = parts.day;
  } else {
    const explicit = dayLabel.match(/(\d{1,2})\.\s*(\d{1,2})\.?/);
    if (explicit) {
      day = Number(explicit[1]);
      month = Number(explicit[2]);
      if (Date.UTC(year, month - 1, day) - Date.UTC(current.year, current.month - 1, current.day) > 24 * 60 * 60 * 1000) {
        year -= 1;
      }
    }
  }

  return isoFromPragueParts(year, month, day, hour, minute);
}

function pragueDateParts(date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Prague",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value)
  };
}

function isoFromPragueParts(year: number, month: number, day: number, hour: number, minute: number): string | undefined {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = timeZoneOffsetMinutes(utcGuess, "Europe/Prague");
  const timestamp = utcGuess.getTime() - offset * 60_000;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function timeZoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return (asUtc - date.getTime()) / 60_000;
}

function gdacsItems(parsed: unknown): Record<string, unknown>[] {
  const root = asRecord(parsed);
  const rss = asRecord(root?.rss);
  const channel = asRecord(rss?.channel);
  return toArray(channel?.item)
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

function mapGdacsItem(item: Record<string, unknown>, query: SafetyQuery, fetchedAt: string): SafetyFeature[] {
  const eventType = optionalString(item.eventtype)?.toUpperCase() ?? optionalString(item.subject)?.slice(0, 2).toUpperCase() ?? "UNKNOWN";
  const eventLayer = gdacsPrimaryLayer(eventType);
  const targetLayers = gdacsRequestedLayers(eventLayer, query.layers);
  if (targetLayers.length === 0) {
    return [];
  }

  const eventBbox = parseGdacsBbox(optionalString(item.bbox));
  const point = gdacsMapPoint(item, eventBbox, query.bbox);
  if (!point) {
    return [];
  }

  const eventId = optionalString(item.eventid) ?? optionalString(item.guid) ?? stableToken(JSON.stringify(item));
  const episodeId = optionalString(item.episodeid);
  const alertLevel = optionalString(item.alertlevel);
  const alertScore = optionalNumber(item.alertscore);
  const episodeAlertScore = optionalNumber(item.episodealertscore);
  const publishedAt = normalizeTimestamp(optionalString(item.pubDate));
  const modifiedAt = normalizeTimestamp(optionalString(item.datemodified)) ?? publishedAt;
  const fromDate = normalizeTimestamp(optionalString(item.fromdate));
  const toDate = normalizeTimestamp(optionalString(item.todate));
  const observedAt = modifiedAt ?? fromDate ?? publishedAt ?? fetchedAt;
  const validFrom = fromDate ?? publishedAt ?? observedAt;
  const validUntil = toDate ?? addSeconds(fetchedAt, 24 * 60 * 60);
  const country = optionalString(item.country);
  const iso3 = optionalString(item.iso3);
  const title = optionalString(item.title) ?? `${gdacsEventTypeLabel(eventType)} alert`;
  const link = optionalString(item.link);
  const capUrl = optionalString(item.cap);
  const isCurrent = parseBoolean(item.iscurrent);
  const severity = gdacsSeverity(alertLevel, alertScore);
  const confidence = gdacsConfidence(alertLevel, alertScore, isCurrent);
  const status = isCurrent === false ? "past" : "active";
  const population = asRecord(item.population);
  const severityRecord = asRecord(item.severity);
  const vulnerability = asRecord(item.vulnerability);
  const glide = optionalString(item.glide);
  const bboxTag = eventBbox ? `${eventBbox.west},${eventBbox.south},${eventBbox.east},${eventBbox.north}` : undefined;

  return targetLayers.map((layer) => {
    const category = gdacsCategory(eventType, layer);
    return makePointFeature({
      id: `${layer}:gdacs:${stableToken(`${eventType}:${eventId}:${episodeId ?? ""}:${layer}`)}`,
      lon: point.lon,
      lat: point.lat,
      layer,
      category,
      hazardType: gdacsHazardType(eventType, layer),
      typeCode: eventType,
      sourceCode: optionalString(item.subject),
      sourceSystem: "GDACS",
      headline: title,
      description: optionalString(item.description),
      recommendedAction: "Použijte jako veřejný strategický krizový kontext; lokální opatření ověřujte přes oficiální kanály IZS a příslušné orgány.",
      sourceId: "gdacs_alerts",
      sourceName: "GDACS global disaster alerts",
      license: GDACS_LICENSE,
      observedAt,
      effectiveAt: validFrom,
      expiresAt: validUntil,
      validFrom,
      validUntil,
      updatedAt: modifiedAt ?? observedAt,
      confidence,
      severity,
      status,
      urgency: gdacsUrgency(eventType, severity, isCurrent),
      certainty: gdacsCertainty(isCurrent, severity),
      areaName: country,
      affectedArea: country,
      countryCode: iso3,
      detailUrl: link,
      fireStatus: layer === "fire" ? status : undefined,
      detectedAt: layer === "fire" ? observedAt : undefined,
      sourceIncident: `${eventType}${eventId}`,
      iconHint: layer === "fire" ? "fire" : layer === "flood" ? "flood" : "warning",
      basis: ["gdacs_rss", eventType],
      metrics: compactMetrics({
        alertScore,
        episodeAlertScore,
        gdacsSeverityValue: optionalNumber(severityRecord?.["@_value"]),
        populationValue: optionalNumber(population?.["@_value"]),
        vulnerabilityValue: optionalNumber(vulnerability?.["@_value"]),
        bboxWest: eventBbox?.west,
        bboxSouth: eventBbox?.south,
        bboxEast: eventBbox?.east,
        bboxNorth: eventBbox?.north
      }),
      tags: compactTags({
        eventType,
        eventId,
        episodeId,
        alertLevel,
        country,
        iso3,
        detailUrl: link,
        capUrl,
        glide,
        isCurrent: isCurrent === undefined ? undefined : String(isCurrent),
        gdacsBbox: bboxTag,
        pointBasis: point.basis
      }),
      providerProperties: compactUnknownRecord({
        gdacs: compactUnknownRecord({
          eventType,
          eventId,
          episodeId,
          alertLevel,
          episodeAlertLevel: optionalString(item.episodealertlevel),
          reportUrl: link,
          capUrl,
          iconUrl: optionalString(item.icon),
          mapImageUrl: optionalString(item.mapimage),
          mapLinkUrl: optionalString(item.maplink),
          glide,
          bbox: eventBbox,
          pointBasis: point.basis
        })
      }),
      raw: query.includeRaw ? item : undefined
    });
  });
}

function gdacsRequestedLayers(eventLayer: SafetyLayerId, requestedLayers: SafetyLayerId[]): SafetyLayerId[] {
  const layers: SafetyLayerId[] = [];
  if (requestedLayers.includes(eventLayer)) {
    layers.push(eventLayer);
  }
  if (eventLayer !== "warnings" && requestedLayers.includes("warnings")) {
    layers.push("warnings");
  }
  return Array.from(new Set(layers));
}

function gdacsPrimaryLayer(eventType: string): SafetyLayerId {
  if (eventType === "WF") {
    return "fire";
  }
  if (eventType === "FL") {
    return "flood";
  }
  return "warnings";
}

function gdacsCategory(eventType: string, layer: SafetyLayerId): string {
  if (layer === "fire") {
    return "wildfire_alert";
  }
  if (layer === "flood") {
    return "flood_alert";
  }
  return `gdacs_${gdacsHazardType(eventType, layer)}_alert`;
}

function gdacsHazardType(eventType: string, layer: SafetyLayerId): string {
  if (layer === "fire") {
    return "fire";
  }
  if (layer === "flood") {
    return "flood";
  }
  switch (eventType) {
    case "EQ":
      return "earthquake";
    case "TC":
      return "tropical_cyclone";
    case "VO":
      return "volcano";
    case "DR":
      return "drought";
    case "WF":
      return "fire";
    case "FL":
      return "flood";
    default:
      return "disaster_alert";
  }
}

function gdacsEventTypeLabel(eventType: string): string {
  switch (eventType) {
    case "EQ":
      return "Earthquake";
    case "TC":
      return "Tropical cyclone";
    case "FL":
      return "Flood";
    case "VO":
      return "Volcano";
    case "DR":
      return "Drought";
    case "WF":
      return "Wildfire";
    default:
      return "Disaster";
  }
}

function gdacsSeverity(alertLevel: string | undefined, alertScore: number | undefined): SafetySeverity {
  const normalized = alertLevel?.toLowerCase();
  if (normalized === "red" || (alertScore ?? 0) >= 3) {
    return "critical";
  }
  if (normalized === "orange" || (alertScore ?? 0) >= 2) {
    return "warning";
  }
  if (normalized === "green" || (alertScore ?? 0) >= 1) {
    return "advisory";
  }
  return "info";
}

function gdacsConfidence(alertLevel: string | undefined, alertScore: number | undefined, isCurrent: boolean | undefined): number {
  const base = alertLevel?.toLowerCase() === "red" ? 0.9 : alertLevel?.toLowerCase() === "orange" ? 0.82 : alertLevel?.toLowerCase() === "green" ? 0.68 : 0.55;
  const scoreBoost = alertScore !== undefined ? Math.min(0.1, Math.max(0, alertScore) * 0.02) : 0;
  const currentPenalty = isCurrent === false ? 0.18 : 0;
  return round(Math.max(0.35, Math.min(0.96, base + scoreBoost - currentPenalty)), 2);
}

function gdacsUrgency(eventType: string, severity: SafetySeverity, isCurrent: boolean | undefined): SafetyUrgency {
  if (isCurrent === false) {
    return "past";
  }
  if (severity === "critical" || severity === "warning") {
    return "immediate";
  }
  return eventType === "TC" ? "expected" : "unknown";
}

function gdacsCertainty(isCurrent: boolean | undefined, severity: SafetySeverity): SafetyCertainty {
  if (isCurrent === false) {
    return "observed";
  }
  return severity === "critical" || severity === "warning" ? "likely" : "possible";
}

function gdacsMapPoint(
  item: Record<string, unknown>,
  eventBbox: BoundingBox | undefined,
  queryBbox: BoundingBox
): { lon: number; lat: number; basis: string } | undefined {
  const pointRecord = asRecord(item.Point);
  const lat = optionalNumber(pointRecord?.lat);
  const lon = optionalNumber(pointRecord?.long);
  if (lat !== undefined && lon !== undefined) {
    return isPointInBbox(lon, lat, queryBbox) ? { lon, lat, basis: "geo_point" } : { lon, lat, basis: "geo_point_outside_bbox" };
  }

  const georssPoint = optionalString(item.point);
  if (georssPoint) {
    const parts = georssPoint.split(/\s+/).map((part) => Number(part));
    const georssLat = parts[0];
    const georssLon = parts[1];
    if (typeof georssLon === "number" && typeof georssLat === "number" && Number.isFinite(georssLon) && Number.isFinite(georssLat)) {
      return isPointInBbox(georssLon, georssLat, queryBbox)
        ? { lon: georssLon, lat: georssLat, basis: "georss_point" }
        : { lon: georssLon, lat: georssLat, basis: "georss_point_outside_bbox" };
    }
  }

  if (eventBbox && gdacsBboxIsPreciseEnoughForPoint(eventBbox)) {
    const center = bboxCenter(eventBbox);
    if (isPointInBbox(center.lon, center.lat, queryBbox)) {
      return { ...center, basis: "gdacs_bbox_center" };
    }
  }

  return undefined;
}

function gdacsBboxIsPreciseEnoughForPoint(bbox: BoundingBox): boolean {
  const width = Math.abs(bbox.east - bbox.west);
  const height = Math.abs(bbox.north - bbox.south);
  return width <= 2 && height <= 2;
}

function parseGdacsBbox(value: string | undefined): BoundingBox | undefined {
  if (!value) {
    return undefined;
  }
  const parts = value.split(/\s+/).map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return undefined;
  }
  const [west, east, south, north] = parts as [number, number, number, number];
  if (west > east || south > north) {
    return undefined;
  }
  return { west, south, east, north };
}

async function requestSparqlJson(baseUrl: string, query: string, timeoutMs: number): Promise<SparqlResults> {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      accept: "application/sparql-results+json,application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "CSM-SIM/0.1 safety-data-api"
    },
    body: new URLSearchParams({ query, format: "application/sparql-results+json" }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new HttpRequestError(`POST ${baseUrl} failed with ${response.status}`, baseUrl, response.status);
  }
  return (await response.json()) as SparqlResults;
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

function normalizeSparqlTimestamp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  const normalized = trimmed.includes("T") ? trimmed : trimmed.replace(" ", "T");
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return undefined;
}

type HydroSeries = NonNullable<NonNullable<HydroNowResponse["objList"]>[number]["tsList"]>[number];

function latestObservation(series: HydroSeries | undefined): HydroObservation | undefined {
  return hydroObservations(series)[0];
}

function hydroObservations(series: HydroSeries | undefined): HydroObservation[] {
  const data = series?.tsData ?? [];
  return data
    .map((point) => ({
      observedAt: normalizeTimestamp(optionalString(point.dt)),
      value: optionalNumber(point.value)
    }))
    .filter((point): point is { observedAt: string; value: number } => point.observedAt !== undefined && point.value !== undefined)
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))
    .map((point) => ({ ...point, unit: series?.unit }));
}

function latestForecastTimestamp(seriesList: Array<HydroSeries | undefined>): string | undefined {
  return seriesList
    .flatMap((series) => hydroObservations(series))
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0]?.observedAt;
}

function findHydroStation(stations: HydroStation[], stationId: string): HydroStation | undefined {
  const decodedStationId = safeDecodeURIComponent(stationId);
  return stations.find((station) => station.objId === decodedStationId || station.stationCode === decodedStationId);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hydroDetailWindow(
  query: HydroStationDetailQuery,
  config: SafetyDataConfig,
  generatedAt: string
): { from: string; to: string } {
  const nowMs = Date.parse(generatedAt);
  const from = query.from ?? new Date(nowMs - Math.max(1, config.chmiHydroDetailDefaultPastHours) * 60 * 60 * 1000).toISOString();
  const to = query.to ?? new Date(nowMs + Math.max(0, config.chmiHydroDetailForecastHours) * 60 * 60 * 1000).toISOString();
  return { from, to };
}

function recentBackfillDates(from: string, to: string, maxDays: number, generatedAt: string): string[] {
  const dayLimit = Math.max(0, Math.min(31, Math.trunc(maxDays)));
  if (dayLimit === 0) {
    return [];
  }

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const nowMs = Date.parse(generatedAt);
  if (![fromMs, toMs, nowMs].every(Number.isFinite)) {
    return [];
  }

  const todayStartMs = utcDayStart(nowMs);
  const latestRecentDayMs = todayStartMs - 24 * 60 * 60 * 1000;
  const earliestAllowedMs = todayStartMs - dayLimit * 24 * 60 * 60 * 1000;
  const startMs = utcDayStart(Math.max(fromMs, earliestAllowedMs));
  const endMs = utcDayStart(Math.min(toMs, latestRecentDayMs));
  if (startMs > endMs) {
    return [];
  }

  const dates: string[] = [];
  for (let dayMs = startMs; dayMs <= endMs; dayMs += 24 * 60 * 60 * 1000) {
    dates.push(formatUtcDate(dayMs));
  }
  return dates;
}

function buildHydroStationDetail(
  station: HydroStation,
  records: ChmiHydroHistoryRecord[],
  requestedSeriesIds: HydroSeriesId[],
  window: { from: string; to: string },
  generatedAt: string,
  warnings: string[]
): HydroStationDetail {
  const series = requestedSeriesIds.map((seriesId) => {
    const meta = HYDRO_SERIES_META[seriesId];
    const points = records
      .filter((record) => record.seriesId === seriesId)
      .map((record) => ({
        at: record.observedAt,
        value: round(record.value, 3),
        source: record.sourceKind === "now" ? ("live_now" as const) : ("recent_backfill" as const),
        ingestedAt: record.ingestedAt
      }));
    return {
      id: seriesId,
      label: meta.label,
      unit: points.length > 0 ? normalizeHydroUnit(records.find((record) => record.seriesId === seriesId)?.unit, meta.unit) : meta.unit,
      role: meta.role,
      points
    };
  });

  const detailWarnings = [...warnings];
  if (records.length === 0) {
    detailWarnings.push("No local CHMI hydro observations are available for the requested window yet.");
  }

  return {
    contractVersion: "chmi-hydro-station-detail-v1",
    generatedAt,
    providerId: "sim.safety-data",
    sourceId: "chmi_hydro",
    station: {
      stationId: station.objId,
      stationCode: station.stationCode,
      stationName: station.stationName,
      streamName: station.streamName,
      lat: round(station.lat, 6),
      lon: round(station.lon, 6),
      spaType: station.spaType,
      catchmentAreaKm2: station.catchmentAreaKm2,
      hydrologicalOrder: station.hydrologicalOrder
    },
    window,
    thresholds: {
      waterLevel: {
        unit: "cm",
        dry: station.dryH,
        spa1: station.spa1H,
        spa2: station.spa2H,
        spa3: station.spa3H,
        spa4: station.spa4H
      },
      discharge: {
        unit: "m3/s",
        dry: station.dryQ,
        spa1: station.spa1Q,
        spa2: station.spa2Q,
        spa3: station.spa3Q,
        spa4: station.spa4Q
      }
    },
    series,
    chart: {
      title: `${station.stationName}${station.streamName ? ` - ${station.streamName}` : ""}`,
      currentTime: generatedAt,
      panels: hydroChartPanels(requestedSeriesIds)
    },
    warnings: detailWarnings
  };
}

function hydroChartPanels(seriesIds: HydroSeriesId[]): HydroStationDetail["chart"]["panels"] {
  const requested = new Set(seriesIds);
  const panels: HydroStationDetail["chart"]["panels"] = [];
  if (requested.has("H") || requested.has("H_F")) {
    panels.push({
      id: "water_level",
      title: "Vodní stav",
      yAxis: { label: "vodní stav [cm]", unit: "cm" },
      seriesIds: ["H", "H_F"].filter((seriesId): seriesId is HydroSeriesId => requested.has(seriesId as HydroSeriesId)),
      thresholdSet: "waterLevel",
      forecastSeriesIds: requested.has("H_F") ? ["H_F"] : undefined
    });
  }
  if (requested.has("Q") || requested.has("Q_F")) {
    panels.push({
      id: "discharge",
      title: "Průtok",
      yAxis: { label: "průtok [m3/s]", unit: "m3/s" },
      seriesIds: ["Q", "Q_F"].filter((seriesId): seriesId is HydroSeriesId => requested.has(seriesId as HydroSeriesId)),
      thresholdSet: "discharge",
      forecastSeriesIds: requested.has("Q_F") ? ["Q_F"] : undefined
    });
  }
  if (requested.has("TH")) {
    panels.push({
      id: "temperature",
      title: "Teplota vody",
      yAxis: { label: "teplota vody [°C]", unit: "°C" },
      seriesIds: ["TH"]
    });
  }
  return panels;
}

function hydroDetailUrl(stationId: string): string {
  return `/safety-data/api/v1/hydro/stations/${encodeURIComponent(stationId)}/observations`;
}

function normalizeHydroUnit(unit: string | undefined, fallback: string): string {
  switch (unit) {
    case "CM":
      return "cm";
    case "M3_S":
      return "m3/s";
    case "DEG_C":
      return "°C";
    default:
      return unit ?? fallback;
  }
}

function utcDayStart(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function formatUtcDate(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function hydroTrend(series: HydroSeries | undefined, seriesType: "H" | "Q"): HydroTrend | undefined {
  const [latest, previous] = hydroObservations(series);
  if (!latest || !previous) {
    return undefined;
  }
  const latestMs = Date.parse(latest.observedAt);
  const previousMs = Date.parse(previous.observedAt);
  const deltaHours = Math.max((latestMs - previousMs) / (60 * 60 * 1000), 0);
  if (deltaHours <= 0) {
    return undefined;
  }

  const delta = latest.value - previous.value;
  const ratePerHour = delta / deltaHours;
  const threshold = seriesType === "H" ? 0.5 : Math.max(0.01, Math.abs(previous.value) * 0.02);
  const trend = Math.abs(ratePerHour) < threshold ? "stable" : ratePerHour > 0 ? "rising" : "falling";
  return {
    trend,
    delta: round(delta, 2),
    ratePerHour: round(ratePerHour, 2),
    windowMinutes: Math.round(deltaHours * 60)
  };
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

function floodLevel(waterLevelCm: number | undefined, flowM3s: number | undefined, station: HydroStation): number {
  return Math.max(
    thresholdLevel(waterLevelCm, station.spa1H, station.spa2H, station.spa3H, station.spa4H),
    thresholdLevel(flowM3s, station.spa1Q, station.spa2Q, station.spa3Q, station.spa4Q)
  );
}

function thresholdLevel(value: number | undefined, spa1: number | undefined, spa2: number | undefined, spa3: number | undefined, spa4: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  if (spa4 !== undefined && value >= spa4) {
    return 4;
  }
  if (spa3 !== undefined && value >= spa3) {
    return 3;
  }
  if (spa2 !== undefined && value >= spa2) {
    return 2;
  }
  if (spa1 !== undefined && value >= spa1) {
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

function capSeverity(value: string | undefined, event: string, awarenessLevelCode?: string): SafetySeverity {
  if (isNoWarning(event)) {
    return "info";
  }
  switch (awarenessLevelCode) {
    case "4":
      return "critical";
    case "3":
      return "warning";
    case "2":
      return "advisory";
    case "1":
    case "0":
      return "info";
  }
  switch ((value ?? "").toLowerCase()) {
    case "extreme":
      return "critical";
    case "severe":
      return "warning";
    case "moderate":
      return "advisory";
    case "minor":
      return "info";
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

function firmsDetectedAt(date: string | undefined, time: string | undefined): string | undefined {
  if (!date || !time) {
    return undefined;
  }
  const padded = time.padStart(4, "0");
  const timestamp = `${date}T${padded.slice(0, 2)}:${padded.slice(2, 4)}:00Z`;
  return normalizeTimestamp(timestamp);
}

function firmsConfidence(value: string | undefined): number {
  const text = (value ?? "").trim().toLowerCase();
  const numeric = optionalNumber(text);
  if (numeric !== undefined) {
    return numeric > 1 ? round(Math.max(0, Math.min(100, numeric)) / 100, 2) : round(Math.max(0, Math.min(1, numeric)), 2);
  }
  if (["h", "high"].includes(text)) {
    return 0.88;
  }
  if (["n", "nominal", "medium"].includes(text)) {
    return 0.68;
  }
  if (["l", "low"].includes(text)) {
    return 0.45;
  }
  return 0.55;
}

function fireSeverity(confidence: number, frp: number | undefined): SafetySeverity {
  if ((frp ?? 0) >= 50 || confidence >= 0.9) {
    return "critical";
  }
  if ((frp ?? 0) >= 10 || confidence >= 0.7) {
    return "warning";
  }
  if (confidence >= 0.5) {
    return "advisory";
  }
  return "info";
}

function capStatus(status: string | undefined, msgType: string | undefined): string {
  const normalizedStatus = (status ?? "").toLowerCase();
  const normalizedType = (msgType ?? "").toLowerCase();
  if (normalizedStatus === "actual" && normalizedType === "cancel") {
    return "cancelled";
  }
  if (normalizedStatus === "actual") {
    return "active";
  }
  return normalizedStatus || "active";
}

function weatherHazardType(event: string, headline: string): string {
  const text = `${event} ${headline}`.toLowerCase();
  if (text.includes("wind") || text.includes("vítr") || text.includes("vitr")) {
    return "wind";
  }
  if (text.includes("thunder") || text.includes("bouř") || text.includes("bour")) {
    return "thunderstorm";
  }
  if (text.includes("rain") || text.includes("déšť") || text.includes("dest") || text.includes("sráž")) {
    return "rain";
  }
  if (text.includes("flood") || text.includes("povod")) {
    return "flood";
  }
  if (text.includes("snow") || text.includes("sníh") || text.includes("sneh")) {
    return "snow";
  }
  if (text.includes("ice") || text.includes("náled") || text.includes("naled")) {
    return "ice";
  }
  if (text.includes("heat") || text.includes("teplot") || text.includes("hork")) {
    return "temperature";
  }
  if (text.includes("fire") || text.includes("požár") || text.includes("pozar")) {
    return "fire_weather";
  }
  return "weather_alert";
}

function weatherIconHint(event: string, headline: string): string {
  const hazard = weatherHazardType(event, headline);
  return hazard === "weather_alert" ? "weather-alert" : hazard;
}

function styleHint(layer: SafetyLayerId, severity: SafetySeverity): string {
  switch (layer) {
    case "weather_alerts":
      return `safety-weather-${severity}`;
    case "warnings":
      return `safety-warning-${severity}`;
    case "fire":
      return `safety-fire-${severity}`;
    case "flood":
      return `safety-flood-${severity}`;
    case "boundary_admin":
      return "boundary-admin-v1";
  }
}

function iconHint(layer: SafetyLayerId, category: string): string {
  if (layer === "fire") {
    return "fire";
  }
  if (layer === "flood") {
    return "flood";
  }
  if (layer === "boundary_admin") {
    return "boundary";
  }
  return category.includes("weather") ? "weather-alert" : "warning";
}

function isNoWarning(event: string | undefined, description?: string): boolean {
  const text = `${event ?? ""} ${description ?? ""}`.toLowerCase();
  return (
    text.includes("žádná výstraha") ||
    text.includes("zadna vystraha") ||
    text.includes("žádný výhled") ||
    text.includes("zadny vyhled") ||
    text.includes("no warning") ||
    text.includes("no outlook") ||
    text.includes("no dangerous phenomena")
  );
}

function isInactiveCapInfo(
  event: string | undefined,
  description: string | undefined,
  severity: string | undefined,
  certainty: string | undefined,
  classification?: ChmiAlertClassification
): boolean {
  if (isNoWarning(event, description)) {
    return true;
  }
  if (classification?.isOutlook && isNoWarning(description, event)) {
    return true;
  }
  const normalizedEvent = (event ?? "").toLowerCase();
  return !description && severity?.toLowerCase() === "minor" && certainty?.toLowerCase() === "unlikely" && normalizedEvent.includes("warning");
}

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const [headerLine, ...rows] = lines;
  if (!headerLine) {
    return [];
  }
  const headers = splitCsvLine(headerLine).map((header) => header.trim());
  return rows.map((row) => {
    const values = splitCsvLine(row);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function splitCsvLine(line: string): string[] {
  const output: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === "," && !quoted) {
      output.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  output.push(current);
  return output.map((value) => value.trim());
}

function layerRequested(layers: SafetyLayerId[], featureLayer: SafetyLayerId): boolean {
  return layers.includes(featureLayer);
}

function isWeatherAlertsRequested(layers: SafetyLayerId[]): boolean {
  return layers.includes("weather_alerts");
}

function mapAdminBoundaryRow(row: AdminBoundaryRow, fetchedAt: string, includeRaw: boolean): SafetyFeature | undefined {
  const geometry = parseSafetyGeometry(row.geometry_geojson);
  const adminLevel = optionalNumber(row.admin_level);
  const name = optionalString(row.name) ?? "Administrative boundary";
  const code = optionalString(row.code) ?? optionalString(row.osm_id);
  if (!geometry || adminLevel === undefined) {
    return undefined;
  }

  const observedAt = normalizeTimestamp(row.imported_at instanceof Date ? row.imported_at.toISOString() : optionalString(row.imported_at)) ?? fetchedAt;
  return makeGeometryFeature({
    id: `boundary_admin:admin_boundaries:${stableToken(`${adminLevel}:${code ?? ""}:${row.osm_id}`)}`,
    layer: "boundary_admin",
    category: "admin_boundary",
    hazardType: "admin_boundary",
    headline: name,
    description: `Administrative boundary level ${adminLevel}.`,
    sourceId: "admin_boundaries",
    source: "admin_boundaries",
    sourceName: "OSM PostGIS administrative boundaries",
    license: OSM_ADMIN_BOUNDARY_LICENSE,
    observedAt,
    effectiveAt: observedAt,
    confidence: 0.82,
    severity: "info",
    status: "reference",
    urgency: "unknown",
    certainty: "observed",
    areaName: name,
    adminLevel,
    name,
    code,
    countryCode: optionalString(row.country_code) ?? "CZ",
    styleHint: adminBoundaryStyle(adminLevel),
    iconHint: "boundary",
    basis: ["osm_postgis_admin_boundary", row.source ?? "osm_postgis"],
    geometry,
    tags: compactTags({
      osmId: optionalString(row.osm_id),
      source: optionalString(row.source),
      precision: "postgis_read_model"
    }),
    raw: includeRaw ? { tags: row.tags } : undefined
  });
}

function seedAdminBoundaryFeatures(bbox: BoundingBox, observedAt: string): SafetyFeature[] {
  const czechiaBbox: BoundingBox = { west: 12.09, south: 48.55, east: 18.86, north: 51.06 };
  if (!bboxIntersects(bbox, czechiaBbox)) {
    return [];
  }
  return [
    makePolygonFeature({
      id: "boundary_admin:admin_boundaries:CZ",
      layer: "boundary_admin",
      category: "admin_boundary",
      hazardType: "admin_boundary",
      headline: "Czechia administrative boundary reference",
      description: "Coarse built-in Czechia boundary used until an authoritative PostGIS boundary import is available.",
      sourceId: "admin_boundaries",
      sourceName: "Administrative boundary seed reference",
      license: ADMIN_BOUNDARY_SEED_LICENSE,
      observedAt,
      effectiveAt: observedAt,
      confidence: 0.45,
      severity: "info",
      status: "reference",
      urgency: "unknown",
      certainty: "unknown",
      areaName: "Czechia",
      adminLevel: 2,
      name: "Czechia",
      code: "CZ",
      countryCode: "CZ",
      styleHint: "boundary-admin-country-v1",
      iconHint: "boundary",
      basis: ["sim_seed_boundary", "replace_with_postgis"],
      coordinates: [
        [
          [12.09, 48.55],
          [18.86, 48.55],
          [18.86, 51.06],
          [12.09, 51.06],
          [12.09, 48.55]
        ]
      ],
      tags: { boundaryType: "country", precision: "coarse_seed" }
    })
  ];
}

function boundaryLevelsForBbox(bbox: BoundingBox): { levels: number[]; geometryColumn: AdminBoundaryGeometryColumn } {
  const span = Math.max(Math.abs(bbox.east - bbox.west), Math.abs(bbox.north - bbox.south));
  if (span >= 4) {
    return { levels: [2, 4], geometryColumn: "geom_z5" };
  }
  if (span >= 1) {
    return { levels: [4, 6], geometryColumn: "geom_z8" };
  }
  if (span >= 0.25) {
    return { levels: [6, 7, 8], geometryColumn: "geom_z11" };
  }
  return { levels: [8], geometryColumn: "geom" };
}

function parseSafetyGeometry(value: string | null): SafetyGeometry | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as SafetyGeometry;
    return parsed.type === "Polygon" || parsed.type === "MultiPolygon" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function adminBoundaryStyle(adminLevel: number): string {
  if (adminLevel <= 2) {
    return "boundary-admin-country-v1";
  }
  if (adminLevel <= 4) {
    return "boundary-admin-region-v1";
  }
  if (adminLevel <= 6) {
    return "boundary-admin-district-v1";
  }
  return "boundary-admin-municipality-v1";
}

function roundBbox(bbox: BoundingBox): BoundingBox {
  return {
    west: round(bbox.west, 4),
    south: round(bbox.south, 4),
    east: round(bbox.east, 4),
    north: round(bbox.north, 4)
  };
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

function quoteQualifiedIdentifier(value: string): string {
  return value.split(".").map(quoteIdentifier).join(".");
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
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

function bboxIntersects(a: BoundingBox, b: BoundingBox): boolean {
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
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
