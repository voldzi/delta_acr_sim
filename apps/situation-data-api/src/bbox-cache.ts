import type { BoundingBox } from "./types.js";

export interface CanonicalBbox extends BoundingBox {
  gridDegrees: number;
  paddingDegrees: number;
}

const CACHE_GRID_DEGREES = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5] as const;

export function canonicalizeBboxForCache(bbox: BoundingBox, paddingDegrees = 0.18): CanonicalBbox {
  if (isCanonicalBbox(bbox)) {
    return bbox;
  }
  const normalized = normalizeBbox(bbox);
  const viewportSpan = Math.max(normalized.east - normalized.west, normalized.north - normalized.south);
  const gridDegrees = gridForViewportSpan(viewportSpan);
  const padding = Math.max(0, paddingDegrees);
  const padded = {
    west: clampLon(normalized.west - padding),
    south: clampLat(normalized.south - padding),
    east: clampLon(normalized.east + padding),
    north: clampLat(normalized.north + padding)
  };

  return {
    west: round(clampLon(snapDown(padded.west, gridDegrees)), 6),
    south: round(clampLat(snapDown(padded.south, gridDegrees)), 6),
    east: round(clampLon(snapUp(padded.east, gridDegrees)), 6),
    north: round(clampLat(snapUp(padded.north, gridDegrees)), 6),
    gridDegrees,
    paddingDegrees: round(padding, 6)
  };
}

function isCanonicalBbox(bbox: BoundingBox): bbox is CanonicalBbox {
  const candidate = bbox as Partial<CanonicalBbox>;
  return typeof candidate.gridDegrees === "number" && typeof candidate.paddingDegrees === "number";
}

export function roundPointToGrid(lon: number, lat: number, gridDegrees: number): { lon: number; lat: number; gridDegrees: number } {
  const grid = Math.max(0.001, gridDegrees);
  return {
    lon: round(clampLon(Math.round(lon / grid) * grid), 6),
    lat: round(clampLat(Math.round(lat / grid) * grid), 6),
    gridDegrees: grid
  };
}

export function formatBboxKey(bbox: BoundingBox): string {
  return [bbox.west, bbox.south, bbox.east, bbox.north].map((value) => round(value, 6)).join(",");
}

function gridForViewportSpan(span: number): number {
  if (span <= 0.1) {
    return CACHE_GRID_DEGREES[0];
  }
  if (span <= 0.25) {
    return CACHE_GRID_DEGREES[1];
  }
  if (span <= 0.75) {
    return CACHE_GRID_DEGREES[2];
  }
  if (span <= 1.5) {
    return CACHE_GRID_DEGREES[3];
  }
  if (span <= 3.5) {
    return CACHE_GRID_DEGREES[4];
  }
  return CACHE_GRID_DEGREES[5];
}

function normalizeBbox(bbox: BoundingBox): BoundingBox {
  return {
    west: Math.min(bbox.west, bbox.east),
    south: Math.min(bbox.south, bbox.north),
    east: Math.max(bbox.west, bbox.east),
    north: Math.max(bbox.south, bbox.north)
  };
}

function snapDown(value: number, grid: number): number {
  return Math.floor(value / grid) * grid;
}

function snapUp(value: number, grid: number): number {
  return Math.ceil(value / grid) * grid;
}

function clampLon(value: number): number {
  return Math.max(-180, Math.min(180, value));
}

function clampLat(value: number): number {
  return Math.max(-90, Math.min(90, value));
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
