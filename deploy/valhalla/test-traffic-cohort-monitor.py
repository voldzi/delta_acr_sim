#!/usr/bin/env python3
"""Offline, aggregate-only cohort monitor checks."""

import importlib.util
from pathlib import Path
import tempfile


spec = importlib.util.spec_from_file_location(
    "traffic_cohort_monitor", Path(__file__).with_name("traffic-cohort-monitor.py")
)
assert spec is not None and spec.loader is not None
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


class TrafficStub:
    @staticmethod
    def parse_iso_timestamp(value: object) -> float | None:
        try:
            return float(value) if value is not None else None
        except (TypeError, ValueError):
            return None


now = 10000.0
flows = [
    {"messageId": "candidate-a", "averageSpeedKph": 50, "observedAt": now - 50, "validUntil": now + 100},
    {"messageId": "candidate-a", "averageSpeedKph": 45, "observedAt": now - 40, "validUntil": now - 10},
    {"messageId": "candidate-b", "averageSpeedKph": 30, "observedAt": now - 50, "validUntil": now - 600},
    {"messageId": "candidate-c", "averageSpeedKph": 30, "observedAt": now - 50, "validUntil": now - 3600},
    {"messageId": "candidate-d", "averageSpeedKph": 0, "observedAt": now - 50},
    {"messageId": "candidate-e", "averageSpeedKph": 25, "observedAt": now - 4000},
    {"messageId": "candidate-f", "averageSpeedKph": 25, "observedAt": now + 5},
    {"messageId": "baseline-a", "averageSpeedKph": 70, "observedAt": now - 20, "validUntil": now + 60},
]
candidate = monitor.cohort_summary(
    flows, {"candidate-a", "candidate-b", "candidate-c", "candidate-d", "candidate-e", "candidate-f"},
    TrafficStub(), 1800, now,
)
assert candidate["recordCount"] == 7
assert candidate["uniqueMessageCount"] == 6
assert candidate["duplicateRecords"] == 1
assert candidate["validSpeedCount"] == 6
assert candidate["freshCount"] == 1
assert candidate["expiredCount"] == 3
assert candidate["expiredWithin5MinutesCount"] == 1
assert candidate["expiredWithin30MinutesCount"] == 1
assert candidate["expiredOver30MinutesCount"] == 1
assert candidate["expiryBeforeObservationCount"] == 2
assert candidate["invalidSpeedCount"] == 1
assert candidate["staleObservationCount"] == 1
assert candidate["futureObservationCount"] == 1
assert candidate["expiredAgeSecondsMedian"] == 600
assert candidate["freshRemainingSecondsMedian"] == 100
assert monitor.cohort_summary(flows, {"baseline-a"}, TrafficStub(), 1800, now)["freshCount"] == 1

with tempfile.TemporaryDirectory() as directory:
    monitor.REPORT = Path(directory) / "report.json"
    monitor.write_report({"samples": [{"candidate": candidate}]})
    report = monitor.REPORT.read_text(encoding="utf-8")
    assert "candidate-a" not in report
    assert '"freshCount":1' in report
    assert monitor.REPORT.stat().st_mode & 0o777 == 0o600

print("Aggregate traffic cohort monitor tests passed.")
