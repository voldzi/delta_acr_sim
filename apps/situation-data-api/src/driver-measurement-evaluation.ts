/** Scalar-only evaluation of the retained shadow data; not a live-speed input. */
export const DRIVER_EVALUATION_CONTRACT = "sim-driver-evaluation-v1";
export const DRIVER_EVALUATION_REJECTION_CODES = [
  "non_measured_position", "low_sensor_quality", "personal_stop_or_unknown_motion",
  "sampling_gap", "ambiguous_or_noncontinuous_edge", "heading_inconsistent",
  "speed_or_distance_inconsistent", "eta_not_comparable"
] as const;
export type DriverEvaluationRejectionCode = typeof DRIVER_EVALUATION_REJECTION_CODES[number];

export interface DriverEvaluationEta {
  routingDataset: string;
  windowStart: string;
  attestedContributorCount: number;
  observationCount: number;
  medianAbsoluteErrorSeconds: number;
  medianAbsoluteErrorPercent: number;
}
export interface DriverEvaluationSpeedCounts {
  evaluatedGroupCount: number;
  currentGroupCount: number;
  historicalGroupCount: number;
  futureGroupCount: number;
  otherDatasetGroupCount: number;
  subthresholdGroupCount: number;
  qualityGroupCount: number;
  closedWindowGroupCount: number;
  currentQualityGroupCount: number;
  currentQualityIntervalCount: number;
}
export interface DriverEvaluationSnapshot {
  contractVersion: typeof DRIVER_EVALUATION_CONTRACT;
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
  summary: {
    retainedBatchCount: number;
    lastAcceptedAt: string | null;
    acceptedIntervalCount: number;
    deduplicatedIntervalCount: number;
    activeRevocationTombstoneCount: number;
    rejectionCounts: Record<DriverEvaluationRejectionCode, number>;
    speed: DriverEvaluationSpeedCounts;
    eta: DriverEvaluationEta[];
  };
  limits: { minimumAttestedContributors: 5; minimumIntervals: 10; maximumEtaRows: 100 };
}

const DATASET = /^sim-routing-\d{4}-\d{2}-\d{2}-\d+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SPEED_KEYS: readonly (keyof DriverEvaluationSpeedCounts)[] = [
  "evaluatedGroupCount", "currentGroupCount", "historicalGroupCount", "futureGroupCount",
  "otherDatasetGroupCount", "subthresholdGroupCount", "qualityGroupCount", "closedWindowGroupCount",
  "currentQualityGroupCount", "currentQualityIntervalCount"
];
const invalid = (): never => { throw new Error("Invalid driver evaluation snapshot"); };
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}
function nonnegative(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return invalid();
  return value;
}
function timestamp(value: unknown): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return invalid();
    value = value.toISOString();
  }
  if (typeof value !== "string" || !ISO.test(value) || !Number.isFinite(Date.parse(value))) return invalid();
  const normalized = new Date(value).toISOString();
  if (normalized.slice(0, 19) !== value.slice(0, 19)) return invalid();
  return normalized;
}
export function driverEvaluationInputs(dataset: string, now: string): { dataset: string; now: string; since: string } {
  if (typeof dataset !== "string" || !DATASET.test(dataset)) return invalid();
  const normalized = timestamp(now);
  return { dataset, now: normalized, since: new Date(Date.parse(normalized) - 86400000).toISOString() };
}

