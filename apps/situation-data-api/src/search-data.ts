import { createHash } from "node:crypto";
import { Pool } from "pg";
import type { SituationDataConfig } from "./config.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import { ChmiWeatherRadarSource } from "./sources.js";
import { WEATHER_FORECAST_SOURCE_ID, WeatherForecastSource } from "./weather-forecast.js";
import type { BoundingBox, SituationFeature, SituationGeometry, SituationLayerId } from "./types.js";

export type SearchEntityType =
  | "police_station"
  | "fire_station"
  | "hospital"
  | "medical_emergency"
  | "hydro_station"
  | "hydro_measurement"
  | "weather_forecast"
  | "weather_nowcast"
  | "weather_radar"
  | "thunderstorm_risk"
  | "weather_warning"
  | "safety_alert"
  | "fire_incident"
  | "flood_risk_area"
  | "road_closure"
  | "shelter"
  | "evacuation_point"
  | "municipality"
  | "district"
  | "region"
  | "critical_infrastructure"
  | "public_resource";

export type SearchSourceAuthority = "official" | "internal_verified" | "partner_verified" | "reference" | "community_verified" | "community_unverified" | "modelled" | "unknown";
export type SearchDataQuality = "official_observed" | "official_warning" | "verified_reference" | "reference" | "modelled" | "mixed" | "unknown";

export interface SearchCoordinate {
  lat: number;
  lon: number;
}

export interface SearchEntity {
  contractVersion: "sim-search-source-v1";
  providerId: "sim.search-data";
  providerEntityId: string;
  sourceSystem: string;
  sourceEntityId: string;
  entityType: SearchEntityType;
  entitySubtype?: string;
  title: string;
  summary: string;
  searchableText: string;
  aliases: string[];
  localized: {
    cs: { title: string; summary: string };
    en?: { title: string; summary: string };
  };
  geometry: SituationGeometry;
  centroid: SearchCoordinate;
  address: {
    countryCode: string;
    region?: string;
    district?: string;
    municipality?: string;
    street?: string;
  };
  status: "active" | "inactive" | "expired" | "unknown";
  severity: "info" | "advisory" | "warning" | "critical" | null;
  confidence: number;
  dataQuality: SearchDataQuality;
  sourceAuthority: SearchSourceAuthority;
  classification: "PUBLIC" | "INTERNAL" | "RESTRICTED";
  handling: string[];
  visibility: "cop_internal" | "restricted" | "public";
  allowedUse: string[];
  observedAt: string | null;
  validFrom: string | null;
  validUntil: string | null;
  updatedAt: string;
  expiresAt: string | null;
  stale: boolean;
  sourceRevision: string;
  layerIds: string[];
  tags: string[];
  metrics: Record<string, number | string | boolean>;
  positionQuality: {
    accuracy: "exact" | "centroid" | "approximate" | "unknown";
    source: string;
  };
  providerProperties: Record<string, unknown>;
  deleted: false;
}

export interface SearchEntityFeed {
  contractVersion: "sim-search-source-v1";
  providerId: "sim.search-data";
  generatedAt: string;
  query: {
    updatedSince?: string;
    cursor?: string;
    limit: number;
    entityTypes: SearchEntityType[];
    sourceSystems: string[];
    includeDeleted: boolean;
  };
  summary: {
    entityCount: number;
    returnedCount: number;
    staleEntityCount: number;
    deletedCount: number;
    warningCount: number;
  };
  entities: SearchEntity[];
  nextCursor?: string;
  warnings: string[];
}

export interface SearchQueryRequest {
  text?: string;
  entityTypes?: SearchEntityType[];
  sourceSystems?: string[];
  center?: SearchCoordinate;
  radiusM?: number;
  bbox?: BoundingBox | null;
  validAt?: string;
  includeStale?: boolean;
  limit?: number;
}

interface OsmPoiSearchRow {
  osm_id: string;
  osm_type: string;
  category: string;
  name: string | null;
  lon: number | string;
  lat: number | string;
  tags: Record<string, unknown> | null;
  imported_at: Date | string | null;
  region_name: string | null;
  district_name: string | null;
  municipality_name: string | null;
}

interface OsmAdminSearchRow {
  osm_id: string;
  admin_level: number | string;
  name: string | null;
  code: string | null;
  country_code: string | null;
  geometry_geojson: unknown;
  centroid_lon: number | string;
  centroid_lat: number | string;
  tags: Record<string, unknown> | null;
  imported_at: Date | string | null;
}

interface SafetyFeatureCollection {
  features?: SafetyFeature[];
  warnings?: string[];
  summary?: {
    staleFeatureCount?: number;
    warningCount?: number;
  };
}

interface SafetyFeature {
  type: "Feature";
  id?: string | number;
  geometry?: SituationGeometry;
  properties?: Record<string, unknown>;
}

interface CollectOptions {
  bbox: BoundingBox;
  entityTypes?: SearchEntityType[];
  sourceSystems?: string[];
  limit: number;
  updatedSince?: string;
  includeStale: boolean;
  validAt?: string;
}

const CONTRACT_VERSION = "sim-search-source-v1" as const;
const PROVIDER_ID = "sim.search-data" as const;
const CZECHIA_BBOX: BoundingBox = { west: 11.8, south: 48.5, east: 19.2, north: 51.2 };
const SEARCH_ENTITY_TYPES: SearchEntityType[] = [
  "police_station",
  "fire_station",
  "hospital",
  "medical_emergency",
  "hydro_station",
  "hydro_measurement",
  "weather_forecast",
  "weather_nowcast",
  "weather_radar",
  "thunderstorm_risk",
  "weather_warning",
  "safety_alert",
  "fire_incident",
  "flood_risk_area",
  "road_closure",
  "shelter",
  "evacuation_point",
  "municipality",
  "district",
  "region",
  "critical_infrastructure",
  "public_resource"
];
const OSM_POI_ENTITY_TYPES = new Set<SearchEntityType>([
  "police_station",
  "fire_station",
  "hospital",
  "medical_emergency",
  "shelter",
  "evacuation_point",
  "critical_infrastructure",
  "public_resource"
]);
const OSM_ADMIN_ENTITY_TYPES = new Set<SearchEntityType>(["municipality", "district", "region"]);
const SAFETY_ENTITY_TYPES = new Set<SearchEntityType>(["hydro_station", "hydro_measurement", "weather_warning", "safety_alert", "fire_incident", "flood_risk_area", "road_closure"]);
const SAFETY_SOURCE_SYSTEMS = ["safety_data", "chmi_alerts", "chmi_hydro", "nasa_firms", "gdacs_alerts", "hzs_incidents", "municipal_alerts", "road_srti_lod"];
const WEATHER_FORECAST_ENTITY_TYPES = new Set<SearchEntityType>(["weather_forecast"]);
const WEATHER_RADAR_ENTITY_TYPES = new Set<SearchEntityType>(["weather_radar", "weather_nowcast", "thunderstorm_risk"]);
const OSM_POI_CATEGORIES = [
  "police",
  "fire_station",
  "hospital",
  "healthcare_hospital",
  "clinic",
  "healthcare_clinic",
  "doctors",
  "healthcare_doctor",
  "ambulance_station",
  "defibrillator",
  "pharmacy",
  "healthcare_pharmacy",
  "shelter",
  "assembly_point",
  "siren",
  "fire_hydrant",
  "communications_tower",
  "community_centre",
  "townhall"
];

export class SearchDataService {
  private readonly cache: ManagedResponseCache<SearchEntityFeed>;
  private pool?: Pool;
  private weatherForecastSource?: WeatherForecastSource;
  private chmiWeatherRadarSource?: ChmiWeatherRadarSource;

  constructor(private readonly config: SituationDataConfig) {
    this.cache = new ManagedResponseCache<SearchEntityFeed>({
      ttlMs: Math.max(10, config.searchDataCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.staleIfErrorSeconds, config.searchDataCacheTtlSeconds) * 1000,
      maxEntries: Math.max(16, config.searchDataCacheMaxEntries)
    });
  }

  taxonomy() {
    const generatedAt = new Date().toISOString();
    return {
      contractVersion: CONTRACT_VERSION,
      providerId: PROVIDER_ID,
      generatedAt,
      entityTypes: SEARCH_ENTITY_TYPES.map((entityType) => ({
        entityType,
        label: entityTypeLabel(entityType),
        layerIds: layerIdsForEntityType(entityType),
        sourceSystems: sourceSystemsForEntityType(entityType)
      })),
      severities: ["info", "advisory", "warning", "critical"],
      statuses: ["active", "inactive", "expired", "unknown"],
      sourceAuthorities: ["official", "internal_verified", "partner_verified", "reference", "community_verified", "community_unverified", "modelled", "unknown"],
      dataQualities: ["official_observed", "official_warning", "verified_reference", "reference", "modelled", "mixed", "unknown"],
      visibility: ["cop_internal", "restricted", "public"],
      classification: ["PUBLIC", "INTERNAL", "RESTRICTED"],
      supportedLayers: Array.from(new Set(SEARCH_ENTITY_TYPES.flatMap(layerIdsForEntityType))).sort(),
      notes: [
        "SIM provides normalized source entities for COP indexing and RAG grounding.",
        "SIM does not implement AI chat, user authorization, final map actions or crisis recommendations.",
        "OSM/reference objects are not promoted to official operational state."
      ]
    };
  }

