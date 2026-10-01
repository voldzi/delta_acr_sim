import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SituationDataConfig } from "../src/config.js";
import { Tpeg2Source, parseTpeg2Dynamic, parseTpeg2Static, parseTpeg2Tec } from "../src/tpeg2-source.js";

const document = (type: "TFP" | "TEC", body: string) => `
  <TPEGDocument timeStamp="2026-09-14T12:00:00Z" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:tfp="http://www.tisa.org/TPEG/TFP_1_1" xmlns:tec="http://www.tisa.org/TPEG/TEC_3_4">
    <ApplicationRootMessageML xsi:type="${type === "TFP" ? "tfp:TFPMessage" : "tec:TECMessage"}">${body}</ApplicationRootMessageML>
  </TPEGDocument>`;

describe("TPEG2 streaming parsers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  it("joins an OpenLR static segment to its message id and decodes signed deltas", async () => {
    const parsed = await parseTpeg2Static(
      document(
        "TFP",
        `
      <mmt><optionMMCPartLink><messageID>42</messageID><partID>1</partID></optionMMCPartLink></mmt>
      <loc>
        <method><optionTMCLocationReferenceLink><locationID>37307</locationID><countryCode>11</countryCode><locationTableNumber>25</locationTableNumber></optionTMCLocationReferenceLink></method>
        <method><optionOpenLRLocationReferenceLink><locationReference><optionLinearLocationReference>
          <first><coordinate><longitude>583571</longitude><latitude>2313505</latitude></coordinate><lineProperties><frc code="0"/><fow code="1"/><bearing><value>42</value></bearing></lineProperties><pathProperties><lfrcnp code="0"/><dnp><value>287</value></dnp><againstDrivingDirection>false</againstDrivingDirection></pathProperties></first>
          <last><coordinate><longitude>-355</longitude><latitude>119</latitude></coordinate><lineProperties><frc code="0"/><fow code="1"/><bearing><value>172</value></bearing></lineProperties></last>
          <positiveOffset><value>25</value></positiveOffset>
        </optionLinearLocationReference></locationReference></optionOpenLRLocationReferenceLink></method>
      </loc>`
      )
    );

    const segment = parsed.get("42");
    expect(segment?.locationId).toBe("37307");
    expect(segment?.coordinates).toHaveLength(2);
    expect(segment?.coordinates[0]?.[0]).toBeCloseTo(12.5223, 3);
    expect(segment?.coordinates[1]?.[0]).toBeLessThan(segment!.coordinates[0]![0]);
    expect(segment?.coordinates[1]?.[0]).toBeCloseTo(segment!.coordinates[0]![0] - 0.00355, 7);
    expect(segment?.coordinates[1]?.[1]).toBeCloseTo(segment!.coordinates[0]![1] + 0.00119, 7);
    expect(segment?.openlr?.positiveOffsetMeters).toBe(25);
    expect(segment?.openlr?.points).toEqual([
      { role: "first", frc: "0", fow: "1", bearing: 42, lowestFrcToNext: "0", distanceToNext: 287, againstDrivingDirection: false },
      { role: "last", frc: "0", fow: "1", bearing: 172 }
    ]);
  });

  it("keeps each intermediate OpenLR point's own direction and road class", async () => {
    const parsed = await parseTpeg2Static(
      document(
        "TFP",
        `
      <mmt><optionMMCPartLink><messageID>43</messageID><partID>1</partID></optionMMCPartLink></mmt>
      <loc><method><optionOpenLRLocationReferenceLink><locationReference><optionLinearLocationReference>
        <first><coordinate><longitude>583571</longitude><latitude>2313505</latitude></coordinate><lineProperties><frc code="0"/></lineProperties></first>
        <intermediate><coordinate><longitude>100</longitude><latitude>50</latitude></coordinate><lineProperties><frc code="1"/><bearing><value>90</value></bearing></lineProperties></intermediate>
        <intermediate><coordinate><longitude>100</longitude><latitude>50</latitude></coordinate><lineProperties><frc code="2"/><bearing><value>180</value></bearing></lineProperties></intermediate>
        <last><coordinate><longitude>100</longitude><latitude>50</latitude></coordinate><lineProperties><frc code="3"/></lineProperties></last>
      </optionLinearLocationReference></locationReference></optionOpenLRLocationReferenceLink></method></loc>`
      )
    );
    expect(parsed.get("43")?.openlr?.points).toEqual([
      { role: "first", frc: "0" },
      { role: "intermediate", frc: "1", bearing: 90 },
      { role: "intermediate", frc: "2", bearing: 180 },
      { role: "last", frc: "3" }
    ]);
  });

  it("uses the unrestricted TFP flow method instead of vehicle-specific alternatives", async () => {
    const records = await parseTpeg2Dynamic(
      document(
        "TFP",
        `
      <mmt><optionMMCPartLink><messageID>42</messageID><versionID>7</versionID><messageExpiryTime>2026-09-14T12:10:00Z</messageExpiryTime><cancelFlag>false</cancelFlag><partID>2</partID></optionMMCPartLink></mmt>
      <method><optionFlowStatus><startTime>2026-09-14T12:00:00Z</startTime><status><LOS code="3"/><averageSpeed>89</averageSpeed><freeFlowTravelTime>71</freeFlowTravelTime><delay>36</delay></status><statistics><FlowQuality code="4"/></statistics></optionFlowStatus></method>
      <method><optionFlowStatus><startTime>2026-09-14T12:00:00Z</startTime><status><LOS code="1"/><averageSpeed>20</averageSpeed></status><restriction><vehicleClassAssignment code="1"/></restriction></optionFlowStatus></method>`
      )
    );

    expect(records).toEqual([expect.objectContaining({ messageId: "42", averageSpeedKph: 89, delaySeconds: 36, losCode: "3", qualityCode: "4" })]);
  });

  it("maps TEC free text, validity, codes and geographic line coordinates", async () => {
    const records = await parseTpeg2Tec(
      document(
        "TEC",
        `
      <mmt><optionMessageManagement><messageID>99</messageID><versionID>2</versionID><messageExpiryTime>2026-09-15T12:00:00Z</messageExpiryTime><cancelFlag>false</cancelFlag><messageGenerationTime>2026-09-14T11:59:00Z</messageGenerationTime></optionMessageManagement></mmt>
      <event><effectCode code="7"/><startTime>2026-09-14T12:00:00Z</startTime><stopTime>2026-09-15T10:00:00Z</stopTime><cause><optionDirectCause><mainCause code="10"/><warningLevel code="3"/><unverifiedInformation>true</unverifiedInformation><freeText><value>  uzavřená   komunikace  </value></freeText></optionDirectCause></cause></event>
      <loc><method><optionGeographicLocationReferenceLink><geographicLineReference>
        <linePoints><Longitude>676828</Longitude><Latitude>2282845</Latitude></linePoints>
        <linePoints><Longitude>676791</Longitude><Latitude>2282811</Latitude></linePoints>
      </geographicLineReference></optionGeographicLocationReferenceLink></method></loc>`
      )
    );

    expect(records).toEqual([
      expect.objectContaining({
        messageId: "99",
        label: "uzavřená komunikace",
        effectCode: "7",
        mainCauseCode: "10",
        warningLevelCode: "3",
        unverified: true
      })
    ]);
    expect(records[0]?.coordinates).toHaveLength(2);
    expect(records[0]?.coordinates[0]?.[0]).toBeCloseTo(14.523, 2);
  });

  it("drops cancelled dynamic messages", async () => {
    const records = await parseTpeg2Dynamic(
      document(
        "TFP",
        `
      <mmt><optionMMCPartLink><messageID>42</messageID><cancelFlag>true</cancelFlag><partID>2</partID></optionMMCPartLink></mmt>
      <method><optionFlowStatus><status><averageSpeed>50</averageSpeed></status></optionFlowStatus></method>`
      )
    );
    expect(records).toEqual([]);
  });

  it("keeps the API token and raw XML out of the normalized feature response", async () => {
    const staticXml = document(
      "TFP",
      `
      <mmt><optionMMCPartLink><messageID>42</messageID><partID>1</partID></optionMMCPartLink></mmt>
      <loc><method><optionOpenLRLocationReferenceLink><locationReference><optionLinearLocationReference>
        <first><coordinate><longitude>583571</longitude><latitude>2313505</latitude></coordinate></first>
        <last><coordinate><longitude>355</longitude><latitude>119</latitude></coordinate></last>
      </optionLinearLocationReference></locationReference></optionOpenLRLocationReferenceLink></method></loc>`
    );
    const dynamicXml = document(
      "TFP",
      `
      <mmt><optionMMCPartLink><messageID>42</messageID><versionID>7</versionID><cancelFlag>false</cancelFlag><partID>2</partID></optionMMCPartLink></mmt>
      <method><optionFlowStatus><startTime>2026-09-14T12:00:00Z</startTime><status><averageSpeed>89</averageSpeed><delay>36</delay></status></optionFlowStatus></method>`
    );
    const tecXml = document(
      "TEC",
      `
      <mmt><optionMessageManagement><messageID>99</messageID><cancelFlag>false</cancelFlag></optionMessageManagement></mmt>
      <event><cause><optionDirectCause><freeText><value>Omezení provozu</value></freeText></optionDirectCause></cause></event>
      <loc><method><optionGeographicLocationReferenceLink><geographicLineReference><linePoints><Longitude>676828</Longitude><Latitude>2282845</Latitude></linePoints></geographicLineReference></optionGeographicLocationReferenceLink></method></loc>`
    );
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("token")).toBe("test-provider-secret");
      const body = url.pathname.endsWith("tfp-static") ? staticXml : url.pathname.endsWith("tfp-dynamic") ? dynamicXml : tecXml;
      return new Response(body, { status: 200, headers: { ETag: '"fixture"', "Last-Modified": "Sun, 14 Sep 2026 12:00:00 GMT" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const source = new Tpeg2Source({
      enabledSources: ["tpeg2"],
      tpeg2BaseUrl: "https://online.ceda.cz",
      tpeg2ApiToken: "test-provider-secret",
      tpeg2DynamicCacheTtlSeconds: 300,
      tpeg2StaticCacheTtlSeconds: 86400,
      tpeg2RequestTimeoutMs: 10000,
      tpeg2MaxRecords: 50000
    } as SituationDataConfig);

    const result = await source.fetchFeatures({
      bbox: { west: 11, south: 48, east: 19, north: 52 },
      layers: ["traffic"],
      sourceIds: ["tpeg2"],
      limit: 10,
      includeRaw: true
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.features.map((feature) => feature.properties.category)).toEqual(["road_traffic_flow", "road_traffic_event"]);
    expect(JSON.stringify(result)).not.toContain("test-provider-secret");
    expect(result.features.every((feature) => feature.properties.raw === undefined)).toBe(true);
  });

  it("waits for refreshed TPEG2 speeds before handing a snapshot to Valhalla", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
    vi.setSystemTime(new Date("2026-09-25T15:00:00Z"));
    const staticXml = document(
      "TFP",
      `<mmt><optionMMCPartLink><messageID>42</messageID><partID>1</partID></optionMMCPartLink></mmt><loc><method><optionOpenLRLocationReferenceLink><locationReference><optionLinearLocationReference><first><coordinate><longitude>583571</longitude><latitude>2313505</latitude></coordinate></first><last><coordinate><longitude>355</longitude><latitude>119</latitude></coordinate></last></optionLinearLocationReference></locationReference></optionOpenLRLocationReferenceLink></method></loc>`
    );
    const flowXml = (speed: number) =>
      document(
        "TFP",
        `<mmt><optionMMCPartLink><messageID>42</messageID><partID>2</partID></optionMMCPartLink></mmt><method><optionFlowStatus><startTime>2026-09-25T15:00:00Z</startTime><status><averageSpeed>${speed}</averageSpeed></status></optionFlowStatus></method>`
      );
    let dynamicRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("tfp-static")) return new Response(staticXml);
        if (path.endsWith("tfp-dynamic")) return new Response(flowXml(++dynamicRequests === 1 ? 40 : 65));
        return new Response(document("TEC", ""));
      })
    );
    const source = new Tpeg2Source({
      enabledSources: ["tpeg2"],
      tpeg2BaseUrl: "https://online.ceda.cz",
      tpeg2ApiToken: "test-provider-secret",
      tpeg2DynamicCacheTtlSeconds: 300,
      tpeg2StaticCacheTtlSeconds: 86400,
      tpeg2RequestTimeoutMs: 10000,
      tpeg2MaxRecords: 50000
    } as SituationDataConfig);
    expect((await source.trafficSnapshot()).flows[0]?.averageSpeedKph).toBe(40);
    await vi.advanceTimersByTimeAsync(301000);
    expect((await source.trafficSnapshot()).flows[0]?.averageSpeedKph).toBe(65);
    expect(dynamicRequests).toBe(2);
  });
});

