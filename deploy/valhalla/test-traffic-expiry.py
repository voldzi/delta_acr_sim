#!/usr/bin/env python3
"""Synthetic traffic archive acceptance; no licensed or provider data needed."""
from __future__ import annotations

from io import BytesIO
import importlib.util
import json
from pathlib import Path
import struct
import tarfile
import tempfile
import threading
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("traffic_update", Path(__file__).with_name("traffic-update.py"))
assert SPEC and SPEC.loader
traffic = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(traffic)
NOW = 1790856000.0
EDGE = 2 | (20 << 3) | (1 << 25)
MAPPING = {"matcherVersion": traffic.MATCHER_VERSION, "sourceSegmentCount": 1,
           "mappedSegmentCount": 1, "mapping": {"synthetic": [{"id": EDGE, "baselineSpeedKph": 80}]}}


def flow(**kwargs):
    return {"messageId": "synthetic", "averageSpeedKph": 30,
            "observedAt": traffic.utc_iso(NOW - 10), "validUntil": traffic.utc_iso(NOW + 5), **kwargs}


def archive(path):
    header = struct.pack("<2Q4I", 2 | (20 << 3), 0, 2, 3, 0, 0)
    with tarfile.open(path, "w") as tar:
        info = tarfile.TarInfo("2/000/000/020.gph")
        info.size = len(header) + 16
        tar.addfile(info, BytesIO(header + b"\0" * 16))


