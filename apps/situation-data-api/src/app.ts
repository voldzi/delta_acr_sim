import { createHttpRequestTracingMiddleware } from "@csm-sim/observability";
import cors, { type CorsOptions } from "cors";
import express, { type Express } from "express";
import { SituationAggregationService } from "./aggregation.js";
import { buildSituationMapCatalog } from "./catalog.js";
import { ChmiWeatherWebcamCatalog } from "./chmi-webcams.js";
import type { SituationDataConfig } from "./config.js";
import { DemCatalog } from "./dem-catalog.js";
import { problem } from "./http.js";
import { LAYERS } from "./layers.js";
import { MobileCoverageSource } from "./mobile-coverage-source.js";
import { ChmiWeatherRadarFrameCatalog } from "./radar-frames.js";
import { RadioPlanningError, RadioPlanningService } from "./radio-planning.js";
import { createSharedResponseCacheStore } from "./shared-cache.js";
import { allSourceDescriptors, createSituationDataSources } from "./sources.js";
import {
  buildSituationFeatureDetail,
  buildSituationFeatureGeometry,
  buildSituationFeatureSummaryCollection,
  buildSituationTaxonomy,
  findSituationFeature
} from "./feature-views.js";
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
  mobileCoverage: MobileCoverageSource;
  radioPlanning: RadioPlanningService;
  radarFrames: ChmiWeatherRadarFrameCatalog;
  weatherWebcams: ChmiWeatherWebcamCatalog;
}

