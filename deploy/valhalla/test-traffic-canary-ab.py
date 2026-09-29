#!/usr/bin/env python3
"""Offline checks for the pilot-only traffic A/B helper."""

import importlib.util
import hashlib
from pathlib import Path
import tempfile
import time


spec = importlib.util.spec_from_file_location("traffic_canary_ab", Path(__file__).with_name("traffic-canary-ab.py"))
assert spec is not None and spec.loader is not None
canary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(canary)


def segment(message_id: str, frc: str = "3") -> dict:
    return {
        "messageId": message_id,
        "coordinates": [[14.42, 50.08], [14.45, 50.09]],
        "openlr": {"points": [{"bearing": 64, "frc": frc}, {"bearing": 192, "frc": frc}]},
    }


payload = canary.route_request(segment("one"))
assert payload is not None
assert payload["costing"] == "auto" and payload["date_time"] == {"type": 0}
assert payload["locations"][0]["heading"] == 90
assert payload["locations"][1]["heading"] == 90
assert canary.route_request({"openlr": {"points": []}, "coordinates": []}) is None
assert canary.route_request({**segment("bad"), "coordinates": [[float("nan"), 50], [14, 50]]}) is None

with tempfile.TemporaryDirectory() as directory:
    source = Path(directory) / "input"
    source.write_bytes(b"test")
    canary.verified_sha256(source, hashlib.sha256(b"test").hexdigest())
    try:
        canary.verified_sha256(source, "0" * 64)
    except RuntimeError:
        pass
    else:
        raise AssertionError("changed audit input must be rejected")


class TrafficStub:
    @staticmethod
    def parse_iso_timestamp(value: object) -> float | None:
        return float(value) if value is not None else None


now = time.time()
static = {"segments": [segment("a", "2"), segment("b", "2"), segment("c", "3"), segment("d", "4")]}
dynamic = {"flows": [
    {"messageId": item, "observedAt": now - 10, "validUntil": now + 600}
    for item in ("a", "b", "c", "d")
] + [{"messageId": "stale", "observedAt": now - 3600, "validUntil": now + 600}]}
audit = {"mapping": {item: [] for item in ("a", "b", "c", "d", "stale")}}
requests = canary.select_requests(static, dynamic, audit, TrafficStub())
assert len(requests) == 4

diagnostic_feed = {"flows": [
    {"messageId": "other", "averageSpeedKph": 40, "observedAt": now - 10},
    {"messageId": "a", "averageSpeedKph": 40, "observedAt": now - 10},
    {"messageId": "b", "averageSpeedKph": None, "observedAt": now - 10},
    {"messageId": "c", "averageSpeedKph": 35, "observedAt": now - 3600},
    {"messageId": "d", "averageSpeedKph": 30, "observedAt": now + 30},
    {"messageId": "e", "averageSpeedKph": 25, "observedAt": now - 10, "validUntil": now - 1},
    {"messageId": "f", "averageSpeedKph": 20},
    {"messageId": "g", "averageSpeedKph": 20, "observedAt": now - 10, "validUntil": now - 3600},
    {"messageId": "h", "averageSpeedKph": 20, "observedAt": now - 10, "validUntil": now - 600},
]}
diagnostics = canary.flow_diagnostics(
    diagnostic_feed, {"mapping": {item: [] for item in "abcdefgh"}}, TrafficStub(), 1800, now=now
)
assert diagnostics == {
    "totalFlowRecords": 9, "candidateIdRecords": 8,
    "candidateValidSpeedRecords": 7, "candidateFreshRecords": 1,
    "candidateInvalidSpeedRecords": 1, "candidateInvalidObservedAtRecords": 1,
    "candidateFutureRecords": 1, "candidateStaleRecords": 1,
    "candidateExpiredRecords": 3, "candidateExpiryBeforeObservationRecords": 2,
    "candidateExpiredWithin5MinutesRecords": 1,
    "candidateExpiredWithin30MinutesRecords": 1,
    "candidateExpiredOver30MinutesRecords": 1,
}

baseline = [
    {"time": 100, "length": 1.2, "shape": "one"},
    {"time": 200, "length": 2.0, "shape": "two"},
    None,
]
candidate = [
    {"time": 90, "length": 1.2, "shape": "one"},
    {"time": 215, "length": 2.1, "shape": "new-two"},
    {"time": 50, "length": 0.8, "shape": "three"},
]
result = canary.comparison(baseline, candidate)
assert result == {
    "requestedRouteCount": 3,
    "pairedRouteCount": 2,
    "baselineFailureCount": 1,
    "canaryFailureCount": 0,
    "changedEtaCount": 2,
    "changedGeometryCount": 1,
    "medianEtaDeltaSeconds": 2.5,
    "minEtaDeltaSeconds": -10,
    "maxEtaDeltaSeconds": 15,
}
print("Pilot traffic A/B helper tests passed.")
