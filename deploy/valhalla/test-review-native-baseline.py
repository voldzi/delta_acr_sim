#!/usr/bin/env python3
"""Synthetic fail-closed baseline/partial ownership tests."""
import copy
import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("baseline_review", Path(__file__).with_name("review-native-baseline.py"))
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)


def interval(edge, begin=0., end=1.):
    return {"edgeId": edge, "beginFraction": begin, "endFraction": end, "edgeLengthMeters": 100.}


class BaselineReviewTests(unittest.TestCase):
    def setUp(self):
        common = {"routingDataset": "synthetic", "staticRevision": "a" * 64}
        self.audit = {**common, "contractVersion": "sim-openlr-native-audit-v1", "decoderVersion": "openlr-native-v2",
                      "approvedForLive": False, "graphSha256": "b" * 64, "tmcSha256": "c" * 64,
                      "mapping": {"new": [{"id": 16}]}, "intervalCandidates": {"new": [interval(16)]},
                      "wholeEdgeCandidateReferenceCount": 1, "matchedIntervalReferenceCount": 1}
        self.baseline = {**common, "contractVersion": "valhalla-openlr-edge-map-v2", "matcherVersion": "openlr-trace-v2",
                         "mapping": {"active": [{"id": 8, "baselineSpeedKph": 50}]}, "mappedSegmentCount": 1}
        self.direction = {**common, "contractVersion": "sim-native-direction-review-v1", "approvedForLive": False,
                          "graphSha256": "b" * 64, "tmcSha256": "c" * 64, "nativeAuditSha256": "d" * 64,
                          "verdicts": {"new": "independent_geometry_direction_pass"}}

    def gate(self):
        return review.gate(self.audit, self.baseline, self.direction, "d" * 64, "e" * 64)

    def test_disjoint_directed_edge_is_only_an_unapproved_candidate(self):
        original = copy.deepcopy(self.baseline)
        summary, candidates = self.gate()
        self.assertEqual(candidates, {"new": [{"id": 16}]})
        self.assertFalse(summary["approvedForLive"])
        self.assertEqual(self.baseline, original)
        self.assertEqual(summary["activeUniqueEdgeCount"], 1)

    def test_already_active_reference_never_replaced(self):
        self.baseline["mapping"] = {"new": [{"id": 8}]}
        summary, candidates = self.gate()
        self.assertEqual(candidates, {})
        self.assertEqual(summary["resultCounts"], {"already_active_reference": 1})

    def test_whole_overlap_denies_entire_path(self):
        self.audit["intervalCandidates"]["new"].append(interval(8))
        self.audit["mapping"]["new"].append({"id": 8})
        summary, candidates = self.gate()
        self.assertEqual(candidates, {})
        self.assertEqual(summary["resultCounts"], {"active_edge_overlap": 1})

    def test_partial_overlap_denies_even_other_disjoint_whole_edges(self):
        self.audit["intervalCandidates"]["new"].append(interval(8, .1, .2))
        summary, candidates = self.gate()
        self.assertEqual(candidates, {})
        self.assertEqual(summary["resultCounts"], {"active_edge_overlap": 1})

    def test_nonpassing_direction_cannot_be_activated(self):
        for verdict in ("lrp_bearing_mismatch", "offset_review_required", "unknown", None):
            self.direction["verdicts"]["new"] = verdict
            summary, candidates = self.gate()
            self.assertEqual(candidates, {})
            self.assertEqual(summary["resultCounts"], {"independent_direction_not_passed": 1})

    def test_no_whole_edge_is_not_promoted(self):
        self.audit["intervalCandidates"]["new"] = [interval(16, .1, .2)]
        self.audit["mapping"] = {}; self.audit["wholeEdgeCandidateReferenceCount"] = 0
        summary, candidates = self.gate()
        self.assertEqual(candidates, {})
        self.assertEqual(summary["resultCounts"], {"native_collision_or_no_whole_edge": 1})

    def test_foreign_partial_claim_blocks_candidate_even_if_rejected(self):
        self.audit["intervalCandidates"]["other"] = [interval(16, .1, .2)]
        self.audit["matchedIntervalReferenceCount"] = 2
        self.direction["verdicts"]["other"] = "offset_review_required"
        summary, candidates = self.gate()
        self.assertEqual(candidates, {})
        self.assertEqual(summary["resultCounts"]["recomputed_candidate_overlap"], 1)

    def test_wrong_graph_revision_or_direction_hash_is_rejected(self):
        cases = [(self.baseline, "routingDataset", "old"), (self.baseline, "staticRevision", "old"),
                 (self.direction, "graphSha256", "old"), (self.direction, "nativeAuditSha256", "old"),
                 (self.audit, "decoderVersion", "old"), (self.audit, "approvedForLive", True)]
        for target, key, value in cases:
            original = target[key]; target[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): self.gate()
            target[key] = original

    def test_missing_or_extra_verdict_rejected(self):
        for verdicts in ({}, {**self.direction["verdicts"], "foreign": "independent_geometry_direction_pass"}):
            self.direction["verdicts"] = verdicts
            with self.assertRaises(ValueError): self.gate()

    def test_bad_edge_interval_and_full_edge_evidence_rejected(self):
        for change in (lambda x: x["intervalCandidates"]["new"][0].update(edgeId=True),
                       lambda x: x["intervalCandidates"]["new"][0].update(edgeId=19),
                       lambda x: x["intervalCandidates"]["new"][0].update(beginFraction=float("nan")),
                       lambda x: x["intervalCandidates"]["new"][0].update(edgeLengthMeters=0),
                       lambda x: x["mapping"]["new"][0].update(id=24),
                       lambda x: x["mapping"]["new"][0].update(untrusted=True)):
            original = copy.deepcopy(self.audit); change(self.audit)
            with self.assertRaises(ValueError): self.gate()
            self.audit = original

    def test_private_artifact_is_exclusive_600_and_never_replaces_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "candidate.json.gz"
            review.directions.write_private(path, {"approvedForLive": False}, [])
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError): review.directions.write_private(path, {}, [])
            with self.assertRaises(ValueError): review.directions.write_private(path, {}, [path])
            with self.assertRaises(ValueError): review.directions.write_private(Path("/run/not-a-live-map.json.gz"), {}, [])


if __name__ == "__main__":
    unittest.main()
