import { afterEach, describe, expect, it, vi } from "vitest";
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
    const parsed = await parseTpeg2Static(document("TFP", `
      <mmt><optionMMCPartLink><messageID>42</messageID><partID>1</partID></optionMMCPartLink></mmt>
      <loc>
        <method><optionTMCLocationReferenceLink><locationID>37307</locationID><countryCode>11</countryCode><locationTableNumber>25</locationTableNumber></optionTMCLocationReferenceLink></method>
        <method><optionOpenLRLocationReferenceLink><locationReference><optionLinearLocationReference>
          <first><coordinate><longitude>583571</longitude><latitude>2313505</latitude></coordinate><lineProperties><frc code="0"/><fow code="1"/><bearing><value>42</value></bearing></lineProperties><pathProperties><lfrcnp code="0"/><dnp><value>287</value></dnp><againstDrivingDirection>false</againstDrivingDirection></pathProperties></first>
          <last><coordinate><longitude>-355</longitude><latitude>119</latitude></coordinate><lineProperties><frc code="0"/><fow code="1"/><bearing><value>172</value></bearing></lineProperties></last>
          <positiveOffset><value>25</value></positiveOffset>
        </optionLinearLocationReference></locationReference></optionOpenLRLocationReferenceLink></method>
      </loc>`));

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
    const parsed = await parseTpeg2Static(document("TFP", `
      <mmt><optionMMCPartLink><messageID>43</messageID><partID>1</partID></optionMMCPartLink></mmt>
      <loc><method><optionOpenLRLocationReferenceLink><locationReference><optionLinearLocationReference>
        <first><coordinate><longitude>583571</longitude><latitude>2313505</latitude></coordinate><lineProperties><frc code="0"/></lineProperties></first>
        <intermediate><coordinate><longitude>100</longitude><latitude>50</latitude></coordinate><lineProperties><frc code="1"/><bearing><value>90</value></bearing></lineProperties></intermediate>
        <intermediate><coordinate><longitude>100</longitude><latitude>50</latitude></coordinate><lineProperties><frc code="2"/><bearing><value>180</value></bearing></lineProperties></intermediate>
        <last><coordinate><longitude>100</longitude><latitude>50</latitude></coordinate><lineProperties><frc code="3"/></lineProperties></last>
      </optionLinearLocationReference></locationReference></optionOpenLRLocationReferenceLink></method></loc>`));
    expect(parsed.get("43")?.openlr?.points).toEqual([
      { role: "first", frc: "0" },
      { role: "intermediate", frc: "1", bearing: 90 },
      { role: "intermediate", frc: "2", bearing: 180 },
      { role: "last", frc: "3" }
    ]);
  });

  it("uses the unrestricted TFP flow method instead of vehicle-specific alternatives", async () => {
    const records = await parseTpeg2Dynamic(document("TFP", `
      <mmt><optionMMCPartLink><messageID>42</messageID><versionID>7</versionID><messageExpiryTime>2026-09-14T12:10:00Z</messageExpiryTime><cancelFlag>false</cancelFlag><partID>2</partID></optionMMCPartLink></mmt>
      <method><optionFlowStatus><startTime>2026-09-14T12:00:00Z</startTime><status><LOS code="3"/><averageSpeed>89</averageSpeed><freeFlowTravelTime>71</freeFlowTravelTime><delay>36</delay></status><statistics><FlowQuality code="4"/></statistics></optionFlowStatus></method>
      <method><optionFlowStatus><startTime>2026-09-14T12:00:00Z</startTime><status><LOS code="1"/><averageSpeed>20</averageSpeed></status><restriction><vehicleClassAssignment code="1"/></restriction></optionFlowStatus></method>`));

    expect(records).toEqual([
      expect.objectContaining({ messageId: "42", averageSpeedKph: 89, delaySeconds: 36, losCode: "3", qualityCode: "4" })
    ]);
  });

  it("maps TEC free text, validity, codes and geographic line coordinates", async () => {
    const records = await parseTpeg2Tec(document("TEC", `
      <mmt><optionMessageManagement><messageID>99</messageID><versionID>2</versionID><messageExpiryTime>2026-09-15T12:00:00Z</messageExpiryTime><cancelFlag>false</cancelFlag><messageGenerationTime>2026-09-14T11:59:00Z</messageGenerationTime></optionMessageManagement></mmt>
      <event><effectCode code="7"/><startTime>2026-09-14T12:00:00Z</startTime><stopTime>2026-09-15T10:00:00Z</stopTime><cause><optionDirectCause><mainCause code="10"/><warningLevel code="3"/><unverifiedInformation>true</unverifiedInformation><freeText><value>  uzavřená   komunikace  </value></freeText></optionDirectCause></cause></event>
      <loc><method><optionGeographicLocationReferenceLink><geographicLineReference>
        <linePoints><Longitude>676828</Longitude><Latitude>2282845</Latitude></linePoints>
        <linePoints><Longitude>676791</Longitude><Latitude>2282811</Latitude></linePoints>
      </geographicLineReference></optionGeographicLocationReferenceLink></method></loc>`));

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
    const records = await parseTpeg2Dynamic(document("TFP", `
      <mmt><optionMMCPartLink><messageID>42</messageID><cancelFlag>true</cancelFlag><partID>2</partID></optionMMCPartLink></mmt>
      <method><optionFlowStatus><status><averageSpeed>50</averageSpeed></status></optionFlowStatus></method>`));
    expect(records).toEqual([]);
  });

  it("keeps the API token and raw XML out of the normalized feature response", async () => {
    const staticXml = document("TFP", `
      <mmt><optionMMCPartLink><messageID>42</messageID><partID>1</partID></optionMMCPartLink></mmt>
      <loc><method><optionOpenLRLocationReferenceLink><locationReference><optionLinearLocationReference>
        <first><coordinate><longitude>583571</longitude><latitude>2313505</latitude></coordinate></first>
        <last><coordinate><longitude>355</longitude><latitude>119</latitude></coordinate></last>
      </optionLinearLocationReference></locationReference></optionOpenLRLocationReferenceLink></method></loc>`);
    const dynamicXml = document("TFP", `
      <mmt><optionMMCPartLink><messageID>42</messageID><versionID>7</versionID><cancelFlag>false</cancelFlag><partID>2</partID></optionMMCPartLink></mmt>
      <method><optionFlowStatus><startTime>2026-09-14T12:00:00Z</startTime><status><averageSpeed>89</averageSpeed><delay>36</delay></status></optionFlowStatus></method>`);
    const tecXml = document("TEC", `
      <mmt><optionMessageManagement><messageID>99</messageID><cancelFlag>false</cancelFlag></optionMessageManagement></mmt>
      <event><cause><optionDirectCause><freeText><value>Omezení provozu</value></freeText></optionDirectCause></cause></event>
      <loc><method><optionGeographicLocationReferenceLink><geographicLineReference><linePoints><Longitude>676828</Longitude><Latitude>2282845</Latitude></linePoints></geographicLineReference></optionGeographicLocationReferenceLink></method></loc>`);
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T15:00:00Z"));
    const staticXml = document("TFP", `<mmt><optionMMCPartLink><messageID>42</messageID><partID>1</partID></optionMMCPartLink></mmt><loc><method><optionOpenLRLocationReferenceLink><locationReference><optionLinearLocationReference><first><coordinate><longitude>583571</longitude><latitude>2313505</latitude></coordinate></first><last><coordinate><longitude>355</longitude><latitude>119</latitude></coordinate></last></optionLinearLocationReference></locationReference></optionOpenLRLocationReferenceLink></method></loc>`);
    const flowXml = (speed: number) => document("TFP", `<mmt><optionMMCPartLink><messageID>42</messageID><partID>2</partID></optionMMCPartLink></mmt><method><optionFlowStatus><startTime>2026-09-25T15:00:00Z</startTime><status><averageSpeed>${speed}</averageSpeed></status></optionFlowStatus></method>`);
    let dynamicRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("tfp-static")) return new Response(staticXml);
      if (path.endsWith("tfp-dynamic")) return new Response(flowXml(++dynamicRequests === 1 ? 40 : 65));
      return new Response(document("TEC", ""));
    }));
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
    vi.setSystemTime(new Date("2026-09-25T15:05:01Z"));
    expect((await source.trafficSnapshot()).flows[0]?.averageSpeedKph).toBe(65);
    expect(dynamicRequests).toBe(2);
  });
});
