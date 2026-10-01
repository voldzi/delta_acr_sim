#!/usr/bin/env node
// Run inside situation-data-api: node --input-type=module - < this-file.
// Refuses non-idle preflight. Only fixed localhost walking/bicycle routes are sent.
// Provider records, tokens and raw error details are never included in output.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const BASE = "http://127.0.0.1:4020";
const STATUS = "/api/v1/internal/valhalla-traffic/status";
const FEED = "/api/v1/internal/valhalla-traffic/feed?includeStatic=false";
const ROUTE = "/api/v1/routing/route";
const QUOTA = "/valhalla-traffic-cache/provider-request-timing.json";
const TIMEOUT_MS = 15000, HARD_MAX_MS = 60000, BODY_LIMIT = 48 * 1024 * 1024;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const STATES = new Set(["disabled", "idle", "warming", "current", "stale", "degraded"]);
const stamp = (value) => typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;

async function boundedQuotaRead(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096) throw new Error("quota_invalid");
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw new Error("quota_invalid");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

export function safeIdleQuota(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 4096) throw new Error("quota_invalid");
  const value = JSON.parse(raw), keys = ["static", "dynamic", "tec"];
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 ||
      Object.keys(value).some((key) => !["version", ...keys].includes(key))) throw new Error("quota_invalid");
  const result = { version: 1 };
  for (const key of keys) {
    const entry = value[key];
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).length !== 1 ||
        !count(entry.nextAttemptAtMs) || entry.nextAttemptAtMs > 8640000000000000) throw new Error("quota_invalid");
    result[key] = { nextAttemptAtMs: entry.nextAttemptAtMs };
  }
  return result;
}

function safeStatus(value) {
  if (!value || typeof value !== "object" || typeof value.enabled !== "boolean" || !STATES.has(value.state)) throw new Error("status_invalid");
  const result = { enabled: value.enabled, state: value.state };
  for (const key of ["activeUntil", "lastVehicleRequestAt"]) {
    if (value[key] !== undefined) {
      if (!Number.isFinite(stamp(value[key]))) throw new Error("status_invalid");
      result[key] = value[key];
    }
  }
  return result;
}

const idleAt = (status, at) => status.enabled === true && status.state === "idle" &&
  Number.isFinite(stamp(status.activeUntil)) && stamp(status.activeUntil) <= at;

async function readJson(response) {
  if (!response.body) return undefined;
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > BODY_LIMIT) throw new Error("body_limit");
      chunks.push(value);
    }
    return bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
  } finally { await reader.cancel().catch(() => undefined); }
}

