import { createConnection } from "node:net";
import type { SituationDataConfig } from "./config.js";
import type { SituationDataSource } from "./sources.js";
import type { BoundingBox, SituationFeature, SituationQuery, SourceDescriptor, SourceFetchResult, SourceHealthStatus } from "./types.js";

const ATTRIBUTION = "APRS-IS network / transmitting amateur radio stations";
const SOURCE_URL = "https://www.aprs-is.net/";
const MAX_PACKET_BYTES = 1024;
const CALLSIGN = /^[A-Z0-9]{1,9}(?:-[0-9]{1,2})?$/;

interface AprsObservation {
  callsign: string;
  receivedAt: string;
  reportAt?: string;
  coordinates?: [number, number];
  symbol?: string;
  symbolTable?: string;
  stationType: "fixed" | "mobile" | "unknown";
  positionQuality: "reported" | "missing" | "invalid";
  timeQuality: "packet_utc" | "sim_received_only";
}

interface CacheEntry {
  expiresAt: number;
  observations: AprsObservation[];
}

export class AprsIsSource implements SituationDataSource {
  readonly descriptor: SourceDescriptor;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<AprsObservation[]>>();
  private readonly requestTimes: number[] = [];
  private lastSuccessAt?: string;
  private lastError?: string;
  private errorCount = 0;
  private backoffUntil = 0;
  private lastObservations: AprsObservation[] = [];

  constructor(private readonly config: SituationDataConfig) {
    this.descriptor = {
      sourceId: "aprs_is",
      label: "APRS / radioamatérské stanice",
      enabled: config.enabledSources.includes("aprs_is") && Boolean(config.aprsIsCallsign && CALLSIGN.test(config.aprsIsCallsign)),
      mode: "live",
      priority: 45,
      layers: ["aprs"],
      license: {
        name: "APRS-IS live reception",
        url: SOURCE_URL,
        attribution: ATTRIBUTION,
        commercialUse: "unknown",
        operationalUse: "allowed_with_obligations",
        notes: [
          "Receiver uses a request-scoped APRS-IS area filter; no aprs.fi API or website is queried.",
          "Positions are unverified radio reports, not verified crisis events or routing data.",
          "COP must display the attribution and source link."
        ]
      },
      baseUrl: SOURCE_URL,
      updateCadenceSeconds: config.aprsIsCacheTtlSeconds
    };
  }

