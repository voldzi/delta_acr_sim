#!/usr/bin/env node
// Bounded, read-only localhost observation. Run inside situation-data-api on stdin.
// Never activates a vehicle lease, reads provider secrets, or outputs provider records.
import { constants, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const BASE = "http://127.0.0.1:4020";
const STATUS = "/api/v1/internal/valhalla-traffic/status";
const FEED = "/api/v1/internal/valhalla-traffic/feed?includeStatic=false";
const QUOTA = "/valhalla-traffic-cache/provider-request-timing.json";
const INTERVAL = 30000, HARD_MAX = 1200000, TIMEOUT = 15000, BODY_LIMIT = 48 * 1024 * 1024;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const DATASET = /^sim-routing-\d{4}-\d{2}-\d{2}-\d+$/;
const GENERATION = /^[A-Za-z0-9._:-]{1,128}$/;
const STATES = new Set(["disabled", "idle", "warming", "current", "stale", "degraded"]);
const stamp = (value) => typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
const number = (value) => typeof value === "number" && Number.isFinite(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value, pattern) => typeof value === "string" && pattern.test(value) ? value : undefined;

async function boundedQuotaRead(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096) throw new Error("quota_invalid");
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new Error("quota_invalid");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

export function safeQuota(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 4096) throw new Error("quota_invalid");
  const value = JSON.parse(raw), keys = ["static", "dynamic", "tec"];
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 ||
      Object.keys(value).some((key) => !["version", ...keys].includes(key))) throw new Error("quota_invalid");
  const result = { version: 1 };
  // This rollout observer deliberately requires the initialized/seeded runtime
  // schema. A cold partial quota is not acceptance evidence; never invent zeros.
  for (const key of keys) {
    const entry = value[key];
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).length !== 1 ||
        !count(entry.nextAttemptAtMs) || entry.nextAttemptAtMs > 8640000000000000) throw new Error("quota_invalid");
    result[key] = { nextAttemptAtMs: entry.nextAttemptAtMs };
  }
  return result;
}

function safeStatus(value) {
  if (!value || typeof value !== "object" || value.enabled !== true || !STATES.has(value.state)) throw new Error("status_invalid");
  const result = { enabled: true, state: value.state };
  for (const key of ["activeUntil", "lastVehicleRequestAt", "updatedAt", "sourceObservedAt", "usableUntil"]) {
    if (Number.isFinite(stamp(value[key]))) result[key] = value[key];
  }
  for (const key of ["appliedFlowCount", "appliedEdgeCount"]) if (count(value[key])) result[key] = value[key];
  result.overlayGeneration = text(value.overlayGeneration, GENERATION);
  result.routingDataset = text(value.routingDataset, DATASET);
  return result;
}

function safeTiming(value) {
  if (!value || typeof value !== "object") throw new Error("timing_missing");
  const result = {};
  for (const key of ["requestStartedAt", "lastCheckedAt", "lastChangedAt", "upstreamLastModifiedAt", "nextRefreshAt"]) {
    if (Number.isFinite(stamp(value[key]))) result[key] = value[key];
  }
  for (const key of ["freshFlowCount", "expiredFlowCount", "invalidTimestampFlowCount"]) {
    if (!count(value[key])) throw new Error("timing_counts_invalid");
    result[key] = value[key];
  }
  if (number(value.requestDurationMs) && value.requestDurationMs >= 0) result.requestDurationMs = value.requestDurationMs;
  if (count(value.lastResponseStatus) && value.lastResponseStatus >= 100 && value.lastResponseStatus <= 599) result.lastResponseStatus = value.lastResponseStatus;
  result.hasLastError = typeof value.lastError === "string" && value.lastError.length > 0;
  return result;
}

