import { SaxesParser } from "saxes";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SituationDataConfig } from "./config.js";
import type { BoundingBox, SituationDataLicense, SituationFeature, SituationQuery, SourceDescriptor, SourceFetchResult, SourceHealthStatus } from "./types.js";

const COORDINATE_FACTOR = 360 / 2 ** 24;
// OpenLR encodes the first LRP absolutely, but subsequent LRPs as signed
// differences in 1e-5 degrees. Using the absolute scale for both places the
// final LRP about twice as far away and breaks graph matching.
const RELATIVE_COORDINATE_FACTOR = 1e-5;
const TPEG2_LICENSE: SituationDataLicense = {
  name: "NDIC TPEG2 API terms",
  url: "https://tpeg.dopravniinfo.cz/about/terms-of-use",
  attribution: "Ředitelství silnic a dálnic / NDIC; TPEG2 delivery by CEDA Maps",
  commercialUse: "allowed_with_obligations",
  operationalUse: "allowed_with_obligations",
  notes: [
    "SIM publishes only a normalized value-added projection; raw TPEG/XML is never returned.",
    "Redistribution of unprocessed source data requires separate provider consent.",
    "The API token is server-side only and must never be logged or exposed to COP clients."
  ]
};

interface ParsedCoordinate {
  kind: "openlr" | "glr";
  role: string;
  longitude: number;
  latitude: number;
}

interface ParsedMethod {
  values: Map<string, string[]>;
  codes: Map<string, string[]>;
}

interface ParsedMessage {
  type: "TFP" | "TEC";
  documentTimestamp?: string;
  values: Map<string, string[]>;
  codes: Map<string, string[]>;
  coordinates: ParsedCoordinate[];
  methods: ParsedMethod[];
}

export interface Tpeg2StaticSegment {
  messageId: string;
  coordinates: Array<[number, number]>;
  openlr?: {
    positiveOffsetMeters?: number;
    negativeOffsetMeters?: number;
    points: Array<{
      role: string;
      frc?: string;
      fow?: string;
      bearing?: number;
      lowestFrcToNext?: string;
      distanceToNext?: number;
      againstDrivingDirection?: boolean;
    }>;
  };
  locationId?: string;
  countryCode?: string;
  locationTableNumber?: string;
}

export interface Tpeg2FlowRecord {
  messageId: string;
  versionId?: string;
  observedAt: string;
  validUntil?: string;
  averageSpeedKph?: number;
  freeFlowTravelTimeSeconds?: number;
  delaySeconds?: number;
  losCode?: string;
  qualityCode?: string;
}

export interface Tpeg2EventRecord {
  messageId: string;
  versionId?: string;
  observedAt: string;
  validFrom?: string;
  validUntil?: string;
  effectCode?: string;
  mainCauseCode?: string;
  subCauseCode?: string;
  warningLevelCode?: string;
  unverified?: boolean;
  label: string;
  coordinates: Array<[number, number]>;
}

export interface Tpeg2TrafficSnapshot {
  generatedAt: string;
  staticRevision: string;
  dynamicRevision: string;
  segments?: Tpeg2StaticSegment[];
  flows: Tpeg2FlowRecord[];
  sourceTiming?: Tpeg2SourceTiming;
}

export interface Tpeg2SourceTiming {
  requestStartedAt?: string;
  lastCheckedAt?: string;
  lastChangedAt?: string;
  upstreamLastModifiedAt?: string;
  nextRefreshAt?: string;
  requestDurationMs?: number;
  lastResponseStatus?: number;
  freshFlowCount: number;
  expiredFlowCount: number;
  invalidTimestampFlowCount: number;
  lastError?: string;
}

interface ConditionalFeedState<T> {
  etag?: string;
  lastModified?: string;
  lastAttemptStartedAtMs?: number;
  nextAttemptAtMs?: number;
  nextAttemptMonotonicMs?: number;
  restartNextAttemptAtMs?: number;
  lastCheckedAtMs?: number;
  lastChangedAtMs?: number;
  requestDurationMs?: number;
  lastResponseStatus?: number;
  lastError?: string;
  failureCount?: number;
  inFlight?: Promise<void>;
  value?: T;
}

type XmlInput = string | AsyncIterable<Uint8Array | string>;

export async function parseTpeg2Static(input: XmlInput): Promise<Map<string, Tpeg2StaticSegment>> {
  const segments = new Map<string, Tpeg2StaticSegment>();
  await parseMessages(input, (message) => {
    const messageId = firstEnding(message.values, "/messageID");
    const partId = firstEnding(message.values, "/partID");
    if (message.type !== "TFP" || !messageId || partId !== "1") {
      return;
    }
    const coordinates = decodeOpenLrCoordinates(message.coordinates);
    if (coordinates.length < 2) {
      return;
    }
    segments.set(messageId, {
      messageId,
      coordinates,
      openlr: decodeOpenLrProperties(message),
      locationId: firstEnding(message.values, "/locationID"),
      countryCode: firstEnding(message.values, "/countryCode"),
      locationTableNumber: firstEnding(message.values, "/locationTableNumber")
    });
  });
  return segments;
}

