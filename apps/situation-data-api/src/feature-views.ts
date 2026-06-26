import { LAYERS } from "./layers.js";
import type {
  BoundingBox,
  SituationDataSourceId,
  SituationFeature,
  SituationFeatureCollection,
  SituationFeatureProperties,
  SituationGeometry,
  SituationLayerId
} from "./types.js";

export type SituationGeometryRole = NonNullable<SituationFeatureProperties["rendering"]>["geometryRole"];

export interface FeatureGeometrySummary {
  type: SituationGeometry["type"];
  bbox?: BoundingBox;
  centroid?: [number, number];
  coordinateCount: number;
  geometryRole: SituationGeometryRole;
  renderingMode?: NonNullable<SituationFeatureProperties["rendering"]>["mode"];
}

export interface SituationFeatureSummary {
  featureId: string;
  layer: SituationLayerId;
  layerId: string;
  providerId: "sim.situation-data";
  providerLayerId: string;
  sourceId: SituationDataSourceId;
  sourceName?: string;
  label: string;
  summary?: string;
  category: string;
  hazardType?: string;
  typeCode?: string;
  sourceCode?: string;
  sourceSystem?: string;
  severity: SituationFeatureProperties["severity"];
  stale: boolean;
  confidence: number;
  observedAt: string;
  validFrom?: string;
  validUntil?: string;
  updatedAt?: string;
  areaName?: string;
  styleHint?: string;
  iconHint?: string;
  metrics?: Record<string, number | string | boolean>;
  rendering?: SituationFeatureProperties["rendering"];
  presentation?: Record<string, unknown>;
  taxonomy?: Record<string, unknown>;
  geometrySummary: FeatureGeometrySummary;
  links: {
    detail: string;
    geometry: string;
  };
}

export interface SituationFeatureSummaryCollection {
  contractVersion: "sim-provider-feature-summary-v1";
  generatedAt: string;
  providerId: "sim.situation-data";
  source: SituationFeatureCollection["source"];
  query: SituationFeatureCollection["query"];
  summary: SituationFeatureCollection["summary"] & {
    omittedGeometry: true;
  };
  features: SituationFeatureSummary[];
  sources: SituationFeatureCollection["sources"];
  warnings: string[];
}

export interface SituationFeatureDetail {
  contractVersion: "sim-provider-feature-detail-v1";
  generatedAt: string;
  providerId: "sim.situation-data";
  source: SituationFeatureCollection["source"];
  query: SituationFeatureCollection["query"];
  summary: SituationFeatureSummary;
  properties: Omit<SituationFeatureProperties, "raw">;
  localized?: Record<string, Record<string, unknown>>;
  providerProperties?: Record<string, unknown>;
  links: {
    geometry: string;
  };
  warnings: string[];
}

export interface SituationFeatureGeometryDocument {
  contractVersion: "sim-provider-feature-geometry-v1";
  generatedAt: string;
  providerId: "sim.situation-data";
  featureId: string;
  layer: SituationLayerId;
  layerId: string;
  providerLayerId: string;
  resolution: "native";
  geometry: SituationGeometry;
  geometrySummary: FeatureGeometrySummary;
}

export interface SituationTaxonomyDocument {
  contractVersion: "sim-provider-taxonomy-v1";
  generatedAt: string;
  providerId: "sim.situation-data";
  taxonomies: Array<{
    taxonomyId: string;
    label: string;
    entries: unknown[];
  }>;
}

export function buildSituationFeatureSummaryCollection(collection: SituationFeatureCollection): SituationFeatureSummaryCollection {
  return {
    contractVersion: "sim-provider-feature-summary-v1",
    generatedAt: new Date().toISOString(),
    providerId: "sim.situation-data",
    source: collection.source,
    query: collection.query,
    summary: {
      ...collection.summary,
      omittedGeometry: true
    },
    features: collection.features.map((feature) => summarizeSituationFeature(feature, collection.query)),
    sources: collection.sources,
    warnings: collection.warnings
  };
}

export function buildSituationFeatureDetail(collection: SituationFeatureCollection, feature: SituationFeature): SituationFeatureDetail {
  const { raw: _raw, ...properties } = feature.properties;
  return {
    contractVersion: "sim-provider-feature-detail-v1",
    generatedAt: new Date().toISOString(),
    providerId: "sim.situation-data",
    source: collection.source,
    query: collection.query,
    summary: summarizeSituationFeature(feature, collection.query),
    properties,
    localized: feature.properties.localized,
    providerProperties: feature.properties.providerProperties,
    links: {
      geometry: situationFeatureGeometryUrl(feature.id, collection.query)
    },
    warnings: collection.warnings
  };
}

