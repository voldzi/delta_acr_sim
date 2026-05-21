import type { TakGatewayConfig } from "./config.js";
import { inferAffiliation, inferLayer } from "./cot.js";
import { takSourceDescriptor } from "./sources.js";
import type { BoundingBox, TakAffiliation, TakCotEvent, TakFeature, TakFeatureCollection, TakGatewayStats, TakQuery } from "./types.js";

export class TakEventStore {
  private readonly events = new Map<string, TakCotEvent>();
  private readonly stats: TakGatewayStats = {
    acceptedEvents: 0,
    invalidEvents: 0,
    droppedEvents: 0,
    authFailures: 0,
    parseErrors: 0,
    currentEvents: 0,
    staleEvents: 0
  };

  constructor(private readonly config: TakGatewayConfig) {}

  upsert(events: TakCotEvent[], invalidCount: number): void {
    const now = new Date();
    for (const event of events) {
      this.events.set(event.uid, event);
      this.stats.acceptedEvents += 1;
      this.stats.lastIngestAt = now.toISOString();
    }
    this.stats.invalidEvents += invalidCount;
    if (invalidCount > 0) {
      this.stats.lastErrorAt = now.toISOString();
    }
    this.prune(now);
    this.refreshCurrentStats(now);
  }

  recordAuthFailure(): void {
    this.stats.authFailures += 1;
  }

  recordParseError(): void {
    this.stats.parseErrors += 1;
    this.stats.lastErrorAt = new Date().toISOString();
  }

  listEvents(includeRaw: boolean): TakCotEvent[] {
    const now = new Date();
    this.prune(now);
    this.refreshCurrentStats(now);
    return [...this.events.values()].map((event) => (includeRaw || this.config.exposeRaw ? event : withoutRaw(event)));
  }

  getFeatureCollection(query: TakQuery): TakFeatureCollection {
    const now = new Date();
    this.prune(now);
    this.refreshCurrentStats(now);

    const features = [...this.events.values()]
      .filter((event) => contains(query.bbox, event.point.lon, event.point.lat))
      .map((event) => this.toFeature(event, now, query.includeRaw))
      .filter((feature) => query.layers.includes(feature.properties.layer))
      .slice(0, query.limit);

    const affiliationCounts: Record<TakAffiliation, number> = {
      friend: 0,
      hostile: 0,
      neutral: 0,
      unknown: 0
    };
    for (const feature of features) {
      affiliationCounts[feature.properties.affiliation] += 1;
    }

    const generatedAt = now.toISOString();
    return {
      contractVersion: "cop-tak-source-v1",
      type: "FeatureCollection",
      generatedAt,
      source: {
        sourceId: "tak-gateway-api",
        sourceType: "TAK_COT_GATEWAY",
        generatedAt
      },
      query: {
        bbox: query.bbox,
        layers: query.layers,
        limit: query.limit
      },
      summary: {
        eventCount: this.events.size,
        featureCount: features.length,
        staleFeatureCount: features.filter((feature) => feature.properties.stale).length,
        affiliationCounts
      },
      features,
      sources: [takSourceDescriptor(this.config)],
      warnings: warningsForConfig(this.config)
    };
  }

  getStats(): TakGatewayStats {
    const now = new Date();
    this.prune(now);
    this.refreshCurrentStats(now);
    return { ...this.stats };
  }

  clear(): number {
    const count = this.events.size;
    this.events.clear();
    this.refreshCurrentStats(new Date());
    return count;
  }

