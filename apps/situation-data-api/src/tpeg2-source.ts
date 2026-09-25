import { SaxesParser } from "saxes";
import { createHash } from "node:crypto";
import type { SituationDataConfig } from "./config.js";
import type {
  BoundingBox,
  SituationDataLicense,
  SituationFeature,
  SituationQuery,
  SourceDescriptor,
  SourceFetchResult,
  SourceHealthStatus
} from "./types.js";

const COORDINATE_FACTOR = 360 / 2 ** 24;
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
}

interface ConditionalFeedState<T> {
  etag?: string;
  lastModified?: string;
  fetchedAtMs?: number;
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
    records.push({
      messageId,
      versionId: firstEnding(message.values, "/versionID"),
      observedAt: firstEnding(method.values, "/startTime") ?? message.documentTimestamp ?? new Date().toISOString(),
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
      observedAt:
        firstEnding(message.values, "/messageGenerationTime") ?? message.documentTimestamp ?? new Date().toISOString(),
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
  private refreshPromise?: Promise<void>;
  private lastSuccessfulRefresh?: string;
  private lastError?: string;
  private staticRevision?: string;
  private dynamicRevision?: string;

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
    const warnings = this.lastError ? [`TPEG2 is serving the last valid snapshot: ${this.lastError}`] : [];
    return { source: this.descriptor, fetchedAt, features, warnings };
  }

  async healthStatus(): Promise<SourceHealthStatus> {
    return {
      sourceId: "tpeg2",
      status: this.config.tpeg2ApiToken && !this.lastError ? "ok" : "degraded",
      backend: "authenticated-tpeg2-api",
      objectCount: (this.dynamicFeed.value?.length ?? 0) + (this.tecFeed.value?.length ?? 0),
      lastImportAt: this.lastSuccessfulRefresh,
      warnings: [
        ...(!this.config.tpeg2ApiToken ? ["TPEG2_API_TOKEN is not configured."] : []),
        ...(this.lastError ? [this.lastError] : [])
      ]
    };
  }

  async trafficSnapshot(includeStatic = false): Promise<Tpeg2TrafficSnapshot> {
    if (!this.config.tpeg2ApiToken) {
      throw new Error("TPEG2 source is enabled but server-side authentication is not configured");
    }
    await this.ensureFresh(true);
    const segments = Array.from(this.staticFeed.value?.values() ?? []);
    const flows = this.dynamicFeed.value ?? [];
    return {
      generatedAt: this.lastSuccessfulRefresh ?? new Date().toISOString(),
      staticRevision:
        this.staticRevision ??= snapshotRevision(segments.map((segment) => [segment.messageId, segment.coordinates])),
      dynamicRevision:
        this.dynamicRevision ??=
          snapshotRevision(flows.map((flow) => [flow.messageId, flow.versionId, flow.observedAt, flow.validUntil, flow.averageSpeedKph])),
      ...(includeStatic ? { segments } : {}),
      flows
    };
  }

  private async ensureFresh(waitForRefresh = false): Promise<void> {
    const maxAgeMs = this.config.tpeg2DynamicCacheTtlSeconds * 1000;
    if (this.dynamicFeed.fetchedAtMs && Date.now() - this.dynamicFeed.fetchedAtMs < maxAgeMs) {
      return;
    }
    this.refreshPromise ??= this.refresh().finally(() => {
      this.refreshPromise = undefined;
    });
    if (!waitForRefresh && this.staticFeed.value && this.dynamicFeed.value && this.tecFeed.value) {
      void this.refreshPromise.catch(() => undefined);
      return;
    }
    await this.refreshPromise;
  }

  private async refresh(): Promise<void> {
    try {
      const staticMaxAgeMs = this.config.tpeg2StaticCacheTtlSeconds * 1000;
      if (!this.staticFeed.fetchedAtMs || Date.now() - this.staticFeed.fetchedAtMs >= staticMaxAgeMs) {
        await this.fetchConditional("/dev/tpeg/tfp-static", this.staticFeed, parseTpeg2Static);
        this.staticRevision = undefined;
      }
      await Promise.all([
        this.fetchConditional("/dev/tpeg/tfp-dynamic", this.dynamicFeed, parseTpeg2Dynamic),
        this.fetchConditional("/dev/tpeg/tec", this.tecFeed, parseTpeg2Tec)
      ]);
      this.dynamicFeed.value = this.dynamicFeed.value?.slice(0, this.config.tpeg2MaxRecords);
      this.tecFeed.value = this.tecFeed.value?.slice(0, this.config.tpeg2MaxRecords);
      this.dynamicRevision = undefined;
      this.lastSuccessfulRefresh = new Date().toISOString();
      this.lastError = undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown provider failure";
      this.lastError = message;
      if (!this.staticFeed.value || !this.dynamicFeed.value || !this.tecFeed.value) {
        throw error;
      }
      const retryBackoffStartedAt = Date.now();
      this.staticFeed.fetchedAtMs = retryBackoffStartedAt;
      this.dynamicFeed.fetchedAtMs = retryBackoffStartedAt;
      this.tecFeed.fetchedAtMs = retryBackoffStartedAt;
    }
  }

  private async fetchConditional<T>(
    path: string,
    state: ConditionalFeedState<T>,
    parser: (input: XmlInput) => Promise<T>
  ): Promise<void> {
    const url = new URL(path, this.config.tpeg2BaseUrl);
    url.searchParams.set("token", this.config.tpeg2ApiToken ?? "");
    const headers: Record<string, string> = { Accept: "application/xml", "Accept-Encoding": "gzip" };
    if (state.etag) headers["If-None-Match"] = state.etag;
    if (state.lastModified) headers["If-Modified-Since"] = state.lastModified;
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(this.config.tpeg2RequestTimeoutMs)
    });
    if (response.status === 304 && state.value) {
      state.fetchedAtMs = Date.now();
      return;
    }
    if (!response.ok || !response.body) {
      throw new Error(`TPEG2 provider returned HTTP ${response.status} for ${path}`);
    }
    const value = await parser(response.body as unknown as AsyncIterable<Uint8Array>);
    state.value = value;
    state.etag = response.headers.get("etag") ?? undefined;
    state.lastModified = response.headers.get("last-modified") ?? undefined;
    state.fetchedAtMs = Date.now();
  }
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
  let longitude = encoded[0]!.longitude;
  let latitude = encoded[0]!.latitude;
  const decoded: Array<[number, number]> = [[longitude * COORDINATE_FACTOR, latitude * COORDINATE_FACTOR]];
  for (const coordinate of encoded.slice(1)) {
    longitude += coordinate.longitude;
    latitude += coordinate.latitude;
    decoded.push([longitude * COORDINATE_FACTOR, latitude * COORDINATE_FACTOR]);
  }
  return decoded;
}