export async function parseTpeg2Dynamic(input: XmlInput): Promise<Tpeg2FlowRecord[]> {
  const records: Tpeg2FlowRecord[] = [];
  await parseMessages(input, (message) => {
    if (message.type !== "TFP" || firstEnding(message.values, "/partID") !== "2") {
      return;
    }
    const messageId = firstEnding(message.values, "/messageID");
    if (!messageId || firstEnding(message.values, "/cancelFlag") === "true") {
      return;
    }
    const method = message.methods.find((candidate) => !firstEnding(candidate.codes, "/vehicleClassAssignment")) ?? message.methods[0];
    if (!method) {
      return;
    }
    // A receipt or document-generation time is not a traffic observation.
    // Only the source's explicit measurement start time can authorize live use.
    const observedAt = firstEnding(method.values, "/startTime");
    if (!observedAt || !Number.isFinite(sourceTimestamp(observedAt))) return;
    records.push({
      messageId,
      versionId: firstEnding(message.values, "/versionID"),
      observedAt,
      validUntil: firstEnding(message.values, "/messageExpiryTime"),
      averageSpeedKph: numberOrUndefined(firstEnding(method.values, "/averageSpeed")),
      freeFlowTravelTimeSeconds: numberOrUndefined(firstEnding(method.values, "/freeFlowTravelTime")),
      delaySeconds: numberOrUndefined(firstEnding(method.values, "/delay")),
      losCode: firstEnding(method.codes, "/LOS"),
      qualityCode: firstEnding(method.codes, "/FlowQuality")
    });
  });
  return records;
}

export async function parseTpeg2Tec(input: XmlInput): Promise<Tpeg2EventRecord[]> {
  const records: Tpeg2EventRecord[] = [];
  await parseMessages(input, (message) => {
    if (message.type !== "TEC") {
      return;
    }
    const messageId = firstEnding(message.values, "/messageID");
    if (!messageId || firstEnding(message.values, "/cancelFlag") === "true") {
      return;
    }
    const label = firstEnding(message.values, "/freeText/value")?.replace(/\s+/g, " ").trim();
    const coordinates = decodeGlrCoordinates(message.coordinates);
    const openLrFallback = decodeOpenLrCoordinates(message.coordinates);
    const selectedCoordinates = coordinates.length > 0 ? coordinates : openLrFallback;
    if (!label || selectedCoordinates.length === 0) {
      return;
    }
    records.push({
      messageId,
      versionId: firstEnding(message.values, "/versionID"),
      observedAt: firstEnding(message.values, "/messageGenerationTime") ?? message.documentTimestamp ?? new Date().toISOString(),
      validFrom: firstEnding(message.values, "/startTime"),
      validUntil: firstEnding(message.values, "/stopTime") ?? firstEnding(message.values, "/messageExpiryTime"),
      effectCode: firstEnding(message.codes, "/effectCode"),
      mainCauseCode: firstEnding(message.codes, "/mainCause"),
      subCauseCode: firstEnding(message.codes, "/subCause"),
      warningLevelCode: firstEnding(message.codes, "/warningLevel"),
      unverified: firstEnding(message.values, "/unverifiedInformation") === "true",
      label: label.slice(0, 500),
      coordinates: selectedCoordinates
    });
  });
  return records;
}

export class Tpeg2Source {
  readonly descriptor: SourceDescriptor;
  private readonly staticFeed: ConditionalFeedState<Map<string, Tpeg2StaticSegment>> = {};
  private readonly dynamicFeed: ConditionalFeedState<Tpeg2FlowRecord[]> = {};
  private readonly tecFeed: ConditionalFeedState<Tpeg2EventRecord[]> = {};
  private staticRevision?: string;
  private dynamicRevision?: string;
  private dynamicPublicationPhaseMs?: number;
  private trafficUntilMs = 0;
  private trafficTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private gateLoadPromise?: Promise<void>;
  private gatePersistPromise: Promise<void> = Promise.resolve();
  private readonly lifetimeAbort = new AbortController();

  constructor(private readonly config: SituationDataConfig) {
    this.descriptor = {
      sourceId: "tpeg2",
      label: "NDIC/ŘSD TPEG2 traffic flow and events",
      enabled: config.enabledSources.includes("tpeg2"),
      mode: "live",
      priority: 92,
      layers: ["traffic"],
      license: TPEG2_LICENSE,
      baseUrl: config.tpeg2BaseUrl,
      updateCadenceSeconds: config.tpeg2DynamicCacheTtlSeconds
    };
  }

  /** Extend demand without changing the per-endpoint upstream request limit. */
  retainTrafficUntil(epochMs: number): void {
    if (this.disposed || !Number.isFinite(epochMs) || epochMs <= Date.now()) return;
    this.trafficUntilMs = Math.max(this.trafficUntilMs, epochMs);
    this.scheduleTrafficRefresh();
  }

  dispose(): void {
    this.disposed = true;
    this.lifetimeAbort.abort();
    this.trafficUntilMs = 0;
    if (this.trafficTimer) clearTimeout(this.trafficTimer);
    this.trafficTimer = undefined;
  }