  cacheStats(): ManagedResponseCacheStats {
    return this.cache.stats();
  }

  async entities(query: {
    updatedSince?: string;
    cursor?: string;
    limit?: number;
    entityTypes?: SearchEntityType[];
    sourceSystems?: string[];
    includeDeleted?: boolean;
  }): Promise<SearchEntityFeed> {
    const limit = clampInteger(query.limit, 1000, 1, this.config.searchDataMaxLimit);
    const cursor = parseCursor(query.cursor);
    const entityTypes = normalizeEntityTypes(query.entityTypes);
    const sourceSystems = normalizeStringFilters(query.sourceSystems);
    const updatedSince = validIso(query.updatedSince);
    const includeDeleted = query.includeDeleted === true;
    const cacheKey = JSON.stringify({
      operation: "entities",
      updatedSince,
      cursor,
      limit,
      entityTypes,
      sourceSystems,
      includeDeleted
    });
    return this.cache.getOrLoad(cacheKey, async () => {
      const collected = await this.collectEntities({
        bbox: CZECHIA_BBOX,
        entityTypes,
        sourceSystems,
        limit: Math.max(limit + cursor.offset + 100, limit),
        updatedSince,
        includeStale: true
      });
      const sorted = collected.entities.sort(compareEntitiesForFeed);
      const paged = sorted.slice(cursor.offset, cursor.offset + limit);
      const nextCursor = cursor.offset + limit < sorted.length ? encodeCursor({ offset: cursor.offset + limit }) : undefined;
      const warnings = [...collected.warnings];
      if (includeDeleted) {
        warnings.push("SIM search-data v1 accepts includeDeleted but does not emit tombstones until a persistent search index state is introduced.");
      }
      return {
        contractVersion: CONTRACT_VERSION,
        providerId: PROVIDER_ID,
        generatedAt: new Date().toISOString(),
        query: {
          updatedSince,
          cursor: query.cursor,
          limit,
          entityTypes,
          sourceSystems,
          includeDeleted
        },
        summary: {
          entityCount: sorted.length,
          returnedCount: paged.length,
          staleEntityCount: sorted.filter((entity) => entity.stale).length,
          deletedCount: 0,
          warningCount: warnings.length
        },
        entities: paged,
        nextCursor,
        warnings
      };
    });
  }

  async getEntity(providerEntityId: string): Promise<SearchEntity | undefined> {
    if (!providerEntityId) {
      return undefined;
    }
    if (providerEntityId.startsWith("osm_poi:")) {
      const rows = await this.fetchOsmPoiRows({ bbox: CZECHIA_BBOX, limit: 1, entityTypes: SEARCH_ENTITY_TYPES, includeStale: true, providerEntityId });
      return rows.map((row) => mapOsmPoiEntity(row)).find(Boolean);
    }
    if (providerEntityId.startsWith("osm_admin:")) {
      const rows = await this.fetchOsmAdminRows({ bbox: CZECHIA_BBOX, limit: 1, entityTypes: SEARCH_ENTITY_TYPES, includeStale: true, providerEntityId });
      return rows.map((row) => mapOsmAdminEntity(row)).find(Boolean);
    }
    if (providerEntityId.startsWith("safety:")) {
      const collected = await this.collectEntities({
        bbox: CZECHIA_BBOX,
        limit: this.config.searchDataMaxLimit,
        includeStale: true
      });
      return collected.entities.find((entity) => entity.providerEntityId === providerEntityId);
    }
    if (providerEntityId.startsWith("weather_forecast:") || providerEntityId.startsWith("weather_radar:")) {
      const collected = await this.collectEntities({
        bbox: CZECHIA_BBOX,
        limit: this.config.searchDataMaxLimit,
        includeStale: true
      });
      return collected.entities.find((entity) => entity.providerEntityId === providerEntityId);
    }
    return undefined;
  }

  async query(request: SearchQueryRequest): Promise<SearchEntityFeed> {
    const limit = clampInteger(request.limit, 20, 1, this.config.searchDataMaxLimit);
    const entityTypes = normalizeEntityTypes(request.entityTypes);
    const sourceSystems = normalizeStringFilters(request.sourceSystems);
    const bbox = request.bbox ?? (request.center ? bboxAroundPoint(request.center, request.radiusM ?? 25_000) : CZECHIA_BBOX);
    const validAt = validIso(request.validAt);
    const text = normalizeSearchText(request.text ?? "");
    const collected = await this.collectEntities({
      bbox,
      entityTypes,
      sourceSystems,
      limit: Math.max(limit * 8, 100),
      includeStale: request.includeStale === true,
      validAt
    });
    const scored = collected.entities
      .filter((entity) => (request.includeStale === true ? true : !entity.stale))
      .filter((entity) => (validAt ? entityValidAt(entity, validAt) : true))
      .filter((entity) => (request.center && request.radiusM ? distanceToEntityMeters(request.center, entity) <= request.radiusM : true))
      .map((entity) => ({ entity, score: scoreEntity(entity, text, request.center) }))
      .filter((item) => (text ? item.score > 0 : true))
      .sort((left, right) => right.score - left.score || compareEntitiesForFeed(left.entity, right.entity))
      .slice(0, limit)
      .map((item) => item.entity);

    return {
      contractVersion: CONTRACT_VERSION,
      providerId: PROVIDER_ID,
      generatedAt: new Date().toISOString(),
      query: {
        updatedSince: undefined,
        cursor: undefined,
        limit,
        entityTypes,
        sourceSystems,
        includeDeleted: false
      },
      summary: {
        entityCount: collected.entities.length,
        returnedCount: scored.length,
        staleEntityCount: scored.filter((entity) => entity.stale).length,
        deletedCount: 0,
        warningCount: collected.warnings.length
      },
      entities: scored,
      warnings: collected.warnings
    };
  }

  async observability() {
    const generatedAt = new Date().toISOString();
    const sourceStatuses = await Promise.all([this.osmStatus(), this.safetyStatus(), this.weatherForecastStatus(), this.weatherRadarStatus()]);
    const degradedSourceCount = sourceStatuses.filter((source) => source.status === "degraded").length;
    const cache = this.cache.stats();
    return {
      serviceId: "search-data-api",
      contractVersion: CONTRACT_VERSION,
      providerId: PROVIDER_ID,
      generatedAt,
      status: "ok",
      dataQualityStatus: degradedSourceCount > 0 ? "degraded" : "ok",
      degradedSourceCount,
      sources: sourceStatuses,
      cache: {
        entries: cache.entries,
        inflight: cache.inflight,
        maxEntries: cache.maxEntries,
        hits: cache.hits,
        misses: cache.misses,
        hitRate: cache.hits + cache.misses > 0 ? round(cache.hits / (cache.hits + cache.misses), 4) : 0,
        staleHits: cache.staleHits,
        refreshes: cache.refreshes,
        errors: cache.errors,
        evictions: cache.evictions
      },
      capabilities: {
        incrementalSync: true,
        cursorPagination: true,
        deletedTombstones: false,
        providerLocalQuery: true,
        wholeCountrySearch: true,
        browserDirectAccess: false
      }
    };
  }

  private async collectEntities(options: CollectOptions): Promise<{ entities: SearchEntity[]; warnings: string[] }> {
    const warnings: string[] = [];
    const entityTypes = options.entityTypes ?? SEARCH_ENTITY_TYPES;
    const [poiResult, adminResult, safetyResult, forecastResult, radarResult] = await Promise.allSettled([
      this.shouldFetchOsmPoi(entityTypes, options.sourceSystems) ? this.fetchOsmPoiRows(options).then((rows) => rows.map(mapOsmPoiEntity).filter(isEntity)) : Promise.resolve([]),
      this.shouldFetchOsmAdmin(entityTypes, options.sourceSystems) ? this.fetchOsmAdminRows(options).then((rows) => rows.map(mapOsmAdminEntity).filter(isEntity)) : Promise.resolve([]),
      this.shouldFetchSafety(entityTypes, options.sourceSystems) ? this.fetchSafetyEntities(options) : Promise.resolve([]),
      this.shouldFetchWeatherForecast(entityTypes, options.sourceSystems) ? this.fetchWeatherForecastEntities(options) : Promise.resolve([]),
      this.shouldFetchWeatherRadar(entityTypes, options.sourceSystems) ? this.fetchWeatherRadarEntities(options) : Promise.resolve([])
    ]);
    const entities: SearchEntity[] = [];
    for (const result of [poiResult, adminResult, safetyResult, forecastResult, radarResult]) {
      if (result.status === "fulfilled") {
        entities.push(...result.value);
      } else {
        warnings.push(result.reason instanceof Error ? result.reason.message : "Unknown search-data source failure.");
      }
    }
    const unique = deduplicateEntities(entities)
      .filter((entity) => (options.updatedSince ? Date.parse(entity.updatedAt) > Date.parse(options.updatedSince) : true))
      .filter((entity) => (options.includeStale ? true : !entity.stale))
      .filter((entity) => (options.validAt ? entityValidAt(entity, options.validAt) : true))
      .filter((entity) => entityTypes.includes(entity.entityType))
      .filter((entity) => (options.sourceSystems?.length ? options.sourceSystems.includes(entity.sourceSystem) : true));
    return { entities: unique, warnings };
  }

