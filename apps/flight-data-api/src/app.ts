import cors from "cors";
import express, { type Express } from "express";
import type { FlightDataConfig } from "./config.js";
import { FlightAggregationService } from "./aggregation.js";
import { problem } from "./http.js";
import { getAircraftType, ReferenceDataService, searchAircraftTypes } from "./reference-data.js";
import { allSourceDescriptors, createFlightDataSources } from "./sources.js";
import type { BoundingBox, FlightDataPublicConfig, FlightDataSourceId, FlightQuery } from "./types.js";

export interface FlightDataAppContext {
  config: FlightDataConfig;
  aggregation: FlightAggregationService;
  referenceData: ReferenceDataService;
}

export async function createApp(config: FlightDataConfig): Promise<{ app: Express; context: FlightDataAppContext }> {
  const sources = createFlightDataSources(config);
  const aggregation = new FlightAggregationService(config, sources);
  const referenceData = new ReferenceDataService(config);
  const context: FlightDataAppContext = { config, aggregation, referenceData };
  const app = express();

  app.use(cors());
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
          ...sourceCacheLines
        ].join("\n") + "\n"
      );
  });
}

function registerSourceRoutes(app: Express, context: FlightDataAppContext): void {
  app.get("/api/v1/sources", (_req, res) => {
    res.json({ items: allSourceDescriptors(context.config) });
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
      ourAirportsCacheTtlSeconds: config.ourAirportsCacheTtlSeconds
    }
  };
}
