import { test } from "node:test";
import assert from "node:assert/strict";
import { observeTrafficReliability, safeQuota } from "./observe-valhalla-traffic-reliability.mjs";

const START = Date.parse("2026-10-01T16:00:00Z");
const TOKEN = "synthetic-private-token", PRIVATE = "PRIVATE_RAW_PROVIDER_RECORD";
const iso = (ms) => new Date(ms).toISOString();
const quota = (ms = START) => JSON.stringify({ version: 1, static: { nextAttemptAtMs: ms }, dynamic: { nextAttemptAtMs: ms }, tec: { nextAttemptAtMs: ms } });
function fixture({ perpetuallyActive = false, spacing = 300000, malformed = false, fail = false, changingIdleQuota = false,
  wallClock = "normal", providerStatus = 200, providerError = false, inconsistentCounts = false } = {}) {
  let time = START;
  const calls = [], emitted = [], sleeps = [];
  const options = { now: () => wallClock === "constant" ? START : wallClock === "backwards" ? START - (time - START) : time,
    monotonicNow: () => time - START,
    sleepImpl: async (ms) => { sleeps.push(ms); time += ms; },
    env: { VALHALLA_TRAFFIC_CONTROL_TOKEN: TOKEN }, emit: (event) => emitted.push(event),
    readFileImpl: async (path) => { assert.equal(path, "/valhalla-traffic-cache/provider-request-timing.json"); return malformed ? "invalid-private-json" : quota(changingIdleQuota ? time : START); },
    fetchImpl: async (url, request) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, "http://127.0.0.1:4020");
      assert.equal(request.method, "GET");
      assert.equal(request.redirect, "error");
      assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
      assert.ok(request.signal instanceof AbortSignal);
      assert.ok(parsed.pathname.endsWith("/status") || parsed.pathname.endsWith("/feed"));
      calls.push(url);
      if (fail) throw new Error(PRIVATE);
      const active = perpetuallyActive || time < START + 900000;
      if (parsed.pathname.endsWith("/status")) return new Response(JSON.stringify({ enabled: true, state: active ? "degraded" : "idle",
        activeUntil: iso(perpetuallyActive ? time + 900000 : START + 900000), updatedAt: iso(time),
        overlayGeneration: "synthetic-generation", routingDataset: "sim-routing-2026-09-29-1790679143", detail: PRIVATE }), { status: 200 });
      assert.equal(parsed.search, "?includeStatic=false");
      if (!active) return new Response(null, { status: 204 });
      const sourceStart = START + Math.floor((time - START) / spacing) * spacing;
      return new Response(JSON.stringify({ contractVersion: "sim-valhalla-live-traffic-feed-v1",
        sourceTiming: { requestStartedAt: iso(sourceStart), lastCheckedAt: iso(sourceStart + 1000),
          requestDurationMs: 1000, lastResponseStatus: providerStatus, freshFlowCount: inconsistentCounts ? 999 : 1,
          expiredFlowCount: 1, invalidTimestampFlowCount: 0, ...(providerError ? { lastError: PRIVATE } : {}), providerError: PRIVATE },
        flows: [{ messageId: PRIVATE, observedAt: iso(time - 1000), validUntil: iso(time + 1000) },
          { messageId: PRIVATE, observedAt: iso(time - 5000), validUntil: iso(time - 1000) }], privateValue: PRIVATE }), { status: 200 });
    } };
  return { options, calls, emitted, sleeps, elapsed: () => time - START, advance: (ms) => { time += ms; } };
}

test("three spaced starts then sixty seconds of natural idle with unchanged quota pass without route or data leakage", async () => {
  const value = fixture(), result = await observeTrafficReliability(value.options);
  assert.equal(result.outcome, "bounded_observation_pass");
  assert.equal(result.providerRequestStartCount, 3);
  assert.equal(result.naturalIdleVerified, true);
  assert.equal(result.quotaUnchangedDuringIdle, true);
  assert.equal(result.elapsedSeconds, 960);
  assert.equal(result.fullAcceptance, false);
  assert.equal(result.expiredFlowsObserved, true);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.ok(value.calls.every((url) => !url.includes("routing")));
  assert.equal(value.emitted.filter((event) => event.event === "sample").length, 4);
  assert.equal(value.emitted.filter((event) => event.event === "idle_checkpoint").length, 2);
});

