import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { ApiConfig } from "./config.js";

const MAX_REPORT_BYTES = 64 * 1024;
const MAX_REPORT_AGE_MS = 90_000;
const DATASET = /^sim-routing-\d{4}-\d{2}-\d{2}-\d+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export const DRIVER_REJECTION_CODES = [
  "non_measured_position",
  "low_sensor_quality",
  "personal_stop_or_unknown_motion",
  "sampling_gap",
  "ambiguous_or_noncontinuous_edge",
  "heading_inconsistent",
  "speed_or_distance_inconsistent",
  "eta_not_comparable"
] as const;
const SPEED_KEYS = [
  "evaluatedGroupCount",
  "currentGroupCount",
  "historicalGroupCount",
  "futureGroupCount",
  "otherDatasetGroupCount",
  "subthresholdGroupCount",
  "qualityGroupCount",
  "closedWindowGroupCount",
  "currentQualityGroupCount",
  "currentQualityIntervalCount"
] as const;

export interface DriverMeasurementEvaluationReport {
  contractVersion: "sim-driver-evaluation-v1";
  generatedAt: string;
  asOf: string;
  routingDataset: string;
  evaluationWindow: { since: string; until: string };
  applicationMode: "shadow_only";
  etaEvidence: "client_reported_not_ground_truth";
  consistency: "read_only_repeatable_read";
  retentionDays: 7;
  livePromotionSupported: false;
  revocationCoverage: "database_only";
  intake: { enabled: boolean; revocationEnabled: boolean; accountScope: "cop_managed_with_consent" };
  comparisonMode: "disabled" | "comparison_only";
  liveAppliedGroupCount: 0;
  summary: {
    retainedBatchCount: number;
    lastAcceptedAt: string | null;
    acceptedIntervalCount: number;
    deduplicatedIntervalCount: number;
    activeRevocationTombstoneCount: number;
    rejectionCounts: Record<(typeof DRIVER_REJECTION_CODES)[number], number>;
    speed: Record<(typeof SPEED_KEYS)[number], number>;
    eta: Array<{
      routingDataset: string;
      windowStart: string;
      attestedContributorCount: number;
      observationCount: number;
      medianAbsoluteErrorSeconds: number;
      medianAbsoluteErrorPercent: number;
    }>;
  };
  limits: { minimumAttestedContributors: 5; minimumIntervals: 10; maximumEtaRows: 100 };
}

export interface DriverMeasurementEvaluationResponse {
  contractVersion: "sim-driver-evaluation-v1";
  status: "current" | "stale" | "unavailable" | "invalid";
  checkedAt: string;
  reportAgeSeconds: number | null;
  report?: DriverMeasurementEvaluationReport;
  reason?: "report_missing" | "report_unreadable" | "report_invalid" | "report_stale";
}

class InvalidReport extends Error {}
const invalid = (): never => {
  throw new InvalidReport();
};
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key)) || Object.keys(object).some((key) => !keys.includes(key)))
    return invalid();
  return object;
}
function count(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) return invalid();
  return value;
}
function finite(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) return invalid();
  return value;
}
function stamp(value: unknown): string {
  if (typeof value !== "string" || !ISO.test(value) || !Number.isFinite(Date.parse(value))) return invalid();
  if (new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) return invalid();
  return value;
}
function dataset(value: unknown): string {
  if (typeof value !== "string" || !DATASET.test(value)) return invalid();
  return value;
}

