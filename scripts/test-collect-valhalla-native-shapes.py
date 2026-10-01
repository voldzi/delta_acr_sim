#!/usr/bin/env python3
"""Synthetic-only private collector preflight and scope tests; no SSH calls."""
import argparse
import contextlib
import gzip
import importlib.util
import io
import json
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("native_shape_collector", Path(__file__).with_name("collect-valhalla-native-shapes.py"))
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.args = argparse.Namespace(audit=self.root / "audit.json.gz", output=self.root / "shapes.json.gz")
        self.audit = {"decoderVersion": "openlr-native-v2", "approvedForLive": False, "graphSha256": "a" * 64,
                      "intervalCandidates": {"private-reference": [{"edgeId": 16}]}}
        self.write_audit()
        self.export = {"contractVersion": "sim-native-directed-shapes-v1", "graphSha256": "a" * 64,
                       "shapes": {"16": [[14., 50.], [14.001, 50.]]}}

    def tearDown(self): self.directory.cleanup()

    def write_audit(self):
        with gzip.open(self.args.audit, "wt") as stream: json.dump(self.audit, stream)

    def response(self, value=None, status=0):
        return subprocess.CompletedProcess([], status, stdout=gzip.compress(json.dumps(value or self.export).encode()), stderr=b"PRIVATE-ERROR")

    def test_success_is_scoped_and_private(self):
        output = io.StringIO()
        with patch.object(collector.subprocess, "run", return_value=self.response()) as run, contextlib.redirect_stdout(output):
            collector.main(self.args)
        command = run.call_args.args[0][-1]
        self.assertIn("--network none --read-only", command)
        self.assertIn("--cidfile", command)
        self.assertIn('docker rm -f "$owned_id"', command)
        self.assertNotIn('docker rm -f "$name"', command)
        self.assertNotIn("/run/valhalla-traffic", command)
        self.assertEqual(run.call_args.kwargs["timeout"], 210)
        self.assertEqual(stat.S_IMODE(self.args.output.stat().st_mode), 0o600)
        self.assertNotIn("private-reference", output.getvalue())
        self.assertNotIn("shapes", output.getvalue())

    def test_invalid_output_is_refused_before_network(self):
        for output in (self.args.audit, self.root / "invalid.json", Path("/run/not-runtime.json.gz")):
            with patch.object(collector.subprocess, "run") as run, self.assertRaises(ValueError):
                collector.main(argparse.Namespace(audit=self.args.audit, output=output))
            run.assert_not_called()
        self.args.output.write_bytes(b"owned-other-output")
        with patch.object(collector.subprocess, "run") as run, self.assertRaises(ValueError): collector.main(self.args)
        run.assert_not_called()

    def test_bad_audit_or_directed_road_ids_fail_before_network(self):
        for value in (True, -1, 19, 2**46):
            self.audit["intervalCandidates"]["private-reference"] = [{"edgeId": value}]
            self.write_audit()
            with patch.object(collector.subprocess, "run") as run, self.assertRaises(ValueError): collector.main(self.args)
            run.assert_not_called()

    def test_wrong_export_identity_or_set_cannot_be_saved(self):
        for change in ({"graphSha256": "b" * 64}, {"contractVersion": "wrong"}, {"shapes": {"24": []}}, {"unexpected": True}):
            with patch.object(collector.subprocess, "run", return_value=self.response({**self.export, **change})), self.assertRaises(ValueError):
                collector.main(self.args)
            self.assertFalse(self.args.output.exists())

    def test_remote_failure_has_no_private_error_details(self):
        with patch.object(collector.subprocess, "run", return_value=self.response(status=1)), self.assertRaises(RuntimeError) as caught:
            collector.main(self.args)
        self.assertNotIn("PRIVATE", str(caught.exception))
        self.assertFalse(self.args.output.exists())


if __name__ == "__main__": unittest.main()