  private shouldFetchOsmPoi(entityTypes: SearchEntityType[], sourceSystems?: string[]): boolean {
    return Boolean(this.config.osmPostgisConnectionString) && sourceAllowed("osm_reference", sourceSystems) && entityTypes.some((type) => OSM_POI_ENTITY_TYPES.has(type));
  }

  private shouldFetchOsmAdmin(entityTypes: SearchEntityType[], sourceSystems?: string[]): boolean {
    return Boolean(this.config.osmPostgisConnectionString) && sourceAllowed("osm_reference", sourceSystems) && entityTypes.some((type) => OSM_ADMIN_ENTITY_TYPES.has(type));
  }

  private shouldFetchSafety(entityTypes: SearchEntityType[], sourceSystems?: string[]): boolean {
    return this.config.enabledSources.includes("safety_data") && sourceSystemsAllowAny(SAFETY_SOURCE_SYSTEMS, sourceSystems) && entityTypes.some((type) => SAFETY_ENTITY_TYPES.has(type));
  }

  private shouldFetchWeatherForecast(entityTypes: SearchEntityType[], sourceSystems?: string[]): boolean {
    return this.config.enabledSources.includes(WEATHER_FORECAST_SOURCE_ID) && sourceAllowed(WEATHER_FORECAST_SOURCE_ID, sourceSystems) && entityTypes.some((type) => WEATHER_FORECAST_ENTITY_TYPES.has(type));
  }

  private shouldFetchWeatherRadar(entityTypes: SearchEntityType[], sourceSystems?: string[]): boolean {
    return this.config.enabledSources.includes("chmi_weather_radar") && sourceAllowed("chmi_weather_radar", sourceSystems) && entityTypes.some((type) => WEATHER_RADAR_ENTITY_TYPES.has(type));
  }

  private async fetchOsmPoiRows(options: CollectOptions & { providerEntityId?: string }): Promise<OsmPoiSearchRow[]> {
    if (!this.config.osmPostgisConnectionString) {
      return [];
    }
    const providerParts = options.providerEntityId?.split(":");
    const exact = providerParts?.[0] === "osm_poi" ? { osmType: providerParts[1], osmId: providerParts[2], category: providerParts[3] } : undefined;
    const categories = categoriesForEntityTypes(options.entityTypes ?? SEARCH_ENTITY_TYPES);
    if (categories.length === 0 && !exact) {
      return [];
    }
    const pool = this.getPool();
    const table = quoteQualifiedIdentifier(this.config.osmPostgisTable, "OSM_POSTGIS_TABLE");
    const boundaryTable = quoteQualifiedIdentifier(this.config.osmPostgisAdminBoundaryTable, "OSM_POSTGIS_ADMIN_BOUNDARY_TABLE");
    const sql = `
      select
        p.osm_id::text,
        p.osm_type,
        p.category,
        p.name,
        p.lon,
        p.lat,
        p.tags,
        p.imported_at,
        (
          select b.name from ${boundaryTable} b
          where b.admin_level = 4 and st_contains(b.geom, p.geom)
          order by st_area(b.geom) asc
          limit 1
        ) as region_name,
        (
          select b.name from ${boundaryTable} b
          where b.admin_level = 6 and st_contains(b.geom, p.geom)
          order by st_area(b.geom) asc
          limit 1
        ) as district_name,
        (
          select b.name from ${boundaryTable} b
          where b.admin_level = 8 and st_contains(b.geom, p.geom)
          order by st_area(b.geom) asc
          limit 1
        ) as municipality_name
      from ${table} p
      where p.geom && st_makeenvelope($1, $2, $3, $4, 4326)
        and ($5::text[] is null or p.category = any($5::text[]))
        and ($6::text is null or p.osm_type = $6)
        and ($7::text is null or p.osm_id::text = $7)
        and ($8::text is null or p.category = $8)
      order by
        case p.category
          when 'hospital' then 1
          when 'healthcare_hospital' then 2
          when 'fire_station' then 3
          when 'police' then 4
          when 'ambulance_station' then 5
          else 20
        end,
        p.name nulls last,
        p.osm_id
      limit $9
    `;
    const result = await pool.query<OsmPoiSearchRow>(sql, [
      options.bbox.west,
      options.bbox.south,
      options.bbox.east,
      options.bbox.north,
      exact ? null : categories,
      exact?.osmType ?? null,
      exact?.osmId ?? null,
      exact?.category ?? null,
      Math.max(1, Math.min(this.config.searchDataMaxLimit, options.limit))
    ]);
    return result.rows;
  }

  private async fetchOsmAdminRows(options: CollectOptions & { providerEntityId?: string }): Promise<OsmAdminSearchRow[]> {
    if (!this.config.osmPostgisConnectionString) {
      return [];
    }
    const providerParts = options.providerEntityId?.split(":");
    const exact = providerParts?.[0] === "osm_admin" ? { adminLevel: Number(providerParts[1]), osmId: providerParts[2] } : undefined;
    const levels = adminLevelsForEntityTypes(options.entityTypes ?? SEARCH_ENTITY_TYPES);
    if (levels.length === 0 && !exact) {
      return [];
    }
    const pool = this.getPool();
    const table = quoteQualifiedIdentifier(this.config.osmPostgisAdminBoundaryTable, "OSM_POSTGIS_ADMIN_BOUNDARY_TABLE");
    const sql = `
      select
        osm_id::text,
        admin_level,
        name,
        code,
        country_code,
        st_asgeojson(geom_z11)::jsonb as geometry_geojson,
        st_x(st_pointonsurface(geom))::double precision as centroid_lon,
        st_y(st_pointonsurface(geom))::double precision as centroid_lat,
        tags,
        imported_at
      from ${table}
      where geom && st_makeenvelope($1, $2, $3, $4, 4326)
        and ($5::integer[] is null or admin_level = any($5::integer[]))
        and ($6::integer is null or admin_level = $6)
        and ($7::text is null or osm_id::text = $7)
      order by admin_level, name nulls last, osm_id
      limit $8
    `;
    const result = await pool.query<OsmAdminSearchRow>(sql, [
      options.bbox.west,
      options.bbox.south,
      options.bbox.east,
      options.bbox.north,
      exact ? null : levels,
      Number.isFinite(exact?.adminLevel) ? exact?.adminLevel : null,
      exact?.osmId ?? null,
      Math.max(1, Math.min(this.config.searchDataMaxLimit, options.limit))
    ]);
    return result.rows;
  }

