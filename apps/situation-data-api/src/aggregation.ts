import type { SituationDataConfig } from "./config.js";
import { canonicalizeBboxForCache } from "./bbox-cache.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type { SituationDataSource, SourceCacheStats } from "./sources.js";
import type {
  SituationDataSourceId,
  SituationFeature,
  SituationFeatureCollection,
  SituationLayerId,
  SituationQuery,
  SourceDescriptor,
  SourceFetchResult
} from "./types.js";

export class SituationAggregationService {
  private readonly cache: ManagedResponseCache<SituationFeatureCollection>;

  constructor(
    private readonly config: SituationDataConfig,
    private readonly sources: SituationDataSource[]
  ) {
    this.cache = new ManagedResponseCache<SituationFeatureCollection>({
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

  async getFeatures(query: SituationQuery): Promise<SituationFeatureCollection> {
    return this.cache.getOrLoad(cacheKeyForSituationQuery(query, this.config), () => this.fetchFeatures(query));
  }

  private async fetchFeatures(query: SituationQuery): Promise<SituationFeatureCollection> {
    const enabledSources = this.sources.filter((source) => query.sourceIds.includes(source.descriptor.sourceId));
    const settled = await Promise.allSettled(enabledSources.map((source) => source.fetchFeatures(query)));
    const results: SourceFetchResult[] = [];
    const warnings: string[] = [];

    for (const item of settled) {
      if (item.status === "fulfilled") {
        results.push(item.value);
        warnings.push(...item.value.warnings);
      } else {
        warnings.push(item.reason instanceof Error ? item.reason.message : "Unknown situation data source fetch failure.");
      }
    }

    const sourceDescriptors = enabledSources.map((source) => source.descriptor);
    const sourcePriorityById = new Map<SituationDataSourceId, number>(sourceDescriptors.map((source) => [source.sourceId, source.priority]));
    const deduplicatedFeatures = deduplicateFeatures(
      results.flatMap((result) => result.features),
      sourcePriorityById,
      this.config.staleAfterSeconds
    ).filter((feature) => query.layers.includes(feature.properties.layer));
    const features = limitBalancedByLayer(deduplicatedFeatures, query.layers, query.limit);

    const generatedAt = new Date().toISOString();
    const response: SituationFeatureCollection = {
      contractVersion: "cop-situation-source-v1",
      type: "FeatureCollection",
      generatedAt,
      source: {
        sourceId: "situation-data-api",
        sourceType: "PUBLIC_SITUATION_AGGREGATE",
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
        warningCount: warnings.length
      },
      features,
      sources: sourceDescriptors,
      warnings
    };
    return response;
  }
}

function cacheKeyForSituationQuery(query: SituationQuery, config: SituationDataConfig): string {
  return JSON.stringify({
    bbox: canonicalizeBboxForCache(query.bbox, config.bboxCachePaddingDegrees),
    layers: [...query.layers].sort(),
    sources: [...query.sourceIds].sort(),
    limit: query.limit,
    includeRaw: query.includeRaw
  });
}

function limitBalancedByLayer(features: SituationFeature[], layers: SituationLayerId[], limit: number): SituationFeature[] {
  if (features.length <= limit) {
    return features;
  }

  const buckets = new Map<SituationLayerId, SituationFeature[]>();
  for (const layer of layers) {
    buckets.set(
      layer,
      features.filter((feature) => feature.properties.layer === layer)
    );
  }

  const selected: SituationFeature[] = [];
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
  features: SituationFeature[],
  sourcePriorityById: Map<SituationDataSourceId, number>,
  staleAfterSeconds: number
): SituationFeature[] {
  const grouped = new Map<string, SituationFeature>();

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
  a: SituationFeature,
  b: SituationFeature,
  sourcePriorityById: Map<SituationDataSourceId, number>
): number {
  const priorityDelta = (sourcePriorityById.get(b.properties.sourceId) ?? 0) - (sourcePriorityById.get(a.properties.sourceId) ?? 0);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return Date.parse(b.properties.observedAt) - Date.parse(a.properties.observedAt);
}

function markStale(feature: SituationFeature, staleAfterSeconds: number): SituationFeature {
  const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(feature.properties.observedAt)) / 1000));
  const validUntilMs = feature.properties.validUntil ? Date.parse(feature.properties.validUntil) : undefined;
  const stale = typeof validUntilMs === "number" && !Number.isNaN(validUntilMs) ? Date.now() > validUntilMs : ageSeconds > staleAfterSeconds;
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

function layerRank(value: SituationLayerId): number {
  switch (value) {
    case "weather":
      return 1;
    case "traffic":
      return 2;
    case "mobile":
      return 3;
    case "ground":
    default:
      return 4;
  }
}