  async healthStatus(): Promise<SourceHealthStatus> {
    const now = Date.now();
    const activeCount = this.lastObservations.filter((item) => item.coordinates && now - Date.parse(item.reportAt ?? item.receivedAt) <= this.config.aprsIsFreshSeconds * 1000).length;
    const staleCount = this.lastObservations.filter((item) => item.coordinates && now - Date.parse(item.reportAt ?? item.receivedAt) > this.config.aprsIsFreshSeconds * 1000).length;
    return {
      sourceId: "aprs_is",
      status: this.backoffUntil > now || this.lastError ? "degraded" : "ok",
      backend: "aprs-is-filtered",
      objectCount: activeCount,
      activeCount,
      staleCount,
      noPositionCount: this.lastObservations.filter((item) => !item.coordinates).length,
      providerErrorCount: this.errorCount,
      lastImportAt: this.lastSuccessAt,
      lastImportAgeSeconds: this.lastSuccessAt ? Math.round((now - Date.parse(this.lastSuccessAt)) / 1000) : undefined,
      warnings: [
        `active=${activeCount}; stale=${staleCount}; withoutPosition=${this.lastObservations.filter((item) => !item.coordinates).length}; providerErrors=${this.errorCount}`,
        ...(this.lastError ? [this.lastError] : [])
      ]
    };
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("aprs")) return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    if (!this.config.aprsIsCallsign || !CALLSIGN.test(this.config.aprsIsCallsign.toUpperCase())) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: ["APRS-IS receiver is not configured."] };
    }
    if (!isPermittedBbox(query.bbox, this.config.aprsIsMaxBboxDegrees)) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: ["APRS request area exceeds the configured limit."] };
    }
    const key = JSON.stringify(query.bbox);
    const now = Date.now();
    const cached = this.cache.get(key);
    let observations = cached?.observations ?? [];
    const warnings: string[] = [];
    if (!cached || cached.expiresAt <= now) {
      if (this.backoffUntil > now) {
        warnings.push("APRS-IS provider temporarily unavailable; cached positions are marked stale.");
      } else if (!this.inflight.has(key) && !this.reserveRequest(now)) {
        warnings.push("APRS-IS request limit reached; try again later.");
      } else {
        try {
          const pending = this.inflight.get(key) ?? this.receive(query.bbox);
          this.inflight.set(key, pending);
          observations = await pending;
          this.cache.set(key, { expiresAt: Date.now() + this.config.aprsIsCacheTtlSeconds * 1000, observations });
          while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
          this.lastObservations = observations;
          this.lastSuccessAt = new Date().toISOString();
          this.lastError = undefined;
          this.errorCount = 0;
        } catch (error) {
          this.errorCount++;
          this.lastError = error instanceof Error ? error.message : "APRS-IS connection failed";
          this.backoffUntil = Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(this.errorCount - 1, 6));
          warnings.push("APRS-IS provider unavailable; cached positions are marked stale.");
        } finally {
          this.inflight.delete(key);
        }
      }
    }
    const features = observations
      .filter((item) => item.coordinates && inside(query.bbox, item.coordinates))
      .slice(0, Math.min(query.limit, this.config.aprsIsMaxStations))
      .map((item) => toFeature(item, fetchedAt, this.config.aprsIsFreshSeconds, warnings.length > 0));
    return { source: this.descriptor, fetchedAt, features, warnings };
  }

  private reserveRequest(now: number): boolean {
    while (this.requestTimes.length && this.requestTimes[0]! <= now - 60_000) this.requestTimes.shift();
    if (this.requestTimes.length >= this.config.aprsIsMaxRequestsPerMinute) return false;
    this.requestTimes.push(now);
    return true;
  }

  private receive(bbox: BoundingBox): Promise<AprsObservation[]> {
    const config = this.config;
    return new Promise((resolve, reject) => {
      const observations = new Map<string, AprsObservation>();
      let buffer = "";
      let settled = false;
      const socket = createConnection({ host: config.aprsIsHost, port: config.aprsIsPort });
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve([...observations.values()]);
      };
      const timer = setTimeout(() => finish(), config.aprsIsWindowMs);
      socket.setTimeout(config.aprsIsWindowMs, () => finish(new Error("APRS-IS timeout")));
      socket.once("connect", () => {
        const filter = `a/${bbox.north}/${bbox.west}/${bbox.south}/${bbox.east}`;
        socket.write(`user ${config.aprsIsCallsign} pass -1 vers CSM-SIM 1.0 filter ${filter}\r\n`);
      });
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (buffer.length > MAX_PACKET_BYTES * 2) buffer = buffer.slice(-MAX_PACKET_BYTES);
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.startsWith("#") && /unverified|rejected|invalid/i.test(line)) {
            // pass -1 is receive-only. Reject only explicit login denial, not an unverified login.
            if (/rejected|invalid/i.test(line)) return finish(new Error("APRS-IS login rejected"));
          }
          if (!line.startsWith("#") && line.length <= MAX_PACKET_BYTES) {
            const observation = parseAprsIsPacket(line, new Date());
            if (observation && (!observation.coordinates || inside(bbox, observation.coordinates))) {
              observations.set(observation.callsign, observation);
              if (observations.size >= config.aprsIsMaxStations) return finish();
            }
          }
          newline = buffer.indexOf("\n");
        }
      });
      socket.once("error", (error) => finish(error));
      socket.once("close", () => finish(new Error("APRS-IS connection closed")));
    });
  }
}

