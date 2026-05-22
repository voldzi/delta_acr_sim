import cors from "cors";
import express, { type Express } from "express";
import { SituationAggregationService } from "./aggregation.js";
import { buildSituationMapCatalog } from "./catalog.js";
import type { SituationDataConfig } from "./config.js";
import { DemCatalog } from "./dem-catalog.js";
import { problem } from "./http.js";
import { LAYERS } from "./layers.js";
import { MobileCoverageSource } from "./mobile-coverage-source.js";
import { allSourceDescriptors, createSituationDataSources } from "./sources.js";
import type {
  BoundingBox,
  MobileCoverageTechnology,
  SituationDataPublicConfig,
  SituationDataSourceId,
  SituationLayerId,
  SituationQuery,
  SourceHealthStatus
} from "./types.js";

export interface SituationDataAppContext {
  config: SituationDataConfig;
  aggregation: SituationAggregationService;
  demCatalog: DemCatalog;
}

export async function createApp(config: SituationDataConfig): Promise<{ app: Express; context: SituationDataAppContext }> {
  const sources = createSituationDataSources(config);
  const aggregation = new SituationAggregationService(config, sources);
  const demCatalog = new DemCatalog(config);
  const context: SituationDataAppContext = { config, aggregation, demCatalog };
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  registerHealthRoutes(app, context);
  registerMetadataRoutes(app, context);
  registerFeatureRoutes(app, context);

  app.use((req, res) => {
    problem(req, res, 404, "NOT_FOUND", "Endpoint not found.");
  });

  return { app, context };
}

function registerHealthRoutes(app: Express, context: SituationDataAppContext): void {
  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/health/ready", async (_req, res) => {
    const sourceHealth = await context.aggregation.sourceHealthStatuses();
    const dem = await context.demCatalog.status();
    const degraded = sourceHealth.some((source) => source.status === "degraded");
    res.json({
      status: degraded || dem.status === "degraded" ? "degraded" : "ok",
      timestamp: new Date().toISOString(),
      enabledSources: context.config.enabledSources,
      sourceHealth,
      dem
    });
  });

  app.get("/metrics", async (_req, res) => {
    const cache = context.aggregation.cacheStats();
    const sourceHealth = await context.aggregation.sourceHealthStatuses();
    const dem = await context.demCatalog.status();
    const sourceCacheLines = context.aggregation.sourceCacheStats().flatMap((sourceCache) => [
      `situation_data_source_cache_entries{source="${sourceCache.sourceId}"} ${sourceCache.entries}`,
      `situation_data_source_cache_inflight{source="${sourceCache.sourceId}"} ${sourceCache.inflight}`,
      `situation_data_source_cache_hits{source="${sourceCache.sourceId}"} ${sourceCache.hits}`,
      `situation_data_source_cache_misses{source="${sourceCache.sourceId}"} ${sourceCache.misses}`,
      `situation_data_source_cache_coalesced_hits{source="${sourceCache.sourceId}"} ${sourceCache.coalescedHits}`,
      `situation_data_source_cache_stale_hits{source="${sourceCache.sourceId}"} ${sourceCache.staleHits}`,
      `situation_data_source_cache_refreshes{source="${sourceCache.sourceId}"} ${sourceCache.refreshes}`,
      `situation_data_source_cache_errors{source="${sourceCache.sourceId}"} ${sourceCache.errors}`,
      `situation_data_source_cache_evictions{source="${sourceCache.sourceId}"} ${sourceCache.evictions}`
    ]);
    const sourceHealthLines = sourceHealth.flatMap(sourceHealthMetricLines);
    res
      .type("text/plain")
      .send(
        [
          `situation_data_enabled_sources ${context.config.enabledSources.length}`,
          `situation_data_cache_entries ${cache.entries}`,
          `situation_data_cache_inflight ${cache.inflight}`,
          `situation_data_cache_hits ${cache.hits}`,
          `situation_data_cache_misses ${cache.misses}`,
          `situation_data_cache_coalesced_hits ${cache.coalescedHits}`,
          `situation_data_cache_stale_hits ${cache.staleHits}`,
          `situation_data_cache_refreshes ${cache.refreshes}`,
          `situation_data_cache_errors ${cache.errors}`,
          `situation_data_cache_evictions ${cache.evictions}`,
          ...sourceCacheLines,
          ...sourceHealthLines,
          ...demMetricLines(dem)
        ].join("\n") + "\n"
      );
  });
}

function registerMetadataRoutes(app: Express, context: SituationDataAppContext): void {
  app.get("/api/v1/layers", (_req, res) => {
    res.json({ items: LAYERS });
  });

  app.get("/api/v1/sources", (_req, res) => {
    res.json({ items: allSourceDescriptors(context.config) });
  });

  app.get("/api/v1/catalog", (_req, res) => {
    res.json(buildSituationMapCatalog(context.config));
  });

  app.get("/api/v1/config", (_req, res) => {
    res.json(publicConfig(context.config));
  });

  app.get("/api/v1/mobile-coverage/metadata", (_req, res) => {
    res.json(new MobileCoverageSource(context.config).metadata());
  });

  app.get("/api/v1/dem/metadata", async (_req, res) => {
    res.json(await context.demCatalog.metadata());
  });
}

