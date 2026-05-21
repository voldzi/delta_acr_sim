import { Pool } from "pg";
import { canonicalizeBboxForCache, formatBboxKey } from "./bbox-cache.js";
import type { SituationDataConfig } from "./config.js";
import { ManagedResponseCache } from "./response-cache.js";
import type { SituationDataSource, SourceCacheStats } from "./sources.js";
import type {
  BoundingBox,
  MobileCoverageQuality,
  MobileCoverageTechnology,
  SituationDataLicense,
  SituationFeature,
  SituationQuery,
  SourceDescriptor,
  SourceFetchResult,
  SourceHealthStatus
} from "./types.js";

const MOBILE_COVERAGE_LICENSE: SituationDataLicense = {
  name: "Estimated mobile coverage model",
  attribution: "DELTA ACR SIM model; OpenStreetMap contributors for tower references",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "Coverage is an estimate, not guaranteed service availability.",
    "Phase 1 uses OSM communications tower references and a distance-based path-loss approximation.",
    "OpenStreetMap-derived references require ODbL attribution and database obligations."
  ]
};

const TECHNOLOGIES: MobileCoverageTechnology[] = ["2G", "4G", "5G"];
const QUALITY_LEVELS: MobileCoverageQuality[] = ["good", "fair", "weak", "none", "unknown"];
const DISCLAIMER = "Coverage is an estimate, not guaranteed service availability.";

interface TowerRow {
  osm_id: string;
  osm_type: string;
  name: string | null;
  lon: number | string;
  lat: number | string;
  tags: Record<string, unknown> | null;
}

interface CoveragePayload {
  generatedAt: string;
  effectiveResolutionM: number;
  towerCount: number;
  features: SituationFeature[];
}

export interface MobileCoverageMetadata {
  layerId: "mobile_coverage";
  modelVersion: string;
  generatedAt: string;
  resolutionM: number;
  technologies: MobileCoverageTechnology[];
  operators: string[];
  qualityLevels: MobileCoverageQuality[];
  demSource: string;
  cacheTtlSeconds: number;
  disclaimer: string;
  assumptions: Record<string, string | number | boolean>;
}

