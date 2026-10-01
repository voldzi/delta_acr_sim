#!/usr/bin/env node
// Run inside situation-data-api: node --input-type=module - < this-file.
// Only localhost API calls; output never contains provider records or secrets.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BASE = "http://127.0.0.1:4020";
const STATUS = "/api/v1/internal/valhalla-traffic/status";
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const HASH = /^[a-f0-9]{64}$/;
const DATASET = /^sim-routing-\d{4}-\d{2}-\d{2}-\d+$/;
const GENERATION = /^[A-Za-z0-9._:-]{1,128}$/;
const STATES = new Set(["disabled", "idle", "warming", "current", "stale", "degraded"]);
const REQUEST_TIMEOUT_MS = 40000;
const BODY_LIMIT = 48 * 1024 * 1024;

const timestamp = (value) => typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const safeText = (value, pattern) => typeof value === "string" && pattern.test(value) ? value : undefined;

function quantiles(values) {
  if (!values.length) return undefined;
  values.sort((a, b) => a - b);
  const at = (fraction) => Math.round(values[Math.floor((values.length - 1) * fraction)] * 1000) / 1000;
  return { min: at(0), p50: at(.5), p90: at(.9), max: at(1) };
}

export function aggregateFlows(flows, sampledAtMs, maxAgeSeconds) {
  const output = { totalFlowCount: flows.length, freshFlowCount: 0, expiredFlowCount: 0, invalidTimestampFlowCount: 0, validSpeedFlowCount: 0 };
  const ages = [], remaining = [];
  for (const flow of flows) {
    if (!flow || typeof flow !== "object") { output.invalidTimestampFlowCount++; continue; }
    if (finite(flow.averageSpeedKph) && flow.averageSpeedKph >= 0 && flow.averageSpeedKph <= 250) output.validSpeedFlowCount++;
    const observed = timestamp(flow.observedAt);
    const expiry = flow.validUntil === undefined ? undefined : timestamp(flow.validUntil);
    if (!Number.isFinite(observed) || (expiry !== undefined && (!Number.isFinite(expiry) || expiry < observed)) || observed > sampledAtMs + 30000) {
      output.invalidTimestampFlowCount++;
      continue;
    }
    const deadline = Math.min(expiry ?? Infinity, observed + maxAgeSeconds * 1000);
    ages.push((sampledAtMs - observed) / 1000);
    remaining.push((deadline - sampledAtMs) / 1000);
    if (deadline <= sampledAtMs) output.expiredFlowCount++;
    else output.freshFlowCount++;
  }
  return { ...output, observationAgeSeconds: quantiles(ages), remainingValidityAtReceiptSeconds: quantiles(remaining) };
}

function safeTiming(value) {
  if (!value || typeof value !== "object") return undefined;
  const output = {};
  for (const key of ["requestStartedAt", "lastCheckedAt", "lastChangedAt", "upstreamLastModifiedAt", "nextRefreshAt"]) {
    if (Number.isFinite(timestamp(value[key]))) output[key] = value[key];
  }
  for (const key of ["requestDurationMs", "lastResponseStatus", "freshFlowCount", "expiredFlowCount", "invalidTimestampFlowCount"]) {
    if (integer(value[key]) || (key === "requestDurationMs" && finite(value[key]) && value[key] >= 0)) output[key] = value[key];
  }
  output.hasLastError = typeof value.lastError === "string" && value.lastError.length > 0;
  return output;
}

function safeStatus(value) {
  if (!value || typeof value !== "object") return undefined;
  const result = { enabled: value.enabled === true, state: STATES.has(value.state) ? value.state : "unknown" };
  for (const key of ["activeUntil", "lastVehicleRequestAt", "updatedAt", "sourceObservedAt", "usableUntil"]) {
    if (Number.isFinite(timestamp(value[key]))) result[key] = value[key];
  }
  result.overlayGeneration = safeText(value.overlayGeneration, GENERATION);
  result.routingDataset = safeText(value.routingDataset, DATASET);
  for (const key of ["appliedFlowCount", "appliedEdgeCount", "mappedSegmentCount", "mappedEdgeCount", "ageSeconds"]) {
    if (integer(value[key])) result[key] = value[key];
  }
  return result;
}

function currentIsBounded(value, at, maxAgeSeconds) {
  return value?.state === "current" && value.enabled === true && Boolean(safeText(value.overlayGeneration, GENERATION)) &&
    Boolean(safeText(value.routingDataset, DATASET)) && integer(value.appliedEdgeCount) && value.appliedEdgeCount > 0 &&
    timestamp(value.updatedAt) <= at + 30000 && timestamp(value.usableUntil) > at &&
    timestamp(value.usableUntil) <= timestamp(value.updatedAt) + maxAgeSeconds * 1000;
}