function flowCounts(flows, at, maxAgeSeconds) {
  const result = { totalFlowCount: flows.length, freshFlowCount: 0, expiredFlowCount: 0, invalidTimestampFlowCount: 0 };
  for (const flow of flows) {
    const observed = stamp(flow?.observedAt), expiry = flow?.validUntil === undefined ? undefined : stamp(flow.validUntil);
    if (!Number.isFinite(observed) || observed > at + 30000 ||
        (expiry !== undefined && (!Number.isFinite(expiry) || expiry < observed))) result.invalidTimestampFlowCount++;
    else if (Math.min(expiry ?? Infinity, observed + maxAgeSeconds * 1000) <= at) result.expiredFlowCount++;
    else result.freshFlowCount++;
  }
  return result;
}

async function readJson(response) {
  if (!response.body) return undefined;
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) throw new Error("body_limit");
      chunks.push(value);
    }
    return size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
  } finally { await reader.cancel().catch(() => undefined); }
}

export async function observeTrafficReliability({ fetchImpl = fetch, now = Date.now,
  monotonicNow = () => performance.now(),
  sleepImpl = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  readFileImpl = boundedQuotaRead, timerImpl = setTimeout, clearTimerImpl = clearTimeout,
  env = process.env, emit = () => {} } = {}) {
  const started = now(), startedMonotonic = monotonicNow(), endMonotonic = startedMonotonic + HARD_MAX;
  const starts = new Set(), events = [], emittedViolations = new Set();
  let sampleCount = 0, errorCount = 0, violationCount = 0, providerFailureSampleCount = 0, lastSignature, previousStart;
  let idleFirst, idleConfirmed = false, activeSeen = false, currentSeen = false, expiredSeen = false;
  let lastStatus, leaseExtensionCount = 0, lastLease;
  const output = (event) => { events.push(event); emit(event); };
  const token = env.VALHALLA_TRAFFIC_CONTROL_TOKEN;
  const maxAgeSeconds = Number(env.VALHALLA_TRAFFIC_MAX_AGE_SECONDS ?? 1800);
  if (!token || !number(maxAgeSeconds) || maxAgeSeconds <= 0) {
    errorCount++;
    output({ event: "error", reason: "configuration_invalid" });
    return finish("fail");
  }
  const requireTimeRemaining = () => {
    const remaining = endMonotonic - monotonicNow();
    if (remaining <= 0) throw new Error("observation_deadline");
    return remaining;
  };
  const quotaRead = async () => {
    const budget = Math.max(1, Math.floor(Math.min(TIMEOUT, requireTimeRemaining())));
    // The filesystem operation cannot necessarily be cancelled. Bound the await
    // independently and consume any eventual rejection without disclosing it.
    const operation = Promise.resolve().then(() => readFileImpl(QUOTA, "utf8"));
    void operation.catch(() => undefined);
    let timer;
    try {
      const raw = await Promise.race([operation, new Promise((_, reject) => {
        timer = timerImpl(() => reject(new Error("quota_read_deadline")), budget);
      })]);
      requireTimeRemaining();
      return safeQuota(raw);
    } finally { clearTimerImpl(timer); }
  };
  const request = async (path) => {
    if (path !== STATUS && path !== FEED) throw new Error("path_refused");
    const remaining = requireTimeRemaining();
    const response = await fetchImpl(`${BASE}${path}`, { method: "GET", redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(TIMEOUT, remaining)))), headers: { Authorization: `Bearer ${token}` } });
    requireTimeRemaining();
    const value = await readJson(response);
    requireTimeRemaining();
    return { status: response.status, value };
  };
  // Cadence, request budgets and the hard stop use only a monotonic clock.
  // Wall time is reserved for source/lease timestamps and emitted timestamps.
  for (let index = 0; index < HARD_MAX / INTERVAL && monotonicNow() < endMonotonic; index++) {
    let sample;
    try {
      const statusResponse = await request(STATUS);
      requireTimeRemaining();
      if (statusResponse.status !== 200) throw new Error("status_unavailable");
      const status = safeStatus(statusResponse.value);
      const feed = await request(FEED);
      requireTimeRemaining();
      const quota = await quotaRead();
      requireTimeRemaining();
      const at = now();
      const atMonotonic = monotonicNow();
      sampleCount++;
      lastStatus = status;
      if (stamp(status.activeUntil) > at) activeSeen = true;
      if (lastLease !== undefined && stamp(status.activeUntil) > lastLease) leaseExtensionCount++;
      if (Number.isFinite(stamp(status.activeUntil))) lastLease = stamp(status.activeUntil);
      sample = { event: "sample", sampledAt: new Date(at).toISOString(), status, feedStatus: feed.status, quota };
      if (status.state === "current") {
        currentSeen = true;
        if (!status.overlayGeneration || !status.routingDataset || !count(status.appliedEdgeCount) || status.appliedEdgeCount <= 0 ||
            !Number.isFinite(stamp(status.updatedAt)) || stamp(status.updatedAt) > at + 30000 ||
            !(stamp(status.usableUntil) > at) || !(stamp(status.usableUntil) <= stamp(status.updatedAt) + maxAgeSeconds * 1000)) {
          violationCount++;
          const key = JSON.stringify(["current_overlay_not_bounded", status.overlayGeneration, status.routingDataset, status.usableUntil]);
          if (!emittedViolations.has(key)) {
            emittedViolations.add(key);
            output({ event: "error", reason: "current_overlay_not_bounded" });
          }
        }
      }
      if (feed.status === 200) {
        if (feed.value?.contractVersion !== "sim-valhalla-live-traffic-feed-v1" || !Array.isArray(feed.value.flows) || feed.value.segments !== undefined) throw new Error("feed_invalid");
        sample.sourceTiming = safeTiming(feed.value.sourceTiming);
        if (sample.sourceTiming.freshFlowCount + sample.sourceTiming.expiredFlowCount +
            sample.sourceTiming.invalidTimestampFlowCount !== feed.value.flows.length) {
          violationCount++;
          throw new Error("timing_counts_inconsistent");
        }
        if (sample.sourceTiming.hasLastError || sample.sourceTiming.lastResponseStatus >= 400) {
          providerFailureSampleCount++;
          const failureKey = JSON.stringify(["provider_refresh_failed", sample.sourceTiming.requestStartedAt,
            sample.sourceTiming.lastResponseStatus, sample.sourceTiming.hasLastError]);
          if (!emittedViolations.has(failureKey)) {
            emittedViolations.add(failureKey);
            output({ event: "error", reason: "provider_refresh_failed" });
          }
        }
        sample.counts = flowCounts(feed.value.flows, at, maxAgeSeconds);
        if (sample.counts.expiredFlowCount > 0) expiredSeen = true;
        const sourceStart = stamp(sample.sourceTiming.requestStartedAt);
        if (Number.isFinite(sourceStart)) {
          if (sourceStart > at + 30000) throw new Error("source_start_invalid");
          if (sourceStart >= started - INTERVAL && !starts.has(sourceStart)) {
            if (previousStart !== undefined && sourceStart - previousStart < 300000) {
              violationCount++;
              output({ event: "error", reason: "provider_request_spacing_below_300_seconds" });
            }
            starts.add(sourceStart);
            previousStart = sourceStart;
          }
        }
      } else if (feed.status !== 204) {
        // An unavailable feed is not silently accepted, even if an old overlay remains.
        throw new Error("feed_unavailable");
      }
      const isIdle = activeSeen && status.state === "idle" && Number.isFinite(stamp(status.activeUntil)) &&
        stamp(status.activeUntil) <= at && feed.status === 204;
      if (starts.size >= 3 && isIdle) {
        const quotaSignature = JSON.stringify(quota);
        if (!idleFirst || idleFirst.quotaSignature !== quotaSignature) {
          idleFirst = { atMonotonic, quotaSignature };
          output({ event: "idle_checkpoint", checkpoint: 1, sampledAt: sample.sampledAt, quota });
        } else if (atMonotonic - idleFirst.atMonotonic >= 60000) {
          idleConfirmed = true;
          output({ event: "idle_checkpoint", checkpoint: 2, sampledAt: sample.sampledAt, quota });
        }
      } else idleFirst = undefined;
      const signature = JSON.stringify({ state: status.state, generation: status.overlayGeneration, dataset: status.routingDataset,
        usableUntil: status.usableUntil, sourceStart: sample.sourceTiming?.requestStartedAt,
        responseStatus: sample.sourceTiming?.lastResponseStatus, hasLastError: sample.sourceTiming?.hasLastError });
      if (signature !== lastSignature) { output(sample); lastSignature = signature; }
      requireTimeRemaining();
      if (starts.size >= 3 && idleConfirmed) return finish(errorCount || violationCount || providerFailureSampleCount ? "fail" : "bounded_observation_pass");
    } catch {
      errorCount++;
      idleFirst = undefined;
      const signature = "sample_error";
      if (lastSignature !== signature) output({ event: "error", reason: "local_sample_failed_or_invalid", sampledAt: new Date(now()).toISOString() });
      lastSignature = signature;
    }
    const next = Math.min(endMonotonic, startedMonotonic + (index + 1) * INTERVAL);
    const wait = Math.min(INTERVAL, next - monotonicNow(), endMonotonic - monotonicNow());
    if (wait > 0) await sleepImpl(wait);
  }
  return finish(violationCount || providerFailureSampleCount ? "fail" : "incomplete");

  function finish(outcome) {
    const summary = { event: "summary", contractVersion: "sim-traffic-reliability-observation-v1", outcome,
      fullAcceptance: false, elapsedSeconds: Math.max(0, (monotonicNow() - startedMonotonic) / 1000), sampleCount, errorCount, violationCount, providerFailureSampleCount,
      providerRequestStartCount: starts.size, providerRequestStarts: [...starts].sort((a, b) => a - b).map((at) => new Date(at).toISOString()),
      minimumProviderSpacingVerified: starts.size >= 3 && violationCount === 0,
      naturalIdleVerified: idleConfirmed, currentOverlayObserved: currentSeen, expiredFlowsObserved: expiredSeen,
      leaseExtensionCount, lastStatus, quotaUnchangedDuringIdle: idleConfirmed,
      reason: outcome === "incomplete" ? "Three live provider starts and a natural idle with unchanged quota were not all observed within twenty minutes; other vehicle requests may keep the shared lease active." :
        outcome === "fail" ? "At least one bounded observation check failed; no full acceptance is claimed." :
        "Three spaced provider starts and natural idle were observed. This does not measure ETA accuracy, archive clearing, or mapping correctness." };
    output(summary);
    return { ...summary, events };
  }
}

if (process.argv[1] === "-" || (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)) {
  // Independent process stop also covers stalled quota I/O or an unexpected
  // uncancellable dependency; it never reports late completion as acceptance.
  const watchdog = setTimeout(() => {
    try {
      writeSync(1, '{"event":"summary","outcome":"incomplete","fullAcceptance":false,"reason":"Independent twenty-minute observer deadline reached."}\n');
    } catch { /* No raw I/O error or credentials are emitted. */ }
    process.exit(2);
  }, HARD_MAX);
  observeTrafficReliability({ emit: (event) => writeSync(1, `${JSON.stringify(event)}\n`) }).then((report) => {
    clearTimeout(watchdog);
    // A timed-out, uncancellable filesystem read must not keep this standalone
    // observation process alive after its completed, synchronously emitted report.
    process.exit(report.outcome === "bounded_observation_pass" ? 0 : report.outcome === "incomplete" ? 2 : 1);
  }).catch(() => {
    clearTimeout(watchdog);
    try { writeSync(1, '{"event":"summary","outcome":"fail","fullAcceptance":false,"reason":"Observer failed without disclosing payloads or credentials."}\n'); } catch { /* Redacted. */ }
    process.exit(1);
  });
}