export class MobileCoverageSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly payloadCache: ManagedResponseCache<CoveragePayload>;
  private readonly towerCountCache: ManagedResponseCache<number>;
  private pool?: Pool;

  constructor(private readonly config: SituationDataConfig) {
    this.payloadCache = new ManagedResponseCache<CoveragePayload>({
      ttlMs: Math.max(60, config.mobileCoverageCacheTtlSeconds) * 1000,
      staleIfErrorMs: Math.max(config.mobileCoverageCacheTtlSeconds, config.staleIfErrorSeconds) * 1000,
      maxEntries: Math.max(64, Math.min(config.cacheMaxEntries, 4096))
    });
    this.towerCountCache = new ManagedResponseCache<number>({
      ttlMs: 300_000,
      staleIfErrorMs: Math.max(300, config.staleIfErrorSeconds) * 1000,
      maxEntries: 2
    });
    this.descriptor = {
      sourceId: "mobile_coverage_model",
      label: "Mobile coverage estimate model",
      enabled: config.enabledSources.includes("mobile_coverage_model"),
      mode: "live",
      priority: 64,
      layers: ["mobile_coverage"],
      license: MOBILE_COVERAGE_LICENSE,
      baseUrl: publicPostgisBaseUrl(config.osmPostgisConnectionString),
      updateCadenceSeconds: config.mobileCoverageCacheTtlSeconds
    };
  }

  cacheStats(): SourceCacheStats[] {
    return [
      {
        sourceId: "mobile_coverage_model",
        ...this.payloadCache.stats()
      }
    ];
  }

  async healthStatus(): Promise<SourceHealthStatus> {
    if (!this.config.osmPostgisConnectionString) {
      return {
        sourceId: "mobile_coverage_model",
        status: "degraded",
        backend: this.config.osmPostgisBackend,
        warnings: ["mobile_coverage_model requires OSM_POSTGIS_DATABASE_URL for tower references."]
      };
    }
    try {
      const objectCount = await this.towerCountCache.getOrLoad("tower-count", () => this.fetchTowerCount());
      return {
        sourceId: "mobile_coverage_model",
        status: objectCount > 0 ? "ok" : "degraded",
        backend: this.config.osmPostgisBackend,
        objectCount,
        warnings: objectCount > 0 ? [] : ["mobile_coverage_model has no communications_tower references."]
      };
    } catch (error) {
      return {
        sourceId: "mobile_coverage_model",
        status: "degraded",
        backend: this.config.osmPostgisBackend,
        warnings: [error instanceof Error ? error.message : "Unknown mobile coverage health check failure."]
      };
    }
  }

  metadata(generatedAt = new Date().toISOString()): MobileCoverageMetadata {
    return {
      layerId: "mobile_coverage",
      modelVersion: this.config.mobileCoverageModelVersion,
      generatedAt,
      resolutionM: this.config.mobileCoverageResolutionM,
      technologies: TECHNOLOGIES,
      operators: ["unknown"],
      qualityLevels: QUALITY_LEVELS,
      demSource: this.config.mobileCoverageDemSource,
      cacheTtlSeconds: this.config.mobileCoverageCacheTtlSeconds,
      disclaimer: DISCLAIMER,
      assumptions: this.assumptions()
    };
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("mobile_coverage")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }
    if (!this.config.osmPostgisConnectionString) {
      return {
        source: this.descriptor,
        fetchedAt,
        features: [],
        warnings: ["mobile_coverage_model requires OSM_POSTGIS_DATABASE_URL for tower references."]
      };
    }

    const technologies = query.mobileCoverageTechnologies?.length ? query.mobileCoverageTechnologies : TECHNOLOGIES;
    const operators = query.mobileCoverageOperators?.length ? query.mobileCoverageOperators : ["unknown"];
    if (!operators.includes("unknown")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }

    const cacheBbox = canonicalizeBboxForCache(query.bbox, this.config.bboxCachePaddingDegrees);
    const cacheKey = JSON.stringify({
      bbox: formatBboxKey(cacheBbox),
      technologies,
      operators: ["unknown"],
      limit: query.limit,
      resolutionM: this.config.mobileCoverageResolutionM,
      modelVersion: this.config.mobileCoverageModelVersion
    });
    const payload = await this.payloadCache.getOrLoad(cacheKey, () => this.buildCoverage(cacheBbox, technologies, query.limit));
    const features = payload.features
      .filter((feature) => featureIntersectsBbox(feature, query.bbox))
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
      warnings:
        payload.towerCount > 0
          ? []
          : ["mobile_coverage_model has no communications_tower references in the requested area; features are marked unknown."]
    };
  }

  private async buildCoverage(bbox: BoundingBox, technologies: MobileCoverageTechnology[], limit: number): Promise<CoveragePayload> {
    const generatedAt = new Date().toISOString();
    const maxCells = Math.max(1, Math.floor(Math.min(this.config.mobileCoverageMaxCells, Math.max(1, limit)) / Math.max(1, technologies.length)));
    const grid = buildGrid(bbox, this.config.mobileCoverageResolutionM, maxCells);
    const towers = await this.fetchTowers(expandBboxByMeters(bbox, 30_000), 10_000);
    const features: SituationFeature[] = [];

    for (const cell of grid.cells) {
      const nearest = nearestTower(cell.center, towers);
      for (const technology of technologies) {
        if (features.length >= limit) {
          break;
        }
        features.push(this.coverageFeature(cell, nearest, technology, generatedAt, grid.resolutionM));
      }
      if (features.length >= limit) {
        break;
      }
    }

    return {
      generatedAt,
      effectiveResolutionM: grid.resolutionM,
      towerCount: towers.length,
      features
    };
  }

  private coverageFeature(
    cell: CoverageCell,
    nearest: NearestTower | undefined,
    technology: MobileCoverageTechnology,
    generatedAt: string,
    resolutionM: number
  ): SituationFeature {
    const estimate = nearest ? estimateSignal(nearest.distanceM, technology) : undefined;
    const quality = estimate ? qualityForSignal(estimate.signalDbm) : "unknown";
    const confidence = estimate && nearest ? confidenceForEstimate(nearest.distanceM, technology) : 0.2;
    const featureId = `coverage:mobile:${technology.toLowerCase()}:${cell.id}`;
    return {
      type: "Feature",
      id: featureId,
      geometry: {
        type: "Polygon",
        coordinates: [cell.coordinates]
      },
      properties: {
        featureId,
        layer: "mobile_coverage",
        category: "mobile_coverage",
        label: `${technology} coverage estimate`,
        sourceId: "mobile_coverage_model",
        observedAt: generatedAt,
        confidence,
        stale: false,
        severity: severityForQuality(quality),
        license: {
          name: MOBILE_COVERAGE_LICENSE.name,
          attribution: MOBILE_COVERAGE_LICENSE.attribution
        },
        metrics: compactMetrics({
          distanceToNearestTowerM: nearest ? Math.round(nearest.distanceM) : undefined,
          nearestTowerLon: nearest?.tower.lon,
          nearestTowerLat: nearest?.tower.lat
        }),
        tags: compactTags({
          nearestTowerId: nearest?.tower.id,
          nearestTowerName: nearest?.tower.name
        }),
        operator: "unknown",
        technology,
        quality,
        estimatedSignalDbm: estimate?.signalDbm,
        modelVersion: this.config.mobileCoverageModelVersion,
        generatedAt,
        resolutionM,
        demSource: this.config.mobileCoverageDemSource,
        assumptions: this.assumptions(),
        disclaimer: DISCLAIMER,
        raw: {
          nearestTower: nearest,
          phase: "phase-1-distance-model"
        }
      }
    };
  }

  private assumptions(): Record<string, string | number | boolean> {
    return {
      antennaHeightM: this.config.mobileCoverageAntennaHeightM,
      propagationModel: "distance-path-loss-lite",
      terrainAware: this.config.mobileCoverageTerrainAware,
      landCoverAware: false
    };
  }

  private async fetchTowerCount(): Promise<number> {
    const table = quoteQualifiedIdentifier(this.config.osmPostgisTable);
    const result = await this.getPool().query<{ count: string }>(
      `select count(*)::bigint as count from ${table} where layer = 'mobile' and category = 'communications_tower'`
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  private async fetchTowers(bbox: BoundingBox, limit: number): Promise<Tower[]> {
    const table = quoteQualifiedIdentifier(this.config.osmPostgisTable);
    const sql = `
      select
        osm_id::text,
        osm_type,
        name,
        lon,
        lat,
        tags
      from ${table}
      where geom && st_makeenvelope($1, $2, $3, $4, 4326)
        and layer = 'mobile'
        and category = 'communications_tower'
      limit $5
    `;
    const result = await this.getPool().query<TowerRow>(sql, [bbox.west, bbox.south, bbox.east, bbox.north, Math.max(1, limit)]);
    return result.rows.flatMap((row) => {
      const lon = optionalNumber(row.lon);
      const lat = optionalNumber(row.lat);
      if (lon === undefined || lat === undefined) {
        return [];
      }
      return [
        {
          id: `${row.osm_type}:${row.osm_id}`,
          name: cleanString(row.name),
          lon,
          lat
        }
      ];
    });
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

interface Tower {
  id: string;
  name?: string;
  lon: number;
  lat: number;
}

interface NearestTower {
  tower: Tower;
  distanceM: number;
}

interface CoverageCell {
  id: string;
  center: { lon: number; lat: number };
  coordinates: Array<[number, number]>;
}

function buildGrid(bbox: BoundingBox, requestedResolutionM: number, maxCells: number): { resolutionM: number; cells: CoverageCell[] } {
  const centerLat = (bbox.south + bbox.north) / 2;
  const metersPerLon = metersPerDegreeLon(centerLat);
  const widthM = Math.max(1, (bbox.east - bbox.west) * metersPerLon);
  const heightM = Math.max(1, (bbox.north - bbox.south) * 111_320);
  const requested = Math.max(100, requestedResolutionM);
  const requestedCells = Math.ceil(widthM / requested) * Math.ceil(heightM / requested);
  const resolutionM = requestedCells > maxCells ? Math.ceil(requested * Math.sqrt(requestedCells / Math.max(1, maxCells))) : requested;
  const columns = Math.max(1, Math.ceil(widthM / resolutionM));
  const rows = Math.max(1, Math.ceil(heightM / resolutionM));
  const lonStep = (bbox.east - bbox.west) / columns;
  const latStep = (bbox.north - bbox.south) / rows;
  const cells: CoverageCell[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const west = bbox.west + column * lonStep;
      const east = column === columns - 1 ? bbox.east : west + lonStep;
      const south = bbox.south + row * latStep;
      const north = row === rows - 1 ? bbox.north : south + latStep;
      cells.push({
        id: `${row}-${column}`,
        center: {
          lon: (west + east) / 2,
          lat: (south + north) / 2
        },
        coordinates: [
          [round(west, 6), round(south, 6)],
          [round(east, 6), round(south, 6)],
          [round(east, 6), round(north, 6)],
          [round(west, 6), round(north, 6)],
          [round(west, 6), round(south, 6)]
        ]
      });
    }
  }
  return { resolutionM, cells };
}

function nearestTower(point: { lon: number; lat: number }, towers: Tower[]): NearestTower | undefined {
  let nearest: NearestTower | undefined;
  for (const tower of towers) {
    const distanceM = distanceMeters(point.lon, point.lat, tower.lon, tower.lat);
    if (!nearest || distanceM < nearest.distanceM) {
      nearest = { tower, distanceM };
    }
  }
  return nearest;
}

function estimateSignal(distanceM: number, technology: MobileCoverageTechnology): { signalDbm: number } {
  const distance = Math.max(100, distanceM);
  const technologyPenalty = technology === "2G" ? 0 : technology === "4G" ? 7 : 14;
  const pathLoss = 10 * 3.2 * Math.log10(distance / 100);
  return { signalDbm: Math.round(-58 - pathLoss - technologyPenalty) };
}

function qualityForSignal(signalDbm: number): MobileCoverageQuality {
  if (signalDbm >= -85) {
    return "good";
  }
  if (signalDbm >= -100) {
    return "fair";
  }
  if (signalDbm >= -112) {
    return "weak";
  }
  return "none";
}

function confidenceForEstimate(distanceM: number, technology: MobileCoverageTechnology): number {
  const rangeM = technology === "2G" ? 25_000 : technology === "4G" ? 12_000 : 4_000;
  return round(Math.max(0.28, Math.min(0.72, 0.72 - (distanceM / rangeM) * 0.38)), 2);
}

function severityForQuality(quality: MobileCoverageQuality): "info" | "advisory" | "warning" | "critical" {
  if (quality === "none") {
    return "critical";
  }
  if (quality === "weak") {
    return "warning";
  }
  if (quality === "unknown") {
    return "advisory";
  }
  return "info";
}

function expandBboxByMeters(bbox: BoundingBox, meters: number): BoundingBox {
  const centerLat = (bbox.south + bbox.north) / 2;
  const lonDelta = meters / metersPerDegreeLon(centerLat);
  const latDelta = meters / 111_320;
  return {
    west: Math.max(-180, bbox.west - lonDelta),
    south: Math.max(-90, bbox.south - latDelta),
    east: Math.min(180, bbox.east + lonDelta),
    north: Math.min(90, bbox.north + latDelta)
  };
}

function featureIntersectsBbox(feature: SituationFeature, bbox: BoundingBox): boolean {
  if (feature.geometry.type !== "Polygon") {
    return false;
  }
  const points = feature.geometry.coordinates.flat();
  if (points.length === 0) {
    return false;
  }
  const featureBbox = points.reduce(
    (acc, [lon, lat]) => ({
      west: Math.min(acc.west, lon),
      south: Math.min(acc.south, lat),
      east: Math.max(acc.east, lon),
      north: Math.max(acc.north, lat)
    }),
    { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity }
  );
  return featureBbox.west <= bbox.east && featureBbox.east >= bbox.west && featureBbox.south <= bbox.north && featureBbox.north >= bbox.south;
}

function distanceMeters(lonA: number, latA: number, lonB: number, latB: number): number {
  const centerLat = (latA + latB) / 2;
  const dx = (lonA - lonB) * metersPerDegreeLon(centerLat);
  const dy = (latA - latB) * 111_320;
  return Math.sqrt(dx * dx + dy * dy);
}

function metersPerDegreeLon(lat: number): number {
  return Math.max(1, 111_320 * Math.cos((lat * Math.PI) / 180));
}

function quoteQualifiedIdentifier(value: string): string {
  const parts = value.split(".").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > 2 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
    throw new Error("Invalid OSM_POSTGIS_TABLE identifier.");
  }
  return parts.map((part) => `"${part.replace(/"/g, '""')}"`).join(".");
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

function compactTags(values: Record<string, string | undefined>): Record<string, string> | undefined {
  const entries = Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function compactMetrics(values: Record<string, number | string | boolean | undefined>): Record<string, number | string | boolean> | undefined {
  const entries = Object.entries(values).filter((entry): entry is [string, number | string | boolean] => entry[1] !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
