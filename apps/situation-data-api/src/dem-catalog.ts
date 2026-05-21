import { Pool } from "pg";
import type { SituationDataConfig } from "./config.js";
import { ManagedResponseCache } from "./response-cache.js";
import type { BoundingBox, DemCatalogStatus } from "./types.js";

interface DemDatasetRow {
  dataset_id: string;
  source: string;
  version: string;
  resolution_m: number | string;
  tile_count: number | string;
  local_tile_count: number | string;
  object_store_tile_count: number | string;
  imported_at: Date | string | null;
  west: number | string | null;
  south: number | string | null;
  east: number | string | null;
  north: number | string | null;
}

export class DemCatalog {
  private readonly statusCache: ManagedResponseCache<DemCatalogStatus>;
  private pool?: Pool;

  constructor(private readonly config: SituationDataConfig) {
    this.statusCache = new ManagedResponseCache<DemCatalogStatus>({
      ttlMs: 60_000,
      staleIfErrorMs: Math.max(300, config.staleIfErrorSeconds) * 1000,
      maxEntries: 4
    });
  }

  async status(): Promise<DemCatalogStatus> {
    if (!this.config.demEnabled) {
      return {
        enabled: false,
        status: "disabled",
        datasetId: this.config.demDatasetId,
        localCacheDir: this.config.demLocalCacheDir,
        objectStore: this.objectStoreDescriptor(),
        warnings: ["DEM support is disabled. Set DEM_ENABLED=true after importing DEM tiles."]
      };
    }
    if (!this.config.demPostgisConnectionString) {
      return {
        enabled: true,
        status: "degraded",
        datasetId: this.config.demDatasetId,
        localCacheDir: this.config.demLocalCacheDir,
        objectStore: this.objectStoreDescriptor(),
        warnings: ["DEM is enabled but DEM_POSTGIS_DATABASE_URL or OSM_POSTGIS_DATABASE_URL is not configured."]
      };
    }

    return this.statusCache.getOrLoad(this.config.demDatasetId, () => this.fetchStatus());
  }

  async metadata(): Promise<DemCatalogStatus> {
    return this.status();
  }

  private async fetchStatus(): Promise<DemCatalogStatus> {
    const result = await this.getPool().query<DemDatasetRow>(
      `
        select
          d.dataset_id,
          d.source,
          d.version,
          d.resolution_m,
          count(t.tile_id)::bigint as tile_count,
          count(*) filter (where t.available_locally)::bigint as local_tile_count,
          count(*) filter (where t.available_object_store)::bigint as object_store_tile_count,
          max(coalesce(t.imported_at, d.imported_at)) as imported_at,
          st_xmin(st_extent(t.geom)) as west,
          st_ymin(st_extent(t.geom)) as south,
          st_xmax(st_extent(t.geom)) as east,
          st_ymax(st_extent(t.geom)) as north
        from public.dem_datasets d
        left join public.dem_tiles t on t.dataset_id = d.dataset_id
        where d.dataset_id = $1
        group by d.dataset_id, d.source, d.version, d.resolution_m
      `,
      [this.config.demDatasetId]
    );
    const row = result.rows[0];
    if (!row) {
      return {
        enabled: true,
        status: "degraded",
        datasetId: this.config.demDatasetId,
        localCacheDir: this.config.demLocalCacheDir,
        objectStore: this.objectStoreDescriptor(),
        warnings: [`DEM dataset ${this.config.demDatasetId} is not imported in PostGIS.`]
      };
    }

    const tileCount = numberFromPg(row.tile_count);
    const localTileCount = numberFromPg(row.local_tile_count);
    const objectStoreTileCount = numberFromPg(row.object_store_tile_count);
    const warnings: string[] = [];
    if (tileCount <= 0) {
      warnings.push(`DEM dataset ${this.config.demDatasetId} has no tiles.`);
    }
    if (localTileCount <= 0) {
      warnings.push(`DEM dataset ${this.config.demDatasetId} has no local cache tiles.`);
    }
    if (objectStoreTileCount <= 0) {
      warnings.push(`DEM dataset ${this.config.demDatasetId} has no SeaweedFS object-store tiles.`);
    }

    return {
      enabled: true,
      status: warnings.length > 0 ? "degraded" : "ok",
      datasetId: row.dataset_id,
      source: row.source,
      version: row.version,
      resolutionM: numberFromPg(row.resolution_m),
      tileCount,
      localTileCount,
      objectStoreTileCount,
      importedAt: normalizeTimestamp(row.imported_at),
      bbox: bboxFromRow(row),
      localCacheDir: this.config.demLocalCacheDir,
      objectStore: this.objectStoreDescriptor(),
      warnings
    };
  }

  private objectStoreDescriptor(): DemCatalogStatus["objectStore"] {
    return {
      endpoint: publicObjectStoreEndpoint(this.config.demSeaweedfsEndpoint),
      bucket: this.config.demSeaweedfsBucket,
      prefix: this.config.demSeaweedfsPrefix
    };
  }

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: this.config.demPostgisConnectionString,
        max: 2,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: this.config.requestTimeoutMs
      });
    }
    return this.pool;
  }
}

function bboxFromRow(row: DemDatasetRow): BoundingBox | undefined {
  const west = optionalNumber(row.west);
  const south = optionalNumber(row.south);
  const east = optionalNumber(row.east);
  const north = optionalNumber(row.north);
  return west === undefined || south === undefined || east === undefined || north === undefined ? undefined : { west, south, east, north };
}

function numberFromPg(value: string | number | undefined | null): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeTimestamp(value: Date | string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function publicObjectStoreEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) {
    return undefined;
  }
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "configured";
  }
}