  async fetchFeatures(query: SituationQuery): Promise<SourceFetchResult> {
    const fetchedAt = new Date().toISOString();
    if (!query.layers.includes("traffic")) {
      return { source: this.descriptor, fetchedAt, features: [], warnings: [] };
    }
    if (!this.config.tpeg2ApiToken) {
      throw new Error("TPEG2 source is enabled but server-side authentication is not configured");
    }

    await this.ensureFresh();
    const segments = this.staticFeed.value ?? new Map();
    const flowFeatures: SituationFeature[] = [];
    for (const flow of this.dynamicFeed.value ?? []) {
      const segment = segments.get(flow.messageId);
      if (!segment || !coordinatesIntersectBbox(segment.coordinates, query.bbox)) {
        continue;
      }
      flowFeatures.push(mapFlowFeature(flow, segment));
      if (flowFeatures.length >= query.limit) {
        break;
      }
    }
    const eventFeatures: SituationFeature[] = [];
    for (const event of this.tecFeed.value ?? []) {
      if (!coordinatesIntersectBbox(event.coordinates, query.bbox)) {
        continue;
      }
      eventFeatures.push(mapEventFeature(event));
      if (eventFeatures.length >= query.limit) {
        break;
      }
    }
    const features = interleaveTrafficFeatures(flowFeatures, eventFeatures, query.limit);
    const warnings = this.feedErrors();
    return { source: this.descriptor, fetchedAt, features, warnings };
  }

  async healthStatus(): Promise<SourceHealthStatus> {
    const errors = this.feedErrors();
    return {
      sourceId: "tpeg2",
      status: this.config.tpeg2ApiToken && errors.length === 0 ? "ok" : "degraded",
      backend: "authenticated-tpeg2-api",
      objectCount: (this.dynamicFeed.value?.length ?? 0) + (this.tecFeed.value?.length ?? 0),
      lastImportAt: isoOrUndefined(this.dynamicFeed.lastChangedAtMs),
      warnings: [...(!this.config.tpeg2ApiToken ? ["TPEG2_API_TOKEN is not configured."] : []), ...errors]
    };
  }

  async trafficSnapshot(includeStatic = false): Promise<Tpeg2TrafficSnapshot> {
    if (!this.config.tpeg2ApiToken) {
      throw new Error("TPEG2 source is enabled but server-side authentication is not configured");
    }
    await this.ensureFresh(true, false);
    const segments = Array.from(this.staticFeed.value?.values() ?? []);
    const flows = this.dynamicFeed.value ?? [];
    return {
      generatedAt: new Date(this.dynamicFeed.lastChangedAtMs!).toISOString(),
      staticRevision: (this.staticRevision ??= snapshotRevision(segments.map((segment) => [segment.messageId, segment.coordinates]))),
      dynamicRevision: (this.dynamicRevision ??= snapshotRevision(
        flows.map((flow) => [flow.messageId, flow.versionId, flow.observedAt, flow.validUntil, flow.averageSpeedKph])
      )),
      ...(includeStatic ? { segments } : {}),
      flows,
      sourceTiming: this.sourceTiming()
    };
  }

  private async ensureFresh(waitForRefresh = false, includeTec = true): Promise<void> {
    const pending = this.refresh(includeTec);
    if (!waitForRefresh && this.staticFeed.value && this.dynamicFeed.value && this.tecFeed.value) {
      void pending.catch(() => undefined);
    } else {
      await pending;
    }
  }

  private async refresh(includeTec: boolean): Promise<void> {
    // Each endpoint commits its content, revision and error independently.
    // allSettled also prevents a rejected sibling from releasing an in-flight gate.
    const requests = [this.refreshStatic(), this.refreshDynamic()];
    if (includeTec) requests.push(this.refreshTec());
    await Promise.allSettled(requests);
    if (!this.staticFeed.value || !this.dynamicFeed.value) {
      throw new Error(this.staticFeed.lastError ?? this.dynamicFeed.lastError ?? "TPEG2 traffic snapshot is not yet available");
    }
  }

  private refreshStatic(): Promise<void> {
    return this.fetchConditional(
      "/dev/tpeg/tfp-static",
      this.staticFeed,
      parseTpeg2Static,
      Math.max(3600, this.config.tpeg2StaticCacheTtlSeconds) * 1000,
      (value) => {
        const revision = snapshotRevision(Array.from(value.values()).map((segment) => [segment.messageId, segment.coordinates]));
        const changed = revision !== this.staticRevision;
        this.staticRevision = revision;
        return changed;
      }
    );
  }

  private refreshDynamic(): Promise<void> {
    return this.fetchConditional(
      "/dev/tpeg/tfp-dynamic",
      this.dynamicFeed,
      async (input) => (await parseTpeg2Dynamic(input)).slice(0, this.config.tpeg2MaxRecords),
      this.dynamicIntervalMs(),
      (value) => {
        const revision = snapshotRevision(value.map((flow) => [flow.messageId, flow.versionId, flow.observedAt, flow.validUntil, flow.averageSpeedKph]));
        const changed = revision !== this.dynamicRevision;
        this.dynamicRevision = revision;
        return changed;
      }
    );
  }

  private refreshTec(): Promise<void> {
    return this.fetchConditional(
      "/dev/tpeg/tec",
      this.tecFeed,
      async (input) => (await parseTpeg2Tec(input)).slice(0, this.config.tpeg2MaxRecords),
      this.dynamicIntervalMs(),
      () => true
    );
  }