class TrafficExpiryAcceptance(unittest.TestCase):
    def test_timestamps_fail_closed(self):
        rejected = [flow(observedAt=None), flow(observedAt="bad"),
                    flow(observedAt="2026-10-01T12:00:00"), flow(observedAt=traffic.utc_iso(NOW + 31)),
                    flow(validUntil=None), flow(validUntil="bad"),
                    flow(validUntil=traffic.utc_iso(NOW)),
                    flow(validUntil=traffic.utc_iso(NOW - 11)), flow(averageSpeedKph=float("nan")),
                    flow(averageSpeedKph=0), flow(averageSpeedKph=-1)]
        for value in rejected:
            with self.subTest(value=value):
                self.assertEqual(traffic.current_edge_speeds({"flows": [value]}, MAPPING, 300, NOW)[:2], ({}, 0))
                self.assertEqual(traffic.next_flow_recompute_epoch({"flows": [value]}, MAPPING, 300, NOW), NOW)

    def test_missing_expiry_has_observation_based_ceiling(self):
        value = flow()
        del value["validUntil"]
        self.assertEqual(traffic.flow_deadline(value, 300, NOW), NOW + 290)
        self.assertIsNone(traffic.flow_deadline(value, 5, NOW))
        self.assertEqual(traffic.flow_deadline(flow(observedAt=traffic.utc_iso(NOW + 30),
                                                   validUntil=traffic.utc_iso(NOW + 35)), 300, NOW), NOW + 35)
        self.assertEqual(traffic.next_flow_recompute_epoch({"flows": [flow(), value]}, MAPPING, 300, NOW), NOW + 5)

    def test_expiry_clears_and_persists_report_without_network(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(traffic.time, "time", return_value=NOW):
            root = Path(directory)
            archive(root / "traffic.tar")
            traffic.apply_speeds(root / "traffic.tar", root / "applied-edges.json", {EDGE: (30, 80)})
            old = {"routingDataset": "synthetic-dataset", "status": "current", "overlayGeneration": "old",
                   "updatedAt": traffic.utc_iso(NOW - 10), "usableUntil": traffic.utc_iso(NOW),
                   "appliedEdgeCount": 1, "appliedFlowCount": 1}
            traffic.atomic_json_state(root / "last-applied.json", {"nextRecomputeAtEpoch": NOW, "report": old})
            with patch.object(traffic, "request_json", side_effect=AssertionError("expiry must be local")):
                self.assertTrue(traffic.clear_expired_runtime(root, 300))
            self.assertEqual(json.loads((root / "applied-edges.json").read_text()), [])
            report = json.loads((root / "pending-report.json").read_text())
            self.assertEqual(report["status"], "degraded")
            self.assertEqual(report["appliedEdgeCount"], 0)
            self.assertEqual(report["usableUntil"], report["updatedAt"])
            self.assertNotEqual(report["overlayGeneration"], "old")
            self.assertFalse(traffic.clear_expired_runtime(root, 300))
            self.assertEqual((root / "pending-report.json").stat().st_mode & 0o777, 0o600)

    def test_deadline_rechecked_under_lock(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(traffic.time, "time", return_value=NOW):
            root = Path(directory)
            archive(root / "traffic.tar")
            traffic.apply_speeds(root / "traffic.tar", root / "applied-edges.json", {EDGE: (30, 80)})
            with patch.object(traffic, "read_json_state", side_effect=[{"nextRecomputeAtEpoch": NOW - 1},
                                                                     {"nextRecomputeAtEpoch": NOW + 5}]):
                self.assertFalse(traffic.clear_expired_runtime(root, 300))
            self.assertEqual(json.loads((root / "applied-edges.json").read_text()), [EDGE])

    def test_old_delivery_cannot_remove_new_generation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "update.lock").touch()
            traffic.atomic_json_state(root / "pending-report.json", {"overlayGeneration": "old"})
            def accept(*args, **kwargs):
                traffic.atomic_json_state(root / "pending-report.json", {"overlayGeneration": "new"})
            with patch.object(traffic, "post_report", side_effect=accept):
                self.assertTrue(traffic.deliver_pending_report(
                    {"SIM_TRAFFIC_FEED_BASE_URL": "http://synthetic", "SIM_TRAFFIC_CONTROL_TOKEN": "test"}, root))
            self.assertEqual(json.loads((root / "pending-report.json").read_text())["overlayGeneration"], "new")

    def test_missing_or_corrupt_ledger_clears_unknown_records_in_place(self):
        for corruption in (None, "[", "{}", "[true]", "[-1]"):
            with self.subTest(corruption=corruption), tempfile.TemporaryDirectory() as directory, \
                    patch.object(traffic.time, "time", return_value=NOW):
                root = Path(directory)
                path = root / "traffic.tar"
                archive(path)
                traffic.apply_speeds(path, root / "applied-edges.json", {EDGE: (30, 80)})
                inode = path.stat().st_ino
                if corruption is None:
                    (root / "applied-edges.json").unlink()
                else:
                    (root / "applied-edges.json").write_text(corruption)
                traffic.atomic_json_state(root / "last-applied.json", {"nextRecomputeAtEpoch": NOW + 100})
                self.assertTrue(traffic.clear_expired_runtime(root, 300))
                self.assertEqual(path.stat().st_ino, inode)
                offset, _ = traffic.edge_record_location(EDGE, traffic.traffic_tile_offsets(path))
                with path.open("rb") as stream:
                    stream.seek(offset)
                    self.assertEqual(stream.read(8), bytes(8))

    def test_ledger_atomic_failure_preserves_last_valid_json(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "applied-edges.json"
            traffic.atomic_json_state(path, [EDGE])
            with patch.object(traffic.os, "replace", side_effect=OSError("synthetic interruption")):
                with self.assertRaises(OSError):
                    traffic.atomic_json_state(path, [EDGE, EDGE + (1 << 25)])
            self.assertEqual(traffic.read_edge_ledger(path), [EDGE])
            self.assertEqual(list(path.parent.glob("*.tmp")), [])

    def test_interrupted_global_clear_keeps_ledger_invalid_for_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "traffic.tar"
            state = root / "applied-edges.json"
            archive(path)
            traffic.apply_speeds(path, state, {EDGE: (30, 80)})
            state.write_text("[")
            original_open = Path.open
            class BrokenWrite:
                def __init__(self, stream): self.stream = stream
                def __enter__(self): return self
                def __exit__(self, *args): self.stream.close()
                def seek(self, *args): return self.stream.seek(*args)
                def write(self, value): raise OSError("synthetic crash during global clear")
            def open_with_fault(value, mode="r", *args, **kwargs):
                stream = original_open(value, mode, *args, **kwargs)
                return BrokenWrite(stream) if value == path and mode == "r+b" else stream
            with patch.object(Path, "open", open_with_fault):
                with self.assertRaisesRegex(OSError, "global clear"):
                    traffic.apply_speeds(path, state, {})
            self.assertIsNone(traffic.read_edge_ledger(state))
            self.assertTrue(traffic.clear_expired_runtime(root, 300))
            offset, _ = traffic.edge_record_location(EDGE, traffic.traffic_tile_offsets(path))
            with path.open("rb") as stream:
                stream.seek(offset)
                self.assertEqual(stream.read(8), bytes(8))

    def test_blocked_report_thread_does_not_block_local_expiry(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(traffic.time, "time", return_value=NOW):
            root = Path(directory)
            archive(root / "traffic.tar")
            traffic.apply_speeds(root / "traffic.tar", root / "applied-edges.json", {EDGE: (30, 80)})
            traffic.atomic_json_state(root / "pending-report.json", {"overlayGeneration": "old"})
            started, release, stop = threading.Event(), threading.Event(), threading.Event()
            def blocked(*args, **kwargs):
                started.set()
                release.wait(3)
            with patch.object(traffic, "deliver_pending_report", side_effect=blocked):
                worker = threading.Thread(target=traffic.expiry_report_loop, args=({}, root, stop), daemon=True)
                worker.start()
                try:
                    self.assertTrue(started.wait(1))
                    self.assertTrue(traffic.clear_expired_runtime(root, 300))
                    self.assertEqual(traffic.read_edge_ledger(root / "applied-edges.json"), [])
                finally:
                    stop.set()
                    release.set()
                    worker.join(1)

    def test_apply_commits_deadline_before_failed_report(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(traffic.time, "time", return_value=NOW):
            root = Path(directory)
            archive(root / "traffic.tar")
            traffic.write_gzip_json(traffic.mapping_path(root, "synthetic-dataset", "static", traffic.MATCHER_VERSION), MAPPING)
            feed = {"contractVersion": "sim-valhalla-live-traffic-feed-v1", "staticRevision": "static",
                    "dynamicRevision": "dynamic", "maxAgeSeconds": 300, "flows": [flow()]}
            config = {"SIM_TRAFFIC_FEED_BASE_URL": "http://synthetic", "SIM_TRAFFIC_CONTROL_TOKEN": "test",
                      "TRAFFIC_RUNTIME_DIR": str(root), "TRAFFIC_MAPPING_CACHE_DIR": str(root)}
            def outage(*args, **kwargs):
                state = json.loads((root / "last-applied.json").read_text())
                self.assertEqual(state["nextRecomputeAtEpoch"], NOW + 5)
                self.assertEqual(state["report"]["status"], "current")
                raise RuntimeError("synthetic report outage")
            with patch.object(traffic, "request_json", return_value=(200, feed)), \
                    patch.object(traffic, "routing_dataset", return_value="synthetic-dataset"), \
                    patch.object(traffic, "post_report", side_effect=outage):
                with self.assertRaisesRegex(RuntimeError, "report outage"):
                    traffic.run(config)
            self.assertTrue((root / "pending-report.json").exists())
            with patch.object(traffic.time, "time", return_value=NOW + 5):
                self.assertTrue(traffic.clear_expired_runtime(root, 300))
            self.assertEqual(json.loads((root / "pending-report.json").read_text())["status"], "degraded")

    def test_report_contract_requires_204(self):
        with patch.object(traffic, "request_json", return_value=(204, None)):
            traffic.post_report("http://synthetic", "test", {})
        with patch.object(traffic, "request_json", return_value=(400, {})):
            with self.assertRaisesRegex(RuntimeError, "HTTP 400"):
                traffic.post_report("http://synthetic", "test", {})


if __name__ == "__main__":
    unittest.main()
