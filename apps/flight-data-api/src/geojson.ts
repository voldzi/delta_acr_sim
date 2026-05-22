import type { BoundingBox, GeoJsonGeometry } from "./types.js";

export interface GeoJsonFeature {
  type: "Feature";
  geometry?: GeoJsonGeometry | null;
  properties?: Record<string, unknown> | null;
  id?: string | number;
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  name?: string;
  features: GeoJsonFeature[];
}

export function geometryIntersectsBbox(geometry: GeoJsonGeometry | null | undefined, bbox: BoundingBox | undefined): boolean {
  if (!bbox) {
    return true;
  }
  const points = geometryPoints(geometry);
  if (points.length === 0) {
    return false;
  }
  const west = Math.min(...points.map((point) => point[0]));
  const east = Math.max(...points.map((point) => point[0]));
  const south = Math.min(...points.map((point) => point[1]));
  const north = Math.max(...points.map((point) => point[1]));
  return east >= bbox.west && west <= bbox.east && north >= bbox.south && south <= bbox.north;
}

export function geometryPoints(geometry: GeoJsonGeometry | null | undefined): Array<[number, number]> {
  if (!geometry) {
    return [];
  }
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

export function asGeoJsonGeometry(value: unknown): GeoJsonGeometry | undefined {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  if (value.type === "Point" && isPosition(value.coordinates)) {
    return { type: "Point", coordinates: value.coordinates };
  }
  if (value.type === "LineString" && isPositionArray(value.coordinates)) {
    return { type: "LineString", coordinates: value.coordinates };
  }
  if (value.type === "Polygon" && isPositionArrayArray(value.coordinates)) {
    return { type: "Polygon", coordinates: value.coordinates };
  }
  if (value.type === "MultiPolygon" && isPositionArrayArrayArray(value.coordinates)) {
    return { type: "MultiPolygon", coordinates: value.coordinates };
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    Number.isFinite(value[0]) &&
    typeof value[1] === "number" &&
    Number.isFinite(value[1])
  );
}

function isPositionArray(value: unknown): value is Array<[number, number]> {
  return Array.isArray(value) && value.every(isPosition);
}

function isPositionArrayArray(value: unknown): value is Array<Array<[number, number]>> {
  return Array.isArray(value) && value.every(isPositionArray);
}

function isPositionArrayArrayArray(value: unknown): value is Array<Array<Array<[number, number]>>> {
  return Array.isArray(value) && value.every(isPositionArrayArray);
}
