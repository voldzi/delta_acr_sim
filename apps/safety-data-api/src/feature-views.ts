import { publicChmiTaxonomyEntries } from "./chmi-taxonomy.js";
import { LAYERS } from "./layers.js";
import type {
  BoundingBox,
  SafetyDataSourceId,
  SafetyFeature,
  SafetyFeatureCollection,
  SafetyFeatureProperties,
  SafetyGeometry,
  SafetyLayerId
} from "./types.js";

export interface FeatureGeometrySummary {
  type: SafetyGeometry["type"];
  bbox?: BoundingBox;
  centroid?: [number, number];
  coordinateCount: number;
  geometryRole: "feature_geometry";
}

export interface SafetyFeatureSummary {
  featureId: string;
  layer: SafetyLayerId;
  layerId: string;
  providerId: "sim.safety-data";
  providerLayerId: string;
  sourceId: SafetyDataSourceId;
  sourceName: string;
  label: string;
  description?: string;
  category: string;
  hazardType: string;
  typeCode?: string;
  sourceCode?: string;
  sourceSystem?: string;
  severity: SafetyFeatureProperties["severity"];
  status: string;
  stale: boolean;
  confidence: number;
  observedAt: string;
  validFrom: string;
  validUntil?: string;
  updatedAt: string;
  areaName?: string;
  styleHint?: string;
  iconHint?: string;
  metrics?: Record<string, number | string | boolean>;
  presentation?: Record<string, unknown>;
  taxonomy?: Record<string, unknown>;
  geometrySummary: FeatureGeometrySummary;
  links: {
    detail: string;
    geometry: string;
  };
}

export interface SafetyFeatureSummaryCollection {
  contractVersion: "sim-provider-feature-summary-v1";
  generatedAt: string;
  providerId: "sim.safety-data";
  source: SafetyFeatureCollection["source"];
  query: SafetyFeatureCollection["query"];
  summary: SafetyFeatureCollection["summary"] & {
    omittedGeometry: true;
  };
  features: SafetyFeatureSummary[];
  sources: SafetyFeatureCollection["sources"];
  warnings: string[];
}

export interface SafetyFeatureDetail {
  contractVersion: "sim-provider-feature-detail-v1";
  generatedAt: string;
  providerId: "sim.safety-data";
  source: SafetyFeatureCollection["source"];
  query: SafetyFeatureCollection["query"];
  summary: SafetyFeatureSummary;
  properties: Omit<SafetyFeatureProperties, "raw">;
  localized?: Record<string, Record<string, unknown>>;
  providerProperties?: Record<string, unknown>;
  links: {
    geometry: string;
    sourceDetail?: string;
    timeline?: string;
  };
  warnings: string[];
}

export interface SafetyFeatureGeometryDocument {
  contractVersion: "sim-provider-feature-geometry-v1";
  generatedAt: string;
  providerId: "sim.safety-data";
  featureId: string;
  layer: SafetyLayerId;
  layerId: string;
  providerLayerId: string;
  resolution: "native";
  geometry: SafetyGeometry;
  geometrySummary: FeatureGeometrySummary;
}

export interface SafetyTaxonomyDocument {
  contractVersion: "sim-provider-taxonomy-v1";
  generatedAt: string;
  providerId: "sim.safety-data";
  taxonomies: Array<{
    taxonomyId: string;
    label: string;
    entries: unknown[];
  }>;
}

export function buildSafetyFeatureSummaryCollection(collection: SafetyFeatureCollection): SafetyFeatureSummaryCollection {
  return {
    contractVersion: "sim-provider-feature-summary-v1",
    generatedAt: new Date().toISOString(),
    providerId: "sim.safety-data",
    source: collection.source,
    query: collection.query,
    summary: {
      ...collection.summary,
      omittedGeometry: true
    },
    features: collection.features.map((feature) => summarizeSafetyFeature(feature, collection.query)),
    sources: collection.sources,
    warnings: collection.warnings
  };
}

