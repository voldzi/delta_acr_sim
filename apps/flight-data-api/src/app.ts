import { createHttpRequestTracingMiddleware } from "@csm-sim/observability";
import cors, { type CorsOptions } from "cors";
import express, { type Express } from "express";
import { AirspaceActivationService } from "./airspace-activation.js";
import { AirspaceReferenceService } from "./airspace-reference.js";
import type { FlightDataConfig } from "./config.js";
import { FlightAggregationService } from "./aggregation.js";
import { buildFlightMapCatalog } from "./catalog.js";
import { problem } from "./http.js";
import { getAircraftType, ReferenceDataService, searchAircraftTypes } from "./reference-data.js";
import { allSourceDescriptors, createFlightDataSources } from "./sources.js";
import type { BoundingBox, FlightDataPublicConfig, FlightDataSourceId, FlightQuery } from "./types.js";
import { UasGeozoneService } from "./uas-geozones.js";

export interface FlightDataAppContext {
  config: FlightDataConfig;
  aggregation: FlightAggregationService;
  referenceData: ReferenceDataService;
  airspaces: AirspaceReferenceService;
  uasGeozones: UasGeozoneService;
  airspaceActivations: AirspaceActivationService;
}

export async function createApp(config: FlightDataConfig): Promise<{ app: Express; context: FlightDataAppContext }> {
  const sources = createFlightDataSources(config);
  const aggregation = new FlightAggregationService(config, sources);
  const referenceData = new ReferenceDataService(config);
  const airspaces = new AirspaceReferenceService(config);
  const uasGeozones = new UasGeozoneService(config);
  const airspaceActivations = new AirspaceActivationService(config, uasGeozones);
  const context: FlightDataAppContext = { config, aggregation, referenceData, airspaces, uasGeozones, airspaceActivations };
  const app = express();

  app.use(createHttpRequestTracingMiddleware("csm-sim-flight-data-api"));
  app.use(cors(createCorsOptions(config.corsOrigins)));
  app.use(express.json({ limit: "1mb" }));

  registerHealthRoutes(app, context);
  registerSourceRoutes(app, context);
  registerFlightRoutes(app, context);
  registerReferenceRoutes(app, context);

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

function registerHealthRoutes(app: Express, context: FlightDataAppContext): void {
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
    const airspaceCache = context.airspaces.cacheStats();
    const uasGeozoneCache = context.uasGeozones.cacheStats();
    const airspaceActivationCache = context.airspaceActivations.cacheStats();
    const sourceCacheLines = context.aggregation.sourceCacheStats().flatMap((sourceCache) => [
      `flight_data_source_cache_entries{source="${sourceCache.sourceId}"} ${sourceCache.entries}`,
      `flight_data_source_cache_inflight{source="${sourceCache.sourceId}"} ${sourceCache.inflight}`,
      `flight_data_source_cache_hits{source="${sourceCache.sourceId}"} ${sourceCache.hits}`,
      `flight_data_source_cache_misses{source="${sourceCache.sourceId}"} ${sourceCache.misses}`,
      `flight_data_source_cache_coalesced_hits{source="${sourceCache.sourceId}"} ${sourceCache.coalescedHits}`,
      `flight_data_source_cache_stale_hits{source="${sourceCache.sourceId}"} ${sourceCache.staleHits}`,
      `flight_data_source_cache_refreshes{source="${sourceCache.sourceId}"} ${sourceCache.refreshes}`,
      `flight_data_source_cache_errors{source="${sourceCache.sourceId}"} ${sourceCache.errors}`,
      `flight_data_source_cache_evictions{source="${sourceCache.sourceId}"} ${sourceCache.evictions}`
    ]);
    res
      .type("text/plain")
      .send(
        [
          `flight_data_enabled_sources ${context.config.enabledSources.length}`,
          `flight_data_cache_entries ${cache.entries}`,
          `flight_data_cache_inflight ${cache.inflight}`,
          `flight_data_cache_hits ${cache.hits}`,
          `flight_data_cache_misses ${cache.misses}`,
          `flight_data_cache_coalesced_hits ${cache.coalescedHits}`,
          `flight_data_cache_stale_hits ${cache.staleHits}`,
          `flight_data_cache_refreshes ${cache.refreshes}`,
          `flight_data_cache_errors ${cache.errors}`,
          `flight_data_cache_evictions ${cache.evictions}`,
          `flight_data_reference_cache_entries{source="czech_aip_airspaces"} ${airspaceCache.entries}`,
          `flight_data_reference_cache_inflight{source="czech_aip_airspaces"} ${airspaceCache.inflight}`,
          `flight_data_reference_cache_hits{source="czech_aip_airspaces"} ${airspaceCache.hits}`,
          `flight_data_reference_cache_misses{source="czech_aip_airspaces"} ${airspaceCache.misses}`,
          `flight_data_reference_cache_stale_hits{source="czech_aip_airspaces"} ${airspaceCache.staleHits}`,
          `flight_data_reference_cache_errors{source="czech_aip_airspaces"} ${airspaceCache.errors}`,
          `flight_data_reference_cache_entries{source="czech_uas_geozones"} ${uasGeozoneCache.entries}`,
          `flight_data_reference_cache_hits{source="czech_uas_geozones"} ${uasGeozoneCache.hits}`,
          `flight_data_reference_cache_misses{source="czech_uas_geozones"} ${uasGeozoneCache.misses}`,
          `flight_data_reference_cache_stale_hits{source="czech_uas_geozones"} ${uasGeozoneCache.staleHits}`,
          `flight_data_reference_cache_errors{source="czech_uas_geozones"} ${uasGeozoneCache.errors}`,
          `flight_data_reference_cache_entries{source="czech_aup_uup"} ${airspaceActivationCache.entries}`,
          `flight_data_reference_cache_hits{source="czech_aup_uup"} ${airspaceActivationCache.hits}`,
          `flight_data_reference_cache_misses{source="czech_aup_uup"} ${airspaceActivationCache.misses}`,
          `flight_data_reference_cache_stale_hits{source="czech_aup_uup"} ${airspaceActivationCache.staleHits}`,
          `flight_data_reference_cache_errors{source="czech_aup_uup"} ${airspaceActivationCache.errors}`,
          ...sourceCacheLines
        ].join("\n") + "\n"
      );
  });
}

