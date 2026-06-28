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

export interface SituationFeatureDensityOptions {
  cellSizeDegrees?: number;
  maxCells?: number;
  sampleSize?: number;
}

export interface SituationFeatureDensityCollection {
  contractVersion: "sim-provider-feature-density-v1";
  type: "FeatureCollection";
  generatedAt: string;
  providerId: "sim.situation-data";
  source: SituationFeatureCollection["source"];
  query: SituationFeatureCollection["query"];
  density: {
    cellSizeDegrees: number;
    cellCount: number;
    maxCells: number;
    sampleSize: number;
    inputFeatureCount: number;
    omittedFeatureCount: number;
    truncated: boolean;
    omittedOriginalGeometry: true;
  };
  summary: SituationFeatureCollection["summary"] & {
    cellCount: number;
    inputFeatureCount: number;
    omittedGeometry: true;
  };
  features: SituationFeatureDensityCell[];
  sources: SituationFeatureCollection["sources"];
  warnings: string[];
}

export interface SituationFeatureDensityCell {
  type: "Feature";
  id: string;
  geometry: {
    type: "Polygon";
    coordinates: Array<Array<[number, number]>>;
  };
  properties: {
    featureId: string;
    providerId: "sim.situation-data";
    layerId: string;
    providerLayerId: string;
    layer: SituationLayerId;
    category: "density_cell";
    label: string;
    featureCount: number;
    staleFeatureCount: number;
    topSeverity: SituationFeatureProperties["severity"];
    layerCounts: Partial<Record<SituationLayerId, number>>;
    sourceCounts: Partial<Record<SituationDataSourceId, number>>;
    severityCounts: Partial<Record<SituationFeatureProperties["severity"], number>>;
    sampleFeatureIds: string[];
    bbox: BoundingBox;
    centroid: [number, number];
    rendering: {
      mode: "grid";
      geometryRole: "grid_cell";
    };
  };
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

export function buildSituationFeatureDensityCollection(
  collection: SituationFeatureCollection,
  options: SituationFeatureDensityOptions = {}
): SituationFeatureDensityCollection {
  const cellSizeDegrees = normalizeCellSizeDegrees(options.cellSizeDegrees ?? autoCellSizeDegrees(collection.query.bbox));
  const maxCells = Math.max(1, Math.min(5000, Math.trunc(options.maxCells ?? 512)));
  const sampleSize = Math.max(0, Math.min(20, Math.trunc(options.sampleSize ?? 5)));
  const cells = new Map<string, DensityAccumulator>();

  for (const feature of collection.features) {
    const point = densityPoint(feature);
    if (!point) {
      continue;
    }
    const cellIndex = densityCellIndex(point, cellSizeDegrees);
    const cellKey = `${cellIndex.x}:${cellIndex.y}`;
    const existing = cells.get(cellKey) ?? createDensityAccumulator(cellIndex, cellSizeDegrees);
    addFeatureToDensityAccumulator(existing, feature, sampleSize);
    cells.set(cellKey, existing);
  }

  const allCells = Array.from(cells.values()).sort(compareDensityAccumulators);
  const selectedCells = allCells.slice(0, maxCells).map((cell) => densityAccumulatorFeature(cell));
  const generatedAt = new Date().toISOString();

  return {
    contractVersion: "sim-provider-feature-density-v1",
    type: "FeatureCollection",
    generatedAt,
    providerId: "sim.situation-data",
    source: collection.source,
    query: collection.query,
    density: {
      cellSizeDegrees,
      cellCount: selectedCells.length,
      maxCells,
      sampleSize,
      inputFeatureCount: collection.features.length,
      omittedFeatureCount: Math.max(0, allCells.length - selectedCells.length),
      truncated: allCells.length > selectedCells.length,
      omittedOriginalGeometry: true
    },
    summary: {
      ...collection.summary,
      cellCount: selectedCells.length,
      inputFeatureCount: collection.features.length,
      omittedGeometry: true
    },
    features: selectedCells,
    sources: collection.sources,
    warnings: collection.warnings
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

interface DensityAccumulator {
  id: string;
  bbox: BoundingBox;
  centroid: [number, number];
  featureCount: number;
  staleFeatureCount: number;
  topSeverity: SituationFeatureProperties["severity"];
  layerCounts: Map<SituationLayerId, number>;
  sourceCounts: Map<SituationDataSourceId, number>;
  severityCounts: Map<SituationFeatureProperties["severity"], number>;
  sampleFeatureIds: string[];
}

function createDensityAccumulator(index: { x: number; y: number }, cellSizeDegrees: number): DensityAccumulator {
  const west = roundCoord(index.x * cellSizeDegrees);
  const south = roundCoord(index.y * cellSizeDegrees);
  const east = roundCoord((index.x + 1) * cellSizeDegrees);
  const north = roundCoord((index.y + 1) * cellSizeDegrees);
  return {
    id: `density:${cellSizeDegrees}:${index.x}:${index.y}`,
    bbox: { west, south, east, north },
    centroid: [roundCoord((west + east) / 2), roundCoord((south + north) / 2)],
    featureCount: 0,
    staleFeatureCount: 0,
    topSeverity: "info",
    layerCounts: new Map(),
    sourceCounts: new Map(),
    severityCounts: new Map(),
    sampleFeatureIds: []
  };
}

function addFeatureToDensityAccumulator(cell: DensityAccumulator, feature: SituationFeature, sampleSize: number): void {
  cell.featureCount += 1;
  if (feature.properties.stale) {
    cell.staleFeatureCount += 1;
  }
  cell.topSeverity = higherSeverity(cell.topSeverity, feature.properties.severity);
  increment(cell.layerCounts, feature.properties.layer);
  increment(cell.sourceCounts, feature.properties.sourceId);
  increment(cell.severityCounts, feature.properties.severity);
  if (cell.sampleFeatureIds.length < sampleSize) {
    cell.sampleFeatureIds.push(feature.id);
  }
}

function densityAccumulatorFeature(cell: DensityAccumulator): SituationFeatureDensityCell {
  const primaryLayer = mostCommon(cell.layerCounts) ?? "weather";
  return {
    type: "Feature",
    id: cell.id,
    geometry: densityCellPolygon(cell.bbox),
    properties: {
      featureId: cell.id,
      providerId: "sim.situation-data",
      layerId: `density.${primaryLayer}`,
      providerLayerId: `density.${primaryLayer}`,
      layer: primaryLayer,
      category: "density_cell",
      label: `${cell.featureCount} prvku`,
      featureCount: cell.featureCount,
      staleFeatureCount: cell.staleFeatureCount,
      topSeverity: cell.topSeverity,
      layerCounts: objectFromCounts(cell.layerCounts),
      sourceCounts: objectFromCounts(cell.sourceCounts),
      severityCounts: objectFromCounts(cell.severityCounts),
      sampleFeatureIds: cell.sampleFeatureIds,
      bbox: cell.bbox,
      centroid: cell.centroid,
      rendering: {
        mode: "grid",
        geometryRole: "grid_cell"
      }
    }
  };
}

function densityCellPolygon(bbox: BoundingBox): SituationFeatureDensityCell["geometry"] {
  return {
    type: "Polygon",
    coordinates: [
      [
        [bbox.west, bbox.south],
        [bbox.east, bbox.south],
        [bbox.east, bbox.north],
        [bbox.west, bbox.north],
        [bbox.west, bbox.south]
      ]
    ]
  };
}

function densityPoint(feature: SituationFeature): [number, number] | undefined {
  const summary = summarizeGeometry(feature);
  if (summary.centroid) {
    return summary.centroid;
  }
  const bbox = summary.bbox;
  return bbox ? [roundCoord((bbox.west + bbox.east) / 2), roundCoord((bbox.south + bbox.north) / 2)] : undefined;
}

function densityCellIndex(point: [number, number], cellSizeDegrees: number): { x: number; y: number } {
  return {
    x: Math.floor(point[0] / cellSizeDegrees),
    y: Math.floor(point[1] / cellSizeDegrees)
  };
}

function compareDensityAccumulators(left: DensityAccumulator, right: DensityAccumulator): number {
  const severityDelta = severityRank(right.topSeverity) - severityRank(left.topSeverity);
  if (severityDelta !== 0) {
    return severityDelta;
  }
  const countDelta = right.featureCount - left.featureCount;
  if (countDelta !== 0) {
    return countDelta;
  }
  return left.id.localeCompare(right.id);
}

function autoCellSizeDegrees(bbox: BoundingBox): number {
  const span = Math.max(bbox.east - bbox.west, bbox.north - bbox.south);
  if (span <= 0.2) {
    return 0.01;
  }
  if (span <= 0.8) {
    return 0.025;
  }
  if (span <= 2) {
    return 0.05;
  }
  if (span <= 6) {
    return 0.1;
  }
  return 0.25;
}

function normalizeCellSizeDegrees(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0.1;
  }
  return roundCoord(Math.min(2, Math.max(0.001, value)));
}

function higherSeverity(left: SituationFeatureProperties["severity"], right: SituationFeatureProperties["severity"]): SituationFeatureProperties["severity"] {
  return severityRank(right) > severityRank(left) ? right : left;
}

function severityRank(severity: SituationFeatureProperties["severity"]): number {
  switch (severity) {
    case "critical":
      return 3;
    case "warning":
      return 2;
    case "advisory":
      return 1;
    case "info":
      return 0;
  }
}

function increment<T extends string>(counts: Map<T, number>, key: T): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function mostCommon<T extends string>(counts: Map<T, number>): T | undefined {
  return Array.from(counts.entries()).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

function objectFromCounts<T extends string>(counts: Map<T, number>): Partial<Record<T, number>> {
  return Object.fromEntries(counts.entries()) as Partial<Record<T, number>>;
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
