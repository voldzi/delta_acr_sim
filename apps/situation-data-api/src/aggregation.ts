import type { SituationDataConfig } from "./config.js";
import { canonicalizeBboxForCache } from "./bbox-cache.js";
import { ManagedResponseCache, type ManagedResponseCacheStats } from "./response-cache.js";
import type { SharedResponseCacheStore } from "./response-cache.js";
import type { SituationDataSource, SourceCacheStats } from "./sources.js";
import type {
  SituationDataSourceId,
  SituationFeature,
  SituationFeatureCollection,
  SituationLayerId,
  SituationQuery,
  SourceHealthStatus,
  SourceDescriptor,
  SourceFetchResult
} from "./types.js";

export class SituationAggregationService {
  private readonly cache: ManagedResponseCache<SituationFeatureCollection>;

  constructor(
    private readonly config: SituationDataConfig,
    private readonly sources: SituationDataSource[],
    sharedCache?: SharedResponseCacheStore
  ) {
    this.cache = new ManagedResponseCache<SituationFeatureCollection>({
      ttlMs: config.cacheTtlSeconds * 1000,
      staleIfErrorMs: config.staleIfErrorSeconds * 1000,
      maxEntries: config.cacheMaxEntries,
      sharedStore: sharedCache,
      sharedKeyPrefix: `${config.sharedCacheKeyPrefix}:features:v1`
    });
  }

  cacheStats(): ManagedResponseCacheStats {
    return this.cache.stats();
  }

  sourceCacheStats(): SourceCacheStats[] {
    return this.sources.flatMap((source) => source.cacheStats?.() ?? []);
  }

