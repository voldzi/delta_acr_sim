#!/usr/bin/env python3
import copy
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("direction_review", Path(__file__).with_name("review-native-directions.py"))
review = importlib.util.module_from_spec(spec)
spec.loader.exec_module(review)
fixture_spec = importlib.util.spec_from_file_location("synthetic_corridor_fixtures", Path(__file__).with_name("test-prepare-openlr-native-corridors.py"))
fixture = importlib.util.module_from_spec(fixture_spec)
fixture_spec.loader.exec_module(fixture)


class DirectionReviewTests(unittest.TestCase):
    def setUp(self):
        self.segment = {"coordinates": [[14., 50.], [14.003, 50.]], "openlr": {"points": [{"bearing": 64}, {"bearing": 192}]}}
        self.intervals = [{"edgeId": 1, "beginFraction": 0., "endFraction": 1.}]
        self.shapes = {"1": [[14., 50.], [14.003, 50.]]}
        self.road = [[[14., 50.], [14.003, 50.]]]

    def test_correct_direction_and_corridor(self):
        self.assertEqual(review.review(self.segment, self.intervals, self.shapes, self.road), "independent_geometry_direction_pass")

    def test_reverse_direction_rejected(self):
        self.shapes["1"].reverse()
        self.assertEqual(review.review(self.segment, self.intervals, self.shapes, self.road), "lrp_bearing_mismatch")

    def test_wrong_order_rejected(self):
        self.segment["coordinates"].reverse()
        self.segment["openlr"]["points"] = [{"bearing": 64}, {"bearing": 192}]
        self.assertNotEqual(review.review(self.segment, self.intervals, self.shapes, self.road), "independent_geometry_direction_pass")

    def test_internal_divergence_not_hidden_by_endpoints(self):
        self.shapes["1"] = [[14., 50.], [14.001, 50.], [14.0015, 50.003], [14.002, 50.], [14.003, 50.]]
        self.assertEqual(review.review(self.segment, self.intervals, self.shapes, self.road), "tmc_corridor_divergence")

    def test_offsets_require_distinct_evidence(self):
        self.segment["openlr"]["positiveOffsetMeters"] = 30
        self.assertEqual(review.review(self.segment, self.intervals, self.shapes, self.road), "offset_review_required")

    def test_fractional_shape_clipped_in_directed_order(self):
        shape = review.clip_shape(self.shapes["1"], .25, .75)
        self.assertAlmostEqual(shape[0][0], 14.00075)
        self.assertAlmostEqual(shape[-1][0], 14.00225)
        self.assertLess(shape[0][0], shape[-1][0])

    def test_disconnected_intervals_rejected(self):
        self.intervals.append({"edgeId": 2, "beginFraction": 0., "endFraction": 1.})
        self.shapes["2"] = [[14.006, 50.], [14.007, 50.]]
        self.assertEqual(review.review(self.segment, self.intervals, self.shapes, self.road), "disconnected_geometry")

    def test_missing_and_nonfinite_geometry_fail(self):
        for shape in ([], [[14., float("nan")], [14.003, 50.]], [[14., 50.], [14., 50.]]):
            with self.subTest(shape=shape), self.assertRaises(ValueError):
                review.clip_shape(shape, 0, 1)

    def test_complete_private_review_pins_inputs_and_does_not_publish_verdict_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = {key: Path(directory) / (key + ".json.gz") for key in ("source", "audit", "shapes", "output")}
            table = Path(directory) / "tmc.zip"
            fixture.synthetic_tmc_zip(table)
            table_hash = hashlib.sha256(table.read_bytes()).hexdigest()
            segment = fixture.segment()
            audit = {"decoderVersion": "openlr-native-v2", "approvedForLive": False, "staticRevision": "a" * 64,
                     "graphSha256": "b" * 64, "routingDataset": "synthetic", "tmcSha256": table_hash,
                     "intervalCandidates": {segment["messageId"]: self.intervals},
                     "mapping": {segment["messageId"]: [{"id": 1}]},
                     "matchedIntervalReferenceCount": 1, "wholeEdgeCandidateReferenceCount": 1}
            for key, value in (("source", {"staticRevision": "a" * 64, "segments": [segment]}), ("audit", audit),
                               ("shapes", {"contractVersion": "sim-native-directed-shapes-v1", "graphSha256": "b" * 64,
                                           "shapes": self.shapes})):
                fixture.prepare.native.private_json(paths[key], value)
            args = argparse.Namespace(static_cache=paths["source"], audit=paths["audit"], shapes=paths["shapes"],
                                      tmc_zip=table, output=paths["output"])
            report = review.run(args)
            self.assertEqual(report["resultCounts"], {"independent_geometry_direction_pass": 1})
            self.assertEqual(report["nativeAuditSha256"], hashlib.sha256(paths["audit"].read_bytes()).hexdigest())
            self.assertNotIn(segment["messageId"], json.dumps(report))
            self.assertEqual(stat.S_IMODE(paths["output"].stat().st_mode), 0o600)
            self.assertEqual(review.read_private(paths["output"])["verdicts"],
                             {segment["messageId"]: "independent_geometry_direction_pass"})
            args.output = paths["source"]
            with self.assertRaises(ValueError): review.run(args)
            audit["graphSha256"] = "different"
            fixture.prepare.native.private_json(paths["audit"], audit)
            with self.assertRaisesRegex(ValueError, "identity mismatch"): review.run(args)


if __name__ == "__main__":
    unittest.main()
