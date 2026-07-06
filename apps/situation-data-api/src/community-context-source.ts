import { Pool } from "pg";
import { canonicalizeBboxForCache, formatBboxKey } from "./bbox-cache.js";
import type { SituationDataConfig } from "./config.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type { SituationDataSource, SourceCacheStats } from "./sources.js";
import type { BoundingBox, SituationDataLicense, SituationFeature, SituationQuery, SourceDescriptor, SourceFetchResult, SourceHealthStatus } from "./types.js";

export const COMMUNITY_CONTEXT_LICENSE: SituationDataLicense = {
  name: "OpenStreetMap ODbL 1.0 + CSM SIM normalized community context",
  url: "https://opendatacommons.org/licenses/odbl/1-0/",
  attribution: "OpenStreetMap contributors; normalized by CSM SIM",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "This source publishes practical community context from a local OSM/PostGIS read model.",
    "Features are reference data, not verified current operational status.",
    "Future user-submitted observations and photos must use COP/community moderation before being promoted to verified context."
  ]
};

interface CommunityPoiRow {
  osm_id: string;
  osm_type: string;
  category: string;
  name: string | null;
  lon: number | string;
  lat: number | string;
  tags: Record<string, unknown> | null;
  imported_at: Date | string | null;
}

interface CommunityContextMetadata {
  objectCount: number;
  lastImportAt?: string;
}

const COMMUNITY_CATEGORIES = [
  "toilets",
  "drinking_water",
  "water_point",
  "shower",
  "charging_station",
  "fuel",
  "bicycle_repair_station",
  "internet_cafe",
  "library",
  "community_centre",
  "townhall",
  "pharmacy",
  "healthcare_pharmacy",
  "defibrillator",
  "shelter",
  "assembly_point"
] as const;

const COMMUNITY_CATEGORY_SET = new Set<string>(COMMUNITY_CATEGORIES);

