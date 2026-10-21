import { afterEach, describe, expect, it, vi } from "vitest";
import gtfsRealtime from "gtfs-realtime-bindings";
import { IdsjmkFeedClient, parseIdsjmkGtfsRt } from "../src/idsjmk-feed.js";
import type { SituationDataConfig } from "../src/config.js";

const now = 1_790_000_000_000;
const encode = (entities: object[], header: object = {}) => gtfsRealtime.transit_realtime.FeedMessage.encode({
  header: { gtfsRealtimeVersion: "2.0", timestamp: now / 1000, ...header }, entity: entities
}).finish();
const vehicle = (id: string, timestamp: number | undefined = now / 1000) => ({ id,
  vehicle: { vehicle: { id }, position: { latitude: 49.2, longitude: 16.6 }, timestamp } });
const config = { idsjmkVehiclePositionsCacheTtlSeconds: 30, requestTimeoutMs: 1000,
  idsjmkVehiclePositionsUrl: "https://example.invalid/feed" } as SituationDataConfig;

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("official IDS JMK shared GTFS-RT feed", () => {
  it("preserves actual observation time and omits missing/future timestamps and coordinates", () => {
    const bytes = encode([vehicle("fresh"), vehicle("old", now / 1000 - 600), vehicle("missing", undefined),
      vehicle("future", now / 1000 + 60), { id: "no-position", vehicle: { timestamp: now / 1000 } }]);
    // Explicitly remove the default supplied by the fixture helper.
    const decoded = gtfsRealtime.transit_realtime.FeedMessage.decode(bytes);
    delete decoded.entity[2]!.vehicle!.timestamp;
    const result = parseIdsjmkGtfsRt(gtfsRealtime.transit_realtime.FeedMessage.encode(decoded).finish(), now);
    expect(result.Vehicles).toHaveLength(2);
    expect(result.Vehicles![1]!.lastUpdate).toBe(new Date(now - 600_000).toISOString());
    expect(result._invalidTimestamps).toBe(2);
    expect(result._invalidCoordinates).toBe(1);
  });
  it("rejects differential or future snapshots", () => {
    expect(() => parseIdsjmkGtfsRt(encode([], { incrementality: 1 }), now)).toThrow();
    expect(() => parseIdsjmkGtfsRt(encode([], { timestamp: now / 1000 + 60 }), now)).toThrow();
  });
  it("coalesces 1000 consumers into one provider request", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const fetcher = vi.fn(async () => new Response(encode([vehicle("one")])));
    vi.stubGlobal("fetch", fetcher);
    const client = new IdsjmkFeedClient(config);
    const results = await Promise.all(Array.from({ length: 1000 }, () => client.load()));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results.every(r => r === results[0])).toBe(true);
    expect(client.diagnostics().upstreamRequests).toBe(1);
  });
  it("honours Retry-After without retrying per user", async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const fetcher = vi.fn(async () => new Response(null, { status: 429, headers: { "retry-after": "120" } }));
    vi.stubGlobal("fetch", fetcher);
    const client = new IdsjmkFeedClient(config);
    await expect(client.load()).rejects.toThrow();
    vi.setSystemTime(now + 31_000);
    await expect(client.load()).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
