import { createHttpRequestTracingMiddleware } from "@csm-sim/observability";
import cors, { type CorsOptions } from "cors";
import express, { type Express, type Request } from "express";
import { buildTakMapCatalog } from "./catalog.js";
import type { TakGatewayConfig } from "./config.js";
import { parseCotXml } from "./cot.js";
import { problem } from "./http.js";
import { LAYERS } from "./layers.js";
import { takSourceDescriptor } from "./sources.js";
import { TakEventStore } from "./store.js";
import type { BoundingBox, TakGatewayPublicConfig, TakLayerId, TakQuery } from "./types.js";

export interface TakGatewayAppContext {
  config: TakGatewayConfig;
  store: TakEventStore;
}

export async function createApp(config: TakGatewayConfig): Promise<{ app: Express; context: TakGatewayAppContext }> {
  const store = new TakEventStore(config);
  const context: TakGatewayAppContext = { config, store };
  const app = express();

  app.use(createHttpRequestTracingMiddleware("csm-sim-tak-gateway-api"));
  app.use(cors(createCorsOptions(config.corsOrigins)));
  app.use(express.json({ limit: "1mb" }));

  registerHealthRoutes(app, context);
  registerMetadataRoutes(app, context);
  registerIngestRoutes(app, context);
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

function registerHealthRoutes(app: Express, context: TakGatewayAppContext): void {
  app.get("/health/live", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/health/ready", (_req, res) => {
    const stats = context.store.getStats();
    const ready = isOperationallyReady(context.config);
    res.json({
      status: ready ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      ingestAuthConfigured: Boolean(context.config.ingestToken),
      readAuthConfigured: Boolean(context.config.readToken),
      publicRead: context.config.publicRead,
      currentEvents: stats.currentEvents,
      staleEvents: stats.staleEvents,
      lastIngestAt: stats.lastIngestAt
    });
  });

  app.get("/metrics", (_req, res) => {
    const stats = context.store.getStats();
    res
      .type("text/plain")
      .send(
        [
          `tak_gateway_current_events ${stats.currentEvents}`,
          `tak_gateway_stale_events ${stats.staleEvents}`,
          `tak_gateway_accepted_events_total ${stats.acceptedEvents}`,
          `tak_gateway_invalid_events_total ${stats.invalidEvents}`,
          `tak_gateway_dropped_events_total ${stats.droppedEvents}`,
          `tak_gateway_auth_failures_total ${stats.authFailures}`,
          `tak_gateway_parse_errors_total ${stats.parseErrors}`,
          `tak_gateway_ingest_auth_configured ${context.config.ingestToken ? 1 : 0}`,
          `tak_gateway_read_auth_configured ${context.config.readToken ? 1 : 0}`,
          `tak_gateway_public_read_enabled ${context.config.publicRead ? 1 : 0}`
        ].join("\n") + "\n"
      );
  });
}

function registerMetadataRoutes(app: Express, context: TakGatewayAppContext): void {
  app.get("/api/v1/layers", (_req, res) => {
    res.json({ items: LAYERS });
  });

  app.get("/api/v1/sources", (_req, res) => {
    res.json({ items: [takSourceDescriptor(context.config)] });
  });

  app.get("/api/v1/catalog", (_req, res) => {
    res.json(buildTakMapCatalog(context.config));
  });

  app.get("/api/v1/observability", (_req, res) => {
    const stats = context.store.getStats();
    res.json({
      serviceId: "tak-gateway-api",
      generatedAt: new Date().toISOString(),
      status: isOperationallyReady(context.config) ? "ok" : "degraded",
      eventStore: {
        currentEvents: stats.currentEvents,
        staleEvents: stats.staleEvents,
        acceptedEvents: stats.acceptedEvents,
        invalidEvents: stats.invalidEvents,
        droppedEvents: stats.droppedEvents,
        authFailures: stats.authFailures,
        parseErrors: stats.parseErrors,
        lastIngestAt: stats.lastIngestAt,
        lastErrorAt: stats.lastErrorAt,
        staleRate: ratio(stats.staleEvents, Math.max(1, stats.currentEvents + stats.staleEvents)),
        errorCount: stats.invalidEvents + stats.droppedEvents + stats.authFailures + stats.parseErrors
      },
      dataFreshness: {
        sourceCount: 1,
        sourcesWithImportAge: stats.lastIngestAt ? 1 : 0,
        newestImportAgeSeconds: stats.lastIngestAt ? secondsSince(stats.lastIngestAt) : -1,
        oldestImportAgeSeconds: stats.lastIngestAt ? secondsSince(stats.lastIngestAt) : -1,
        degradedSourceCount: isOperationallyReady(context.config) ? 0 : 1,
        warningCount: context.config.publicRead ? 1 : 0
      }
    });
  });

  app.get("/api/v1/config", (_req, res) => {
    res.json(publicConfig(context.config));
  });

  app.get("/api/v1/events", (req, res) => {
    if (!isDebugAuthorized(req, context)) {
      context.store.recordAuthFailure();
      return problem(req, res, 401, "UNAUTHORIZED", "Missing or invalid bearer token.");
    }
    const includeRaw = parseBoolean(req.query.includeRaw) && context.config.exposeRaw;
    res.json({
      items: context.store.listEvents(includeRaw),
      totalCount: context.store.getStats().currentEvents
    });
  });
}

