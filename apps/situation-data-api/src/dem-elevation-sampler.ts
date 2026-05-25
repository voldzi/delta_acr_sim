import { existsSync } from "node:fs";
import { Pool } from "pg";
import { fromFile, type GeoTIFFImage } from "geotiff";
import type { BoundingBox } from "./types.js";
import type { SituationDataConfig } from "./config.js";

interface DemTileRow {
  tile_id: string;
  local_path: string | null;
  west: number | string;
  south: number | string;
  east: number | string;
  north: number | string;
}

export interface DemTileRef {
  tileId: string;
  localPath: string;
  bbox: BoundingBox;
}

interface LoadedDemTile {
  image: GeoTIFFImage;
  raster: ArrayLike<number>;
  width: number;
  height: number;
  origin: number[];
  resolution: number[];
  noData: number | null;
}

export interface ElevationSample {
  elevationM: number;
  tileId: string;
}

export class DemElevationSampler {
  private pool?: Pool;
  private readonly tileCache = new Map<string, Promise<LoadedDemTile>>();
  private readonly sampleCache = new Map<string, Promise<ElevationSample | undefined>>();

  constructor(private readonly config: SituationDataConfig) {}

  async tilesForBbox(bbox: BoundingBox): Promise<DemTileRef[]> {
    if (!this.config.demEnabled || !this.config.demPostgisConnectionString) {
      return [];
    }
    const result = await this.getPool().query<DemTileRow>(
      `
        select tile_id, local_path, west, south, east, north
        from public.dem_tiles
        where dataset_id = $1
          and available_locally = true
          and geom && st_makeenvelope($2, $3, $4, $5, 4326)
        order by tile_id
      `,
      [this.config.demDatasetId, bbox.west, bbox.south, bbox.east, bbox.north]
    );
    return result.rows.flatMap((row) => {
      const localPath = cleanString(row.local_path);
      const west = optionalNumber(row.west);
      const south = optionalNumber(row.south);
      const east = optionalNumber(row.east);
      const north = optionalNumber(row.north);
      if (!localPath || west === undefined || south === undefined || east === undefined || north === undefined || !existsSync(localPath)) {
        return [];
      }
      return [{ tileId: row.tile_id, localPath, bbox: { west, south, east, north } }];
    });
  }

  async sample(lon: number, lat: number, tiles: DemTileRef[]): Promise<ElevationSample | undefined> {
    const tile = tiles.find((candidate) => pointInTile(lon, lat, candidate.bbox));
    if (!tile) {
      return undefined;
    }
    const cacheKey = `${tile.tileId}:${round(lon, 5)}:${round(lat, 5)}`;
    const existing = this.sampleCache.get(cacheKey);
    if (existing) {
      return existing;
    }
    const promise = this.sampleFromTile(tile, lon, lat);
    this.sampleCache.set(cacheKey, promise);
    return promise;
  }

  private async sampleFromTile(tile: DemTileRef, lon: number, lat: number): Promise<ElevationSample | undefined> {
    const loaded = await this.loadTile(tile);
    const originX = loaded.origin[0];
    const originY = loaded.origin[1];
    const resX = loaded.resolution[0];
    const resY = loaded.resolution[1];
    if (
      typeof originX !== "number" ||
      typeof originY !== "number" ||
      typeof resX !== "number" ||
      typeof resY !== "number" ||
      !Number.isFinite(originX) ||
      !Number.isFinite(originY) ||
      !Number.isFinite(resX) ||
      !Number.isFinite(resY) ||
      resX === 0 ||
      resY === 0
    ) {
      return undefined;
    }
    const x = clamp(Math.floor((lon - originX) / resX), 0, loaded.width - 1);
    const y = clamp(Math.floor((lat - originY) / resY), 0, loaded.height - 1);
    const value = Number(loaded.raster[y * loaded.width + x]);
    if (!Number.isFinite(value) || (loaded.noData !== null && value === loaded.noData)) {
      return undefined;
    }
    return { elevationM: Math.round(value), tileId: tile.tileId };
  }

  private async loadTile(tile: DemTileRef): Promise<LoadedDemTile> {
    const existing = this.tileCache.get(tile.localPath);
    if (existing) {
      return existing;
    }
    const promise = (async () => {
      const tiff = await fromFile(tile.localPath);
      const image = await tiff.getImage();
      const raster = (await image.readRasters({
        samples: [0],
        interleave: true
      })) as ArrayLike<number>;
      return {
        image,
        raster,
        width: image.getWidth(),
        height: image.getHeight(),
        origin: image.getOrigin(),
        resolution: image.getResolution(),
        noData: image.getGDALNoData()
      };
    })();
    this.tileCache.set(tile.localPath, promise);
    return promise;
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

function pointInTile(lon: number, lat: number, bbox: BoundingBox): boolean {
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
