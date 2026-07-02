import { Pool } from "pg";
import { canonicalizeBboxForCache, formatBboxKey } from "./bbox-cache.js";
import type { SituationDataConfig } from "./config.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type { SituationDataSource, SourceCacheStats } from "./sources.js";
import type {
  BoundingBox,
  SituationDataLicense,
  SituationFeature,
  SituationLayerId,
  SituationQuery,
  SourceHealthStatus,
  SourceDescriptor,
  SourceFetchResult
} from "./types.js";

const OSM_POSTGIS_LICENSE: SituationDataLicense = {
  name: "ODbL 1.0",
  url: "https://opendatacommons.org/licenses/odbl/1-0/",
  attribution: "OpenStreetMap contributors",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Attribution is required.",
    "Public adapted databases must follow ODbL obligations.",
    "This source reads a local OSM extract from PostGIS and is suitable as the production replacement for public Overpass."
  ]
};

interface OsmPoiRow {
  osm_id: string;
  osm_type: string;
  category: string;
  layer: string;
  name: string | null;
  lon: number | string;
  lat: number | string;
  tags: Record<string, unknown> | null;
  imported_at: Date | string | null;
}

interface OsmAdminBoundaryRow {
  osm_id: string;
  admin_level: number | string;
  name: string | null;
  code: string | null;
  country_code: string | null;
  source: string | null;
  geometry_geojson: unknown;
  tags: Record<string, unknown> | null;
  imported_at: Date | string | null;
}

interface OsmPostgisMetadata {
  objectCount: number;
  lastImportAt?: string;
  boundaryFeatureCount: number;
  boundaryLevels: string[];
  boundaryLastImportAt?: string;
}

type OsmPoiLayer = "ground" | "mobile";
type OsmAdminBoundaryLayer = "boundary_country" | "boundary_region" | "boundary_district" | "boundary_orp" | "place_settlements";
const DEFAULT_TOWER_VIEWSHED_QUERY = {
  technology: "4G",
  radiusM: 12_000,
  azimuthStepDeg: 10,
  distanceStepM: 500,
  includeNoSignal: false
} as const;
const TOWER_VIEWSHED_RADIUS_M_BY_TECHNOLOGY = {
  "2G": 25_000,
  "4G": 12_000,
  "5G": 5_000
} as const;

