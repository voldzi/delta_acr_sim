import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import supertest from "supertest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { RoutingService, encodeValhallaPolyline6 } from "../src/routing-service.js";
import { canonicalRoutingHash } from "../src/routing-safety.js";
import { parseTpeg2Tec } from "../src/tpeg2-source.js";
import {
  publishKnownClosureSnapshot,
  validateKnownReviewSet,
  type KnownClosureReviewSet,
  type KnownClosureSnapshot,
  type KnownClosureOptions
} from "../src/known-road-closures.js";
const now = Date.parse("2026-10-03T12:00:00Z"),
  tileset = 1790679143;
const dataset = { version: "sim-routing-2026-09-29-1790679143", builtAt: new Date(tileset * 1000).toISOString() };
const polygon: Array<[number, number]> = [
  [14.49, 50.09],
  [14.51, 50.09],
  [14.51, 50.11],
  [14.49, 50.11],
  [14.49, 50.09]
];
const doc = (extra = "", direction = "true") =>
  `<TPEGDocument docType="fullRepository" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:tec="http://www.tisa.org/TPEG/TEC_3_4"><ApplicationRootMessageML xsi:type="tec:TECMessage"><mmt><optionMessageManagement><messageID>99</messageID><versionID>2</versionID><cancelFlag>false</cancelFlag><messageGenerationTime>2026-10-03T11:00:00Z</messageGenerationTime><messageExpiryTime>2026-10-03T13:00:00Z</messageExpiryTime></optionMessageManagement></mmt><event><effectCode table="tec001_EffectCode" code="7"/><startTime>2026-10-03T11:00:00Z</startTime><stopTime>2026-10-03T14:00:00Z</stopTime><cause><optionDirectCause><unverifiedInformation>false</unverifiedInformation><freeText><value>Synthetic whole bridge closed, not a real record</value></freeText></optionDirectCause></cause>${extra}</event><loc>${direction === "unknown" ? "" : `<method><optionTMCLocationReferenceLink><bothDirections>${direction}</bothDirections></optionTMCLocationReferenceLink></method>`}<method><optionGeographicLocationReferenceLink><geographicLineReference><linePoints><Longitude>676828</Longitude><Latitude>2282845</Latitude></linePoints><linePoints><Longitude>676791</Longitude><Latitude>2282811</Latitude></linePoints><isFuzzyLine>true</isFuzzyLine></geographicLineReference></optionGeographicLocationReferenceLink></method></loc></ApplicationRootMessageML></TPEGDocument>`;
