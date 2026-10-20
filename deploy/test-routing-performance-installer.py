"""Isolated tests: no Docker, network, production files or credentials."""
import importlib.util
import copy
import tempfile
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("installer", Path(__file__).with_name("install-reviewed-routing-performance.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

class InstallerTests(unittest.TestCase):
    def test_startup_diagnostics_excludes_raw_logs_and_probe_output(self):
        state = {"Image": installer.NEW, "RestartCount": 1, "State": {"Status": "restarting", "ExitCode": 1,
                 "Health": {"Status": "unhealthy", "Log": [{"ExitCode": 1, "Output": "synthetic-secret ECONNREFUSED"}]}}}
        with patch.object(subprocess, "run", side_effect=[subprocess.CompletedProcess([], 0, json.dumps([state]), ""), subprocess.CompletedProcess([], 0, "Error: CLEAN_DATABASE_NOT_READY synthetic-secret", "")]):
            result = installer.safe_startup_diagnostics("fixture")
        self.assertNotIn("synthetic-secret", json.dumps(result))
        self.assertEqual(result["startupErrorCodes"], ["CLEAN_DATABASE_NOT_READY"])
        self.assertEqual(result["probes"][0]["errorCodes"], ["ECONNREFUSED"])

    def diagnostic_state(self):
        return {"Image": installer.NEW, "RestartCount": 0, "State": {"Status": "exited", "ExitCode": 1}}

    def test_diagnostic_inspect_timeout_is_bounded_and_safe(self):
        with patch.object(subprocess, "run", side_effect=subprocess.TimeoutExpired([], 5, output="synthetic-secret")) as call:
            result = installer.safe_startup_diagnostics("fixture")
        self.assertEqual(result, {"inspectTimedOut": True})
        self.assertEqual(call.call_args.kwargs["timeout"], 5)
        self.assertNotIn("synthetic-secret", json.dumps(result))

    def test_diagnostic_logs_timeout_preserves_inspect_and_never_partial_logs(self):
        with patch.object(subprocess, "run", side_effect=[
            subprocess.CompletedProcess([], 0, json.dumps([self.diagnostic_state()]), ""),
            subprocess.TimeoutExpired([], 10, output="synthetic-secret")]) as call:
            result = installer.safe_startup_diagnostics("fixture")
        self.assertTrue(result["logsTimedOut"])
        self.assertEqual(result["exitCode"], 1)
        self.assertEqual(call.call_args.kwargs["timeout"], 10)
        self.assertNotIn("synthetic-secret", json.dumps(result))

    def test_diagnostic_stack_sites_allowlist_coordinates_not_messages_or_names(self):
        raw = """TypeError: synthetic-secret credential-value
    at synthetic-secret-function (file:///app/apps/situation-data-api/dist/app.js:140:19)
    at /app/apps/situation-data-api/dist/index.js:14:32
    at synthetic-secret-function (file:///app/packages/clean-lifecycle/runtime.mjs:20:6)
    at /app/apps/situation-data-api/dist/synthetic-secret.js:2:3
    at /app/packages/clean-lifecycle/synthetic-secret.mjs:2:3
    at /app/apps/other/dist/app.js:2:3
    at /private/synthetic-secret/config.js:2:3
    at /app/apps/situation-data-api/dist/app.js:140:19?synthetic-secret
Error code: ERR_INVALID_ARG_TYPE
"""
        with patch.object(subprocess, "run", side_effect=[
            subprocess.CompletedProcess([], 0, json.dumps([self.diagnostic_state()]), ""),
            subprocess.CompletedProcess([], 0, raw, "")]):
            result = installer.safe_startup_diagnostics("fixture")
        self.assertEqual(result["startupStackSites"], [
            {"module": "apps/situation-data-api/dist/app.js", "line": 140, "column": 19},
            {"module": "apps/situation-data-api/dist/index.js", "line": 14, "column": 32},
            {"module": "packages/clean-lifecycle/runtime.mjs", "line": 20, "column": 6}])
        self.assertEqual(result["exceptionClasses"], ["TypeError"])
        self.assertEqual(result["startupErrorCodes"], ["ERR_INVALID_ARG_TYPE"])
        serialized = json.dumps(result)
        self.assertNotIn("synthetic-secret", serialized)
        self.assertNotIn("credential-value", serialized)

    def test_diagnostic_stack_sites_deduplicated_and_limited(self):
        raw = "\n".join("    at /app/apps/situation-data-api/dist/app.js:%d:1" % line for line in ([1, 1] + list(range(2, 20))))
        with patch.object(subprocess, "run", side_effect=[
            subprocess.CompletedProcess([], 0, json.dumps([self.diagnostic_state()]), ""),
            subprocess.CompletedProcess([], 0, raw, "")]):
            result = installer.safe_startup_diagnostics("fixture")
        self.assertEqual(len(result["startupStackSites"]), 12)
        self.assertEqual([site["line"] for site in result["startupStackSites"]], list(range(1, 13)))

    def test_repeat_never_overwrites_rollback_or_retries(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            receipt = root / "failure.json"
            receipt.write_text(json.dumps({"phase": "runtime-security-parity", "differentFields": ["Config.Env", "synthetic-secret"]}))
            original = receipt.read_bytes()
            with self.assertRaises(RuntimeError) as error:
                installer.reject_previous_attempt(root)
            self.assertIn("runtime-security-parity", str(error.exception))
            self.assertNotIn("synthetic-secret", str(error.exception))
            self.assertEqual(receipt.read_bytes(), original)

    def test_incomplete_attempt_requires_review(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "without a failure receipt"):
                installer.reject_previous_attempt(Path(directory))

    def runtime(self):
        return {"Config": {"Env": ["A=1", "B=2"], "Cmd": ["node", "app.js"]}, "HostConfig": {"SecurityOpt": ["a", "b"]}, "Mounts": [{"Destination": "/cache", "RW": False}]}

    def test_runtime_order_is_not_a_value_change(self):
        before = self.runtime()
        after = copy.deepcopy(before)
        after["Config"]["Env"].reverse()
        after["HostConfig"]["SecurityOpt"].reverse()
        self.assertEqual(installer.runtime_differences(before, after), [])

    def test_runtime_secret_value_and_mount_permissions_still_checked(self):
        before = self.runtime()
        after = copy.deepcopy(before)
        after["Config"]["Env"][0] = "A=changed"
        after["Mounts"][0]["RW"] = True
        self.assertEqual(installer.runtime_differences(before, after), ["Config.Env", "Mounts"])

    def test_duplicate_environment_names_rejected(self):
        with self.assertRaises(RuntimeError):
            installer.environment_map(["A=1", "A=2"])

    def pin(self):
        return {"services": {"situation-data-api": {"image": installer.OLD}, "ai-router-api": {"image": "sha256:" + "a" * 64}}}

    def test_interpolation_uses_pins_not_inherited_override(self):
        with patch.dict("os.environ", {"SIM_ERASURE_DRIVER_IMAGE": "unreviewed"}):
            env = installer.reviewed_compose_environment(self.pin())
        self.assertEqual(env["SIM_ERASURE_DRIVER_IMAGE"], installer.OLD)
        self.assertEqual(env["SIM_ERASURE_ROUTER_IMAGE"], "sha256:" + "a" * 64)

    def test_mutable_or_invalid_pin_rejected(self):
        for value in ("latest", "sha256:" + "x" * 64, "sha256:abc", None):
            pin = self.pin()
            pin["services"]["ai-router-api"]["image"] = value
            with self.assertRaises(RuntimeError):
                installer.reviewed_compose_environment(pin)

    def test_environment_scoped_to_compose(self):
        installer.COMPOSE_ENV = {"reviewed": "fixture"}
        try:
            with patch.object(subprocess, "check_output", return_value="") as call:
                installer.run(installer.DC + ["config", "--format", "json"])
                self.assertEqual(call.call_args.kwargs["env"], installer.COMPOSE_ENV)
                installer.run(["docker", "inspect", "fixture"])
                self.assertIsNone(call.call_args.kwargs["env"])
        finally:
            installer.COMPOSE_ENV = None

    def test_error_never_echoes_captured_secret(self):
        with patch.object(subprocess, "check_output", side_effect=subprocess.CalledProcessError(1, ["docker"], stderr="synthetic-secret")):
            with self.assertRaises(RuntimeError) as error:
                installer.run(installer.DC + ["config"])
            self.assertNotIn("synthetic-secret", str(error.exception))

if __name__ == "__main__":
    unittest.main()
