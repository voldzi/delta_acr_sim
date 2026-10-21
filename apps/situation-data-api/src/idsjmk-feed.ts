import gtfsRealtime from "gtfs-realtime-bindings";
import type { SituationDataConfig } from "./config.js";
import { ManagedResponseCache } from "./response-cache.js";
import type { IdsjmkVehicleFeed, IdsjmkVehicleRecord } from "./sources.js";

export const IDSJMK_GTFS_RT_URL = "https://kordis-jmk.cz/gtfs/gtfsReal.dat";
export const IDSJMK_POSITION_MAX_AGE_MS = 120_000;
const MAX_BYTES = 8 * 1024 * 1024;
const clients = new WeakMap<SituationDataConfig, IdsjmkFeedClient>();
export const idsjmkRefreshSeconds = (config: SituationDataConfig): number => Math.max(30, config.idsjmkVehiclePositionsCacheTtlSeconds);
const seconds = (value: unknown): number | undefined => {
  const n = typeof value === "number" ? value : value && typeof value === "object" && "toNumber" in value
    ? (value as { toNumber(): number }).toNumber() : undefined;
  return n !== undefined && Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

export function parseIdsjmkGtfsRt(bytes: Uint8Array, now = Date.now()): IdsjmkVehicleFeed {
  const feed = gtfsRealtime.transit_realtime.FeedMessage.decode(bytes);
  const timestamp = seconds(feed.header?.timestamp);
  if (!timestamp || timestamp * 1000 > now + 30_000 || feed.header?.incrementality === 1)
    throw new Error("IDS JMK requires a full GTFS-RT snapshot with a valid source timestamp");
  if (feed.entity.length > 50_000) throw new Error("IDS JMK GTFS-RT entity limit exceeded");
  const vehicles: IdsjmkVehicleRecord[] = [];
  let invalidCoordinates = 0, invalidTimestamps = 0, missingIdentity = 0;
  const seen = new Set<string>();
  for (const entity of feed.entity) {
    if (entity.isDeleted || !entity.vehicle) continue;
    const v = entity.vehicle, p = v.position;
    if (!p || !Object.hasOwn(p, "latitude") || !Object.hasOwn(p, "longitude") || !Number.isFinite(p.latitude) || !Number.isFinite(p.longitude) ||
        Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180) { invalidCoordinates++; continue; }
    const observed = seconds(v.timestamp);
    // Header/fetch time must never substitute for a missing vehicle observation.
    if (!observed || observed * 1000 > now + 30_000) { invalidTimestamps++; continue; }
    const id = v.vehicle?.id?.trim() || (entity.id?.trim() ? `entity:${entity.id}` : "");
    if (!id || seen.has(id)) { missingIdentity++; continue; }
    seen.add(id);
    vehicles.push({ vehicleId: id, lon: p.longitude, lat: p.latitude, lastUpdate: new Date(observed * 1000).toISOString(),
      routeId: v.trip?.routeId || undefined, tripId: v.trip?.tripId || undefined,
      speedMps: Object.hasOwn(p, "speed") && Number.isFinite(p.speed) && p.speed! >= 0 ? p.speed : undefined,
      bearing: Object.hasOwn(p, "bearing") && Number.isFinite(p.bearing) && p.bearing! >= 0 && p.bearing! < 360 ? p.bearing : undefined,
      stopId: v.stopId || undefined, currentStopSequence: v.currentStopSequence || undefined,
      _gtfsRt: true, _feedObservedAt: new Date(timestamp * 1000).toISOString() });
  }
  return { LastUpdate: new Date(timestamp * 1000).toISOString(), Vehicles: vehicles, _gtfsRt: true,
    _omitted: invalidCoordinates + invalidTimestamps + missingIdentity,
    _invalidCoordinates: invalidCoordinates, _invalidTimestamps: invalidTimestamps, _missingIdentity: missingIdentity };
}

export function idsjmkFeedClient(config: SituationDataConfig): IdsjmkFeedClient {
  let client = clients.get(config);
  if (!client) { client = new IdsjmkFeedClient(config); clients.set(config, client); }
  return client;
}

export class IdsjmkFeedClient {
  private readonly cache;
  private nextAllowedAt = 0;
  private failures = 0;
  private snapshot?: IdsjmkVehicleFeed;
  private upstreamRequests = 0;
  constructor(private readonly config: SituationDataConfig) {
    this.cache = new ManagedResponseCache<IdsjmkVehicleFeed>({ ttlMs: idsjmkRefreshSeconds(config) * 1000,
      staleIfErrorMs: IDSJMK_POSITION_MAX_AGE_MS, maxEntries: 1 });
  }
  stats() { return this.cache.stats(); }
  diagnostics() { return { upstreamRequests: this.upstreamRequests, nextAllowedAt: this.nextAllowedAt,
    snapshot: this.snapshot, failureBackoff: this.failures > 0 }; }
  load(): Promise<IdsjmkVehicleFeed> { return this.cache.getOrLoad("snapshot", () => this.fetch()); }
  private async fetch(): Promise<IdsjmkVehicleFeed> {
    if (Date.now() < this.nextAllowedAt) throw new Error("IDS JMK provider backoff active; no upstream request issued");
    const ttl = idsjmkRefreshSeconds(this.config) * 1000;
    this.nextAllowedAt = Date.now() + ttl;
    this.upstreamRequests++;
    let retryAt = 0;
    try {
      const response = await fetch(this.config.idsjmkVehiclePositionsUrl, {
        headers: { accept: "application/x-protobuf,application/octet-stream,application/json", "user-agent": "CSM-SIM/1.0 (server-side shared transit cache)" },
        redirect: "error", signal: AbortSignal.timeout(this.config.requestTimeoutMs) });
      if (!response.ok) {
        const retry = response.headers.get("retry-after");
        if (retry) retryAt = /^\d+$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry);
        throw new Error("IDS JMK upstream HTTP " + response.status);
      }
      if (Number(response.headers.get("content-length")) > MAX_BYTES) throw new Error("IDS JMK feed exceeds size limit");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("IDS JMK feed body missing");
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); throw new Error("IDS JMK feed exceeds size limit"); }
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks);
      const first = new TextDecoder().decode(bytes.subarray(0, 40)).trimStart()[0];
      // Keep explicitly configured legacy JSON feeds compatible; never try another URL.
      const result: IdsjmkVehicleFeed = first === "{" || first === "[" ? JSON.parse(bytes.toString("utf8")) : parseIdsjmkGtfsRt(bytes);
      this.snapshot = result;
      this.failures = 0;
      this.nextAllowedAt = Date.now() + ttl;
      return result;
    } catch (error) {
      this.failures++;
      this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + Math.min(900_000, ttl * 2 ** Math.min(this.failures - 1, 5)),
        Number.isFinite(retryAt) ? retryAt : 0);
      throw new Error(error instanceof Error && error.message.startsWith("IDS JMK ") ? error.message : "IDS JMK feed unavailable or invalid");
    }
  }
}