async function source(extra = "", direction = "true") {
  const records = await parseTpeg2Tec(doc(extra, direction), true);
  const reviews: KnownClosureReviewSet = {
    version: "sim-known-closure-reviews-v1",
    revision: "synthetic-review",
    routingDataset: dataset,
    reviews: [
      {
        id: "synthetic-bridge",
        eventId: "99",
        eventSemanticHash: records[0]!.closureEvidence!.semanticHash,
        osmWayId: "1",
        reviewedAt: "2026-10-03T11:59:00Z",
        sourceUrl: "https://synthetic.invalid/closure",
        scopeBasis: direction === "unknown" ? "official_whole_structure_statement" : "source_both_direction",
        polygon
      }
    ]
  };
  return { records, reviews, confirmedAt: "2026-10-03T11:59:00Z" };
}
const request = () => ({
  from: { lon: 14.42, lat: 50.08 },
  to: { lon: 14.45, lat: 50.1 },
  profileId: "car" as const,
  avoid: ["road_closure" as const],
  alternatives: 2,
  includeRoadAttributes: false,
  includeElevationProfile: false,
  includeWeatherOnRoute: false,
  includeHazardsOnRoute: false,
  includeTraffic: false
});
const trip = (shape: Array<[number, number]>) => ({
  status: 0,
  summary: { length: 2, time: 100 },
  legs: [{ shape: encodeValhallaPolyline6(shape), summary: { length: 2, time: 100 }, maneuvers: [] }]
});
const reply = () => ({
  trip: trip([
    [14.42, 50.08],
    [14.44, 50.09],
    [14.45, 50.1]
  ]),
  alternates: [
    {
      trip: trip([
        [14.42, 50.08],
        [14.43, 50.095],
        [14.45, 50.1]
      ])
    }
  ]
});
async function fixture() {
  const s = await source();
  let snapshot = publishKnownClosureSnapshot(s.reviews, s, dataset, now);
  const options: KnownClosureOptions = { enabled: true, acceptedEngineVersions: ["3.8.3"], loadSnapshot: vi.fn(async () => structuredClone(snapshot)) };
  const config = {
    ...(await loadConfig()),
    enabledSources: [],
    valhallaBaseUrl: "http://synthetic.valhalla",
    routingEngine: "valhalla" as const,
    valhallaTrafficEnabled: false,
    osmPostgisConnectionString: undefined
  };
  const payloads: any[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
    payloads.push(JSON.parse(String(init?.body)));
    return Response.json(reply());
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    service: new RoutingService(config, undefined, undefined, options),
    options,
    payloads,
    fetchMock,
    setSnapshot: (s: KnownClosureSnapshot) => {
      snapshot = s;
    },
    snapshot
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("accepted route concurrency", () => {
  it("keeps one native flight and distinct caller UUID diagnostics without changing the payload or 401 rejection", async () => {
    vi.stubEnv("SITUATION_DATA_ROUTING_DIAGNOSTICS_UNTIL", new Date(now + 600_000).toISOString());
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const f = await fixture(); let release!: (value: Response) => void; let nativeCalls = 0;
      f.fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
        if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
        nativeCalls++; f.payloads.push(JSON.parse(String(init?.body)));
        return new Promise<Response>(r => { release = r; });
      });
      const ids = ["f0000000-0000-4000-8000-000000000001", "f0000000-0000-4000-8000-000000000002"];
      const input = { ...request(), vehicleProfile: { version: "sim-mapped-road-profile-v1" as const, intent: "car" as const, coverageAcknowledged: "mapped_restrictions_incomplete" as const } };
      const pending = Promise.allSettled(ids.map(correlationId => f.service.route(input, { correlationId })));
      for (let i = 0; i < 100 && nativeCalls === 0; i++) await Promise.resolve();
      expect(nativeCalls).toBe(1);
      release(Response.json({ ...reply(), warnings: [{ code: 401, text: "PRIVATE_PROVIDER_TEXT_CANARY" }] }));
      const results = await pending;
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(result.reason).toMatchObject({ status: 422, code: "ROUTING_RESTRICTIONS_RELAXATION_REQUIRED" });
      }
      expect(nativeCalls).toBe(1);
      const events = log.mock.calls.map(([line]) => JSON.parse(String(line))).filter(e => e.event === "routing_guard_diagnostic_v1");
      expect(events).toHaveLength(2); expect(events.map(e => e.correlationId).sort()).toEqual(ids);
      for (const e of events) expect(e).toMatchObject({ stage: "native_warning_validation", outcomeCode: "ROUTING_RESTRICTIONS_RELAXATION_REQUIRED", requestedDateTimeMode: "none", requestedVariantCount: 2, returnedVariantCount: 2, nativeWarningCodes: [401], warningCounts: { root: 1, primary: 0, alternate: 0, malformed: 0 }, closureGeometryValidated: true, snapClassification: "unknown", algorithm: "not_reported", multipassCondition: "not_reported" });
      expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_PROVIDER_TEXT_CANARY");
      for (const id of ids) expect(JSON.stringify(f.payloads)).not.toContain(id);
    } finally { log.mockRestore(); }
  });
  it("shares an identical in-flight engine route but validates every caller", async () => {
    const f = await fixture();
    let release!: (value: Response) => void;
    let engineCalls = 0;
    f.fetchMock.mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
      engineCalls++;
      return new Promise<Response>(r => { release = r; });
    });
    const pending = Array.from({ length: 8 }, () => f.service.route(request()));
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(engineCalls).toBe(1);
    release(Response.json(reply()));
    const results = await Promise.all(pending);
    expect(results.every(r => r.routes.every(v => v.knownClosures?.state === "applied"))).toBe(true);
    expect(f.options.loadSnapshot).toHaveBeenCalledTimes(16);
    results[0]!.routes.length = 0;
    expect(results[1]!.routes.length).toBeGreaterThan(0);
  });
});
describe("known closure publisher", () => {
  it("retains explicit scope and chooses earliest source expiry, not last refresh as event onset", async () => {
    const s = await source();
    expect(s.records[0]?.validUntil).toBe("2026-10-03T13:00:00Z");
    expect(s.records[0]?.closureEvidence).toMatchObject({ direction: "both", roadClosed: true, vehicleScope: "all", fuzzyGeometry: true });
    const p = publishKnownClosureSnapshot(s.reviews, s, dataset, now);
    expect(p.closures).toHaveLength(1);
    expect(Date.parse(p.observedAt)).toBe(Date.parse(s.confirmedAt));
    expect(p.validUntil).toBe("2026-10-03T12:09:00.000Z");
  });
  it("does not infer direction from an unknown fuzzy line; whole-structure review is separately explicit", async () => {
    const s = await source("", "unknown");
    s.reviews.reviews[0]!.scopeBasis = "source_both_direction";
    expect(() => publishKnownClosureSnapshot(s.reviews, s, dataset, now)).toThrow("lacks reviewed direction");
    s.reviews.reviews[0]!.scopeBasis = "official_whole_structure_statement";
    expect(publishKnownClosureSnapshot(s.reviews, s, dataset, now).closures[0]).toMatchObject({
      sourceDirection: "unknown",
      enforcedDirection: "both",
      enforcementReason: "conservative_whole_structure_avoidance"
    });
  });
  it.each([
    "<vehicleRestriction/>",
    "<cause><optionLinkedCause/></cause>",
    '<cause><optionDirectCause><laneRestrictionType code="1"/></optionDirectCause></cause>',
    "<cause><optionDirectCause><unverifiedInformation>true</unverifiedInformation></optionDirectCause></cause>"
  ])("rejects restricted/lane/unverified scope %s", async (extra) => {
    const s = await source(extra);
    expect(() => publishKnownClosureSnapshot(s.reviews, s, dataset, now)).toThrow();
  });
  it("never overrides an explicitly one-direction closure with conservative policy", async () => {
    const s = await source("", "false");
    s.reviews.reviews[0]!.scopeBasis = "official_whole_structure_statement";
    expect(() => publishKnownClosureSnapshot(s.reviews, s, dataset, now)).toThrow();
  });
  it("invalidates changed text/semantics and preserves malformed identities rather than treating them as withdrawal", async () => {
    const s = await source();
    const changed = await parseTpeg2Tec(doc().replace("Synthetic whole bridge closed", "Different whole bridge closed"), true);
    expect(() => publishKnownClosureSnapshot(s.reviews, { ...s, records: changed }, dataset, now)).toThrow();
    const malformed = await parseTpeg2Tec(doc().replace(/<freeText>.*?<\/freeText>/, ""), true);
    expect(malformed[0]?.messageId).toBe("99");
    expect(() => publishKnownClosureSnapshot(s.reviews, { ...s, records: malformed }, dataset, now)).toThrow();
  });
  it("rejects delta/wrong XML and incomplete XML before revocation can be inferred", async () => {
    await expect(parseTpeg2Tec(doc().replace("fullRepository", "delta"), true)).rejects.toThrow();
    await expect(parseTpeg2Tec("<other/>", true)).rejects.toThrow();
    await expect(parseTpeg2Tec(doc().slice(0, -20), true)).rejects.toThrow();
    await expect(parseTpeg2Tec(doc().replace("<cancelFlag>false</cancelFlag>", ""), true)).rejects.toThrow();
    await expect(parseTpeg2Tec(doc().replace("<messageID>99</messageID>", "<messageID>99</messageID><messageID>98</messageID>"), true)).rejects.toThrow();
  });
  it("withdraws absent/expired reviewed entries only from a fresh full snapshot; coverage stays partial", async () => {
    const s = await source();
    expect(publishKnownClosureSnapshot(s.reviews, { ...s, records: [] }, dataset, now).closures).toHaveLength(0);
    expect(() => publishKnownClosureSnapshot(s.reviews, { ...s, confirmedAt: "2026-10-03T11:00:00Z" }, dataset, now)).toThrow();
  });
  it("rejects a changed graph, malformed rings, duplicate identities and an empty review set", async () => {
    const s = await source();
    for (const update of [
      (r: KnownClosureReviewSet) => {
        r.routingDataset = { ...dataset, version: "different" };
      },
      (r: KnownClosureReviewSet) => {
        r.reviews[0]!.polygon = [
          [1, 1],
          [1, 1],
          [1, 1],
          [1, 1]
        ];
      },
      (r: KnownClosureReviewSet) => {
        r.reviews.push(r.reviews[0]!);
      },
      (r: KnownClosureReviewSet) => {
        r.reviews = [];
      }
    ]) {
      const r = structuredClone(s.reviews);
      update(r);
      expect(() => validateKnownReviewSet(r, dataset, now)).toThrow();
    }
  });
});
describe("ordinary route engine fences", () => {
  it.each(["route", "alternatives"] as const)(
    "returns a neutral 422 for a typed HTTP400 location rejection on %s without locating or retrying",
    async (method) => {
      const f = await fixture();
      f.fetchMock.mockImplementation(async (url, init) => {
        if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
        f.payloads.push(JSON.parse(String(init?.body)));
        return Response.json({ error_code: 171, error: "private upstream location detail", location_index: 1 }, { status: 400 });
      });
      await expect(f.service[method](request())).rejects.toMatchObject({ status: 422, code: "ROUTING_LOCATION_NOT_ROUTABLE" });
      expect(f.payloads).toHaveLength(1);
      expect(f.payloads[0].locations.map((p: any) => [p.radius, p.search_cutoff])).toEqual([
        [25, 25],
        [25, 25]
      ]);
      expect(f.payloads[0].exclude_polygons).toEqual([polygon]);
      expect(f.fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/status", "/route"]);
    }
  );
  it.each([undefined, 0, 1, 2, -1, "1", 1.5, { value: 1 }])("never trusts an upstream location_index %j to identify the requested endpoint", async (index) => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("/status")
        ? Response.json({ version: "3.8.3", tileset_last_modified: tileset })
        : Response.json(
            { error_code: 171, error: "No suitable edges near location", ...(index === undefined ? {} : { location_index: index }) },
            { status: 400 }
          )
    );
    await expect(f.service.route(request())).rejects.toMatchObject({ status: 422, code: "ROUTING_LOCATION_NOT_ROUTABLE" });
  });
  it.each([200, 401, 403, 404, 429, 500, 502, 503])("does not classify HTTP%s with a spoofed 171 as a route location error", async (status) => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("/status")
        ? Response.json({ version: "3.8.3", tileset_last_modified: tileset })
        : Response.json({ error_code: 171, error: "private upstream location detail" }, { status })
    );
    await expect(f.service.route(request())).rejects.toMatchObject({ status: 502, code: "ROUTING_KNOWN_CLOSURES_ENGINE_FAILED" });
    expect(f.fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/route"))).toHaveLength(1);
  });
  it.each([undefined, "171", 170, 171.5, null, [171], { code: 171 }])(
    "does not infer an endpoint rejection from malformed or other error_code %j",
    async (code) => {
      const f = await fixture();
      f.fetchMock.mockImplementation(async (url) =>
        String(url).endsWith("/status")
          ? Response.json({ version: "3.8.3", tileset_last_modified: tileset })
          : Response.json({ error: "No suitable edges near location", ...(code === undefined ? {} : { error_code: code }) }, { status: 400 })
      );
      await expect(f.service.route(request())).rejects.toMatchObject({ status: 502, code: "ROUTING_KNOWN_CLOSURES_ENGINE_FAILED" });
    }
  );
  it("does not reinterpret a status error as a route endpoint rejection", async () => {
    const f = await fixture();
    f.fetchMock.mockResolvedValue(Response.json({ error_code: 171, error: "private status detail" }, { status: 400 }));
    await expect(f.service.route(request())).rejects.toMatchObject({ status: 502, code: "ROUTING_KNOWN_CLOSURES_ENGINE_FAILED" });
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });
  it("keeps an attribute endpoint error advisory rather than classifying the request location", async () => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
      if (String(url).endsWith("/trace_attributes")) return Response.json({ error_code: 171, error: "private trace detail" }, { status: 400 });
      return Response.json(reply());
    });
    const result = await f.service.route({ ...request(), includeRoadAttributes: true });
    expect(result.routes).toHaveLength(1);
    expect(result.routes.every((route) => route.roadAttributes?.state === "unavailable")).toBe(true);
    expect(result.routes.every((route) => route.knownClosures?.state === "applied")).toBe(true);
  });
  it.each(["route", "alternatives"] as const)("keeps mapped-profile constraints on a typed location rejection from %s", async (method) => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
      f.payloads.push(JSON.parse(String(init?.body)));
      return Response.json({ error_code: 171 }, { status: 400 });
    });
    await expect(
      f.service[method]({
        ...request(),
        vehicleProfile: { version: "sim-mapped-road-profile-v1", intent: "car", coverageAcknowledged: "mapped_restrictions_incomplete" }
      })
    ).rejects.toMatchObject({ status: 422, code: "ROUTING_LOCATION_NOT_ROUTABLE" });
    expect(f.payloads).toHaveLength(1);
    expect(f.payloads[0].costing_options.auto.ignore_access).toBe(false);
    expect(f.payloads[0].exclude_polygons).toEqual([polygon]);
  });
  it.each(["route", "alternatives"] as const)("exposes only the correlated typed error without raw engine text or proof through HTTP %s", async (endpoint) => {
    const f = await fixture(),
      { app, context } = await createApp({ ...(await loadConfig()), enabledSources: [], sharedCacheRedisUrl: undefined });
    context.routing = f.service;
    f.fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("/status")
        ? Response.json({ version: "3.8.3", tileset_last_modified: tileset })
        : Response.json({ error_code: 171, error: "private upstream location detail" }, { status: 400 })
    );
    try {
      const response = await supertest(app).post(`/api/v1/routing/${endpoint}`).set("x-correlation-id", "synthetic-unroutable-contract").send(request());
      expect(response.status).toBe(422);
      expect(response.body.code ?? response.body.error?.code).toBe("ROUTING_LOCATION_NOT_ROUTABLE");
      expect(JSON.stringify(response.body)).toContain("synthetic-unroutable-contract");
      expect(JSON.stringify(response.body)).not.toContain("private upstream location detail");
      expect(response.body.routes).toBeUndefined();
      expect(response.body.knownClosures).toBeUndefined();
      expect(response.body.assessment).toBeUndefined();
    } finally {
      await context.driverMeasurements.close();
    }
  });
  it.each(["route", "alternatives"] as const)("correlates bounded private diagnostics through HTTP %s without changing the error envelope", async endpoint => {
    vi.stubEnv("SITUATION_DATA_ROUTING_DIAGNOSTICS_UNTIL", new Date(now + 600_000).toISOString());
    const log = vi.spyOn(console, "info").mockImplementation(() => {}), f = await fixture();
    const { app, context } = await createApp({ ...(await loadConfig()), enabledSources: [], sharedCacheRedisUrl: undefined });
    context.routing = f.service;
    f.fetchMock.mockImplementation(async url => String(url).endsWith("/status")
      ? Response.json({ version: "3.8.3", tileset_last_modified: tileset })
      : Response.json({ ...reply(), warnings: [{ code: 401, text: "PRIVATE_HTTP_PROVIDER_CANARY" }] }));
    const cid = "F0000000-0000-4000-8000-000000000001";
    try {
      const response = await supertest(app).post(`/api/v1/routing/${endpoint}`).set("x-correlation-id", cid)
        .send({ ...request(), from: { ...request().from, label: "PRIVATE_ORIGIN_LABEL_CANARY" } });
      expect(response.status).toBe(422);
      expect(Object.keys(response.body)).toEqual(["error"]);
      expect(response.body.error).toMatchObject({ code: "ROUTING_RESTRICTIONS_RELAXATION_REQUIRED", correlationId: cid });
      const events = log.mock.calls.map(([line]) => JSON.parse(String(line))).filter(e => e.event === "routing_guard_diagnostic_v1");
      expect(events).toHaveLength(1); expect(events[0].correlationId).toBe(cid);
      expect(events[0].nativeWarningCodes).toEqual([401]);
      const exported = JSON.stringify([response.body, log.mock.calls]);
      expect(exported).not.toContain("PRIVATE_HTTP_PROVIDER_CANARY");
      expect(exported).not.toContain("PRIVATE_ORIGIN_LABEL_CANARY");
      expect(JSON.stringify(response.body)).not.toContain("nativeWarningCodes");
    } finally { log.mockRestore(); await context.driverMeasurements.close(); }
  });
  it.each(["invalid_geometry", "closure_crossing"])("diagnostic never marks geometry/closures validated after %s", async fault => {
    vi.stubEnv("SITUATION_DATA_ROUTING_DIAGNOSTICS_UNTIL", new Date(now + 600_000).toISOString());
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const f = await fixture();
      f.fetchMock.mockImplementation(async url => {
        if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
        const data: any = reply();
        data.trip = trip(fault === "invalid_geometry" ? [[1, 1]] : [[14.48, 50.1], [14.52, 50.1]]);
        data.trip.warnings = [{ code: 401 }]; return Response.json(data);
      });
      await expect(f.service.route(request(), { correlationId: "f0000000-0000-4000-8000-000000000001" }))
        .rejects.toMatchObject({ status: 502, code: "ROUTING_KNOWN_CLOSURES_ENGINE_FAILED" });
      const event = JSON.parse(String(log.mock.calls[0][0]));
      expect(event).toMatchObject({ closureGeometryValidated: false, stage: "geometry_closure_validation", nativeWarningCodes: [401], snapClassification: "unknown" });
    } finally { log.mockRestore(); }
  });
  it.each(["start", "target", "surplus-start", "surplus-target"])(
    "classifies a proven %s shape snap outside 25m without accepting any variant",
    async (position) => {
      const f = await fixture();
      f.fetchMock.mockImplementation(async (url) => {
        if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
        const data = reply(),
          shape: Array<[number, number]> = [
            [14.42, 50.08],
            [14.44, 50.09],
            [14.45, 50.1]
          ];
        if (position.endsWith("start")) shape[0] = [14.419, 50.08];
        else shape[2] = [14.451, 50.1];
        if (position.startsWith("surplus")) data.alternates[0]!.trip = trip(shape);
        else data.trip = trip(shape);
        return Response.json(data);
      });
      await expect(f.service.route({ ...request(), alternatives: 1 })).rejects.toMatchObject({
        status: 422,
        code: position.endsWith("target") ? "ROUTING_TARGET_NOT_ROUTABLE" : "ROUTING_WAYPOINT_NOT_ROUTABLE"
      });
      expect(f.fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/route"))).toHaveLength(1);
    }
  );
  it("keeps missing or invalid shape geometry a protective engine failure", async () => {
    for (const shape of [undefined, "", null, 123]) {
      const f = await fixture();
      f.fetchMock.mockImplementation(async (url) => {
        if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
        return Response.json({
          trip: { status: 0, summary: { length: 2, time: 100 }, legs: [{ ...(shape === undefined ? {} : { shape }), summary: { length: 2, time: 100 } }] }
        });
      });
      await expect(f.service.route(request())).rejects.toMatchObject({ status: 502, code: "ROUTING_KNOWN_CLOSURES_ENGINE_FAILED" });
    }
  });
  it("does not misclassify a distant single-vertex shape as a client endpoint error", async () => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("/status") ? Response.json({ version: "3.8.3", tileset_last_modified: tileset }) : Response.json({ trip: trip([[1, 1]]) })
    );
    await expect(f.service.route(request())).rejects.toMatchObject({ status: 502, code: "ROUTING_KNOWN_CLOSURES_ENGINE_FAILED" });
  });
  it("does not classify finite out-of-WGS84 engine geometry as an endpoint error", async () => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("/status")
        ? Response.json({ version: "3.8.3", tileset_last_modified: tileset })
        : Response.json({
            trip: trip([
              [181, 50],
              [181.001, 50]
            ])
          })
    );
    await expect(f.service.route(request())).rejects.toMatchObject({ status: 502, code: "ROUTING_KNOWN_CLOSURES_ENGINE_FAILED" });
  });
  it("binds user-selected arrival to every variant without changing road geometry or using native coalescing", async () => {
    const f = await fixture();
    const raw = { ...request(), includeSteps: true, arrival: { version: "sim-user-selected-arrival-v1" as const,
      selection: "user_selected" as const, target: { lon: 14.45, lat: 50.10024 } } };
    const [a, b] = await Promise.all([f.service.route(raw), f.service.route(raw)]);
    expect(f.payloads).toHaveLength(2);
    for (const result of [a, b]) {
      expect(result.query.arrival).toEqual(raw.arrival);
      expect(result.routes).toHaveLength(2);
      for (const [i, route] of result.routes.entries()) {
        expect(route.arrival).toMatchObject({ version: raw.arrival.version, target: raw.arrival.target,
          requestedAccess: raw.to, mappedEndpoint: raw.to, snapDistanceM: 0,
          remainingAccess: "unverified", requestHash: canonicalRoutingHash(result.query),
          geometryHash: canonicalRoutingHash(route.geometry), routeId: route.routeId,
          routingDataset: dataset, engine: { provider: "valhalla", costing: "auto", fallbackUsed: false } });
        expect(route.arrival!.distanceM).toBeGreaterThan(26);
        expect(route.arrival!.distanceM).toBeLessThan(27);
        expect(result.features[i]!.properties.arrival).toEqual(route.arrival);
      }
    }
  });
  it.each(["vehicle", "trip", "vehicleProfile", "via", "departureTime"])("rejects arrival combined with %s before routing", async key => {
    const f = await fixture();
    await expect(f.service.route({ ...request(), includeSteps: true, [key]: undefined,
      arrival: { version: "sim-user-selected-arrival-v1", selection: "user_selected", target: request().to } }))
      .rejects.toMatchObject({ status: 422, code: "ROUTING_ARRIVAL_UNSUPPORTED" });
    expect(f.payloads).toHaveLength(0);
  });
  it.each([undefined, false])("requires includeSteps true for arrival (%s)", async includeSteps => {
    const f = await fixture();
    await expect(f.service.route({ ...request(), includeSteps,
      arrival: { version: "sim-user-selected-arrival-v1", selection: "user_selected", target: request().to } }))
      .rejects.toMatchObject({ status: 422, code: "ROUTING_ARRIVAL_UNSUPPORTED" });
  });
  it.each(["root", "trip", "alternate"])("returns typed rejection for isolated relaxation warning at %s, never an accepted route", async (location) => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
      const data: any = reply();
      if (location === "root") data.warnings = [{ code: 401 }];
      else if (location === "trip") data.trip.warnings = [{ code: 401 }];
      else data.alternates[0].trip.warnings = [{ code: 401 }];
      return Response.json(data);
    });
    await expect(f.service.route(request())).rejects.toMatchObject({ status: 422, code: "ROUTING_RESTRICTIONS_RELAXATION_REQUIRED" });
  });
  it("does not downgrade mixed warnings to a location-related rejection", async () => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url) => String(url).endsWith("/status")
      ? Response.json({ version: "3.8.3", tileset_last_modified: tileset })
      : Response.json({ ...reply(), warnings: [{ code: 401 }, { code: 500 }] }));
    await expect(f.service.route(request())).rejects.toMatchObject({ status: 502, code: "ROUTING_KNOWN_CLOSURES_ENGINE_FAILED" });
  });
  it.each(["invalid_geometry", "closure_crossing"])("warning 401 cannot conceal %s", async (fault) => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
      const data: any = reply();
      data.trip = trip(fault === "invalid_geometry" ? [[1, 1]] : [[14.48, 50.1], [14.52, 50.1]]);
      data.trip.warnings = [{ code: 401 }];
      return Response.json(data);
    });
    await expect(f.service.route(request())).rejects.toMatchObject({ status: 502, code: "ROUTING_KNOWN_CLOSURES_ENGINE_FAILED" });
  });
  it.each(["root", "trip", "alternate"])("preserves a protective %s warning even when the primary endpoint snap is invalid", async (location) => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
      const data: any = reply(),
        warnings = [{ code: 500, text: "synthetic omitted restriction" }];
      data.trip = trip([
        [14.42, 50.08],
        [14.44, 50.09],
        [14.451, 50.1]
      ]);
      if (location === "root") data.warnings = warnings;
      else if (location === "trip") data.trip.warnings = warnings;
      else data.alternates[0].trip.warnings = warnings;
      return Response.json(data);
    });
    await expect(f.service.route({ ...request(), alternatives: 1 })).rejects.toMatchObject({ status: 502, code: "ROUTING_KNOWN_CLOSURES_ENGINE_FAILED" });
  });
  it("checks a surplus closure-crossing variant before classifying an invalid primary snap", async () => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("/status")
        ? Response.json({ version: "3.8.3", tileset_last_modified: tileset })
        : Response.json({
            trip: trip([
              [14.42, 50.08],
              [14.44, 50.09],
              [14.451, 50.1]
            ]),
            alternates: [
              {
                trip: trip([
                  [14.42, 50.08],
                  [14.5, 50.1],
                  [14.45, 50.1]
                ])
              }
            ]
          })
    );
    await expect(f.service.route({ ...request(), alternatives: 1 })).rejects.toMatchObject({ status: 502, code: "ROUTING_KNOWN_CLOSURES_ENGINE_FAILED" });
  });
  it("keeps a failed route fetch protective without exposing its message or retrying", async () => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
      throw new Error("private network request detail");
    });
    const failure = await f.service.route(request()).catch((error) => error);
    expect(failure).toMatchObject({ status: 502, code: "ROUTING_KNOWN_CLOSURES_ENGINE_FAILED" });
    expect(failure.message).not.toContain("private network request detail");
    expect(f.fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(["/status", "/route"]);
  });
  it.each([200, 400])("keeps invalid route JSON on HTTP%s protective rather than inferring 171", async (status) => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("/status")
        ? Response.json({ version: "3.8.3", tileset_last_modified: tileset })
        : new Response('{"error_code":171', { status, headers: { "content-type": "application/json" } })
    );
    await expect(f.service.route(request())).rejects.toMatchObject({ status: 502, code: "ROUTING_KNOWN_CLOSURES_ENGINE_FAILED" });
    expect(f.fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/route"))).toHaveLength(1);
  });
  it("rejects a proven via-point snap outside 25m as a waypoint, not the target", async () => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("/status")
        ? Response.json({ version: "3.8.3", tileset_last_modified: tileset })
        : Response.json({
            trip: {
              status: 0,
              summary: { length: 2, time: 100 },
              legs: [
                {
                  shape: encodeValhallaPolyline6([
                    [14.42, 50.08],
                    [14.431, 50.085]
                  ]),
                  summary: { length: 1, time: 50 },
                  maneuvers: []
                },
                {
                  shape: encodeValhallaPolyline6([
                    [14.431, 50.085],
                    [14.45, 50.1]
                  ]),
                  summary: { length: 1, time: 50 },
                  maneuvers: []
                }
              ]
            }
          })
    );
    await expect(f.service.route({ ...request(), alternatives: 1, via: [{ lon: 14.43, lat: 50.085 }] })).rejects.toMatchObject({
      status: 422,
      code: "ROUTING_WAYPOINT_NOT_ROUTABLE"
    });
  });
  it("does not change the legacy route behavior when reviewed-closure routing is disabled", async () => {
    const f = await fixture();
    f.options.enabled = false;
    f.fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("/status")
        ? Response.json({ version: "3.8.3", tileset_last_modified: tileset })
        : Response.json({ error_code: 171, error: "No suitable edges near location" }, { status: 400 })
    );
    const response = await f.service.route({ ...request(), alternatives: 1 });
    expect(response.routes[0]!.quality.mode).toBe("direct_fallback");
    expect(response.routes[0]!.knownClosures).toBeUndefined();
    expect(response.routes[0]!.assessment).toBeUndefined();
  });
  it("preserves explicit mapped alternatives on route as well as alternatives endpoint", async () => {
    const f = await fixture();
    const p = { version: "sim-mapped-road-profile-v1" as const, intent: "car" as const, coverageAcknowledged: "mapped_restrictions_incomplete" as const };
    const response = await f.service.route({ ...request(), vehicleProfile: p });
    expect(response.query.alternatives).toBe(2);
    expect(response.routes).toHaveLength(2);
    expect(f.payloads[0].alternates).toBe(1);
  });
  it("primary-only mapped planning changes only native alternates, never vehicle or closure options", async () => {
    const p = {
      version: "sim-mapped-road-profile-v1" as const,
      intent: "car" as const,
      coverageAcknowledged: "mapped_restrictions_incomplete" as const,
      vehicle: { heightM: 1.6, widthM: 1.8, lengthM: 4.2, loadedWeightKg: 1600 }
    };
    const payloads: any[] = [];
    for (const alternatives of [1, 3]) {
      const f = await fixture();
      const input = { ...request(), alternatives, vehicleProfile: structuredClone(p) };
      const original = structuredClone(input);
      const result = await f.service.route(input);
      expect(input).toEqual(original);
      expect(result.query.vehicleProfile).toEqual(p);
      expect(result.query.alternatives).toBe(alternatives);
      expect(result.routes[0]!.mappedProfileAssessment!.appliedProfile).toEqual(p);
      expect(result.routes[0]!.knownClosures!.state).toBe("applied");
      expect(f.payloads).toHaveLength(1);
      payloads.push(f.payloads[0]);
    }
    expect(payloads.map((p) => p.alternates)).toEqual([0, 2]);
    const primaryOnly = structuredClone(payloads[0]);
    primaryOnly.alternates = 2;
    expect(primaryOnly).toEqual(payloads[1]);
    expect(payloads[0].costing).toBe("auto");
    expect(payloads[0].costing_options.auto).toMatchObject({
      height: 1.6, width: 1.8, length: 4.2, weight: 1.6,
      ignore_access: false, ignore_restrictions: false, ignore_oneways: false,
      ignore_closures: false, ignore_non_vehicular_restrictions: false,
      shortest: false, use_tracks: 0
    });
    expect(payloads[0].exclude_polygons).toEqual([polygon]);
  });
  it.each([1, 3])("mapped planning with %s requested variants still rejects warning 401 without retry or fallback", async (alternatives) => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/status")) return Response.json({ version: "3.8.3", tileset_last_modified: tileset });
      f.payloads.push(JSON.parse(String(init?.body)));
      return Response.json({ ...reply(), warnings: [{ code: 401 }] });
    });
    const p = { version: "sim-mapped-road-profile-v1" as const, intent: "car" as const, coverageAcknowledged: "mapped_restrictions_incomplete" as const };
    await expect(f.service.route({ ...request(), alternatives, vehicleProfile: p }))
      .rejects.toMatchObject({ status: 422, code: "ROUTING_RESTRICTIONS_RELAXATION_REQUIRED" });
    expect(f.payloads).toHaveLength(1);
    expect(f.payloads[0].alternates).toBe(alternatives - 1);
    expect(f.payloads[0].costing).toBe("auto");
    expect(f.payloads[0].costing_options.auto.ignore_access).toBe(false);
    expect(f.payloads[0].exclude_polygons).toEqual([polygon]);
  });
  it("fails mapped profiles closed before engine calls when known closure path is disabled", async () => {
    const f = await fixture();
    f.options.enabled = false;
    await expect(
      f.service.route({
        ...request(),
        vehicleProfile: { version: "sim-mapped-road-profile-v1", intent: "car", coverageAcknowledged: "mapped_restrictions_incomplete" }
      })
    ).rejects.toMatchObject({ status: 503, code: "ROUTING_PROFILE_UNAVAILABLE" });
    expect(f.fetchMock).not.toHaveBeenCalled();
  });
  it("returns a typed error rather than fabricating an unmapped final leg", async () => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("/status")
        ? Response.json({ version: "3.8.3", tileset_last_modified: tileset })
        : Response.json({
            ...reply(),
            trip: trip([
              [14.42, 50.08],
              [14.44, 50.09],
              [14.451, 50.1]
            ])
          })
    );
    await expect(
      f.service.route({
        ...request(),
        vehicleProfile: { version: "sim-mapped-road-profile-v1", intent: "road_legal_4x4", coverageAcknowledged: "mapped_restrictions_incomplete" }
      })
    ).rejects.toMatchObject({ status: 422, code: "ROUTING_TARGET_NOT_ROUTABLE" });
  });
  it.each(["car", "commercial_truck", "car_with_trailer", "road_legal_4x4"] as const)(
    "applies mapped %s profile with the same closure/hash/feature fences",
    async (intent) => {
      const f = await fixture(),
        v = { heightM: 3, widthM: 2.5, lengthM: 12, loadedWeightKg: 20000 };
      const p = {
        version: "sim-mapped-road-profile-v1" as const,
        intent,
        coverageAcknowledged: "mapped_restrictions_incomplete" as const,
        ...(intent === "commercial_truck" || intent === "car_with_trailer"
          ? {
              vehicle: {
                ...v,
                ...(intent === "commercial_truck"
                  ? { axleLoadKg: 8000, axleCount: 3 }
                  : { trailer: { attached: true as const, heightM: 2.8, widthM: 2.4, lengthM: 6, loadedWeightKg: 4000 } })
              }
            }
          : {})
      };
      const response = await f.service.alternatives({ ...request(), vehicleProfile: p });
      for (const r of response.routes) {
        expect(r.mappedProfileAssessment?.appliedProfile).toEqual(p);
        expect(r.mappedProfileAssessment?.requestHash).toBe(r.knownClosures?.requestHash);
        expect(r.mappedProfileAssessment?.geometryHash).toBe(r.knownClosures?.geometryHash);
        expect(r.mappedProfileAssessment?.validUntil).toBe(r.knownClosures?.validUntil);
        expect(response.features.find((x) => x.id === r.routeId)?.properties.mappedProfileAssessment).toEqual(r.mappedProfileAssessment);
      }
      const payload = f.payloads[0];
      expect(payload.costing).toBe(intent === "commercial_truck" ? "truck" : "auto");
      expect(payload.costing_options[payload.costing].ignore_access).toBe(false);
      expect(payload.exclude_polygons).toHaveLength(1);
    }
  );
  it("ships an independently reproducible synthetic COP fixture with exact schema and hashes", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../openapi/examples/known-road-closures.synthetic.json", import.meta.url), "utf8"));
    const require = createRequire(import.meta.url),
      Ajv = require("ajv/dist/2020").default,
      ajv = new Ajv({ strict: false });
    require("ajv-formats").default(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(new URL("../../../openapi/fragments/known-road-closures.schema.json", import.meta.url), "utf8")));
    expect(fixture.synthetic).toBe(true);
    expect(fixture.response.query).toEqual({ ...fixture.request, via: [], avoid: [] });
    for (const route of fixture.response.routes) {
      expect(validate(route.knownClosures)).toBe(true);
      expect(route.knownClosures.geometryHash).toBe(canonicalRoutingHash(route.geometry));
      expect(route.knownClosures.requestHash).toBe(canonicalRoutingHash(fixture.response.query));
      expect(fixture.response.features.find((f: any) => f.id === route.routeId)?.properties.knownClosures).toEqual(route.knownClosures);
    }
  });
  it("applies polygons in the engine and returns per-variant binding evidence without strict claims", async () => {
    const f = await fixture();
    const out = await f.service.alternatives(request());
    expect(f.payloads[0].exclude_polygons).toEqual([polygon]);
    expect(out.routes).toHaveLength(2);
    for (const r of out.routes) {
      expect(r.assessment).toBeUndefined();
      expect(r.knownClosures).toMatchObject({
        coverage: "incomplete",
        state: "applied",
        geometryHash: canonicalRoutingHash(r.geometry),
        requestHash: canonicalRoutingHash(out.query),
        appliedClosureCount: 1
      });
    }
    const require = createRequire(import.meta.url),
      Ajv = require("ajv/dist/2020").default,
      ajv = new Ajv({ strict: false });
    require("ajv-formats").default(ajv);
    const schema = JSON.parse(readFileSync(new URL("../../../openapi/fragments/known-road-closures.schema.json", import.meta.url), "utf8"));
    expect(ajv.compile(schema)(out.routes[0]!.knownClosures)).toBe(true);
  });
  it("checks even surplus native variants outside the OD corridor before truncating", async () => {
    const f = await fixture();
    f.fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("/status")
        ? Response.json({ version: "3.8.3", tileset_last_modified: tileset })
        : Response.json({
            ...reply(),
            alternates: [
              {
                trip: trip([
                  [14.42, 50.08],
                  [14.5, 50.1],
                  [14.45, 50.1]
                ])
              }
            ]
          })
    );
    await expect(f.service.route({ ...request(), alternatives: 1 })).rejects.toMatchObject({ status: 502, code: "ROUTING_KNOWN_CLOSURES_ENGINE_FAILED" });
  });
  it("does not cache old exclusions or fall back on a source/engine outage", async () => {
    const f = await fixture();
    await f.service.route(request());
    f.options.loadSnapshot = vi.fn(async () => {
      throw new Error("source outage");
    });
    await expect(f.service.route(request())).rejects.toThrow();
    expect(f.payloads).toHaveLength(1);
  });
  it.each(["graph", "revision", "expiry", "revocation"])("fences a %s change during the engine call", async (kind) => {
    const f = await fixture();
    let statusCount = 0;
    f.fetchMock.mockImplementation(async (url) => {
      if (String(url).endsWith("/status"))
        return Response.json({ version: "3.8.3", tileset_last_modified: ++statusCount > 1 && kind === "graph" ? tileset + 1 : tileset });
      if (kind === "expiry") vi.setSystemTime(now + 600000);
      if (kind === "revision") f.setSnapshot({ ...f.snapshot, revision: "changed" });
      if (kind === "revocation") f.setSnapshot({ ...f.snapshot, closures: [] });
      return Response.json(reply());
    });
    await expect(f.service.route(request())).rejects.toMatchObject({ status: 503 });
  });
  it("rejects an unaccepted engine, engine warnings and future departure", async () => {
    const f = await fixture();
    f.options.acceptedEngineVersions = [];
    await expect(f.service.route(request())).rejects.toMatchObject({ status: 503 });
    f.options.acceptedEngineVersions = ["3.8.3"];
    f.fetchMock.mockImplementation(async (url) =>
      String(url).endsWith("/status")
        ? Response.json({ version: "3.8.3", tileset_last_modified: tileset })
        : Response.json({ ...reply(), warnings: [{ code: 1 }] })
    );
    await expect(f.service.route(request())).rejects.toMatchObject({ status: 502 });
    await expect(f.service.route({ ...request(), departureTime: "2026-10-04T12:00:00Z" })).rejects.toMatchObject({ status: 422 });
  });
});