export function parseAprsIsPacket(line: string, receivedAt: Date): AprsObservation | undefined {
  const match = /^([A-Z0-9]{1,9}(?:-[0-9]{1,2})?)>[^:]{1,120}:(.*)$/i.exec(line);
  if (!match) return undefined;
  const callsign = match[1]!.toUpperCase();
  const body = match[2]!;
  if (!"!=/@".includes(body[0] ?? "")) return { callsign, receivedAt: receivedAt.toISOString(), positionQuality: "missing", timeQuality: "sim_received_only", stationType: "unknown" };
  let payload = body.slice(1);
  let reportAt: string | undefined;
  if (body[0] === "/" || body[0] === "@") {
    const stamp = payload.slice(0, 7);
    payload = payload.slice(7);
    const utc = /^([0-2][0-9])([0-5][0-9])([0-5][0-9])h$/.exec(stamp);
    if (utc) {
      const date = new Date(receivedAt);
      date.setUTCHours(Number(utc[1]), Number(utc[2]), Number(utc[3]), 0);
      if (date.getTime() > receivedAt.getTime() + 60_000) date.setUTCDate(date.getUTCDate() - 1);
      reportAt = date.toISOString();
    } else {
      const dayUtc = /^([0-3][0-9])([0-2][0-9])([0-5][0-9])z$/.exec(stamp);
      if (dayUtc) {
        const day = Number(dayUtc[1]);
        const hour = Number(dayUtc[2]);
        const minute = Number(dayUtc[3]);
        let date = new Date(Date.UTC(receivedAt.getUTCFullYear(), receivedAt.getUTCMonth(), day, hour, minute));
        if (date.getTime() > receivedAt.getTime() + 60_000) {
          date = new Date(Date.UTC(receivedAt.getUTCFullYear(), receivedAt.getUTCMonth() - 1, day, hour, minute));
        }
        if (hour < 24 && date.getUTCDate() === day) reportAt = date.toISOString();
      }
    }
  }
  const pos = /^([0-8][0-9])([0-5][0-9]\.\d{2})([NS])([/\\])([0-1][0-9][0-9])([0-5][0-9]\.\d{2})([EW])(.{1})/.exec(payload);
  if (!pos) return { callsign, receivedAt: receivedAt.toISOString(), reportAt, positionQuality: "invalid", timeQuality: reportAt ? "packet_utc" : "sim_received_only", stationType: "unknown" };
  const lat = (Number(pos[1]) + Number(pos[2]) / 60) * (pos[3] === "S" ? -1 : 1);
  const lon = (Number(pos[5]) + Number(pos[6]) / 60) * (pos[7] === "W" ? -1 : 1);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  const movement = /^(?:\d{3})\/(?:\d{3})/.test(payload.slice(pos[0].length));
  const fixedSymbols = new Set(["-", "#", "&", "r", "y"]);
  const mobileSymbols = new Set([">", "v", "j", "k", "'", "`", "b"]);
  return {
    callsign, receivedAt: receivedAt.toISOString(), reportAt, coordinates: [lon, lat],
    symbolTable: pos[4], symbol: pos[8],
    stationType: movement || mobileSymbols.has(pos[8]!) ? "mobile" : fixedSymbols.has(pos[8]!) ? "fixed" : "unknown",
    positionQuality: "reported", timeQuality: reportAt ? "packet_utc" : "sim_received_only"
  };
}

function isPermittedBbox(bbox: BoundingBox, maxDegrees: number): boolean {
  return bbox.east > bbox.west && bbox.north > bbox.south &&
    bbox.east - bbox.west <= maxDegrees && bbox.north - bbox.south <= maxDegrees;
}

function inside(bbox: BoundingBox, point: [number, number]): boolean {
  return point[0] >= bbox.west && point[0] <= bbox.east && point[1] >= bbox.south && point[1] <= bbox.north;
}

function toFeature(item: AprsObservation, fetchedAt: string, freshSeconds: number, providerFailed: boolean): SituationFeature {
  const ageSeconds = Math.max(0, Math.round((Date.parse(fetchedAt) - Date.parse(item.reportAt ?? item.receivedAt)) / 1000));
  const stale = providerFailed || ageSeconds > freshSeconds;
  const id = `aprs:aprs_is:${item.callsign}`;
  return {
    type: "Feature", id, geometry: { type: "Point", coordinates: item.coordinates! },
    properties: {
      featureId: id, layer: "aprs", category: "amateur_radio_station",
      label: item.callsign, sourceId: "aprs_is", sourceName: "APRS-IS",
      observedAt: item.reportAt ?? item.receivedAt, updatedAt: item.receivedAt,
      stale, confidence: item.timeQuality === "packet_utc" ? 0.55 : 0.35, severity: "info",
      license: { name: "APRS-IS live reception", attribution: ATTRIBUTION, url: SOURCE_URL },
      summary: stale ? "Poslední známá poloha; není živá." : "Neověřené hlášení APRS.",
      providerProperties: {
        callsign: item.callsign, stationType: item.stationType,
        symbol: item.symbol, symbolTable: item.symbolTable,
        positionState: stale ? "stale" : "reported", positionQuality: item.positionQuality,
        reportAt: item.reportAt ?? null, simReceivedAt: item.receivedAt,
        reportTimeQuality: item.timeQuality, ageSeconds, source: "APRS-IS",
        attribution: ATTRIBUTION, attributionUrl: SOURCE_URL,
        verifiedIncident: false, navigationUse: false
      }
    }
  };
}