function registerFeatureRoutes(app: Express, context: SituationDataAppContext): void {
  app.get("/api/v1/features", async (req, res) => {
    const query = parseSituationQuery(req.query, context.config);
    if (!query.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", query.error);
    }
    res.json(await context.aggregation.getFeatures(query.value));
  });

  app.get("/api/v1/cop/features", async (req, res) => {
    res.set(compatibilityAliasHeaders("/api/v1/features"));
    const query = parseSituationQuery(req.query, context.config);
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

function parseSituationQuery(
  raw: Record<string, unknown>,
  config: SituationDataConfig
): { ok: true; value: SituationQuery } | { ok: false; error: string } {
  const bbox = parseBbox(raw.bbox, config.defaultBbox);
  if (!bbox.ok) {
    return { ok: false, error: bbox.error };
  }
  const layers = parseLayers(raw.layer ?? raw.layers);
  if (layers.length === 0) {
    return { ok: false, error: "No valid situation layers requested." };
  }
  const sources = parseSources(raw.source ?? raw.sources, config.enabledSources);
  if (sources.length === 0) {
    return { ok: false, error: "No valid situation data sources requested." };
  }
  return {
    ok: true,
    value: {
      bbox: bbox.value,
      layers,
      sourceIds: sources,
      limit: parseLimit(raw.limit, 250, 1000),
      includeRaw: parseBoolean(raw.includeRaw),
      mobileCoverageTechnologies: parseTechnologies(raw.technology ?? raw.technologies),
      mobileCoverageOperators: parseOperators(raw.operator ?? raw.operators)
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

function parseLayers(value: unknown): SituationLayerId[] {
  const allowed = new Set<SituationLayerId>([
    "weather",
    "ground",
    "mobile",
    "mobile_coverage",
    "mobile_network",
    "traffic",
    "warnings",
    "flood",
    "air_quality"
  ]);
  const raw = asString(value);
  if (!raw) {
    return ["weather", "ground", "mobile", "mobile_network", "traffic", "warnings", "flood", "air_quality"];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is SituationLayerId => allowed.has(item as SituationLayerId));
}

function parseSources(value: unknown, fallback: SituationDataSourceId[]): SituationDataSourceId[] {
  const allowed = new Set<SituationDataSourceId>([
    "mock",
    "open_meteo",
    "mobile_coverage_model",
    "mobile_network_model",
    "osm_postgis",
    "osm_overpass",
    "ctu_nettest",
    "pid_gtfs_rt",
    "safety_data",
    "aviation_weather",
    "ardos_partner"
  ]);
  const raw = asString(value);
  if (!raw) {
    return fallback;
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is SituationDataSourceId => allowed.has(item as SituationDataSourceId));
}

function parseTechnologies(value: unknown): MobileCoverageTechnology[] | undefined {
  const allowed = new Set<MobileCoverageTechnology>(["2G", "4G", "5G"]);
  const raw = asString(value);
  if (!raw) {
    return undefined;
  }
  const parsed = raw
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter((item): item is MobileCoverageTechnology => allowed.has(item as MobileCoverageTechnology));
  return parsed.length > 0 ? parsed : undefined;
}

function parseOperators(value: unknown): string[] | undefined {
  const raw = asString(value);
  if (!raw) {
    return undefined;
  }
  const parsed = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  return parsed.length > 0 ? parsed : undefined;
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

function publicConfig(config: SituationDataConfig): SituationDataPublicConfig {
  return {
    enabledSources: config.enabledSources,
    defaultBbox: config.defaultBbox,
    cacheTtlSeconds: config.cacheTtlSeconds,
    staleIfErrorSeconds: config.staleIfErrorSeconds,
    cacheMaxEntries: config.cacheMaxEntries,
    bboxCachePaddingDegrees: config.bboxCachePaddingDegrees,
    staleAfterSeconds: config.staleAfterSeconds,
    requestTimeoutMs: config.requestTimeoutMs,
    sourceCacheTtlSeconds: {
      openMeteo: config.openMeteoCacheTtlSeconds,
      mobileNetwork: config.mobileNetworkCacheTtlSeconds,
      mobileCoverage: config.mobileCoverageCacheTtlSeconds,
      osmPostgis: config.osmPostgisCacheTtlSeconds,
      osmOverpass: config.overpassCacheTtlSeconds,
      safetyData: config.safetyDataCacheTtlSeconds,
      aviationWeather: config.aviationWeatherCacheTtlSeconds,
      ardosPartner: config.ardosPartnerCacheTtlSeconds
    },
    providers: [
      { sourceId: "mock", authConfigured: true },
      { sourceId: "open_meteo", baseUrl: config.openMeteoBaseUrl, authConfigured: true },
      {
        sourceId: "mobile_coverage_model",
        baseUrl: publicPostgisBaseUrl(config.osmPostgisConnectionString),
        authConfigured: Boolean(config.osmPostgisConnectionString),
        backend: config.osmPostgisBackend
      },
      {
        sourceId: "mobile_network_model",
        baseUrl: publicPostgisBaseUrl(config.osmPostgisConnectionString),
        authConfigured: Boolean(config.osmPostgisConnectionString),
        backend: config.osmPostgisBackend
      },
      {
        sourceId: "osm_postgis",
        baseUrl: publicPostgisBaseUrl(config.osmPostgisConnectionString),
        authConfigured: Boolean(config.osmPostgisConnectionString),
        backend: config.osmPostgisBackend
      },
      { sourceId: "osm_overpass", baseUrl: config.overpassBaseUrl, authConfigured: true },
      { sourceId: "ctu_nettest", baseUrl: config.ctuNettestUrl, authConfigured: true },
      { sourceId: "pid_gtfs_rt", baseUrl: config.pidGtfsRtVehiclePositionsUrl, authConfigured: true },
      { sourceId: "safety_data", baseUrl: config.safetyDataBaseUrl, authConfigured: true },
      { sourceId: "aviation_weather", baseUrl: config.aviationWeatherBaseUrl, authConfigured: true },
      { sourceId: "ardos_partner", baseUrl: config.ardosPartnerBaseUrl, authConfigured: Boolean(config.ardosPartnerBaseUrl && config.ardosPartnerToken) }
    ]
  };
}

function sourceHealthMetricLines(status: SourceHealthStatus): string[] {
  const backend = escapeLabel(status.backend ?? "unknown");
  const source = escapeLabel(status.sourceId);
  const lines = [`situation_data_source_health{source="${source}",backend="${backend}"} ${status.status === "ok" ? 1 : 0}`];
  if (status.sourceId === "mobile_coverage_model") {
    lines.push(`situation_data_mobile_coverage_backend_info{backend="${backend}"} 1`);
    if (typeof status.objectCount === "number") {
      lines.push(`situation_data_mobile_coverage_towers{backend="${backend}"} ${status.objectCount}`);
    }
  }
  if (status.sourceId === "mobile_network_model") {
    lines.push(`situation_data_mobile_network_backend_info{backend="${backend}"} 1`);
    if (typeof status.objectCount === "number") {
      lines.push(`situation_data_mobile_network_towers{backend="${backend}"} ${status.objectCount}`);
    }
  }
  if (status.sourceId === "osm_postgis") {
    lines.push(`situation_data_osm_postgis_backend_info{backend="${backend}"} 1`);
    if (typeof status.objectCount === "number") {
      lines.push(`situation_data_osm_postgis_objects{backend="${backend}"} ${status.objectCount}`);
    }
    if (status.lastImportAt) {
      lines.push(`situation_data_osm_postgis_last_import_timestamp_seconds{backend="${backend}"} ${Math.round(Date.parse(status.lastImportAt) / 1000)}`);
    }
    if (typeof status.lastImportAgeSeconds === "number") {
      lines.push(`situation_data_osm_postgis_import_age_seconds{backend="${backend}"} ${status.lastImportAgeSeconds}`);
    }
  }
  if (status.sourceId === "ctu_nettest") {
    lines.push(`situation_data_ctu_nettest_backend_info{backend="${backend}"} 1`);
    if (typeof status.objectCount === "number") {
      lines.push(`situation_data_ctu_nettest_measurements{backend="${backend}"} ${status.objectCount}`);
    }
    if (status.lastImportAt) {
      lines.push(`situation_data_ctu_nettest_latest_measurement_timestamp_seconds{backend="${backend}"} ${Math.round(Date.parse(status.lastImportAt) / 1000)}`);
    }
    if (typeof status.lastImportAgeSeconds === "number") {
      lines.push(`situation_data_ctu_nettest_latest_measurement_age_seconds{backend="${backend}"} ${status.lastImportAgeSeconds}`);
    }
  }
  return lines;
}

function demMetricLines(status: Awaited<ReturnType<DemCatalog["status"]>>): string[] {
  const dataset = escapeLabel(status.datasetId);
  const source = escapeLabel(status.source ?? "unknown");
  const state = status.status === "ok" ? 1 : 0;
  const lines = [`situation_data_dem_health{dataset="${dataset}",source="${source}"} ${state}`];
  if (typeof status.tileCount === "number") {
    lines.push(`situation_data_dem_tiles{dataset="${dataset}",source="${source}"} ${status.tileCount}`);
  }
  if (typeof status.localTileCount === "number") {
    lines.push(`situation_data_dem_local_tiles{dataset="${dataset}",source="${source}"} ${status.localTileCount}`);
  }
  if (typeof status.objectStoreTileCount === "number") {
    lines.push(`situation_data_dem_object_store_tiles{dataset="${dataset}",source="${source}"} ${status.objectStoreTileCount}`);
  }
  if (status.importedAt) {
    lines.push(`situation_data_dem_last_import_timestamp_seconds{dataset="${dataset}",source="${source}"} ${Math.round(Date.parse(status.importedAt) / 1000)}`);
  }
  return lines;
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

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
