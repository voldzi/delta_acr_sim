/**
 * Comparison-only inspection of driver-measurements-v1 aggregates.
 *
 * This module has no IO, clock, cache, provider call or traffic writer. An
 * eligible comparison is NOT permission to apply a speed or change an ETA.
 */
export const DRIVER_SPEED_PILOT_CONTRACT = "driver-speed-pilot-evaluation-v1";
export type DriverSpeedPilotMode = "disabled" | "comparison_only";

const DATASET = /^sim-routing-\d{4}-\d{2}-\d{2}-\d+$/;
const EDGE_ID = /^(?:0|[1-9]\d*)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const REVIEW_VERSION = /^[A-Za-z0-9._:-]{1,96}$/;
const WINDOW_MS = 300_000;
const MAX_ROWS = 1_000;
const MAX_SPEED_KPH = 252;
// A conservative comparison filter, not a claim about ETA accuracy. A reviewed
// edge may tighten it; input cannot widen it or lower the contributor thresholds.
const MAX_COMPARISON_SPREAD_KPH = 20;
const MAX_OFFICIAL_SNAPSHOT_AGE_MS = 60_000;
const MAX_OFFICIAL_FLOW_AGE_MS = 1_800_000;

export interface DriverSpeedPilotAggregate {
  dataset: string;
  directedEdgeId: string;
  windowStart: string;
  usableUntil: string;
  state: "current" | "historical";
  attestedContributorCount: number;
  intervalCount: number;
  p10SpeedKph: number;
  medianSpeedKph: number;
  p90SpeedKph: number;
}

export interface DriverSpeedPilotReviewedEdge {
  dataset: string;
  directedEdgeId: string;
  speedCapKph: number;
  reviewVersion: string;
  maximumSpreadKph?: number;
}

export interface DriverSpeedPilotOfficialEdge {
  dataset: string;
  directedEdgeId: string;
  observedAt: string;
  usableUntil: string;
}

/**
 * `known: true` asserts complete coverage evidence for the reviewed edge set,
 * not an arbitrary/truncated list of returned flows. The caller owns that
 * assertion. `asOf` is the inspection instant, never a provider observation.
 */
export type DriverSpeedPilotOfficialCoverage =
  | { known: false }
  | {
      known: true;
      dataset: string;
      asOf: string;
      edges: readonly DriverSpeedPilotOfficialEdge[];
    };

export interface DriverSpeedPilotInput {
  mode?: DriverSpeedPilotMode;
  now: string;
  activeDataset: string;
  aggregates: readonly DriverSpeedPilotAggregate[];
  reviewedEdges: readonly DriverSpeedPilotReviewedEdge[];
  officialCoverage: DriverSpeedPilotOfficialCoverage;
}

export const DRIVER_SPEED_PILOT_REJECTION_REASONS = Object.freeze([
  "disabled",
  "malformed_aggregate",
  "duplicate_aggregate",
  "wrong_dataset",
  "invalid_counts",
  "insufficient_contributors",
  "insufficient_intervals",
  "invalid_speed",
  "speed_order",
  "invalid_window",
  "future_window",
  "expired_window",
  "historical_window",
  "invalid_review",
  "unreviewed_edge",
  "speed_cap",
  "excessive_spread",
  "official_coverage_unknown",
  "official_fresh_precedence"
] as const);
export type DriverSpeedPilotRejectionReason = typeof DRIVER_SPEED_PILOT_REJECTION_REASONS[number];

export const DRIVER_SPEED_PILOT_PROMOTION_BLOCKING_REASONS = Object.freeze([
  "comparison_only_no_live_writer",
  "v1_true_observation_timestamps_unavailable",
  "v1_full_edge_coverage_unavailable",
  "v1_stationary_waits_not_represented",
  "live_processing_consent_not_attested",
  "revocation_overlay_ack_not_available",
  "independent_contributors_not_verified",
  "independent_eta_validation_not_available"
] as const);

export interface DriverSpeedPilotEvaluation {
  contractVersion: typeof DRIVER_SPEED_PILOT_CONTRACT;
  mode: DriverSpeedPilotMode;
  consideredAggregateCount: number;
  eligibleAggregateCount: number;
  eligibleEdgeCount: number;
  rejectedAggregateCount: number;
  rejectionCounts: Readonly<Partial<Record<DriverSpeedPilotRejectionReason, number>>>;
  officialCoverageStatus: "known" | "unknown";
  timeEvidence: "source_window_bounds_only";
  sourceWindowBounds: Readonly<{
    earliestWindowStart: string | null;
    latestWindowStart: string | null;
    earliestUsableUntil: string | null;
  }>;
  liveAppliedEdgeCount: 0;
  promotionBlockingReasons: readonly typeof DRIVER_SPEED_PILOT_PROMOTION_BLOCKING_REASONS[number][];
}