test("other vehicle requests extending the lease end explicitly incomplete at twenty minutes", async () => {
  const result = await observeTrafficReliability(fixture({ perpetuallyActive: true }).options);
  assert.equal(result.outcome, "incomplete");
  assert.equal(result.elapsedSeconds, 1200);
  assert.equal(result.naturalIdleVerified, false);
  assert.ok(result.leaseExtensionCount > 0);
});

test("unchanged idle quota is required, not merely an idle status", async () => {
  const result = await observeTrafficReliability(fixture({ changingIdleQuota: true }).options);
  assert.equal(result.outcome, "incomplete");
  assert.equal(result.naturalIdleVerified, false);
});

test("source start spacing below the five-minute floor fails closed", async () => {
  const result = await observeTrafficReliability(fixture({ spacing: 120000 }).options);
  assert.equal(result.outcome, "fail");
  assert.ok(result.violationCount > 0);
  assert.equal(result.minimumProviderSpacingVerified, false);
});

test("unavailable or invalid local inputs never reveal raw errors or fabricate successful observation", async () => {
  for (const failure of [{ malformed: true }, { fail: true }]) {
    const result = await observeTrafficReliability(fixture(failure).options);
    assert.notEqual(result.outcome, "bounded_observation_pass");
    assert.ok(result.errorCount > 0);
    assert.equal(JSON.stringify(result).includes(PRIVATE), false);
    assert.equal(result.events.filter((event) => event.event === "error").length, 1);
  }
});

test("absent token prevents requests and quota reads", async () => {
  const value = fixture(); value.options.env = {};
  const result = await observeTrafficReliability(value.options);
  assert.equal(result.outcome, "fail");
  assert.equal(value.calls.length, 0);
});

test("quota requires initialized runtime timing structures without inventing zeros for cold partial files", () => {
  assert.equal(safeQuota(quota()).dynamic.nextAttemptAtMs, START);
  for (const raw of [JSON.stringify({ ...JSON.parse(quota()), secret: PRIVATE }),
    JSON.stringify({ ...JSON.parse(quota()), dynamic: { nextAttemptAtMs: START, url: PRIVATE } }),
    JSON.stringify({ version: 1 }), JSON.stringify({ ...JSON.parse(quota()), tec: { nextAttemptAtMs: -1 } })]) {
    assert.throws(() => safeQuota(raw));
  }
});

test("expired current overlay is rejected even with a valid generation and dataset", async () => {
  const value = fixture(), original = value.options.fetchImpl;
  value.options.fetchImpl = async (url, options) => {
    const response = await original(url, options);
    if (!new URL(url).pathname.endsWith("/status")) return response;
    const status = await response.json();
    status.state = "current";
    status.appliedEdgeCount = 5;
    status.usableUntil = iso(START - 1);
    return new Response(JSON.stringify(status), { status: 200 });
  };
  const result = await observeTrafficReliability(value.options);
  assert.equal(result.outcome, "fail");
  assert.ok(result.violationCount > 0);
  assert.equal(result.naturalIdleVerified, false);
  assert.equal(result.events.filter((event) => event.reason === "current_overlay_not_bounded").length, 1);
});

test("over-limit response is rejected and output remains sanitized", async () => {
  const value = fixture(), original = value.options.fetchImpl;
  let injected = false;
  value.options.fetchImpl = async (url, options) => {
    if (!injected && new URL(url).pathname.endsWith("/feed")) {
      injected = true;
      return new Response(new Uint8Array(48 * 1024 * 1024 + 1), { status: 200 });
    }
    return original(url, options);
  };
  const result = await observeTrafficReliability(value.options);
  assert.equal(result.outcome, "fail");
  assert.equal(result.errorCount, 1);
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
});

