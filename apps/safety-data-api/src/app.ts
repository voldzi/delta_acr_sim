import { createHttpRequestTracingMiddleware } from "@csm-sim/observability";
import cors, { type CorsOptions } from "cors";
import express, { type Express } from "express";
import { SafetyAggregationService } from "./aggregation.js";
import { buildSafetyMapCatalog } from "./catalog.js";
import type { SafetyDataConfig } from "./config.js";
import {
  buildSafetyFeatureDetail,
  buildSafetyFeatureGeometry,
  buildSafetyFeatureSummaryCollection,
  buildSafetyTaxonomy,
  findSafetyFeature
} from "./feature-views.js";
import { problem } from "./http.js";
import { LAYERS } from "./layers.js";
import { buildSafetyNotificationCandidateCollection, type SafetyNotificationCandidateOptions } from "./notification-candidates.js";
import { allSourceDescriptors, createSafetyDataSources } from "./sources.js";
import type { BoundingBox, HydroSeriesId, HydroStationDetail, HydroStationDetailQuery, SafetyDataPublicConfig, SafetyDataSourceId, SafetyLayerId, SafetyQuery, SafetySeverity } from "./types.js";

export interface SafetyDataAppContext {
  config: SafetyDataConfig;
  aggregation: SafetyAggregationService;
  hydroDetails?: {
    getHydroStationDetail(stationId: string, query: HydroStationDetailQuery): Promise<HydroStationDetail | undefined>;
  };
}

export async function createApp(config: SafetyDataConfig): Promise<{ app: Express; context: SafetyDataAppContext }> {
  const sources = createSafetyDataSources(config);
  const aggregation = new SafetyAggregationService(config, sources);
  const hydroSource = sources.find((source) => source.descriptor.sourceId === "chmi_hydro" && source.getHydroStationDetail);
  const hydroDetails = hydroSource?.getHydroStationDetail
    ? { getHydroStationDetail: hydroSource.getHydroStationDetail.bind(hydroSource) }
    : undefined;
  const context: SafetyDataAppContext = { config, aggregation, hydroDetails };
  const app = express();

  app.use(createHttpRequestTracingMiddleware("csm-sim-safety-data-api"));
  app.use(cors(createCorsOptions(config.corsOrigins)));
  app.use(express.json({ limit: "1mb" }));

  registerHealthRoutes(app, context);
  registerMetadataRoutes(app, context);
  registerFeatureRoutes(app, context);
  registerHydroDetailRoutes(app, context);

  app.use((req, res) => {
    problem(req, res, 404, "NOT_FOUND", "Endpoint not found.");
  });

  return { app, context };
}

function createCorsOptions(origins: string[] = []): CorsOptions {
  if (origins.length > 0) {
    return {
      origin(origin, callback) {
        callback(null, !origin || origins.includes(origin));
      }
    };
  }
  return process.env.NODE_ENV === "production" ? { origin: false } : {};
}

