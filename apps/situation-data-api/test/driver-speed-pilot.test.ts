import { describe, expect, it } from "vitest";
import {
  DRIVER_SPEED_PILOT_CONTRACT,
  DRIVER_SPEED_PILOT_PROMOTION_BLOCKING_REASONS,
  DRIVER_SPEED_PILOT_REJECTION_REASONS,
  DriverSpeedPilotInputError,
  evaluateDriverSpeedPilot,
  type DriverSpeedPilotAggregate,
  type DriverSpeedPilotInput,
  type DriverSpeedPilotOfficialCoverage,
  type DriverSpeedPilotReviewedEdge,
  type DriverSpeedPilotRejectionReason
} from "../src/driver-speed-pilot.js";

const graph = "sim-routing-2026-10-11-1791687606";
const otherGraph = "sim-routing-2026-10-04-1791082806";
const now = "2026-10-13T12:03:00.000Z";
const windowStart = "2026-10-13T12:00:00.000Z";
const usableUntil = "2026-10-13T12:05:00.000Z";

function aggregate(changes: Partial<DriverSpeedPilotAggregate> = {}): DriverSpeedPilotAggregate {
  return {
    dataset: graph, directedEdgeId: "8", windowStart, usableUntil, state: "current",
    attestedContributorCount: 5, intervalCount: 10,
    p10SpeedKph: 20, medianSpeedKph: 30, p90SpeedKph: 40, ...changes
  };
}

function review(changes: Partial<DriverSpeedPilotReviewedEdge> = {}): DriverSpeedPilotReviewedEdge {
  return { dataset: graph, directedEdgeId: "8", speedCapKph: 50, reviewVersion: "synthetic-direction-review-v1", ...changes };
}

function coverage(edges: Extract<DriverSpeedPilotOfficialCoverage, { known: true }>["edges"] = []): DriverSpeedPilotOfficialCoverage {
  return { known: true, dataset: graph, asOf: now, edges };
}

function fixture(changes: Partial<DriverSpeedPilotInput> = {}): DriverSpeedPilotInput {
  return { mode: "comparison_only", now, activeDataset: graph, aggregates: [aggregate()], reviewedEdges: [review()], officialCoverage: coverage(), ...changes };
}

function rowWithInvalid(changes: Record<string, unknown>): DriverSpeedPilotAggregate {
  return { ...aggregate(), ...changes } as unknown as DriverSpeedPilotAggregate;
}

function rejected(row: DriverSpeedPilotAggregate, reason: DriverSpeedPilotRejectionReason): void {
  const result = evaluateDriverSpeedPilot(fixture({ aggregates: [row] }));
  expect(result).toMatchObject({ consideredAggregateCount: 1, eligibleAggregateCount: 0, rejectedAggregateCount: 1, liveAppliedEdgeCount: 0 });
  expect(result.rejectionCounts).toEqual({ [reason]: 1 });
}

