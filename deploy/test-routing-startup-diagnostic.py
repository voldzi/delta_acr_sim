"""Synthetic-only diagnostic orchestration; no Docker or production access."""
import importlib.util
import json
import os
import tempfile
import stat
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location("diagnostic", Path(__file__).with_name("diagnose-routing-startup.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class DiagnosticTests(unittest.TestCase):
    def test_restore_requires_old_health_runtime_and_exact_original_pin(self):
        state = {"Config": {"Env": ["A=fixture"], "Healthcheck": {"Test": ["fixture"]}}, "HostConfig": {}, "Mounts": []}
        pin = Mock()
        pin.read_bytes.return_value = b"original"
        with patch.object(module.support, "PIN", pin), \
             patch.object(module.support, "replace_pin") as replace, \
             patch.object(module, "run") as run, \
             patch.object(module, "wait_healthy", return_value="healthy") as wait, \
             patch.object(module, "inspect", return_value=state):
            self.assertTrue(module.restore(b"original", state)["verified"])
            replace.assert_called_once_with(b"original")
            run.assert_called_once_with(module.support.DC + ["up", "-d", "--no-deps", "--no-build", "situation-data-api"])
            wait.assert_called_once_with(module.support.OLD)
            pin.read_bytes.return_value = b"changed"
            self.assertFalse(module.restore(b"original", state)["verified"])
            pin.read_bytes.return_value = b"original"
            wait.return_value = "unhealthy"
            self.assertFalse(module.restore(b"original", state)["verified"])

    def test_safe_receipt_readable_even_under_private_root_umask(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            old = os.umask(0o077)
            try:
                module.write_receipt(path, {"verified": True}, 0o644)
            finally:
                os.umask(old)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)

    def exercise(self, *, outcome="healthy", capture_error=False, write_error=False, restore_error=False, deploy=False, accept=True):
        original = json.dumps({"services": {"situation-data-api": {"image": module.support.OLD}}}).encode()
        compose = json.loads(original)
        candidate = json.loads(original)
        candidate["services"]["situation-data-api"]["image"] = module.support.NEW
        before = {"Config": {"Healthcheck": {"Test": ["fixture"]}}}
        with patch.object(module.support, "replace_pin") as replace, \
             patch.object(module, "run", side_effect=[json.dumps(candidate), ""]), \
             patch.object(module, "wait_healthy", return_value=outcome), \
             patch.object(module, "inspect", return_value=before), \
             patch.object(module.support, "runtime_differences", return_value=[]), \
             patch.object(module.support, "safe_startup_diagnostics", side_effect=TimeoutError() if capture_error else None, return_value={"health": outcome}) as capture, \
             patch.object(module, "restore", side_effect=RuntimeError() if restore_error else None, return_value={"verified": True}) as restore, \
             patch.object(module, "write_receipt", side_effect=OSError() if write_error else None) as write, \
             patch.object(module.signal, "signal"), patch("builtins.print"):
            order = Mock()
            order.attach_mock(capture, "capture")
            order.attach_mock(restore, "restore")
            order.attach_mock(write, "write")
            if restore_error:
                with self.assertRaisesRegex(RuntimeError, "ROLLBACK_NOT_VERIFIED"):
                    module.diagnostic(original, before, compose, Path("/fixture/private"), Path("/fixture/result"))
                return
            result = module.diagnostic(original, before, compose, Path("/fixture/private"), Path("/fixture/result"), deploy=deploy,
                                       acceptance=(lambda: {"verified": accept}) if deploy else None)
            if deploy and accept and outcome == "healthy":
                restore.assert_not_called()
                self.assertTrue(result["deploymentCommitted"])
                return result
            restore.assert_called_once_with(original, before)
            self.assertEqual(order.mock_calls[0][0], "capture")
            self.assertEqual(order.mock_calls[1][0], "restore")
            return result

    def test_success_always_restores_original(self):
        self.assertTrue(self.exercise()["rollback"]["verified"])

    def test_explicit_deployment_only_keeps_verified_candidate(self):
        self.exercise(deploy=True)

    def test_failed_real_route_acceptance_restores(self):
        result = self.exercise(deploy=True, accept=False)
        self.assertTrue(result["rollback"]["verified"])
        self.assertNotIn("deploymentCommitted", result)

    def test_deployment_requires_acceptance_callback_before_any_change(self):
        with self.assertRaisesRegex(RuntimeError, "requires a real route"):
            module.diagnostic(b"", {}, {}, Path("/fixture"), Path("/fixture/result"), deploy=True)

    def test_failed_health_keeps_reason_and_restores(self):
        result = self.exercise(outcome="process_restarted")
        self.assertFalse(result["candidatePassed"])
        self.assertEqual(result["healthOutcome"], "process_restarted")

    def test_capture_failure_cannot_prevent_rollback(self):
        self.assertTrue(self.exercise(capture_error=True)["startup"]["diagnosticCaptureFailed"])

    def test_receipt_failure_cannot_prevent_rollback(self):
        result = self.exercise(write_error=True)
        self.assertTrue(result["rollback"]["verified"])
        self.assertTrue(result["receiptWriteFailed"])

    def test_rollback_failure_is_not_success(self):
        self.exercise(restore_error=True)

    def test_image_mismatch_not_misreported_as_deadline(self):
        with patch.object(module, "inspect", return_value={"Image": "other", "State": {}}):
            self.assertEqual(module.wait_healthy(module.support.NEW), "image_mismatch")

    def test_process_and_oom_reasons(self):
        for state, outcome in (({"OOMKilled": True}, "oom_killed"), ({"Status": "exited"}, "process_exited"), ({"Restarting": True}, "process_restarted"), ({"Status": "running"}, "health_probe_missing")):
            with patch.object(module, "inspect", return_value={"Image": module.support.NEW, "State": state}):
                self.assertEqual(module.wait_healthy(module.support.NEW), outcome)

    def test_command_timeout_never_exposes_output(self):
        with patch.object(subprocess, "check_output", side_effect=subprocess.TimeoutExpired("fixture", 15, output="synthetic-secret")):
            with self.assertRaisesRegex(RuntimeError, "COMMAND_TIMEOUT") as error:
                module.run(["docker", "inspect", "fixture"])
            self.assertNotIn("synthetic-secret", str(error.exception))

if __name__ == "__main__": unittest.main()
