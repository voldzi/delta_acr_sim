import type { SafetyDataConfig } from "./config.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type { SafetyDataSource } from "./sources.js";
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

export class SafetyAggregationService {
  private readonly cache: ManagedResponseCache<SafetyFeatureCollection>;

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

  async getFeatures(query: SafetyQuery): Promise<SafetyFeatureCollection> {
    return this.cache.getOrLoad(cacheKeyForSafetyQuery(query), () => this.fetchFeatures(query));
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
    ).filter((feature) => query.layers.includes(feature.properties.layer));
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
      features.filter((feature) => feature.properties.layer === layer)
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
    case "warnings":
      return 1;
    case "flood":
    default:
      return 2;
  }
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}