function registerIngestRoutes(app: Express, context: TakGatewayAppContext): void {
  const textBody = express.text({ type: ["application/xml", "text/xml", "text/plain", "application/octet-stream", "*/*"], limit: "1mb" });

  app.post("/api/v1/cot/events", textBody, (req, res) => {
    if (!isAuthorized(req, context)) {
      context.store.recordAuthFailure();
      return problem(req, res, 401, "UNAUTHORIZED", "Missing or invalid bearer token.");
    }

    const xml = typeof req.body === "string" ? req.body : "";
    const parsed = parseCotXml(xml);
    if (parsed.events.length === 0) {
      context.store.recordParseError();
      return problem(req, res, 400, "INVALID_COT_XML", parsed.warnings.join(" "));
    }

    context.store.upsert(parsed.events, parsed.warnings.length);
    res.status(202).json({
      accepted: true,
      eventCount: parsed.events.length,
      warningCount: parsed.warnings.length,
      warnings: parsed.warnings
    });
  });

  app.post("/api/v1/admin/clear", (req, res) => {
    if (!isAuthorized(req, context)) {
      context.store.recordAuthFailure();
      return problem(req, res, 401, "UNAUTHORIZED", "Missing or invalid bearer token.");
    }
    res.json({ accepted: true, affectedCount: context.store.clear() });
  });
}

function registerFeatureRoutes(app: Express, context: TakGatewayAppContext): void {
  app.get("/api/v1/features", (req, res) => {
    if (!isReadAuthorized(req, context)) {
      context.store.recordAuthFailure();
      return problem(req, res, 401, "UNAUTHORIZED", "Missing or invalid bearer token.");
    }
    const query = parseTakQuery(req.query, context.config);
    if (!query.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", query.error);
    }
    res.json(context.store.getFeatureCollection(query.value));
  });

  app.get("/api/v1/cop/features", (req, res) => {
    res.set(compatibilityAliasHeaders("/api/v1/features"));
    if (!isReadAuthorized(req, context)) {
      context.store.recordAuthFailure();
      return problem(req, res, 401, "UNAUTHORIZED", "Missing or invalid bearer token.");
    }
    const query = parseTakQuery(req.query, context.config);
    if (!query.ok) {
      return problem(req, res, 400, "VALIDATION_ERROR", query.error);
    }
    res.json(context.store.getFeatureCollection(query.value));
  });
}

function compatibilityAliasHeaders(successorPath: string): Record<string, string> {
  return {
    Deprecation: "true",
    Link: `<${successorPath}>; rel="successor-version"`,
    Warning: '299 - "Compatibility alias; use the source-neutral provider endpoint for new integrations."'
  };
}

function isOperationallyReady(config: TakGatewayConfig): boolean {
  return Boolean(config.ingestToken) && (config.publicRead || Boolean(config.readToken));
}

function isReadAuthorized(req: Request, context: TakGatewayAppContext): boolean {
  if (context.config.publicRead) {
    return true;
  }
  if (!context.config.readToken) {
    return false;
  }
  return req.headers.authorization === `Bearer ${context.config.readToken}`;
}

function isDebugAuthorized(req: Request, context: TakGatewayAppContext): boolean {
  const header = req.headers.authorization;
  return Boolean(
    (context.config.readToken && header === `Bearer ${context.config.readToken}`) ||
    (context.config.ingestToken && header === `Bearer ${context.config.ingestToken}`)
  );
}

function isAuthorized(req: Request, context: TakGatewayAppContext): boolean {
  if (!context.config.ingestToken) {
    return false;
  }
  const header = req.headers.authorization;
  return header === `Bearer ${context.config.ingestToken}`;
}

function parseTakQuery(raw: Record<string, unknown>, config: TakGatewayConfig): { ok: true; value: TakQuery } | { ok: false; error: string } {
  const bbox = parseBbox(raw.bbox, config.defaultBbox);
  if (!bbox.ok) {
    return { ok: false, error: bbox.error };
  }
  const layers = parseLayers(raw.layer ?? raw.layers);
  if (layers.length === 0) {
    return { ok: false, error: "No valid TAK layers requested." };
  }
  return {
    ok: true,
    value: {
      bbox: bbox.value,
      layers,
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

function parseLayers(value: unknown): TakLayerId[] {
  const allowed = new Set<TakLayerId>(["ground", "mobile", "traffic"]);
  const raw = asString(value);
  if (!raw) {
    return ["mobile", "ground", "traffic"];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is TakLayerId => allowed.has(item as TakLayerId));
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

function ratio(value: number, total: number): number {
  return total > 0 ? Number((value / total).toFixed(4)) : 0;
}

function secondsSince(isoTimestamp: string): number {
  const timestampMs = new Date(isoTimestamp).getTime();
  return Number.isFinite(timestampMs) ? Math.max(0, Math.round((Date.now() - timestampMs) / 1000)) : -1;
}

function publicConfig(config: TakGatewayConfig): TakGatewayPublicConfig {
  return {
    defaultBbox: config.defaultBbox,
    staleAfterSeconds: config.staleAfterSeconds,
    retentionSeconds: config.retentionSeconds,
    maxEvents: config.maxEvents,
    exposeRaw: config.exposeRaw,
    ingestAuthConfigured: Boolean(config.ingestToken),
    readAuthConfigured: Boolean(config.readToken),
    publicRead: config.publicRead,
    sourceLabel: config.sourceLabel
  };
}