function decodeOpenLrProperties(message: ParsedMessage): Tpeg2StaticSegment["openlr"] {
  const method = message.methods.find((candidate) =>
    Array.from(candidate.values.keys()).some((path) => path.includes("/optionLinearLocationReference/"))
  );
  if (!method) return undefined;
  const roleIndexes = new Map<string, number>();
  const points = message.coordinates.filter((coordinate) => coordinate.kind === "openlr").map((coordinate) => {
    const prefix = `/optionLinearLocationReference/${coordinate.role}`;
    const index = roleIndexes.get(coordinate.role) ?? 0;
    roleIndexes.set(coordinate.role, index + 1);
    const property = (map: Map<string, string[]>, suffix: string) => endingAt(map, `${prefix}${suffix}`, index);
    const bearing = numberOrUndefined(property(method.values, "/lineProperties/bearing/value"));
    const distanceToNext = numberOrUndefined(property(method.values, "/pathProperties/dnp/value"));
    const againstDrivingDirection = property(method.values, "/pathProperties/againstDrivingDirection");
    return {
      role: coordinate.role,
      ...(property(method.codes, "/lineProperties/frc") !== undefined
        ? { frc: property(method.codes, "/lineProperties/frc") } : {}),
      ...(property(method.codes, "/lineProperties/fow") !== undefined
        ? { fow: property(method.codes, "/lineProperties/fow") } : {}),
      ...(bearing !== undefined ? { bearing } : {}),
      ...(property(method.codes, "/pathProperties/lfrcnp") !== undefined
        ? { lowestFrcToNext: property(method.codes, "/pathProperties/lfrcnp") } : {}),
      ...(distanceToNext !== undefined ? { distanceToNext } : {}),
      ...(againstDrivingDirection === "true" || againstDrivingDirection === "false"
        ? { againstDrivingDirection: againstDrivingDirection === "true" } : {})
    };
  });
  return points.length > 0 ? { points } : undefined;
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
  const geometry = event.coordinates.length === 1
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
