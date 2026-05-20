import cors from "cors";
import express, { type Express } from "express";
import { SituationAggregationService } from "./aggregation.js";
import type { SituationDataConfig } from "./config.js";
import { problem } from "./http.js";
import { LAYERS } from "./layers.js";
import { allSourceDescriptors, createSituationDataSources } from "./sources.js";
import type { BoundingBox, SituationDataPublicConfig, SituationDataSourceId, SituationLayerId, SituationQuery } from "./types.js";

export interface SituationDataAppContext {
  config: SituationDataConfig;
  aggregation: SituationAggregationService;
}

export async function createApp(config: SituationDataConfig): Promise<{ app: Express; context: SituationDataAppContext }> {
  const sources = createSituationDataSources(config);
  const aggregation = new SituationAggregationService(config, sources);
  const context: SituationDataAppContext = { config, aggregation };
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

  app.get("/health/ready", (_req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      enabledSources: context.config.enabledSources
    });
  });

  app.get("/metrics", (_req, res) => {
    res.type("text/plain").send([`situation_data_enabled_sources ${context.config.enabledSources.length}`].join("\n") + "\n");
  });
}

function registerMetadataRoutes(app: Express, context: SituationDataAppContext): void {
  app.get("/api/v1/layers", (_req, res) => {
    res.json({ items: LAYERS });
  });

  app.get("/api/v1/sources", (_req, res) => {
    res.json({ items: allSourceDescriptors(context.config) });
  });

  app.get("/api/v1/config", (_req, res) => {
    res.json(publicConfig(context.config));
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
    const query = parseSituationQuery(req.query, context.config);
    if (!query.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", query.error);
    }
    res.json(await context.aggregation.getFeatures(query.value));
  });
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

function parseLayers(value: unknown): SituationLayerId[] {
  const allowed = new Set<SituationLayerId>(["weather", "ground", "mobile", "traffic"]);
  const raw = asString(value);
  if (!raw) {
    return ["weather", "ground", "mobile", "traffic"];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is SituationLayerId => allowed.has(item as SituationLayerId));
}

function parseSources(value: unknown, fallback: SituationDataSourceId[]): SituationDataSourceId[] {
  const allowed = new Set<SituationDataSourceId>(["mock", "open_meteo", "osm_overpass"]);
  const raw = asString(value);
  if (!raw) {
    return fallback;
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is SituationDataSourceId => allowed.has(item as SituationDataSourceId));
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
    staleAfterSeconds: config.staleAfterSeconds,
    requestTimeoutMs: config.requestTimeoutMs,
    providers: [
      { sourceId: "mock", authConfigured: true },
      { sourceId: "open_meteo", baseUrl: config.openMeteoBaseUrl, authConfigured: true },
      { sourceId: "osm_overpass", baseUrl: config.overpassBaseUrl, authConfigured: true }
    ]
  };
}