function registerHealthRoutes(app: Express, context: SafetyDataAppContext): void {
  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/health/ready", (_req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      enabledSources: context.config.enabledSources
    });
  });

  app.get("/metrics", (_req, res) => {
    const cache = context.aggregation.cacheStats();
    const snapshot = context.aggregation.telemetrySnapshot();
    const sourceCacheLines = context.aggregation.sourceCacheStats().flatMap((sourceCache) => [
      `safety_data_source_cache_entries{source="${sourceCache.sourceId}"} ${sourceCache.entries}`,
      `safety_data_source_cache_inflight{source="${sourceCache.sourceId}"} ${sourceCache.inflight}`,
      `safety_data_source_cache_hits{source="${sourceCache.sourceId}"} ${sourceCache.hits}`,
      `safety_data_source_cache_misses{source="${sourceCache.sourceId}"} ${sourceCache.misses}`,
      `safety_data_source_cache_coalesced_hits{source="${sourceCache.sourceId}"} ${sourceCache.coalescedHits}`,
      `safety_data_source_cache_stale_hits{source="${sourceCache.sourceId}"} ${sourceCache.staleHits}`,
      `safety_data_source_cache_refreshes{source="${sourceCache.sourceId}"} ${sourceCache.refreshes}`,
      `safety_data_source_cache_errors{source="${sourceCache.sourceId}"} ${sourceCache.errors}`,
      `safety_data_source_cache_evictions{source="${sourceCache.sourceId}"} ${sourceCache.evictions}`
    ]);
    const layerCountLines = Object.entries(snapshot.layerCounts).map(([layer, count]) => `safety_data_last_layer_features{layer="${layer}"} ${count ?? 0}`);
    res
      .type("text/plain")
      .send(
        [
          `safety_data_enabled_sources ${context.config.enabledSources.length}`,
          `safety_data_cache_entries ${cache.entries}`,
          `safety_data_cache_inflight ${cache.inflight}`,
          `safety_data_cache_hits ${cache.hits}`,
          `safety_data_cache_misses ${cache.misses}`,
          `safety_data_cache_coalesced_hits ${cache.coalescedHits}`,
          `safety_data_cache_stale_hits ${cache.staleHits}`,
          `safety_data_cache_refreshes ${cache.refreshes}`,
          `safety_data_cache_errors ${cache.errors}`,
          `safety_data_cache_evictions ${cache.evictions}`,
          `safety_data_last_feature_count ${snapshot.featureCount}`,
          `safety_data_last_source_count ${snapshot.sourceCount}`,
          `safety_data_last_stale_feature_count ${snapshot.staleFeatureCount}`,
          `safety_data_last_response_warning_count ${snapshot.responseWarningCount}`,
          `safety_data_last_advisory_count ${snapshot.advisoryCount}`,
          `safety_data_last_warning_count ${snapshot.warningCount}`,
          `safety_data_last_critical_count ${snapshot.criticalCount}`,
          `safety_data_last_generated_age_seconds ${snapshot.generatedAgeSeconds}`,
          ...layerCountLines,
          ...sourceCacheLines
        ].join("\n") + "\n"
      );
  });
}

function registerMetadataRoutes(app: Express, context: SafetyDataAppContext): void {
  app.get("/api/v1/layers", (_req, res) => {
    res.json({ items: LAYERS });
  });

  app.get("/api/v1/sources", (_req, res) => {
    res.json({ items: allSourceDescriptors(context.config) });
  });

  app.get("/api/v1/catalog", (_req, res) => {
    res.json(buildSafetyMapCatalog(context.config));
  });

  app.get("/api/v1/taxonomy", (_req, res) => {
    res.json(buildSafetyTaxonomy());
  });

  app.get("/api/v1/observability", (_req, res) => {
    const cache = context.aggregation.cacheStats();
    const snapshot = context.aggregation.telemetrySnapshot();
    const sourceCaches = context.aggregation.sourceCacheStats();
    res.json({
      serviceId: "safety-data-api",
      generatedAt: new Date().toISOString(),
      status: snapshot.responseWarningCount > 0 || sourceCaches.some(hasCurrentCacheFailure) ? "degraded" : "ok",
      cache: cacheTelemetry(cache, context.config.cacheMaxEntries),
      sourceCaches: sourceCaches.map((sourceCache) => ({
        sourceId: sourceCache.sourceId,
        cache: cacheTelemetry(sourceCache, context.config.cacheMaxEntries)
      })),
      dataFreshness: {
        sourceCount: context.config.enabledSources.length,
        sourcesWithImportAge: snapshot.generatedAgeSeconds >= 0 ? 1 : 0,
        newestImportAgeSeconds: snapshot.generatedAgeSeconds,
        oldestImportAgeSeconds: snapshot.generatedAgeSeconds,
        degradedSourceCount: snapshot.responseWarningCount > 0 ? 1 : 0,
        warningCount: snapshot.responseWarningCount
      },
      lastResult: snapshot
    });
  });

  app.get("/api/v1/config", (_req, res) => {
    res.json(publicConfig(context.config));
  });
}