  private async fetchSafetyEntities(options: CollectOptions): Promise<SearchEntity[]> {
    const url = new URL(`${trimTrailingSlash(this.config.safetyDataBaseUrl)}/api/v1/features`);
    url.searchParams.set("bbox", `${options.bbox.west},${options.bbox.south},${options.bbox.east},${options.bbox.north}`);
    url.searchParams.set("layers", "weather_alerts,warnings,fire,flood");
    url.searchParams.set("limit", String(Math.max(1, Math.min(this.config.searchDataMaxLimit, options.limit))));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`safety-data search source returned HTTP ${response.status}.`);
      }
      const body = (await response.json()) as SafetyFeatureCollection;
      return (body.features ?? []).map(mapSafetyEntity).filter(isEntity);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchWeatherForecastEntities(options: CollectOptions): Promise<SearchEntity[]> {
    this.weatherForecastSource ??= new WeatherForecastSource(this.config);
    const result = await this.weatherForecastSource.fetchFeatures({
      bbox: options.bbox,
      layers: ["weather_forecast_area"],
      sourceIds: [WEATHER_FORECAST_SOURCE_ID],
      limit: Math.max(1, Math.min(64, options.limit)),
      includeRaw: false
    });
    return result.features.map(mapWeatherForecastEntity).filter(isEntity);
  }

  private async fetchWeatherRadarEntities(options: CollectOptions): Promise<SearchEntity[]> {
    this.chmiWeatherRadarSource ??= new ChmiWeatherRadarSource(this.config);
    const layers = radarLayersForEntityTypes(options.entityTypes ?? SEARCH_ENTITY_TYPES);
    const result = await this.chmiWeatherRadarSource.fetchFeatures({
      bbox: options.bbox,
      layers,
      sourceIds: ["chmi_weather_radar"],
      limit: Math.max(1, Math.min(20, options.limit)),
      includeRaw: false
    });
    return result.features.map(mapWeatherRadarEntity).filter(isEntity);
  }

  private async osmStatus() {
    if (!this.config.osmPostgisConnectionString) {
      return {
        sourceSystem: "osm_reference",
        status: "degraded",
        dataQualityStatus: "degraded",
        entityCount: 0,
        staleCount: 0,
        warnings: ["OSM_POSTGIS_DATABASE_URL is not configured; reference search entities are unavailable."]
      };
    }
    try {
      const pool = this.getPool();
      const poiTable = quoteQualifiedIdentifier(this.config.osmPostgisTable, "OSM_POSTGIS_TABLE");
      const boundaryTable = quoteQualifiedIdentifier(this.config.osmPostgisAdminBoundaryTable, "OSM_POSTGIS_ADMIN_BOUNDARY_TABLE");
      const [poi, boundary] = await Promise.all([
        pool.query<{ count: string; imported_at: Date | string | null }>(`select count(*)::text, max(imported_at) as imported_at from ${poiTable}`),
        pool.query<{ count: string; imported_at: Date | string | null }>(`select count(*)::text, max(imported_at) as imported_at from ${boundaryTable}`)
      ]);
      const count = Number(poi.rows[0]?.count ?? 0) + Number(boundary.rows[0]?.count ?? 0);
      return {
        sourceSystem: "osm_reference",
        status: count > 0 ? "ok" : "degraded",
        dataQualityStatus: count > 0 ? "ok" : "degraded",
        entityCount: count,
        staleCount: 0,
        lastSuccessAt: newestIsoTimestamp(normalizeTimestamp(poi.rows[0]?.imported_at), normalizeTimestamp(boundary.rows[0]?.imported_at)),
        warnings: count > 0 ? [] : ["OSM search read-model tables are empty."]
      };
    } catch (error) {
      return {
        sourceSystem: "osm_reference",
        status: "degraded",
        dataQualityStatus: "degraded",
        entityCount: 0,
        staleCount: 0,
        warnings: [error instanceof Error ? error.message : "Unknown OSM search status failure."]
      };
    }
  }

  private async safetyStatus() {
    if (!this.config.enabledSources.includes("safety_data")) {
      return {
        sourceSystem: "safety_data",
        status: "degraded",
        dataQualityStatus: "degraded",
        entityCount: 0,
        staleCount: 0,
        warnings: ["safety_data is not enabled in SITUATION_DATA_ENABLED_SOURCES; dynamic search entities are unavailable."]
      };
    }
    try {
      const url = new URL(`${trimTrailingSlash(this.config.safetyDataBaseUrl)}/api/v1/observability`);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) {
        throw new Error(`safety-data observability returned HTTP ${response.status}.`);
      }
      const body = (await response.json()) as Record<string, unknown>;
      const lastResult = asRecord(body.lastResult);
      return {
        sourceSystem: "safety_data",
        status: body.status === "ok" ? "ok" : "degraded",
        dataQualityStatus: body.status === "ok" ? "ok" : "degraded",
        entityCount: numberValue(lastResult?.featureCount) ?? 0,
        staleCount: numberValue(lastResult?.staleFeatureCount) ?? 0,
        lastSuccessAt: stringValue(body.generatedAt),
        warnings: body.status === "ok" ? [] : ["safety-data observability is degraded."]
      };
    } catch (error) {
      return {
        sourceSystem: "safety_data",
        status: "degraded",
        dataQualityStatus: "degraded",
        entityCount: 0,
        staleCount: 0,
        warnings: [error instanceof Error ? error.message : "Unknown safety search status failure."]
      };
    }
  }

  private async weatherForecastStatus() {
    if (!this.config.enabledSources.includes(WEATHER_FORECAST_SOURCE_ID)) {
      return {
        sourceSystem: WEATHER_FORECAST_SOURCE_ID,
        status: "degraded",
        dataQualityStatus: "degraded",
        entityCount: 0,
        staleCount: 0,
        warnings: ["weather_forecast is not enabled in SITUATION_DATA_ENABLED_SOURCES; forecast search entities are unavailable."]
      };
    }
    return {
      sourceSystem: WEATHER_FORECAST_SOURCE_ID,
      status: "ok",
      dataQualityStatus: "ok",
      entityCount: 0,
      staleCount: 0,
      backend: "sim-weather-forecast-open-meteo",
      warnings: []
    };
  }

  private async weatherRadarStatus() {
    if (!this.config.enabledSources.includes("chmi_weather_radar")) {
      return {
        sourceSystem: "chmi_weather_radar",
        status: "degraded",
        dataQualityStatus: "degraded",
        entityCount: 0,
        staleCount: 0,
        warnings: ["chmi_weather_radar is not enabled in SITUATION_DATA_ENABLED_SOURCES; radar search entities are unavailable."]
      };
    }
    try {
      this.chmiWeatherRadarSource ??= new ChmiWeatherRadarSource(this.config);
      const status = await this.chmiWeatherRadarSource.healthStatus();
      return {
        sourceSystem: "chmi_weather_radar",
        status: status.status,
        dataQualityStatus: status.status,
        entityCount: status.objectCount ?? 0,
        staleCount: status.status === "degraded" && status.lastImportAgeSeconds && status.lastImportAgeSeconds > 2 * 60 * 60 ? 1 : 0,
        lastSuccessAt: status.lastImportAt,
        backend: status.backend,
        warnings: status.warnings
      };
    } catch (error) {
      return {
        sourceSystem: "chmi_weather_radar",
        status: "degraded",
        dataQualityStatus: "degraded",
        entityCount: 0,
        staleCount: 0,
        warnings: [error instanceof Error ? error.message : "Unknown weather radar search status failure."]
      };
    }
  }

  private getPool(): Pool {
    if (!this.config.osmPostgisConnectionString) {
      throw new Error("OSM_POSTGIS_DATABASE_URL is not configured.");
    }
    this.pool ??= new Pool({ connectionString: this.config.osmPostgisConnectionString, max: 4 });
    return this.pool;
  }
}

function mapOsmPoiEntity(row: OsmPoiSearchRow): SearchEntity | undefined {
  const lon = numberValue(row.lon);
  const lat = numberValue(row.lat);
  const category = cleanString(row.category);
  const osmType = cleanString(row.osm_type) ?? "object";
  const osmId = cleanString(row.osm_id);
  if (lon === undefined || lat === undefined || !category || !osmId) {
    return undefined;
  }
  const entityType = entityTypeForOsmCategory(category);
  if (!entityType) {
    return undefined;
  }
  const tags = normalizeTags(row.tags);
  const title = cleanString(row.name) ?? tags.name ?? osmCategoryLabelCs(category);
  const summary = osmPoiSummary(entityType, title);
  const importedAt = normalizeTimestamp(row.imported_at) ?? new Date().toISOString();
  const aliases = Array.from(new Set([title, tags.operator, tags.brand, tags["short_name"], osmCategoryLabelCs(category)].filter(isNonEmptyString)));
  return {
    contractVersion: CONTRACT_VERSION,
    providerId: PROVIDER_ID,
    providerEntityId: `osm_poi:${osmType}:${osmId}:${category}`,
    sourceSystem: "osm_reference",
    sourceEntityId: `osm:${osmType}:${osmId}`,
    entityType,
    entitySubtype: category,
    title,
    summary,
    searchableText: searchableText([
      title,
      summary,
      category,
      tags.name,
      tags.operator,
      tags.brand,
      cleanString(row.region_name),
      cleanString(row.district_name),
      cleanString(row.municipality_name)
    ]),
    aliases,
    localized: {
      cs: { title, summary },
      en: { title: tags["name:en"] ?? title, summary: osmPoiSummaryEn(entityType, tags["name:en"] ?? title) }
    },
    geometry: { type: "Point", coordinates: [round(lon, 6), round(lat, 6)] },
    centroid: { lat: round(lat, 6), lon: round(lon, 6) },
    address: {
      countryCode: "CZ",
      region: cleanString(row.region_name),
      district: cleanString(row.district_name),
      municipality: cleanString(row.municipality_name),
      street: cleanString(tags["addr:street"])
    },
    status: "active",
    severity: null,
    confidence: confidenceForOsmCategory(category),
    dataQuality: "verified_reference",
    sourceAuthority: "reference",
    classification: "PUBLIC",
    handling: ["server_to_server", "cop_index_allowed", "reference_not_operational_status"],
    visibility: "cop_internal",
    allowedUse: ["search", "map_context", "ai_rag_grounding"],
    observedAt: null,
    validFrom: importedAt,
    validUntil: null,
    updatedAt: importedAt,
    expiresAt: null,
    stale: false,
    sourceRevision: `osm_reference:${importedAt.slice(0, 10)}`,
    layerIds: layerIdsForEntityType(entityType),
    tags: Array.from(new Set(["osm", "reference", entityType, category, ...(tags.amenity ? [tags.amenity] : [])])),
    metrics: {},
    positionQuality: {
      accuracy: osmType === "area" ? "centroid" : "exact",
      source: "local_osm_postgis_read_model"
    },
    providerProperties: {
      osmType,
      osmId,
      category,
      amenity: tags.amenity,
      emergency: tags.emergency,
      healthcare: tags.healthcare,
      sourceAuthorityEvidence: "OpenStreetMap local read model; reference data, not an official operational status feed."
    },
    deleted: false
  };
}