export class CommunityContextSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly payloadCache: ManagedResponseCache<CommunityPoiRow[]>;
  private readonly metadataCache: ManagedResponseCache<CommunityContextMetadata>;
  private pool?: Pool;

  constructor(private readonly config: SituationDataConfig) {
    this.payloadCache = new ManagedResponseCache<CommunityPoiRow[]>({
      ttlMs: Math.max(60, config.osmPostgisCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.osmPostgisCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(64, Math.min(config.cacheMaxEntries, 4096))
    });
    this.metadataCache = new ManagedResponseCache<CommunityContextMetadata>({
      ttlMs: 60_000,
      staleIfErrorMs: Math.max(300, config.staleIfErrorSeconds) * 1000,
      maxEntries: 4
    });
    this.descriptor = {
      sourceId: "community_context",
      label: "Community context reference layer",
      enabled: config.enabledSources.includes("community_context"),
      mode: "reference",
      priority: 58,
      layers: ["community_places"],
      license: COMMUNITY_CONTEXT_LICENSE,
      baseUrl: publicPostgisBaseUrl(config.osmPostgisConnectionString),
      updateCadenceSeconds: config.osmPostgisCacheTtlSeconds
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [
      {
        sourceId: "community_context",
        ...this.payloadCache.stats()
      }
    ];
  }

  async healthStatus(): Promise<SourceHealthStatus> {
    const warnings: string[] = [];
    if (!this.config.osmPostgisConnectionString) {
      return {
        sourceId: "community_context",
        status: "degraded",
        backend: this.config.osmPostgisBackend,
        warnings: ["community_context requires OSM_POSTGIS_DATABASE_URL because it reads the local OSM/PostGIS reference model."]
      };
    }

    try {
      const metadata = await this.metadataCache.getOrLoad("metadata", () => this.fetchMetadata());
      if (metadata.objectCount <= 0) {
        warnings.push(`${this.config.osmPostgisTable} has no community context categories. Rebuild the OSM POI materialized view.`);
      }
      if (!metadata.lastImportAt) {
        warnings.push(`${this.config.osmPostgisTable} has no imported_at timestamp for community context.`);
      }
      return {
        sourceId: "community_context",
        status: warnings.length > 0 ? "degraded" : "ok",
        backend: this.config.osmPostgisBackend,
        objectCount: metadata.objectCount,
        lastImportAt: metadata.lastImportAt,
        lastImportAgeSeconds: metadata.lastImportAt ? Math.max(0, Math.round((Date.now() - Date.parse(metadata.lastImportAt)) / 1000)) : undefined,
        warnings
      };
    } catch (error) {
      return {
        sourceId: "community_context",
        status: "degraded",
        backend: this.config.osmPostgisBackend,
        warnings: [error instanceof Error ? error.message : "Unknown community_context health check failure."]
      };
    }
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("community_places")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }
    if (!this.config.osmPostgisConnectionString) {
      return {
        source: this.descriptor,
        fetchedAt,
        features: [],
        warnings: ["community_context is enabled but OSM_POSTGIS_DATABASE_URL is not configured."]
      };
    }

    const cacheBbox = canonicalizeBboxForCache(query.bbox, this.config.bboxCachePaddingDegrees);
    const queryLimit = Math.max(1, Math.min(5000, query.limit));
    const rows = await this.payloadCache.getOrLoad(
      JSON.stringify({
        bbox: formatBboxKey(cacheBbox),
        categories: COMMUNITY_CATEGORIES,
        limit: queryLimit
      }),
      () => this.fetchRows(cacheBbox, queryLimit)
    );
    const features = rows
      .map((row) => mapCommunityPoiRow(row, fetchedAt, query.includeRaw))
      .filter((feature): feature is SituationFeature => Boolean(feature))
      .filter((feature) => isFeaturePointInBbox(feature, query.bbox))
      .slice(0, query.limit);

    return {
      source: this.descriptor,
      fetchedAt,
      features,
      warnings: []
    };
  }

  private async fetchRows(bbox: BoundingBox, limit: number): Promise<CommunityPoiRow[]> {
    const pool = this.getPool();
    const table = quoteQualifiedIdentifier(this.config.osmPostgisTable);
    const sql = `
      select
        osm_id::text,
        osm_type,
        category,
        name,
        lon,
        lat,
        tags,
        imported_at
      from ${table}
      where geom && st_makeenvelope($1, $2, $3, $4, 4326)
        and category = any($5::text[])
      order by
        case category
          when 'defibrillator' then 1
          when 'pharmacy' then 2
          when 'healthcare_pharmacy' then 2
          when 'drinking_water' then 3
          when 'water_point' then 4
          when 'toilets' then 5
          when 'charging_station' then 6
          when 'fuel' then 7
          when 'shelter' then 8
          when 'assembly_point' then 9
          when 'community_centre' then 10
          when 'townhall' then 11
          else 20
        end,
        name nulls last,
        osm_id
      limit $6
    `;
    const result = await pool.query<CommunityPoiRow>(sql, [
      bbox.west,
      bbox.south,
      bbox.east,
      bbox.north,
      COMMUNITY_CATEGORIES,
      Math.max(1, Math.min(5000, limit))
    ]);
    return result.rows;
  }

  private async fetchMetadata(): Promise<CommunityContextMetadata> {
    const pool = this.getPool();
    const table = quoteQualifiedIdentifier(this.config.osmPostgisTable);
    const sql = `
      select
        count(*)::bigint as object_count,
        max(imported_at) as last_import_at
      from ${table}
      where category = any($1::text[])
    `;
    const result = await pool.query<{ object_count: string | number; last_import_at: Date | string | null }>(sql, [COMMUNITY_CATEGORIES]);
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

function mapCommunityPoiRow(row: CommunityPoiRow, fetchedAt: string, includeRaw: boolean): SituationFeature | undefined {
  const lon = optionalNumber(row.lon);
  const lat = optionalNumber(row.lat);
  const rawCategory = cleanString(row.category);
  const osmType = cleanString(row.osm_type) ?? "object";
  const osmId = cleanString(row.osm_id);
  if (lon === undefined || lat === undefined || !rawCategory || !osmId || !COMMUNITY_CATEGORY_SET.has(rawCategory)) {
    return undefined;
  }

  const tags = normalizeTags(row.tags);
  const category = normalizedCommunityCategory(rawCategory);
  const labelCs = cleanString(row.name) ?? tags.name ?? communityCategoryLabelCs(category);
  const labelEn = cleanString(row.name) ?? tags["name:en"] ?? communityCategoryLabelEn(category);
  const importedAt = normalizeTimestamp(row.imported_at) ?? fetchedAt;
  const id = `community_places:osm_postgis:${osmType}:${osmId}:${category}`;
  const summaryCs = communitySummaryCs(category, labelCs);
  const summaryEn = communitySummaryEn(category, labelEn);
  const confidence = communityConfidence(category);
  const canAcceptContributions = true;

  return {
    type: "Feature",
    id,
    geometry: {
      type: "Point",
      coordinates: [round(lon, 6), round(lat, 6)]
    },
    properties: {
      featureId: id,
      layer: "community_places",
      category,
      label: labelCs,
      labelLocalized: { cs: labelCs, en: labelEn },
      summary: summaryCs,
      summaryLocalized: { cs: summaryCs, en: summaryEn },
      sourceId: "community_context",
      source: "osm_postgis",
      sourceName: "SIM community context reference layer",
      observedAt: importedAt,
      validFrom: importedAt,
      updatedAt: importedAt,
      confidence,
      stale: false,
      severity: "info",
      license: {
        name: COMMUNITY_CONTEXT_LICENSE.name,
        attribution: COMMUNITY_CONTEXT_LICENSE.attribution,
        url: COMMUNITY_CONTEXT_LICENSE.url
      },
      basis: ["osm_postgis", "local_postgis_read_model", "community_context_reference"],
      sourceRevision: `community-context:${importedAt}`,
      readModel: true,
      styleHint: "community-place-osm-v1",
      iconHint: communityIcon(category),
      dataQuality: "observed",
      metrics: {
        ageSeconds: 0,
        confidencePercent: Math.round(confidence * 100)
      },
      tags: compactTags({
        osmId,
        osmType,
        importedAt,
        category,
        rawCategory,
        amenity: tags.amenity,
        emergency: tags.emergency,
        healthcare: tags.healthcare,
        tourism: tags.tourism,
        access: tags.access,
        wheelchair: tags.wheelchair,
        fee: tags.fee,
        openingHours: tags.opening_hours,
        communityStatus: "reference_only",
        sourceAuthority: "reference",
        sourceRevision: `community-context:${importedAt}`
      }),
      providerProperties: {
        community: {
          contractVersion: "sim-community-context-v1",
          placeId: id,
          source: "osm",
          sourceId: "osm_postgis",
          sourceAuthority: "reference",
          communityStatus: "reference_only",
          category,
          rawCategory,
          categoryGroup: communityCategoryGroup(category),
          categoryLabelLocalized: {
            cs: communityCategoryLabelCs(category),
            en: communityCategoryLabelEn(category)
          },
          openingHours: tags.opening_hours,
          access: tags.access,
          wheelchair: tags.wheelchair,
          fee: tags.fee,
          payment: tags.payment,
          website: tags.website,
          canAcceptContributions,
          acceptedContributionTypes: ["photo", "review", "status_report", "proposed_edit"],
          proofOfVisitRecommended: true,
          moderationRequired: true,
          license: COMMUNITY_CONTEXT_LICENSE.name,
          attribution: COMMUNITY_CONTEXT_LICENSE.attribution,
          mayDisplayContact: false,
          notesLocalized: {
            cs: "Referenční komunitní objekt z OSM. Aktuální dostupnost musí potvrdit uživatel nebo správce.",
            en: "Reference community object from OSM. Current availability must be confirmed by a user or moderator."
          }
        },
        display: {
          styleProfile: "community-place-osm-v1",
          icon: communityIcon(category),
          label: labelCs,
          subtitle: communityCategoryLabelCs(category),
          minZoomHint: communityMinZoom(category),
          badgeTone: communityBadgeTone(category)
        }
      },
      raw: includeRaw ? { ...row, tags: scrubPublicTags(row.tags) } : undefined
    }
  };
}

function normalizedCommunityCategory(category: string): string {
  const mapping: Record<string, string> = {
    toilets: "toilet",
    drinking_water: "drinking_water",
    water_point: "water_point",
    shower: "shower",
    charging_station: "charging",
    fuel: "fuel",
    bicycle_repair_station: "bicycle_repair",
    internet_cafe: "internet_access",
    library: "public_library",
    community_centre: "community_centre",
    townhall: "municipal_office",
    pharmacy: "pharmacy",
    healthcare_pharmacy: "pharmacy",
    defibrillator: "defibrillator",
    shelter: "shelter",
    assembly_point: "assembly_point"
  };
  return mapping[category] ?? category;
}

function communityCategoryGroup(category: string): string {
  if (["toilet", "shower"].includes(category)) {
    return "sanitation";
  }
  if (["drinking_water", "water_point"].includes(category)) {
    return "water";
  }
  if (["charging", "internet_access"].includes(category)) {
    return "connectivity";
  }
  if (["defibrillator", "pharmacy"].includes(category)) {
    return "health";
  }
  if (["shelter", "assembly_point", "community_centre", "municipal_office"].includes(category)) {
    return "civic_support";
  }
  if (["fuel", "bicycle_repair"].includes(category)) {
    return "mobility";
  }
  return "community";
}

function communityCategoryLabelCs(category: string): string {
  const labels: Record<string, string> = {
    toilet: "WC / veřejná toaleta",
    drinking_water: "pitná voda",
    water_point: "zdroj vody",
    shower: "sprcha",
    charging: "nabíjení",
    fuel: "čerpací stanice",
    bicycle_repair: "servis kol",
    internet_access: "internet / Wi-Fi",
    public_library: "knihovna",
    community_centre: "komunitní centrum",
    municipal_office: "obecní úřad",
    pharmacy: "lékárna",
    defibrillator: "AED / defibrilátor",
    shelter: "přístřeší",
    assembly_point: "shromaždiště"
  };
  return labels[category] ?? "komunitní bod";
}

function communityCategoryLabelEn(category: string): string {
  const labels: Record<string, string> = {
    toilet: "toilet / restroom",
    drinking_water: "drinking water",
    water_point: "water point",
    shower: "shower",
    charging: "charging point",
    fuel: "fuel station",
    bicycle_repair: "bicycle repair",
    internet_access: "internet / Wi-Fi",
    public_library: "library",
    community_centre: "community centre",
    municipal_office: "municipal office",
    pharmacy: "pharmacy",
    defibrillator: "AED / defibrillator",
    shelter: "shelter",
    assembly_point: "assembly point"
  };
  return labels[category] ?? "community point";
}

function communitySummaryCs(category: string, label: string): string {
  return `${label}: ${communityCategoryLabelCs(category)} z referenční komunitní vrstvy SIM.`;
}

function communitySummaryEn(category: string, label: string): string {
  return `${label}: ${communityCategoryLabelEn(category)} from the SIM community reference layer.`;
}

function communityIcon(category: string): string {
  const icons: Record<string, string> = {
    toilet: "community-toilet",
    drinking_water: "community-water",
    water_point: "community-water",
    shower: "community-shower",
    charging: "community-charging",
    fuel: "community-fuel",
    bicycle_repair: "community-repair",
    internet_access: "community-wifi",
    public_library: "community-library",
    community_centre: "community-centre",
    municipal_office: "community-office",
    pharmacy: "community-pharmacy",
    defibrillator: "community-aed",
    shelter: "community-shelter",
    assembly_point: "community-assembly"
  };
  return icons[category] ?? "community-place";
}

function communityBadgeTone(category: string): string {
  if (["defibrillator", "pharmacy"].includes(category)) {
    return "health";
  }
  if (["drinking_water", "water_point"].includes(category)) {
    return "water";
  }
  if (["toilet", "shower"].includes(category)) {
    return "sanitation";
  }
  return "reference";
}

function communityConfidence(category: string): number {
  if (["defibrillator", "pharmacy", "municipal_office"].includes(category)) {
    return 0.84;
  }
  if (["toilet", "drinking_water", "water_point", "shelter", "community_centre"].includes(category)) {
    return 0.78;
  }
  return 0.72;
}

function communityMinZoom(category: string): number {
  if (["defibrillator", "pharmacy", "municipal_office", "fuel"].includes(category)) {
    return 11;
  }
  return 13;
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

function normalizeTags(value: Record<string, unknown> | null): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function scrubPublicTags(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  const blocked = new Set(["phone", "contact:phone", "email", "contact:email", "fax", "contact:fax"]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !blocked.has(key)));
}

function quoteQualifiedIdentifier(value: string, label = "OSM_POSTGIS_TABLE"): string {
  const parts = value.split(".");
  if (parts.length === 0 || parts.length > 2 || parts.some((part) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(part))) {
    throw new Error(`${label} must be an unquoted table name like public.osm_poi.`);
  }
  return parts.map((part) => `"${part}"`).join(".");
}

function isFeaturePointInBbox(feature: SituationFeature, bbox: BoundingBox): boolean {
  if (feature.geometry.type !== "Point") {
    return true;
  }
  const [lon, lat] = feature.geometry.coordinates;
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeTimestamp(value: Date | string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function compactTags(values: Record<string, string | undefined>): Record<string, string> | undefined {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