  private prune(now: Date): void {
    const retentionMs = this.config.retentionSeconds * 1000;
    const staleGraceMs = Math.max(retentionMs, this.config.staleAfterSeconds * 1000);
    for (const [uid, event] of this.events.entries()) {
      const receivedAt = new Date(event.receivedAt).getTime();
      const staleAt = event.stale ? new Date(event.stale).getTime() : undefined;
      const tooOld = Number.isFinite(receivedAt) && now.getTime() - receivedAt > retentionMs;
      const staleExpired = staleAt !== undefined && Number.isFinite(staleAt) && now.getTime() - staleAt > staleGraceMs;
      if (tooOld || staleExpired) {
        this.events.delete(uid);
        this.stats.droppedEvents += 1;
      }
    }

    if (this.events.size <= this.config.maxEvents) {
      return;
    }

    const ordered = [...this.events.values()].sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());
    for (const event of ordered.slice(0, this.events.size - this.config.maxEvents)) {
      this.events.delete(event.uid);
      this.stats.droppedEvents += 1;
    }
  }

  private refreshCurrentStats(now: Date): void {
    this.stats.currentEvents = this.events.size;
    this.stats.staleEvents = [...this.events.values()].filter((event) => isStale(event, now, this.config.staleAfterSeconds)).length;
  }

  private toFeature(event: TakCotEvent, now: Date, includeRaw: boolean): TakFeature {
    const layer = inferLayer(event);
    const affiliation = inferAffiliation(event.type);
    const observedAt = event.time ?? event.receivedAt;
    const ageSeconds = Math.max(0, Math.round((now.getTime() - new Date(observedAt).getTime()) / 1000));
    const circularError = event.point.ce;
    const confidence = estimateConfidence(circularError, isStale(event, now, this.config.staleAfterSeconds));
    const label = event.contact?.callsign ?? event.group?.name ?? event.uid;
    const metrics: Record<string, number | string | boolean> = {
      ageSeconds
    };
    addMetric(metrics, "altitudeHaeM", event.point.hae);
    addMetric(metrics, "circularErrorM", event.point.ce);
    addMetric(metrics, "linearErrorM", event.point.le);
    addMetric(metrics, "courseDeg", event.track?.course);
    addMetric(metrics, "speedMps", event.track?.speed);

    return {
      type: "Feature",
      id: `tak:cot:${event.uid}`,
      geometry: {
        type: "Point",
        coordinates: [event.point.lon, event.point.lat]
      },
      properties: {
        featureId: `tak:cot:${event.uid}`,
        layer,
        category: inferCategory(event, layer),
        label,
        description: event.remarks,
        sourceId: "tak_gateway",
        observedAt,
        receivedAt: event.receivedAt,
        validUntil: event.stale,
        confidence,
        stale: isStale(event, now, this.config.staleAfterSeconds),
        affiliation,
        license: {
          name: "TAK/CoT partner data",
          attribution: "TAK/ARDOS partner feed"
        },
        metrics,
        tags: compactTags({
          cotType: event.type,
          how: event.how,
          groupName: event.group?.name,
          groupRole: event.group?.role
        }),
        raw: includeRaw && this.config.exposeRaw ? event.raw : undefined
      }
    };
  }
}

function inferCategory(event: TakCotEvent, layer: string): string {
  const type = event.type.toLowerCase();
  if (type.includes("emergency") || type.includes("med") || type.includes("911")) {
    return "tak_emergency";
  }
  if (layer === "traffic") {
    return "tak_track";
  }
  if (layer === "mobile") {
    return "tak_unit";
  }
  return "tak_marker";
}

function estimateConfidence(circularError: number | undefined, stale: boolean): number {
  const base = circularError === undefined ? 0.75 : circularError <= 25 ? 0.95 : circularError <= 100 ? 0.8 : 0.6;
  return stale ? Math.min(base, 0.45) : base;
}

function isStale(event: TakCotEvent, now: Date, staleAfterSeconds: number): boolean {
  const observedAt = new Date(event.time ?? event.receivedAt).getTime();
  const staleAt = event.stale ? new Date(event.stale).getTime() : undefined;
  if (staleAt !== undefined && Number.isFinite(staleAt) && now.getTime() > staleAt) {
    return true;
  }
  return Number.isFinite(observedAt) && now.getTime() - observedAt > staleAfterSeconds * 1000;
}

function contains(bbox: BoundingBox, lon: number, lat: number): boolean {
  return lon >= bbox.west && lon <= bbox.east && lat >= bbox.south && lat <= bbox.north;
}

function withoutRaw(event: TakCotEvent): TakCotEvent {
  const { raw: _raw, ...rest } = event;
  return rest;
}

function addMetric(metrics: Record<string, number | string | boolean>, key: string, value: number | undefined): void {
  if (value !== undefined) {
    metrics[key] = value;
  }
}

function compactTags(values: Record<string, string | undefined>): Record<string, string> | undefined {
  const tags = Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function warningsForConfig(config: TakGatewayConfig): string[] {
  const warnings: string[] = [];
  if (!config.ingestToken) {
    warnings.push("TAK_GATEWAY_INGEST_TOKEN is not configured; CoT ingest is not protected.");
  }
  if (config.publicRead) {
    warnings.push("TAK_GATEWAY_PUBLIC_READ is enabled; partner TAK/CoT features are readable without bearer token.");
  }
  if (!config.publicRead && !config.readToken) {
    warnings.push("TAK_GATEWAY_PUBLIC_READ is disabled but TAK_GATEWAY_READ_TOKEN is not configured; feature reads are blocked.");
  }
  return warnings;
}