describe("TPEG2 independent refresh scheduling", () => {
  const sources: Tpeg2Source[] = [];
  const directories: string[] = [];
  const initialTime = Date.parse("2026-10-01T12:00:00Z");
  const query = {
    bbox: { west: 11, south: 48, east: 19, north: 52 },
    layers: ["traffic"],
    sourceIds: ["tpeg2"],
    limit: 10
  } as Parameters<Tpeg2Source["fetchFeatures"]>[0];
  const flowXml = (speed = 40) =>
    document(
      "TFP",
      `
    <mmt><optionMMCPartLink><messageID>42</messageID><partID>2</partID>
      <messageExpiryTime>2026-10-01T12:10:00Z</messageExpiryTime></optionMMCPartLink></mmt>
    <method><optionFlowStatus><startTime>2026-10-01T12:00:00Z</startTime>
      <status><averageSpeed>${speed}</averageSpeed></status></optionFlowStatus></method>`
    );
  const source = (overrides: Partial<SituationDataConfig> = {}) => {
    const value = new Tpeg2Source({
      enabledSources: ["tpeg2"],
      tpeg2BaseUrl: "https://fixture.invalid",
      tpeg2ApiToken: "synthetic-test-token",
      tpeg2DynamicCacheTtlSeconds: 300,
      tpeg2StaticCacheTtlSeconds: 86400,
      tpeg2RequestTimeoutMs: 120000,
      tpeg2MaxRecords: 50000,
      valhallaTrafficMaxAgeSeconds: 1800,
      ...overrides
    } as SituationDataConfig);
    sources.push(value);
    return value;
  };
  const pathOf = (input: string | URL | Request) => new URL(String(input)).pathname;
  const seedClock = () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
    vi.setSystemTime(initialTime);
  };

  afterEach(async () => {
    sources.splice(0).forEach((value) => value.dispose());
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("rejects missing and unzoned measurement timestamps instead of inventing observation time", async () => {
    const record = (startTime: string) =>
      document(
        "TFP",
        `<mmt><optionMMCPartLink><messageID>42</messageID><partID>2</partID></optionMMCPartLink></mmt><method><optionFlowStatus>${startTime}<status><averageSpeed>50</averageSpeed></status></optionFlowStatus></method>`
      );
    expect(await parseTpeg2Dynamic(record(""))).toEqual([]);
    expect(await parseTpeg2Dynamic(record("<startTime>2026-10-01T12:00:00</startTime>"))).toEqual([]);
    expect(await parseTpeg2Dynamic(record("<startTime>invalid</startTime>"))).toEqual([]);
    expect((await parseTpeg2Dynamic(record("<startTime>2026-10-01T14:00:00+02:00</startTime>")))[0]?.observedAt).toBe("2026-10-01T14:00:00+02:00");
  });

  it("anchors proactive requests to HTTP start despite forty-second downloads and stops at lease expiry", async () => {
    seedClock();
    const started: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (pathOf(input).endsWith("tfp-dynamic")) {
          started.push(Date.now());
          await new Promise((resolve) => setTimeout(resolve, 40000));
          return new Response(flowXml());
        }
        return new Response(document("TFP", ""));
      })
    );
    const value = source();
    value.retainTrafficUntil(initialTime + 650000);
    await vi.advanceTimersByTimeAsync(40000);
    await vi.advanceTimersByTimeAsync(300000);
    await vi.advanceTimersByTimeAsync(300000);
    expect(started.map((time) => time - initialTime)).toEqual([0, 300000, 600000]);
    await vi.advanceTimersByTimeAsync(400000);
    expect(started).toHaveLength(3);
  });

  it("coalesces map, traffic and proactive requests while preserving the minimum interval", async () => {
    seedClock();
    let dynamicRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (pathOf(input).endsWith("tfp-dynamic")) {
          dynamicRequests++;
          await new Promise((resolve) => setTimeout(resolve, 20000));
          return new Response(flowXml());
        }
        return new Response(document("TFP", ""));
      })
    );
    const value = source();
    value.retainTrafficUntil(initialTime + 900000);
    const requests = Promise.all([value.trafficSnapshot(), value.trafficSnapshot(), value.fetchFeatures(query)]);
    await vi.advanceTimersByTimeAsync(20000);
    await requests;
    expect(dynamicRequests).toBe(1);
    await value.trafficSnapshot();
    expect(dynamicRequests).toBe(1);
    value.dispose();
    await vi.advanceTimersByTimeAsync(1000000);
    expect(dynamicRequests).toBe(1);
  });

  it("gates initial failures and increases backoff without an early retry", async () => {
    seedClock();
    let dynamicRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (pathOf(input).endsWith("tfp-dynamic")) {
          dynamicRequests++;
          return new Response("synthetic failure", { status: 503 });
        }
        return new Response(document("TFP", ""));
      })
    );
    const value = source();
    for (let i = 0; i < 3; i++) await expect(value.trafficSnapshot()).rejects.toThrow("HTTP 503");
    expect(dynamicRequests).toBe(1);
    await vi.advanceTimersByTimeAsync(299999);
    await expect(value.trafficSnapshot()).rejects.toThrow("HTTP 503");
    expect(dynamicRequests).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(value.trafficSnapshot()).rejects.toThrow("HTTP 503");
    expect(dynamicRequests).toBe(2);
    await vi.advanceTimersByTimeAsync(300000);
    await expect(value.trafficSnapshot()).rejects.toThrow("HTTP 503");
    expect(dynamicRequests).toBe(2);
    await vi.advanceTimersByTimeAsync(300000);
    await expect(value.trafficSnapshot()).rejects.toThrow("HTTP 503");
    expect(dynamicRequests).toBe(3);
  });

  it("commits new TFP content and revision even while TEC fails", async () => {
    seedClock();
    let dynamicRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = pathOf(input);
        if (path.endsWith("tfp-dynamic")) return new Response(flowXml(++dynamicRequests === 1 ? 30 : 70));
        if (path.endsWith("/tec") && dynamicRequests > 1) return new Response("synthetic failure", { status: 503 });
        return new Response(document("TFP", ""));
      })
    );
    const value = source();
    await value.fetchFeatures(query);
    const before = await value.trafficSnapshot();
    await vi.advanceTimersByTimeAsync(300000);
    await value.fetchFeatures(query);
    const after = await value.trafficSnapshot();
    expect(before.flows[0]?.averageSpeedKph).toBe(30);
    expect(after.flows[0]?.averageSpeedKph).toBe(70);
    expect(after.dynamicRevision).not.toBe(before.dynamicRevision);
    expect((await value.healthStatus()).warnings).toContain("TPEG2 provider returned HTTP 503 for /dev/tpeg/tec");
  });

  it("preserves snapshot age and expiry across a conditional HTTP 304", async () => {
    seedClock();
    let dynamicRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
        if (!pathOf(input).endsWith("tfp-dynamic")) return new Response(document("TFP", ""));
        if (++dynamicRequests === 1) return new Response(flowXml(), { headers: { ETag: '"synthetic-v1"' } });
        expect(options?.headers).toEqual(expect.objectContaining({ "If-None-Match": '"synthetic-v1"' }));
        return new Response(null, { status: 304 });
      })
    );
    const value = source();
    const before = await value.trafficSnapshot();
    await vi.advanceTimersByTimeAsync(300000);
    const after = await value.trafficSnapshot();
    expect(after.generatedAt).toBe(before.generatedAt);
    expect(after.dynamicRevision).toBe(before.dynamicRevision);
    expect(after.flows).toEqual(before.flows);
    expect(after.sourceTiming?.lastChangedAt).toBe(before.sourceTiming?.lastChangedAt);
    expect(after.sourceTiming?.lastCheckedAt).toBe(new Date(initialTime + 300000).toISOString());
    expect(after.sourceTiming?.lastResponseStatus).toBe(304);
    expect(after.sourceTiming?.nextRefreshAt).toBe(new Date(initialTime + 600000).toISOString());
  });

  it("honors Retry-After beyond the normal minimum interval", async () => {
    seedClock();
    let dynamicRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (pathOf(input).endsWith("tfp-dynamic")) {
          dynamicRequests++;
          return new Response("synthetic rate limit", { status: 429, headers: { "Retry-After": "900" } });
        }
        return new Response(document("TFP", ""));
      })
    );
    const value = source();
    await expect(value.trafficSnapshot()).rejects.toThrow("HTTP 429");
    await vi.advanceTimersByTimeAsync(899999);
    await expect(value.trafficSnapshot()).rejects.toThrow("HTTP 429");
    expect(dynamicRequests).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(value.trafficSnapshot()).rejects.toThrow("HTTP 429");
    expect(dynamicRequests).toBe(2);
  });

  it("fails closed without provider calls when configured request timing cannot be persisted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sim-tpeg-gate-"));
    directories.push(directory);
    const blocker = join(directory, "not-a-directory");
    await writeFile(blocker, "synthetic fixture");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(source({ valhallaTrafficCacheDir: blocker }).trafficSnapshot()).rejects.toThrow("persisted request timing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists a timing-only gate without source records or credentials", async () => {
    seedClock();
    const directory = await mkdtemp(join(tmpdir(), "sim-tpeg-gate-"));
    directories.push(directory);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => new Response(pathOf(input).endsWith("tfp-dynamic") ? flowXml() : document("TFP", "")))
    );
    const value = source({ valhallaTrafficCacheDir: directory });
    await value.trafficSnapshot();
    const content = await readFile(join(directory, "provider-request-timing.json"), "utf8");
    expect(content).not.toContain("synthetic-test-token");
    expect(content).not.toContain("averageSpeed");
    expect(JSON.parse(content).dynamic.nextAttemptAtMs).toBe(initialTime + 300000);
    const fetchMock = vi.mocked(fetch);
    const before = fetchMock.mock.calls.length;
    await expect(source({ valhallaTrafficCacheDir: directory }).trafficSnapshot()).rejects.toThrow("not yet available");
    expect(fetchMock).toHaveBeenCalledTimes(before);
    // Static content is not persisted here, so its in-memory 24-hour cache TTL
    // must not prevent a restart from reloading it after the hard request quota.
    await vi.advanceTimersByTimeAsync(300000);
    await source({ valhallaTrafficCacheDir: directory }).trafficSnapshot();
    expect(fetchMock).toHaveBeenCalledTimes(before + 2);
  });

  it("extends a live lease and never overlaps a request whose download exceeds one period", async () => {
    seedClock();
    let dynamicRequests = 0;
    let active = 0;
    let maximumActive = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (!pathOf(input).endsWith("tfp-dynamic")) return new Response(document("TFP", ""));
        dynamicRequests++;
        active++;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 350000));
        active--;
        return new Response(flowXml());
      })
    );
    const value = source();
    value.retainTrafficUntil(initialTime + 400000);
    await vi.advanceTimersByTimeAsync(200000);
    value.retainTrafficUntil(initialTime + 800000);
    await vi.advanceTimersByTimeAsync(510000);
    expect(dynamicRequests).toBe(3);
    expect(maximumActive).toBe(1);
    await vi.advanceTimersByTimeAsync(400000);
    expect(dynamicRequests).toBe(3);
  });

  it("cancels in-flight work on disposal and keeps demand-idle failures from spinning", async () => {
    seedClock();
    let aborted = false;
    let dynamicRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
        if (!pathOf(input).endsWith("tfp-dynamic")) return new Response(document("TFP", ""));
        dynamicRequests++;
        return await new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("synthetic abort", "AbortError"));
            },
            { once: true }
          );
        });
      })
    );
    const value = source();
    value.retainTrafficUntil(initialTime + 900000);
    await vi.advanceTimersByTimeAsync(0);
    value.dispose();
    await vi.advanceTimersByTimeAsync(1000000);
    expect(aborted).toBe(true);
    expect(dynamicRequests).toBe(1);
  });

  it("keeps the preceding content on parser failure and does not invent a new successful check", async () => {
    seedClock();
    let dynamicRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (!pathOf(input).endsWith("tfp-dynamic")) return new Response(document("TFP", ""));
        return new Response(++dynamicRequests === 1 ? flowXml() : "<synthetic-malformed>");
      })
    );
    const value = source();
    const before = await value.trafficSnapshot();
    await vi.advanceTimersByTimeAsync(300000);
    const after = await value.trafficSnapshot();
    expect(after.dynamicRevision).toBe(before.dynamicRevision);
    expect(after.generatedAt).toBe(before.generatedAt);
    expect(after.sourceTiming?.lastCheckedAt).toBe(before.sourceTiming?.lastCheckedAt);
    expect(after.sourceTiming?.lastError).toBe("TPEG2 provider refresh failed for /dev/tpeg/tfp-dynamic");
    await value.trafficSnapshot();
    expect(dynamicRequests).toBe(2);
  });

  it("preserves the real minimum interval when the wall clock jumps forward", async () => {
    seedClock();
    let dynamicRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (!pathOf(input).endsWith("tfp-dynamic")) return new Response(document("TFP", ""));
        dynamicRequests++;
        return new Response(flowXml());
      })
    );
    const value = source();
    await value.trafficSnapshot();
    vi.setSystemTime(initialTime + 3600000);
    await value.trafficSnapshot();
    expect(dynamicRequests).toBe(1);
    await vi.advanceTimersByTimeAsync(300000);
    await value.trafficSnapshot();
    expect(dynamicRequests).toBe(2);
  });

  it("issues no HTTP request if the durable quota write fails after a successful load", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sim-tpeg-gate-"));
    directories.push(directory);
    await writeFile(join(directory, "provider-request-timing.json"), JSON.stringify({ version: 1 }));
    await mkdir(join(directory, `provider-request-timing.json.tmp-${process.pid}`));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(source({ valhallaTrafficCacheDir: directory }).trafficSnapshot()).rejects.toThrow("request timing persistence");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aligns an opted-in publication phase without shortening the hard request interval", async () => {
    seedClock();
    const started: number[] = [];
    const firstModifiedAt = initialTime - 299000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (!pathOf(input).endsWith("tfp-dynamic")) return new Response(document("TFP", ""));
        const startedAt = Date.now();
        started.push(startedAt);
        const modifiedAt = firstModifiedAt + Math.floor((startedAt - firstModifiedAt) / 300000) * 300000;
        await new Promise((resolve) => setTimeout(resolve, 40000));
        return new Response(flowXml(), { headers: { "Last-Modified": new Date(modifiedAt).toUTCString() } });
      })
    );
    const value = source({ tpeg2AlignToLastModified: true });
    value.retainTrafficUntil(initialTime + 1000000);
    await vi.advanceTimersByTimeAsync(40000);
    expect((await value.trafficSnapshot()).sourceTiming?.nextRefreshAt).toBe(new Date(initialTime + 311000).toISOString());
    await vi.advanceTimersByTimeAsync(311000);
    await vi.advanceTimersByTimeAsync(300000);
    expect(started.map((time) => time - initialTime)).toEqual([0, 311000, 611000]);
    expect(started.slice(1).every((time, index) => time - started[index]! >= 300000)).toBe(true);
  });

  it.each([undefined, "invalid-date", "Thu, 01 Oct 2026 12:01:00 GMT"])(
    "uses start-based cadence when publication Last-Modified is missing, invalid or future (%s)",
    async (lastModified) => {
      seedClock();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async (input: string | URL | Request) =>
            new Response(pathOf(input).endsWith("tfp-dynamic") ? flowXml() : document("TFP", ""), {
              headers: lastModified ? { "Last-Modified": lastModified } : {}
            })
        )
      );
      const snapshot = await source({ tpeg2AlignToLastModified: true }).trafficSnapshot();
      expect(snapshot.sourceTiming?.nextRefreshAt).toBe(new Date(initialTime + 300000).toISOString());
    }
  );

  it("keeps phase alignment disabled unless explicitly configured", async () => {
    seedClock();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (input: string | URL | Request) =>
          new Response(pathOf(input).endsWith("tfp-dynamic") ? flowXml() : document("TFP", ""), {
            headers: { "Last-Modified": new Date(initialTime - 299000).toUTCString() }
          })
      )
    );
    const snapshot = await source().trafficSnapshot();
    expect(snapshot.sourceTiming?.nextRefreshAt).toBe(new Date(initialTime + 300000).toISOString());
  });
});
