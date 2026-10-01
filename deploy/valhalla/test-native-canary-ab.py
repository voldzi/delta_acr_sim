#!/usr/bin/env python3
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("pilot", Path(__file__).with_name("native-canary-ab.py"))
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


class PilotTests(unittest.TestCase):
    def setUp(self):
        self.baseline = {"contractVersion": "valhalla-openlr-edge-map-v2", "matcherVersion": "openlr-trace-v2",
            "routingDataset": pilot.DATASET, "staticRevision": pilot.STATIC, "mappedSegmentCount": 35639,
            "mapping": {f"b{i}": [{"id": i << 25}] for i in range(35639)}}
        self.candidate = {"contractVersion": "sim-native-baseline-review-v1", "approvedForLive": False,
            "routingDataset": pilot.DATASET, "staticRevision": pilot.STATIC, "graphSha256": pilot.GRAPH,
            "baselineSha256": pilot.BASELINE, "isolatedCandidateReferenceCount": 427,
            "isolatedCandidateEdgeCount": 2870, "mapping": {}}
        n = 40000
        for i in range(427):
            count = 6 if i < 119 else 7
            self.candidate["mapping"][f"c{i}"] = [{"id": j << 25} for j in range(n, n + count)]
            n += count
        self.static = {"staticRevision": pilot.STATIC}
        self.feed = {"contractVersion": "sim-valhalla-live-traffic-feed-v1", "staticRevision": pilot.STATIC,
                     "flows": [], "maxAgeSeconds": 1800}

    def validate(self):
        return pilot.validate(self.candidate, self.baseline, self.static, self.feed, pilot.BASELINE)

    def test_disjoint_whole_edges(self):
        self.assertEqual(len(self.validate()), 2870)

    def test_all_identity_changes_rejected(self):
        for key in ("contractVersion", "routingDataset", "graphSha256", "staticRevision", "baselineSha256"):
            value = self.candidate[key]
            self.candidate[key] = "wrong"
            with self.assertRaises(ValueError): self.validate()
            self.candidate[key] = value
        self.candidate["approvedForLive"] = True
        with self.assertRaises(ValueError): self.validate()

    def test_existing_ownership_rejected(self):
        self.candidate["mapping"]["c0"][0] = {"id": 0}
        with self.assertRaises(ValueError): self.validate()

    def test_cross_candidate_overlap_rejected(self):
        self.candidate["mapping"]["c1"][0] = copy.deepcopy(self.candidate["mapping"]["c0"][0])
        with self.assertRaises(ValueError): self.validate()

    def test_partial_boolean_unsupported_edge_rejected(self):
        for invalid in ({"id": True}, {"id": 3}, {"id": 2**46}, {"id": 0, "beginFraction": .5}):
            self.candidate["mapping"]["c0"][0] = invalid
            with self.assertRaises(ValueError): self.validate()

    def test_request_reversal_and_clock(self):
        segment = {"coordinates": [[14., 50.], [14.1, 50.1]],
                   "openlr": {"points": [{"bearing": 0}, {"bearing": 128}]}}
        forward = pilot.request(segment, "2026-10-01T21:00")
        reverse = pilot.request(segment, "2026-10-01T21:00", reverse=True)
        self.assertEqual(forward["date_time"], reverse["date_time"])
        self.assertEqual(reverse["locations"][0]["heading"], 180)
        self.assertEqual(reverse["locations"][0]["lon"], 14.1)

    def test_unavailable_is_not_a_pass(self):
        self.assertEqual(pilot.compare({"status": "unavailable"}, {"status": "unavailable"}), {"paired": False})

    def test_route_comparison(self):
        result = {"status": "ok", "seconds": 100., "shapeSha256": "same", "newEdgeCount": 1}
        pair = pilot.compare(result, {**result, "seconds": 120.})
        self.assertEqual(pair["deltaSeconds"], 20.)
        self.assertFalse(pair["shapeChanged"])

    def test_neighbour_edge_is_not_target_evidence(self):
        class Actor:
            def route(self, payload):
                return {"trip": {"summary": {"time": 100., "length": 1.}, "legs": [{"shape": "synthetic"}]}}
            def trace_attributes(self, payload):
                return {"edges": [{"id": 8}, {"id": 16}]}
        result = pilot.measure(Actor(), {"costing": "auto", "date_time": {"type": 1, "value": "2026-10-01T21:00"}}, {8}, {24})
        self.assertEqual(result["newEdgeCount"], 1)
        self.assertEqual(result["targetEdgeCount"], 0)


if __name__ == "__main__": unittest.main()