  private dynamicIntervalMs(): number {
    return Math.max(300, this.config.tpeg2DynamicCacheTtlSeconds) * 1000;
  }

  private scheduleTrafficRefresh(): void {
    if (this.trafficTimer) clearTimeout(this.trafficTimer);
    this.trafficTimer = undefined;
    if (this.disposed || !this.config.tpeg2ApiToken || this.trafficUntilMs <= Date.now()) return;
    const due = Date.now() + this.remainingWaitMs(this.dynamicFeed);
    const wakeAt = Math.min(due, this.trafficUntilMs);
    this.trafficTimer = setTimeout(
      () => {
        this.trafficTimer = undefined;
        if (this.disposed || this.trafficUntilMs <= Date.now()) return;
        void this.refreshDynamic()
          .catch(() => undefined)
          .finally(() => this.scheduleTrafficRefresh());
      },
      Math.max(0, wakeAt - Date.now())
    );
    this.trafficTimer.unref?.();
  }

  private feedErrors(): string[] {
    return [this.staticFeed.lastError, this.dynamicFeed.lastError, this.tecFeed.lastError].filter((value): value is string => Boolean(value));
  }

  private remainingWaitMs(state: ConditionalFeedState<unknown>): number {
    return Math.max(0, (state.nextAttemptAtMs ?? Date.now()) - Date.now(), (state.nextAttemptMonotonicMs ?? performance.now()) - performance.now());
  }

  private alignDynamicRefresh<T>(
    path: string,
    state: ConditionalFeedState<T>,
    startedAt: number,
    startedMonotonic: number,
    intervalMs: number,
    lastModified: string | null
  ): void {
    // Last-Modified is useful as a publication phase only after the operator
    // verifies its cadence against actual releases. It cannot prove that alone.
    if (!this.config.tpeg2AlignToLastModified || !path.endsWith("tfp-dynamic") || !lastModified) return;
    const modifiedAt = Date.parse(lastModified);
    if (!Number.isFinite(modifiedAt) || modifiedAt < 0 || modifiedAt > Date.now()) return;
    this.dynamicPublicationPhaseMs ??= modifiedAt;
    const publicationMarginMs = 10000;
    const anchor = this.dynamicPublicationPhaseMs + publicationMarginMs;
    const earliest = Math.max(startedAt + intervalMs, Date.now() + 1);
    const next = anchor + Math.max(0, Math.ceil((earliest - anchor) / intervalMs)) * intervalMs;
    state.nextAttemptAtMs = next;
    state.nextAttemptMonotonicMs = startedMonotonic + (next - startedAt);
    state.restartNextAttemptAtMs = next;
  }

  private sourceTiming(): Tpeg2SourceTiming {
    const now = Date.now();
    let freshFlowCount = 0;
    let expiredFlowCount = 0;
    let invalidTimestampFlowCount = 0;
    for (const flow of this.dynamicFeed.value ?? []) {
      const observed = sourceTimestamp(flow.observedAt);
      const expiry = flow.validUntil === undefined ? undefined : sourceTimestamp(flow.validUntil);
      if (!Number.isFinite(observed) || (expiry !== undefined && (!Number.isFinite(expiry) || expiry < observed)) || observed > now + 30000) {
        invalidTimestampFlowCount++;
      } else if ((expiry !== undefined && expiry <= now) || now - observed > (this.config.valhallaTrafficMaxAgeSeconds ?? 1800) * 1000) {
        expiredFlowCount++;
      } else {
        freshFlowCount++;
      }
    }
    const state = this.dynamicFeed;
    const modified = state.lastModified ? Date.parse(state.lastModified) : NaN;
    return {
      requestStartedAt: isoOrUndefined(state.lastAttemptStartedAtMs),
      lastCheckedAt: isoOrUndefined(state.lastCheckedAtMs),
      lastChangedAt: isoOrUndefined(state.lastChangedAtMs),
      upstreamLastModifiedAt: Number.isFinite(modified) ? new Date(modified).toISOString() : undefined,
      nextRefreshAt: isoOrUndefined(state.nextAttemptAtMs),
      requestDurationMs: state.requestDurationMs,
      lastResponseStatus: state.lastResponseStatus,
      freshFlowCount,
      expiredFlowCount,
      invalidTimestampFlowCount,
      lastError: state.lastError
    };
  }

  private fetchConditional<T>(
    path: string,
    state: ConditionalFeedState<T>,
    parser: (input: XmlInput) => Promise<T>,
    intervalMs: number,
    commitRevision: (value: T) => boolean
  ): Promise<void> {
    if (state.inFlight) return state.inFlight;
    state.inFlight = this.performFetch(path, state, parser, intervalMs, commitRevision)
      .catch((error: unknown) => {
        state.lastError = error instanceof Error && error.message.startsWith("TPEG2 ") ? error.message : `TPEG2 provider refresh failed for ${path}`;
        if (state.nextAttemptAtMs === undefined || state.nextAttemptAtMs <= Date.now()) {
          state.nextAttemptAtMs = Date.now() + this.dynamicIntervalMs();
          state.nextAttemptMonotonicMs = performance.now() + this.dynamicIntervalMs();
          state.restartNextAttemptAtMs = state.nextAttemptAtMs;
        }
        throw new Error(state.lastError);
      })
      .finally(() => {
        state.inFlight = undefined;
      });
    return state.inFlight;
  }