function registerFeatureRoutes(app: Express, context: SafetyDataAppContext): void {
  app.get("/api/v1/features", async (req, res) => {
    const query = parseSafetyQuery(req.query, context.config);
    if (!query.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", query.error);
    }
    res.json(await context.aggregation.getFeatures(query.value));
  });

  app.get("/api/v1/cop/features", async (req, res) => {
    res.set(compatibilityAliasHeaders("/api/v1/features"));
    const query = parseSafetyQuery(req.query, context.config);
    if (!query.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", query.error);
    }
    res.json(await context.aggregation.getFeatures(query.value));
  });

  app.get("/api/v1/features/summary", async (req, res) => {
    const query = parseSafetyQuery(req.query, context.config);
    if (!query.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", query.error);
    }
    const collection = await context.aggregation.getFeatures(query.value);
    res.json(buildSafetyFeatureSummaryCollection(collection));
  });

  app.get("/api/v1/notifications/candidates", async (req, res) => {
    const query = parseSafetyQuery(req.query, context.config, {
      defaultLayers: ["warnings", "weather_alerts", "fire", "flood"],
      defaultLimit: 100
    });
    if (!query.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", query.error);
    }
    const options = parseNotificationCandidateOptions(req.query);
    if (!options.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", options.error);
    }
    const collection = await context.aggregation.getFeatures({
      ...query.value,
      includeRaw: false
    });
    res.json(buildSafetyNotificationCandidateCollection(collection, options.value));
  });

  app.get("/api/v1/features/:featureId/geometry", async (req, res) => {
    const featureId = req.params.featureId;
    if (!featureId) {
      return problem(req, res, 400, "VALIDATION_ERROR", "featureId is required.");
    }
    const query = parseSafetyQuery(req.query, context.config);
    if (!query.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", query.error);
    }
    const collection = await context.aggregation.getFeatures(query.value);
    const feature = findSafetyFeature(collection, featureId);
    if (!feature) {
      return problem(req, res, 404, "NOT_FOUND", "Safety feature was not found in the requested query window.");
    }
    res.json(buildSafetyFeatureGeometry(feature));
  });

  app.get("/api/v1/features/:featureId", async (req, res) => {
    const featureId = req.params.featureId;
    if (!featureId) {
      return problem(req, res, 400, "VALIDATION_ERROR", "featureId is required.");
    }
    const query = parseSafetyQuery(req.query, context.config);
    if (!query.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", query.error);
    }
    const collection = await context.aggregation.getFeatures(query.value);
    const feature = findSafetyFeature(collection, featureId);
    if (!feature) {
      return problem(req, res, 404, "NOT_FOUND", "Safety feature was not found in the requested query window.");
    }
    res.json(buildSafetyFeatureDetail(collection, feature));
  });
}

function registerHydroDetailRoutes(app: Express, context: SafetyDataAppContext): void {
  app.get("/api/v1/hydro/stations/:stationId/observations", async (req, res) => {
    if (!context.hydroDetails) {
      return problem(req, res, 503, "SOURCE_UNAVAILABLE", "CHMI hydro source is not enabled.");
    }
    const query = parseHydroDetailQuery(req.query);
    if (!query.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", query.error);
    }
    const detail = await context.hydroDetails.getHydroStationDetail(req.params.stationId, query.value);
    if (!detail) {
      return problem(req, res, 404, "NOT_FOUND", "CHMI hydro station was not found.");
    }
    res.json(detail);
  });
}

function compatibilityAliasHeaders(successorPath: string): Record<string, string> {
  return {
    Deprecation: "true",
    Link: `<${successorPath}>; rel="successor-version"`,
    Warning: '299 - "Compatibility alias; use the source-neutral provider endpoint for new integrations."'
  };
}

function parseSafetyQuery(
  raw: Record<string, unknown>,
  config: SafetyDataConfig,
  options: { defaultLayers?: SafetyLayerId[]; defaultLimit?: number } = {}
): { ok: true; value: SafetyQuery } | { ok: false; error: string } {
  const bbox = parseBbox(raw.bbox, config.defaultBbox);
  if (!bbox.ok) {
    return { ok: false, error: bbox.error };
  }
  const layers = parseLayers(raw.layer ?? raw.layers, options.defaultLayers);
  if (layers.length === 0) {
    return { ok: false, error: "No valid safety layers requested." };
  }
  const sources = parseSources(raw.source ?? raw.sources, config.enabledSources);
  if (sources.length === 0) {
    return { ok: false, error: "No valid safety data sources requested." };
  }
  return {
    ok: true,
    value: {
      bbox: bbox.value,
      layers,
      sourceIds: sources,
      limit: parseLimit(raw.limit, options.defaultLimit ?? 250, 1000),
      includeRaw: parseBoolean(raw.includeRaw)
    }
  };
}