function mapOsmAdminEntity(row: OsmAdminSearchRow): SearchEntity | undefined {
  const adminLevel = numberValue(row.admin_level);
  const lon = numberValue(row.centroid_lon);
  const lat = numberValue(row.centroid_lat);
  const osmId = cleanString(row.osm_id);
  if (adminLevel === undefined || lon === undefined || lat === undefined || !osmId) {
    return undefined;
  }
  const entityType = entityTypeForAdminLevel(adminLevel);
  if (!entityType) {
    return undefined;
  }
  const tags = normalizeTags(row.tags);
  const title = cleanString(row.name) ?? tags["name:cs"] ?? tags.name ?? entityTypeLabel(entityType);
  const importedAt = normalizeTimestamp(row.imported_at) ?? new Date().toISOString();
  const geometry = parseGeometry(row.geometry_geojson);
  if (!geometry) {
    return undefined;
  }
  const summary = `${title}: administrativní území z lokálního OSM read-modelu.`;
  return {
    contractVersion: CONTRACT_VERSION,
    providerId: PROVIDER_ID,
    providerEntityId: `osm_admin:${adminLevel}:${osmId}`,
    sourceSystem: "osm_reference",
    sourceEntityId: `osm:boundary:${osmId}`,
    entityType,
    entitySubtype: adminLevel === 7 ? "orp" : `admin_level_${adminLevel}`,
    title,
    summary,
    searchableText: searchableText([title, summary, cleanString(row.code), tags.name, tags["name:en"], String(adminLevel)]),
    aliases: Array.from(new Set([title, tags["name:en"], cleanString(row.code)].filter(isNonEmptyString))),
    localized: {
      cs: { title, summary },
      en: { title: tags["name:en"] ?? title, summary: `${tags["name:en"] ?? title}: administrative boundary from the local OSM read model.` }
    },
    geometry,
    centroid: { lat: round(lat, 6), lon: round(lon, 6) },
    address: {
      countryCode: cleanString(row.country_code) ?? "CZ",
      region: entityType === "region" ? title : undefined,
      district: entityType === "district" ? title : undefined,
      municipality: entityType === "municipality" ? title : undefined
    },
    status: "active",
    severity: null,
    confidence: 0.82,
    dataQuality: "verified_reference",
    sourceAuthority: "reference",
    classification: "PUBLIC",
    handling: ["server_to_server", "cop_index_allowed"],
    visibility: "cop_internal",
    allowedUse: ["search", "map_context", "ai_rag_grounding"],
    observedAt: null,
    validFrom: importedAt,
    validUntil: null,
    updatedAt: importedAt,
    expiresAt: null,
    stale: false,
    sourceRevision: `osm_admin:${importedAt.slice(0, 10)}`,
    layerIds: layerIdsForEntityType(entityType),
    tags: ["osm", "reference", "boundary", entityType, `admin_level_${adminLevel}`],
    metrics: { adminLevel },
    positionQuality: {
      accuracy: "centroid",
      source: "local_osm_postgis_admin_boundary"
    },
    providerProperties: {
      osmId,
      adminLevel,
      code: cleanString(row.code),
      countryCode: cleanString(row.country_code) ?? "CZ",
      sourceAuthorityEvidence: "OpenStreetMap administrative boundary read model."
    },
    deleted: false
  };
}

function mapSafetyEntity(feature: SafetyFeature): SearchEntity | undefined {
  const properties = asRecord(feature.properties);
  const geometry = feature.geometry;
  if (!properties || !geometry) {
    return undefined;
  }
  const centroid = centroidForGeometry(geometry);
  if (!centroid) {
    return undefined;
  }
  const sourceId = stringValue(properties.sourceId) ?? stringValue(properties.sourceSystem) ?? "safety_data";
  const layer = stringValue(properties.layer) ?? stringValue(properties.layerId) ?? "warnings";
  const hazardType = stringValue(properties.hazardType) ?? stringValue(properties.category) ?? "safety_alert";
  const entityType = entityTypeForSafetyFeature(sourceId, layer, hazardType, properties);
  if (!entityType) {
    return undefined;
  }
  const featureId = String(feature.id ?? stringValue(properties.featureId) ?? stableHash(JSON.stringify({ geometry, properties })));
  const title = stringValue(properties.headline) ?? stringValue(properties.label) ?? stringValue(properties.name) ?? entityTypeLabel(entityType);
  const description = stringValue(properties.description) ?? stringValue(properties.summary) ?? title;
  const observedAt = normalizeTimestamp(properties.observedAt);
  const validFrom = normalizeTimestamp(properties.validFrom ?? properties.effectiveAt);
  const validUntil = normalizeTimestamp(properties.validUntil ?? properties.expiresAt);
  const updatedAt = normalizeTimestamp(properties.updatedAt ?? properties.observedAt ?? properties.validFrom) ?? new Date().toISOString();
  const stale = booleanValue(properties.stale) ?? isExpired(validUntil);
  const severity = normalizeSeverity(stringValue(properties.severity));
  const sourceName = stringValue(properties.sourceName) ?? stringValue(properties.source) ?? sourceId;
  const localized = asRecord(properties.localized);
  const cs = asRecord(localized?.cs);
  const titleCs = stringValue(cs?.headline) ?? stringValue(cs?.title) ?? title;
  const summaryCs = stringValue(cs?.description) ?? stringValue(cs?.summary) ?? description;
  return {
    contractVersion: CONTRACT_VERSION,
    providerId: PROVIDER_ID,
    providerEntityId: `safety:${stableHash(featureId)}`,
    sourceSystem: sourceId,
    sourceEntityId: featureId,
    entityType,
    entitySubtype: hazardType,
    title,
    summary: description,
    searchableText: searchableText([title, description, hazardType, sourceId, stringValue(properties.areaName), stringValue(properties.riverName), stringValue(properties.stationId)]),
    aliases: Array.from(new Set([title, stringValue(properties.areaName), stringValue(properties.riverName), stringValue(properties.stationId)].filter(isNonEmptyString))),
    localized: {
      cs: { title: titleCs, summary: summaryCs }
    },
    geometry,
    centroid,
    address: {
      countryCode: stringValue(properties.countryCode) ?? "CZ",
      region: undefined,
      district: undefined,
      municipality: undefined,
      street: undefined
    },
    status: isExpired(validUntil) ? "expired" : "active",
    severity,
    confidence: clampNumber(numberValue(properties.confidence), 0.5, 0, 1),
    dataQuality: dataQualityForSafetySource(sourceId, entityType),
    sourceAuthority: sourceAuthorityForSafetySource(sourceId),
    classification: "PUBLIC",
    handling: ["server_to_server", "cop_index_allowed", "dynamic_data_requires_timestamp"],
    visibility: "cop_internal",
    allowedUse: ["search", "map_context", "ai_rag_grounding"],
    observedAt: observedAt ?? null,
    validFrom: validFrom ?? observedAt ?? updatedAt,
    validUntil: validUntil ?? null,
    updatedAt,
    expiresAt: normalizeTimestamp(properties.expiresAt) ?? validUntil ?? null,
    stale,
    sourceRevision: `${sourceId}:${updatedAt}`,
    layerIds: layerIdsForEntityType(entityType),
    tags: Array.from(new Set(["safety", sourceId, layer, hazardType, entityType].filter(isNonEmptyString))),
    metrics: numericMetrics(properties),
    positionQuality: {
      accuracy: geometry.type === "Point" ? "exact" : "approximate",
      source: sourceName
    },
    providerProperties: {
      originalFeatureId: featureId,
      sourceName,
      layer,
      hazardType,
      stationId: stringValue(properties.stationId),
      riverName: stringValue(properties.riverName),
      areaName: stringValue(properties.areaName),
      sourceAuthorityEvidence: sourceName
    },
    deleted: false
  };
}

