import { Pool } from "pg";
import { canonicalizeBboxForCache, formatBboxKey } from "./bbox-cache.js";
import type { SituationDataConfig } from "./config.js";
import { ManagedResponseCache } from "./response-cache.js";
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

interface OsmPostgisMetadata {
  objectCount: number;
  lastImportAt?: string;
}

export class OsmPostgisSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly payloadCache: ManagedResponseCache<OsmPoiRow[]>;
  private readonly metadataCache: ManagedResponseCache<OsmPostgisMetadata>;
  private pool?: Pool;

  constructor(private readonly config: SituationDataConfig) {
    this.payloadCache = new ManagedResponseCache<OsmPoiRow[]>({
      ttlMs: Math.max(60, config.osmPostgisCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.osmPostgisCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(64, Math.min(config.cacheMaxEntries, 4096))
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
      layers: ["ground", "mobile"],
      license: OSM_POSTGIS_LICENSE,
      baseUrl: publicPostgisBaseUrl(config.osmPostgisConnectionString),
      updateCadenceSeconds: config.osmPostgisCacheTtlSeconds
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [
      {
        sourceId: "osm_postgis",
        ...this.payloadCache.stats()
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
      if (!metadata.lastImportAt) {
        warnings.push("osm_postgis public.osm_poi has no imported_at timestamp.");
      }
      return {
        sourceId: "osm_postgis",
        status: warnings.length > 0 ? "degraded" : "ok",
        backend: this.config.osmPostgisBackend,
        objectCount: metadata.objectCount,
        lastImportAt: metadata.lastImportAt,
        lastImportAgeSeconds,
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
    const layers = query.layers.filter((layer): layer is "ground" | "mobile" => layer === "ground" || layer === "mobile");
    if (layers.length === 0) {
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
    const cacheKey = JSON.stringify({
      bbox: formatBboxKey(cacheBbox),
      layers: [...layers].sort()
    });
    const rows = await this.payloadCache.getOrLoad(cacheKey, () => this.fetchRows(cacheBbox, layers, 1000));
    const features = rows
      .map((row) => mapOsmPoiRow(row, fetchedAt, query.includeRaw))
      .filter((feature): feature is SituationFeature => Boolean(feature))
      .filter((feature) => query.layers.includes(feature.properties.layer))
      .filter((feature) => isFeaturePointInBbox(feature, query.bbox))
      .slice(0, query.limit);

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

  private async fetchMetadata(): Promise<OsmPostgisMetadata> {
    const pool = this.getPool();
    const table = quoteQualifiedIdentifier(this.config.osmPostgisTable);
    const sql = `
      select
        count(*)::bigint as object_count,
        max(imported_at) as last_import_at
      from ${table}
    `;
    const result = await pool.query<{ object_count: string | number; last_import_at: Date | string | null }>(sql);
    const row = result.rows[0];
    return {
      objectCount: numberFromPg(row?.object_count),
      lastImportAt: normalizeTimestamp(row?.last_import_at)
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
  const tags = normalizeTags(row.tags);
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
        towerType: tags["tower:type"]
      }),
      raw: includeRaw ? row : undefined
    }
  };
}

function parseLayer(value: string): SituationLayerId | undefined {
  return value === "ground" || value === "mobile" ? value : undefined;
}

function quoteQualifiedIdentifier(value: string): string {
  const parts = value.split(".").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > 2 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
    throw new Error("Invalid OSM_POSTGIS_TABLE identifier.");
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
