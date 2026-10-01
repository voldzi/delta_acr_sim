import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyTrafficIdle, safeIdleQuota } from "./verify-valhalla-traffic-idle.mjs";

const START = Date.parse("2026-10-01T16:00:00Z");
const TOKEN = "synthetic-private-token", PRIVATE = "PRIVATE_RAW_PROVIDER_RECORD";
const iso = (at) => new Date(at).toISOString();
const quota = (at = START) => JSON.stringify({ version: 1, static: { nextAttemptAtMs: at }, dynamic: { nextAttemptAtMs: at }, tec: { nextAttemptAtMs: at } });

function fixture({ active = false, routeFail = false, extendedLease = false, changedVehicleRequest = false,
  changedQuota = false, rawError = false, malformedQuota = false, feedAvailable = false, exceededDeadline = false } = {}) {
  let statusReads = 0, quotaReads = 0, monotonic = 0;
  const calls = [];
  const options = { env: { VALHALLA_TRAFFIC_CONTROL_TOKEN: TOKEN }, now: () => START,
    monotonicNow: () => monotonic,
    readFileImpl: async (path) => {
      assert.equal(path, "/valhalla-traffic-cache/provider-request-timing.json");
      quotaReads++;
      if (malformedQuota) return "invalid-private-json";
      return quota(changedQuota && quotaReads > 1 ? START + 1 : START);
    },
    fetchImpl: async (url, request) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, "http://127.0.0.1:4020");
      assert.equal(request.redirect, "error");
      assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
      assert.ok(request.signal instanceof AbortSignal);
      calls.push({ path: parsed.pathname, method: request.method, body: request.body && JSON.parse(request.body) });
      if (rawError) throw new Error(`${TOKEN}:${PRIVATE}`);
      if (parsed.pathname.endsWith("/status")) {
        assert.equal(request.method, "GET");
        statusReads++;
        return new Response(JSON.stringify({ enabled: true, state: active ? "warming" : "idle",
          activeUntil: iso(active || (extendedLease && statusReads > 1) ? START + 900000 : START - 1),
          lastVehicleRequestAt: iso(changedVehicleRequest && statusReads > 1 ? START - 500000 : START - 900001), detail: PRIVATE }), { status: 200 });
      }
      if (parsed.pathname.endsWith("/feed")) {
        assert.equal(request.method, "GET");
        assert.equal(parsed.search, "?includeStatic=false");
        return feedAvailable ? new Response(JSON.stringify({ providerRecords: PRIVATE }), { status: 200 }) : new Response(null, { status: 204 });
      }
      assert.equal(parsed.pathname, "/api/v1/routing/route");
      assert.equal(request.method, "POST");
      const body = JSON.parse(request.body);
      assert.ok(["walking", "bicycle"].includes(body.profileId));
      assert.equal(body.includeTraffic, false);
      assert.deepEqual(body.from, { lon: 14.42076, lat: 50.08804 });
      assert.deepEqual(body.to, { lon: 14.4461, lat: 50.0755 });
      if (exceededDeadline) monotonic = 60001;
      return new Response(JSON.stringify({ source: { backend: "valhalla", privateValue: PRIVATE }, routes: [{ status: "ok", distanceM: 2500, durationSeconds: 900, rawProvider: PRIVATE }], detail: PRIVATE }), { status: routeFail ? 503 : 200 });
    } };
  return { options, calls, quotaReads: () => quotaReads };
}

test("natural idle permits only walking and bicycle without lease or quota changes", async () => {
  const value = fixture(), result = await verifyTrafficIdle(value.options);
  assert.equal(result.outcome, "idle_non_vehicle_pass");
  assert.equal(result.fullAcceptance, false);
  assert.equal(result.checks.every((check) => check.state === "pass"), true);
  assert.deepEqual(value.calls.map((call) => [call.method, call.path]), [
    ["GET", "/api/v1/internal/valhalla-traffic/status"], ["POST", "/api/v1/routing/route"],
    ["POST", "/api/v1/routing/route"], ["GET", "/api/v1/internal/valhalla-traffic/status"],
    ["GET", "/api/v1/internal/valhalla-traffic/feed"]
  ]);
  assert.deepEqual(value.calls.filter((call) => call.method === "POST").map((call) => call.body.profileId), ["walking", "bicycle"]);
  assert.equal(value.quotaReads(), 2);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
});

test("non-idle preflight refuses without any route or quota read", async () => {
  const value = fixture({ active: true }), result = await verifyTrafficIdle(value.options);
  assert.equal(result.outcome, "refused");
  assert.equal(value.calls.length, 1);
  assert.equal(value.calls.some((call) => call.method === "POST"), false);
  assert.equal(value.quotaReads(), 0);
});