for (const wallClock of ["constant", "backwards"]) {
  test(`twenty-minute monotonic bound holds with a ${wallClock} wall clock and sleeps never exceed thirty seconds`, async () => {
    const value = fixture({ perpetuallyActive: true, wallClock });
    const result = await observeTrafficReliability(value.options);
    assert.notEqual(result.outcome, "bounded_observation_pass");
    assert.equal(result.elapsedSeconds, 1200);
    assert.equal(value.elapsed(), 1200000);
    assert.ok(value.sleeps.every((ms) => ms > 0 && ms <= 30000));
    assert.ok(value.calls.length <= 80);
    assert.equal(result.naturalIdleVerified, false);
  });
}

test("empty flows with inconsistent provider counts fail rather than manufacture acceptance", async () => {
  const value = fixture({ inconsistentCounts: true });
  const original = value.options.fetchImpl;
  value.options.fetchImpl = async (url, request) => {
    const response = await original(url, request);
    if (!new URL(url).pathname.endsWith("/feed") || response.status !== 200) return response;
    const feed = await response.json();
    feed.flows = [];
    return new Response(JSON.stringify(feed), { status: 200 });
  };
  const result = await observeTrafficReliability(value.options);
  assert.equal(result.outcome, "fail");
  assert.ok(result.violationCount > 0);
  assert.equal(result.providerRequestStartCount, 0);
});

test("provider error or failed upstream status explicitly fails the observation without disclosing raw errors", async () => {
  for (const failure of [{ providerError: true }, { providerStatus: 429 }, { providerStatus: 503 }]) {
    const result = await observeTrafficReliability(fixture(failure).options);
    assert.equal(result.outcome, "fail");
    assert.ok(result.providerFailureSampleCount > 0);
    assert.equal(JSON.stringify(result).includes(PRIVATE), false);
    assert.ok(result.events.some((event) => event.reason === "provider_refresh_failed"));
  }
});

test("quota returning after the hard deadline cannot turn an otherwise valid idle checkpoint into a pass", async () => {
  const value = fixture(), original = value.options.readFileImpl;
  let delayed = false;
  value.options.readFileImpl = async (...args) => {
    const raw = await original(...args);
    // Three starts and the first idle checkpoint already exist at this point.
    if (!delayed && value.elapsed() >= 960000) {
      delayed = true;
      value.advance(241000);
    }
    return raw;
  };
  const result = await observeTrafficReliability(value.options);
  assert.equal(delayed, true);
  assert.equal(result.outcome, "incomplete");
  assert.equal(result.providerRequestStartCount, 3);
  assert.equal(result.naturalIdleVerified, false);
  assert.ok(result.errorCount > 0);
  assert.equal(result.events.filter((event) => event.event === "idle_checkpoint" && event.checkpoint === 2).length, 0);
});

test("hung quota reads are awaited for no more than fifteen seconds or the remaining monotonic budget", async () => {
  const value = fixture({ perpetuallyActive: true }), budgets = [], originalFetch = value.options.fetchImpl;
  value.options.fetchImpl = async (...args) => {
    const response = await originalFetch(...args);
    // In the last polling slot, two requests consume part of the remaining
    // global budget. The final quota timeout must therefore be below 15 seconds.
    if (value.elapsed() >= 1170000) value.advance(9000);
    return response;
  };
  let rejection;
  value.options.readFileImpl = () => new Promise((_, reject) => { rejection = reject; });
  value.options.timerImpl = (callback, ms) => {
    budgets.push(ms);
    queueMicrotask(() => { value.advance(ms); callback(); });
    return {};
  };
  value.options.clearTimerImpl = () => {};
  const result = await observeTrafficReliability(value.options);
  assert.equal(result.outcome, "incomplete");
  assert.equal(result.elapsedSeconds, 1200);
  assert.ok(budgets.length > 0 && budgets.every((ms) => ms > 0 && ms <= 15000));
  assert.ok(budgets.some((ms) => ms < 15000));
  assert.equal(result.sampleCount, 0);
  assert.ok(result.errorCount > 0);
  // The detached operation is handled even if it rejects after its timeout.
  rejection(new Error(PRIVATE));
  await new Promise((resolveTick) => setImmediate(resolveTick));
  assert.equal(JSON.stringify(result).includes(PRIVATE), false);
});