export function buildSituationFeatureGeometry(feature: SituationFeature): SituationFeatureGeometryDocument {
  return {
    contractVersion: "sim-provider-feature-geometry-v1",
    generatedAt: new Date().toISOString(),
    providerId: "sim.situation-data",
    featureId: feature.id,
    layer: feature.properties.layer,
    layerId: feature.properties.layerId ?? feature.properties.layer,
    providerLayerId: feature.properties.providerLayerId ?? `${feature.properties.sourceId}.${feature.properties.layer}`,
    resolution: "native",
    geometry: feature.geometry,
    geometrySummary: summarizeGeometry(feature)
  };
}

export function buildSituationTaxonomy(): SituationTaxonomyDocument {
  return {
    contractVersion: "sim-provider-taxonomy-v1",
    generatedAt: new Date().toISOString(),
    providerId: "sim.situation-data",
    taxonomies: [
      {
        taxonomyId: "sim.situation.layers",
        label: "SIM situation provider layers",
        entries: LAYERS.map((layer) => ({
          layerId: layer.layerId,
          label: layer.label,
          description: layer.description,
          defaultVisible: layer.defaultVisible,
          geometryTypes: layer.geometryTypes,
          expectedCadenceSeconds: layer.expectedCadenceSeconds
        }))
      },
      {
        taxonomyId: "sim.situation.geometry_roles",
        label: "SIM situation geometry rendering roles",
        entries: [
          { geometryRole: "feature_geometry", label: "Render as regular map feature" },
          { geometryRole: "grid_cell", label: "Render as grid field cell" },
          { geometryRole: "raster_extent", label: "Raster extent metadata; do not fill as vector polygon" },
          { geometryRole: "wind_vector", label: "Render as vector field glyph or streamline" }
        ]
      },
      {
        taxonomyId: "sim.situation.severity",
        label: "SIM normalized situation severity",
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

export function findSituationFeature(collection: SituationFeatureCollection, featureId: string): SituationFeature | undefined {
  return collection.features.find((feature) => feature.id === featureId || feature.properties.featureId === featureId);
}

function summarizeSituationFeature(feature: SituationFeature, query?: SituationFeatureCollection["query"]): SituationFeatureSummary {
  const providerProperties = recordValue(feature.properties.providerProperties);
  return {
    featureId: feature.id,
    layer: feature.properties.layer,
    layerId: feature.properties.layerId ?? feature.properties.layer,
    providerId: "sim.situation-data",
    providerLayerId: feature.properties.providerLayerId ?? `${feature.properties.sourceId}.${feature.properties.layer}`,
    sourceId: feature.properties.sourceId,
    sourceName: feature.properties.sourceName,
    label: feature.properties.label,
    summary: feature.properties.summary,
    category: feature.properties.category,
    hazardType: feature.properties.hazardType,
    typeCode: feature.properties.typeCode,
    sourceCode: feature.properties.sourceCode,
    sourceSystem: feature.properties.sourceSystem,
    severity: feature.properties.severity,
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
    rendering: feature.properties.rendering,
    presentation: recordValue(providerProperties?.presentation),
    taxonomy: recordValue(providerProperties?.taxonomy),
    geometrySummary: summarizeGeometry(feature),
    links: {
      detail: situationFeatureDetailUrl(feature.id, query),
      geometry: situationFeatureGeometryUrl(feature.id, query)
    }
  };
}

function summarizeGeometry(feature: SituationFeature): FeatureGeometrySummary {
  const points = geometryPoints(feature.geometry);
  return {
    type: feature.geometry.type,
    bbox: bboxForPoints(points),
    centroid: centroidForPoints(points),
    coordinateCount: points.length,
    geometryRole: feature.properties.rendering?.geometryRole ?? "feature_geometry",
    renderingMode: feature.properties.rendering?.mode
  };
}

function geometryPoints(geometry: SituationGeometry): Array<[number, number]> {
  if (geometry.type === "Point") {
    return [geometry.coordinates];
  }
  if (geometry.type === "LineString") {
    return geometry.coordinates;
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

function situationFeatureDetailUrl(featureId: string, query?: SituationFeatureCollection["query"]): string {
  return appendQuery(`/situation-data/api/v1/features/${encodeURIComponent(featureId)}`, query);
}

function situationFeatureGeometryUrl(featureId: string, query?: SituationFeatureCollection["query"]): string {
  return appendQuery(`/situation-data/api/v1/features/${encodeURIComponent(featureId)}/geometry`, query);
}

function appendQuery(path: string, query?: SituationFeatureCollection["query"]): string {
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
