import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateFlows, verifyTrafficReliability } from "./verify-valhalla-traffic-reliability.mjs";

const NOW = Date.parse("2026-10-01T16:00:00Z");
const iso = (offset) => new Date(NOW + offset).toISOString();
const DATASET = "sim-routing-2026-09-29-1790679143";
const PRIVATE = "SYNTHETIC_PRIVATE_PROVIDER_VALUE_NOT_FOR_OUTPUT";
const TOKEN = "synthetic-test-control-token";

function fixture(change = {}) {
  const current = { enabled: true, state: "current", routingDataset: DATASET, overlayGeneration: "test-generation-1",
    updatedAt: iso(-1000), usableUntil: iso(60000), appliedEdgeCount: 5, activeUntil: iso(900000), lastVehicleRequestAt: iso(0), detail: PRIVATE };
  const feed = { contractVersion: "sim-valhalla-live-traffic-feed-v1", generatedAt: iso(-1000), staticRevision: "a".repeat(64), dynamicRevision: "b".repeat(64),
    sourceTiming: { requestStartedAt: iso(-2000), lastCheckedAt: iso(-1000), lastChangedAt: iso(-1000), nextRefreshAt: iso(298000), requestDurationMs: 1000,
      lastResponseStatus: 200, freshFlowCount: 1, expiredFlowCount: 1, invalidTimestampFlowCount: 1, lastError: PRIVATE },
    flows: [{ messageId: PRIVATE, observedAt: iso(-10000), validUntil: iso(60000), averageSpeedKph: 50 },
      { messageId: PRIVATE, observedAt: iso(-60000), validUntil: iso(-1000), averageSpeedKph: 40 },
      { messageId: PRIVATE, observedAt: "missing-timezone", averageSpeedKph: 30 }] };
  const values = {
    before: structuredClone(current), after: structuredClone(current), feed,
    route: { source: { backend: "valhalla" }, traffic: { liveSpeeds: structuredClone(current) }, routes: [{ status: "ok", distanceM: 1000, durationSeconds: 100, geometry: PRIVATE }] },
    feedStatus: 200, unauthorizedStatus: 401, routeStatus: 200, ...change
  };
  const calls = [];
  let statusCalls = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(new URL(url).origin, "http://127.0.0.1:4020");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    const path = new URL(url).pathname;
    calls.push({ path, options });
    if (change.failPath === path) throw new Error(PRIVATE);
    let response, status = 200;
    if (path === "/health/live") response = { status: "ok" };
    else if (path === "/health/ready") response = { routing: { status: "ok", valhallaVersion: "3.8.3", routingDataset: { version: DATASET } }, ignored: PRIVATE };
    else if (path.endsWith("/status") && options.headers.Authorization === undefined) { status = values.unauthorizedStatus; response = { code: "UNAUTHORIZED", message: PRIVATE }; }
    else if (path.endsWith("/status")) { assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`); response = statusCalls++ ? values.after : values.before; }
    else if (path === "/api/v1/routing/route") { response = values.route; status = values.routeStatus; }
    else if (path.endsWith("/feed")) {
      assert.equal(new URL(url).search, "?includeStatic=false");
      assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
      response = values.feed; status = values.feedStatus;
    } else throw new Error("Unexpected test request");
    return new Response(JSON.stringify(response), { status });
  };
  return { values, calls, options: { fetchImpl, now: () => NOW, env: { VALHALLA_TRAFFIC_CONTROL_TOKEN: TOKEN, VALHALLA_TRAFFIC_MAX_AGE_SECONDS: "1800" } } };
}

test("current bounded sample verifies the route, private feed and generation without leaking payloads", async () => {
  const sample = fixture();
  const report = await verifyTrafficReliability(sample.options);
  assert.equal(report.outcome, "technical_sample_pass");
  assert.equal(report.fullAcceptance, false);
  assert.equal(report.samples.feed.totalFlowCount, 3);
  assert.equal(report.samples.feed.freshFlowCount, 1);
  assert.equal(report.samples.feed.expiredFlowCount, 1);
  assert.equal(report.samples.feed.invalidTimestampFlowCount, 1);
  assert.equal(report.samples.feed.sourceTiming.hasLastError, true);
  assert.equal(JSON.stringify(report).includes(PRIVATE), false);
  assert.equal(JSON.stringify(report).includes(TOKEN), false);
  assert.equal(sample.calls.length, 7);
  const route = sample.calls.find((call) => call.path === "/api/v1/routing/route");
  assert.deepEqual(JSON.parse(route.options.body), { profileId: "car", from: { lon: 14.42076, lat: 50.08804 }, to: { lon: 14.4461, lat: 50.0755 }, includeTraffic: true, alternatives: 1 });
});

test("cold warming 503 is explicitly transition, never full acceptance", async () => {
  const sample = fixture();
  sample.values.before.state = "idle";
  sample.values.after.state = "warming";
  sample.values.route.traffic.liveSpeeds.state = "warming";
  sample.values.feedStatus = 503;
  sample.values.feed = { code: "VALHALLA_TRAFFIC_FEED_UNAVAILABLE", message: PRIVATE };
  const report = await verifyTrafficReliability(sample.options);
  assert.equal(report.outcome, "transition");
  assert.equal(report.fullAcceptance, false);
  assert.equal(report.samples.feed.expectedWarming, true);
  assert.equal(report.checks.some((item) => item.state === "fail"), false);
  assert.equal(JSON.stringify(report).includes(PRIVATE), false);
});

test("current without a trusted future bounded deadline fails", async () => {
  for (const expiry of [undefined, iso(-1), iso(1800001)]) {
    const sample = fixture();
    sample.values.before.usableUntil = expiry;
    sample.values.after.usableUntil = expiry;
    sample.values.route.traffic.liveSpeeds.usableUntil = expiry;
    assert.equal((await verifyTrafficReliability(sample.options)).outcome, "fail");
  }
});

test("wrong captured routing dataset fails and unacknowledged generation is a transition", async () => {
  const wrong = fixture();
  wrong.values.route.traffic.liveSpeeds.routingDataset = "sim-routing-2026-09-30-1790765543";
  assert.equal((await verifyTrafficReliability(wrong.options)).outcome, "fail");
  const moving = fixture();
  moving.values.route.traffic.liveSpeeds.overlayGeneration = "intermediate-generation";
  assert.equal((await verifyTrafficReliability(moving.options)).outcome, "transition");
});

test("auth failure, unexpected static records and request failures are explicit and sanitized", async () => {
  const unauthorized = fixture({ unauthorizedStatus: 200 });
  assert.equal((await verifyTrafficReliability(unauthorized.options)).outcome, "fail");
  const staticFeed = fixture();
  staticFeed.values.feed.segments = [{ messageId: PRIVATE }];
  assert.equal((await verifyTrafficReliability(staticFeed.options)).outcome, "fail");
  const broken = fixture({ failPath: "/health/live" });
  const report = await verifyTrafficReliability(broken.options);
  assert.equal(report.outcome, "fail");
  assert.equal(JSON.stringify(report).includes(PRIVATE), false);
});

test("missing control token stops before any localhost request", async () => {
  const sample = fixture();
  sample.options.env = {};
  const report = await verifyTrafficReliability(sample.options);
  assert.equal(report.outcome, "fail");
  assert.equal(sample.calls.length, 0);
});

test("flow aggregation never manufactures observation time and caps missing expiry by maximum age", () => {
  const summary = aggregateFlows([
    { observedAt: undefined }, { observedAt: "2026-10-01T15:59:00" },
    { observedAt: iso(31000) }, { observedAt: iso(-1000), validUntil: iso(-2000) },
    { observedAt: iso(-1800001) }, { observedAt: iso(-1000) }
  ], NOW, 1800);
  assert.equal(summary.totalFlowCount, 6);
  assert.equal(summary.invalidTimestampFlowCount, 4);
  assert.equal(summary.expiredFlowCount, 1);
  assert.equal(summary.freshFlowCount, 1);
});
