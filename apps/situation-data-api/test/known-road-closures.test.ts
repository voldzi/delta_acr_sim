import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
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
  it("preserves explicit mapped alternatives on route as well as alternatives endpoint", async () => {
    const f = await fixture();
    const p = { version: "sim-mapped-road-profile-v1" as const, intent: "car" as const, coverageAcknowledged: "mapped_restrictions_incomplete" as const };
    const response = await f.service.route({ ...request(), vehicleProfile: p });
    expect(response.query.alternatives).toBe(2);
    expect(response.routes).toHaveLength(2);
    expect(f.payloads[0].alternates).toBe(1);
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
