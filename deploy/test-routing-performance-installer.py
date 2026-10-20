"""Isolated tests: no Docker, network, production files or credentials."""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("installer", Path(__file__).with_name("install-reviewed-routing-performance.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

class InstallerTests(unittest.TestCase):
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