  private async performFetch<T>(
    path: string,
    state: ConditionalFeedState<T>,
    parser: (input: XmlInput) => Promise<T>,
    intervalMs: number,
    commitRevision: (value: T) => boolean
  ): Promise<void> {
    if (this.disposed) return;
    await (this.gateLoadPromise ??= this.loadRequestGate());
    if (this.disposed) return;
    if (this.remainingWaitMs(state) > 0) return;
    const minimumRequestIntervalMs = path.endsWith("tfp-static") ? 300000 : intervalMs;
    // Persist a conservative preflight gate before issuing the HTTP request.
    // A crash cannot permit a new process to retry earlier than the real start.
    state.nextAttemptAtMs = Date.now() + intervalMs + this.config.tpeg2RequestTimeoutMs;
    state.restartNextAttemptAtMs = Date.now() + minimumRequestIntervalMs + this.config.tpeg2RequestTimeoutMs;
    await this.persistRequestGate();
    if (this.disposed) return;
    const startedAt = Date.now();
    const startedMonotonic = performance.now();
    if (startedAt + minimumRequestIntervalMs > state.restartNextAttemptAtMs) {
      throw new Error("TPEG2 request timing persistence exceeded its deadline");
    }
    state.lastAttemptStartedAtMs = startedAt;
    state.nextAttemptAtMs = startedAt + intervalMs;
    state.nextAttemptMonotonicMs = startedMonotonic + intervalMs;
    // The persisted file is a request-quota gate, not a content cache. Static
    // content is reloaded after restart, subject to the same minimum interval.
    state.restartNextAttemptAtMs = startedAt + minimumRequestIntervalMs;
    const url = new URL(path, this.config.tpeg2BaseUrl);
    url.searchParams.set("token", this.config.tpeg2ApiToken ?? "");
    const headers: Record<string, string> = { Accept: "application/xml", "Accept-Encoding": "gzip" };
    if (state.etag) headers["If-None-Match"] = state.etag;
    if (state.lastModified) headers["If-Modified-Since"] = state.lastModified;
    let retryNotBefore: number | undefined;
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.any([AbortSignal.timeout(this.config.tpeg2RequestTimeoutMs), this.lifetimeAbort.signal])
      });
      state.lastResponseStatus = response.status;
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter && !response.ok) {
        const seconds = Number(retryAfter);
        const retryAt = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1000 : Date.parse(retryAfter);
        if (Number.isFinite(retryAt)) retryNotBefore = retryAt;
      }
      if (response.status === 304 && state.value) {
        state.lastCheckedAtMs = Date.now();
        state.lastError = undefined;
        state.failureCount = 0;
        this.alignDynamicRefresh(path, state, startedAt, startedMonotonic, intervalMs, response.headers.get("last-modified"));
        return;
      }
      if (!response.ok || !response.body) {
        throw new Error(`TPEG2 provider returned HTTP ${response.status} for ${path}`);
      }
      const value = await parser(response.body as unknown as AsyncIterable<Uint8Array>);
      const changed = commitRevision(value);
      state.value = value;
      state.etag = response.headers.get("etag") ?? undefined;
      state.lastModified = response.headers.get("last-modified") ?? undefined;
      state.lastCheckedAtMs = Date.now();
      if (changed || state.lastChangedAtMs === undefined) state.lastChangedAtMs = state.lastCheckedAtMs;
      state.lastError = undefined;
      state.failureCount = 0;
      this.alignDynamicRefresh(path, state, startedAt, startedMonotonic, intervalMs, response.headers.get("last-modified"));
    } catch (error) {
      state.failureCount = (state.failureCount ?? 0) + 1;
      const backoffMs = Math.min(Math.max(minimumRequestIntervalMs, 3600000), minimumRequestIntervalMs * 2 ** Math.min(6, state.failureCount - 1));
      state.nextAttemptAtMs = Math.max(startedAt + backoffMs, retryNotBefore ?? 0);
      state.nextAttemptMonotonicMs = Math.max(startedMonotonic + backoffMs, performance.now() + Math.max(0, (retryNotBefore ?? Date.now()) - Date.now()));
      state.restartNextAttemptAtMs = state.nextAttemptAtMs;
      throw error;
    } finally {
      state.requestDurationMs = Math.max(0, performance.now() - startedMonotonic);
      await this.persistRequestGate();
    }
  }

  private requestGatePath(): string | undefined {
    return this.config.valhallaTrafficCacheDir ? join(this.config.valhallaTrafficCacheDir, "provider-request-timing.json") : undefined;
  }

  private async loadRequestGate(): Promise<void> {
    const path = this.requestGatePath();
    if (!path) return;
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("TPEG2 persisted request timing is unavailable or invalid");
    }
    if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) {
      throw new Error("TPEG2 persisted request timing is invalid");
    }
    for (const [name, state] of this.feedStates()) {
      const entry = (value as Record<string, unknown>)[name];
      if (entry === undefined) continue;
      if (!entry || typeof entry !== "object") throw new Error("TPEG2 persisted request timing is invalid");
      const next = (entry as { nextAttemptAtMs?: unknown }).nextAttemptAtMs;
      if (typeof next !== "number" || !Number.isFinite(next) || next < 0) throw new Error("TPEG2 persisted request timing is invalid");
      state.nextAttemptAtMs = next;
      state.nextAttemptMonotonicMs = performance.now() + Math.max(0, next - Date.now());
      state.restartNextAttemptAtMs = next;
    }
  }

  private feedStates(): Array<[string, ConditionalFeedState<unknown>]> {
    return [
      ["static", this.staticFeed],
      ["dynamic", this.dynamicFeed],
      ["tec", this.tecFeed]
    ];
  }

  private persistRequestGate(): Promise<void> {
    const path = this.requestGatePath();
    if (!path) return Promise.resolve();
    const write = this.gatePersistPromise
      .catch(() => undefined)
      .then(async () => {
        const state = Object.fromEntries(
          this.feedStates()
            .filter(([, feed]) => feed.nextAttemptAtMs !== undefined)
            .map(([name, feed]) => [name, { nextAttemptAtMs: feed.restartNextAttemptAtMs ?? feed.nextAttemptAtMs }])
        );
        await mkdir(this.config.valhallaTrafficCacheDir, { recursive: true });
        const temporary = `${path}.tmp-${process.pid}`;
        await writeFile(temporary, `${JSON.stringify({ version: 1, ...state })}\n`, { mode: 0o600 });
        await rename(temporary, path);
      })
      .catch(() => {
        throw new Error("TPEG2 request timing persistence is unavailable");
      });
    this.gatePersistPromise = write;
    return write;
  }
}

