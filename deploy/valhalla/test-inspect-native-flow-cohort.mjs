import assert from "node:assert/strict";
import test from "node:test";
import { countCohort } from "./inspect-native-flow-cohort.mjs";

const now = Date.parse("2026-10-01T18:00:00Z");
const candidate = { contractVersion: "sim-native-baseline-review-v1", approvedForLive: false, staticRevision: "synthetic",
  mapping: { "private-synthetic": [{ id: 1 }] } };
const flow = { messageId: "private-synthetic", observedAt: "2026-10-01T17:59:00Z", validUntil: "2026-10-01T18:01:00Z", averageSpeedKph: 50 };
const feed = (flows) => ({ staticRevision: "synthetic", maxAgeSeconds: 1800, flows });

test("counts only current cohort, separates records from references and never exposes identities", () => {
  const counts = countCohort(candidate, feed([flow, flow, { ...flow, messageId: "foreign" }]), now);
  assert.equal(counts.candidateFreshFlowRecords, 2);
  assert.equal(counts.candidateFreshUniqueReferences, 1);
  assert.ok(!JSON.stringify(counts).includes("private-synthetic"));
});

test("expiry and observation-age deadlines are not renewed", () => {
  const counts = countCohort(candidate, feed([{ ...flow, validUntil: "2026-10-01T18:00:00Z" },
    { ...flow, observedAt: "2026-10-01T17:00:00Z", validUntil: undefined }]), now);
  assert.equal(counts.candidateExpiredFlowRecords, 2);
  assert.equal(counts.candidateFreshFlowRecords, 0);
});

test("invalid timestamp, future observation and invalid speed are not current", () => {
  for (const change of [{ observedAt: "yesterday" }, { observedAt: "2026-10-01T18:00:31Z" },
    { validUntil: "2026-10-01T17:58:00Z" }, { averageSpeedKph: 0 }, { averageSpeedKph: NaN }, { averageSpeedKph: 251 }]) {
    const counts = countCohort(candidate, feed([{ ...flow, ...change }]), now);
    assert.equal(counts.candidateInvalidFlowRecords, 1);
    assert.equal(counts.candidateFreshFlowRecords, 0);
  }
});

test("wrong artifact, source revision or timing configuration fails closed", () => {
  for (const change of [{ approvedForLive: true }, { contractVersion: "wrong" }, { staticRevision: "old" }, { mapping: [] }]) {
    assert.throws(() => countCohort({ ...candidate, ...change }, feed([flow]), now));
  }
  for (const maxAgeSeconds of [0, NaN, undefined]) assert.throws(() => countCohort(candidate, { ...feed([flow]), maxAgeSeconds }, now));
});