describe("driver speed pilot: comparison-only boundary", () => {
  it("defaults to disabled and never accepts a live mode", () => {
    const implicit = fixture(); delete implicit.mode;
    for (const input of [implicit, fixture({ mode: "disabled" })]) {
      const result = evaluateDriverSpeedPilot(input);
      expect(result.mode).toBe("disabled");
      expect(result.eligibleAggregateCount).toBe(0);
      expect(result.rejectionCounts).toEqual({ disabled: 1 });
      expect(result.liveAppliedEdgeCount).toBe(0);
    }
    expect(() => evaluateDriverSpeedPilot({ ...fixture(), mode: "live" })).toThrow(DriverSpeedPilotInputError);
  });

  it("returns a bounded comparison candidate, never a selected speed or edge ID", () => {
    const result = evaluateDriverSpeedPilot(fixture());
    expect(result).toMatchObject({ contractVersion: DRIVER_SPEED_PILOT_CONTRACT, mode: "comparison_only",
      consideredAggregateCount: 1, eligibleAggregateCount: 1, eligibleEdgeCount: 1, rejectedAggregateCount: 0,
      officialCoverageStatus: "known", timeEvidence: "source_window_bounds_only", liveAppliedEdgeCount: 0,
      sourceWindowBounds: { earliestWindowStart: windowStart, latestWindowStart: windowStart, earliestUsableUntil: usableUntil } });
    expect(result.rejectionCounts).toEqual({});
    const output = JSON.stringify(result);
    for (const privateField of ["directedEdgeId", "contributorIdDay", "contributor_hash", "lat", "lon", "medianSpeedKph", "reviewVersion"]) {
      expect(output).not.toContain(`"${privateField}"`);
    }
    expect(output).not.toContain(graph);
  });

  it("retains explicit blockers even for an eligible comparison", () => {
    const result = evaluateDriverSpeedPilot(fixture());
    expect(result.promotionBlockingReasons).toEqual(DRIVER_SPEED_PILOT_PROMOTION_BLOCKING_REASONS);
    expect(result.promotionBlockingReasons).toEqual(expect.arrayContaining([
      "v1_true_observation_timestamps_unavailable", "v1_full_edge_coverage_unavailable",
      "v1_stationary_waits_not_represented", "live_processing_consent_not_attested",
      "revocation_overlay_ack_not_available", "independent_contributors_not_verified"
    ]));
  });

  it("uses the unchanged source-window deadline, including its exact boundary", () => {
    const before = evaluateDriverSpeedPilot(fixture({ now: "2026-10-13T12:04:59.999Z" }));
    expect(before.eligibleAggregateCount).toBe(0); // The old official snapshot is now unknown, not refreshed by evaluation.
    const atBoundary = evaluateDriverSpeedPilot(fixture({ now: usableUntil,
      officialCoverage: { known: true, dataset: graph, asOf: usableUntil, edges: [] } }));
    expect(atBoundary.rejectionCounts).toEqual({ expired_window: 1 });
    const immediatelyBefore = evaluateDriverSpeedPilot(fixture({ now: "2026-10-13T12:04:59.999Z",
      officialCoverage: { known: true, dataset: graph, asOf: "2026-10-13T12:04:59.999Z", edges: [] } }));
    expect(immediatelyBefore.eligibleAggregateCount).toBe(1);
    expect(immediatelyBefore.sourceWindowBounds.earliestUsableUntil).toBe(usableUntil);
  });

  it("does not rejuvenate an expired window with a receive/generated timestamp", () => {
    rejected(aggregate({ windowStart: "2026-10-13T11:55:00.000Z", usableUntil: "2026-10-13T12:00:00.000Z" }), "expired_window");
    rejected(rowWithInvalid({ generatedAt: now }), "malformed_aggregate");
    expect(() => evaluateDriverSpeedPilot({ ...fixture(), generatedAt: now })).toThrow(DriverSpeedPilotInputError);
  });

  it("rejects a future window and a historical label even before expiry", () => {
    rejected(aggregate({ windowStart: usableUntil, usableUntil: "2026-10-13T12:10:00.000Z" }), "future_window");
    rejected(aggregate({ state: "historical" }), "historical_window");
  });

  it.each([
    { windowStart: "2026-10-13T12:00:01.000Z" },
    { usableUntil: "2026-10-13T12:05:00.001Z" },
    { usableUntil: "2026-10-13T12:06:00.000Z" },
    { windowStart: "2026-02-30T12:00:00.000Z" },
    { windowStart: "2026-10-13T12:00:00+00:00" },
    { windowStart: undefined },
    { usableUntil: null }
  ])("rejects invalid/noncanonical source window bounds: %j", changes => {
    rejected(rowWithInvalid(changes), "invalid_window");
  });

  it("fences graph changes and reviewed directions separately", () => {
    rejected(aggregate({ dataset: otherGraph }), "wrong_dataset");
    const graphChanged = evaluateDriverSpeedPilot(fixture({ activeDataset: otherGraph }));
    expect(graphChanged.rejectionCounts).toEqual({ wrong_dataset: 1 });
    const wrongReviewGraph = evaluateDriverSpeedPilot(fixture({ reviewedEdges: [review({ dataset: otherGraph })] }));
    expect(wrongReviewGraph.rejectionCounts).toEqual({ unreviewed_edge: 1 });
    rejected(aggregate({ directedEdgeId: "9" }), "unreviewed_edge");
  });

  it("does not lower the five-contributor or ten-interval thresholds", () => {
    rejected(aggregate({ attestedContributorCount: 4 }), "insufficient_contributors");
    rejected(aggregate({ intervalCount: 9 }), "insufficient_intervals");
    expect(evaluateDriverSpeedPilot(fixture()).eligibleAggregateCount).toBe(1);
  });

  it.each([
    { attestedContributorCount: Number.NaN }, { attestedContributorCount: Number.POSITIVE_INFINITY },
    { attestedContributorCount: 5.5 }, { attestedContributorCount: -1 },
    { attestedContributorCount: "5" }, { intervalCount: 4 }, { intervalCount: 10.5 },
    { intervalCount: Number.MAX_SAFE_INTEGER + 1 }
  ])("rejects malformed counts without numeric coercion: %j", changes => {
    rejected(rowWithInvalid(changes), "invalid_counts");
  });

  it.each([
    { medianSpeedKph: Number.NaN }, { medianSpeedKph: Number.POSITIVE_INFINITY },
    { medianSpeedKph: -1 }, { medianSpeedKph: 0 }, { medianSpeedKph: "30" },
    { p10SpeedKph: 0 }, { p90SpeedKph: 253 }
  ])("rejects malformed and unbounded speeds: %j", changes => {
    rejected(rowWithInvalid(changes), "invalid_speed");
  });

  it("rejects out-of-order speed percentiles instead of sorting supplied values", () => {
    rejected(aggregate({ p10SpeedKph: 31 }), "speed_order");
    rejected(aggregate({ p90SpeedKph: 29 }), "speed_order");
  });

  it("requires the whole reviewed distribution to fit the cap, without clamping", () => {
    const result = evaluateDriverSpeedPilot(fixture({ reviewedEdges: [review({ speedCapKph: 35 })] }));
    expect(result.rejectionCounts).toEqual({ speed_cap: 1 });
    expect(result.eligibleAggregateCount).toBe(0);
  });

  it("rejects excessive spread and allows only tighter per-edge review limits", () => {
    rejected(aggregate({ p10SpeedKph: 10 }), "excessive_spread");
    const tighter = evaluateDriverSpeedPilot(fixture({ reviewedEdges: [review({ maximumSpreadKph: 5 })] }));
    expect(tighter.rejectionCounts).toEqual({ excessive_spread: 1 });
    const wider = evaluateDriverSpeedPilot(fixture({ reviewedEdges: [review({ maximumSpreadKph: 21 })] }));
    expect(wider.rejectionCounts).toEqual({ invalid_review: 1 });
  });

  it("rejects missing, malformed or duplicate geographical reviews", () => {
    expect(evaluateDriverSpeedPilot(fixture({ reviewedEdges: [] })).rejectionCounts).toEqual({ unreviewed_edge: 1 });
    for (const reviewedEdges of [
      [review({ reviewVersion: "" })], [review({ reviewVersion: "free text description" })],
      [review({ speedCapKph: Number.NaN })], [review({ speedCapKph: 253 })],
      [review(), review()],
      [{ ...review(), latitude: 50 } as unknown as DriverSpeedPilotReviewedEdge]
    ]) {
      expect(evaluateDriverSpeedPilot(fixture({ reviewedEdges })).rejectionCounts).toEqual({ invalid_review: 1 });
    }
  });

  it("gives a fresh official speed on the same graph-bound direction priority", () => {
    const officialCoverage = coverage([{ dataset: graph, directedEdgeId: "8", observedAt: "2026-10-13T12:02:00.000Z", usableUntil: "2026-10-13T12:04:00.000Z" }]);
    const result = evaluateDriverSpeedPilot(fixture({ officialCoverage }));
    expect(result.rejectionCounts).toEqual({ official_fresh_precedence: 1 });
    expect(result.eligibleAggregateCount).toBe(0);
    expect(result.liveAppliedEdgeCount).toBe(0);
  });

  it("does not confuse the opposite direction with official coverage of this edge", () => {
    const officialCoverage = coverage([{ dataset: graph, directedEdgeId: "9", observedAt: "2026-10-13T12:02:00.000Z", usableUntil: "2026-10-13T12:04:00.000Z" }]);
    expect(evaluateDriverSpeedPilot(fixture({ officialCoverage })).eligibleAggregateCount).toBe(1);
  });

  it("does not treat an expired official speed as fresh", () => {
    const officialCoverage = coverage([{ dataset: graph, directedEdgeId: "8", observedAt: "2026-10-13T12:01:00.000Z", usableUntil: now }]);
    const result = evaluateDriverSpeedPilot(fixture({ officialCoverage }));
    expect(result.officialCoverageStatus).toBe("known");
    expect(result.eligibleAggregateCount).toBe(1);
  });

  it("does not infer missing official coverage from known=false, invalid or stale evidence", () => {
    const malformed = { known: true, dataset: graph, asOf: now, edges: [{ dataset: graph, directedEdgeId: "8", observedAt: "invalid", usableUntil }] };
    for (const officialCoverage of [
      { known: false }, undefined, malformed,
      { known: true, dataset: otherGraph, asOf: now, edges: [] },
      { known: true, dataset: graph, asOf: "2026-10-13T12:01:59.999Z", edges: [] },
      { known: true, dataset: graph, asOf: "2026-10-13T12:03:00.001Z", edges: [] },
      { known: true, dataset: graph, asOf: now, edges: [{ dataset: graph, directedEdgeId: "8", observedAt: "2026-10-13T12:03:01.000Z", usableUntil }] }
    ]) {
      const result = evaluateDriverSpeedPilot({ ...fixture(), officialCoverage });
      expect(result.officialCoverageStatus).toBe("unknown");
      expect(result.rejectionCounts).toEqual({ official_coverage_unknown: 1 });
      expect(result.eligibleAggregateCount).toBe(0);
    }
  });

  it("fails closed on duplicate official edges and unbounded official deadlines", () => {
    const edge = { dataset: graph, directedEdgeId: "8", observedAt: "2026-10-13T12:02:00.000Z", usableUntil };
    for (const edges of [[edge, edge], [{ ...edge, usableUntil: "2026-10-13T12:32:00.001Z" }]]) {
      expect(evaluateDriverSpeedPilot(fixture({ officialCoverage: coverage(edges) })).rejectionCounts).toEqual({ official_coverage_unknown: 1 });
    }
  });

  it.each([
    { directedEdgeId: "08" }, { directedEdgeId: "8.0" }, { directedEdgeId: "3" },
    { directedEdgeId: String(2 ** 46) }, { state: "live" }, { dataset: "untyped" },
    { contributorIdDay: "private-pseudonym" }, { points: [{ lat: 50, lon: 14 }] },
    { chatContext: "sensitive free text" }, { liveAppliedEdgeCount: 1 }
  ])("rejects extra or invalid row keys without echoing them: %j", changes => {
    rejected(rowWithInvalid(changes), "malformed_aggregate");
  });

  it("rejects all copies of a duplicate row instead of inflating evidence", () => {
    const result = evaluateDriverSpeedPilot(fixture({ aggregates: [aggregate(), aggregate()] }));
    expect(result).toMatchObject({ consideredAggregateCount: 2, eligibleAggregateCount: 0, rejectedAggregateCount: 2, liveAppliedEdgeCount: 0 });
    expect(result.rejectionCounts).toEqual({ duplicate_aggregate: 2 });
  });

  it("rejects accessor, inherited and symbol keys without evaluating free-text values", () => {
    const accessor = { ...aggregate() };
    Object.defineProperty(accessor, "state", { enumerable: true, get: () => { throw new Error("private accessor value"); } });
    const inherited = Object.create(aggregate()) as DriverSpeedPilotAggregate;
    const symbol = { ...aggregate(), [Symbol("private")]: "private" };
    for (const row of [accessor, inherited, symbol]) rejected(row, "malformed_aggregate");
    rejected(rowWithInvalid({ state: { toString: () => { throw new Error("private coercion value"); } } }), "malformed_aggregate");
  });

  it("keeps scalar count reconciliation and allows only the finite reason vocabulary", () => {
    const result = evaluateDriverSpeedPilot(fixture({ aggregates: [aggregate(), aggregate({ directedEdgeId: "16" }), aggregate({ dataset: otherGraph, directedEdgeId: "24" }), aggregate({ directedEdgeId: "32", intervalCount: 9 })],
      reviewedEdges: [review(), review({ directedEdgeId: "16" })],
      officialCoverage: coverage([{ dataset: graph, directedEdgeId: "16", observedAt: "2026-10-13T12:02:00.000Z", usableUntil }]) }));
    expect(result.consideredAggregateCount).toBe(4);
    expect(result.eligibleAggregateCount).toBe(1);
    expect(result.rejectedAggregateCount).toBe(3);
    expect(Object.values(result.rejectionCounts).reduce<number>((sum, count) => sum + (count ?? 0), 0)).toBe(result.rejectedAggregateCount);
    for (const reason of Object.keys(result.rejectionCounts)) expect(DRIVER_SPEED_PILOT_REJECTION_REASONS).toContain(reason);
  });

  it("has no snapshot cache: a new empty snapshot after revocation has no retained candidate", () => {
    const before = evaluateDriverSpeedPilot(fixture());
    const after = evaluateDriverSpeedPilot(fixture({ aggregates: [] }));
    expect(before.eligibleAggregateCount).toBe(1);
    expect(after).toMatchObject({ consideredAggregateCount: 0, eligibleAggregateCount: 0, eligibleEdgeCount: 0, rejectedAggregateCount: 0, liveAppliedEdgeCount: 0,
      sourceWindowBounds: { earliestWindowStart: null, latestWindowStart: null, earliestUsableUntil: null } });
    expect(after.promotionBlockingReasons).toContain("revocation_overlay_ack_not_available");
    // This only proves stateless comparison, not a writer's revocation acknowledgement.
  });

  it("bounds input lists and returns only a static input error, not payload data", () => {
    for (const input of [
      null, { ...fixture(), rawGps: "private" }, { ...fixture(), now: "2026-02-30T12:00:00.000Z" },
      { ...fixture(), activeDataset: "invalid" }, { ...fixture(), aggregates: [aggregate(), ...Array(1000).fill(aggregate())] },
      { ...fixture(), reviewedEdges: Array(1001).fill(review()) }, { ...fixture(), aggregates: "not-an-array" }
    ]) {
      expect(() => evaluateDriverSpeedPilot(input)).toThrow(DriverSpeedPilotInputError);
      try { evaluateDriverSpeedPilot(input); } catch (error) {
        expect(error).toBeInstanceOf(DriverSpeedPilotInputError);
        expect((error as DriverSpeedPilotInputError).code).toBe("DRIVER_SPEED_PILOT_INPUT_INVALID");
        expect((error as Error).message).not.toContain("private");
      }
    }
  });

  it("does not mutate supplied aggregates/reviews and freezes its zero-live result", () => {
    const input = fixture();
    for (const row of input.aggregates) Object.freeze(row);
    for (const row of input.reviewedEdges) Object.freeze(row);
    Object.freeze(input.aggregates); Object.freeze(input.reviewedEdges); Object.freeze(input);
    const snapshot = JSON.stringify(input);
    const result = evaluateDriverSpeedPilot(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.rejectionCounts)).toBe(true);
    expect(Object.isFrozen(result.sourceWindowBounds)).toBe(true);
    expect(Object.isFrozen(result.promotionBlockingReasons)).toBe(true);
    expect(Reflect.set(result, "liveAppliedEdgeCount", 1)).toBe(false);
    expect(result.liveAppliedEdgeCount).toBe(0);
  });
});