export class DriverSpeedPilotInputError extends Error {
  readonly code = "DRIVER_SPEED_PILOT_INPUT_INVALID";
  constructor() { super("Invalid driver speed comparison input."); }
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !keys.includes(key))) return undefined;
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => descriptor.get || descriptor.set)) return undefined;
  const candidate = value as Record<string, unknown>;
  return candidate;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !ISO.test(value)) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) return undefined;
  return time;
}

function dataset(value: unknown): value is string {
  return typeof value === "string" && DATASET.test(value);
}

function directedEdge(value: unknown): value is string {
  if (typeof value !== "string" || !EDGE_ID.test(value)) return false;
  const id = Number(value);
  return Number.isSafeInteger(id) && id >= 0 && id < 2 ** 46 && id % 8 <= 2;
}

function finiteSpeed(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_SPEED_KPH;
}

function boundedRows(value: unknown): value is readonly unknown[] {
  return Array.isArray(value) && value.length <= MAX_ROWS;
}

const AGGREGATE_KEYS = ["dataset", "directedEdgeId", "windowStart", "usableUntil", "state", "attestedContributorCount", "intervalCount", "p10SpeedKph", "medianSpeedKph", "p90SpeedKph"];
const REVIEW_KEYS = ["dataset", "directedEdgeId", "speedCapKph", "reviewVersion", "maximumSpreadKph"];
const OFFICIAL_KEYS = ["dataset", "directedEdgeId", "observedAt", "usableUntil"];
const edgeKey = (graph: string, edge: string): string => `${graph}:${edge}`;

function reviews(rows: readonly unknown[]): Map<string, DriverSpeedPilotReviewedEdge> | undefined {
  const result = new Map<string, DriverSpeedPilotReviewedEdge>();
  for (const value of rows) {
    const item = record(value, REVIEW_KEYS);
    if (!item || !dataset(item.dataset) || !directedEdge(item.directedEdgeId) || !finiteSpeed(item.speedCapKph) ||
      typeof item.reviewVersion !== "string" || !REVIEW_VERSION.test(item.reviewVersion) ||
      (item.maximumSpreadKph !== undefined && (typeof item.maximumSpreadKph !== "number" ||
        !Number.isFinite(item.maximumSpreadKph) || item.maximumSpreadKph <= 0 || item.maximumSpreadKph > MAX_COMPARISON_SPREAD_KPH))) return undefined;
    const key = edgeKey(item.dataset, item.directedEdgeId);
    if (result.has(key)) return undefined;
    result.set(key, item as unknown as DriverSpeedPilotReviewedEdge);
  }
  return result;
}

function officialCoverage(value: unknown, activeDataset: string, now: number): Set<string> | undefined {
  const item = record(value, ["known", "dataset", "asOf", "edges"]);
  if (!item || item.known !== true) return undefined;
  const asOf = timestamp(item.asOf);
  if (item.dataset !== activeDataset || asOf === undefined || asOf > now || now - asOf > MAX_OFFICIAL_SNAPSHOT_AGE_MS || !boundedRows(item.edges)) return undefined;
  const result = new Set<string>();
  const seen = new Set<string>();
  for (const value of item.edges) {
    const edge = record(value, OFFICIAL_KEYS);
    if (!edge || edge.dataset !== activeDataset || !directedEdge(edge.directedEdgeId)) return undefined;
    const observed = timestamp(edge.observedAt), until = timestamp(edge.usableUntil);
    if (observed === undefined || until === undefined || observed > asOf || until <= observed || until - observed > MAX_OFFICIAL_FLOW_AGE_MS) return undefined;
    const key = edgeKey(activeDataset, edge.directedEdgeId);
    if (seen.has(key)) return undefined;
    seen.add(key);
    if (until > now && now - observed < MAX_OFFICIAL_FLOW_AGE_MS) result.add(key);
  }
  return result;
}

