import { XMLParser } from "fast-xml-parser";
import { Pool } from "pg";
import type { SafetyDataConfig } from "./config.js";
import { HttpRequestError, requestJson, requestText } from "./http.js";
import { ManagedResponseCache } from "./response-cache.js";
import type {
  BoundingBox,
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
    new AdminBoundarySource(config).descriptor
  ].map((descriptor) => ({ ...descriptor, enabled: enabled.has(descriptor.sourceId) }));
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
      layers: ["weather_alerts"],
      license: CHMI_OPEN_DATA_LICENSE,
      baseUrl: config.chmiAlertsCapBaseUrl,
      updateCadenceSeconds: 300
    };
  }

  async fetchFeatures(query: SafetyQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!isWeatherAlertsRequested(query.layers)) {
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

    const capLayer = query.layers.includes("warnings") && !query.layers.includes("weather_alerts") ? "warnings" : "weather_alerts";
    const pointFeatures = mapCapAlert(parsed, query, fetchedAt, capUrl, capLayer).filter((feature) => isFeatureInBbox(feature, query.bbox));
    const polygonized = await this.polygonizeCapFeatures(pointFeatures, query);
    const features = polygonized.features.filter((feature) => isFeatureInBbox(feature, query.bbox));
    return { source: this.descriptor, fetchedAt, features: features.slice(0, query.limit), warnings: polygonized.warnings };
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

interface FeatureInput {
  id: string;
  lon: number;
  lat: number;
  layer: SafetyLayerId;
  category: string;
  hazardType?: string;
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
  floodStage?: number | string;
  trend?: string;
  basin?: string;
  affectedArea?: string;
  name?: string;
  code?: string;
  countryCode?: string;
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
    floodStage: input.floodStage,
    trend: input.trend,
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

function mapCapAlert(payload: unknown, query: SafetyQuery, fetchedAt: string, capUrl: string, layer: Extract<SafetyLayerId, "weather_alerts" | "warnings">): SafetyFeature[] {
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
    const icon = weatherIconHint(event, headline);
    const primaryArea = affectedAreas[0];

    return makePointFeature({
      id: `${layer}:chmi_alerts:${stableToken(`${identifier}:${event}:${onset ?? sent}:${index}`)}`,
      lon: center.lon,
      lat: center.lat,
      layer,
      category,
      hazardType: weatherHazardType(event, headline),
      headline,
      description,
      recommendedAction: instruction,
      sourceId: "chmi_alerts",
      sourceName: "CHMI CAP weather warnings",
      license: CHMI_OPEN_DATA_LICENSE,
      observedAt: sent,
      effectiveAt: onset ?? sent,
      expiresAt: expires ?? addSeconds(sent, 24 * 60 * 60),
      confidence: capConfidence(optionalString(info.certainty), severity),
      severity,
      status: capStatus(status, msgType),
      urgency: capUrgency(optionalString(info.urgency)),
      certainty: capCertainty(optionalString(info.certainty)),
      areaName: primaryArea,
      adminLevel: primaryArea ? "cap_area" : "unknown",
      iconHint: icon,
      basis: ["chmi_cap", capUrl],
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
  const waterLevel = latestObservation(waterLevelSeries);
  const flow = latestObservation(flowSeries);
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
    floodStage: floodActivityLevel,
    trend: selectedTrend?.trend ?? "unknown",
    basin: station.hydrologicalOrder,
    affectedArea: station.streamName ? `${station.streamName} - ${station.stationName}` : station.stationName,
    iconHint: "flood",
    basis: ["chmi_hydro_now", station.objId],
    metrics: compactMetrics({
      waterLevelCm: waterLevel?.value,
      flowM3s: flow?.value,
      floodActivityLevel,
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
      spaType: station.spaType,
      hydrologicalOrder: station.hydrologicalOrder,
      trendBasis: selectedTrend ? (waterTrend ? "water_level" : "discharge") : undefined
    }),
    raw: includeRaw ? payload : undefined
  });
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
    case "warnings":
      return `safety-weather-${severity}`;
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
  return text.includes("žádná výstraha") || text.includes("zadna vystraha") || text.includes("no warning");
}

function isInactiveCapInfo(event: string | undefined, description: string | undefined, severity: string | undefined, certainty: string | undefined): boolean {
  if (isNoWarning(event, description)) {
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
  if (featureLayer === "weather_alerts" || featureLayer === "warnings") {
    return isWeatherAlertsRequested(layers);
  }
  return layers.includes(featureLayer);
}

function isWeatherAlertsRequested(layers: SafetyLayerId[]): boolean {
  return layers.includes("weather_alerts") || layers.includes("warnings");
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