function isoOrUndefined(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

function sourceTimestamp(value: string): number {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
}

function snapshotRevision(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function interleaveTrafficFeatures(flow: SituationFeature[], events: SituationFeature[], limit: number): SituationFeature[] {
  const result: SituationFeature[] = [];
  let flowIndex = 0;
  let eventIndex = 0;
  while (result.length < limit && (flowIndex < flow.length || eventIndex < events.length)) {
    const eventTurn = result.length > 0 && result.length % 5 === 4 && eventIndex < events.length;
    if (!eventTurn && flowIndex < flow.length) {
      result.push(flow[flowIndex++]!);
    } else if (eventIndex < events.length) {
      result.push(events[eventIndex++]!);
    } else if (flowIndex < flow.length) {
      result.push(flow[flowIndex++]!);
    }
  }
  return result;
}

async function parseMessages(input: XmlInput, onMessage: (message: ParsedMessage) => void): Promise<void> {
  let documentTimestamp: string | undefined;
  let current: ParsedMessage | undefined;
  let currentMethod: ParsedMethod | undefined;
  let currentCoordinate: Partial<ParsedCoordinate> | undefined;
  const names: string[] = [];
  const texts: string[] = [];
  const parser = new SaxesParser({ xmlns: true });

  parser.on("opentag", (rawTag) => {
    const tag = rawTag as unknown as { local: string; attributes: Record<string, { local: string; value: string }> };
    names.push(tag.local);
    texts.push("");
    const attributes = Object.values(tag.attributes);
    if (tag.local === "TPEGDocument") {
      documentTimestamp = attributes.find((attribute) => attribute.local === "timeStamp")?.value;
    }
    if (tag.local === "ApplicationRootMessageML") {
      const type = attributes.find((attribute) => attribute.local === "type")?.value;
      if (type?.endsWith(":TFPMessage") || type?.endsWith(":TECMessage")) {
        current = {
          type: type.endsWith(":TFPMessage") ? "TFP" : "TEC",
          documentTimestamp,
          values: new Map(),
          codes: new Map(),
          coordinates: [],
          methods: []
        };
      }
    }
    if (!current) return;
    const relativePath = messagePath(names);
    const code = attributes.find((attribute) => attribute.local === "code")?.value;
    if (code) addValue(current.codes, relativePath, code);
    if (currentMethod && code) addValue(currentMethod.codes, relativePath, code);
    if (tag.local === "method") {
      currentMethod = { values: new Map(), codes: new Map() };
    }
    if (tag.local === "coordinate") {
      currentCoordinate = { kind: "openlr", role: names.at(-2) ?? "unknown" };
    } else if (tag.local === "linePoints") {
      currentCoordinate = { kind: "glr", role: "linePoint" };
    }
  });
  parser.on("text", (value) => {
    if (texts.length > 0) texts[texts.length - 1] += value;
  });
  parser.on("closetag", (rawTag) => {
    const tag = rawTag as unknown as { local: string };
    const value = texts.at(-1)?.trim();
    const relativePath = messagePath(names);
    if (current && value) {
      addValue(current.values, relativePath, value);
      if (currentMethod) addValue(currentMethod.values, relativePath, value);
      if (currentCoordinate && (tag.local === "longitude" || tag.local === "Longitude")) {
        currentCoordinate.longitude = Number(value);
      }
      if (currentCoordinate && (tag.local === "latitude" || tag.local === "Latitude")) {
        currentCoordinate.latitude = Number(value);
      }
    }
    if (current && currentCoordinate && (tag.local === "coordinate" || tag.local === "linePoints")) {
      if (Number.isFinite(currentCoordinate.longitude) && Number.isFinite(currentCoordinate.latitude)) {
        current.coordinates.push(currentCoordinate as ParsedCoordinate);
      }
      currentCoordinate = undefined;
    }
    if (current && tag.local === "method" && currentMethod) {
      current.methods.push(currentMethod);
      currentMethod = undefined;
    }
    if (current && tag.local === "ApplicationRootMessageML") {
      onMessage(current);
      current = undefined;
      currentMethod = undefined;
      currentCoordinate = undefined;
    }
    names.pop();
    texts.pop();
  });

  const decoder = new TextDecoder();
  if (typeof input === "string") {
    parser.write(input).close();
    return;
  }
  for await (const chunk of input) {
    parser.write(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
  }
  parser.write(decoder.decode()).close();
}

function messagePath(names: string[]): string {
  const root = names.lastIndexOf("ApplicationRootMessageML");
  return `/${names.slice(Math.max(0, root + 1)).join("/")}`;
}

function addValue(map: Map<string, string[]>, path: string, value: string): void {
  const values = map.get(path) ?? [];
  values.push(value);
  map.set(path, values);
}

function firstEnding(map: Map<string, string[]>, suffix: string): string | undefined {
  for (const [path, values] of map) {
    if (path.endsWith(suffix) && values[0] !== undefined) return values[0];
  }
  return undefined;
}

function endingAt(map: Map<string, string[]>, suffix: string, index: number): string | undefined {
  for (const [path, values] of map) {
    if (path.endsWith(suffix)) return values[index];
  }
  return undefined;
}

function decodeOpenLrCoordinates(coordinates: ParsedCoordinate[]): Array<[number, number]> {
  const encoded = coordinates.filter((coordinate) => coordinate.kind === "openlr");
  if (encoded.length === 0) return [];
  let longitude = encoded[0]!.longitude * COORDINATE_FACTOR;
  let latitude = encoded[0]!.latitude * COORDINATE_FACTOR;
  const decoded: Array<[number, number]> = [[longitude, latitude]];
  for (const coordinate of encoded.slice(1)) {
    longitude += coordinate.longitude * RELATIVE_COORDINATE_FACTOR;
    latitude += coordinate.latitude * RELATIVE_COORDINATE_FACTOR;
    decoded.push([longitude, latitude]);
  }
  return decoded;
}

function decodeOpenLrProperties(message: ParsedMessage): Tpeg2StaticSegment["openlr"] {
  const method = message.methods.find((candidate) => Array.from(candidate.values.keys()).some((path) => path.includes("/optionLinearLocationReference/")));
  if (!method) return undefined;
  const roleIndexes = new Map<string, number>();
  const points = message.coordinates
    .filter((coordinate) => coordinate.kind === "openlr")
    .map((coordinate) => {
      const prefix = `/optionLinearLocationReference/${coordinate.role}`;
      const index = roleIndexes.get(coordinate.role) ?? 0;
      roleIndexes.set(coordinate.role, index + 1);
      const property = (map: Map<string, string[]>, suffix: string) => endingAt(map, `${prefix}${suffix}`, index);
      const bearing = numberOrUndefined(property(method.values, "/lineProperties/bearing/value"));
      const distanceToNext = numberOrUndefined(property(method.values, "/pathProperties/dnp/value"));
      const againstDrivingDirection = property(method.values, "/pathProperties/againstDrivingDirection");
      return {
        role: coordinate.role,
        ...(property(method.codes, "/lineProperties/frc") !== undefined ? { frc: property(method.codes, "/lineProperties/frc") } : {}),
        ...(property(method.codes, "/lineProperties/fow") !== undefined ? { fow: property(method.codes, "/lineProperties/fow") } : {}),
        ...(bearing !== undefined ? { bearing } : {}),
        ...(property(method.codes, "/pathProperties/lfrcnp") !== undefined ? { lowestFrcToNext: property(method.codes, "/pathProperties/lfrcnp") } : {}),
        ...(distanceToNext !== undefined ? { distanceToNext } : {}),
        ...(againstDrivingDirection === "true" || againstDrivingDirection === "false" ? { againstDrivingDirection: againstDrivingDirection === "true" } : {})
      };
    });
  const positiveOffsetMeters = numberOrUndefined(firstEnding(method.values, "/optionLinearLocationReference/positiveOffset/value"));
  const negativeOffsetMeters = numberOrUndefined(firstEnding(method.values, "/optionLinearLocationReference/negativeOffset/value"));
  return points.length > 0
    ? {
        points,
        ...(positiveOffsetMeters !== undefined ? { positiveOffsetMeters } : {}),
        ...(negativeOffsetMeters !== undefined ? { negativeOffsetMeters } : {})
      }
    : undefined;
}

function decodeGlrCoordinates(coordinates: ParsedCoordinate[]): Array<[number, number]> {
  return coordinates
    .filter((coordinate) => coordinate.kind === "glr")
    .map((coordinate) => [coordinate.longitude * COORDINATE_FACTOR, coordinate.latitude * COORDINATE_FACTOR]);
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function coordinatesIntersectBbox(coordinates: Array<[number, number]>, bbox: BoundingBox): boolean {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [longitude, latitude] of coordinates) {
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  }
  return west <= bbox.east && east >= bbox.west && south <= bbox.north && north >= bbox.south;
}

function mapFlowFeature(flow: Tpeg2FlowRecord, segment: Tpeg2StaticSegment): SituationFeature {
  const delay = flow.delaySeconds ?? 0;
  const totalTravelTime = delay + (flow.freeFlowTravelTimeSeconds ?? 0);
  const delayRatio = totalTravelTime > 0 ? delay / totalTravelTime : 0;
  const severity = delay > 900 && delayRatio >= 0.75 ? "critical" : delayRatio >= 0.5 ? "warning" : delayRatio >= 0.2 ? "advisory" : "info";
  const speedLabel = flow.averageSpeedKph === undefined ? "Dopravní proud" : `Dopravní proud: ${Math.round(flow.averageSpeedKph)} km/h`;
  return {
    type: "Feature",
    id: `traffic:tpeg2:tfp:${flow.messageId}`,
    geometry: { type: "LineString", coordinates: segment.coordinates },
    properties: {
      featureId: `traffic:tpeg2:tfp:${flow.messageId}`,
      providerId: "sim.situation-data",
      providerLayerId: "traffic.tpeg2.flow",
      layerId: "public.traffic.flow",
      layer: "traffic",
      category: "road_traffic_flow",
      label: speedLabel,
      sourceId: "tpeg2",
      sourceSystem: "NDIC TPEG2 TFP",
      observedAt: flow.observedAt,
      validUntil: flow.validUntil,
      confidence: qualityConfidence(flow.qualityCode),
      stale: false,
      severity,
      license: licenseProjection(),
      metrics: compactRecord({
        averageSpeedKph: flow.averageSpeedKph,
        averageSpeedMps: flow.averageSpeedKph === undefined ? undefined : flow.averageSpeedKph / 3.6,
        freeFlowTravelTimeSeconds: flow.freeFlowTravelTimeSeconds,
        delaySeconds: flow.delaySeconds,
        losCode: flow.losCode,
        qualityCode: flow.qualityCode
      }),
      tags: compactStringRecord({
        messageId: flow.messageId,
        versionId: flow.versionId,
        tmcLocationId: segment.locationId,
        tmcCountryCode: segment.countryCode,
        tmcLocationTableNumber: segment.locationTableNumber,
        geometryPrecision: "openlr_reference_line"
      }),
      transportMode: "road",
      speedMps: flow.averageSpeedKph === undefined ? undefined : flow.averageSpeedKph / 3.6,
      delaySeconds: flow.delaySeconds,
      operator: "ŘSD / NDIC"
    }
  };
}

function mapEventFeature(event: Tpeg2EventRecord): SituationFeature {
  const geometry =
    event.coordinates.length === 1
      ? { type: "Point" as const, coordinates: event.coordinates[0]! }
      : { type: "LineString" as const, coordinates: event.coordinates };
  const warning = Number(event.warningLevelCode ?? 0);
  const severity = warning >= 4 ? "critical" : warning >= 3 ? "warning" : warning >= 2 ? "advisory" : "info";
  return {
    type: "Feature",
    id: `traffic:tpeg2:tec:${event.messageId}`,
    geometry,
    properties: {
      featureId: `traffic:tpeg2:tec:${event.messageId}`,
      providerId: "sim.situation-data",
      providerLayerId: "traffic.tpeg2.events",
      layerId: "public.traffic.road_events",
      layer: "traffic",
      category: "road_traffic_event",
      label: event.label,
      sourceId: "tpeg2",
      sourceSystem: "NDIC TPEG2 TEC",
      observedAt: event.observedAt,
      validFrom: event.validFrom,
      validUntil: event.validUntil,
      confidence: event.unverified ? 0.6 : 0.9,
      stale: false,
      severity,
      license: licenseProjection(),
      metrics: compactRecord({ warningLevelCode: event.warningLevelCode }),
      tags: compactStringRecord({
        messageId: event.messageId,
        versionId: event.versionId,
        effectCode: event.effectCode,
        mainCauseCode: event.mainCauseCode,
        subCauseCode: event.subCauseCode,
        unverified: event.unverified === undefined ? undefined : String(event.unverified),
        geometryPrecision: "tpeg_reference_line"
      }),
      transportMode: "road",
      operator: "ŘSD / NDIC"
    }
  };
}

function qualityConfidence(code: string | undefined): number {
  const value = Number(code);
  return Number.isFinite(value) ? Math.max(0.5, Math.min(0.95, 0.55 + value * 0.08)) : 0.7;
}

function licenseProjection(): SituationFeature["properties"]["license"] {
  return { name: TPEG2_LICENSE.name, attribution: TPEG2_LICENSE.attribution, url: TPEG2_LICENSE.url };
}

function compactRecord(values: Record<string, number | string | boolean | undefined>): Record<string, number | string | boolean> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, number | string | boolean] => entry[1] !== undefined));
}

function compactStringRecord(values: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