/** Reconstruct every field: unknown/raw values are never forwarded to the browser. */
export function parseDriverMeasurementEvaluationReport(value: unknown, nowMs: number): DriverMeasurementEvaluationReport {
  const raw = record(value, [
    "contractVersion",
    "generatedAt",
    "asOf",
    "routingDataset",
    "evaluationWindow",
    "applicationMode",
    "etaEvidence",
    "consistency",
    "retentionDays",
    "livePromotionSupported",
    "revocationCoverage",
    "summary",
    "limits",
    "intake",
    "comparisonMode",
    "liveAppliedGroupCount"
  ]);
  if (
    raw.contractVersion !== "sim-driver-evaluation-v1" ||
    raw.applicationMode !== "shadow_only" ||
    raw.etaEvidence !== "client_reported_not_ground_truth" ||
    raw.consistency !== "read_only_repeatable_read" ||
    raw.retentionDays !== 7 ||
    raw.livePromotionSupported !== false ||
    raw.revocationCoverage !== "database_only"
  )
    return invalid();
  const generatedAt = stamp(raw.generatedAt),
    asOf = stamp(raw.asOf);
  if (Date.parse(generatedAt) > nowMs + 5000 || Date.parse(asOf) !== Date.parse(generatedAt)) return invalid();
  const window = record(raw.evaluationWindow, ["since", "until"]);
  const since = stamp(window.since),
    until = stamp(window.until);
  if (Date.parse(until) !== Date.parse(asOf) || Date.parse(until) - Date.parse(since) !== 86400_000) return invalid();
  const intake = record(raw.intake, ["enabled", "revocationEnabled", "accountScope"]);
  if (
    typeof intake.enabled !== "boolean" ||
    typeof intake.revocationEnabled !== "boolean" ||
    intake.accountScope !== "cop_managed_with_consent" ||
    !["disabled", "comparison_only"].includes(String(raw.comparisonMode)) ||
    raw.liveAppliedGroupCount !== 0
  )
    return invalid();
  const limits = record(raw.limits, ["minimumAttestedContributors", "minimumIntervals", "maximumEtaRows"]);
  if (limits.minimumAttestedContributors !== 5 || limits.minimumIntervals !== 10 || limits.maximumEtaRows !== 100) return invalid();
  const summary = record(raw.summary, [
    "retainedBatchCount",
    "lastAcceptedAt",
    "acceptedIntervalCount",
    "deduplicatedIntervalCount",
    "activeRevocationTombstoneCount",
    "rejectionCounts",
    "speed",
    "eta"
  ]);
  const lastAcceptedAt = summary.lastAcceptedAt === null ? null : stamp(summary.lastAcceptedAt);
  if (lastAcceptedAt && Date.parse(lastAcceptedAt) > Date.parse(generatedAt)) return invalid();
  const rejections = record(summary.rejectionCounts, DRIVER_REJECTION_CODES),
    speedRaw = record(summary.speed, SPEED_KEYS);
  const speed = Object.fromEntries(SPEED_KEYS.map((key) => [key, count(speedRaw[key])])) as DriverMeasurementEvaluationReport["summary"]["speed"];
  if (
    speed.evaluatedGroupCount !== speed.currentGroupCount + speed.historicalGroupCount + speed.futureGroupCount + speed.otherDatasetGroupCount ||
    speed.closedWindowGroupCount !== speed.historicalGroupCount ||
    speed.qualityGroupCount + speed.subthresholdGroupCount !== speed.currentGroupCount + speed.historicalGroupCount ||
    speed.currentQualityGroupCount > Math.min(speed.currentGroupCount, speed.qualityGroupCount) ||
    speed.currentQualityIntervalCount < 10 * speed.currentQualityGroupCount ||
    (speed.currentQualityGroupCount === 0 && speed.currentQualityIntervalCount !== 0)
  )
    return invalid();
  if (!Array.isArray(summary.eta) || summary.eta.length > 100) return invalid();
  const eta = summary.eta.map((item) => {
    const row = record(item, [
      "routingDataset",
      "windowStart",
      "attestedContributorCount",
      "observationCount",
      "medianAbsoluteErrorSeconds",
      "medianAbsoluteErrorPercent"
    ]);
    const windowStart = stamp(row.windowStart);
    const routingDataset = dataset(row.routingDataset);
    if (
      routingDataset !== raw.routingDataset ||
      Date.parse(windowStart) > Date.parse(asOf) ||
      Date.parse(windowStart) < Date.parse(since) ||
      Date.parse(windowStart) % 3600_000 !== 0
    )
      return invalid();
    const attestedContributorCount = count(row.attestedContributorCount, 5);
    const observationCount = count(row.observationCount, 10);
    if (observationCount < attestedContributorCount) return invalid();
    return {
      routingDataset,
      windowStart,
      attestedContributorCount,
      observationCount,
      medianAbsoluteErrorSeconds: finite(row.medianAbsoluteErrorSeconds, 86400),
      medianAbsoluteErrorPercent: finite(row.medianAbsoluteErrorPercent)
    };
  });
  return {
    contractVersion: "sim-driver-evaluation-v1",
    generatedAt,
    asOf,
    routingDataset: dataset(raw.routingDataset),
    evaluationWindow: { since, until },
    applicationMode: "shadow_only",
    etaEvidence: "client_reported_not_ground_truth",
    consistency: "read_only_repeatable_read",
    retentionDays: 7,
    livePromotionSupported: false,
    revocationCoverage: "database_only",
    intake: { enabled: intake.enabled, revocationEnabled: intake.revocationEnabled, accountScope: "cop_managed_with_consent" },
    comparisonMode: raw.comparisonMode as "disabled" | "comparison_only",
    liveAppliedGroupCount: 0,
    summary: {
      retainedBatchCount: count(summary.retainedBatchCount),
      lastAcceptedAt,
      acceptedIntervalCount: count(summary.acceptedIntervalCount),
      deduplicatedIntervalCount: count(summary.deduplicatedIntervalCount),
      activeRevocationTombstoneCount: count(summary.activeRevocationTombstoneCount),
      rejectionCounts: Object.fromEntries(
        DRIVER_REJECTION_CODES.map((key) => [key, count(rejections[key])])
      ) as DriverMeasurementEvaluationReport["summary"]["rejectionCounts"],
      speed,
      eta
    },
    limits: { minimumAttestedContributors: 5, minimumIntervals: 10, maximumEtaRows: 100 }
  };
}