function mapWeatherForecastEntity(feature: SituationFeature): SearchEntity | undefined {
  const properties = asRecord(feature.properties);
  const geometry = feature.geometry;
  const centroid = centroidForGeometry(geometry);
  if (!properties || !centroid) {
    return undefined;
  }
  const featureId = String(feature.id ?? stringValue(properties.featureId) ?? stableHash(JSON.stringify({ geometry, properties })));
  const labelLocalized = asRecord(properties.labelLocalized);
  const summaryLocalized = asRecord(properties.summaryLocalized);
  const titleCs = stringValue(labelLocalized?.cs) ?? stringValue(properties.label) ?? "Předpověď počasí";
  const titleEn = stringValue(labelLocalized?.en) ?? "Weather forecast";
  const summaryCs = stringValue(summaryLocalized?.cs) ?? stringValue(properties.summary) ?? titleCs;
  const summaryEn = stringValue(summaryLocalized?.en) ?? "Weather forecast context for this map area.";
  const observedAt = normalizeTimestamp(properties.observedAt);
  const validFrom = normalizeTimestamp(properties.validFrom) ?? observedAt;
  const validUntil = normalizeTimestamp(properties.validUntil);
  const updatedAt = normalizeTimestamp(properties.updatedAt ?? properties.generatedAt ?? properties.observedAt) ?? new Date().toISOString();
  const metrics = mixedMetricsFrom(properties.metrics);
  const providerProperties = asRecord(properties.providerProperties) ?? {};
  const tags = tagsFromProperties(properties, ["weather", "forecast", "nowcast", "precipitation", "rain", "srazky", "bourka"]);
  const hazardType = stringValue(asRecord(providerProperties.presentation)?.hazardType) ?? tagValue(properties, "hazardType") ?? "weather_forecast";
  const stale = (booleanValue(properties.stale) ?? false) || isExpired(validUntil);
  return {
    contractVersion: CONTRACT_VERSION,
    providerId: PROVIDER_ID,
    providerEntityId: `weather_forecast:${stableHash(featureId)}`,
    sourceSystem: WEATHER_FORECAST_SOURCE_ID,
    sourceEntityId: featureId,
    entityType: "weather_forecast",
    entitySubtype: hazardType,
    title: titleCs,
    summary: summaryCs,
    searchableText: searchableText([
      titleCs,
      titleEn,
      summaryCs,
      summaryEn,
      hazardType,
      stringValue(asRecord(providerProperties.presentation)?.conditionLabel),
      stringValue(asRecord(providerProperties.presentation)?.conditionLabelEn),
      "déšť srážky pršet bouřka vítr nárazy předpověď počasí nowcast radar rain precipitation thunderstorm wind forecast"
    ]),
    aliases: Array.from(new Set([titleCs, titleEn, "bude pršet", "srážky", "bouřka", "weather forecast", "rain forecast"].filter(isNonEmptyString))),
    localized: {
      cs: { title: titleCs, summary: summaryCs },
      en: { title: titleEn, summary: summaryEn }
    },
    geometry,
    centroid,
    address: {
      countryCode: "CZ"
    },
    status: isExpired(validUntil) ? "expired" : "active",
    severity: normalizeSeverity(stringValue(properties.severity)),
    confidence: clampNumber(properties.confidence, 0.7, 0, 1),
    dataQuality: "modelled",
    sourceAuthority: "modelled",
    classification: "PUBLIC",
    handling: ["server_to_server", "cop_index_allowed", "dynamic_data_requires_timestamp", "forecast_model_not_official_warning"],
    visibility: "cop_internal",
    allowedUse: ["search", "map_context", "ai_rag_grounding", "weather_question_answering"],
    observedAt: observedAt ?? null,
    validFrom: validFrom ?? updatedAt,
    validUntil: validUntil ?? null,
    updatedAt,
    expiresAt: validUntil ?? null,
    stale,
    sourceRevision: `${WEATHER_FORECAST_SOURCE_ID}:${updatedAt}`,
    layerIds: layerIdsForEntityType("weather_forecast"),
    tags,
    metrics,
    positionQuality: {
      accuracy: "approximate",
      source: "SIM weather forecast grid"
    },
    providerProperties: {
      ...providerProperties,
      aiContext: {
        dynamicDataRequiresTimestamp: true,
        preferredAnswerScope: "nearest_or_intersecting_forecast_area",
        precipitationMetrics: ["precipitationNext10MinMm", "precipitationNext1hMm", "precipitationNext3hMm", "precipitationProbabilityNext1hPercent"],
        thunderstormMetrics: ["thunderstormProbabilityPercent", "riskScore"],
        windMetrics: ["windSpeedMps", "windGustMps", "maxWindGustNext6hMps"],
        lightningNearbyAvailable: false,
        radarNowcastShouldBeCorroboratedFromSourceSystem: "chmi_weather_radar"
      }
    },
    deleted: false
  };
}

function mapWeatherRadarEntity(feature: SituationFeature): SearchEntity | undefined {
  const properties = asRecord(feature.properties);
  const geometry = feature.geometry;
  const centroid = centroidForGeometry(geometry);
  if (!properties || !centroid) {
    return undefined;
  }
  const layer = stringValue(properties.layer) ?? "weather_radar_reflectivity";
  const entityType = weatherRadarEntityType(layer, stringValue(properties.category));
  const featureId = String(feature.id ?? stringValue(properties.featureId) ?? stableHash(JSON.stringify({ geometry, properties })));
  const observedAt = normalizeTimestamp(properties.observedAt);
  const validUntil = normalizeTimestamp(properties.validUntil);
  const updatedAt = normalizeTimestamp(properties.updatedAt ?? properties.generatedAt ?? properties.observedAt) ?? new Date().toISOString();
  const title = stringValue(properties.label) ?? entityTypeLabel(entityType);
  const summary = stringValue(properties.summary) ?? `${title}: radarový kontext ČHMÚ pro srážky a bouřky.`;
  const providerProperties = asRecord(properties.providerProperties) ?? {};
  const metrics = mixedMetricsFrom(properties.metrics);
  metrics.lightningStrikeFeedAvailable = false;
  if (entityType === "weather_nowcast") {
    metrics.nowcastHorizonMinutes = numberValue(metrics.forecastHorizonMinutes) ?? numberValue(asRecord(providerProperties.raster)?.forecastHorizonMinutes) ?? 60;
  }
  const stale = (booleanValue(properties.stale) ?? false) || isExpired(validUntil);
  return {
    contractVersion: CONTRACT_VERSION,
    providerId: PROVIDER_ID,
    providerEntityId: `weather_radar:${stableHash(featureId)}`,
    sourceSystem: "chmi_weather_radar",
    sourceEntityId: featureId,
    entityType,
    entitySubtype: stringValue(properties.category) ?? layer,
    title,
    summary,
    searchableText: searchableText([
      title,
      summary,
      layer,
      stringValue(properties.category),
      "radar srážky déšť bouřka nowcast odrazivost intenzita precipitation thunderstorm reflectivity"
    ]),
    aliases: Array.from(new Set([title, "radar", "srážkový radar", "bouřkový radar", "weather radar", "rain radar"].filter(isNonEmptyString))),
    localized: {
      cs: { title, summary },
      en: { title, summary: stringValue(properties.summary) ?? "CHMI weather radar context for precipitation and thunderstorms." }
    },
    geometry,
    centroid,
    address: {
      countryCode: "CZ"
    },
    status: isExpired(validUntil) ? "expired" : "active",
    severity: normalizeSeverity(stringValue(properties.severity)),
    confidence: clampNumber(properties.confidence, 0.68, 0, 1),
    dataQuality: "official_observed",
    sourceAuthority: "official",
    classification: "PUBLIC",
    handling: ["server_to_server", "cop_index_allowed", "dynamic_data_requires_timestamp", "render_raster_for_visual_detail"],
    visibility: "cop_internal",
    allowedUse: ["search", "map_context", "ai_rag_grounding", "weather_question_answering"],
    observedAt: observedAt ?? null,
    validFrom: observedAt ?? updatedAt,
    validUntil: validUntil ?? null,
    updatedAt,
    expiresAt: validUntil ?? null,
    stale,
    sourceRevision: stringValue(properties.sourceRevision) ?? `${layer}:${updatedAt}`,
    layerIds: layerIdsForEntityType(entityType),
    tags: tagsFromProperties(properties, ["weather", "radar", "precipitation", "thunderstorm", entityType]),
    metrics,
    positionQuality: {
      accuracy: "approximate",
      source: "ČHMÚ radar raster extent"
    },
    providerProperties: {
      ...providerProperties,
      aiContext: {
        dynamicDataRequiresTimestamp: true,
        preferredAnswerScope: "intersecting_radar_extent",
        radarIntensitySource: "raster_overlay",
        radarIntensityNumericAtPointAvailable: false,
        lightningNearbyAvailable: false,
        rawLightningStrikeFeedAvailable: false
      }
    },
    deleted: false
  };
}

function categoriesForEntityTypes(entityTypes: SearchEntityType[]): string[] {
  const categories = new Set<string>();
  for (const entityType of entityTypes) {
    for (const category of OSM_POI_CATEGORIES) {
      if (entityTypeForOsmCategory(category) === entityType) {
        categories.add(category);
      }
    }
  }
  return Array.from(categories);
}

function adminLevelsForEntityTypes(entityTypes: SearchEntityType[]): number[] {
  const levels: number[] = [];
  if (entityTypes.includes("region")) {
    levels.push(4);
  }
  if (entityTypes.includes("district")) {
    levels.push(6, 7);
  }
  if (entityTypes.includes("municipality")) {
    levels.push(8);
  }
  return levels;
}

