import type { SafetyDataConfig } from "./config.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type { SafetyDataSource, SourceCacheStats } from "./sources.js";
import type {
  BoundingBox,
  SafetyDataSourceId,
  SafetyFeature,
  SafetyFeatureCollection,
  SafetyLayerId,
  SafetyQuery,
  SourceDescriptor,
  SourceFetchResult
} from "./types.js";

export interface SafetyAggregationTelemetry {
  generatedAt?: string;
  generatedAgeSeconds: number;
  featureCount: number;
  sourceCount: number;
  staleFeatureCount: number;
  advisoryCount: number;
  warningCount: number;
  criticalCount: number;
  responseWarningCount: number;
  layerCounts: Partial<Record<SafetyLayerId, number>>;
  sourceIds: SafetyDataSourceId[];
  layers: SafetyLayerId[];
}

export class SafetyAggregationService {
  private readonly cache: ManagedResponseCache<SafetyFeatureCollection>;
  private lastCollection?: SafetyFeatureCollection;

  constructor(
    private readonly config: SafetyDataConfig,
    private readonly sources: SafetyDataSource[]
  ) {
    this.cache = new ManagedResponseCache<SafetyFeatureCollection>({
      ttlMs: config.cacheTtlSeconds * 1000,
      staleIfErrorMs: config.staleIfErrorSeconds * 1000,
      maxEntries: config.cacheMaxEntries
    });
  }

  cacheStats(): ManagedResponseCacheStats {
    return this.cache.stats();
  }

  sourceCacheStats(): SourceCacheStats[] {
    return this.sources.flatMap((source) => source.cacheStats?.() ?? []);
  }

  telemetrySnapshot(now = new Date()): SafetyAggregationTelemetry {
    const collection = this.lastCollection;
    if (!collection) {
      return {
        generatedAgeSeconds: -1,
        featureCount: 0,
        sourceCount: 0,
        staleFeatureCount: 0,
        advisoryCount: 0,
        warningCount: 0,
        criticalCount: 0,
        responseWarningCount: 0,
        layerCounts: {},
        sourceIds: [],
        layers: []
      };
    }
    const generatedTime = new Date(collection.generatedAt).getTime();
    return {
      generatedAt: collection.generatedAt,
      generatedAgeSeconds: Number.isFinite(generatedTime) ? Math.max(0, Math.round((now.getTime() - generatedTime) / 1000)) : -1,
      featureCount: collection.summary.featureCount,
      sourceCount: collection.summary.sourceCount,
      staleFeatureCount: collection.summary.staleFeatureCount,
      advisoryCount: collection.summary.advisoryCount,
      warningCount: collection.summary.warningCount,
      criticalCount: collection.summary.criticalCount,
      responseWarningCount: collection.warnings.length,
      layerCounts: countLayers(collection.features),
      sourceIds: collection.query.sources,
      layers: collection.query.layers
    };
  }

  async getFeatures(query: SafetyQuery): Promise<SafetyFeatureCollection> {
    const collection = await this.cache.getOrLoad(cacheKeyForSafetyQuery(query), () => this.fetchFeatures(query));
    this.lastCollection = collection;
    return collection;
  }