/** Reconstruct the exact DTO: no raw query row, JSON object or identifier is spread. */
export function projectDriverEvaluationSnapshot(dataset: string, now: string, totalsValue: unknown,
  speedValue: unknown, etaValues: unknown[]): DriverEvaluationSnapshot {
  const input = driverEvaluationInputs(dataset, now), totals = record(totalsValue), speedRow = record(speedValue);
  const rawRejections = record(totals.rejectionCounts);
  if (Object.keys(rawRejections).some(key => !(DRIVER_EVALUATION_REJECTION_CODES as readonly string[]).includes(key))) return invalid();
  const rejectionCounts = Object.fromEntries(DRIVER_EVALUATION_REJECTION_CODES.map(key => [key,
    Object.hasOwn(rawRejections,key) ? count(rawRejections[key]) : 0])) as Record<DriverEvaluationRejectionCode, number>;
  const speed = Object.fromEntries(SPEED_KEYS.map(key => [key, count(speedRow[key])])) as unknown as DriverEvaluationSpeedCounts;
  if (speed.evaluatedGroupCount !== speed.currentGroupCount + speed.historicalGroupCount + speed.futureGroupCount + speed.otherDatasetGroupCount ||
      speed.closedWindowGroupCount !== speed.historicalGroupCount ||
      speed.currentQualityGroupCount > speed.currentGroupCount ||
      speed.currentQualityGroupCount > speed.qualityGroupCount ||
      speed.qualityGroupCount > speed.currentGroupCount + speed.historicalGroupCount ||
      speed.subthresholdGroupCount > speed.currentGroupCount + speed.historicalGroupCount ||
      speed.qualityGroupCount + speed.subthresholdGroupCount !== speed.currentGroupCount + speed.historicalGroupCount ||
      speed.currentQualityIntervalCount < speed.currentQualityGroupCount * 10 ||
      (speed.currentQualityGroupCount === 0 && speed.currentQualityIntervalCount !== 0)) return invalid();
  if (!Array.isArray(etaValues) || etaValues.length > 100) return invalid();
  const eta = etaValues.map(value => {
    const row = record(value), windowStart = timestamp(row.windowStart);
    if (row.routingDataset !== input.dataset || !windowStart.endsWith(":00:00.000Z") ||
        Date.parse(windowStart) < Date.parse(input.since) || Date.parse(windowStart) > Date.parse(input.now)) return invalid();
    const attestedContributorCount = count(row.attestedContributorCount), observationCount = count(row.observationCount);
    if (attestedContributorCount < 5 || observationCount < 10 || observationCount < attestedContributorCount) return invalid();
    return { routingDataset: input.dataset, windowStart, attestedContributorCount, observationCount,
      medianAbsoluteErrorSeconds: nonnegative(row.medianAbsoluteErrorSeconds),
      medianAbsoluteErrorPercent: nonnegative(row.medianAbsoluteErrorPercent) };
  });
  const lastAcceptedAt = totals.lastAcceptedAt === null ? null : timestamp(totals.lastAcceptedAt);
  if (lastAcceptedAt !== null && Date.parse(lastAcceptedAt) > Date.parse(input.now)) return invalid();
  return {
    contractVersion: DRIVER_EVALUATION_CONTRACT, generatedAt: input.now, asOf: input.now, routingDataset: input.dataset,
    evaluationWindow: { since: input.since, until: input.now }, applicationMode: "shadow_only",
    etaEvidence: "client_reported_not_ground_truth", consistency: "read_only_repeatable_read", retentionDays: 7,
    livePromotionSupported: false, revocationCoverage: "database_only",
    summary: {
      retainedBatchCount: count(totals.retainedBatchCount), lastAcceptedAt,
      acceptedIntervalCount: count(totals.acceptedIntervalCount), deduplicatedIntervalCount: count(totals.deduplicatedIntervalCount),
      activeRevocationTombstoneCount: count(totals.activeRevocationTombstoneCount), rejectionCounts, speed, eta
    },
    limits: { minimumAttestedContributors: 5, minimumIntervals: 10, maximumEtaRows: 100 }
  };
}

/** Fresh report metadata is not authorization to apply any of its measurements. */
export function isDriverEvaluationSnapshotFresh(snapshot: DriverEvaluationSnapshot, nowMs: number, maximumAgeMs = 90000): boolean {
  const asOf = Date.parse(snapshot.asOf), generated = Date.parse(snapshot.generatedAt);
  return Number.isFinite(nowMs) && Number.isFinite(asOf) && asOf === generated &&
    Number.isFinite(maximumAgeMs) && maximumAgeMs > 0 && nowMs >= generated && nowMs - generated <= maximumAgeMs;
}