function parseBbox(value: unknown, fallback: BoundingBox): { ok: true; value: BoundingBox } | { ok: false; error: string } {
  const raw = asString(value);
  if (!raw) {
    return { ok: true, value: fallback };
  }
  const parts = raw.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return { ok: false, error: "bbox must be west,south,east,north." };
  }
  const [west, south, east, north] = parts as [number, number, number, number];
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
    return { ok: false, error: "bbox coordinates are outside WGS84 bounds or not ordered west,south,east,north." };
  }
  return { ok: true, value: { west, south, east, north } };
}

function parseLayers(value: unknown, fallback: SafetyLayerId[] = ["weather_alerts", "fire", "flood", "boundary_admin"]): SafetyLayerId[] {
  const allowed = new Set<SafetyLayerId>(["weather_alerts", "warnings", "fire", "flood", "boundary_admin"]);
  const raw = asString(value);
  if (!raw) {
    return fallback;
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is SafetyLayerId => allowed.has(item as SafetyLayerId));
}

function parseNotificationCandidateOptions(
  raw: Record<string, unknown>
): { ok: true; value: SafetyNotificationCandidateOptions } | { ok: false; error: string } {
  const minSeverity = parseSeverity(raw.minSeverity ?? raw.minimumSeverity, "advisory");
  if (!minSeverity) {
    return { ok: false, error: "minSeverity must be one of info,advisory,warning,critical." };
  }
  return {
    ok: true,
    value: {
      minSeverity,
      includeStale: parseBoolean(raw.includeStale)
    }
  };
}

function parseSeverity(value: unknown, fallback: SafetySeverity): SafetySeverity | undefined {
  const raw = asString(value);
  if (!raw) {
    return fallback;
  }
  const allowed = new Set<SafetySeverity>(["info", "advisory", "warning", "critical"]);
  return allowed.has(raw as SafetySeverity) ? (raw as SafetySeverity) : undefined;
}

function parseSources(value: unknown, fallback: SafetyDataSourceId[]): SafetyDataSourceId[] {
  const allowed = new Set<SafetyDataSourceId>(["mock", "chmi_alerts", "chmi_hydro", "nasa_firms", "gdacs_alerts", "hzs_incidents", "road_srti_lod", "admin_boundaries"]);
  const raw = asString(value);
  if (!raw) {
    return fallback;
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is SafetyDataSourceId => allowed.has(item as SafetyDataSourceId));
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  const raw = asString(value);
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(1, Math.trunc(parsed))) : fallback;
}

function parseBoolean(value: unknown): boolean {
  const raw = asString(value);
  return raw === "1" || raw === "true" || raw === "yes";
}

function parseHydroDetailQuery(
  raw: Record<string, unknown>
): { ok: true; value: HydroStationDetailQuery } | { ok: false; error: string } {
  const from = parseIsoDateParam(raw.from, "from");
  if (!from.ok) {
    return from;
  }
  const to = parseIsoDateParam(raw.to, "to");
  if (!to.ok) {
    return to;
  }
  if (from.value && to.value && Date.parse(from.value) >= Date.parse(to.value)) {
    return { ok: false, error: "from must be earlier than to." };
  }
  const seriesIds = parseHydroSeries(raw.series);
  if (seriesIds.length === 0 && asString(raw.series)) {
    return { ok: false, error: "series must contain at least one of H,Q,TH,H_F,Q_F." };
  }
  return {
    ok: true,
    value: {
      from: from.value,
      to: to.value,
      seriesIds: seriesIds.length > 0 ? seriesIds : undefined
    }
  };
}

function parseIsoDateParam(value: unknown, name: string): { ok: true; value?: string } | { ok: false; error: string } {
  const raw = asString(value);
  if (!raw) {
    return { ok: true };
  }
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) {
    return { ok: false, error: `${name} must be an ISO-8601 timestamp.` };
  }
  return { ok: true, value: date.toISOString() };
}

function parseHydroSeries(value: unknown): HydroSeriesId[] {
  const allowed = new Set<HydroSeriesId>(["H", "Q", "TH", "H_F", "Q_F"]);
  const raw = asString(value);
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is HydroSeriesId => allowed.has(item as HydroSeriesId));
}

function asString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return asString(value[0]);
  }
  return typeof value === "string" ? value : undefined;
}