export class OsmPostgisSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly payloadCache: ManagedResponseCache<OsmPoiRow[]>;
  private readonly boundaryCache: ManagedResponseCache<OsmAdminBoundaryRow[]>;
  private readonly metadataCache: ManagedResponseCache<OsmPostgisMetadata>;
  private pool?: Pool;

  constructor(private readonly config: SituationDataConfig) {
    this.payloadCache = new ManagedResponseCache<OsmPoiRow[]>({
      ttlMs: Math.max(60, config.osmPostgisCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.osmPostgisCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(64, Math.min(config.cacheMaxEntries, 4096))
    });
    this.boundaryCache = new ManagedResponseCache<OsmAdminBoundaryRow[]>({
      ttlMs: Math.max(60, config.osmPostgisCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.osmPostgisCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(64, Math.min(config.cacheMaxEntries, 2048))
    });
    this.metadataCache = new ManagedResponseCache<OsmPostgisMetadata>({
      ttlMs: 60_000,
      staleIfErrorMs: Math.max(300, config.staleIfErrorSeconds) * 1000,
      maxEntries: 4
    });
    this.descriptor = {
      sourceId: "osm_postgis",
      label: "Local OpenStreetMap PostGIS context",
      enabled: config.enabledSources.includes("osm_postgis"),
      mode: "live",
      priority: 62,
      layers: ["ground", "mobile", "boundary_country", "boundary_region", "boundary_district", "boundary_orp", "place_settlements"],
      license: OSM_POSTGIS_LICENSE,
      baseUrl: publicPostgisBaseUrl(config.osmPostgisConnectionString),
      updateCadenceSeconds: config.osmPostgisCacheTtlSeconds
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [
      {
        sourceId: "osm_postgis",
        ...mergeCacheStats([this.payloadCache.stats(), this.boundaryCache.stats()])
      }
    ];
  }

  async healthStatus(): Promise<SourceHealthStatus> {
    const warnings: string[] = [];
    if (!this.config.osmPostgisConnectionString) {
      return {
        sourceId: "osm_postgis",
        status: "degraded",
        backend: this.config.osmPostgisBackend,
        warnings: ["osm_postgis is enabled but OSM_POSTGIS_DATABASE_URL is not configured."]
      };
    }

    try {
      const metadata = await this.metadataCache.getOrLoad("metadata", () => this.fetchMetadata());
      const lastImportAgeSeconds = metadata.lastImportAt ? Math.max(0, Math.round((Date.now() - Date.parse(metadata.lastImportAt)) / 1000)) : undefined;
      if (metadata.objectCount <= 0) {
        warnings.push("osm_postgis public.osm_poi is empty.");
      }
      if (metadata.boundaryFeatureCount <= 0) {
        warnings.push(`${this.config.osmPostgisAdminBoundaryTable} is empty or not imported.`);
      }
      if (!metadata.lastImportAt) {
        warnings.push("osm_postgis public.osm_poi has no imported_at timestamp.");
      }
      if (!metadata.boundaryLastImportAt) {
        warnings.push(`${this.config.osmPostgisAdminBoundaryTable} has no imported_at timestamp.`);
      }
      const boundaryLastImportAgeSeconds = metadata.boundaryLastImportAt
        ? Math.max(0, Math.round((Date.now() - Date.parse(metadata.boundaryLastImportAt)) / 1000))
        : undefined;
      return {
        sourceId: "osm_postgis",
        status: warnings.length > 0 ? "degraded" : "ok",
        backend: this.config.osmPostgisBackend,
        objectCount: metadata.objectCount,
        lastImportAt: metadata.lastImportAt,
        lastImportAgeSeconds,
        boundaryFeatureCount: metadata.boundaryFeatureCount,
        boundaryLevels: metadata.boundaryLevels,
        boundaryLastImportAt: metadata.boundaryLastImportAt,
        boundaryLastImportAgeSeconds,
        warnings
      };
    } catch (error) {
      return {
        sourceId: "osm_postgis",
        status: "degraded",
        backend: this.config.osmPostgisBackend,
        warnings: [error instanceof Error ? error.message : "Unknown osm_postgis health check failure."]
      };
    }
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    const poiLayers = query.layers.filter((layer): layer is OsmPoiLayer => layer === "ground" || layer === "mobile");
    const boundaryLayers = query.layers.filter(isOsmAdminBoundaryLayer);
    if (poiLayers.length === 0 && boundaryLayers.length === 0) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }
    if (!this.config.osmPostgisConnectionString) {
      return {
        source: this.descriptor,
        fetchedAt,
        features: [],
        warnings: ["osm_postgis is enabled but OSM_POSTGIS_DATABASE_URL is not configured."]
      };
    }

    const cacheBbox = canonicalizeBboxForCache(query.bbox, this.config.bboxCachePaddingDegrees);
    const [poiRows, boundaryRows] = await Promise.all([
      poiLayers.length > 0
        ? this.payloadCache.getOrLoad(
            JSON.stringify({
              bbox: formatBboxKey(cacheBbox),
              layers: [...poiLayers].sort()
            }),
            () => this.fetchRows(cacheBbox, poiLayers, 1000)
          )
        : Promise.resolve([]),
      boundaryLayers.length > 0
        ? this.boundaryCache.getOrLoad(
            JSON.stringify({
              bbox: formatBboxKey(cacheBbox),
              layers: [...boundaryLayers].sort(),
              geomColumn: adminBoundaryGeomColumn(cacheBbox).column
            }),
            () => this.fetchAdminBoundaryRows(cacheBbox, boundaryLayers, Math.min(1000, query.limit))
          )
        : Promise.resolve([])
    ]);

    const poiFeatures = poiRows
      .map((row) => mapOsmPoiRow(row, fetchedAt, query.includeRaw))
      .filter((feature): feature is SituationFeature => Boolean(feature))
      .filter((feature) => query.layers.includes(feature.properties.layer))
      .filter((feature) => isFeaturePointInBbox(feature, query.bbox));
    const boundaryFeatures = boundaryRows
      .map((row) => mapOsmAdminBoundaryRow(row, fetchedAt, query.includeRaw))
      .filter((feature): feature is SituationFeature => Boolean(feature))
      .filter((feature) => query.layers.includes(feature.properties.layer))
      .filter((feature) => isFeatureEnvelopeInBbox(feature, query.bbox));
    const features = [...boundaryFeatures, ...poiFeatures].slice(0, query.limit);

    return {
      source: this.descriptor,
      fetchedAt,
      features,
      warnings: []
    };
  }

  private async fetchRows(bbox: BoundingBox, layers: Array<"ground" | "mobile">, limit: number): Promise<OsmPoiRow[]> {
    const pool = this.getPool();
    const table = quoteQualifiedIdentifier(this.config.osmPostgisTable);
    const sql = `
      select
        osm_id::text,
        osm_type,
        category,
        layer,
        name,
        lon,
        lat,
        tags,
        imported_at
      from ${table}
      where geom && st_makeenvelope($1, $2, $3, $4, 4326)
        and layer = any($5::text[])
      order by
        case category
          when 'hospital' then 1
          when 'fire_station' then 2
          when 'police' then 3
          when 'ambulance_station' then 4
          when 'communications_tower' then 5
          else 20
        end,
        name nulls last,
        osm_id
      limit $6
    `;
    const result = await pool.query<OsmPoiRow>(sql, [bbox.west, bbox.south, bbox.east, bbox.north, layers, Math.max(1, Math.min(1000, limit))]);
    return result.rows;
  }

  private async fetchAdminBoundaryRows(bbox: BoundingBox, layers: OsmAdminBoundaryLayer[], limit: number): Promise<OsmAdminBoundaryRow[]> {
    const pool = this.getPool();
    const table = quoteQualifiedIdentifier(this.config.osmPostgisAdminBoundaryTable, "OSM_POSTGIS_ADMIN_BOUNDARY_TABLE");
    const geom = adminBoundaryGeomColumn(bbox);
    const adminLevels = Array.from(new Set(layers.flatMap(adminLevelsForLayer))).sort((a, b) => a - b);
    if (adminLevels.length === 0) {
      return [];
    }
    const sql = `
      select
        osm_id::text,
        admin_level,
        name,
        code,
        country_code,
        source,
        st_asgeojson(${geom.column})::jsonb as geometry_geojson,
        tags,
        imported_at
      from ${table}
      where ${geom.column} && st_makeenvelope($1, $2, $3, $4, 4326)
        and admin_level = any($5::integer[])
      order by admin_level, name nulls last, osm_id
      limit $6
    `;
    const result = await pool.query<OsmAdminBoundaryRow>(sql, [
      bbox.west,
      bbox.south,
      bbox.east,
      bbox.north,
      adminLevels,
      Math.max(1, Math.min(1000, limit))
    ]);
    return result.rows;
  }

  private async fetchMetadata(): Promise<OsmPostgisMetadata> {
    const pool = this.getPool();
    const table = quoteQualifiedIdentifier(this.config.osmPostgisTable);
    const boundaryTable = quoteQualifiedIdentifier(this.config.osmPostgisAdminBoundaryTable, "OSM_POSTGIS_ADMIN_BOUNDARY_TABLE");
    const sql = `
      select
        count(*)::bigint as object_count,
        max(imported_at) as last_import_at
      from ${table}
    `;
    const boundarySql = `
      select
        count(*)::bigint as boundary_feature_count,
        array_agg(distinct admin_level::text order by admin_level::text) as boundary_levels,
        max(imported_at) as boundary_last_import_at
      from ${boundaryTable}
    `;
    const [result, boundaryResult] = await Promise.all([
      pool.query<{ object_count: string | number; last_import_at: Date | string | null }>(sql),
      pool.query<{ boundary_feature_count: string | number; boundary_levels: string[] | null; boundary_last_import_at: Date | string | null }>(boundarySql)
    ]);
    const row = result.rows[0];
    const boundaryRow = boundaryResult.rows[0];
    return {
      objectCount: numberFromPg(row?.object_count),
      lastImportAt: normalizeTimestamp(row?.last_import_at),
      boundaryFeatureCount: numberFromPg(boundaryRow?.boundary_feature_count),
      boundaryLevels: boundaryRow?.boundary_levels ?? [],
      boundaryLastImportAt: normalizeTimestamp(boundaryRow?.boundary_last_import_at)
    };
  }

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: this.config.osmPostgisConnectionString,
        max: 4,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: this.config.requestTimeoutMs
      });
    }
    return this.pool;
  }
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