  async sourceHealthStatuses(): Promise<SourceHealthStatus[]> {
    const checks = this.sources.filter((source) => source.healthStatus).map((source) => source.healthStatus?.());
    const settled = await Promise.allSettled(checks);
    return settled.flatMap((item) => (item.status === "fulfilled" && item.value ? [item.value] : []));
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
    )
      .filter((feature) => query.layers.includes(feature.properties.layer))
      .map(normalizeProviderFeature);
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

function normalizeProviderFeature(feature: SituationFeature): SituationFeature {
  const providerLayerId = providerLayerIdForFeature(feature);
  const layerId = catalogLayerIdForFeature(feature, providerLayerId);
  return {
    ...feature,
    properties: {
      ...feature.properties,
      layerId,
      providerId: "sim.situation-data",
      providerLayerId,
      providerProperties: providerPropertiesForFeature(feature)
    }
  };
}

function providerLayerIdForFeature(feature: SituationFeature): string {
  const { layer, sourceId, category } = feature.properties;
  if (sourceId === "open_meteo") {
    return "weather.open_meteo";
  }
  if (sourceId === "aviation_weather") {
    return "weather.aviation_weather";
  }
  if (sourceId === "chmi_weather_stations") {
    if (layer === "weather_temperature_grid") {
      return "weather.temperature_grid";
    }
    if (layer === "weather_wind_field") {
      return "weather.wind_field";
    }
    if (layer === "weather_precipitation_grid") {
      return "weather.precipitation_grid";
    }
    if (layer === "weather_humidity_grid") {
      return "weather.humidity_grid";
    }
    if (layer === "weather_pressure_grid") {
      return "weather.pressure_grid";
    }
    return "weather.chmi_station_observations";
  }
  if (sourceId === "chmi_air_quality") {
    if (layer === "air_quality_grid") {
      return "air_quality.grid";
    }
    return "air_quality.chmi_station_observations";
  }
  if (sourceId === "chmi_weather_webcams") {
    return "weather.chmi_webcams";
  }
  if (sourceId === "chmi_weather_radar") {
    if (layer === "weather_radar_reflectivity") {
      return "weather.radar_reflectivity";
    }
    if (layer === "weather_radar_precipitation") {
      return "weather.radar_precipitation";
    }
    if (layer === "weather_radar_nowcast") {
      return "weather.radar_nowcast";
    }
    if (layer === "weather_thunderstorm_risk") {
      return "weather.thunderstorm_risk";
    }
  }
  if (sourceId === "mobile_network_model") {
    return "mobile_network";
  }
  if (sourceId === "mobile_coverage_model") {
    return "mobile_coverage";
  }
  if (sourceId === "ctu_nettest") {
    return "mobile.ctu_nettest";
  }
  if (sourceId === "ctu_stationary_mobile") {
    return "mobile.ctu_stationary";
  }
  if (sourceId === "pid_gtfs_rt") {
    return "traffic.pid_gtfs_rt";
  }
  if (sourceId === "idsjmk_vehicle_positions") {
    return "traffic.idsjmk_vehicle_positions";
  }
  if (sourceId === "spravazeleznic_trains") {
    return "traffic.spravazeleznic_trains";
  }
  if (sourceId === "road_srti_lod") {
    return "traffic.road_events.srti";
  }
  if (sourceId === "safety_data" && layer === "warnings") {
    return "warnings.safety_data_projection";
  }
  if (sourceId === "safety_data" && layer === "fire") {
    return "fire.safety_data_projection";
  }
  if (sourceId === "safety_data" && layer === "flood") {
    return "flood.safety_data_projection";
  }
  if (sourceId === "safety_data" && layer === "boundary_admin") {
    return "boundary_admin.safety_data_projection";
  }
  if (sourceId === "osm_postgis") {
    if (layer === "boundary_country") {
      return "boundary.country";
    }
    if (layer === "boundary_region") {
      return "boundary.region";
    }
    if (layer === "boundary_district") {
      return "boundary.district";
    }
    if (layer === "boundary_orp") {
      return "boundary.orp";
    }
    if (layer === "place_settlements") {
      return "place.settlements";
    }
    if (category === "communications_tower") {
      return "mobile.osm_postgis.communications";
    }
    if (["hospital", "clinic", "doctors", "pharmacy"].includes(category)) {
      return "ground.osm_postgis.healthcare";
    }
    if (["fire_station", "police", "ambulance_station", "shelter"].includes(category)) {
      return "ground.osm_postgis.emergency";
    }
    if (category === "townhall") {
      return "ground.osm_postgis.civic";
    }
  }
  return `${sourceId}.${layer}`;
}

function catalogLayerIdForFeature(feature: SituationFeature, providerLayerId: string): string {
  const { layer, sourceId } = feature.properties;
  switch (providerLayerId) {
    case "weather.open_meteo":
      return "public.weather.current";
    case "weather.aviation_weather":
      return "public.weather.aviation";
    case "weather.chmi_station_observations":
      return "public.weather.observations";
    case "weather.chmi_webcams":
      return "public.weather.webcams";
    case "weather.temperature_grid":
      return "public.weather.temperature_grid";
    case "weather.wind_field":
      return "public.weather.wind_field";
    case "weather.precipitation_grid":
      return "public.weather.precipitation_grid";
    case "weather.humidity_grid":
      return "public.weather.humidity_grid";
    case "weather.pressure_grid":
      return "public.weather.pressure_grid";
    case "air_quality.chmi_station_observations":
      return "public.safety.air_quality";
    case "air_quality.grid":
      return "public.safety.air_quality_grid";
    case "weather.radar_reflectivity":
      return "public.weather.radar_reflectivity";
    case "weather.radar_precipitation":
      return "public.weather.radar_precipitation";
    case "weather.radar_nowcast":
      return "public.weather.radar_nowcast";
    case "weather.thunderstorm_risk":
      return "public.safety.thunderstorm_risk";
    case "mobile_network":
      return "public.mobile.network";
    case "mobile_coverage":
      return "diagnostic.mobile.coverage";
    case "mobile.ctu_nettest":
      return "diagnostic.mobile.ctu_measurements";
    case "mobile.ctu_stationary":
      return "diagnostic.mobile.ctu_stationary_measurements";
    case "mobile.osm_postgis.communications":
      return "reference.infrastructure.communications";
    case "ground.osm_postgis.healthcare":
      return "reference.infrastructure.healthcare";
    case "ground.osm_postgis.emergency":
      return "reference.infrastructure.emergency";
    case "ground.osm_postgis.civic":
      return "reference.infrastructure.civic";
    case "traffic.pid_gtfs_rt":
      return "public.traffic.transit";
    case "traffic.idsjmk_vehicle_positions":
      return "public.traffic.transit";
    case "traffic.spravazeleznic_trains":
      return "public.traffic.transit";
    case "traffic.road_events.srti":
      return "public.traffic.road_events";
    case "warnings.safety_data_projection":
      return "public.safety.warnings";
    case "fire.safety_data_projection":
      return "public.safety.fire";
    case "flood.safety_data_projection":
      return "public.safety.flood";
    case "boundary_admin.safety_data_projection":
      return "public.boundary.admin";
    case "boundary.country":
      return "public.boundary.country";
    case "boundary.region":
      return "public.boundary.region";
    case "boundary.district":
      return "public.boundary.district";
    case "boundary.orp":
      return "public.boundary.orp";
    case "place.settlements":
      return "public.place.settlements";
    default:
      return sourceId === "mock" ? `diagnostic.mock.${layer}` : `provider.${sourceId}.${layer}`;
  }
}

function providerPropertiesForFeature(feature: SituationFeature): Record<string, unknown> {
  const {
    metrics,
    tags,
    rendering,
    operator,
    technology,
    quality,
    status,
    basis,
    summary,
    notices,
    dataQuality,
    labelLocalized,
    summaryLocalized,
    source,
    sourceName,
    validFrom,
    updatedAt,
    adminLevel,
    name,
    code,
    countryCode,
    areaName,
    styleHint,
    iconHint,
    btsStatus,
    btsStatusSource,
    operatorStatusAvailable,
    estimatedSignalDbm,
    modelVersion,
    sourceRevision,
    readModel,
    generatedAt,
    resolutionM,
    demSource,
    assumptions,
    disclaimer,
    providerProperties,
    raw
  } = feature.properties;
  return compactRecord({
    metrics,
    tags,
    rendering,
    operator,
    technology,
    quality,
    status,
    basis,
    summary,
    notices,
    dataQuality,
    labelLocalized,
    summaryLocalized,
    source,
    sourceName,
    validFrom,
    updatedAt,
    adminLevel,
    name,
    code,
    countryCode,
    areaName,
    styleHint,
    iconHint,
    btsStatus,
    btsStatusSource,
    operatorStatusAvailable,
    estimatedSignalDbm,
    modelVersion,
    sourceRevision,
    readModel,
    generatedAt,
    resolutionM,
    demSource,
    assumptions,
    disclaimer,
    ...(providerProperties ?? {}),
    raw
  });
}

function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function cacheKeyForSituationQuery(query: SituationQuery, config: SituationDataConfig): string {
  return JSON.stringify({
    bbox: canonicalizeBboxForCache(query.bbox, config.bboxCachePaddingDegrees),
    layers: [...query.layers].sort(),
    sources: [...query.sourceIds].sort(),
    limit: query.limit,
    includeRaw: query.includeRaw,
    technologies: [...(query.mobileCoverageTechnologies ?? [])].sort(),
    operators: [...(query.mobileCoverageOperators ?? [])].sort()
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
    case "mobile_network":
      return 4;
    case "mobile_coverage":
      return 5;
    case "warnings":
      return 6;
    case "fire":
      return 7;
    case "flood":
      return 8;
    case "boundary_admin":
      return 9;
    case "air_quality":
      return 10;
    case "boundary_country":
      return 11;
    case "boundary_region":
      return 12;
    case "boundary_district":
      return 13;
    case "boundary_orp":
      return 14;
    case "place_settlements":
      return 15;
    case "weather_temperature_grid":
    case "weather_wind_field":
    case "weather_precipitation_grid":
    case "weather_humidity_grid":
    case "weather_pressure_grid":
    case "air_quality_grid":
      return 16;
    case "ground":
    default:
      return 20;
  }
}
