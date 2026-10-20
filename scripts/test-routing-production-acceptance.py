"""Synthetic-only acceptance summarizer checks; no HTTP, Docker or DB access."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import datetime

spec = importlib.util.spec_from_file_location("acceptance", Path(__file__).with_name("accept-routing-performance-production.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class AcceptanceTests(unittest.TestCase):
    def value(self, **updates):
        now = datetime.datetime.now(datetime.timezone.utc)
        traffic = {"state": "current", "status": "current", "routingDataset": module.DATASET,
                   "appliedFlowCount": 1, "appliedEdgeCount": 3,
                   "sourceObservedAt": (now - datetime.timedelta(minutes=2)).isoformat(),
                   "usableUntil": (now + datetime.timedelta(minutes=2)).isoformat()}
        traffic.update(updates)
        return {"coverage": {"routingDataset": {"version": module.DATASET}}, "traffic": {"liveSpeeds": traffic}}

    def test_fresh_speeds_require_actual_applied_counts_and_matching_graph(self):
        with patch.object(module, "request", return_value=(200, self.value())):
            self.assertTrue(module.fresh_speed()["verified"])

    def test_stale_zero_unmatched_future_or_invalid_speeds_fail(self):
        now = datetime.datetime.now(datetime.timezone.utc)
        cases = ({"state": "warming"}, {"appliedFlowCount": 0}, {"appliedEdgeCount": 0},
                 {"routingDataset": "other"}, {"usableUntil": (now - datetime.timedelta(seconds=1)).isoformat()},
                 {"sourceObservedAt": (now + datetime.timedelta(minutes=2)).isoformat()},
                 {"usableUntil": "invalid"}, {"usableUntil": "2026-10-20T12:00:00"})
        for case in cases:
            with self.subTest(case=case), patch.object(module, "request", return_value=(200, self.value(**case))):
                self.assertFalse(module.fresh_speed()["verified"])

    def test_mobile_requires_real_read_model_and_configured_resolution(self):
        value = {"features": [{"properties": {"readModel": True, "resolutionM": 1000, "stale": False}}], "warnings": []}
        with patch.object(module, "request", return_value=(200, value)) as request:
            rows = module.mobile()
        self.assertEqual(request.call_count, 3)
        self.assertEqual([x["technology"] for x in rows], ["2G", "4G", "5G"])
        self.assertTrue(all(x["readModel"] and x["resolution1000"] and not x["staleCount"] for x in rows))

    def test_summary_does_not_export_geometry_or_arbitrary_properties(self):
        value = {"routes": [{"status": "ok", "geometry": "synthetic-sensitive-fixture", "knownClosures": {"state": "applied"}}],
                 "coverage": {"routingDataset": {"version": module.DATASET}}}
        result = module.summarize(200, value, 12)
        self.assertNotIn("synthetic-sensitive-fixture", str(result))

if __name__ == "__main__": unittest.main()