export async function verifyTrafficIdle({ fetchImpl = fetch, now = Date.now,
  monotonicNow = () => performance.now(), readFileImpl = boundedQuotaRead, env = process.env } = {}) {
  const started = monotonicNow(), deadline = started + HARD_MAX_MS;
  const checks = [], requests = [], samples = {};
  const token = env.VALHALLA_TRAFFIC_CONTROL_TOKEN;
  const check = (name, passed) => checks.push({ name, state: passed ? "pass" : "fail" });
  const elapsed = () => Math.max(0, monotonicNow() - started);

  // A monotonic whole-run budget is shared by API body reads and quota reads.
  async function bounded(operation) {
    const remaining = deadline - monotonicNow();
    if (remaining <= 0) throw new Error("verification_deadline");
    const controller = new AbortController();
    let timer;
    try {
      const value = await Promise.race([
        operation(controller.signal),
        new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("verification_timeout")); }, Math.max(1, Math.ceil(Math.min(TIMEOUT_MS, remaining))));
        })
      ]);
      if (monotonicNow() >= deadline) throw new Error("verification_deadline");
      return value;
    } finally { clearTimeout(timer); }
  }

  async function request(label, path, profileId) {
    if (![STATUS, FEED, ROUTE].includes(path) ||
        (path === ROUTE ? !["walking", "bicycle"].includes(profileId) : profileId !== undefined)) throw new Error("request_refused");
    const began = monotonicNow();
    try {
      const response = await bounded(async (signal) => {
        const value = await fetchImpl(`${BASE}${path}`, {
          method: path === ROUTE ? "POST" : "GET", redirect: "error", signal,
          headers: { Authorization: `Bearer ${token}`, ...(path === ROUTE ? { "Content-Type": "application/json" } : {}) },
          ...(path === ROUTE ? { body: JSON.stringify({ profileId, from: { lon: 14.42076, lat: 50.08804 },
            to: { lon: 14.4461, lat: 50.0755 }, includeTraffic: false, alternatives: 1 }) } : {})
        });
        if (!count(value.status) || value.status < 100 || value.status > 599) throw new Error("response_invalid");
        return { status: value.status, value: await readJson(value) };
      });
      requests.push({ label, status: response.status, durationMs: Math.max(0, Math.round(monotonicNow() - began)) });
      return response;
    } catch {
      requests.push({ label, status: "request_failed", durationMs: Math.max(0, Math.round(monotonicNow() - began)) });
      throw new Error("local_request_failed_or_invalid");
    }
  }

  function finish(outcome, reason) {
    if (outcome === "idle_non_vehicle_pass" && elapsed() >= HARD_MAX_MS) {
      outcome = "fail";
      reason = "The bounded verification deadline was reached.";
      check("whole_run_deadline", false);
    }
    return { contractVersion: "sim-traffic-idle-verification-v1", outcome, fullAcceptance: false,
      elapsedSeconds: Math.round(elapsed()) / 1000, checks, requests, samples, reason };
  }

  if (typeof token !== "string" || !token) return finish("fail", "Local control authentication is not configured.");
  try {
    const before = await request("idle_status_before", STATUS);
    if (before.status !== 200) throw new Error("status_unavailable");
    samples.before = safeStatus(before.value);
    check("idle_preflight", idleAt(samples.before, now()));
    if (checks.at(-1).state === "fail") return finish("refused", "The existing traffic lease is not naturally idle; no route was requested.");
    samples.quotaBefore = safeIdleQuota(await bounded(() => readFileImpl(QUOTA, "utf8")));
    check("timing_only_quota_preflight", true);

    samples.routes = [];
    for (const profileId of ["walking", "bicycle"]) {
      const response = await request(`${profileId}_route`, ROUTE, profileId);
      const primary = response.value?.routes?.[0];
      const valid = response.status === 200 && response.value?.source?.backend === "valhalla" && primary?.status === "ok" &&
        finite(primary.distanceM) && primary.distanceM > 0 && finite(primary.durationSeconds) && primary.durationSeconds > 0;
      samples.routes.push({ profileId, status: response.status, backendValhalla: response.value?.source?.backend === "valhalla",
        routeValid: valid, ...(finite(primary?.distanceM) && primary.distanceM > 0 ? { distanceM: primary.distanceM } : {}),
        ...(finite(primary?.durationSeconds) && primary.durationSeconds > 0 ? { durationSeconds: primary.durationSeconds } : {}) });
      check(`${profileId}_route_valid`, valid);
      if (!valid) return finish("fail", "A bounded non-vehicle route check failed; no traffic acceptance is claimed.");
    }

    const after = await request("idle_status_after", STATUS);
    if (after.status !== 200) throw new Error("status_unavailable");
    samples.after = safeStatus(after.value);
    check("still_idle", idleAt(samples.after, now()));
    check("active_until_unchanged", samples.after.activeUntil === samples.before.activeUntil);
    check("last_vehicle_request_unchanged", samples.after.lastVehicleRequestAt === samples.before.lastVehicleRequestAt);
    // Refuse feed access if a shared vehicle request has made the lease active.
    if (checks.find((entry) => entry.name === "still_idle").state === "fail") {
      return finish("fail", "The shared traffic lease is no longer idle; no feed was requested.");
    }
    const feed = await request("idle_feed", FEED);
    samples.feedStatus = feed.status;
    check("idle_feed_empty", feed.status === 204);
    samples.quotaAfter = safeIdleQuota(await bounded(() => readFileImpl(QUOTA, "utf8")));
    check("quota_unchanged", JSON.stringify(samples.quotaBefore) === JSON.stringify(samples.quotaAfter));
    check("whole_run_deadline", elapsed() < HARD_MAX_MS);
    return finish(checks.some((entry) => entry.state === "fail") ? "fail" : "idle_non_vehicle_pass",
      "This bounded sample checks walking/bicycle routes without lease or quota change. It does not prove traffic ETA accuracy or full rollout acceptance.");
  } catch {
    check("local_inputs_bounded_and_valid", false);
    return finish("fail", "A local request or timing-only input failed, exceeded its limit, or was invalid; payloads and credentials were not disclosed.");
  }
}

if (process.argv[1] === "-" || (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)) {
  // A timed-out filesystem request cannot be cancelled reliably. The CLI must
  // also terminate if such a request would otherwise keep Node alive.
  const watchdog = setTimeout(() => {
    process.stdout.write('{"contractVersion":"sim-traffic-idle-verification-v1","outcome":"fail","fullAcceptance":false,"reason":"The sixty-second idle verification deadline was reached without disclosing payloads or credentials."}\n');
    process.exit(1);
  }, HARD_MAX_MS);
  const outputAndExit = (report, code) => {
    process.stdout.write(`${JSON.stringify(report)}\n`, () => {
      clearTimeout(watchdog);
      process.exit(code);
    });
  };
  verifyTrafficIdle().then((report) => {
    outputAndExit(report, report.outcome === "idle_non_vehicle_pass" ? 0 : report.outcome === "refused" ? 2 : 1);
  }).catch(() => {
    outputAndExit({ outcome: "fail", fullAcceptance: false,
      reason: "Idle verification failed without disclosing payloads or credentials." }, 1);
  });
}
