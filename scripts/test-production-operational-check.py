#!/usr/bin/env python3
"""Local-only regression tests; no SSH, HTTP, providers, or real mounts."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
import unittest
from unittest import mock


DIRECTORY = Path(__file__).resolve().parent


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, DIRECTORY / filename)
    if spec is None or spec.loader is None:
        raise AssertionError("Test module cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


monitor = load_module("valhalla_operational_monitor", "valhalla_operational_monitor.py")
checker = load_module("production_operational_check_test_subject", "production-operational-check.py")
PRIVATE = "SYNTHETIC_RAW_DETAIL_TOKEN_NEVER_FOR_REPORT"
PROVIDER_URL = f"https://partner.invalid/private-feed?token={PRIVATE}"
NOW = 2_000_000.0


def iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def snapshot(*, failed: bool = False) -> tuple[bytes, str]:
    graph = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(days=1)
    started = graph - timedelta(seconds=60)
    activated = graph + timedelta(seconds=60)
    release = graph.strftime("%Y%m%dT%H%M%SZ")
    target = f"/srv/valhalla/releases/{release}/custom_files"
    text = f"""ActiveState={'failed' if failed else 'inactive'}
SubState={'failed' if failed else 'dead'}
Result={'exit-code' if failed else 'success'}
ExecMainStatus={'1' if failed else '0'}
ActiveState=active
SubState=waiting
UnitFileState=enabled
NextElapseUSecRealtime={iso(graph + timedelta(days=2))}
ActiveState=inactive
SubState=dead
Result=success
ExecMainStatus=0
last-attempt.env
RELEASE_ID={release}
STATUS={'failed' if failed else 'success'}
PHASE={'preparing' if failed else 'complete'}
STARTED_AT={iso(started)}
UPDATED_AT={iso(activated)}
DETAIL={PRIVATE} {PROVIDER_URL}
last-success.env
RELEASE_ID={release}
TARGET={target}
ACTIVATED_AT={iso(activated)}
current
{target}
releases
{release}
disk
Filesystem Size Used Avail Use% Mounted on
/dev/synthetic 64G 20G 44G 32% /
valhalla-status
{{"version":"3.8.3","tileset_last_modified":{int(graph.timestamp())},"ignored":"{PRIVATE}"}}
traffic-runtime
TOKEN={PRIVATE}
URL={PROVIDER_URL}
traffic-cache
SECRET={PRIVATE}
"""
    return text.encode("utf-8"), iso(graph)


def failure_report(status: str = "failed") -> dict:
    failures = [{"check": "valhallaUpdates", "error": "VALHALLA_WEEKLY_ATTEMPT_FAILED: The last update failed."}] if status == "failed" else []
    return {"status": status, "host": "synthetic-host", "summary": "Valhalla update failed" if failures else "all operational checks passed",
            "startedAt": "2026-10-10T08:00:00Z", "finishedAt": "2026-10-10T08:00:01Z", "failures": failures}


class GeneralReportRedactionTests(unittest.TestCase):
    def test_invalid_provider_json_does_not_copy_the_response_body(self):
        for body in [f'not-json {PRIVATE}'.encode(), bytes([0xff, 0xfe])]:
            client = checker.Client('http://synthetic.invalid', 1)
            response = checker.Response('http://synthetic.invalid/health', 200, body, 1)
            with mock.patch.object(client, 'request', return_value=response):
                with self.assertRaises(checker.OperationalCheckError) as result:
                    client.json('/health')
                self.assertNotIn(PRIVATE, str(result.exception))
                self.assertEqual(str(result.exception), 'Provider returned invalid JSON')

    def test_all_known_and_unknown_check_errors_are_fixed_not_exception_text(self):
        for name in [*checker.CHECK_FAILURE_MESSAGES, 'syntheticUnknown']:
            def fail():
                raise RuntimeError(f'{PRIVATE} {PROVIDER_URL}')
            result = checker.run_named_check(name, fail)
            self.assertEqual(result['status'], 'failed')
            self.assertNotIn(PRIVATE, json.dumps(result))
            self.assertNotIn(PROVIDER_URL, json.dumps(result))
            self.assertTrue(result['error'].startswith('OPERATIONAL_'))

    def test_smoke_failure_does_not_publish_stdout_or_stderr(self):
        completed = subprocess.CompletedProcess(['python3'], 1, PRIVATE, PROVIDER_URL)
        with mock.patch.object(checker.subprocess, 'run', return_value=completed):
            with self.assertRaises(checker.OperationalCheckError) as result:
                checker.run_command('synthetic smoke', ['python3'], 1)
        self.assertNotIn(PRIVATE, str(result.exception))
        self.assertNotIn(PROVIDER_URL, str(result.exception))
        self.assertIn('exit code 1', str(result.exception))

    def test_smoke_success_publishes_metadata_not_raw_output(self):
        completed = subprocess.CompletedProcess(['python3'], 0, PRIVATE, PROVIDER_URL)
        with mock.patch.object(checker.subprocess, 'run', return_value=completed):
            result = checker.run_command('synthetic smoke', ['python3'], 1)
        self.assertEqual(result['exitCode'], 0)
        self.assertNotIn('stdoutPreview', result)
        self.assertNotIn(PRIVATE, json.dumps(result))
        self.assertNotIn(PROVIDER_URL, json.dumps(result))


class AtomicPublicationTests(unittest.TestCase):
    def test_write_is_atomic_and_leaves_no_temporary_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "reports/latest.json"
            checker.write_json(target, {"version": "old"})
            real_replace = os.replace
            observed = []

            def check_replace(source, destination):
                self.assertEqual(json.loads(target.read_text()), {"version": "old"})
                self.assertEqual(json.loads(Path(source).read_text()), {"version": "new", "nested": {"count": 3}})
                self.assertEqual(Path(destination), target)
                observed.append(source)
                return real_replace(source, destination)

            with mock.patch.object(checker.os, "replace", side_effect=check_replace):
                checker.write_json(target, {"version": "new", "nested": {"count": 3}})
            self.assertEqual(len(observed), 1)
            self.assertEqual(json.loads(target.read_text()), {"version": "new", "nested": {"count": 3}})
            self.assertEqual(list(target.parent.glob(".operational-*")), [])
            self.assertEqual(target.stat().st_mode & 0o777, 0o644)

    def test_serialization_or_replace_failure_preserves_previous_report_and_cleans_temporary_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "latest.json"
            checker.write_json(target, {"complete": True})
            before = target.read_bytes()
            with self.assertRaises(TypeError):
                checker.write_json(target, {"partial": [1, object()]})
            self.assertEqual(target.read_bytes(), before)
            self.assertEqual(list(target.parent.glob(".operational-*")), [])
            with mock.patch.object(checker.os, "replace", side_effect=OSError(PRIVATE)):
                with self.assertRaises(OSError):
                    checker.write_json(target, {"new": True})
            self.assertEqual(target.read_bytes(), before)
            self.assertEqual(list(target.parent.glob(".operational-*")), [])

    def test_missing_or_wrong_x5_mount_stops_before_mkdir_or_file_creation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = (Path(temporary) / "x5").resolve()
            target = root / "data/csm-sim/latest.json"
            for result in [subprocess.CompletedProcess([], 1, "", PRIVATE),
                           subprocess.CompletedProcess([], 0, "wrong-device-uuid\n", PRIVATE)]:
                with self.subTest(returncode=result.returncode), mock.patch.object(checker, "X5_ROOT", root), \
                        mock.patch.object(checker.subprocess, "run", return_value=result) as run, \
                        mock.patch.object(Path, "mkdir") as mkdir:
                    with self.assertRaises(checker.OperationalCheckError) as raised:
                        checker.write_json(target, {"status": "ok"})
                    self.assertIn("X5_MOUNT_UNAVAILABLE", str(raised.exception))
                    self.assertNotIn(PRIVATE, str(raised.exception))
                    mkdir.assert_not_called()
                    self.assertEqual(run.call_args.args[0], ["findmnt", "-n", "-o", "UUID", "--mountpoint", str(root)])
                    self.assertFalse(root.exists())

    def test_mount_timeout_or_missing_findmnt_also_stops_before_mkdir(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = (Path(temporary) / "x5").resolve()
            for error in [OSError(PRIVATE), subprocess.TimeoutExpired("findmnt", 5, output=PRIVATE)]:
                with self.subTest(error=type(error).__name__), mock.patch.object(checker, "X5_ROOT", root), \
                        mock.patch.object(checker.subprocess, "run", side_effect=error), mock.patch.object(Path, "mkdir") as mkdir:
                    with self.assertRaises(checker.OperationalCheckError):
                        checker.write_json(root / "cache/latest.json", {"status": "ok"})
                    mkdir.assert_not_called()
                    self.assertFalse(root.exists())

    def test_correct_x5_uuid_allows_atomic_publication(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = (Path(temporary) / "x5").resolve()
            target = root / "data/csm-sim/latest.json"
            result = subprocess.CompletedProcess([], 0, checker.X5_UUID + "\n", "")
            with mock.patch.object(checker, "X5_ROOT", root), mock.patch.object(checker.subprocess, "run", return_value=result) as run:
                checker.write_json(target, {"status": "ok"})
            self.assertTrue(run.called)
            self.assertEqual(json.loads(target.read_text()), {"status": "ok"})


class ValhallaCheckTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.key = Path(self.temporary.name) / "synthetic-monitor-key"
        self.key.write_text("not-a-real-private-key\n")
        self.key.chmod(0o600)
        self.args = argparse.Namespace(valhalla_monitor_key=self.key)

    def client(self, graph_time: str | None):
        client = mock.Mock()
        dataset = {"builtAt": graph_time} if graph_time is not None else {}
        client.json.return_value = ({"routing": {"routingDataset": dataset}}, checker.Response("http://127.0.0.1/health", 200, b"{}", 1))
        return client

    def popen(self, raw: bytes, *, returncode: int = 0, timeout: bool = False):
        process = mock.Mock(returncode=returncode)
        process.wait.side_effect = [subprocess.TimeoutExpired("ssh", 15), 0] if timeout else None

        def open_process(command, *, stdout, stderr):
            self.assertEqual(command[-1], "status")
            self.assertIn("BatchMode=yes", command)
            self.assertIn("StrictHostKeyChecking=yes", command)
            self.assertEqual(stderr, subprocess.DEVNULL)
            stdout.write(raw)
            return process

        return process, open_process

    def assert_private(self, value):
        serialized = json.dumps(value, ensure_ascii=False)
        self.assertNotIn(PRIVATE, serialized)
        self.assertNotIn(PROVIDER_URL, serialized)
        self.assertNotIn(str(self.key), serialized)

    def test_valid_snapshot_passes_real_evaluator_and_only_status_and_freshness_health_are_requested(self):
        raw, graph_time = snapshot()
        process, popen = self.popen(raw)
        client = self.client(graph_time)
        with mock.patch.object(checker.subprocess, "Popen", side_effect=popen):
            result = checker.check_valhalla_monitor(client, self.args)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["severity"], "info")
        self.assertEqual(result["details"]["engineVersion"], "3.8.3")
        self.assertEqual(result["failures"], [])
        self.assert_private(result)
        client.json.assert_called_once_with("/situation-data/health/ready")
        process.wait.assert_called_once_with(timeout=15)

    def test_failed_update_has_only_stable_generic_errors_not_detail_or_partner_output(self):
        raw, graph_time = snapshot(failed=True)
        _, popen = self.popen(raw)
        with mock.patch.object(checker.subprocess, "Popen", side_effect=popen):
            result = checker.check_valhalla_monitor(self.client(graph_time), self.args)
        self.assertEqual(result["status"], "failed")
        self.assertIn("VALHALLA_WEEKLY_ATTEMPT_FAILED", result["error"])
        self.assert_private(result)

    def test_missing_or_world_readable_key_never_starts_ssh(self):
        for missing in [False, True]:
            if missing:
                self.key.unlink()
            else:
                self.key.chmod(0o644)
            with self.subTest(missing=missing), mock.patch.object(checker.subprocess, "Popen") as popen:
                result = checker.check_valhalla_monitor(self.client(None), self.args)
            self.assertEqual(result["status"], "failed")
            self.assertIn("VALHALLA_MONITOR_UNAVAILABLE", result["error"])
            popen.assert_not_called()
            self.assert_private(result)

    def test_missing_freshness_health_timestamp_or_health_failure_is_not_accepted(self):
        raw, _ = snapshot()
        for health_failure in [False, True]:
            client = self.client(None)
            if health_failure:
                client.json.side_effect = checker.OperationalCheckError(PROVIDER_URL)
            _, popen = self.popen(raw)
            with self.subTest(health_failure=health_failure), mock.patch.object(checker.subprocess, "Popen", side_effect=popen):
                result = checker.check_valhalla_monitor(client, self.args)
            self.assertEqual(result["status"], "failed")
            self.assertIn("VALHALLA_MONITOR_UNAVAILABLE", result["error"])
            self.assert_private(result)

    def test_ssh_failure_timeout_oversize_and_invalid_encoding_are_safely_generic(self):
        _, graph_time = snapshot()
        variants = [(PRIVATE.encode(), 1, False), (PRIVATE.encode(), 0, True), (b"x" * 65537, 0, False), (b"\xff" + PRIVATE.encode(), 0, False)]
        for raw, code, timed_out in variants:
            process, popen = self.popen(raw, returncode=code, timeout=timed_out)
            with self.subTest(code=code, timeout=timed_out, length=len(raw)), mock.patch.object(checker.subprocess, "Popen", side_effect=popen):
                result = checker.check_valhalla_monitor(self.client(graph_time), self.args)
            self.assertEqual(result["status"], "failed")
            self.assertIn("VALHALLA_MONITOR_UNAVAILABLE", result["error"])
            self.assert_private(result)
            if timed_out:
                process.kill.assert_called_once()
                self.assertEqual(process.wait.call_count, 2)

    def test_operational_report_contains_valhalla_failure_without_leaking_raw_output(self):
        raw, graph_time = snapshot(failed=True)
        _, popen = self.popen(raw)
        args = argparse.Namespace(**vars(self.args), base_url="http://127.0.0.1:5020", timeout_seconds=1,
            valhalla_monitor_enabled=True, skip_provider_gateway_smoke=True, skip_data_plane_smoke=True,
            require_dem=False, require_terrain_aware=False, slo_max_total_duration_ms=180000,
            environment="synthetic-test", bbox="12,48,19,51", terrain_bbox="14,50,15,51",
            slo_availability_target=0.995, check_interval_seconds=300,
            slo_max_live_latency_ms=1000, slo_max_summary_latency_ms=3000, slo_require_operations_ok=True)
        with mock.patch.object(checker, "Client", return_value=self.client(graph_time)), \
                mock.patch.object(checker.subprocess, "Popen", side_effect=popen), \
                mock.patch.object(checker, "check_metrics_are_internal", return_value={"status": "ok"}), \
                mock.patch.object(checker, "check_operations_slo", return_value={"status": "ok"}):
            report = checker.build_report(args)
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["failures"][0]["check"], "valhallaUpdates")
        self.assert_private(report)


class AlertDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.args = argparse.Namespace(state_file=Path(self.temporary.name) / "state.json", alert_reminder_seconds=86400,
            alert_every_failure=False, alert_on_recovery=True, no_syslog=True,
            webhook_url="https://notification.invalid/synthetic", webhook_timeout_seconds=1, environment="synthetic-test")
        self.clock = mock.patch.object(checker.time, "time", return_value=NOW)
        self.clock.start()
        self.addCleanup(self.clock.stop)

    def previous(self, report: dict, *, delivered_at: float = 0, failed: bool = False):
        checker.write_json(self.args.state_file, {"status": report["status"], "fingerprint": checker.failure_fingerprint(report["failures"]),
            "lastExternalAlertAt": delivered_at, "externalDeliveryFailed": failed})

    def test_failed_webhook_retries_same_failure_fingerprint_and_success_updates_external_delivery(self):
        report = failure_report()
        with mock.patch.object(checker, "send_webhook", side_effect=[checker.OperationalCheckError(PROVIDER_URL), {"httpStatus": 204, "elapsedMs": 2}]) as send:
            first = checker.maybe_alert(report, self.args)
            self.assertFalse(first["userNotificationDelivered"])
            self.assertFalse(first["sent"])
            self.assertNotIn(PRIVATE, json.dumps(first))
            self.assertNotIn(PROVIDER_URL, json.dumps(first))
            self.assertTrue(checker.read_json(self.args.state_file)["externalDeliveryFailed"])
            second = checker.maybe_alert(report, self.args)
        self.assertEqual(send.call_count, 2)
        self.assertTrue(second["userNotificationDelivered"])
        self.assertTrue(second["sent"])
        self.assertEqual(second["channels"][0]["status"], "ok")
        state = checker.read_json(self.args.state_file)
        self.assertEqual(state["lastExternalAlertAt"], NOW)
        self.assertFalse(state["externalDeliveryFailed"])

    def test_syslog_success_is_not_proof_of_user_notification(self):
        self.args.no_syslog = False
        self.args.webhook_url = ""
        with mock.patch.object(checker, "log_syslog") as logger, mock.patch.object(checker, "send_webhook") as send:
            delivery = checker.maybe_alert(failure_report(), self.args)
        logger.assert_called_once()
        send.assert_not_called()
        self.assertFalse(delivery["userNotificationDelivered"])
        self.assertEqual(checker.read_json(self.args.state_file)["lastExternalAlertAt"], 0)

    def test_successful_real_webhook_function_keeps_http_status_separate_from_channel_success(self):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.read.return_value = b""
        with mock.patch.object(checker, "urlopen", return_value=response):
            delivery = checker.maybe_alert(failure_report(), self.args)
        self.assertTrue(delivery["userNotificationDelivered"])
        self.assertTrue(delivery["sent"])
        self.assertEqual(delivery["channels"][0]["status"], "ok")
        self.assertEqual(delivery["channels"][0]["httpStatus"], 200)

    def test_same_failure_is_silent_before_daily_reminder_and_sent_when_reminder_becomes_due(self):
        report = failure_report()
        for elapsed, expected in [(86399, False), (86400, True)]:
            self.previous(report, delivered_at=NOW - elapsed)
            with self.subTest(elapsed=elapsed), mock.patch.object(checker, "send_webhook", return_value={"httpStatus": 204, "elapsedMs": 1}) as send:
                delivery = checker.maybe_alert(report, self.args)
            self.assertEqual(send.called, expected)
            self.assertEqual(delivery["userNotificationDelivered"], expected)

    def test_recovery_is_delivered_once_and_next_healthy_run_is_silent(self):
        self.previous(failure_report(), delivered_at=NOW - 300)
        healthy = failure_report("ok")
        with mock.patch.object(checker, "send_webhook", return_value={"httpStatus": 200, "elapsedMs": 2}) as send:
            recovery = checker.maybe_alert(healthy, self.args)
            repeated = checker.maybe_alert(healthy, self.args)
        self.assertEqual(send.call_count, 1)
        self.assertEqual(recovery["eventType"], "recovery")
        self.assertTrue(recovery["userNotificationDelivered"])
        self.assertFalse(repeated["userNotificationDelivered"])
        self.assertEqual(checker.read_json(self.args.state_file)["status"], "ok")

    def test_failed_recovery_notification_retries_on_next_healthy_run_and_then_deduplicates(self):
        self.previous(failure_report(), delivered_at=NOW - 300)
        healthy = failure_report("ok")
        with mock.patch.object(checker, "send_webhook", side_effect=[checker.OperationalCheckError(PROVIDER_URL), {"httpStatus": 204, "elapsedMs": 1}]) as send:
            first = checker.maybe_alert(healthy, self.args)
            self.assertFalse(first["userNotificationDelivered"])
            self.assertEqual(first["eventType"], "recovery")
            self.assertEqual(checker.read_json(self.args.state_file).get("pendingEventType"), "recovery")
            self.assertNotIn(PRIVATE, json.dumps(first))
            second = checker.maybe_alert(healthy, self.args)
            third = checker.maybe_alert(healthy, self.args)
        self.assertEqual(send.call_count, 2)
        self.assertEqual(second["eventType"], "recovery")
        self.assertTrue(second["userNotificationDelivered"])
        self.assertFalse(third["userNotificationDelivered"])
        self.assertNotEqual(checker.read_json(self.args.state_file).get("pendingEventType"), "recovery")


if __name__ == "__main__":
    unittest.main()
