// Execute inside SIM or COP API; emits only aggregate proof, never provider bodies.
import assert from "node:assert/strict";
const base = (process.env.COP_SAFETY_DATA_BASE_URL ?? "http://127.0.0.1:4030/api/v1").replace(/\/$/, "");
const request = async (path) => {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(30000) });
  const body = await response.json();
  return { status: response.status, body, latencyMs: Math.round(performance.now() - started) };
};
const first = await request("/context/news");
const second = await request("/context/news");
assert.equal(first.status, 200);
assert.equal(first.body.contractVersion, "sim-crisis-media-context-v1");
assert.equal(first.body.status, "ok");
assert.equal(first.body.sources.length, 3);
assert.ok(first.body.items.length <= 100);
assert.ok(
  first.body.items.every((item) => item.location === null && item.eventAt === null && item.notificationEligible === false && !item.description && !item.raw)
);
assert.deepEqual(
  second.body.sources.map((source) => source.fetchedAt),
  first.body.sources.map((source) => source.fetchedAt)
);
const invalid = await request("/context/news?feeds=unknown");
assert.equal(invalid.status, 400);
assert.equal(invalid.body.error.code, "INVALID_MEDIA_NEWS_QUERY");
assert.equal(typeof invalid.body.error.correlationId, "string");
const municipal = await request("/features?source=municipal_alerts&layers=warnings&bbox=11.8,48.5,19.2,51.2&limit=500");
assert.equal(municipal.status, 200);
assert.deepEqual(municipal.body.query.sources, ["municipal_alerts"]);
assert.ok(municipal.body.features.every((feature) => !feature.properties.raw && feature.properties.providerProperties?.notification));
const hzs = await request("/notifications/candidates?source=hzs_incidents&bbox=15.05,49.45,16.95,50.85&limit=100");
assert.equal(hzs.status, 200);
assert.ok(["ready", "unavailable", "incomplete"].includes(hzs.body.inputReadiness?.status));
assert.ok(hzs.body.candidates.every((candidate) => !candidate.feature.raw));
if (hzs.body.inputReadiness.status !== "ready") assert.equal(hzs.body.candidates.length, 0);
console.log(
  JSON.stringify({
    news: {
      status: first.body.status,
      itemCount: first.body.items.length,
      sources: first.body.sources.map((source) => ({ id: source.id, status: source.status })),
      latencyMs: first.latencyMs,
      cachedLatencyMs: second.latencyMs,
      snapshotReused: true,
      invalidQueryStatus: invalid.status
    },
    municipal: {
      featureCount: municipal.body.features.length,
      warningCount: municipal.body.warnings.length,
      latencyMs: municipal.latencyMs,
      notificationEligibleCount: municipal.body.features.filter((feature) => feature.properties.providerProperties.notification.eligible === true).length
    },
    hzs: {
      featureCount: hzs.body.summary.featureCount,
      candidateCount: hzs.body.candidates.length,
      readiness: hzs.body.inputReadiness,
      skippedReasons: hzs.body.summary.eligibilitySkippedReasons,
      warningCount: hzs.body.warnings.length,
      latencyMs: hzs.latencyMs
    }
  })
);