function registerSourceRoutes(app: Express, context: FlightDataAppContext): void {
  app.get("/api/v1/sources", (_req, res) => {
    res.json({ items: allSourceDescriptors(context.config) });
  });

  app.get("/api/v1/catalog", (_req, res) => {
    res.json(buildFlightMapCatalog(context.config));
  });

  app.get("/api/v1/observability", (_req, res) => {
    const cache = context.aggregation.cacheStats();
    const referenceCaches = [
      { sourceId: "czech_aip_airspaces", cache: context.airspaces.cacheStats() },
      { sourceId: "czech_uas_geozones", cache: context.uasGeozones.cacheStats() },
      { sourceId: "czech_aup_uup", cache: context.airspaceActivations.cacheStats() }
    ];
    res.json({
      serviceId: "flight-data-api",
      generatedAt: new Date().toISOString(),
      status: "ok",
      cache: cacheTelemetry(cache, context.config.cacheMaxEntries),
      sourceCaches: context.aggregation.sourceCacheStats().map((sourceCache) => ({
        sourceId: sourceCache.sourceId,
        cache: cacheTelemetry(sourceCache, context.config.cacheMaxEntries)
      })),
      referenceCaches: referenceCaches.map((referenceCache) => ({
        sourceId: referenceCache.sourceId,
        cache: cacheTelemetry(referenceCache.cache, context.config.cacheMaxEntries)
      })),
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

function registerFlightRoutes(app: Express, context: FlightDataAppContext): void {
  app.get("/api/v1/aircraft/positions", async (req, res) => {
    const query = parseFlightQuery(req.query, context.config.enabledSources);
    if (!query.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", query.error);
    }
    try {
      res.json(await context.aggregation.getTracks(query.value));
    } catch (error) {
      problem(req, res, 502, "SOURCE_UNAVAILABLE", error instanceof Error ? error.message : "Unable to fetch flight data.");
    }
  });

  app.get("/api/v1/cop/tracks", async (req, res) => {
    res.set(compatibilityAliasHeaders("/api/v1/aircraft/positions"));
    const query = parseFlightQuery(req.query, context.config.enabledSources);
    if (!query.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", query.error);
    }
    try {
      const response = await context.aggregation.getTracks(query.value);
      res.json({
        contractVersion: "cop-flight-source-v1",
        source: {
          sourceId: "flight-data-api",
          sourceType: "PUBLIC_FLIGHT_AGGREGATE",
          generatedAt: response.generatedAt
        },
        summary: response.summary,
        tracks: response.tracks,
        sources: response.sources,
        warnings: response.warnings
      });
    } catch (error) {
      problem(req, res, 502, "SOURCE_UNAVAILABLE", error instanceof Error ? error.message : "Unable to fetch flight data.");
    }
  });
}

function compatibilityAliasHeaders(successorPath: string): Record<string, string> {
  return {
    Deprecation: "true",
    Link: `<${successorPath}>; rel="successor-version"`,
    Warning: '299 - "Compatibility alias; use the source-neutral provider endpoint for new integrations."'
  };
}

function registerReferenceRoutes(app: Express, context: FlightDataAppContext): void {
  app.get("/api/v1/airports", async (req, res) => {
    const bbox = parseBbox(req.query.bbox);
    if (!bbox.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", bbox.error);
    }
    const limit = parseLimit(req.query.limit, 50, 500);
    const referenceMetadata = await context.referenceData.metadata();
    res.json({
      items: await context.referenceData.searchAirports(asString(req.query.query ?? req.query.q), bbox.value, limit),
      source: {
        label: referenceMetadata.airportSource === "ourairports:airports.csv" ? "OurAirports airport reference data" : "Airport reference seed fallback",
        license: "OurAirports public domain data where imported; embedded seed is public-domain compatible.",
        loadedAt: referenceMetadata.loadedAt,
        warnings: referenceMetadata.warnings
      },
      summary: {
        totalReferenceAirports: referenceMetadata.airportCount
      }
    });
  });

  app.get("/api/v1/airports/:ident", async (req, res) => {
    const airport = await context.referenceData.getAirport(req.params.ident);
    if (!airport) {
      return problem(req, res, 404, "NOT_FOUND", "Airport not found.");
    }
    res.json(airport);
  });

  app.get("/api/v1/aircraft-types", (req, res) => {
    const limit = parseLimit(req.query.limit, 50, 500);
    res.json({
      items: searchAircraftTypes(asString(req.query.query ?? req.query.q), limit),
      source: {
        label: "Aircraft type reference subset",
        license: "Seed data uses ICAO Doc 8643 compatible fields; production target is licensed ICAO API or approved ODbL source."
      }
    });
  });

  app.get("/api/v1/aircraft-types/:designator", (req, res) => {
    const aircraftType = getAircraftType(req.params.designator);
    if (!aircraftType) {
      return problem(req, res, 404, "NOT_FOUND", "Aircraft type not found.");
    }
    res.json(aircraftType);
  });

  app.get("/api/v1/airspaces", async (req, res) => {
    const bbox = parseBbox(req.query.bbox);
    if (!bbox.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", bbox.error);
    }
    const types = parseAirspaceTypes(req.query.type ?? req.query.types);
    if (!types.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", types.error);
    }
    const limit = parseLimit(req.query.limit, 250, 1000);
    res.json(
      await context.airspaces.getFeatureCollection({
        bbox: bbox.value,
        types: types.value,
        limit
      })
    );
  });

  app.get("/api/v1/uas-geozones", async (req, res) => {
    const bbox = parseBbox(req.query.bbox);
    if (!bbox.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", bbox.error);
    }
    const layerIds = parseLayerIds(req.query.layer ?? req.query.layers ?? req.query.publication ?? req.query.publications);
    const limit = parseLimit(req.query.limit, 250, 1000);
    res.json(
      await context.uasGeozones.getFeatureCollection({
        bbox: bbox.value,
        layerIds,
        limit
      })
    );
  });

  app.get("/api/v1/airspace-activations", async (req, res) => {
    const bbox = parseBbox(req.query.bbox);
    if (!bbox.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", bbox.error);
    }
    const limit = parseLimit(req.query.limit, 250, 1000);
    res.json(
      await context.airspaceActivations.getFeatureCollection({
        bbox: bbox.value,
        limit,
        includeCancelled: parseBoolean(req.query.includeCancelled)
      })
    );
  });
}

function parseFlightQuery(raw: Record<string, unknown>, defaultSources: FlightDataSourceId[]): { ok: true; value: FlightQuery } | { ok: false; error: string } {
  const bbox = parseBbox(raw.bbox);
  if (!bbox.ok) {
    return { ok: false, error: bbox.error };
  }
  const sources = parseSources(raw.source ?? raw.sources, defaultSources);
  if (sources.length === 0) {
    return { ok: false, error: "No valid flight data sources requested." };
  }
  return {
    ok: true,
    value: {
      bbox: bbox.value,
      limit: parseLimit(raw.limit, 250, 1000),
      sourceIds: sources,
      includeStale: parseBoolean(raw.includeStale)
    }
  };
}

function parseBbox(value: unknown): { ok: true; value?: BoundingBox } | { ok: false; error: string } {
  const raw = asString(value);
  if (!raw) {
    return { ok: true, value: undefined };
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

function parseSources(value: unknown, fallback: FlightDataSourceId[]): FlightDataSourceId[] {
  const allowed = new Set<FlightDataSourceId>(["mock", "adsb_lol", "opensky", "local_adsb"]);
  const raw = asString(value);
  if (!raw) {
    return fallback;
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is FlightDataSourceId => allowed.has(item as FlightDataSourceId));
}

function parseAirspaceTypes(value: unknown): { ok: true; value?: Array<"prohibited" | "restricted" | "danger" | "temporary_reserved" | "temporary_segregated" | "other"> } | { ok: false; error: string } {
  const raw = asString(value);
  if (!raw) {
    return { ok: true, value: undefined };
  }
  const allowed = new Set(["prohibited", "restricted", "danger", "temporary_reserved", "temporary_segregated", "other"]);
  const parsed = raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const invalid = parsed.filter((item) => !allowed.has(item));
  if (invalid.length > 0) {
    return { ok: false, error: `Unsupported airspace type: ${invalid.join(", ")}.` };
  }
  return {
    ok: true,
    value: parsed as Array<"prohibited" | "restricted" | "danger" | "temporary_reserved" | "temporary_segregated" | "other">
  };
}

function parseLayerIds(value: unknown): string[] | undefined {
  const raw = asString(value);
  if (!raw) {
    return undefined;
  }
  const parsed = raw
    .split(",")
    .map((item) => item.trim().toUpperCase())
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

function publicConfig(config: FlightDataConfig): FlightDataPublicConfig {
  return {
    enabledSources: config.enabledSources,
    defaultArea: {
      lat: config.defaultLat,
      lon: config.defaultLon,
      radiusNm: config.defaultRadiusNm
    },
    cacheTtlSeconds: config.cacheTtlSeconds,
    bboxCacheGridDegrees: config.bboxCacheGridDegrees,
    bboxCachePaddingDegrees: config.bboxCachePaddingDegrees,
    staleIfErrorSeconds: config.staleIfErrorSeconds,
    cacheMaxEntries: config.cacheMaxEntries,
    staleAfterSeconds: config.staleAfterSeconds,
    requestTimeoutMs: config.requestTimeoutMs,
    providers: [
      { sourceId: "mock", authConfigured: true },
      { sourceId: "adsb_lol", baseUrl: config.adsbLolBaseUrl, authConfigured: true },
      {
        sourceId: "opensky",
        baseUrl: config.openskyBaseUrl,
        authConfigured: Boolean(config.openskyAccessToken || (config.openskyClientId && config.openskyClientSecret))
      },
      {
        sourceId: "local_adsb",
        baseUrl: config.localAdsbAircraftJsonUrls.length === 1 ? config.localAdsbAircraftJsonUrls[0] : undefined,
        authConfigured: config.localAdsbAircraftJsonUrls.length > 0
      }
    ],
    referenceData: {
      ourAirportsEnabled: config.ourAirportsEnabled,
      ourAirportsCountries: config.ourAirportsCountries,
      ourAirportsCacheTtlSeconds: config.ourAirportsCacheTtlSeconds,
      aipAirspacesEnabled: config.aipAirspacesEnabled,
      aipAirspacesCacheTtlSeconds: config.aipAirspacesCacheTtlSeconds,
      aipAirspacesSourceUrl: config.aipAirspacesSourceUrl,
      uasGeozonesEnabled: config.uasGeozonesEnabled,
      uasGeozonesLayerIds: config.uasGeozonesLayerIds,
      uasGeozonesCacheTtlSeconds: config.uasGeozonesCacheTtlSeconds,
      uasGeozonesCatalogUrl: config.uasGeozonesCatalogUrl,
      airspaceActivationEnabled: config.airspaceActivationEnabled,
      airspaceActivationCacheTtlSeconds: config.airspaceActivationCacheTtlSeconds,
      airspaceActivationBaseUrl: config.airspaceActivationBaseUrl
    }
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

function ratio(value: number, total: number): number {
  return total > 0 ? Number((value / total).toFixed(4)) : 0;
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