test("route failure stops at walking and never claims idle acceptance", async () => {
  const value = fixture({ routeFail: true }), result = await verifyTrafficIdle(value.options);
  assert.equal(result.outcome, "fail");
  assert.equal(value.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(result.checks.find((check) => check.name === "walking_route_valid").state, "fail");
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
});

test("a newly active lease fails and prevents feed access", async () => {
  const value = fixture({ extendedLease: true }), result = await verifyTrafficIdle(value.options);
  assert.equal(result.outcome, "fail");
  assert.equal(result.checks.find((check) => check.name === "active_until_unchanged").state, "fail");
  assert.equal(value.calls.some((call) => call.path.endsWith("/feed")), false);
});

test("changed last vehicle request or quota cannot pass", async () => {
  for (const change of [{ changedVehicleRequest: true }, { changedQuota: true }]) {
    const result = await verifyTrafficIdle(fixture(change).options);
    assert.equal(result.outcome, "fail");
    assert.equal(result.checks.some((check) => check.state === "fail"), true);
  }
});

test("available idle feed fails without exposing provider records", async () => {
  const result = await verifyTrafficIdle(fixture({ feedAvailable: true }).options);
  assert.equal(result.outcome, "fail");
  assert.equal(result.checks.find((check) => check.name === "idle_feed_empty").state, "fail");
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
});

test("invalid quota or thrown errors are sanitized and prevent route requests", async () => {
  for (const failure of [{ rawError: true }, { malformedQuota: true }]) {
    const value = fixture(failure), result = await verifyTrafficIdle(value.options);
    assert.equal(result.outcome, "fail");
    assert.equal(value.calls.some((call) => call.method === "POST"), false);
    assert.equal(JSON.stringify(result).includes(PRIVATE), false);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
  }
});

test("absent token prevents all requests and quota reads", async () => {
  const value = fixture(); value.options.env = {};
  const result = await verifyTrafficIdle(value.options);
  assert.equal(result.outcome, "fail");
  assert.equal(value.calls.length, 0);
  assert.equal(value.quotaReads(), 0);
});

test("monotonic whole-run deadline prevents further routes with a frozen wall clock", async () => {
  const value = fixture({ exceededDeadline: true }), result = await verifyTrafficIdle(value.options);
  assert.equal(result.outcome, "fail");
  assert.equal(result.elapsedSeconds, 60.001);
  assert.equal(value.calls.filter((call) => call.method === "POST").length, 1);
});

test("quota returning after the whole-run deadline fails without a route request", async () => {
  const value = fixture();
  let monotonic = 0;
  value.options.monotonicNow = () => monotonic;
  value.options.readFileImpl = async () => {
    monotonic = 60001;
    return quota();
  };
  const result = await verifyTrafficIdle(value.options);
  assert.equal(result.outcome, "fail");
  assert.equal(result.elapsedSeconds, 60.001);
  assert.equal(value.calls.some((call) => call.method === "POST"), false);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
});

test("an unresolved quota read is capped by the remaining monotonic budget", async () => {
  const value = fixture(), original = value.options.fetchImpl;
  let monotonic = 0;
  value.options.monotonicNow = () => monotonic;
  value.options.fetchImpl = async (url, options) => {
    const response = await original(url, options);
    monotonic = 59999;
    return response;
  };
  value.options.readFileImpl = () => new Promise(() => {});
  const result = await verifyTrafficIdle(value.options);
  assert.equal(result.outcome, "fail");
  assert.equal(value.calls.some((call) => call.method === "POST"), false);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
});

test("non-Valhalla, non-ok, zero or nonfinite route metrics cannot pass", async () => {
  for (const route of [
    { source: { backend: "fallback" }, routes: [{ status: "ok", distanceM: 1, durationSeconds: 1 }] },
    { source: { backend: "valhalla" }, routes: [{ status: "error", distanceM: 1, durationSeconds: 1 }] },
    { source: { backend: "valhalla" }, routes: [{ status: "ok", distanceM: 0, durationSeconds: 1 }] },
    { source: { backend: "valhalla" }, routes: [{ status: "ok", distanceM: 1, durationSeconds: Infinity }] }
  ]) {
    const value = fixture(), original = value.options.fetchImpl;
    value.options.fetchImpl = async (url, options) => options.method === "POST"
      ? new Response(JSON.stringify(route), { status: 200 }) : original(url, options);
    assert.equal((await verifyTrafficIdle(value.options)).outcome, "fail");
  }
});

test("quota validation rejects extra fields, missing feeds and unsafe times", () => {
  assert.equal(safeIdleQuota(quota()).dynamic.nextAttemptAtMs, START);
  for (const raw of [JSON.stringify({ ...JSON.parse(quota()), secret: PRIVATE }),
    JSON.stringify({ ...JSON.parse(quota()), dynamic: { nextAttemptAtMs: START, secret: PRIVATE } }),
    JSON.stringify({ version: 1 }), JSON.stringify({ ...JSON.parse(quota()), tec: { nextAttemptAtMs: -1 } }),
    JSON.stringify({ ...JSON.parse(quota()), tec: { nextAttemptAtMs: 8640000000000001 } })]) {
    assert.throws(() => safeIdleQuota(raw));
  }
});

test("over-limit response fails without retaining the raw body", async () => {
  const value = fixture(), original = value.options.fetchImpl;
  value.options.fetchImpl = async (url, options) => options.method === "POST"
    ? new Response(new Uint8Array(48 * 1024 * 1024 + 1), { status: 200 }) : original(url, options);
  const result = await verifyTrafficIdle(value.options);
  assert.equal(result.outcome, "fail");
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
});
