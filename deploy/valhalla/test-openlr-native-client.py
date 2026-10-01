#!/usr/bin/env python3
"""Native client contract/failure/ownership tests, with synthetic data only."""
from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import stat
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("native_client", ROOT / "openlr-native-client.py")
assert spec and spec.loader
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)
GRAPH, REVISION = "a" * 64, "b" * 64


def segment(ident="synthetic"):
    return {"messageId": ident, "coordinates": [[14., 50.], [14.003, 50.]], "openlr": {"points": [
        {"role": "first", "bearing": 64, "frc": "2", "fow": "3", "distanceToNext": 215,
         "lowestFrcToNext": "2", "againstDrivingDirection": False},
        {"role": "last", "bearing": 192, "frc": "2", "fow": "3"}]}}


def response():
    return {"requestId": 1, "decoderVersion": client.DECODER_VERSION, "routingDataset": "synthetic",
        "graphSha256": GRAPH, "corridorRevision": "", "status": "matched", "expansions": 1, "lengthMeters": 150,
        "intervals": [{"edgeId": 1, "beginFraction": .25, "endFraction": .75, "edgeLengthMeters": 100},
                      {"edgeId": 2, "beginFraction": 0, "endFraction": 1, "edgeLengthMeters": 100}],
        "fullEdgeIds": [2]}