function entityTypeForOsmCategory(category: string): SearchEntityType | undefined {
  const mapping: Record<string, SearchEntityType> = {
    police: "police_station",
    fire_station: "fire_station",
    hospital: "hospital",
    healthcare_hospital: "hospital",
    clinic: "medical_emergency",
    healthcare_clinic: "medical_emergency",
    doctors: "medical_emergency",
    healthcare_doctor: "medical_emergency",
    ambulance_station: "medical_emergency",
    defibrillator: "medical_emergency",
    pharmacy: "medical_emergency",
    healthcare_pharmacy: "medical_emergency",
    shelter: "shelter",
    assembly_point: "evacuation_point",
    siren: "critical_infrastructure",
    fire_hydrant: "critical_infrastructure",
    communications_tower: "critical_infrastructure",
    community_centre: "public_resource",
    townhall: "public_resource"
  };
  return mapping[category];
}

function entityTypeForAdminLevel(adminLevel: number): SearchEntityType | undefined {
  if (adminLevel === 4) {
    return "region";
  }
  if (adminLevel === 6 || adminLevel === 7) {
    return "district";
  }
  if (adminLevel === 8) {
    return "municipality";
  }
  return undefined;
}

function entityTypeForSafetyFeature(sourceId: string, layer: string, hazardType: string, properties: Record<string, unknown>): SearchEntityType | undefined {
  if (sourceId === "chmi_hydro" || stringValue(properties.stationId)) {
    return "hydro_station";
  }
  if (layer === "weather_alerts" || sourceId === "chmi_alerts") {
    return "weather_warning";
  }
  if (layer === "fire" || hazardType.includes("fire") || sourceId === "nasa_firms" || sourceId === "hzs_incidents") {
    return "fire_incident";
  }
  if (layer === "flood" || hazardType.includes("flood")) {
    return "flood_risk_area";
  }
  if (sourceId === "road_srti_lod" || hazardType.includes("road") || hazardType.includes("traffic")) {
    return "road_closure";
  }
  if (layer === "warnings") {
    return "safety_alert";
  }
  return undefined;
}

function layerIdsForEntityType(entityType: SearchEntityType): string[] {
  const mapping: Record<SearchEntityType, string[]> = {
    police_station: ["public.security.police"],
    fire_station: ["public.security.fire_station"],
    hospital: ["public.health.hospital"],
    medical_emergency: ["public.health.emergency"],
    hydro_station: ["public.safety.hydro"],
    hydro_measurement: ["public.safety.hydro"],
    weather_forecast: ["public.weather.forecast_area"],
    weather_nowcast: ["public.weather.radar_nowcast"],
    weather_radar: ["public.weather.radar_reflectivity", "public.weather.radar_precipitation"],
    thunderstorm_risk: ["public.safety.thunderstorm_risk"],
    weather_warning: ["public.safety.weather_alerts"],
    safety_alert: ["public.safety.warnings"],
    fire_incident: ["public.safety.fire"],
    flood_risk_area: ["public.safety.flood"],
    road_closure: ["public.traffic.incidents", "public.safety.warnings"],
    shelter: ["public.resources.shelter"],
    evacuation_point: ["public.resources.evacuation"],
    municipality: ["public.boundary.admin"],
    district: ["public.boundary.admin"],
    region: ["public.boundary.admin"],
    critical_infrastructure: ["public.infrastructure.critical"],
    public_resource: ["public.resources.public"]
  };
  return mapping[entityType];
}

function sourceSystemsForEntityType(entityType: SearchEntityType): string[] {
  if (OSM_POI_ENTITY_TYPES.has(entityType) || OSM_ADMIN_ENTITY_TYPES.has(entityType)) {
    return ["osm_reference"];
  }
  if (WEATHER_FORECAST_ENTITY_TYPES.has(entityType)) {
    return [WEATHER_FORECAST_SOURCE_ID];
  }
  if (WEATHER_RADAR_ENTITY_TYPES.has(entityType)) {
    return ["chmi_weather_radar"];
  }
  return ["safety_data", "chmi_alerts", "chmi_hydro", "nasa_firms", "gdacs_alerts", "hzs_incidents", "municipal_alerts", "road_srti_lod"];
}

function entityTypeLabel(entityType: SearchEntityType): string {
  const labels: Record<SearchEntityType, string> = {
    police_station: "Police station",
    fire_station: "Fire station",
    hospital: "Hospital",
    medical_emergency: "Medical emergency point",
    hydro_station: "Hydrological station",
    hydro_measurement: "Hydrological measurement",
    weather_forecast: "Weather forecast",
    weather_nowcast: "Weather nowcast",
    weather_radar: "Weather radar",
    thunderstorm_risk: "Thunderstorm risk",
    weather_warning: "Weather warning",
    safety_alert: "Safety alert",
    fire_incident: "Fire incident",
    flood_risk_area: "Flood risk area",
    road_closure: "Road closure",
    shelter: "Shelter",
    evacuation_point: "Evacuation point",
    municipality: "Municipality",
    district: "District / ORP",
    region: "Region",
    critical_infrastructure: "Critical infrastructure",
    public_resource: "Public resource"
  };
  return labels[entityType];
}

function osmCategoryLabelCs(category: string): string {
  const labels: Record<string, string> = {
    police: "Policie",
    fire_station: "Hasičská stanice",
    hospital: "Nemocnice",
    healthcare_hospital: "Nemocnice",
    clinic: "Zdravotnické zařízení",
    healthcare_clinic: "Zdravotnické zařízení",
    doctors: "Lékař",
    healthcare_doctor: "Lékař",
    ambulance_station: "Zdravotnická záchranná služba",
    defibrillator: "Defibrilátor",
    pharmacy: "Lékárna",
    healthcare_pharmacy: "Lékárna",
    shelter: "Úkryt / přístřeší",
    assembly_point: "Evakuační shromaždiště",
    siren: "Siréna",
    fire_hydrant: "Požární hydrant",
    communications_tower: "Komunikační stožár",
    community_centre: "Komunitní centrum",
    townhall: "Úřad"
  };
  return labels[category] ?? "Referenční objekt";
}

function osmPoiSummary(entityType: SearchEntityType, title: string): string {
  return `${title}: ${entityTypeLabel(entityType).toLowerCase()} z lokálního OSM read-modelu.`;
}

function osmPoiSummaryEn(entityType: SearchEntityType, title: string): string {
  return `${title}: ${entityTypeLabel(entityType).toLowerCase()} from the local OSM read model.`;
}

function confidenceForOsmCategory(category: string): number {
  if (["hospital", "healthcare_hospital", "fire_station", "police", "ambulance_station", "defibrillator"].includes(category)) {
    return 0.84;
  }
  if (category === "communications_tower") {
    return 0.72;
  }
  return 0.76;
}

function dataQualityForSafetySource(sourceId: string, entityType: SearchEntityType): SearchDataQuality {
  if (sourceId === "chmi_alerts" || entityType === "weather_warning") {
    return "official_warning";
  }
  if (sourceId === "chmi_hydro") {
    return "official_observed";
  }
  if (sourceId === "nasa_firms" || sourceId === "gdacs_alerts") {
    return "official_observed";
  }
  if (sourceId === "road_srti_lod") {
    return "official_observed";
  }
  if (sourceId === "municipal_alerts" || sourceId === "hzs_incidents") {
    return "official_observed";
  }
  return "mixed";
}

function sourceAuthorityForSafetySource(sourceId: string): SearchSourceAuthority {
  if (["chmi_alerts", "chmi_hydro", "nasa_firms", "gdacs_alerts", "road_srti_lod", "municipal_alerts", "hzs_incidents"].includes(sourceId)) {
    return "official";
  }
  return "unknown";
}

function normalizeSeverity(value: string | undefined): SearchEntity["severity"] {
  if (value === "critical") {
    return "critical";
  }
  if (value === "warning") {
    return "warning";
  }
  if (value === "advisory") {
    return "advisory";
  }
  if (value === "info") {
    return "info";
  }
  return "info";
}

function numericMetrics(properties: Record<string, unknown>): Record<string, number | string | boolean> {
  const keys = ["waterLevelCm", "discharge", "waterTemperatureC", "floodStage", "intensity", "frp", "ageSeconds"];
  const result: Record<string, number | string | boolean> = {};
  for (const key of keys) {
    const value = properties[key];
    if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
      result[key] = value;
    }
  }
  return result;
}

function mixedMetricsFrom(value: unknown): Record<string, number | string | boolean> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const result: Record<string, number | string | boolean> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "number" || typeof item === "string" || typeof item === "boolean") {
      result[key] = item;
    }
  }
  return result;
}