function numberFromPg(value: string | number | null | undefined): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function mergeCacheStats(stats: ManagedResponseCacheStats[]): ManagedResponseCacheStats {
  return stats.reduce<ManagedResponseCacheStats>(
    (summary, item) => {
      const next: ManagedResponseCacheStats = {
        entries: summary.entries + item.entries,
        inflight: summary.inflight + item.inflight,
        maxEntries: summary.maxEntries + item.maxEntries,
        hits: summary.hits + item.hits,
        misses: summary.misses + item.misses,
        coalescedHits: summary.coalescedHits + item.coalescedHits,
        staleHits: summary.staleHits + item.staleHits,
        refreshes: summary.refreshes + item.refreshes,
        errors: summary.errors + item.errors,
        evictions: summary.evictions + item.evictions,
        sharedEnabled: summary.sharedEnabled || item.sharedEnabled,
        sharedAvailable: summary.sharedAvailable || item.sharedAvailable,
        sharedHits: summary.sharedHits + item.sharedHits,
        sharedMisses: summary.sharedMisses + item.sharedMisses,
        sharedStaleHits: summary.sharedStaleHits + item.sharedStaleHits,
        sharedWrites: summary.sharedWrites + item.sharedWrites,
        sharedErrors: summary.sharedErrors + item.sharedErrors
      };
      const lastSuccessAt = newestIsoTimestamp(summary.lastSuccessAt, item.lastSuccessAt);
      const lastErrorAt = newestIsoTimestamp(summary.lastErrorAt, item.lastErrorAt);
      if (lastSuccessAt) {
        next.lastSuccessAt = lastSuccessAt;
      }
      if (lastErrorAt) {
        next.lastErrorAt = lastErrorAt;
      }
      return next;
    },
    {
      entries: 0,
      inflight: 0,
      maxEntries: 0,
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

function mapOsmPoiRow(row: OsmPoiRow, fetchedAt: string, includeRaw: boolean): SituationFeature | undefined {
  const layer = parseLayer(row.layer);
  const lon = optionalNumber(row.lon);
  const lat = optionalNumber(row.lat);
  const category = cleanString(row.category);
  const osmType = cleanString(row.osm_type) ?? "object";
  const osmId = cleanString(row.osm_id);
  if (!layer || lon === undefined || lat === undefined || !category || !osmId) {
    return undefined;
  }
  const id = `${layer}:osm_postgis:${osmType}:${osmId}:${category}`;
  const towerId = `${osmType}:${osmId}`;
  const tags = normalizeTags(row.tags);
  const isCommunicationsTower = category === "communications_tower";
  return {
    type: "Feature",
    id,
    geometry: {
      type: "Point",
      coordinates: [round(lon, 6), round(lat, 6)]
    },
    properties: {
      featureId: id,
      layer,
      category,
      label: cleanString(row.name) ?? labelForCategory(category),
      sourceId: "osm_postgis",
      observedAt: fetchedAt,
      confidence: confidenceForCategory(category),
      stale: false,
      severity: "info",
      status: isCommunicationsTower ? "unknown" : undefined,
      dataQuality: isCommunicationsTower ? "unknown" : undefined,
      btsStatus: isCommunicationsTower ? "unknown" : undefined,
      btsStatusSource: isCommunicationsTower ? "none" : undefined,
      operatorStatusAvailable: isCommunicationsTower ? false : undefined,
      notices: isCommunicationsTower ? ["Referenční OSM komunikační stožár; nejde o ověřený stav BTS ani dostupnost služby."] : undefined,
      disclaimer: isCommunicationsTower ? "Reference infrastructure only; BTS operational status is unknown." : undefined,
      providerProperties: isCommunicationsTower ? mobileCoverageTowerReference(towerId) : undefined,
      license: {
        name: OSM_POSTGIS_LICENSE.name,
        attribution: OSM_POSTGIS_LICENSE.attribution,
        url: OSM_POSTGIS_LICENSE.url
      },
      metrics: {
        ageSeconds: 0
      },
      tags: compactTags({
        osmType,
        osmId,
        importedAt: normalizeTimestamp(row.imported_at),
        amenity: tags.amenity,
        emergency: tags.emergency,
        manMade: tags.man_made,
        towerType: tags["tower:type"],
        viewshedTowerId: isCommunicationsTower ? towerId : undefined,
        referenceOnly: isCommunicationsTower ? "true" : undefined,
        btsStatus: isCommunicationsTower ? "unknown" : undefined
      }),
      raw: includeRaw ? row : undefined
    }
  };
}

function mobileCoverageTowerReference(towerId: string): Record<string, unknown> {
  return {
    mobileCoverage: {
      contractVersion: "sim-mobile-coverage-tower-reference-v1",
      towerId,
      viewshedAvailable: true,
      viewshedUrl: `/situation-data/api/v1/mobile-coverage/towers/${towerId}/viewshed`,
      serviceViewshedUrl: `/api/v1/mobile-coverage/towers/${towerId}/viewshed`,
      defaultQuery: DEFAULT_TOWER_VIEWSHED_QUERY,
      radiusMByTechnology: TOWER_VIEWSHED_RADIUS_M_BY_TECHNOLOGY,
      renderPolicy: "coverage_only",
      btsStatus: "operator_feed_unavailable",
      operatorStatusAvailable: false,
      disclaimer: "Modelled line-of-sight coverage estimate only; SIM has no live operator BTS/NOC status for this tower."
    }
  };
}

function mapOsmAdminBoundaryRow(row: OsmAdminBoundaryRow, fetchedAt: string, includeRaw: boolean): SituationFeature | undefined {
  const adminLevel = optionalNumber(row.admin_level);
  const layer = adminLevel !== undefined ? layerForAdminLevel(adminLevel) : undefined;
  const geometry = parseGeometry(row.geometry_geojson);
  const osmId = cleanString(row.osm_id);
  if (adminLevel === undefined || !layer || !geometry || !osmId) {
    return undefined;
  }
  const tags = normalizeTags(row.tags);
  const name = cleanString(row.name) ?? tags["name:cs"] ?? tags.name ?? labelForAdminLayer(layer);
  const code = cleanString(row.code) ?? osmId;
  const countryCode = cleanString(row.country_code) ?? "CZ";
  const importedAt = normalizeTimestamp(row.imported_at) ?? fetchedAt;
  const category = layer === "place_settlements" ? "settlement" : "admin_boundary";
  const id = `${layer}:osm_postgis:boundary:${stableBoundaryToken(`${adminLevel}:${code}:${osmId}`)}`;
  const englishName = tags["name:en"] ?? tags["int_name"] ?? name;
  const summaryCs = boundarySummaryCs(layer, name);
  const summaryEn = boundarySummaryEn(layer, englishName);
  const sourceName = "OSM PostGIS administrative boundary read model";

  return {
    type: "Feature",
    id,
    geometry,
    properties: {
      featureId: id,
      layer,
      category,
      label: name,
      labelLocalized: { cs: name, en: englishName },
      summary: summaryCs,
      summaryLocalized: { cs: summaryCs, en: summaryEn },
      sourceId: "osm_postgis",
      source: "osm_postgis",
      sourceName,
      observedAt: importedAt,
      validFrom: importedAt,
      updatedAt: importedAt,
      confidence: 0.82,
      stale: false,
      severity: "info",
      license: {
        name: OSM_POSTGIS_LICENSE.name,
        attribution: OSM_POSTGIS_LICENSE.attribution,
        url: OSM_POSTGIS_LICENSE.url
      },
      basis: ["osm_postgis_admin_boundary", "local_postgis_read_model"],
      sourceRevision: `osm-admin-boundary:${importedAt}`,
      readModel: true,
      dataQuality: "observed",
      adminLevel,
      name,
      code,
      countryCode,
      areaName: name,
      styleHint: styleHintForAdminLayer(layer),
      iconHint: layer === "place_settlements" ? "place" : "boundary",
      metrics: {
        ageSeconds: 0,
        adminLevel,
        generalizationM: adminBoundaryGeneralizationMeters(geometry)
      },
      tags: compactTags({
        osmId,
        osmSource: cleanString(row.source) ?? "osm_postgis",
        code,
        countryCode,
        adminLevel: String(adminLevel),
        boundaryLayer: layer,
        sourceRevision: `osm-admin-boundary:${importedAt}`
      }),
      providerProperties: {
        adminLevel,
        name,
        code,
        countryCode,
        sourceName,
        sourceRevision: `osm-admin-boundary:${importedAt}`,
        basis: ["osm_postgis_admin_boundary", "local_postgis_read_model"],
        dataQuality: "observed",
        readModel: true
      },
      raw: includeRaw ? { tags: row.tags } : undefined
    }
  };
}

function parseLayer(value: string): SituationLayerId | undefined {
  return value === "ground" || value === "mobile" ? value : undefined;
}

function isOsmAdminBoundaryLayer(value: SituationLayerId): value is OsmAdminBoundaryLayer {
  return (
    value === "boundary_country" ||
    value === "boundary_region" ||
    value === "boundary_district" ||
    value === "boundary_orp" ||
    value === "place_settlements"
  );
}

function adminLevelsForLayer(layer: OsmAdminBoundaryLayer): number[] {
  switch (layer) {
    case "boundary_country":
      return [2];
    case "boundary_region":
      return [4];
    case "boundary_district":
      return [6];
    case "boundary_orp":
      return [7];
    case "place_settlements":
      return [8];
  }
}

function layerForAdminLevel(adminLevel: number): OsmAdminBoundaryLayer | undefined {
  switch (adminLevel) {
    case 2:
      return "boundary_country";
    case 4:
      return "boundary_region";
    case 6:
      return "boundary_district";
    case 7:
      return "boundary_orp";
    case 8:
      return "place_settlements";
    default:
      return undefined;
  }
}

function adminBoundaryGeomColumn(bbox: BoundingBox): { column: string; simplificationDegrees: number } {
  const span = Math.max(bbox.east - bbox.west, bbox.north - bbox.south);
  if (span > 3) {
    return { column: "geom_z5", simplificationDegrees: 0.01 };
  }
  if (span > 0.7) {
    return { column: "geom_z8", simplificationDegrees: 0.003 };
  }
  if (span > 0.15) {
    return { column: "geom_z11", simplificationDegrees: 0.0008 };
  }
  return { column: "geom", simplificationDegrees: 0 };
}

function adminBoundaryGeneralizationMeters(geometry: SituationFeature["geometry"]): number {
  const coordinates = featureCoordinates(geometry);
  if (coordinates.length < 2) {
    return 0;
  }
  const envelope = coordinates.reduce(
    (acc, [lon, lat]) => ({
      west: Math.min(acc.west, lon),
      south: Math.min(acc.south, lat),
      east: Math.max(acc.east, lon),
      north: Math.max(acc.north, lat)
    }),
    { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity }
  );
  const span = Math.max(envelope.east - envelope.west, envelope.north - envelope.south);
  if (span > 3) {
    return 1100;
  }
  if (span > 0.7) {
    return 330;
  }
  if (span > 0.15) {
    return 90;
  }
  return 0;
}

function parseGeometry(value: unknown): SituationFeature["geometry"] | undefined {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const geometry = parsed as { type?: unknown; coordinates?: unknown };
  if (geometry.type === "Polygon" && isPolygonCoordinates(geometry.coordinates)) {
    return { type: "Polygon", coordinates: geometry.coordinates };
  }
  if (geometry.type === "MultiPolygon" && isMultiPolygonCoordinates(geometry.coordinates)) {
    return { type: "MultiPolygon", coordinates: geometry.coordinates };
  }
  return undefined;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isPolygonCoordinates(value: unknown): value is Array<Array<[number, number]>> {
  return Array.isArray(value) && value.every((ring) => Array.isArray(ring) && ring.every(isLonLat));
}

function isMultiPolygonCoordinates(value: unknown): value is Array<Array<Array<[number, number]>>> {
  return Array.isArray(value) && value.every((polygon) => isPolygonCoordinates(polygon));
}

function isLonLat(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number" && Number.isFinite(value[0]) && Number.isFinite(value[1]);
}

function isFeatureEnvelopeInBbox(feature: SituationFeature, bbox: BoundingBox): boolean {
  const coordinates = featureCoordinates(feature.geometry);
  if (coordinates.length === 0) {
    return false;
  }
  const envelope = coordinates.reduce(
    (acc, [lon, lat]) => ({
      west: Math.min(acc.west, lon),
      south: Math.min(acc.south, lat),
      east: Math.max(acc.east, lon),
      north: Math.max(acc.north, lat)
    }),
    { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity }
  );
  return envelope.west <= bbox.east && envelope.east >= bbox.west && envelope.south <= bbox.north && envelope.north >= bbox.south;
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

function labelForAdminLayer(layer: OsmAdminBoundaryLayer): string {
  const labels: Record<OsmAdminBoundaryLayer, string> = {
    boundary_country: "Country boundary",
    boundary_region: "Region boundary",
    boundary_district: "District boundary",
    boundary_orp: "ORP boundary",
    place_settlements: "Settlement"
  };
  return labels[layer];
}

function boundarySummaryCs(layer: OsmAdminBoundaryLayer, name: string): string {
  const labels: Record<OsmAdminBoundaryLayer, string> = {
    boundary_country: "Hranice státu",
    boundary_region: "Hranice kraje",
    boundary_district: "Hranice okresu",
    boundary_orp: "Hranice ORP",
    place_settlements: "Sídlo"
  };
  return `${labels[layer]}: ${name}.`;
}

function boundarySummaryEn(layer: OsmAdminBoundaryLayer, name: string): string {
  const labels: Record<OsmAdminBoundaryLayer, string> = {
    boundary_country: "Country boundary",
    boundary_region: "Regional boundary",
    boundary_district: "District boundary",
    boundary_orp: "ORP boundary",
    place_settlements: "Settlement"
  };
  return `${labels[layer]}: ${name}.`;
}

function styleHintForAdminLayer(layer: OsmAdminBoundaryLayer): string {
  const hints: Record<OsmAdminBoundaryLayer, string> = {
    boundary_country: "boundary-country-v1",
    boundary_region: "boundary-region-v1",
    boundary_district: "boundary-district-v1",
    boundary_orp: "boundary-orp-v1",
    place_settlements: "place-settlements-v1"
  };
  return hints[layer];
}

function stableBoundaryToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120);
}

function quoteQualifiedIdentifier(value: string, label = "OSM_POSTGIS_TABLE"): string {
  const parts = value.split(".").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > 2 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
    throw new Error(`Invalid ${label} identifier.`);
  }
  return parts.map((part) => `"${part.replace(/"/g, '""')}"`).join(".");
}

function normalizeTags(value: Record<string, unknown> | null): Record<string, string> {
  if (!value) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
      .map(([key, item]) => [key, item.trim()])
  );
}

function isFeaturePointInBbox(feature: SituationFeature, bbox: BoundingBox): boolean {
  if (feature.geometry.type !== "Point") {
    return false;
  }
  const [lon, lat] = feature.geometry.coordinates;
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

function labelForCategory(category: string): string {
  const labels: Record<string, string> = {
    hospital: "Hospital",
    clinic: "Clinic",
    doctors: "Doctor",
    pharmacy: "Pharmacy",
    police: "Police station",
    fire_station: "Fire station",
    ambulance_station: "Ambulance station",
    fire_hydrant: "Fire hydrant",
    defibrillator: "Defibrillator",
    siren: "Siren",
    assembly_point: "Assembly point",
    communications_tower: "Communication tower",
    shelter: "Shelter",
    community_centre: "Community centre",
    townhall: "Town hall",
    healthcare_hospital: "Hospital",
    healthcare_clinic: "Clinic",
    healthcare_doctor: "Doctor",
    healthcare_pharmacy: "Pharmacy"
  };
  return labels[category] ?? "OpenStreetMap reference";
}

function confidenceForCategory(category: string): number {
  if (["hospital", "healthcare_hospital", "fire_station", "police", "ambulance_station", "defibrillator"].includes(category)) {
    return 0.84;
  }
  if (category === "communications_tower") {
    return 0.72;
  }
  return 0.76;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeTimestamp(value: Date | string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function compactTags(values: Record<string, string | undefined>): Record<string, string> | undefined {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
