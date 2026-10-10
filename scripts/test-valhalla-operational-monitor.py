#!/usr/bin/env python3
"""Hermetic Valhalla monitor tests: no SSH, network, provider or notifications."""

import json
import unittest
from datetime import datetime, timedelta, timezone

from valhalla_operational_monitor import evaluate_valhalla_snapshot


NOW = datetime(2026, 10, 10, 19, 0, tzinfo=timezone.utc)
SECRET = "DO_NOT_OUTPUT_THIS_PRIVATE_VALUE"
ACTIVE_ID = "20261003T010000Z"
NEXT_ID = "20261010T174115Z"


def iso(value):
    return value.isoformat().replace("+00:00", "Z")


def fixture(age_days=7, *, activation=None, graph=None, status="success", phase="complete",
            service_state="inactive", service_result="success", start=None, updated=None,
            available="36G", timer_state="active", unit_file_state=None):
    graph = graph or NOW - timedelta(days=age_days)
    activation = activation or graph + timedelta(minutes=2)
    start = start or graph - timedelta(hours=2)
    updated = updated or activation
    unit_state = f"UnitFileState={unit_file_state}\n" if unit_file_state else ""
    attempt_id = NEXT_ID if status == "running" else ACTIVE_ID
    return f"""ActiveState={service_state}
SubState={'start' if service_state == 'activating' else 'dead'}
Result={service_result}
ExecMainStatus={1 if service_result == 'exit-code' else 0}
ActiveState={timer_state}
{unit_state}NextElapseUSecRealtime=Sun 2026-10-11 00:15:54 UTC
ActiveState=inactive
Result=success
ExecMainStatus=0
ActiveState=active
NextElapseUSecRealtime=Sat 2026-10-10 19:01:00 UTC
ActiveState=inactive
Result=success
ExecMainStatus=0

last-attempt.env
RELEASE_ID={attempt_id}
STATUS={status}
PHASE={phase}
STARTED_AT={iso(start)}
UPDATED_AT={iso(updated)}
MODE=run
DETAIL=https://private.example.invalid/?token={SECRET}

last-success.env
RELEASE_ID={ACTIVE_ID}
TARGET=/srv/valhalla/releases/{ACTIVE_ID}/custom_files
PREVIOUS_TARGET=/srv/valhalla/releases/20260929T081714Z/custom_files
ACTIVATED_AT={iso(activation)}

current
/srv/valhalla/releases/{ACTIVE_ID}/custom_files

releases
20260929T081714Z
{ACTIVE_ID}

disk
Filesystem                         Size  Used Avail Use% Mounted on
/dev/mapper/ubuntu--vg-ubuntu--lv     61G   23G {available} 39% /

valhalla-status
curl: (7) Failed to connect to 127.0.0.1 port 8002: {SECRET}
{json.dumps({'version': '3.8.3', 'tileset_last_modified': int(graph.timestamp()), 'ignoredSecret': SECRET})}

traffic-runtime
private-artifact.json {SECRET}

traffic-cache
secret-file-name-{SECRET}.json
"""


def codes(report):
    return {item["code"] for item in report["failures"]}