function tagsFromProperties(properties: Record<string, unknown>, fallback: string[]): string[] {
  const tagValues = Array.isArray(properties.tags)
    ? properties.tags.flatMap((item) => {
        if (typeof item === "string") {
          return [item];
        }
        const record = asRecord(item);
        return record ? Object.values(record).filter(isNonEmptyString) : [];
      })
    : [];
  return Array.from(new Set([...fallback, ...tagValues].filter(isNonEmptyString)));
}

function tagValue(properties: Record<string, unknown>, key: string): string | undefined {
  if (!Array.isArray(properties.tags)) {
    return undefined;
  }
  for (const item of properties.tags) {
    const record = asRecord(item);
    const value = record ? stringValue(record[key]) : undefined;
    if (value) {
      return value;
    }
  }
  return undefined;
}

function weatherRadarEntityType(layer: string, category: string | undefined): SearchEntityType {
  if (layer === "weather_radar_nowcast") {
    return "weather_nowcast";
  }
  if (layer === "weather_thunderstorm_risk" || category === "weather_thunderstorm_risk") {
    return "thunderstorm_risk";
  }
  return "weather_radar";
}

function radarLayersForEntityTypes(entityTypes: SearchEntityType[]): SituationLayerId[] {
  const layers = new Set<SituationLayerId>();
  if (entityTypes.includes("weather_radar")) {
    layers.add("weather_radar_reflectivity");
    layers.add("weather_radar_precipitation");
  }
  if (entityTypes.includes("weather_nowcast")) {
    layers.add("weather_radar_nowcast");
  }
  if (entityTypes.includes("thunderstorm_risk")) {
    layers.add("weather_thunderstorm_risk");
  }
  return Array.from(layers);
}

function compareEntitiesForFeed(left: SearchEntity, right: SearchEntity): number {
  const leftTime = Date.parse(left.updatedAt);
  const rightTime = Date.parse(right.updatedAt);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.providerEntityId.localeCompare(right.providerEntityId);
}

function deduplicateEntities(entities: SearchEntity[]): SearchEntity[] {
  const byId = new Map<string, SearchEntity>();
  for (const entity of entities) {
    const existing = byId.get(entity.providerEntityId);
    if (!existing || Date.parse(entity.updatedAt) >= Date.parse(existing.updatedAt)) {
      byId.set(entity.providerEntityId, entity);
    }
  }
  return Array.from(byId.values());
}

function scoreEntity(entity: SearchEntity, normalizedText: string, center?: SearchCoordinate): number {
  let score = 1;
  if (normalizedText) {
    const haystack = normalizeSearchText([entity.title, entity.summary, entity.searchableText, ...entity.aliases].join(" "));
    const tokens = normalizedText.split(/\s+/).filter(Boolean);
    const matches = tokens.filter((token) => haystack.includes(token)).length;
    score = matches / Math.max(1, tokens.length);
    if (haystack.includes(normalizedText)) {
      score += 0.75;
    }
  }
  if (center) {
    const distance = distanceToEntityMeters(center, entity);
    score += Math.max(0, 0.5 - distance / 100_000);
  }
  score += entity.confidence * 0.1;
  return score;
}

function distanceToEntityMeters(center: SearchCoordinate, entity: SearchEntity): number {
  const bounds = geometryBounds(entity.geometry);
  if (bounds && center.lon >= bounds.west && center.lon <= bounds.east && center.lat >= bounds.south && center.lat <= bounds.north) {
    return 0;
  }
  return distanceMeters(center, entity.centroid);
}

function geometryBounds(geometry: SituationGeometry): BoundingBox | undefined {
  const points = geometry.type === "Point" ? [geometry.coordinates as [number, number]] : flattenCoordinates(geometry.coordinates);
  if (points.length === 0) {
    return undefined;
  }
  return {
    west: Math.min(...points.map((point) => point[0])),
    south: Math.min(...points.map((point) => point[1])),
    east: Math.max(...points.map((point) => point[0])),
    north: Math.max(...points.map((point) => point[1]))
  };
}

function entityValidAt(entity: SearchEntity, validAt: string): boolean {
  const at = Date.parse(validAt);
  if (!Number.isFinite(at)) {
    return true;
  }
  const from = entity.validFrom ? Date.parse(entity.validFrom) : undefined;
  const until = entity.validUntil ? Date.parse(entity.validUntil) : entity.expiresAt ? Date.parse(entity.expiresAt) : undefined;
  if (from !== undefined && Number.isFinite(from) && at < from) {
    return false;
  }
  if (until !== undefined && Number.isFinite(until) && at > until) {
    return false;
  }
  return true;
}

function sourceAllowed(sourceSystem: string | undefined, filters?: string[]): boolean {
  if (!filters || filters.length === 0) {
    return true;
  }
  if (!sourceSystem) {
    return filters.some((filter) => filter !== "osm_reference");
  }
  return filters.includes(sourceSystem);
}

function sourceSystemsAllowAny(sourceSystems: string[], filters?: string[]): boolean {
  if (!filters || filters.length === 0) {
    return true;
  }
  return filters.some((filter) => sourceSystems.includes(filter));
}

function normalizeEntityTypes(value: unknown): SearchEntityType[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const requested = raw.map((item) => String(item).trim()).filter(Boolean);
  const valid = requested.filter((item): item is SearchEntityType => SEARCH_ENTITY_TYPES.includes(item as SearchEntityType));
  return valid.length > 0 ? Array.from(new Set(valid)) : SEARCH_ENTITY_TYPES;
}

function normalizeStringFilters(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return Array.from(new Set(raw.map((item) => String(item).trim()).filter(Boolean))).sort();
}

function parseCursor(value: unknown): { offset: number } {
  if (typeof value !== "string" || value.length === 0) {
    return { offset: 0 };
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { offset?: unknown };
    return { offset: Math.max(0, Math.floor(numberValue(parsed.offset) ?? 0)) };
  } catch {
    return { offset: 0 };
  }
}

function encodeCursor(value: { offset: number }): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function validIso(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function bboxAroundPoint(center: SearchCoordinate, radiusM: number): BoundingBox {
  const radius = Math.max(100, Math.min(250_000, radiusM));
  const latDegrees = radius / 111_320;
  const lonDegrees = radius / (111_320 * Math.max(0.1, Math.cos((center.lat * Math.PI) / 180)));
  return {
    west: clampNumber(center.lon - lonDegrees, center.lon, -180, 180),
    south: clampNumber(center.lat - latDegrees, center.lat, -90, 90),
    east: clampNumber(center.lon + lonDegrees, center.lon, -180, 180),
    north: clampNumber(center.lat + latDegrees, center.lat, -90, 90)
  };
}

function distanceMeters(left: SearchCoordinate, right: SearchCoordinate): number {
  const radius = 6_371_000;
  const leftLat = (left.lat * Math.PI) / 180;
  const rightLat = (right.lat * Math.PI) / 180;
  const deltaLat = ((right.lat - left.lat) * Math.PI) / 180;
  const deltaLon = ((right.lon - left.lon) * Math.PI) / 180;
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(leftLat) * Math.cos(rightLat) * Math.sin(deltaLon / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function centroidForGeometry(geometry: SituationGeometry): SearchCoordinate | undefined {
  if (geometry.type === "Point") {
    const [lon, lat] = geometry.coordinates;
    return { lat, lon };
  }
  const points = flattenCoordinates(geometry.coordinates);
  if (points.length === 0) {
    return undefined;
  }
  const lon = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const lat = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  return { lat: round(lat, 6), lon: round(lon, 6) };
}

function flattenCoordinates(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) {
    return [];
  }
  if (value.length === 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    return [[value[0], value[1]]];
  }
  return value.flatMap(flattenCoordinates);
}

function parseGeometry(value: unknown): SituationGeometry | undefined {
  const geometry = asRecord(value);
  const type = stringValue(geometry?.type);
  if (!type || !["Point", "LineString", "MultiLineString", "Polygon", "MultiPolygon"].includes(type)) {
    return undefined;
  }
  return geometry as unknown as SituationGeometry;
}

function normalizeTags(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    const text = stringValue(item);
    if (text) {
      result[key] = text;
    }
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function cleanString(value: unknown): string | undefined {
  return stringValue(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isEntity(value: SearchEntity | undefined): value is SearchEntity {
  return Boolean(value);
}

function isExpired(value: string | undefined): boolean {
  return Boolean(value && Date.parse(value) < Date.now());
}

function searchableText(values: Array<string | undefined>): string {
  return values.filter(isNonEmptyString).join(" ");
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  return undefined;
}

function newestIsoTimestamp(...values: Array<string | undefined>): string | undefined {
  return values
    .filter(isNonEmptyString)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = numberValue(value);
  if (parsed === undefined) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = numberValue(value);
  if (parsed === undefined) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function round(value: number, decimals = 3): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function quoteQualifiedIdentifier(value: string, label: string): string {
  const parts = value.split(".");
  if (parts.length === 0 || parts.length > 2 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
    throw new Error(`${label} must be an unquoted PostgreSQL identifier or schema-qualified identifier.`);
  }
  return parts.map((part) => `"${part}"`).join(".");
}