export async function createApp(config: SituationDataConfig): Promise<{ app: Express; context: SituationDataAppContext }> {
  const sources = createSituationDataSources(config);
  const sharedCache = await createSharedResponseCacheStore(config);
  const aggregation = new SituationAggregationService(config, sources, sharedCache);
  const demCatalog = new DemCatalog(config);
  const mobileCoverage = new MobileCoverageSource(config);
  const radioPlanning = new RadioPlanningService(config);
  const radarFrames = new ChmiWeatherRadarFrameCatalog(config);
  const weatherWebcams = new ChmiWeatherWebcamCatalog(config);
  const context: SituationDataAppContext = { config, aggregation, demCatalog, mobileCoverage, radioPlanning, radarFrames, weatherWebcams };
  const app = express();

  app.use(createHttpRequestTracingMiddleware("csm-sim-situation-data-api"));
  app.use(cors(createCorsOptions(config.corsOrigins)));
  app.use(express.json({ limit: "1mb" }));

  registerHealthRoutes(app, context);
  registerMetadataRoutes(app, context);
  registerRadioRoutes(app, context);
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
          `situation_data_cache_shared_enabled ${cache.sharedEnabled ? 1 : 0}`,
          `situation_data_cache_shared_available ${cache.sharedAvailable ? 1 : 0}`,
          `situation_data_cache_shared_hits ${cache.sharedHits}`,
          `situation_data_cache_shared_misses ${cache.sharedMisses}`,
          `situation_data_cache_shared_stale_hits ${cache.sharedStaleHits}`,
          `situation_data_cache_shared_writes ${cache.sharedWrites}`,
          `situation_data_cache_shared_errors ${cache.sharedErrors}`,
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

  app.get("/api/v1/taxonomy", (_req, res) => {
    res.json(buildSituationTaxonomy());
  });

  app.get("/api/v1/config", (_req, res) => {
    res.json(publicConfig(context.config));
  });

  app.get("/api/v1/observability", async (_req, res) => {
    const cache = context.aggregation.cacheStats();
    const sourceHealth = await context.aggregation.sourceHealthStatuses();
    const dem = await context.demCatalog.status();
    res.json({
      serviceId: "situation-data-api",
      generatedAt: new Date().toISOString(),
      status: sourceHealth.some((source) => source.status === "degraded") || dem.status === "degraded" ? "degraded" : "ok",
      cache: cacheTelemetry(cache, context.config.cacheMaxEntries),
      sharedCache: {
        enabled: cache.sharedEnabled,
        available: cache.sharedAvailable,
        hits: cache.sharedHits,
        misses: cache.sharedMisses,
        hitRate: ratio(cache.sharedHits, cache.sharedHits + cache.sharedMisses),
        staleHits: cache.sharedStaleHits,
        writes: cache.sharedWrites,
        errors: cache.sharedErrors,
        state: cache.sharedEnabled ? (cache.sharedAvailable && cache.sharedErrors === 0 ? "ok" : "degraded") : "disabled"
      },
      sourceCaches: context.aggregation.sourceCacheStats().map((sourceCache) => ({
        sourceId: sourceCache.sourceId,
        cache: cacheTelemetry(sourceCache, context.config.cacheMaxEntries)
      })),
      dataFreshness: sourceFreshness(sourceHealth),
      environmentGrid: environmentGridTelemetry(context.config, sourceHealth),
      boundaryReadModel: boundaryReadModelTelemetry(context.config, sourceHealth),
      sourceHealth: sourceHealth.map((source) => ({
        sourceId: source.sourceId,
        status: source.status,
        backend: source.backend,
        objectCount: source.objectCount,
        lastImportAt: source.lastImportAt,
        lastImportAgeSeconds: source.lastImportAgeSeconds,
        boundaryFeatureCount: source.boundaryFeatureCount,
        boundaryLevels: source.boundaryLevels,
        boundaryLastImportAt: source.boundaryLastImportAt,
        boundaryLastImportAgeSeconds: source.boundaryLastImportAgeSeconds,
        warningCount: source.warnings.length
      }))
    });
  });

  app.get("/api/v1/mobile-coverage/metadata", (_req, res) => {
    res.json(context.mobileCoverage.metadata());
  });

  app.get("/api/v1/mobile-coverage/towers/:towerId/viewshed", async (req, res) => {
    const towerId = req.params.towerId;
    if (!towerId || !isValidTowerId(towerId)) {
      return problem(req, res, 400, "VALIDATION_ERROR", "towerId must use OSM form node:<id>, way:<id> or relation:<id>.");
    }
    if (!context.config.osmPostgisConnectionString) {
      return problem(req, res, 503, "SOURCE_UNAVAILABLE", "OSM_POSTGIS_DATABASE_URL is required for tower viewshed.");
    }
    const request = parseMobileCoverageViewshedQuery(req.query);
    if (!request.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", request.error);
    }
    try {
      const payload = await context.mobileCoverage.buildTowerViewshed({
        towerId,
        ...request.value
      });
      if (!payload) {
        return problem(req, res, 404, "NOT_FOUND", "Mobile coverage tower was not found.");
      }
      res.json(payload);
    } catch (error) {
      return problem(
        req,
        res,
        502,
        "UPSTREAM_ERROR",
        error instanceof Error ? `Mobile coverage tower viewshed failed: ${error.message}` : "Mobile coverage tower viewshed failed."
      );
    }
  });

  app.get("/api/v1/dem/metadata", async (_req, res) => {
    res.json(await context.demCatalog.metadata());
  });

  app.get("/api/v1/weather-radar/frames", async (req, res) => {
    res.json(
      await context.radarFrames.listFrames({
        productIds: parseStringList(req.query.product ?? req.query.products),
        historyHours: parseOptionalNumber(req.query.historyHours ?? req.query.hours),
        limit: parseOptionalNumber(req.query.limit),
        materialize: parseBoolean(req.query.materialize)
      })
    );
  });

  app.get("/api/v1/weather-radar/assets/:productId/:fileName", async (req, res) => {
    const asset = await context.radarFrames.storedAsset(req.params.productId, req.params.fileName);
    if (!asset) {
      return problem(req, res, 404, "NOT_FOUND", "Weather radar frame is not stored locally.");
    }
    res.type(asset.contentType);
    res.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
    res.sendFile(asset.path);
  });

  app.get("/api/v1/weather-radar/clean/:productId/:fileName", async (req, res) => {
    try {
      const asset = await context.radarFrames.cleanAsset(req.params.productId, req.params.fileName);
      if (!asset) {
        return problem(req, res, 404, "NOT_FOUND", "Clean weather radar frame is not available for this product.");
      }
      res.type(asset.contentType);
      res.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
      res.sendFile(asset.path);
    } catch (error) {
      return problem(
        req,
        res,
        502,
        "UPSTREAM_ERROR",
        error instanceof Error ? `Clean weather radar frame generation failed: ${error.message}` : "Clean weather radar frame generation failed."
      );
    }
  });

  app.get("/api/v1/weather-cameras", async (req, res) => {
    const bbox = parseOptionalBbox(req.query.bbox);
    if (!bbox.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", bbox.error);
    }
    try {
      res.json(
        await context.weatherWebcams.listCatalog({
          bbox: bbox.value,
          limit: parseOptionalNumber(req.query.limit),
          includeRaw: parseBoolean(req.query.includeRaw)
        })
      );
    } catch (error) {
      return problem(
        req,
        res,
        502,
        "UPSTREAM_ERROR",
        error instanceof Error ? `CHMI weather camera catalog fetch failed: ${error.message}` : "CHMI weather camera catalog fetch failed."
      );
    }
  });

  app.get("/api/v1/weather-cameras/:locationId", async (req, res) => {
    try {
      const detail = await context.weatherWebcams.getDetail(req.params.locationId);
      if (!detail) {
        return problem(req, res, 404, "NOT_FOUND", "Weather camera location was not found.");
      }
      res.json(detail);
    } catch (error) {
      return problem(
        req,
        res,
        502,
        "UPSTREAM_ERROR",
        error instanceof Error ? `CHMI weather camera detail fetch failed: ${error.message}` : "CHMI weather camera detail fetch failed."
      );
    }
  });

  app.get("/api/v1/weather-cameras/:locationId/snapshot", async (req, res) => {
    try {
      const asset = await context.weatherWebcams.snapshot(req.params.locationId, asString(req.query.cameraId));
      if (!asset) {
        return problem(req, res, 404, "NOT_FOUND", "Weather camera snapshot was not found.");
      }
      res.type(asset.contentType);
      res.set("Cache-Control", `public, max-age=${asset.cacheSeconds}, stale-while-revalidate=${asset.cacheSeconds * 2}`);
      res.set("X-SIM-Camera-Id", asset.cameraId);
      res.set("X-SIM-Camera-Name", encodeURIComponent(asset.name));
      res.send(asset.body);
    } catch (error) {
      return problem(
        req,
        res,
        502,
        "UPSTREAM_ERROR",
        error instanceof Error ? `CHMI weather camera snapshot fetch failed: ${error.message}` : "CHMI weather camera snapshot fetch failed."
      );
    }
  });
}

