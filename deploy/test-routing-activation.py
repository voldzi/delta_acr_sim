import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("activation", Path(__file__).with_name("activate-reviewed-routing-performance.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def fixture():
    return {"source": {"backend": "valhalla"}, "coverage": {"routingDataset": {"version": module.DATASET}},
            "routes": [{"status": "ok", "distanceM": 100, "durationSeconds": 10,
                        "knownClosures": {"state": "applied", "routingDataset": {"version": module.DATASET}, "engine": {"fallbackUsed": False}}}]}

class ActivationTests(unittest.TestCase):
    def test_guarded_route_accepted(self):
        self.assertTrue(module.valid_route(200, fixture()))

    def test_missing_closures_or_fallback_or_other_graph_rejected(self):
        for key, value in (("state", "unknown"), ("engine", {"fallbackUsed": True}), ("routingDataset", {"version": "other"})):
            item = fixture()
            item["routes"][0]["knownClosures"][key] = value
            self.assertFalse(module.valid_route(200, item))

    def test_four_real_fixtures_no_direct_provider(self):
        calls = [(200, fixture())] * 3 + [(422, {"error": {"code": "ROUTING_LOCATION_NOT_ROUTABLE"}})]
        with patch.object(module, "request_route", side_effect=calls) as request:
            result = module.accept_routes()
        self.assertTrue(result["verified"])
        self.assertEqual(request.call_count, 4)
        self.assertTrue(result["freshSpeedsAcceptancePending"])

    def test_provider_limit_is_not_accepted_or_retried(self):
        with patch.object(module, "request_route", return_value=(429, {"error": {"code": "LIMIT"}})) as request:
            with self.assertRaises(RuntimeError): module.accept_routes()
            self.assertEqual(request.call_count, 1)

    def test_normal_warmup_never_accepts_503(self):
        calls = [(503, {"error": {"code": "ROUTING_KNOWN_CLOSURES_UNAVAILABLE"}})] + [(200, fixture())] * 3 + [(422, {"error": {"code": "ROUTING_LOCATION_NOT_ROUTABLE"}})]
        with patch.object(module, "request_route", side_effect=calls), patch.object(module.time, "sleep") as sleep, patch("builtins.print"):
            self.assertTrue(module.accept_routes()["verified"])
            sleep.assert_called_once()

    def test_wrong_unroutable_result_blocks_activation(self):
        with patch.object(module, "request_route", side_effect=[(200, fixture())] * 4):
            with self.assertRaisesRegex(RuntimeError, "Unroutable fixture"):
                module.accept_routes()

if __name__ == "__main__": unittest.main()