export function buildSafetyFeatureDetail(collection: SafetyFeatureCollection, feature: SafetyFeature): SafetyFeatureDetail {
  const { raw: _raw, ...properties } = feature.properties;
  return {
    contractVersion: "sim-provider-feature-detail-v1",
    generatedAt: new Date().toISOString(),
    providerId: "sim.safety-data",
    source: collection.source,
    query: collection.query,
    summary: summarizeSafetyFeature(feature, collection.query),
    properties,
    localized: feature.properties.localized,
    providerProperties: feature.properties.providerProperties,
    links: {
      geometry: safetyFeatureGeometryUrl(feature.id, collection.query),
      sourceDetail: feature.properties.detailUrl,
      timeline: feature.properties.timelineUrl
    },
    warnings: collection.warnings
  };
}

export function buildSafetyFeatureGeometry(feature: SafetyFeature): SafetyFeatureGeometryDocument {
  return {
    contractVersion: "sim-provider-feature-geometry-v1",
    generatedAt: new Date().toISOString(),
    providerId: "sim.safety-data",
    featureId: feature.id,
    layer: feature.properties.layer,
    layerId: feature.properties.layerId ?? safetyCatalogLayerId(feature.properties.layer),
    providerLayerId: feature.properties.providerLayerId ?? safetyProviderLayerId(feature.properties.layer),
    resolution: "native",
    geometry: feature.geometry,
    geometrySummary: summarizeGeometry(feature.geometry)
  };
}

export function buildSafetyTaxonomy(): SafetyTaxonomyDocument {
  return {
    contractVersion: "sim-provider-taxonomy-v1",
    generatedAt: new Date().toISOString(),
    providerId: "sim.safety-data",
    taxonomies: [
      {
        taxonomyId: "chmi.sivs",
        label: "CHMI SIVS/CAP canonical hazard taxonomy",
        entries: publicChmiTaxonomyEntries()
      },
      {
        taxonomyId: "sim.safety.layers",
        label: "SIM safety provider layers",
        entries: LAYERS.map((layer) => ({
          layerId: layer.layerId,
          label: layer.label,
          description: layer.description,
          defaultVisible: layer.defaultVisible,
          geometryTypes: layer.geometryTypes,
          expectedCadenceSeconds: layer.expectedCadenceSeconds,
          catalogLayerId: safetyCatalogLayerId(layer.layerId),
          providerLayerId: safetyProviderLayerId(layer.layerId)
        }))
      },
      {
        taxonomyId: "sim.safety.severity",
        label: "SIM normalized safety severity",
        entries: [
          { severity: "info", rank: 0, label: { cs: "Informace", en: "Information" } },
          { severity: "advisory", rank: 1, label: { cs: "Upozorneni", en: "Advisory" } },
          { severity: "warning", rank: 2, label: { cs: "Vystraha", en: "Warning" } },
          { severity: "critical", rank: 3, label: { cs: "Kriticke", en: "Critical" } }
        ]
      }
    ]
  };
}

export function findSafetyFeature(collection: SafetyFeatureCollection, featureId: string): SafetyFeature | undefined {
  return collection.features.find((feature) => feature.id === featureId || feature.properties.featureId === featureId);
}

function summarizeSafetyFeature(feature: SafetyFeature, query?: SafetyFeatureCollection["query"]): SafetyFeatureSummary {
  const providerProperties = recordValue(feature.properties.providerProperties);
  return {
    featureId: feature.id,
    layer: feature.properties.layer,
    layerId: feature.properties.layerId ?? safetyCatalogLayerId(feature.properties.layer),
    providerId: "sim.safety-data",
    providerLayerId: feature.properties.providerLayerId ?? safetyProviderLayerId(feature.properties.layer),
    sourceId: feature.properties.sourceId,
    sourceName: feature.properties.sourceName,
    label: feature.properties.headline,
    description: feature.properties.description,
    category: feature.properties.category,
    hazardType: feature.properties.hazardType,
    typeCode: feature.properties.typeCode,
    sourceCode: feature.properties.sourceCode,
    sourceSystem: feature.properties.sourceSystem,
    severity: feature.properties.severity,
    status: feature.properties.status,
    stale: feature.properties.stale,
    confidence: feature.properties.confidence,
    observedAt: feature.properties.observedAt,
    validFrom: feature.properties.validFrom,
    validUntil: feature.properties.validUntil,
    updatedAt: feature.properties.updatedAt,
    areaName: feature.properties.areaName,
    styleHint: feature.properties.styleHint,
    iconHint: feature.properties.iconHint,
    metrics: feature.properties.metrics,
    presentation: recordValue(providerProperties?.presentation),
    taxonomy: recordValue(providerProperties?.taxonomy),
    geometrySummary: summarizeGeometry(feature.geometry),
    links: {
      detail: safetyFeatureDetailUrl(feature.id, query),
      geometry: safetyFeatureGeometryUrl(feature.id, query)
    }
  };
}