function registerRadioRoutes(app: Express, context: SituationDataAppContext): void {
  app.get("/api/v1/radio/profiles", async (_req, res) => {
    res.json(await context.radioPlanning.listProfiles());
  });

  app.post("/api/v1/radio/profiles", async (req, res) => {
    try {
      const profile = await context.radioPlanning.saveCustomProfile(req.body);
      res.status(201).json(profile);
    } catch (error) {
      return radioProblem(req, res, error, "Radio profile save failed.");
    }
  });

  app.post("/api/v1/radio/link-check", async (req, res) => {
    try {
      res.json(await context.radioPlanning.linkCheck(req.body));
    } catch (error) {
      return radioProblem(req, res, error, "Radio link check failed.");
    }
  });

  app.post("/api/v1/radio/coverage", async (req, res) => {
    try {
      res.json(await context.radioPlanning.coverage(req.body));
    } catch (error) {
      return radioProblem(req, res, error, "Radio coverage failed.");
    }
  });

  app.post("/api/v1/radio/site-search", async (req, res) => {
    try {
      res.json(await context.radioPlanning.siteSearch(req.body));
    } catch (error) {
      return radioProblem(req, res, error, "Radio site search failed.");
    }
  });
}

function radioProblem(req: Parameters<typeof problem>[0], res: Parameters<typeof problem>[1], error: unknown, fallbackMessage: string): void {
  if (error instanceof RadioPlanningError) {
    return problem(req, res, error.status, error.code, error.message);
  }
  return problem(req, res, 502, "UPSTREAM_ERROR", error instanceof Error ? `${fallbackMessage}: ${error.message}` : fallbackMessage);
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

  app.get("/api/v1/features/summary", async (req, res) => {
    const query = parseSituationQuery(req.query, context.config);
    if (!query.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", query.error);
    }
    const collection = await context.aggregation.getFeatures(query.value);
    res.json(buildSituationFeatureSummaryCollection(collection));
  });

  app.get("/api/v1/features/:featureId/geometry", async (req, res) => {
    const featureId = req.params.featureId;
    if (!featureId) {
      return problem(req, res, 400, "VALIDATION_ERROR", "featureId is required.");
    }
    const query = parseSituationQuery(req.query, context.config);
    if (!query.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", query.error);
    }
    const collection = await context.aggregation.getFeatures(query.value);
    const feature = findSituationFeature(collection, featureId);
    if (!feature) {
      return problem(req, res, 404, "NOT_FOUND", "Situation feature was not found in the requested query window.");
    }
    res.json(buildSituationFeatureGeometry(feature));
  });

  app.get("/api/v1/features/:featureId", async (req, res) => {
    const featureId = req.params.featureId;
    if (!featureId) {
      return problem(req, res, 400, "VALIDATION_ERROR", "featureId is required.");
    }
    const query = parseSituationQuery(req.query, context.config);
    if (!query.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", query.error);
    }
    const collection = await context.aggregation.getFeatures(query.value);
    const feature = findSituationFeature(collection, featureId);
    if (!feature) {
      return problem(req, res, 404, "NOT_FOUND", "Situation feature was not found in the requested query window.");
    }
    res.json(buildSituationFeatureDetail(collection, feature));
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
    "fire",
    "flood",
    "boundary_admin",
    "boundary_country",
    "boundary_region",
    "boundary_district",
    "boundary_orp",
    "place_settlements",
    "air_quality",
    "weather_temperature_grid",
    "weather_wind_field",
    "weather_precipitation_grid",
    "weather_humidity_grid",
    "weather_pressure_grid",
    "weather_radar_reflectivity",
    "weather_radar_precipitation",
    "weather_radar_nowcast",
    "weather_thunderstorm_risk",
    "weather_webcams",
    "air_quality_grid"
  ]);
  const raw = asString(value);
  if (!raw) {
    return [
      "weather",
      "ground",
      "mobile",
      "mobile_network",
      "traffic",
      "warnings",
      "fire",
      "flood",
      "boundary_admin",
      "boundary_country",
      "boundary_region",
      "boundary_district",
      "boundary_orp",
      "place_settlements",
      "air_quality",
      "weather_temperature_grid",
      "weather_wind_field",
      "weather_precipitation_grid",
      "weather_humidity_grid",
      "weather_pressure_grid",
      "weather_radar_reflectivity",
      "weather_radar_precipitation",
      "weather_radar_nowcast",
      "weather_thunderstorm_risk",
      "weather_webcams",
      "air_quality_grid"
    ];
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
    "ctu_stationary_mobile",
    "pid_gtfs_rt",
    "idsjmk_vehicle_positions",
    "road_srti_lod",
    "safety_data",
    "aviation_weather",
    "chmi_air_quality",
    "chmi_weather_stations",
    "chmi_weather_radar",
    "chmi_weather_webcams",
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

function parseMobileCoverageViewshedQuery(
  raw: Record<string, unknown>
): { ok: true; value: { technology?: MobileCoverageTechnology; radiusM?: number; azimuthStepDeg?: number; distanceStepM?: number; includeRaw?: boolean } } | { ok: false; error: string } {
  const technologies = parseTechnologies(raw.technology);
  if (asString(raw.technology) && !technologies?.[0]) {
    return { ok: false, error: "technology must be one of 2G, 4G or 5G." };
  }
  const radiusM = parsePositiveOptionalNumber(raw.radiusM);
  if (!radiusM.ok) {
    return { ok: false, error: "radiusM must be a positive number." };
  }
  const azimuthStepDeg = parsePositiveOptionalNumber(raw.azimuthStepDeg);
  if (!azimuthStepDeg.ok) {
    return { ok: false, error: "azimuthStepDeg must be a positive number." };
  }
  const distanceStepM = parsePositiveOptionalNumber(raw.distanceStepM);
  if (!distanceStepM.ok) {
    return { ok: false, error: "distanceStepM must be a positive number." };
  }
  return {
    ok: true,
    value: {
      technology: technologies?.[0],
      radiusM: radiusM.value,
      azimuthStepDeg: azimuthStepDeg.value,
      distanceStepM: distanceStepM.value,
      includeRaw: parseBoolean(raw.includeRaw)
    }
  };
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

function parseOptionalNumber(value: unknown): number | undefined {
  const raw = asString(value);
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePositiveOptionalNumber(value: unknown): { ok: true; value?: number } | { ok: false } {
  const raw = asString(value);
  if (!raw) {
    return { ok: true };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { ok: false };
  }
  return { ok: true, value: parsed };
}

function parseStringList(value: unknown): string[] | undefined {
  const raw = asString(value);
  if (!raw) {
    return undefined;
  }
  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

function asString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return asString(value[0]);
  }
  return typeof value === "string" ? value : undefined;
}

function isValidTowerId(value: string): boolean {
  return /^(node|way|relation):-?\d+$/.test(value);
}

function publicConfig(config: SituationDataConfig): SituationDataPublicConfig {
  return {
    enabledSources: config.enabledSources,
    defaultBbox: config.defaultBbox,
    cacheTtlSeconds: config.cacheTtlSeconds,
    staleIfErrorSeconds: config.staleIfErrorSeconds,
    cacheMaxEntries: config.cacheMaxEntries,
    sharedCache: {
      enabled: Boolean(config.sharedCacheRedisUrl),
      backend: config.sharedCacheRedisUrl ? "redis" : "memory",
      keyPrefix: config.sharedCacheKeyPrefix,
      connectTimeoutMs: config.sharedCacheConnectTimeoutMs
    },
    bboxCachePaddingDegrees: config.bboxCachePaddingDegrees,
    staleAfterSeconds: config.staleAfterSeconds,
    requestTimeoutMs: config.requestTimeoutMs,
    sourceCacheTtlSeconds: {
      openMeteo: config.openMeteoCacheTtlSeconds,
      mobileNetwork: config.mobileNetworkCacheTtlSeconds,
      mobileCoverage: config.mobileCoverageCacheTtlSeconds,
      osmPostgis: config.osmPostgisCacheTtlSeconds,
      osmOverpass: config.overpassCacheTtlSeconds,
      ctuStationaryMobile: config.ctuStationaryMobileCacheTtlSeconds,
      idsjmkVehiclePositions: config.idsjmkVehiclePositionsCacheTtlSeconds,
      roadSrtiLod: config.roadSrtiLodCacheTtlSeconds,
      safetyData: config.safetyDataCacheTtlSeconds,
      aviationWeather: config.aviationWeatherCacheTtlSeconds,
      chmiAirQuality: config.chmiAirQualityCacheTtlSeconds,
      chmiWeatherStations: config.chmiWeatherCacheTtlSeconds,
      chmiWeatherRadar: config.chmiWeatherRadarCacheTtlSeconds,
      chmiWeatherWebcams: config.chmiWeatherWebcamsCacheTtlSeconds,
      ardosPartner: config.ardosPartnerCacheTtlSeconds
    },
    weatherRadarFrames: {
      historyHours: config.chmiWeatherRadarFrameHistoryHours,
      maxCount: config.chmiWeatherRadarFrameMaxCount,
      storeEnabled: config.chmiWeatherRadarFrameStoreEnabled,
      mode: config.chmiWeatherRadarFrameStoreEnabled ? "local_filesystem" : "metadata_only",
      cleanCropInsetPixels: config.chmiWeatherRadarCleanCropInsetPixels
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
      { sourceId: "ctu_stationary_mobile", baseUrl: "https://ctu.gov.cz", authConfigured: config.ctuStationaryMobileUrls.length > 0 },
      { sourceId: "pid_gtfs_rt", baseUrl: config.pidGtfsRtVehiclePositionsUrl, authConfigured: true },
      { sourceId: "idsjmk_vehicle_positions", baseUrl: config.idsjmkVehiclePositionsUrl, authConfigured: true },
      { sourceId: "road_srti_lod", baseUrl: config.roadSrtiLodSparqlUrl, authConfigured: true },
      { sourceId: "safety_data", baseUrl: config.safetyDataBaseUrl, authConfigured: true },
      { sourceId: "aviation_weather", baseUrl: config.aviationWeatherBaseUrl, authConfigured: true },
      { sourceId: "chmi_air_quality", baseUrl: config.chmiAirQualityDataUrl, authConfigured: true, backend: "chmi-opendata" },
      { sourceId: "chmi_weather_stations", baseUrl: config.chmiWeatherDataBaseUrl, authConfigured: true, backend: "chmi-opendata" },
      { sourceId: "chmi_weather_radar", baseUrl: config.chmiWeatherRadarBaseUrl, authConfigured: true, backend: "chmi-opendata" },
      { sourceId: "chmi_weather_webcams", baseUrl: config.chmiWeatherWebcamsMapUrl, authConfigured: true, backend: "chmi-data-provider" },
      { sourceId: "ardos_partner", baseUrl: config.ardosPartnerBaseUrl, authConfigured: Boolean(config.ardosPartnerBaseUrl && config.ardosPartnerToken) }
    ]
  };
}

function parseOptionalBbox(value: unknown): { ok: true; value?: BoundingBox } | { ok: false; error: string } {
  const raw = asString(value);
  if (!raw) {
    return { ok: true, value: undefined };
  }
  return parseBbox(raw, { west: -180, south: -90, east: 180, north: 90 });
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
    if (typeof status.boundaryFeatureCount === "number") {
      lines.push(`situation_data_boundary_read_model_features{backend="${backend}"} ${status.boundaryFeatureCount}`);
    }
    if (status.lastImportAt) {
      lines.push(`situation_data_osm_postgis_last_import_timestamp_seconds{backend="${backend}"} ${Math.round(Date.parse(status.lastImportAt) / 1000)}`);
    }
    if (typeof status.lastImportAgeSeconds === "number") {
      lines.push(`situation_data_osm_postgis_import_age_seconds{backend="${backend}"} ${status.lastImportAgeSeconds}`);
    }
    if (status.boundaryLastImportAt) {
      lines.push(
        `situation_data_boundary_read_model_last_import_timestamp_seconds{backend="${backend}"} ${Math.round(Date.parse(status.boundaryLastImportAt) / 1000)}`
      );
    }
    if (typeof status.boundaryLastImportAgeSeconds === "number") {
      lines.push(`situation_data_boundary_read_model_import_age_seconds{backend="${backend}"} ${status.boundaryLastImportAgeSeconds}`);
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
  if (status.sourceId === "ctu_stationary_mobile") {
    lines.push(`situation_data_ctu_stationary_mobile_backend_info{backend="${backend}"} 1`);
    if (typeof status.objectCount === "number") {
      lines.push(`situation_data_ctu_stationary_mobile_measurements{backend="${backend}"} ${status.objectCount}`);
    }
    if (status.lastImportAt) {
      lines.push(`situation_data_ctu_stationary_mobile_latest_measurement_timestamp_seconds{backend="${backend}"} ${Math.round(Date.parse(status.lastImportAt) / 1000)}`);
    }
    if (typeof status.lastImportAgeSeconds === "number") {
      lines.push(`situation_data_ctu_stationary_mobile_latest_measurement_age_seconds{backend="${backend}"} ${status.lastImportAgeSeconds}`);
    }
  }
  if (status.sourceId === "chmi_air_quality") {
    lines.push(`situation_data_chmi_air_quality_backend_info{backend="${backend}"} 1`);
    if (typeof status.objectCount === "number") {
      lines.push(`situation_data_chmi_air_quality_stations{backend="${backend}"} ${status.objectCount}`);
    }
    if (status.lastImportAt) {
      lines.push(`situation_data_chmi_air_quality_latest_observation_timestamp_seconds{backend="${backend}"} ${Math.round(Date.parse(status.lastImportAt) / 1000)}`);
    }
    if (typeof status.lastImportAgeSeconds === "number") {
      lines.push(`situation_data_chmi_air_quality_latest_observation_age_seconds{backend="${backend}"} ${status.lastImportAgeSeconds}`);
    }
  }
  if (status.sourceId === "chmi_weather_stations") {
    lines.push(`situation_data_chmi_weather_stations_backend_info{backend="${backend}"} 1`);
    if (typeof status.objectCount === "number") {
      lines.push(`situation_data_chmi_weather_stations{backend="${backend}"} ${status.objectCount}`);
    }
    if (status.lastImportAt) {
      lines.push(`situation_data_chmi_weather_latest_observation_timestamp_seconds{backend="${backend}"} ${Math.round(Date.parse(status.lastImportAt) / 1000)}`);
    }
    if (typeof status.lastImportAgeSeconds === "number") {
      lines.push(`situation_data_chmi_weather_latest_observation_age_seconds{backend="${backend}"} ${status.lastImportAgeSeconds}`);
    }
  }
  if (status.sourceId === "chmi_weather_radar") {
    lines.push(`situation_data_chmi_weather_radar_backend_info{backend="${backend}"} 1`);
    if (typeof status.objectCount === "number") {
      lines.push(`situation_data_chmi_weather_radar_products{backend="${backend}"} ${status.objectCount}`);
    }
    if (status.lastImportAt) {
      lines.push(`situation_data_chmi_weather_radar_latest_timestamp_seconds{backend="${backend}"} ${Math.round(Date.parse(status.lastImportAt) / 1000)}`);
    }
    if (typeof status.lastImportAgeSeconds === "number") {
      lines.push(`situation_data_chmi_weather_radar_latest_age_seconds{backend="${backend}"} ${status.lastImportAgeSeconds}`);
    }
  }
  return lines;
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
    state: isAfterIso(stats.lastErrorAt, stats.lastSuccessAt) ? "degraded" : pressure > 0.95 ? "pressure" : requestCount > 0 ? "warm" : "cold"
  };
  if (stats.lastSuccessAt) {
    telemetry.lastSuccessAt = stats.lastSuccessAt;
  }
  if (stats.lastErrorAt) {
    telemetry.lastErrorAt = stats.lastErrorAt;
  }
  return telemetry;
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

function sourceFreshness(sourceHealth: SourceHealthStatus[]): Record<string, number> {
  const ages = sourceHealth.map((source) => source.lastImportAgeSeconds).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    sourceCount: sourceHealth.length,
    sourcesWithImportAge: ages.length,
    newestImportAgeSeconds: ages.length > 0 ? Math.min(...ages) : -1,
    oldestImportAgeSeconds: ages.length > 0 ? Math.max(...ages) : -1,
    degradedSourceCount: sourceHealth.filter((source) => source.status === "degraded").length,
    warningCount: sourceHealth.reduce((sum, source) => sum + source.warnings.length, 0)
  };
}

function environmentGridTelemetry(config: SituationDataConfig, sourceHealth: SourceHealthStatus[]): Record<string, unknown> {
  const weather = sourceHealth.find((source) => source.sourceId === "chmi_weather_stations");
  const airQuality = sourceHealth.find((source) => source.sourceId === "chmi_air_quality");
  const radar = sourceHealth.find((source) => source.sourceId === "chmi_weather_radar");
  const weatherReady = config.enabledSources.includes("chmi_weather_stations") && weather?.status === "ok";
  const airQualityReady = config.enabledSources.includes("chmi_air_quality") && airQuality?.status === "ok";
  const radarReady = config.enabledSources.includes("chmi_weather_radar") && radar?.status === "ok";
  const enabledLayers = [
    "public.weather.temperature_grid",
    "public.weather.wind_field",
    "public.weather.precipitation_grid",
    "public.weather.humidity_grid",
    "public.weather.pressure_grid",
    "public.weather.radar_reflectivity",
    "public.weather.radar_precipitation",
    "public.weather.radar_nowcast",
    "public.safety.thunderstorm_risk",
    "public.safety.air_quality_grid"
  ];
  return {
    status: weatherReady || airQualityReady || radarReady ? "cataloged" : "degraded",
    enabledLayers,
    sourceIds: ["chmi_weather_stations", "chmi_weather_radar", "chmi_air_quality"],
    stableGrid: {
      alignment: "wgs84",
      resolutionDegrees: config.openMeteoGridDegrees
    },
    cacheTtlSeconds: {
      weather: config.chmiWeatherCacheTtlSeconds,
      radar: config.chmiWeatherRadarCacheTtlSeconds,
      airQuality: config.chmiAirQualityCacheTtlSeconds
    },
    readModel: {
      mode: "catalog_only",
      tileCount: 0,
      cellCount: 0
    },
    radarFrames: {
      endpoint: "/api/v1/weather-radar/frames",
      historyHours: config.chmiWeatherRadarFrameHistoryHours,
      maxCount: config.chmiWeatherRadarFrameMaxCount,
      storeEnabled: config.chmiWeatherRadarFrameStoreEnabled,
      mode: config.chmiWeatherRadarFrameStoreEnabled ? "local_filesystem" : "metadata_only",
      cleanCropInsetPixels: config.chmiWeatherRadarCleanCropInsetPixels
    },
    upstreamStatus: {
      weather: weather?.status ?? "not_enabled",
      radar: radar?.status ?? "not_enabled",
      airQuality: airQuality?.status ?? "not_enabled"
    },
    warnings:
      weatherReady || airQualityReady || radarReady
        ? ["Weather grid and radar overlay layers are cataloged. SIM provides clean cropped radar PNG frames; tiled radar delivery remains a future optimization."]
        : ["Environment grid sources are not healthy or not enabled."]
  };
}

function boundaryReadModelTelemetry(config: SituationDataConfig, sourceHealth: SourceHealthStatus[]): Record<string, unknown> {
  const osm = sourceHealth.find((source) => source.sourceId === "osm_postgis");
  return {
    status: osm?.boundaryFeatureCount && osm.boundaryFeatureCount > 0 ? "ok" : config.osmPostgisConnectionString ? "degraded" : "unconfigured",
    backend: config.osmPostgisBackend,
    table: config.osmPostgisAdminBoundaryTable,
    featureCount: osm?.boundaryFeatureCount ?? 0,
    adminLevels: osm?.boundaryLevels ?? [],
    lastImportAt: osm?.boundaryLastImportAt,
    lastImportAgeSeconds: osm?.boundaryLastImportAgeSeconds,
    cacheTtlSeconds: config.osmPostgisCacheTtlSeconds,
    layers: ["public.boundary.country", "public.boundary.region", "public.boundary.district", "public.boundary.orp", "public.place.settlements"],
    warnings:
      osm?.boundaryFeatureCount && osm.boundaryFeatureCount > 0
        ? []
        : [`Boundary read model requires ${config.osmPostgisAdminBoundaryTable} from scripts/import-osm-cz-postgis.sh.`]
  };
}

function ratio(value: number, total: number): number {
  return total > 0 ? Number((value / total).toFixed(4)) : 0;
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