function publicConfig(config: SafetyDataConfig): SafetyDataPublicConfig {
  return {
    enabledSources: config.enabledSources,
    defaultBbox: config.defaultBbox,
    cacheTtlSeconds: config.cacheTtlSeconds,
    staleIfErrorSeconds: config.staleIfErrorSeconds,
    cacheMaxEntries: config.cacheMaxEntries,
    staleAfterSeconds: config.staleAfterSeconds,
    requestTimeoutMs: config.requestTimeoutMs,
    hydroMaxStations: config.chmiHydroMaxStations,
    hydroStationCacheMaxEntries: config.chmiHydroStationCacheMaxEntries,
    hydroCurrentSnapshotCacheTtlSeconds: config.chmiHydroCurrentSnapshotCacheTtlSeconds,
    hydroDetailDefaultPastHours: config.chmiHydroDetailDefaultPastHours,
    hydroDetailForecastHours: config.chmiHydroDetailForecastHours,
    hydroDetailBackfillDays: config.chmiHydroDetailBackfillDays,
    providers: [
      { sourceId: "mock", authConfigured: true },
      { sourceId: "chmi_alerts", baseUrl: config.chmiAlertsCapBaseUrl, authConfigured: true },
      { sourceId: "chmi_hydro", baseUrl: config.chmiHydroNowBaseUrl, authConfigured: true },
      { sourceId: "nasa_firms", baseUrl: config.nasaFirmsAreaBaseUrl, authConfigured: Boolean(config.nasaFirmsMapKey) },
      { sourceId: "gdacs_alerts", baseUrl: config.gdacsRssUrl, authConfigured: true },
      { sourceId: "hzs_incidents", baseUrl: config.hzsIncidentFeeds[0]?.url, authConfigured: true },
      { sourceId: "road_srti_lod", baseUrl: config.roadSrtiLodSparqlUrl, authConfigured: true },
      { sourceId: "admin_boundaries", baseUrl: publicPostgisBaseUrl(config.adminBoundaryConnectionString), authConfigured: Boolean(config.adminBoundaryConnectionString) }
    ]
  };
}

interface CacheStatsLike {
  entries: number;
  inflight: number;
  maxEntries?: number;
  hits: number;
  misses: number;
  coalescedHits: number;
  staleHits: number;
  refreshes: number;
  errors: number;
  evictions: number;
  lastSuccessAt?: string;
  lastErrorAt?: string;
}

function cacheTelemetry(stats: CacheStatsLike, maxEntries: number): Record<string, number | string> {
  const requestCount = stats.hits + stats.misses;
  const effectiveMaxEntries = Math.max(1, stats.maxEntries ?? maxEntries);
  const pressure = ratio(stats.entries, effectiveMaxEntries);
  const currentFailure = hasCurrentCacheFailure(stats);
  const telemetry: Record<string, number | string> = {
    entries: stats.entries,
    inflight: stats.inflight,
    maxEntries: effectiveMaxEntries,
    pressure,
    hits: stats.hits,
    misses: stats.misses,
    hitRate: ratio(stats.hits, requestCount),
    coalescedHits: stats.coalescedHits,
    staleHits: stats.staleHits,
    refreshes: stats.refreshes,
    errors: stats.errors,
    evictions: stats.evictions,
    state: currentFailure ? "degraded" : pressure > 0.95 ? "pressure" : requestCount > 0 ? "warm" : "cold"
  };
  if (stats.lastSuccessAt) {
    telemetry.lastSuccessAt = stats.lastSuccessAt;
  }
  if (stats.lastErrorAt) {
    telemetry.lastErrorAt = stats.lastErrorAt;
  }
  return telemetry;
}

function ratio(value: number, total: number): number {
  return total > 0 ? Number((value / total).toFixed(4)) : 0;
}

function hasCurrentCacheFailure(stats: Pick<CacheStatsLike, "lastErrorAt" | "lastSuccessAt">): boolean {
  return isAfterIso(stats.lastErrorAt, stats.lastSuccessAt);
}

function isAfterIso(left: string | undefined, right: string | undefined): boolean {
  if (!left) {
    return false;
  }
  const leftTime = Date.parse(left);
  if (!Number.isFinite(leftTime)) {
    return false;
  }
  if (!right) {
    return true;
  }
  const rightTime = Date.parse(right);
  return !Number.isFinite(rightTime) || leftTime > rightTime;
}

function publicPostgisBaseUrl(connectionString: string | undefined): string | undefined {
  if (!connectionString) {
    return undefined;
  }
  try {
    const url = new URL(connectionString);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "postgresql://configured";
  }
}
