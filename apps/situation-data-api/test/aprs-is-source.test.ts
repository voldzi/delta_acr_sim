import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AprsIsSource, parseAprsIsPacket } from "../src/aprs-is-source.js";
import type { SituationDataConfig } from "../src/config.js";
import type { SituationQuery } from "../src/types.js";

const receivedAt = new Date("2026-09-24T12:00:00.000Z");
const query: SituationQuery = {
  bbox: { west: 14, south: 49, east: 15, north: 50 },
  layers: ["aprs"],
  sourceIds: ["aprs_is"],
  limit: 100,
  includeRaw: false
};
const config = (port: number) => ({
  enabledSources: ["aprs_is"],
  aprsIsCallsign: "N0CALL",
  aprsIsHost: "127.0.0.1",
  aprsIsPort: port,
  aprsIsWindowMs: 80,
  aprsIsCacheTtlSeconds: 30,
  aprsIsFreshSeconds: 600,
  aprsIsMaxBboxDegrees: 2,
  aprsIsMaxStations: 500,
  aprsIsMaxRequestsPerMinute: 12
}) as SituationDataConfig;

describe("APRS-IS source", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("keeps SSIDs distinct and classifies fixed/mobile from symbols, not SSID", () => {
    const fixed = parseAprsIsPacket("OK3JS-6>APRS,TCPIP*:=4959.00N/01430.00E-House", receivedAt);
    const mobile = parseAprsIsPacket("OK3JS-10>APRS,TCPIP*:=4959.10N/01430.10E>123/045", receivedAt);
    expect(fixed).toMatchObject({ callsign: "OK3JS-6", coordinates: [14.5, 49.983333333333334], stationType: "fixed", symbol: "-" });
    expect(mobile).toMatchObject({ callsign: "OK3JS-10", stationType: "mobile", symbol: ">" });
    expect(fixed?.callsign).not.toBe(mobile?.callsign);
  });

  it("marks missing and invalid positions explicitly", () => {
    expect(parseAprsIsPacket("OK3JS-6>APRS,TCPIP*::DEST     :text", receivedAt)?.positionQuality).toBe("missing");
    expect(parseAprsIsPacket("OK3JS-6>APRS,TCPIP*:=not-a-position", receivedAt)?.positionQuality).toBe("invalid");
  });

  it("bounds area, receives on demand, caches results and preserves stale state", async () => {
    let connections = 0;
    let login = "";
    server = createServer((socket) => {
      connections++;
      socket.once("data", (data) => {
        login = data.toString();
        socket.write("OK3JS-6>APRS,TCPIP*:=4959.00N/01430.00E-House\r\n");
        socket.write("OK3JS-10>APRS,TCPIP*:=4959.10N/01430.10E>123/045\r\n");
      });
    }).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const source = new AprsIsSource({ ...config((server.address() as { port: number }).port), aprsIsMaxRequestsPerMinute: 1 });
    const started = performance.now();
    const first = await source.fetchFeatures(query);
    const firstLatencyMs = performance.now() - started;
    const cachedStarted = performance.now();
    const second = await source.fetchFeatures(query);
    const cachedLatencyMs = performance.now() - cachedStarted;
    expect(firstLatencyMs).toBeLessThan(500);
    expect(cachedLatencyMs).toBeLessThan(firstLatencyMs);
    expect(first.features.map((item) => item.id)).toEqual(["aprs:aprs_is:OK3JS-6", "aprs:aprs_is:OK3JS-10"]);
    expect(first.features[0]?.properties.providerProperties).toMatchObject({ reportAt: null, reportTimeQuality: "sim_received_only", positionState: "reported" });
    expect(first.features[0]?.properties.license).toMatchObject({ url: "https://www.aprs-is.net/" });
    expect(second.features).toHaveLength(2);
    expect(connections).toBe(1);
    expect(login).toContain("pass -1");
    expect(login).toContain("filter a/50/14/49/15");
    const tooWide = await source.fetchFeatures({ ...query, bbox: { west: 11, south: 48, east: 19, north: 51 } });
    expect(tooWide.features).toHaveLength(0);
    expect(tooWide.warnings[0]).toContain("limit");
    const limited = await source.fetchFeatures({ ...query, bbox: { west: 14, south: 49, east: 14.9, north: 50 } });
    expect(limited.features).toHaveLength(0);
    expect(limited.warnings[0]).toContain("request limit");
    expect(connections).toBe(1);
  });

  it("omits missing positions and labels old positions as stale", async () => {
    server = createServer((socket) => {
      socket.once("data", () => {
        socket.write("OK3JS-6>APRS,TCPIP*:/011200h4959.00N/01430.00E-House\r\n");
        socket.write("OK3JS-10>APRS,TCPIP*::DEST     :no position\r\n");
      });
    }).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const source = new AprsIsSource(config((server.address() as { port: number }).port));
    const result = await source.fetchFeatures(query);
    expect(result.features).toHaveLength(1);
    expect(result.features[0]?.properties.stale).toBe(true);
    expect(result.features[0]?.properties.providerProperties).toMatchObject({ positionState: "stale", reportTimeQuality: "packet_utc" });
    expect((await source.healthStatus()).noPositionCount).toBe(1);
  });

  it("backs off on provider failure without blocking other sources", async () => {
    const source = new AprsIsSource(config(1));
    const first = await source.fetchFeatures(query);
    const second = await source.fetchFeatures(query);
    expect(first.features).toEqual([]);
    expect(first.warnings[0]).toContain("unavailable");
    expect(second.warnings[0]).toContain("temporarily unavailable");
    expect((await source.healthStatus()).status).toBe("degraded");
  });

  it("marks an old timestamp as stale", () => {
    const old = parseAprsIsPacket("OK3JS-6>APRS,TCPIP*:/011200h4959.00N/01430.00E-House", new Date("2026-09-24T12:00:00Z"));
    expect(old?.reportAt).toBe("2026-09-24T01:12:00.000Z");
    expect(old?.timeQuality).toBe("packet_utc");
  });
});