async function readJson(response) {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > BODY_LIMIT) throw new Error("body_limit");
      chunks.push(value);
    }
    return bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
  } finally { await reader.cancel().catch(() => undefined); }
}

export async function verifyTrafficReliability({ fetchImpl = fetch, now = Date.now, env = process.env } = {}) {
  const checks = [];
  const requests = [];
  const samples = {};
  const token = env.VALHALLA_TRAFFIC_CONTROL_TOKEN;
  const maxAgeSeconds = Number(env.VALHALLA_TRAFFIC_MAX_AGE_SECONDS ?? 1800);
  const check = (name, state, evidence) => checks.push({ name, state, ...(evidence !== undefined ? { evidence } : {}) });
  const request = async (label, path, { authenticated = false, body } = {}) => {
    if (![STATUS, "/health/live", "/health/ready", "/api/v1/routing/route", "/api/v1/internal/valhalla-traffic/feed?includeStatic=false"].includes(path)) throw new Error("Non-local request refused");
    const startedAt = now();
    try {
      const response = await fetchImpl(`${BASE}${path}`, {
        method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const value = await readJson(response);
      const receivedAtMs = now();
      requests.push({ label, status: response.status, startedAt: new Date(startedAt).toISOString(), receivedAt: new Date(receivedAtMs).toISOString(), durationMs: receivedAtMs - startedAt });
      return { status: response.status, value, receivedAtMs };
    } catch {
      requests.push({ label, status: "request_failed", startedAt: new Date(startedAt).toISOString(), durationMs: now() - startedAt });
      check(`${label}_request`, "fail", "Local request failed, timed out, redirected, or returned invalid/bounded JSON.");
      return {};
    }
  };

  check("control_token_configured", token ? "pass" : "fail");
  check("max_age_configuration", finite(maxAgeSeconds) && maxAgeSeconds > 0 ? "pass" : "fail");
  if (!token || !finite(maxAgeSeconds) || maxAgeSeconds <= 0) return finish();
  const health = await request("health_live", "/health/live");
  check("health_live", health.status === 200 && health.value?.status === "ok" ? "pass" : "fail");
  const unauthorized = await request("unauthorized_status", STATUS);
  check("unauthorized_status_rejected", unauthorized.status === 401 ? "pass" : "fail");
  const before = await request("authorized_status_before", STATUS, { authenticated: true });
  samples.before = safeStatus(before.value);
  check("authorized_status", before.status === 200 && before.value?.enabled === true && STATES.has(before.value?.state) ? "pass" : "fail");
  check("current_before_deadline_bounded", before.value?.state === "current" ? (currentIsBounded(before.value, before.receivedAtMs, maxAgeSeconds) ? "pass" : "fail") : "not_applicable");

  const ready = await request("routing_dataset", "/health/ready");
  const dataset = safeText(ready.value?.routing?.routingDataset?.version, DATASET);
  samples.routing = { dataset, version: safeText(ready.value?.routing?.valhallaVersion, /^\d+\.\d+\.\d+$/), status: ready.value?.routing?.status === "ok" ? "ok" : "not_ok" };
  check("active_routing_dataset_available", ready.status === 200 && Boolean(dataset) ? "pass" : "fail");

  const route = await request("synthetic_prague_car_route", "/api/v1/routing/route", { body: {
    profileId: "car", from: { lon: 14.42076, lat: 50.08804 }, to: { lon: 14.4461, lat: 50.0755 }, includeTraffic: true, alternatives: 1
  } });
  const live = route.value?.traffic?.liveSpeeds;
  const primary = route.value?.routes?.[0];
  samples.route = { status: route.status, liveSpeeds: safeStatus(live), routeCount: Array.isArray(route.value?.routes) ? route.value.routes.length : 0,
    ...(finite(primary?.distanceM) ? { distanceM: primary.distanceM } : {}), ...(finite(primary?.durationSeconds) ? { durationSeconds: primary.durationSeconds } : {}) };
  const routeChanged = route.status === 503 && route.value?.code === "ROUTING_TRAFFIC_CHANGED";
  check("synthetic_car_route", routeChanged ? "transition" : route.status === 200 && route.value?.source?.backend === "valhalla" && primary?.status === "ok" &&
    finite(primary.distanceM) && primary.distanceM > 0 && finite(primary.durationSeconds) && primary.durationSeconds > 0 ? "pass" : "fail");
  check("route_current_deadline_bounded", live?.state === "current" ? (currentIsBounded(live, route.receivedAtMs, maxAgeSeconds) ? "pass" : "fail") : "not_applicable");
  check("route_current_matches_active_dataset", live?.state === "current" ? (live.routingDataset === dataset ? "pass" : "fail") : "not_applicable");

  const after = await request("authorized_status_after", STATUS, { authenticated: true });
  samples.after = safeStatus(after.value);
  check("authorized_status_after", after.status === 200 && after.value?.enabled === true && STATES.has(after.value?.state) ? "pass" : "fail");
  check("vehicle_lease_active", timestamp(after.value?.activeUntil) > after.receivedAtMs && timestamp(after.value?.lastVehicleRequestAt) >= timestamp(requests.find((r) => r.label === "synthetic_prague_car_route")?.startedAt) ? "pass" : "fail");
  check("current_after_deadline_bounded", after.value?.state === "current" ? (currentIsBounded(after.value, after.receivedAtMs, maxAgeSeconds) ? "pass" : "fail") : "not_applicable");
  const generationCaptured = live?.state === "current" && [before.value, after.value].some((status) => status?.overlayGeneration === live.overlayGeneration && status?.routingDataset === live.routingDataset);
  check("route_current_generation_acknowledged", live?.state === "current" ? (generationCaptured ? "pass" : "transition") : "not_applicable");

  const feed = await request("authorized_dynamic_feed", "/api/v1/internal/valhalla-traffic/feed?includeStatic=false", { authenticated: true });
  const warming = feed.status === 503 && feed.value?.code === "VALHALLA_TRAFFIC_FEED_UNAVAILABLE" && after.value?.state === "warming";
  if (warming) {
    check("dynamic_feed_available", "transition", "Expected warming response; no fresh-feed acceptance evidence yet.");
    samples.feed = { status: 503, expectedWarming: true };
  } else if (feed.status === 200 && feed.value?.contractVersion === "sim-valhalla-live-traffic-feed-v1" && Array.isArray(feed.value?.flows)) {
    const timing = safeTiming(feed.value.sourceTiming);
    const aggregate = aggregateFlows(feed.value.flows, feed.receivedAtMs, maxAgeSeconds);
    samples.feed = { status: 200, generatedAt: Number.isFinite(timestamp(feed.value.generatedAt)) ? feed.value.generatedAt : undefined,
      staticRevision: safeText(feed.value.staticRevision, HASH), dynamicRevision: safeText(feed.value.dynamicRevision, HASH), sourceTiming: timing, ...aggregate };
    check("dynamic_feed_available", "pass");
    check("dynamic_only_feed", feed.value.segments === undefined ? "pass" : "fail");
    check("feed_revisions_valid", HASH.test(feed.value.staticRevision ?? "") && HASH.test(feed.value.dynamicRevision ?? "") ? "pass" : "fail");
    check("source_timing_counts_consistent", timing && ["freshFlowCount", "expiredFlowCount", "invalidTimestampFlowCount"].every((key) => integer(timing[key])) &&
      timing.freshFlowCount + timing.expiredFlowCount + timing.invalidTimestampFlowCount === aggregate.totalFlowCount ? "pass" : "fail");
    check("fresh_flow_sample_present", aggregate.freshFlowCount > 0 ? "pass" : "transition");
  } else {
    samples.feed = { status: feed.status };
    check("dynamic_feed_available", "fail");
  }
  check("current_overlay_observed", currentIsBounded(after.value, after.receivedAtMs, maxAgeSeconds) && live?.state === "current" ? "pass" : "transition");
  return finish();

  function finish() {
    const outcome = checks.some((item) => item.state === "fail") ? "fail" : checks.some((item) => item.state === "transition") ? "transition" : "technical_sample_pass";
    return { contractVersion: "sim-traffic-reliability-sample-v1", sampledAt: new Date(now()).toISOString(), outcome,
      fullAcceptance: false, scope: "One bounded localhost technical sample; does not measure ETA accuracy or prove a multi-cycle rollout.", checks, requests, samples };
  }
}

if (process.argv[1] === "-" || (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)) {
  verifyTrafficReliability().then((report) => {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.outcome === "fail" ? 1 : report.outcome === "transition" ? 2 : 0;
  }).catch(() => {
    process.stdout.write(`${JSON.stringify({ outcome: "fail", fullAcceptance: false, reason: "Reliability verifier failed without disclosing payloads or credentials." })}\n`);
    process.exitCode = 1;
  });
}