class ValhallaOperationalMonitorTest(unittest.TestCase):
    def evaluate(self, raw=None, **kwargs):
        return evaluate_valhalla_snapshot(fixture() if raw is None else raw, now=NOW, **kwargs)

    def test_fresh_seven_day_graph_is_ok_and_oneshot_inactive_is_normal(self):
        report = self.evaluate()
        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["severity"], "info")
        self.assertEqual(report["failures"], [])
        self.assertEqual(report["details"]["freshnessAgeSeconds"], 7 * 86400)
        self.assertEqual(report["details"]["activeReleaseId"], ACTIVE_ID)
        self.assertEqual(report["details"]["weeklyTimer"]["nextRunAt"], "2026-10-11T00:15:54Z")

    def test_eight_days_warns_and_nine_days_is_critical_before_ten_day_guard(self):
        warning = self.evaluate(fixture(8))
        self.assertEqual(warning["status"], "failed")
        self.assertEqual(warning["severity"], "warning")
        self.assertEqual(codes(warning), {"VALHALLA_MAP_AGE_WARNING"})
        critical = self.evaluate(fixture(9))
        self.assertEqual(critical["severity"], "critical")
        self.assertEqual(codes(critical), {"VALHALLA_MAP_AGE_CRITICAL"})

    def test_boundary_is_not_rounded_up(self):
        report = self.evaluate(fixture(graph=NOW - timedelta(days=8) + timedelta(seconds=1)))
        self.assertNotIn("VALHALLA_MAP_AGE_WARNING", codes(report))

    def test_activation_does_not_mask_old_graph(self):
        report = self.evaluate(fixture(9, activation=NOW - timedelta(minutes=1)))
        self.assertEqual(report["details"]["freshnessAgeSeconds"], 9 * 86400)
        self.assertIn("VALHALLA_MAP_AGE_CRITICAL", codes(report))

    def test_independent_api_date_uses_oldest_freshness(self):
        report = self.evaluate(graph_built_at=iso(NOW - timedelta(days=9)))
        self.assertEqual(report["details"]["freshnessAgeSeconds"], 9 * 86400)
        self.assertIn("VALHALLA_MAP_AGE_CRITICAL", codes(report))

    def test_failed_attempt_and_failed_service_alert_immediately(self):
        report = self.evaluate(fixture(1, status="failed", phase="downloading", service_state="failed", service_result="exit-code"))
        self.assertIn("VALHALLA_WEEKLY_ATTEMPT_FAILED", codes(report))
        self.assertIn("VALHALLA_WEEKLY_UPDATE_FAILED", codes(report))
        self.assertNotIn("VALHALLA_MAP_AGE_WARNING", codes(report))

    def test_new_running_attempt_does_not_realert_old_service_result(self):
        report = self.evaluate(fixture(status="running", phase="downloading", service_state="activating",
                                      service_result="exit-code", start=NOW - timedelta(hours=1), updated=NOW - timedelta(minutes=3)))
        self.assertEqual(report["status"], "ok")
        self.assertNotIn("VALHALLA_WEEKLY_UPDATE_FAILED", codes(report))
        self.assertNotIn("VALHALLA_WEEKLY_ATTEMPT_FAILED", codes(report))

    def test_overlong_build_is_independent_of_other_failures(self):
        raw = fixture(status="running", phase="tiles", service_state="activating", service_result="exit-code",
                      start=NOW - timedelta(hours=6), updated=NOW - timedelta(minutes=1))
        report = self.evaluate(raw)
        self.assertIn("VALHALLA_BUILD_OVERRUN", codes(report))
        self.assertNotIn("VALHALLA_WEEKLY_UPDATE_FAILED", codes(report))
        failed = self.evaluate(raw.replace("ActiveState=activating", "ActiveState=failed", 1))
        self.assertIn("VALHALLA_BUILD_OVERRUN", codes(failed))
        self.assertIn("VALHALLA_WEEKLY_UPDATE_FAILED", codes(failed))

    def test_runtime_disk_minimum_is_ten_gib_not_thirty_five_during_build(self):
        raw = fixture(status="running", phase="merging", service_state="activating", available="12G",
                      start=NOW - timedelta(hours=1), updated=NOW - timedelta(minutes=2))
        self.assertEqual(self.evaluate(raw)["status"], "ok")
        self.assertIn("VALHALLA_RUNTIME_DISK_LOW", codes(self.evaluate(raw.replace("12G", "9.9G"))))
        self.assertIn("VALHALLA_RUNTIME_DISK_LOW", codes(self.evaluate(raw.replace("12G", "900M"))))
        self.assertEqual(self.evaluate(raw.replace("12G", "1.2T"))["status"], "ok")

    def test_disabled_inactive_and_unscheduled_timer_fail(self):
        self.assertIn("VALHALLA_WEEKLY_TIMER_DISABLED", codes(self.evaluate(fixture(unit_file_state="disabled"))))
        self.assertIn("VALHALLA_WEEKLY_TIMER_INACTIVE", codes(self.evaluate(fixture(timer_state="inactive"))))
        no_slot = fixture().replace("NextElapseUSecRealtime=Sun 2026-10-11 00:15:54 UTC", "NextElapseUSecRealtime=")
        self.assertIn("VALHALLA_WEEKLY_TIMER_UNSCHEDULED", codes(self.evaluate(no_slot)))

    def test_missing_or_invalid_exit_status_cannot_look_healthy(self):
        for replacement in ("", SECRET, "999"):
            raw = fixture().replace("ExecMainStatus=0", f"ExecMainStatus={replacement}", 1)
            report = self.evaluate(raw)
            self.assertIn("VALHALLA_WEEKLY_SERVICE_INVALID", codes(report))
            self.assertNotIn(SECRET, json.dumps(report))
        raw = fixture().replace("ExecMainStatus=0", "ExecMainStatus=1", 1)
        self.assertIn("VALHALLA_WEEKLY_UPDATE_FAILED", codes(self.evaluate(raw)))

    def test_missing_success_current_and_graph_fail_closed(self):
        raw = fixture().replace("last-success.env", "unknown-section")
        self.assertIn("VALHALLA_SUCCESS_MISSING", codes(self.evaluate(raw)))
        raw = fixture().replace(f"/srv/valhalla/releases/{ACTIVE_ID}/custom_files", "/arbitrary/private/location")
        self.assertIn("VALHALLA_RELEASE_BINDING_INVALID", codes(self.evaluate(raw)))
        raw = fixture().replace('"tileset_last_modified":', '"untrusted_timestamp":')
        self.assertIn("VALHALLA_GRAPH_METADATA_INVALID", codes(self.evaluate(raw)))

    def test_release_binding_mismatch(self):
        raw = fixture().replace(f"current\n/srv/valhalla/releases/{ACTIVE_ID}/custom_files",
                                f"current\n/srv/valhalla/releases/{NEXT_ID}/custom_files")
        self.assertIn("VALHALLA_RELEASE_MISMATCH", codes(self.evaluate(raw)))

    def test_invalid_and_future_timestamps_are_not_accepted(self):
        raw = fixture().replace("ACTIVATED_AT=2026-10-03T19:02:00Z", "ACTIVATED_AT=2026-10-03T19:02:00")
        self.assertIn("VALHALLA_SUCCESS_TIME_INVALID", codes(self.evaluate(raw)))
        raw = fixture(1, activation=NOW + timedelta(seconds=31), updated=NOW - timedelta(seconds=1))
        self.assertIn("VALHALLA_SUCCESS_TIME_INVALID", codes(self.evaluate(raw)))
        raw = fixture(graph=NOW + timedelta(seconds=31), activation=NOW - timedelta(seconds=1),
                      start=NOW - timedelta(hours=1), updated=NOW - timedelta(seconds=1))
        self.assertIn("VALHALLA_GRAPH_TIME_FUTURE", codes(self.evaluate(raw)))
        raw = fixture(start=NOW + timedelta(seconds=31))
        self.assertIn("VALHALLA_ATTEMPT_TIME_INVALID", codes(self.evaluate(raw)))
        self.assertIn("VALHALLA_GRAPH_METADATA_INVALID", codes(self.evaluate(graph_built_at="not-a-time")))

    def test_cached_snapshot_age_missing_and_future(self):
        self.assertEqual(self.evaluate({"statusText": fixture(), "generatedAt": iso(NOW - timedelta(seconds=900))})["status"], "ok")
        old = self.evaluate({"statusText": fixture(), "generatedAt": iso(NOW - timedelta(seconds=901))})
        self.assertIn("VALHALLA_SNAPSHOT_STALE", codes(old))
        missing = self.evaluate({"statusText": fixture(), "ignoredSecret": SECRET})
        self.assertIn("VALHALLA_SNAPSHOT_TIME_INVALID", codes(missing))
        future = self.evaluate({"statusText": fixture(), "generatedAt": iso(NOW + timedelta(seconds=31))})
        self.assertIn("VALHALLA_SNAPSHOT_TIME_INVALID", codes(future))

    def test_error_fingerprint_is_stable_as_age_and_raw_details_change(self):
        first = self.evaluate(fixture(8))
        second = evaluate_valhalla_snapshot(fixture(8).replace(SECRET, "DIFFERENT_PRIVATE_VALUE"), now=NOW + timedelta(minutes=5))
        self.assertEqual(first["failures"], second["failures"])
        self.assertNotEqual(first["details"]["freshnessAgeSeconds"], second["details"]["freshnessAgeSeconds"])
        failed_first = self.evaluate(fixture(1, status="failed", phase="downloading"))
        failed_second = self.evaluate(fixture(1, status="failed", phase="downloading").replace(SECRET, "OTHER_DETAIL"))
        self.assertEqual(failed_first["failures"], failed_second["failures"])

    def test_raw_details_paths_feed_records_and_secrets_never_propagate(self):
        report = self.evaluate({"statusText": fixture(), "generatedAt": iso(NOW), "secret": SECRET})
        rendered = json.dumps(report)
        self.assertNotIn(SECRET, rendered)
        self.assertNotIn("private.example", rendered)
        self.assertNotIn("DETAIL", rendered)
        self.assertNotIn("traffic-cache", rendered)
        self.assertNotIn("/srv/valhalla/releases", rendered)
        poisoned = fixture().replace("Result=success", f"Result={SECRET}", 1)
        report = self.evaluate(poisoned)
        self.assertNotIn(SECRET, json.dumps(report))
        self.assertIn("VALHALLA_WEEKLY_SERVICE_INVALID", codes(report))

    def test_missing_malformed_oversized_and_invalid_utf8_snapshot(self):
        for raw in (None, [], {}, "", 123, b"\xff"):
            self.assertEqual(evaluate_valhalla_snapshot(raw, now=NOW)["status"], "failed")
        large = self.evaluate((SECRET * 5000).encode())
        self.assertEqual(codes(large), {"VALHALLA_SNAPSHOT_TOO_LARGE"})

    def test_unknown_phase_and_invalid_release_calendar_are_not_exposed(self):
        report = self.evaluate(fixture(phase=SECRET).replace(ACTIVE_ID, "20261340T290000Z"))
        self.assertIn("VALHALLA_ATTEMPT_INVALID", codes(report))
        self.assertIn("VALHALLA_SUCCESS_MISSING", codes(report))
        self.assertNotIn(SECRET, json.dumps(report))

    def test_failed_healthcheck_is_critical_and_live_state_does_not_hide_it(self):
        raw = fixture().replace("ActiveState=inactive\nResult=success\nExecMainStatus=0", "ActiveState=failed\nResult=exit-code\nExecMainStatus=1", 1)
        report = self.evaluate(raw)
        self.assertIn("VALHALLA_HEALTHCHECK_FAILED", codes(report))
        self.assertEqual(report["severity"], "critical")

    def test_epoch_and_offset_aware_now_supported_naive_clock_rejected(self):
        self.assertEqual(evaluate_valhalla_snapshot(fixture(), now=NOW.timestamp())["status"], "ok")
        offset = NOW.astimezone(timezone(timedelta(hours=2)))
        self.assertEqual(evaluate_valhalla_snapshot(fixture(), now=offset)["status"], "ok")
        self.assertEqual(codes(evaluate_valhalla_snapshot(fixture(), now=NOW.replace(tzinfo=None))), {"VALHALLA_CLOCK_INVALID"})

    def test_configurable_thresholds_must_be_finite_positive_and_ordered(self):
        for kwargs in ({"warn_age_seconds": -1}, {"critical_age_seconds": 1}, {"build_max_age_seconds": float("nan")}, {"snapshot_max_age_seconds": 0}):
            self.assertIn("VALHALLA_SNAPSHOT_INVALID", codes(self.evaluate(**kwargs)))


if __name__ == "__main__":
    unittest.main()