  private async fetchFeatures(query: SafetyQuery): Promise<SafetyFeatureCollection> {
    const enabledSources = this.sources.filter((source) => query.sourceIds.includes(source.descriptor.sourceId));
    const settled = await Promise.allSettled(enabledSources.map((source) => source.fetchFeatures(query)));
    const results: SourceFetchResult[] = [];
    const warnings: string[] = [];

    for (const item of settled) {
      if (item.status === "fulfilled") {
        results.push(item.value);
        warnings.push(...item.value.warnings);
      } else {
        warnings.push(item.reason instanceof Error ? item.reason.message : "Unknown safety data source fetch failure.");
      }
    }

    const sourceDescriptors = enabledSources.map((source) => source.descriptor);
    const sourcePriorityById = new Map<SafetyDataSourceId, number>(sourceDescriptors.map((source) => [source.sourceId, source.priority]));
    const deduplicatedFeatures = deduplicateFeatures(
      results.flatMap((result) => result.features),
      sourcePriorityById,
      this.config.staleAfterSeconds
    )
      .filter((feature) => layerRequested(query.layers, feature.properties.layer))
      .map(normalizeProviderFeature);
    const features = limitBalancedByLayer(deduplicatedFeatures, query.layers, query.limit);

    const generatedAt = new Date().toISOString();
    return {
      contractVersion: "cop-safety-source-v1",
      type: "FeatureCollection",
      generatedAt,
      source: {
        sourceId: "safety-data-api",
        sourceType: "PUBLIC_SAFETY_AGGREGATE",
        generatedAt
      },
      query: {
        bbox: query.bbox,
        layers: query.layers,
        limit: query.limit,
        sources: query.sourceIds
      },
      summary: {
        featureCount: features.length,
        sourceCount: sourceDescriptors.length,
        staleFeatureCount: features.filter((feature) => feature.properties.stale).length,
        advisoryCount: features.filter((feature) => feature.properties.severity === "advisory").length,
        warningCount: features.filter((feature) => feature.properties.severity === "warning").length,
        criticalCount: features.filter((feature) => feature.properties.severity === "critical").length
      },
      features,
      sources: sourceDescriptors,
      warnings
    };
  }
}

function countLayers(features: SafetyFeature[]): Partial<Record<SafetyLayerId, number>> {
  const counts: Partial<Record<SafetyLayerId, number>> = {};
  for (const feature of features) {
    counts[feature.properties.layer] = (counts[feature.properties.layer] ?? 0) + 1;
  }
  return counts;
}

function normalizeProviderFeature(feature: SafetyFeature): SafetyFeature {
  const providerLayerId = providerLayerIdForFeature(feature.properties.layer);
  return {
    ...feature,
    properties: {
      ...feature.properties,
      layerId: catalogLayerIdForFeature(feature.properties.layer),
      providerId: "sim.safety-data",
      providerLayerId,
      providerProperties: compactRecord({
        headline: feature.properties.headline,
        description: feature.properties.description,
        recommendedAction: feature.properties.recommendedAction,
        urgency: feature.properties.urgency,
        certainty: feature.properties.certainty,
        affectedAreas: feature.properties.affectedAreas,
        geocodes: feature.properties.geocodes,
        metrics: feature.properties.metrics,
        tags: feature.properties.tags,
        hazardType: feature.properties.hazardType,
        status: feature.properties.status,
        sourceName: feature.properties.sourceName,
        areaName: feature.properties.areaName,
        adminLevel: feature.properties.adminLevel,
        styleHint: feature.properties.styleHint,
        iconHint: feature.properties.iconHint,
        basis: feature.properties.basis,
        fireStatus: feature.properties.fireStatus,
        detectedAt: feature.properties.detectedAt,
        sourceSatellite: feature.properties.sourceSatellite,
        sourceIncident: feature.properties.sourceIncident,
        intensity: feature.properties.intensity,
        frp: feature.properties.frp,
        riverName: feature.properties.riverName,
        stationId: feature.properties.stationId,
        waterLevelCm: feature.properties.waterLevelCm,
        discharge: feature.properties.discharge,
        floodStage: feature.properties.floodStage,
        trend: feature.properties.trend,
        basin: feature.properties.basin,
        affectedArea: feature.properties.affectedArea,
        name: feature.properties.name,
        code: feature.properties.code,
        countryCode: feature.properties.countryCode
      })
    }
  };
}