export async function readDriverMeasurementEvaluation(
  config: Pick<ApiConfig, "dataDir" | "operationsDriverMeasurementReportFile">,
  nowMs = Date.now()
): Promise<DriverMeasurementEvaluationResponse> {
  const response: DriverMeasurementEvaluationResponse = {
    contractVersion: "sim-driver-evaluation-v1",
    status: "unavailable",
    checkedAt: new Date(nowMs).toISOString(),
    reportAgeSeconds: null
  };
  const path = config.operationsDriverMeasurementReportFile;
  if (!path) return { ...response, reason: "report_missing" };
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_REPORT_BYTES || (before.mode & 0o022) !== 0)
      return { ...response, status: "invalid", reason: "report_invalid" };
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      return { ...response, status: "invalid", reason: "report_invalid" };
    const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await file.read(buffer, bytes, buffer.length - bytes, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    const after = await file.stat();
    if (
      bytes > MAX_REPORT_BYTES ||
      bytes !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.nlink !== 1
    )
      return { ...response, status: "invalid", reason: "report_invalid" };
    const report = parseDriverMeasurementEvaluationReport(JSON.parse(buffer.subarray(0, bytes).toString("utf8")), nowMs);
    const ageMs = Math.max(0, nowMs - Date.parse(report.generatedAt));
    return {
      ...response,
      status: ageMs > MAX_REPORT_AGE_MS ? "stale" : "current",
      reportAgeSeconds: ageMs / 1000,
      report,
      ...(ageMs > MAX_REPORT_AGE_MS ? { reason: "report_stale" as const } : {})
    };
  } catch (error) {
    if (error instanceof InvalidReport || error instanceof SyntaxError) return { ...response, status: "invalid", reason: "report_invalid" };
    return { ...response, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "report_missing" : "report_unreadable" };
  } finally {
    await file?.close().catch(() => undefined);
  }
}
