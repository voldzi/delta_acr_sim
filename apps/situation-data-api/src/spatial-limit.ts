import type { BoundingBox, SituationFeature } from "./types.js";

interface Bucket {
  x: number;
  y: number;
  features: SituationFeature[];
}

interface SpatialLimitOptions {
  score?: (feature: SituationFeature) => number;
}

export function spatiallyLimitFeatures(features: SituationFeature[], limit: number, bbox: BoundingBox, options: SpatialLimitOptions = {}): SituationFeature[] {
  const maxFeatures = Math.max(0, Math.floor(limit));
  if (maxFeatures === 0 || features.length === 0) {
    return [];
  }
  if (features.length <= maxFeatures) {
    return features;
  }

  const bucketCount = Math.max(1, Math.ceil(Math.sqrt(maxFeatures)));
  const lonSpan = Math.max(Number.EPSILON, bbox.east - bbox.west);
  const latSpan = Math.max(Number.EPSILON, bbox.north - bbox.south);
  const bucketsByKey = new Map<string, Bucket>();

  for (const feature of features) {
    const envelope = featureEnvelope(feature);
    if (!envelope) {
      continue;
    }
    const centerLon = (envelope.west + envelope.east) / 2;
    const centerLat = (envelope.south + envelope.north) / 2;
    const x = clampBucket(Math.floor(((centerLon - bbox.west) / lonSpan) * bucketCount), bucketCount);
    const y = clampBucket(Math.floor(((centerLat - bbox.south) / latSpan) * bucketCount), bucketCount);
    const key = `${y}:${x}`;
    const bucket = bucketsByKey.get(key) ?? { x, y, features: [] };
    bucket.features.push(feature);
    bucketsByKey.set(key, bucket);
  }

  const score = options.score ?? defaultFeatureScore;
  const buckets = Array.from(bucketsByKey.values())
    .map((bucket) => ({
      ...bucket,
      features: bucket.features.sort(
        (a, b) => score(b) - score(a) || String(a.id ?? a.properties.featureId).localeCompare(String(b.id ?? b.properties.featureId))
      )
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const selected: SituationFeature[] = [];
  let depth = 0;
  while (selected.length < maxFeatures) {
    const candidates = buckets.filter((bucket) => bucket.features[depth]);
    if (candidates.length === 0) {
      break;
    }
    const remaining = maxFeatures - selected.length;
    const chosenBuckets = candidates.length > remaining ? evenlySample(candidates, remaining) : candidates;
    for (const bucket of chosenBuckets) {
      const feature = bucket.features[depth];
      if (feature) {
        selected.push(feature);
      }
    }
    depth += 1;
  }

  return selected;
}

function evenlySample<T>(items: T[], limit: number): T[] {
  if (limit >= items.length) {
    return items;
  }
  const sampled: T[] = [];
  for (let index = 0; index < limit; index += 1) {
    sampled.push(items[Math.floor((index * items.length) / limit)] as T);
  }
  return sampled;
}

function clampBucket(value: number, bucketCount: number): number {
  return Math.max(0, Math.min(bucketCount - 1, value));
}

function defaultFeatureScore(feature: SituationFeature): number {
  const quality = String(feature.properties.quality ?? displayQuality(feature) ?? "unknown");
  const confidence = typeof feature.properties.confidence === "number" ? feature.properties.confidence : 0;
  return qualityScore(quality) * 10 + confidence;
}

function displayQuality(feature: SituationFeature): unknown {
  const providerProperties = feature.properties.providerProperties;
  if (!providerProperties || typeof providerProperties !== "object" || !("display" in providerProperties)) {
    return undefined;
  }
  const display = providerProperties.display;
  if (!display || typeof display !== "object" || !("quality" in display)) {
    return undefined;
  }
  return display.quality;
}

function qualityScore(quality: string): number {
  switch (quality) {
    case "good":
      return 5;
    case "fair":
      return 4;
    case "weak":
      return 3;
    case "unknown":
      return 2;
    case "none":
      return 1;
    default:
      return 0;
  }
}

function featureEnvelope(feature: SituationFeature): BoundingBox | undefined {
  const coordinates = featureCoordinates(feature.geometry);
  if (coordinates.length === 0) {
    return undefined;
  }
  return coordinates.reduce(
    (acc, [lon, lat]) => ({
      west: Math.min(acc.west, lon),
      south: Math.min(acc.south, lat),
      east: Math.max(acc.east, lon),
      north: Math.max(acc.north, lat)
    }),
    { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity }
  );
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
    default:
      return [];
  }
}