function providerLayerIdForFeature(layer: SafetyLayerId): string {
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

function catalogLayerIdForFeature(layer: SafetyLayerId): string {
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

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function cacheKeyForSafetyQuery(query: SafetyQuery): string {
  return JSON.stringify({
    bbox: roundBbox(query.bbox),
    layers: [...query.layers].sort(),
    sources: [...query.sourceIds].sort(),
    limit: query.limit,
    includeRaw: query.includeRaw
  });
}

function roundBbox(bbox: BoundingBox): BoundingBox {
  return {
    west: round(bbox.west, 5),
    south: round(bbox.south, 5),
    east: round(bbox.east, 5),
    north: round(bbox.north, 5)
  };
}

function limitBalancedByLayer(features: SafetyFeature[], layers: SafetyLayerId[], limit: number): SafetyFeature[] {
  if (features.length <= limit) {
    return features;
  }

  const buckets = new Map<SafetyLayerId, SafetyFeature[]>();
  for (const layer of layers) {
    buckets.set(
      layer,
      features.filter((feature) => layerRequested([layer], feature.properties.layer))
    );
  }

  const selected: SafetyFeature[] = [];
  while (selected.length < limit) {
    let added = false;
    for (const layer of layers) {
      const next = buckets.get(layer)?.shift();
      if (!next) {
        continue;
      }
      selected.push(next);
      added = true;
      if (selected.length >= limit) {
        break;
      }
    }
    if (!added) {
      break;
    }
  }

  return selected;
}

function deduplicateFeatures(
  features: SafetyFeature[],
  sourcePriorityById: Map<SafetyDataSourceId, number>,
  staleAfterSeconds: number
): SafetyFeature[] {
  const grouped = new Map<string, SafetyFeature>();

  for (const feature of features) {
    const existing = grouped.get(feature.id);
    if (!existing || compareFeaturePriority(feature, existing, sourcePriorityById) < 0) {
      grouped.set(feature.id, markStale(feature, staleAfterSeconds));
    }
  }

  return Array.from(grouped.values()).sort((a, b) => {
    const severityDelta = severityRank(b.properties.severity) - severityRank(a.properties.severity);
    if (severityDelta !== 0) {
      return severityDelta;
    }
    const layerDelta = layerRank(a.properties.layer) - layerRank(b.properties.layer);
    if (layerDelta !== 0) {
      return layerDelta;
    }
    return Date.parse(b.properties.observedAt) - Date.parse(a.properties.observedAt);
  });
}

function compareFeaturePriority(
  a: SafetyFeature,
  b: SafetyFeature,
  sourcePriorityById: Map<SafetyDataSourceId, number>
): number {
  const priorityDelta = (sourcePriorityById.get(b.properties.sourceId) ?? 0) - (sourcePriorityById.get(a.properties.sourceId) ?? 0);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return Date.parse(b.properties.observedAt) - Date.parse(a.properties.observedAt);
}

function markStale(feature: SafetyFeature, staleAfterSeconds: number): SafetyFeature {
  const observedMs = Date.parse(feature.properties.observedAt);
  const ageSeconds = Number.isNaN(observedMs) ? 0 : Math.max(0, Math.round((Date.now() - observedMs) / 1000));
  const expiresAtMs = feature.properties.expiresAt ? Date.parse(feature.properties.expiresAt) : undefined;
  const stale = typeof expiresAtMs === "number" && !Number.isNaN(expiresAtMs) ? Date.now() > expiresAtMs : ageSeconds > staleAfterSeconds;
  return {
    ...feature,
    properties: {
      ...feature.properties,
      stale,
      metrics: {
        ...(feature.properties.metrics ?? {}),
        ageSeconds
      }
    }
  };
}

function severityRank(value: string): number {
  switch (value) {
    case "critical":
      return 4;
    case "warning":
      return 3;
    case "advisory":
      return 2;
    default:
      return 1;
  }
}

function layerRank(value: SafetyLayerId): number {
  switch (value) {
    case "weather_alerts":
    case "warnings":
      return 1;
    case "fire":
      return 2;
    case "flood":
      return 3;
    case "boundary_admin":
    default:
      return 4;
  }
}

function layerRequested(layers: SafetyLayerId[], featureLayer: SafetyLayerId): boolean {
  if (featureLayer === "weather_alerts" || featureLayer === "warnings") {
    return layers.includes("weather_alerts") || layers.includes("warnings");
  }
  return layers.includes(featureLayer);
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
