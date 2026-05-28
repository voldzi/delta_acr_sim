import cors, { type CorsOptions } from "cors";
import express, { type Express } from "express";
import { SafetyAggregationService } from "./aggregation.js";
import { buildSafetyMapCatalog } from "./catalog.js";
import type { SafetyDataConfig } from "./config.js";
import { problem } from "./http.js";
import { LAYERS } from "./layers.js";
import { allSourceDescriptors, createSafetyDataSources } from "./sources.js";
import type { BoundingBox, SafetyDataPublicConfig, SafetyDataSourceId, SafetyLayerId, SafetyQuery } from "./types.js";

export interface SafetyDataAppContext {
  config: SafetyDataConfig;
  aggregation: SafetyAggregationService;
}

export async function createApp(config: SafetyDataConfig): Promise<{ app: Express; context: SafetyDataAppContext }> {
  const sources = createSafetyDataSources(config);
  const aggregation = new SafetyAggregationService(config, sources);
  const context: SafetyDataAppContext = { config, aggregation };
  const app = express();

  app.use(cors(createCorsOptions(config.corsOrigins)));
  app.use(express.json({ limit: "1mb" }));

  registerHealthRoutes(app, context);
  registerMetadataRoutes(app, context);
  registerFeatureRoutes(app, context);

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
          `safety_data_cache_evictions ${cache.evictions}`
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

  app.get("/api/v1/observability", (_req, res) => {
    const cache = context.aggregation.cacheStats();
    res.json({
      serviceId: "safety-data-api",
      generatedAt: new Date().toISOString(),
      status: "ok",
      cache: cacheTelemetry(cache, context.config.cacheMaxEntries),
      sourceCaches: [],
      dataFreshness: {
        sourceCount: context.config.enabledSources.length,
        sourcesWithImportAge: 0,
        newestImportAgeSeconds: -1,
        oldestImportAgeSeconds: -1,
        degradedSourceCount: 0,
        warningCount: 0
      }
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
  config: SafetyDataConfig
): { ok: true; value: SafetyQuery } | { ok: false; error: string } {
  const bbox = parseBbox(raw.bbox, config.defaultBbox);
  if (!bbox.ok) {
    return { ok: false, error: bbox.error };
  }
  const layers = parseLayers(raw.layer ?? raw.layers);
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
      limit: parseLimit(raw.limit, 250, 1000),
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

function parseLayers(value: unknown): SafetyLayerId[] {
  const allowed = new Set<SafetyLayerId>(["weather_alerts", "warnings", "fire", "flood", "boundary_admin"]);
  const raw = asString(value);
  if (!raw) {
    return ["weather_alerts", "fire", "flood", "boundary_admin"];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is SafetyLayerId => allowed.has(item as SafetyLayerId));
}

function parseSources(value: unknown, fallback: SafetyDataSourceId[]): SafetyDataSourceId[] {
  const allowed = new Set<SafetyDataSourceId>(["mock", "chmi_alerts", "chmi_hydro", "nasa_firms", "admin_boundaries"]);
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
    providers: [
      { sourceId: "mock", authConfigured: true },
      { sourceId: "chmi_alerts", baseUrl: config.chmiAlertsCapBaseUrl, authConfigured: true },
      { sourceId: "chmi_hydro", baseUrl: config.chmiHydroNowBaseUrl, authConfigured: true },
      { sourceId: "nasa_firms", baseUrl: config.nasaFirmsAreaBaseUrl, authConfigured: Boolean(config.nasaFirmsMapKey) },
      { sourceId: "admin_boundaries", authConfigured: true }
    ]
  };
}

interface CacheStatsLike {
  entries: number;
  inflight: number;
  hits: number;
  misses: number;
  coalescedHits: number;
  staleHits: number;
  refreshes: number;
  errors: number;
  evictions: number;
}

function cacheTelemetry(stats: CacheStatsLike, maxEntries: number): Record<string, number | string> {
  const requestCount = stats.hits + stats.misses;
  const pressure = ratio(stats.entries, Math.max(1, maxEntries));
  return {
    entries: stats.entries,
    inflight: stats.inflight,
    maxEntries,
    pressure,
    hits: stats.hits,
    misses: stats.misses,
    hitRate: ratio(stats.hits, requestCount),
    coalescedHits: stats.coalescedHits,
    staleHits: stats.staleHits,
    refreshes: stats.refreshes,
    errors: stats.errors,
    evictions: stats.evictions,
    state: stats.errors > 0 || stats.evictions > 0 ? "degraded" : pressure > 0.85 ? "pressure" : requestCount > 0 ? "warm" : "cold"
  };
}

function ratio(value: number, total: number): number {
  return total > 0 ? Number((value / total).toFixed(4)) : 0;
}