class ClientContractTests(unittest.TestCase):
    def test_tpeg_byte_bearings_and_offsets(self):
        source = segment()
        source["openlr"]["positiveOffsetMeters"] = 12
        request = client.native_request(source, 1, "synthetic", GRAPH, REVISION)
        self.assertEqual([p["bearingDegrees"] for p in request["lrps"]], [90, 270])
        self.assertEqual(request["lrps"][0]["lowestFrcToNext"], 2)
        self.assertEqual(request["positiveOffsetMeters"], 12)
        self.assertNotIn("role", request["lrps"][0])

    def test_invalid_source_is_not_relaxed(self):
        cases = []
        for field, value in [("bearing", 256), ("bearing", True), ("bearing", 64.5),
                             ("frc", "2.0"), ("fow", True), ("distanceToNext", float("nan")),
                             ("lowestFrcToNext", True), ("againstDrivingDirection", "false")]:
            item = segment(); item["openlr"]["points"][0][field] = value; cases.append(item)
        missing = segment(); del missing["openlr"]["points"][0]["lowestFrcToNext"]; cases.append(missing)
        coordinates = segment(); coordinates["coordinates"][0][0] = True; cases.append(coordinates)
        final_path = segment(); final_path["openlr"]["points"][-1]["distanceToNext"] = 10; cases.append(final_path)
        offset = segment(); offset["openlr"]["negativeOffsetMeters"] = -1; cases.append(offset)
        for item in cases:
            with self.subTest(item=item), self.assertRaises((ValueError, TypeError, KeyError)):
                client.native_request(item, 1, "synthetic", GRAPH, REVISION)

    def test_complete_intervals_are_separate_from_full_edge_ids(self):
        client.validate_response(response(), 1, "synthetic", GRAPH)
        self.assertEqual(response()["fullEdgeIds"], [2])

    def test_malformed_or_wrong_identity_response_fails_closed(self):
        mutations = [lambda r: r.update(requestId=True), lambda r: r.update(graphSha256="f" * 64),
                     lambda r: r.update(decoderVersion="legacy"), lambda r: r.update(status="maybe"),
                     lambda r: r.update(expansions=-1), lambda r: r.update(lengthMeters=160),
                     lambda r: r.update(fullEdgeIds=[1, 2]), lambda r: r.update(untrusted="text"),
                     lambda r: r["intervals"][0].update(beginFraction="0.25"),
                     lambda r: r["intervals"][0].update(beginFraction=True),
                     lambda r: r["intervals"][0].update(edgeId=True),
                     lambda r: r["intervals"][0].update(edgeLengthMeters=float("nan")),
                     lambda r: r["intervals"].append(copy.deepcopy(r["intervals"][0]))]
        for change in mutations:
            result = response(); change(result)
            with self.subTest(result=result), self.assertRaises(RuntimeError):
                client.validate_response(result, 1, "synthetic", GRAPH)

    def test_real_subprocess_identity_failure(self):
        process = client.NativeDecoderClient(Path(sys.executable), ROOT / "test-openlr-native-fake-helper.py",
                                             "wrong_identity", GRAPH, 1)
        try:
            with self.assertRaises(RuntimeError):
                process.decode(segment(), REVISION)
        finally:
            process.close()

    def test_real_subprocess_full_and_partial_line_timeout(self):
        for mode in ("timeout", "partial_timeout"):
            process = client.NativeDecoderClient(Path(sys.executable), ROOT / "test-openlr-native-fake-helper.py",
                                                 mode, GRAPH, 1)
            started = time.monotonic()
            try:
                with self.assertRaises(TimeoutError):
                    process.decode(segment(), REVISION)
                self.assertLess(time.monotonic() - started, 2)
            finally:
                process.close()

    def test_protocol_timeout_terminates_owned_child_process(self):
        with tempfile.TemporaryDirectory(prefix="sim-openlr-client-") as work:
            pid_file = Path(work) / "owned-child.pid"
            with patch.dict(os.environ, {"SIM_NATIVE_TEST_CHILD_PID_PATH": str(pid_file)}):
                process = client.NativeDecoderClient(Path(sys.executable), ROOT / "test-openlr-native-fake-helper.py",
                                                     "child_timeout", GRAPH, 1)
            try:
                self.assertEqual(os.getpgid(process.process.pid), process.process.pid)
                with self.assertRaises(TimeoutError):
                    process.decode(segment(), REVISION)
                self.assertIsNotNone(process.process.poll())
                self.assertTrue(pid_file.exists(), "Test child did not start")
                owned_child_pid = int(pid_file.read_text())
                with self.assertRaises(ProcessLookupError):
                    os.kill(owned_child_pid, 0)
            finally:
                process.close()

    def test_protocol_timeout_escalates_owned_group_to_kill(self):
        process = client.NativeDecoderClient(Path(sys.executable), ROOT / "test-openlr-native-fake-helper.py",
                                             "ignore_timeout", GRAPH, 1)
        started = time.monotonic()
        try:
            with self.assertRaises(TimeoutError):
                process.decode(segment(), REVISION)
            self.assertEqual(process.process.returncode, -signal.SIGKILL)
            self.assertGreaterEqual(time.monotonic() - started, 1.9)
            self.assertLess(time.monotonic() - started, 3.5)
            with self.assertRaises(ProcessLookupError):
                os.killpg(process.process.pid, 0)
        finally:
            process.close()

    def test_group_probe_permission_race_is_bounded_not_accepted(self):
        original_killpg = client.os.killpg
        for permanent in (False, True):
            process = client.NativeDecoderClient(Path(sys.executable), ROOT / "test-openlr-native-fake-helper.py",
                                                 "timeout", GRAPH, 1)
            process.failed = True
            denied = False
            def permission_race(group_id, signum):
                nonlocal denied
                if signum == 0 and (permanent or not denied):
                    denied = True
                    raise PermissionError("Synthetic owned-group exit race")
                return original_killpg(group_id, signum)
            started = time.monotonic()
            try:
                with self.subTest(permanent=permanent), patch.object(client.os, "killpg", side_effect=permission_race):
                    if permanent:
                        with self.assertRaises(PermissionError):
                            process._terminate_process_group()
                    else:
                        process._terminate_process_group()
                self.assertTrue(denied)
                self.assertLess(time.monotonic() - started, 1.5)
            finally:
                process._terminate_process_group()
                process.close()

    def test_final_graph_verification_failure_blocks_report(self):
        process = client.NativeDecoderClient(Path(sys.executable), ROOT / "test-openlr-native-fake-helper.py",
                                             "final_verification_failure", GRAPH, 1)
        result = process.decode(segment(), REVISION)
        self.assertEqual(result["status"], "unmatched")
        with self.assertRaises(RuntimeError):
            process.close()

    def test_same_edge_claimed_by_two_references_is_not_activated(self):
        with tempfile.TemporaryDirectory(prefix="sim-openlr-client-") as work:
            static_path, output = Path(work) / "static.json.gz", Path(work) / "audit.json.gz"
            client.private_json(static_path, {"staticRevision": REVISION, "segments": [segment("a"), segment("b")]})
            report = client.run(argparse.Namespace(helper=Path(sys.executable),
                graph_config=ROOT / "test-openlr-native-fake-helper.py", routing_dataset="matched",
                graph_sha256=GRAPH, static_cache=static_path, output=output))
            self.assertEqual(report["collisionReferenceCount"], 2)
            self.assertEqual(report["wholeEdgeCandidateReferenceCount"], 0)
            self.assertFalse(report["approvedForLive"])
            self.assertNotIn("mapping", report)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            with gzip.open(output, "rt") as stream:
                private = json.load(stream)
            self.assertEqual(private["mapping"], {})
            self.assertEqual(len(private["intervalCandidates"]), 2)

    def test_partial_foreign_claim_blocks_full_edge(self):
        with tempfile.TemporaryDirectory(prefix="sim-openlr-client-") as work:
            static_path, output = Path(work) / "static.json.gz", Path(work) / "audit.json.gz"
            client.private_json(static_path, {"staticRevision": REVISION, "segments": [segment("partial"), segment("full")]})
            report = client.run(argparse.Namespace(helper=Path(sys.executable),
                graph_config=ROOT / "test-openlr-native-fake-helper.py", routing_dataset="overlapping_partial",
                graph_sha256=GRAPH, static_cache=static_path, output=output))
            self.assertEqual(report["collisionReferenceCount"], 2)
            self.assertEqual(report["wholeEdgeCandidateReferenceCount"], 0)

    def test_corridor_identity_payload_hash_and_cache_key(self):
        with tempfile.TemporaryDirectory(prefix="sim-openlr-client-") as work:
            static_path, corridor_path = Path(work) / "static.json.gz", Path(work) / "corridor.json.gz"
            client.private_json(static_path, {"staticRevision": REVISION, "segments": [segment()]})
            canonical = {"tmcVersion": "synthetic", "tmcSha256": "c" * 64,
                "corridors": {"synthetic": {"toleranceMeters": 10, "parts": [[[14., 50.], [14.003, 50.]]]}}}
            revision = hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            feed = {"contractVersion": "sim-tmc-corridors-v1", "revision": revision, **canonical}
            client.private_json(corridor_path, feed)
            args = argparse.Namespace(helper=Path(sys.executable), graph_config=ROOT / "test-openlr-native-fake-helper.py",
                routing_dataset="matched", graph_sha256=GRAPH, static_cache=static_path,
                output=Path(work) / "audit.json.gz", corridor_cache=corridor_path)
            report = client.run(args)
            self.assertEqual(report["independentCorridorRevision"], revision)
            self.assertEqual(report["tmcVersion"], "synthetic")
            key = report["cacheKey"]
            args.corridor_cache = None
            self.assertNotEqual(key, client.run(args)["cacheKey"])
            feed["corridors"]["synthetic"]["toleranceMeters"] = 20
            client.private_json(corridor_path, feed)
            args.corridor_cache = corridor_path
            with self.assertRaises(ValueError):
                client.run(args)

    def test_corridor_unknown_fields_and_wrong_revision_response(self):
        good = {"revision": "c" * 64, "toleranceMeters": 10, "parts": [[[14., 50.], [14.003, 50.]]]}
        client.validate_corridor(good)
        for change in (lambda x: x.update(untrusted=True), lambda x: x.update(toleranceMeters=101),
                       lambda x: x.update(parts=[]), lambda x: x.update(revision="invalid")):
            bad = copy.deepcopy(good); change(bad)
            with self.assertRaises(ValueError):
                client.validate_corridor(bad)
        with self.assertRaises(RuntimeError):
            client.validate_response(response(), 1, "synthetic", GRAPH, "c" * 64)

    def test_corridor_entries_reject_redundant_revision_and_unknown_keys(self):
        with tempfile.TemporaryDirectory(prefix="sim-openlr-client-") as work:
            static_path, corridor_path, output = (Path(work) / name for name in
                                                  ("static.json.gz", "corridor.json.gz", "audit.json.gz"))
            client.private_json(static_path, {"staticRevision": REVISION, "segments": [segment()]})
            args = argparse.Namespace(helper=Path(sys.executable), graph_config=ROOT / "test-openlr-native-fake-helper.py",
                routing_dataset="matched", graph_sha256=GRAPH, static_cache=static_path,
                output=output, corridor_cache=corridor_path)
            for key, value in (("revision", "c" * 64), ("source", "untrusted")):
                canonical = {"tmcVersion": "synthetic", "tmcSha256": "c" * 64,
                    "corridors": {"synthetic": {"toleranceMeters": 10,
                        "parts": [[[14., 50.], [14.003, 50.]]], key: value}}}
                revision = hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
                client.private_json(corridor_path, {"contractVersion": "sim-tmc-corridors-v1", "revision": revision, **canonical})
                with self.subTest(key=key), self.assertRaisesRegex(ValueError, "Invalid independent corridor entry"):
                    client.run(args)
                self.assertFalse(output.exists())

    def test_audit_output_cannot_replace_inputs_helper_or_configuration(self):
        with tempfile.TemporaryDirectory(prefix="sim-openlr-client-") as work:
            directory = Path(work)
            static, corridor, helper, configuration = (directory / name for name in
                ("static.json.gz", "corridor.json.gz", "helper.json.gz", "configuration.json.gz"))
            client.private_json(static, {"staticRevision": REVISION, "segments": [segment()]})
            for path in (corridor, helper, configuration):
                path.write_bytes(b"Synthetic protected input")
            args = argparse.Namespace(helper=helper, graph_config=configuration,
                routing_dataset="matched", graph_sha256=GRAPH, static_cache=static,
                corridor_cache=corridor, output=directory / "audit.json.gz")
            for index, source in enumerate((static, corridor, helper, configuration)):
                symbolic, hardlink = (directory / f"alias-{index}-{kind}.json.gz" for kind in ("symbolic", "hard"))
                symbolic.symlink_to(source)
                os.link(source, hardlink)
                original = source.read_bytes()
                for output in (source, source.parent / ".." / source.parent.name / source.name, symbolic, hardlink):
                    args.output = output
                    with self.subTest(source=source.name, output=output.name), \
                         patch.object(client, "NativeDecoderClient") as process, \
                         self.assertRaisesRegex(ValueError, "must not replace"):
                        client.run(args)
                    process.assert_not_called()
                    self.assertEqual(source.read_bytes(), original)

    def test_audit_output_rejects_runtime_paths_and_non_gzip_names_before_helper_start(self):
        with tempfile.TemporaryDirectory(prefix="sim-openlr-client-") as work:
            directory = Path(work)
            static = directory / "static.json.gz"
            client.private_json(static, {"staticRevision": REVISION, "segments": [segment()]})
            run_link, var_run_link = directory / "run-link", directory / "var-run-link"
            run_link.symlink_to("/run", target_is_directory=True)
            var_run_link.symlink_to("/var/run", target_is_directory=True)
            args = argparse.Namespace(helper=Path(sys.executable),
                graph_config=ROOT / "test-openlr-native-fake-helper.py", routing_dataset="matched",
                graph_sha256=GRAPH, static_cache=static, output=directory / "audit.json.gz")
            for output in (directory / "audit.json", directory / "audit.gz", Path("/run/sim-audit.json.gz"),
                           Path("/var/run/sim-audit.json.gz"), run_link / "audit.json.gz", var_run_link / "audit.json.gz"):
                args.output = output
                with self.subTest(output=str(output)), patch.object(client, "NativeDecoderClient") as process, \
                     self.assertRaisesRegex(ValueError, "outside runtime directories"):
                    client.run(args)
                process.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