/** Pure, bounded and deliberately non-promoting. No caller-supplied output fields are echoed. */
export function evaluateDriverSpeedPilot(value: unknown): Readonly<DriverSpeedPilotEvaluation> {
  const input = record(value, ["mode", "now", "activeDataset", "aggregates", "reviewedEdges", "officialCoverage"]);
  if (!input || (input.mode !== undefined && input.mode !== "disabled" && input.mode !== "comparison_only") ||
    !dataset(input.activeDataset) || timestamp(input.now) === undefined || !boundedRows(input.aggregates) || !boundedRows(input.reviewedEdges)) throw new DriverSpeedPilotInputError();
  const mode: DriverSpeedPilotMode = input.mode === "comparison_only" ? "comparison_only" : "disabled";
  const now = timestamp(input.now)!;
  const reviewMap = reviews(input.reviewedEdges);
  const officialEdges = officialCoverage(input.officialCoverage, input.activeDataset, now);
  const rejectionCounts: Partial<Record<DriverSpeedPilotRejectionReason, number>> = {};
  const reject = (reason: DriverSpeedPilotRejectionReason): void => { rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1; };
  const duplicates = new Map<string, number>();
  for (const value of input.aggregates) {
    const row = record(value, AGGREGATE_KEYS);
    if (row && dataset(row.dataset) && directedEdge(row.directedEdgeId) && timestamp(row.windowStart) !== undefined) {
      const key = `${edgeKey(row.dataset, row.directedEdgeId)}:${timestamp(row.windowStart)}`;
      duplicates.set(key, (duplicates.get(key) ?? 0) + 1);
    }
  }
  let eligibleAggregateCount = 0;
  const eligibleEdges = new Set<string>();
  const windows: number[] = [], deadlines: number[] = [];
  for (const value of input.aggregates) {
    if (mode === "disabled") { reject("disabled"); continue; }
    const row = record(value, AGGREGATE_KEYS);
    if (!row || !dataset(row.dataset) || !directedEdge(row.directedEdgeId) || (row.state !== "current" && row.state !== "historical")) { reject("malformed_aggregate"); continue; }
    if (row.dataset !== input.activeDataset) { reject("wrong_dataset"); continue; }
    const start = timestamp(row.windowStart), until = timestamp(row.usableUntil);
    if (start === undefined || until === undefined || start % WINDOW_MS !== 0 || until !== start + WINDOW_MS) { reject("invalid_window"); continue; }
    if ((duplicates.get(`${edgeKey(row.dataset, row.directedEdgeId)}:${start}`) ?? 0) > 1) { reject("duplicate_aggregate"); continue; }
    if (start > now) { reject("future_window"); continue; }
    if (until <= now) { reject("expired_window"); continue; }
    if (row.state !== "current") { reject("historical_window"); continue; }
    const contributorCount = row.attestedContributorCount, intervalCount = row.intervalCount;
    if (typeof contributorCount !== "number" || !Number.isSafeInteger(contributorCount) || contributorCount < 0 ||
      typeof intervalCount !== "number" || !Number.isSafeInteger(intervalCount) || intervalCount < contributorCount) { reject("invalid_counts"); continue; }
    if (contributorCount < 5) { reject("insufficient_contributors"); continue; }
    if (intervalCount < 10) { reject("insufficient_intervals"); continue; }
    if (!finiteSpeed(row.p10SpeedKph) || !finiteSpeed(row.medianSpeedKph) || !finiteSpeed(row.p90SpeedKph)) { reject("invalid_speed"); continue; }
    if (row.p10SpeedKph > row.medianSpeedKph || row.medianSpeedKph > row.p90SpeedKph) { reject("speed_order"); continue; }
    if (!reviewMap) { reject("invalid_review"); continue; }
    const key = edgeKey(row.dataset, row.directedEdgeId), review = reviewMap.get(key);
    if (!review) { reject("unreviewed_edge"); continue; }
    if (row.p90SpeedKph > review.speedCapKph) { reject("speed_cap"); continue; }
    if (row.p90SpeedKph - row.p10SpeedKph > (review.maximumSpreadKph ?? MAX_COMPARISON_SPREAD_KPH)) { reject("excessive_spread"); continue; }
    if (!officialEdges) { reject("official_coverage_unknown"); continue; }
    if (officialEdges.has(key)) { reject("official_fresh_precedence"); continue; }
    eligibleAggregateCount++;
    eligibleEdges.add(key);
    windows.push(start); deadlines.push(until);
  }
  const iso = (time: number): string => new Date(time).toISOString();
  return Object.freeze({
    contractVersion: DRIVER_SPEED_PILOT_CONTRACT,
    mode,
    consideredAggregateCount: input.aggregates.length,
    eligibleAggregateCount,
    eligibleEdgeCount: eligibleEdges.size,
    rejectedAggregateCount: input.aggregates.length - eligibleAggregateCount,
    rejectionCounts: Object.freeze(rejectionCounts),
    officialCoverageStatus: officialEdges ? "known" : "unknown",
    timeEvidence: "source_window_bounds_only",
    sourceWindowBounds: Object.freeze({
      earliestWindowStart: windows.length ? iso(Math.min(...windows)) : null,
      latestWindowStart: windows.length ? iso(Math.max(...windows)) : null,
      earliestUsableUntil: deadlines.length ? iso(Math.min(...deadlines)) : null
    }),
    liveAppliedEdgeCount: 0,
    promotionBlockingReasons: Object.freeze([...DRIVER_SPEED_PILOT_PROMOTION_BLOCKING_REASONS])
  });
}
