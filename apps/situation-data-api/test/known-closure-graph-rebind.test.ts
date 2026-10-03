import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { probeApprovedGraph, verifiedGraphBinding } from "../src/known-closure-graph-rebind.js";
import { encodeValhallaPolyline6 } from "../src/routing-service.js";
import { parseTpeg2Tec, type Tpeg2Source } from "../src/tpeg2-source.js";
import type { KnownClosureReviewSet } from "../src/known-road-closures.js";

const now = Date.parse("2026-10-03T12:00:00Z"),
  tileset = Math.floor(now / 1000) - 60;
const dataset = { version: `sim-routing-2026-10-03-${tileset}`, builtAt: new Date(tileset * 1000).toISOString() };
const from: [number, number] = [14.5, 50.0995],
  to: [number, number] = [14.5, 50.1005];
const center: Array<[number, number]> = [
  [14.5, 50.09999],
  [14.5, 50.10001]
];
const polygon: Array<[number, number]> = [
  [14.49995, 50.09995],
  [14.50005, 50.09995],
  [14.50005, 50.10005],
  [14.49995, 50.10005],
  [14.49995, 50.09995]
];
const baseline: Array<[number, number]> = [from, [14.5, 50.1], to];
const bypass: Array<[number, number]> = [from, [14.501, 50.1], to];
const xml = `<TPEGDocument docType="fullRepository" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:tec="http://www.tisa.org/TPEG/TEC_3_4"><ApplicationRootMessageML xsi:type="tec:TECMessage"><mmt><optionMessageManagement><messageID>99</messageID><versionID>2</versionID><cancelFlag>false</cancelFlag><messageGenerationTime>2026-10-03T11:00:00Z</messageGenerationTime><messageExpiryTime>2026-10-03T13:00:00Z</messageExpiryTime></optionMessageManagement></mmt><event><effectCode table="tec001_EffectCode" code="7"/><startTime>2026-10-03T11:00:00Z</startTime><stopTime>2026-10-03T14:00:00Z</stopTime><cause><optionDirectCause><unverifiedInformation>false</unverifiedInformation><freeText><value>Synthetic whole bridge closed</value></freeText></optionDirectCause></cause></event><loc><method><optionGeographicLocationReferenceLink><geographicLineReference><linePoints><Longitude>676828</Longitude><Latitude>2282845</Latitude></linePoints><linePoints><Longitude>676791</Longitude><Latitude>2282811</Latitude></linePoints><isFuzzyLine>true</isFuzzyLine></geographicLineReference></optionGeographicLocationReferenceLink></method></loc></ApplicationRootMessageML></TPEGDocument>`;
const trip = (shape: Array<[number, number]>) => ({
  status: 0,
  summary: { length: 0.3, time: 60 },
  legs: [{ shape: encodeValhallaPolyline6(shape), maneuvers: [{ type: 1, begin_shape_index: 0, end_shape_index: shape.length - 1, length: 0.3, time: 60 }] }]
});
let dir: string;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  dir = await mkdtemp(join(tmpdir(), "sim-graph-rebind-"));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});
async function fixture(fault?: string) {
  const records = await parseTpeg2Tec(xml, true);
  const evidence = { records, confirmedAt: new Date(now - 1000).toISOString() };
  const knownClosureEvidence = vi.fn(async () => structuredClone(evidence));
  const source = { knownClosureEvidence } as unknown as Tpeg2Source;
  const set: KnownClosureReviewSet = {
    version: "sim-known-closure-reviews-v1",
    revision: "approved-synthetic",
    routingDataset: { version: "sim-routing-2026-09-29-1790679143", builtAt: "2026-09-29T10:52:23.000Z" },
    reviews: [
      {
        id: "synthetic",
        eventId: "99",
        eventSemanticHash: records[0]!.closureEvidence!.semanticHash,
        osmWayId: "1",
        reviewedAt: "2026-10-03T11:59:00Z",
        sourceUrl: "https://synthetic.invalid/closure",
        scopeBasis: "official_whole_structure_statement",
        polygon,
        graphProbe: { version: "sim-known-closure-graph-probe-v1", shape: center, from, to }
      }
    ]
  };
  const config = { ...(await loadConfig()), valhallaBaseUrl: "http://synthetic.valhalla" };
  let statuses = 0;
  const calls = vi.fn(async (url: string, init?: RequestInit) => {
    if (fault === "outage") throw Error("Unavailable");
    if (url.endsWith("/status")) {
      statuses++;
      return Response.json({
        version: fault === "engine" ? "unreviewed" : "3.8.3",
        tileset_last_modified: tileset + (fault === "graph-race" && statuses > 1 ? 1 : 0)
      });
    }
    const body = JSON.parse(String(init?.body));
    if (url.endsWith("/trace_attributes")) {
      if (body.shape) {
        return Response.json({
          shape: encodeValhallaPolyline6(body.shape.map((p: any) => [p.lon, p.lat])),
          edges: [{ way_id: fault === "wrong-structure" ? "2" : "1" }]
        });
      }
      const bridge = [encodeValhallaPolyline6(baseline), encodeValhallaPolyline6([...baseline].reverse())].includes(body.encoded_polyline);
      const alternateBridge = [encodeValhallaPolyline6([from, [14.502, 50.1], to]), encodeValhallaPolyline6([to, [14.502, 50.1], from])].includes(
        body.encoded_polyline
      );
      if (fault === "alternate-edge" && alternateBridge) return Response.json({ edges: [{ way_id: "1" }] });
      return Response.json({ edges: [{ way_id: fault === "baseline-missing" ? "2" : fault === "avoided-edge" ? "1" : bridge ? "1" : "2" }] });
    }
    const reverse = body.locations[0].lat === to[1],
      excluded = !!body.exclude_polygons;
    const shape = excluded ? bypass : baseline,
      oriented = reverse ? [...shape].reverse() : shape;
    const value: any = { trip: trip(oriented) };
    if (fault === "intersect" && excluded) value.trip = trip(reverse ? [...baseline].reverse() : baseline);
    if (fault === "surplus-intersect" && excluded) value.alternates = [{ trip: trip(reverse ? [...baseline].reverse() : baseline) }];
    if (fault === "alternate-edge" && excluded) value.alternates = [{ trip: trip(reverse ? [to, [14.502, 50.1], from] : [from, [14.502, 50.1], to]) }];
    if (fault === "maneuvers") value.trip.legs[0].maneuvers[0].begin_shape_index = 1;
    if (fault === "warning") value.warnings = ["Unsupported option"];
    if (fault === "deadline") vi.setSystemTime(now + 11000);
    return Response.json(value);
  });
  vi.stubGlobal("fetch", calls);
  return { set, config, source, evidence, knownClosureEvidence, calls };
}
it("rebinds only the same approved structure after both positive/negative directional and final source/graph checks", async () => {
  const f = await fixture(),
    result = await probeApprovedGraph(f.set, dataset, f.config, f.source, ["3.8.3"]);
  expect(result.routingDataset).toEqual(dataset);
  expect(result.revision).not.toBe(f.set.revision);
  expect(result.reviews).toEqual(f.set.reviews);
  expect(f.set.routingDataset).not.toEqual(dataset);
  expect(f.calls).toHaveBeenCalledTimes(12);
  expect(f.knownClosureEvidence).toHaveBeenCalledTimes(2);
  const routes = f.calls.mock.calls.filter(([url]) => url.endsWith("/route"));
  const walked = f.calls.mock.calls
    .filter(([url, i]) => url.endsWith("/trace_attributes") && JSON.parse(String(i?.body)).encoded_polyline)
    .map(([, i]) => JSON.parse(String(i?.body)).encoded_polyline);
  expect(walked).toEqual([bypass, baseline, [...bypass].reverse(), [...baseline].reverse()].map(encodeValhallaPolyline6));
  expect(routes).toHaveLength(4);
  expect(routes.map(([, i]) => (JSON.parse(String(i?.body)).exclude_polygons ? "excluded" : "baseline"))).toEqual([
    "baseline",
    "excluded",
    "baseline",
    "excluded"
  ]);
});
it.each(["engine", "wrong-structure", "baseline-missing", "avoided-edge", "intersect", "surplus-intersect", "maneuvers", "warning", "graph-race", "deadline"])(
  "rejects %s without fallback",
  async (fault) => {
    const f = await fixture(fault);
    await expect(probeApprovedGraph(f.set, dataset, f.config, f.source, ["3.8.3"])).rejects.toThrow();
  }
);
it("rejects missing anchors, multiple reviews, changed semantics and stale/future graphs", async () => {
  const f = await fixture();
  for (const edit of [
    (s: KnownClosureReviewSet) => {
      delete s.reviews[0]!.graphProbe;
    },
    (s: KnownClosureReviewSet) => {
      s.reviews.push({ ...s.reviews[0]!, id: "another", eventId: "98" });
    },
    (s: KnownClosureReviewSet) => {
      s.reviews[0]!.eventSemanticHash = "0".repeat(64);
    }
  ]) {
    const s = structuredClone(f.set);
    edit(s);
    await expect(probeApprovedGraph(s, dataset, f.config, f.source, ["3.8.3"])).rejects.toThrow();
  }
  for (const builtAt of ["2026-09-01T00:00:00Z", "2026-10-04T00:00:00Z"])
    await expect(probeApprovedGraph(f.set, { ...dataset, builtAt }, f.config, f.source, ["3.8.3"])).rejects.toThrow();
  expect(f.calls).not.toHaveBeenCalled();
});
it("rejects source confirmation/semantic changes during probing", async () => {
  const f = await fixture();
  f.knownClosureEvidence
    .mockImplementationOnce(async () => structuredClone(f.evidence))
    .mockImplementationOnce(async () => ({ ...f.evidence, confirmedAt: new Date(now).toISOString() }));
  await expect(probeApprovedGraph(f.set, dataset, f.config, f.source, ["3.8.3"])).rejects.toThrow();
});
it("deduplicates concurrent probes, preserves the file, caches only a detached binding", async () => {
  const f = await fixture(),
    path = join(dir, "review.json"),
    text = JSON.stringify(f.set);
  await writeFile(path, text, { mode: 0o600 });
  const args = [path, text, dataset, f.config, f.source, ["3.8.3"]] as const;
  const [a, b] = await Promise.all([verifiedGraphBinding(...args), verifiedGraphBinding(...args)]);
  expect(a).toEqual(b);
  expect(f.calls).toHaveBeenCalledTimes(12);
  expect(await readFile(path, "utf8")).toBe(text);
  a.reviews[0]!.id = "client-mutated";
  expect((await verifiedGraphBinding(...args)).reviews[0]!.id).toBe("synthetic");
  expect(f.calls).toHaveBeenCalledTimes(12);
});
it("fences approval-file races and throttles failed probes without hiding the failure", async () => {
  const f = await fixture(),
    path = join(dir, "review.json"),
    text = JSON.stringify(f.set);
  await writeFile(path, text + " ");
  const args = [path, text, dataset, f.config, f.source, ["3.8.3"]] as const;
  await expect(verifiedGraphBinding(...args)).rejects.toThrow();
  const count = f.calls.mock.calls.length;
  await expect(verifiedGraphBinding(...args)).rejects.toThrow();
  expect(f.calls).toHaveBeenCalledTimes(count);
});
it("returns a typed unavailable error on network failure without an unconstrained retry", async () => {
  const f = await fixture("outage"),
    path = join(dir, "review.json"),
    text = JSON.stringify(f.set);
  await writeFile(path, text);
  await expect(verifiedGraphBinding(path, text, dataset, f.config, f.source, ["3.8.3"])).rejects.toMatchObject({
    status: 503,
    code: "ROUTING_KNOWN_CLOSURES_REVIEW_REQUIRED"
  });
  expect(f.calls).toHaveBeenCalledTimes(1);
});
it("rejects a constrained alternate on the reviewed OSM way even outside the approved polygon", async () => {
  const f = await fixture("alternate-edge");
  await expect(probeApprovedGraph(f.set, dataset, f.config, f.source, ["3.8.3"])).rejects.toThrow();
  const walked = f.calls.mock.calls
    .filter(([url, i]) => url.endsWith("/trace_attributes") && JSON.parse(String(i?.body)).encoded_polyline)
    .map(([, i]) => JSON.parse(String(i?.body)).encoded_polyline);
  expect(walked).toContain(encodeValhallaPolyline6([from, [14.502, 50.1], to]));
});