function summarizeGeometry(geometry: SafetyGeometry): FeatureGeometrySummary {
  const points = geometryPoints(geometry);
  return {
    type: geometry.type,
    bbox: bboxForPoints(points),
    centroid: centroidForPoints(points),
    coordinateCount: points.length,
    geometryRole: "feature_geometry"
  };
}

function geometryPoints(geometry: SafetyGeometry): Array<[number, number]> {
  if (geometry.type === "Point") {
    return [geometry.coordinates];
  }
  if (geometry.type === "Polygon") {
    const points: Array<[number, number]> = [];
    for (const ring of geometry.coordinates) {
      for (const point of ring) {
        points.push(point);
      }
    }
    return points;
  }
  const points: Array<[number, number]> = [];
  for (const polygon of geometry.coordinates) {
    for (const ring of polygon) {
      for (const point of ring) {
        points.push(point);
      }
    }
  }
  return points;
}

function bboxForPoints(points: Array<[number, number]>): BoundingBox | undefined {
  const first = points[0];
  if (!first) {
    return undefined;
  }
  let west = first[0];
  let east = first[0];
  let south = first[1];
  let north = first[1];
  for (const [lon, lat] of points.slice(1)) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return { west: roundCoord(west), south: roundCoord(south), east: roundCoord(east), north: roundCoord(north) };
}

function centroidForPoints(points: Array<[number, number]>): [number, number] | undefined {
  if (points.length === 0) {
    return undefined;
  }
  const [lonSum, latSum] = points.reduce<[number, number]>(([lonTotal, latTotal], [lon, lat]) => [lonTotal + lon, latTotal + lat], [0, 0]);
  return [roundCoord(lonSum / points.length), roundCoord(latSum / points.length)];
}

function roundCoord(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function safetyFeatureDetailUrl(featureId: string, query?: SafetyFeatureCollection["query"]): string {
  return appendQuery(`/safety-data/api/v1/features/${encodeURIComponent(featureId)}`, query);
}

function safetyFeatureGeometryUrl(featureId: string, query?: SafetyFeatureCollection["query"]): string {
  return appendQuery(`/safety-data/api/v1/features/${encodeURIComponent(featureId)}/geometry`, query);
}

function appendQuery(path: string, query?: SafetyFeatureCollection["query"]): string {
  if (!query) {
    return path;
  }
  const params = new URLSearchParams();
  params.set("bbox", `${query.bbox.west},${query.bbox.south},${query.bbox.east},${query.bbox.north}`);
  params.set("layers", query.layers.join(","));
  params.set("source", query.sources.join(","));
  params.set("limit", String(query.limit));
  return `${path}?${params.toString()}`;
}

function safetyProviderLayerId(layer: SafetyLayerId): string {
  switch (layer) {
    case "flood":
      return "safety.flood";
    case "fire":
      return "safety.fire";
    case "boundary_admin":
      return "boundary.admin";
    case "weather_alerts":
    case "warnings":
      return "safety.weather_alerts";
  }
}

function safetyCatalogLayerId(layer: SafetyLayerId): string {
  switch (layer) {
    case "flood":
      return "public.safety.flood";
    case "fire":
      return "public.safety.fire";
    case "boundary_admin":
      return "public.boundary.admin";
    case "weather_alerts":
    case "warnings":
      return "public.safety.weather_alerts";
  }
}
