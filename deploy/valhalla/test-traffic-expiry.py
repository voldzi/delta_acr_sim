#!/usr/bin/env python3
"""Synthetic traffic archive acceptance; no licensed or provider data needed."""
from __future__ import annotations

from io import BytesIO
import copy
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


def archive(path, edge_count=2):
    header = struct.pack("<2Q4I", 2 | (20 << 3), 0, edge_count, 3, 0, 0)
    with tarfile.open(path, "w") as tar:
        info = tarfile.TarInfo("2/000/000/020.gph")
        info.size = len(header) + edge_count * 8
        tar.addfile(info, BytesIO(header + b"\0" * (edge_count * 8)))


def runtime_revision(applied=NOW - 10, deadline=NOW + 5):
    return {"routingDataset": "synthetic-dataset", "staticRevision": "static", "dynamicRevision": "dynamic",
            "matcherVersion": traffic.MATCHER_VERSION, "appliedAtEpoch": applied,
            "nextRecomputeAtEpoch": deadline,
            "report": {"routingDataset": "synthetic-dataset", "staticRevision": "static", "dynamicRevision": "dynamic",
                       "status": "current", "updatedAt": traffic.utc_iso(applied), "usableUntil": traffic.utc_iso(deadline),
                       "overlayGeneration": "synthetic-generation", "mappedSegmentCount": 1, "mappedEdgeCount": 1,
                       "appliedFlowCount": 1, "appliedEdgeCount": 1, "mappingCoveragePercent": 100}}


def feed_and_invalidation_status(root, feed):
    def request(url, **kwargs):
        if url.endswith("/status"):
            return 200, traffic.read_json_state(root / "pending-report.json")
        return 200, feed
    return request


def run_fixture(root, old_deadline=NOW + 100):
    archive(root / "traffic.tar")
    traffic.apply_speeds(root / "traffic.tar", root / "applied-edges.json", {EDGE: (30, 80)})
    old = runtime_revision(deadline=old_deadline)
    traffic.atomic_json_state(root / "last-applied.json", old)
    traffic.atomic_json_state(root / "pending-report.json", old["report"])
    traffic.write_gzip_json(traffic.mapping_path(root, "synthetic-dataset", "static", traffic.MATCHER_VERSION), MAPPING)
    feed = {"contractVersion": "sim-valhalla-live-traffic-feed-v1", "staticRevision": "static",
            "dynamicRevision": "new-dynamic", "maxAgeSeconds": 300, "flows": [flow(averageSpeedKph=10)]}
    config = {"SIM_TRAFFIC_FEED_BASE_URL": "http://synthetic", "SIM_TRAFFIC_CONTROL_TOKEN": "test",
              "TRAFFIC_RUNTIME_DIR": str(root), "TRAFFIC_MAPPING_CACHE_DIR": str(root)}
    return feed, config, old


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
            old = runtime_revision(deadline=NOW)
            old["report"]["overlayGeneration"] = "old"
            traffic.atomic_json_state(root / "last-applied.json", old)
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
            with patch.object(traffic, "read_json_state", side_effect=[runtime_revision(deadline=NOW - 1),
                                                                     runtime_revision(deadline=NOW + 5)]):
                self.assertFalse(traffic.clear_expired_runtime(root, 300))
            self.assertEqual(json.loads((root / "applied-edges.json").read_text()), [EDGE])

    def test_runtime_deadline_requires_acknowledged_bounded_generation(self):
        valid = runtime_revision()
        self.assertEqual(traffic.trustworthy_runtime_deadline(valid, 300, NOW), NOW + 5)
        self.assertTrue(traffic.reusable_traffic_revision(valid, "synthetic-dataset", "static", "dynamic", traffic.MATCHER_VERSION, NOW, 300, [EDGE]))
        mutations = [lambda value: value.pop("report"),
                     lambda value: value.update(writeState="in_progress"),
                     lambda value: value.update(report=None),
                     lambda value: value.update(appliedAtEpoch=float("nan")),
                     lambda value: value.update(appliedAtEpoch=float("inf")),
                     lambda value: value.update(appliedAtEpoch=True),
                     lambda value: value.update(appliedAtEpoch=NOW + 31),
                     lambda value: value.update(nextRecomputeAtEpoch=NOW + 301),
                     lambda value: value.update(nextRecomputeAtEpoch=float("inf")),
                     lambda value: value["report"].pop("overlayGeneration"),
                     lambda value: value["report"].update(overlayGeneration="with spaces"),
                     lambda value: value["report"].pop("usableUntil"),
                     lambda value: value["report"].update(usableUntil="invalid"),
                     lambda value: value["report"].update(updatedAt="2026-10-01 12:00:00Z"),
                     lambda value: value["report"].update(updatedAt=traffic.utc_iso(NOW)),
                     lambda value: value["report"].update(usableUntil=traffic.utc_iso(NOW + 6)),
                     lambda value: value["report"].update(routingDataset="other-graph"),
                     lambda value: value["report"].update(staticRevision="other-static"),
                     lambda value: value["report"].update(dynamicRevision="other-dynamic"),
                     lambda value: value["report"].update(appliedEdgeCount=0),
                     lambda value: value["report"].update(appliedFlowCount=0),
                     lambda value: value["report"].update(status="degraded"),
                     lambda value: value["report"].update(mappedEdgeCount=True),
                     lambda value: value["report"].update(mappingCoveragePercent=101),
                     lambda value: value["report"].update(sourceObservedAt="2026-10-01 12:00:00Z"),
                     lambda value: value["report"].update(sourceObservedAt=traffic.utc_iso(NOW + 31))]
        for mutate in mutations:
            state = copy.deepcopy(valid)
            mutate(state)
            with self.subTest(state=state):
                self.assertEqual(traffic.trustworthy_runtime_deadline(state, 300, NOW), 0)
                self.assertFalse(traffic.reusable_traffic_revision(state, "synthetic-dataset", "static", "dynamic", traffic.MATCHER_VERSION, NOW, 300, [EDGE]))
        self.assertFalse(traffic.reusable_traffic_revision(valid, "synthetic-dataset", "static", "dynamic", traffic.MATCHER_VERSION, NOW, 10, [EDGE]))
        invalid_clear = copy.deepcopy(valid)
        invalid_clear["report"].update(status="degraded", appliedEdgeCount=0, appliedFlowCount=0)
        self.assertEqual(traffic.trustworthy_runtime_deadline(invalid_clear, 300, NOW), 0)

    def test_legacy_or_far_future_state_clears_immediately_once(self):
        legacy = runtime_revision()
        del legacy["report"]
        malformed = runtime_revision()
        malformed["nextRecomputeAtEpoch"] = NOW + 10_000
        malformed["report"]["usableUntil"] = traffic.utc_iso(NOW + 10_000)
        for state in (legacy, malformed):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as directory, \
                    patch.object(traffic.time, "time", return_value=NOW):
                root = Path(directory)
                archive(root / "traffic.tar")
                traffic.apply_speeds(root / "traffic.tar", root / "applied-edges.json", {EDGE: (30, 80)})
                traffic.atomic_json_state(root / "last-applied.json", state)
                self.assertTrue(traffic.clear_expired_runtime(root, 300))
                self.assertEqual(traffic.read_edge_ledger(root / "applied-edges.json"), [])
                updated = (root / "last-applied.json").read_bytes()
                with patch.object(traffic, "apply_speeds", side_effect=AssertionError("empty archive must not be rewritten")):
                    self.assertFalse(traffic.clear_expired_runtime(root, 300))
                self.assertEqual((root / "last-applied.json").read_bytes(), updated)

    def test_valid_runtime_deadline_and_expired_clear_contract(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(traffic.time, "time", return_value=NOW):
            root = Path(directory)
            archive(root / "traffic.tar")
            traffic.apply_speeds(root / "traffic.tar", root / "applied-edges.json", {EDGE: (30, 80)})
            traffic.atomic_json_state(root / "last-applied.json", runtime_revision())
            self.assertFalse(traffic.clear_expired_runtime(root, 300))
            with patch.object(traffic.time, "time", return_value=NOW + 5):
                self.assertTrue(traffic.clear_expired_runtime(root, 300))
            clear = traffic.read_json_state(root / "last-applied.json")
            self.assertEqual(traffic.trustworthy_runtime_deadline(clear, 300, NOW + 5), NOW + 5)
            self.assertTrue(traffic.reusable_traffic_revision(clear, "synthetic-dataset", "static", "dynamic", traffic.MATCHER_VERSION, NOW + 5, 300, []))

    def test_expired_zero_report_reuse_requires_exact_empty_valid_ledger(self):
        clear = runtime_revision(applied=NOW - 5, deadline=NOW - 5)
        clear["report"].update(status="degraded", appliedFlowCount=0, appliedEdgeCount=0)
        for ledger, expected in (([], True), ([EDGE], False), (None, False), ([True], False), ([-1], False)):
            with self.subTest(ledger=ledger):
                self.assertEqual(traffic.reusable_traffic_revision(clear, "synthetic-dataset", "static", "dynamic", traffic.MATCHER_VERSION, NOW, 300, ledger), expected)
        malformed = copy.deepcopy(clear)
        malformed["report"].pop("overlayGeneration")
        self.assertFalse(traffic.reusable_traffic_revision(malformed, "synthetic-dataset", "static", "dynamic", traffic.MATCHER_VERSION, NOW, 300, []))
        far_future = copy.deepcopy(clear)
        far_future.update(appliedAtEpoch=NOW + 31, nextRecomputeAtEpoch=NOW + 31)
        far_future["report"].update(updatedAt=traffic.utc_iso(NOW + 31), usableUntil=traffic.utc_iso(NOW + 31))
        self.assertFalse(traffic.reusable_traffic_revision(far_future, "synthetic-dataset", "static", "dynamic", traffic.MATCHER_VERSION, NOW, 300, []))
        self.assertFalse(traffic.reusable_traffic_revision(clear, "other-graph", "static", "dynamic", traffic.MATCHER_VERSION, NOW, 300, []))
        self.assertFalse(traffic.reusable_traffic_revision(clear, "synthetic-dataset", "static", "changed", traffic.MATCHER_VERSION, NOW, 300, []))

    def test_unchanged_expired_zero_cohort_does_not_rewrite_archive_or_report(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(traffic.time, "time", return_value=NOW):
            root = Path(directory)
            archive(root / "traffic.tar")
            traffic.apply_speeds(root / "traffic.tar", root / "applied-edges.json", {})
            clear = runtime_revision(applied=NOW - 5, deadline=NOW - 5)
            clear["report"].update(status="degraded", appliedFlowCount=0, appliedEdgeCount=0)
            traffic.atomic_json_state(root / "last-applied.json", clear)
            traffic.write_gzip_json(traffic.mapping_path(root, "synthetic-dataset", "static", traffic.MATCHER_VERSION), MAPPING)
            feed = {"contractVersion": "sim-valhalla-live-traffic-feed-v1", "staticRevision": "static",
                    "dynamicRevision": "dynamic", "maxAgeSeconds": 300, "flows": [flow(validUntil=traffic.utc_iso(NOW - 1))]}
            config = {"SIM_TRAFFIC_FEED_BASE_URL": "http://synthetic", "SIM_TRAFFIC_CONTROL_TOKEN": "test",
                      "TRAFFIC_RUNTIME_DIR": str(root), "TRAFFIC_MAPPING_CACHE_DIR": str(root)}
            before = (root / "last-applied.json").read_bytes()
            with patch.object(traffic, "request_json", return_value=(200, feed)), \
                    patch.object(traffic, "routing_dataset", return_value="synthetic-dataset"), \
                    patch.object(traffic, "apply_speeds", side_effect=AssertionError("unchanged empty cohort must not write")), \
                    patch.object(traffic, "post_report", side_effect=AssertionError("no new generation report needed")):
                self.assertEqual(traffic.run(config), 0)
            self.assertEqual((root / "last-applied.json").read_bytes(), before)

    def test_same_revision_mixed_expiry_reapplies_still_fresh_peer(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(traffic.time, "time", return_value=NOW):
            root = Path(directory)
            archive(root / "traffic.tar")
            traffic.apply_speeds(root / "traffic.tar", root / "applied-edges.json", {})
            clear = runtime_revision(applied=NOW - 5, deadline=NOW - 5)
            clear["report"].update(status="degraded", appliedFlowCount=0, appliedEdgeCount=0)
            traffic.atomic_json_state(root / "last-applied.json", clear)
            mapping = copy.deepcopy(MAPPING)
            mapping.update(sourceSegmentCount=2, mappedSegmentCount=2)
            mapping["mapping"]["fresh-peer"] = [{"id": EDGE - (1 << 25), "baselineSpeedKph": 80}]
            traffic.write_gzip_json(traffic.mapping_path(root, "synthetic-dataset", "static", traffic.MATCHER_VERSION), mapping)
            feed = {"contractVersion": "sim-valhalla-live-traffic-feed-v1", "staticRevision": "static",
                    "dynamicRevision": "dynamic", "maxAgeSeconds": 300,
                    "flows": [flow(validUntil=traffic.utc_iso(NOW - 1)),
                              flow(messageId="fresh-peer", validUntil=traffic.utc_iso(NOW + 30))]}
            config = {"SIM_TRAFFIC_FEED_BASE_URL": "http://synthetic", "SIM_TRAFFIC_CONTROL_TOKEN": "test",
                      "TRAFFIC_RUNTIME_DIR": str(root), "TRAFFIC_MAPPING_CACHE_DIR": str(root)}
            with patch.object(traffic, "request_json", side_effect=feed_and_invalidation_status(root, feed)), \
                    patch.object(traffic, "routing_dataset", return_value="synthetic-dataset"), \
                    patch.object(traffic, "post_report") as publish:
                self.assertEqual(traffic.run(config), 0)
            self.assertEqual(publish.call_count, 2)
            state = traffic.read_json_state(root / "last-applied.json")
            self.assertEqual(state["report"]["status"], "current")
            self.assertEqual(state["report"]["appliedEdgeCount"], 1)
            self.assertEqual(state["nextRecomputeAtEpoch"], NOW + 30)
            self.assertEqual(traffic.read_edge_ledger(root / "applied-edges.json"), [EDGE - (1 << 25)])

    def test_zero_reuse_gate_scans_all_fresh_positive_flows(self):
        rejected = [flow(validUntil=traffic.utc_iso(NOW)), flow(averageSpeedKph=0),
                    flow(averageSpeedKph=float("nan")), flow(averageSpeedKph=float("inf")),
                    flow(observedAt=None), flow(observedAt=traffic.utc_iso(NOW + 31)), flow(validUntil="bad")]
        self.assertFalse(traffic.feed_has_usable_speeds({"flows": rejected}, 300, NOW))
        self.assertTrue(traffic.feed_has_usable_speeds({"flows": [*rejected, flow(messageId="unmapped")]}, 300, NOW))

    def test_empty_update_clears_all_records_with_bounded_chunk_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path, state = root / "traffic.tar", root / "applied-edges.json"
            archive(path, edge_count=20_000)
            traffic.apply_speeds(path, state, {EDGE: (30, 80), EDGE - (1 << 25): (40, 80)})
            traffic.atomic_json_state(state, [])
            inode = path.stat().st_ino
            original_open = Path.open
            writes = []
            class CountingWrites:
                def __init__(self, stream): self.stream = stream
                def __enter__(self): return self
                def __exit__(self, *args): self.stream.close()
                def seek(self, *args): return self.stream.seek(*args)
                def write(self, value):
                    writes.append(len(value))
                    return self.stream.write(value)
            def open_counted(value, mode="r", *args, **kwargs):
                stream = original_open(value, mode, *args, **kwargs)
                return CountingWrites(stream) if value == path and mode == "r+b" else stream
            with patch.object(Path, "open", open_counted), \
                    patch.object(traffic, "edge_record_location", side_effect=AssertionError("global clear must not seek per edge")):
                self.assertEqual(traffic.apply_speeds(path, state, {}), 0)
            self.assertEqual(path.stat().st_ino, inode)
            self.assertEqual(writes, [65_536, 65_536, 28_928, 8])
            tile_offset, tile_size = next(iter(traffic.traffic_tile_offsets(path).values()))
            with path.open("rb") as stream:
                stream.seek(tile_offset + traffic.TRAFFIC_HEADER_SIZE)
                self.assertEqual(stream.read(tile_size - traffic.TRAFFIC_HEADER_SIZE), bytes(160_000))
            self.assertEqual(traffic.read_edge_ledger(state), [])

    def test_legacy_empty_ledger_is_cleared_once_and_report_canonicalized(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(traffic.time, "time", return_value=NOW):
            root = Path(directory)
            archive(root / "traffic.tar")
            traffic.apply_speeds(root / "traffic.tar", root / "applied-edges.json", {EDGE: (30, 80)})
            traffic.atomic_json_state(root / "applied-edges.json", [])
            legacy = runtime_revision()
            legacy.pop("report")
            traffic.atomic_json_state(root / "last-applied.json", legacy)
            self.assertTrue(traffic.clear_expired_runtime(root, 300))
            clear = traffic.read_json_state(root / "last-applied.json")
            self.assertEqual(traffic.trustworthy_runtime_deadline(clear, 300, NOW), NOW)
            self.assertEqual(clear["report"]["mappedEdgeCount"], 0)
            self.assertEqual(clear["report"]["mappingCoveragePercent"], 0)
            self.assertNotIn("physicalClearProof", clear)
            with patch.object(traffic, "apply_speeds", side_effect=AssertionError("strict zero state must not write")):
                self.assertFalse(traffic.clear_expired_runtime(root, 300))

    def test_physical_clear_proof_without_parent_ids_is_exact_and_no_io_on_repeat(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(traffic.time, "time", return_value=NOW):
            root = Path(directory)
            path, state = root / "traffic.tar", root / "applied-edges.json"
            archive(path)
            traffic.apply_speeds(path, state, {EDGE: (30, 80)})
            traffic.atomic_json_state(state, [])
            traffic.atomic_json_state(root / "pending-report.json", {"status": "current"})
            self.assertTrue(traffic.clear_expired_runtime(root, 300))
            clear = traffic.read_json_state(root / "last-applied.json")
            self.assertEqual(clear["physicalClearProof"], traffic.physical_clear_identity(path))
            self.assertNotIn("report", clear)
            self.assertFalse((root / "pending-report.json").exists())
            saved = (root / "last-applied.json").read_bytes()
            with patch.object(traffic, "apply_speeds", side_effect=AssertionError("proof must avoid global writes")):
                self.assertFalse(traffic.clear_expired_runtime(root, 300))
            self.assertEqual((root / "last-applied.json").read_bytes(), saved)
            status = path.stat()
            traffic.os.utime(path, ns=(status.st_atime_ns, status.st_mtime_ns + 1))
            self.assertTrue(traffic.clear_expired_runtime(root, 300))
            replacement = root / "replacement.tar"
            archive(replacement)
            traffic.os.replace(replacement, path)
            self.assertTrue(traffic.clear_expired_runtime(root, 300))
            self.assertEqual(traffic.read_json_state(root / "last-applied.json")["physicalClearProof"], traffic.physical_clear_identity(path))

    def test_physical_proof_never_overrides_nonempty_invalid_ledger_or_force(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(traffic.time, "time", return_value=NOW):
            root = Path(directory)
            path, state = root / "traffic.tar", root / "applied-edges.json"
            archive(path)
            self.assertTrue(traffic.clear_expired_runtime(root, 300))
            traffic.atomic_json_state(state, [EDGE])
            self.assertTrue(traffic.clear_expired_runtime(root, 300))
            state.write_text("[")
            self.assertTrue(traffic.clear_expired_runtime(root, 300))
            self.assertTrue(traffic.clear_expired_runtime(root, 300, force=True))

    def test_interrupted_chunk_clear_retries_for_valid_empty_or_nonempty_ledger(self):
        for ledger in ([], [EDGE]):
            with self.subTest(ledger=ledger), tempfile.TemporaryDirectory() as directory, \
                    patch.object(traffic.time, "time", return_value=NOW):
                root = Path(directory)
                path, state = root / "traffic.tar", root / "applied-edges.json"
                archive(path)
                traffic.apply_speeds(path, state, {EDGE: (30, 80)})
                traffic.atomic_json_state(state, ledger)
                original_open = Path.open
                class BrokenWrite:
                    def __init__(self, stream): self.stream = stream
                    def __enter__(self): return self
                    def __exit__(self, *args): self.stream.close()
                    def seek(self, *args): return self.stream.seek(*args)
                    def write(self, value):
                        self.stream.write(value[:8])
                        raise OSError("synthetic chunk interruption")
                def open_with_fault(value, mode="r", *args, **kwargs):
                    stream = original_open(value, mode, *args, **kwargs)
                    return BrokenWrite(stream) if value == path and mode == "r+b" else stream
                with patch.object(Path, "open", open_with_fault):
                    with self.assertRaisesRegex(OSError, "chunk interruption"):
                        traffic.clear_expired_runtime(root, 300)
                self.assertEqual(traffic.read_edge_ledger(state), ledger)
                self.assertNotIn("physicalClearProof", traffic.read_json_state(root / "last-applied.json"))
                self.assertTrue(traffic.clear_expired_runtime(root, 300))
                tile_offset, tile_size = next(iter(traffic.traffic_tile_offsets(path).values()))
                with path.open("rb") as stream:
                    stream.seek(tile_offset + traffic.TRAFFIC_HEADER_SIZE)
                    self.assertEqual(stream.read(tile_size - traffic.TRAFFIC_HEADER_SIZE), bytes(16))

    def test_future_clear_report_cannot_authorize_nonempty_archive(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(traffic.time, "time", return_value=NOW):
            root = Path(directory)
            archive(root / "traffic.tar")
            traffic.apply_speeds(root / "traffic.tar", root / "applied-edges.json", {EDGE: (30, 80)})
            clear = runtime_revision(applied=NOW + 1, deadline=NOW + 1)
            clear["report"].update(status="degraded", appliedFlowCount=0, appliedEdgeCount=0)
            self.assertEqual(traffic.trustworthy_runtime_deadline(clear, 300, NOW), NOW + 1)
            traffic.atomic_json_state(root / "last-applied.json", clear)
            self.assertTrue(traffic.clear_expired_runtime(root, 300))
            self.assertEqual(traffic.read_edge_ledger(root / "applied-edges.json"), [])

    def test_run_rechecks_runtime_with_stricter_feed_age(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(traffic.time, "time", return_value=NOW):
            root = Path(directory)
            archive(root / "traffic.tar")
            traffic.apply_speeds(root / "traffic.tar", root / "applied-edges.json", {EDGE: (30, 80)})
            traffic.atomic_json_state(root / "last-applied.json", runtime_revision(deadline=NOW + 500))
            traffic.write_gzip_json(traffic.mapping_path(root, "synthetic-dataset", "static", traffic.MATCHER_VERSION), MAPPING)
            feed = {"contractVersion": "sim-valhalla-live-traffic-feed-v1", "staticRevision": "static",
                    "dynamicRevision": "dynamic", "maxAgeSeconds": 300, "flows": [flow()]}
            config = {"SIM_TRAFFIC_FEED_BASE_URL": "http://synthetic", "SIM_TRAFFIC_CONTROL_TOKEN": "test",
                      "TRAFFIC_RUNTIME_DIR": str(root), "TRAFFIC_MAPPING_CACHE_DIR": str(root),
                      "TRAFFIC_MAX_AGE_SECONDS": "1800"}
            with patch.object(traffic, "request_json", side_effect=feed_and_invalidation_status(root, feed)), \
                    patch.object(traffic, "routing_dataset", return_value="synthetic-dataset"), \
                    patch.object(traffic, "post_report") as publish:
                self.assertEqual(traffic.run(config), 0)
            self.assertEqual(publish.call_count, 2)
            state = traffic.read_json_state(root / "last-applied.json")
            self.assertEqual(state["nextRecomputeAtEpoch"], NOW + 5)
            self.assertNotEqual(state["report"]["overlayGeneration"], "synthetic-generation")

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
                report = args[2]
                if report["status"] == "degraded":
                    self.assertEqual(report["appliedEdgeCount"], 0)
                    return
                state = json.loads((root / "last-applied.json").read_text())
                self.assertEqual(state["nextRecomputeAtEpoch"], NOW + 5)
                self.assertEqual(state["report"]["status"], "current")
                raise RuntimeError("synthetic report outage")
            with patch.object(traffic, "request_json", side_effect=feed_and_invalidation_status(root, feed)), \
                    patch.object(traffic, "routing_dataset", return_value="synthetic-dataset"), \
                    patch.object(traffic, "post_report", side_effect=outage):
                with self.assertRaisesRegex(RuntimeError, "report outage"):
                    traffic.run(config)
            self.assertTrue((root / "pending-report.json").exists())
            with patch.object(traffic.time, "time", return_value=NOW + 5):
                self.assertTrue(traffic.clear_expired_runtime(root, 300))
            self.assertEqual(json.loads((root / "pending-report.json").read_text())["status"], "degraded")

    def test_interrupted_positive_generation_cannot_inherit_old_current_deadline(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(traffic.time, "time", return_value=NOW):
            root = Path(directory)
            path, ledger = root / "traffic.tar", root / "applied-edges.json"
            archive(path)
            traffic.apply_speeds(path, ledger, {EDGE: (30, 80)})
            old = runtime_revision(deadline=NOW + 100)
            old["physicalClearProof"] = traffic.physical_clear_identity(path)
            traffic.atomic_json_state(root / "last-applied.json", old)
            traffic.atomic_json_state(root / "pending-report.json", old["report"])
            traffic.write_gzip_json(traffic.mapping_path(root, "synthetic-dataset", "static", traffic.MATCHER_VERSION), MAPPING)
            feed = {"contractVersion": "sim-valhalla-live-traffic-feed-v1", "staticRevision": "static",
                    "dynamicRevision": "new-dynamic", "maxAgeSeconds": 300,
                    "flows": [flow(averageSpeedKph=10)]}
            config = {"SIM_TRAFFIC_FEED_BASE_URL": "http://synthetic", "SIM_TRAFFIC_CONTROL_TOKEN": "test",
                      "TRAFFIC_RUNTIME_DIR": str(root), "TRAFFIC_MAPPING_CACHE_DIR": str(root)}
            original_open = Path.open
            new_word = struct.pack("<Q", traffic.traffic_word(10, 80))
            class BrokenPositiveWrite:
                def __init__(self, stream): self.stream = stream
                def __enter__(self): return self
                def __exit__(self, *args): self.stream.close()
                def seek(self, *args): return self.stream.seek(*args)
                def write(self, value):
                    written = self.stream.write(value)
                    if value == new_word:
                        raise OSError("synthetic interruption after new positive speed")
                    return written
            def open_with_fault(value, mode="r", *args, **kwargs):
                stream = original_open(value, mode, *args, **kwargs)
                return BrokenPositiveWrite(stream) if value == path and mode == "r+b" else stream
            with patch.object(traffic, "request_json", side_effect=feed_and_invalidation_status(root, feed)), \
                    patch.object(traffic, "routing_dataset", return_value="synthetic-dataset"), \
                    patch.object(traffic, "post_report"), \
                    patch.object(Path, "open", open_with_fault):
                with self.assertRaisesRegex(OSError, "new positive speed"):
                    traffic.run(config)
            marker = traffic.read_json_state(root / "last-applied.json")
            self.assertEqual(marker["writeState"], "in_progress")
            for name in ("report", "physicalClearProof", "appliedAtEpoch", "nextRecomputeAtEpoch"):
                self.assertNotIn(name, marker)
            self.assertFalse((root / "pending-report.json").exists())
            self.assertEqual(traffic.trustworthy_runtime_deadline(marker, 300, NOW), 0)
            with patch.object(traffic.time, "time", return_value=NOW + 6):
                self.assertTrue(traffic.clear_expired_runtime(root, 300))
            self.assertEqual(traffic.read_edge_ledger(ledger), [])
            offset, _ = traffic.edge_record_location(EDGE, traffic.traffic_tile_offsets(path))
            with path.open("rb") as stream:
                stream.seek(offset)
                self.assertEqual(stream.read(8), bytes(8))
            cleared = traffic.read_json_state(root / "last-applied.json")
            self.assertNotIn("writeState", cleared)
            self.assertEqual(cleared["report"]["status"], "degraded")

    def test_runtime_invalidation_failure_aborts_before_archive_write(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(traffic.time, "time", return_value=NOW):
            root = Path(directory)
            path, ledger = root / "traffic.tar", root / "applied-edges.json"
            archive(path)
            traffic.apply_speeds(path, ledger, {EDGE: (30, 80)})
            old = runtime_revision(deadline=NOW + 100)
            traffic.atomic_json_state(root / "last-applied.json", old)
            before = path.read_bytes()
            original_atomic = traffic.atomic_json_state
            def invalidation_failure(value, state):
                if value == root / "last-applied.json":
                    raise OSError("synthetic runtime marker failure")
                original_atomic(value, state)
            with patch.object(traffic, "atomic_json_state", side_effect=invalidation_failure):
                with self.assertRaisesRegex(OSError, "runtime marker failure"):
                    traffic.apply_speeds(path, ledger, {EDGE: (10, 80)})
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(traffic.read_json_state(root / "last-applied.json"), old)

    def test_interrupted_forced_clear_cannot_reuse_old_current_report(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(traffic.time, "time", return_value=NOW):
            root = Path(directory)
            path, ledger = root / "traffic.tar", root / "applied-edges.json"
            archive(path)
            traffic.apply_speeds(path, ledger, {EDGE: (30, 80)})
            traffic.atomic_json_state(root / "last-applied.json", runtime_revision(deadline=NOW + 100))
            original_open = Path.open
            class BrokenClear:
                def __init__(self, stream): self.stream = stream
                def __enter__(self): return self
                def __exit__(self, *args): self.stream.close()
                def seek(self, *args): return self.stream.seek(*args)
                def write(self, value):
                    self.stream.write(value[:8])
                    raise OSError("synthetic forced clear interruption")
            def open_with_fault(value, mode="r", *args, **kwargs):
                stream = original_open(value, mode, *args, **kwargs)
                return BrokenClear(stream) if value == path and mode == "r+b" else stream
            with patch.object(Path, "open", open_with_fault):
                with self.assertRaisesRegex(OSError, "forced clear interruption"):
                    traffic.clear_expired_runtime(root, 300, force=True)
            marker = traffic.read_json_state(root / "last-applied.json")
            self.assertEqual(marker["writeState"], "in_progress")
            self.assertEqual(traffic.trustworthy_runtime_deadline(marker, 300, NOW), 0)
            self.assertTrue(traffic.clear_expired_runtime(root, 300))

    def test_positive_apply_requires_status_confirmed_ack_outside_archive_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            instant = [NOW]
            with patch.object(traffic.time, "time", side_effect=lambda: instant[0]):
                feed, config, old = run_fixture(root)
                server_report = copy.deepcopy(old["report"])
                events = []
                original_apply = traffic.apply_speeds
                stale_delivered = threading.Event()
                def assert_lock_available():
                    with (root / "update.lock").open("r+") as independent:
                        traffic.fcntl.flock(independent, traffic.fcntl.LOCK_EX | traffic.fcntl.LOCK_NB)
                def request(url, **kwargs):
                    nonlocal server_report
                    if url.endswith("/report"):
                        assert_lock_available()
                        value = kwargs["payload"]
                        if traffic.parse_iso_timestamp(value["updatedAt"]) > traffic.parse_iso_timestamp(server_report["updatedAt"]):
                            server_report = copy.deepcopy(value)
                        if value["status"] == "degraded":
                            events.append("zero_ack")
                            self.assertEqual(value["appliedEdgeCount"], 0)
                            self.assertEqual(traffic.read_json_state(root / "pending-report.json"), value)
                            # A previously captured old current report can finish
                            # late; monotonic SIM ordering must not resurrect it.
                            def deliver_old():
                                traffic.post_report("http://synthetic", "test", old["report"])
                                stale_delivered.set()
                            worker = threading.Thread(target=deliver_old)
                            worker.start()
                            worker.join(1)
                            self.assertFalse(worker.is_alive(), "network callback held archive lock")
                            self.assertTrue(stale_delivered.is_set())
                        elif value["overlayGeneration"] != old["report"]["overlayGeneration"]:
                            events.append("current_report")
                        return 204, None
                    if url.endswith("/status"):
                        assert_lock_available()
                        events.append("zero_status_confirmed")
                        self.assertEqual(server_report["status"], "degraded")
                        instant[0] = NOW + 1
                        return 200, copy.deepcopy(server_report)
                    return 200, feed
                def apply(path, state, speeds):
                    if speeds:
                        self.assertEqual(events, ["zero_ack", "zero_status_confirmed"])
                        self.assertEqual(server_report["status"], "degraded")
                        events.append("positive_apply")
                    return original_apply(path, state, speeds)
                with patch.object(traffic, "request_json", side_effect=request), \
                        patch.object(traffic, "routing_dataset", return_value="synthetic-dataset"), \
                        patch.object(traffic, "apply_speeds", side_effect=apply):
                    self.assertEqual(traffic.run(config), 0)
                self.assertEqual(events, ["zero_ack", "zero_status_confirmed", "positive_apply", "current_report"])
                self.assertEqual(server_report["status"], "current")
                self.assertEqual(server_report["dynamicRevision"], "new-dynamic")

    def test_invalidation_http_error_or_timeout_never_applies_positive_speeds(self):
        for failure in (503, 409, TimeoutError("synthetic invalidation timeout")):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory, \
                    patch.object(traffic.time, "time", return_value=NOW):
                root = Path(directory)
                feed, config, old = run_fixture(root)
                before = (root / "traffic.tar").read_bytes()
                def request(url, **kwargs):
                    if url.endswith("/report"):
                        if isinstance(failure, BaseException):
                            raise failure
                        return failure, None
                    return 200, feed
                with patch.object(traffic, "request_json", side_effect=request), \
                        patch.object(traffic, "routing_dataset", return_value="synthetic-dataset"), \
                        patch.object(traffic, "apply_speeds", side_effect=AssertionError("no archive write before ack")):
                    with self.assertRaises((RuntimeError, TimeoutError)):
                        traffic.run(config)
                self.assertEqual((root / "traffic.tar").read_bytes(), before)
                self.assertEqual(traffic.read_json_state(root / "last-applied.json"), old)
                pending = traffic.read_json_state(root / "pending-report.json")
                self.assertEqual(pending["status"], "degraded")
                self.assertNotEqual(pending["overlayGeneration"], old["report"]["overlayGeneration"])
                self.assertEqual((root / "pending-report.json").stat().st_mode & 0o777, 0o600)

    def test_transport_204_without_exact_zero_status_is_not_write_permission(self):
        variants = ("current", "other-generation", "other-dataset", "nonzero", "boolean-zero", "status-outage", "status-timeout")
        for variant in variants:
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as directory, \
                    patch.object(traffic.time, "time", return_value=NOW):
                root = Path(directory)
                feed, config, old = run_fixture(root)
                def request(url, **kwargs):
                    if url.endswith("/report"):
                        return 204, None
                    if url.endswith("/status"):
                        result = traffic.read_json_state(root / "pending-report.json")
                        if variant == "current": result = old["report"]
                        elif variant == "other-generation": result["overlayGeneration"] = "competing-generation"
                        elif variant == "other-dataset": result["routingDataset"] = "other-dataset"
                        elif variant == "nonzero": result["appliedEdgeCount"] = 1
                        elif variant == "boolean-zero": result["appliedEdgeCount"] = False
                        elif variant == "status-outage": return 503, None
                        elif variant == "status-timeout": raise TimeoutError("synthetic status timeout")
                        return 200, result
                    return 200, feed
                with patch.object(traffic, "request_json", side_effect=request), \
                        patch.object(traffic, "routing_dataset", return_value="synthetic-dataset"), \
                        patch.object(traffic, "apply_speeds", side_effect=AssertionError("no archive write before confirmed ack")):
                    with self.assertRaises((RuntimeError, TimeoutError)):
                        traffic.run(config)

    def test_expiration_during_ack_only_clears_and_never_writes_positive_speeds(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            instant = [NOW]
            with patch.object(traffic.time, "time", side_effect=lambda: instant[0]):
                feed, config, _ = run_fixture(root)
                original_apply = traffic.apply_speeds
                applied = []
                def request(url, **kwargs):
                    if url.endswith("/report"): return 204, None
                    if url.endswith("/status"):
                        result = traffic.read_json_state(root / "pending-report.json")
                        instant[0] = NOW + 5
                        return 200, result
                    return 200, feed
                def apply(path, state, speeds):
                    applied.append(speeds)
                    self.assertEqual(speeds, {}, "expired during acknowledgment must never become positive")
                    return original_apply(path, state, speeds)
                with patch.object(traffic, "request_json", side_effect=request), \
                        patch.object(traffic, "routing_dataset", return_value="synthetic-dataset"), \
                        patch.object(traffic, "apply_speeds", side_effect=apply):
                    self.assertEqual(traffic.run(config), 0)
                self.assertEqual(applied, [{}])
                self.assertEqual(traffic.read_edge_ledger(root / "applied-edges.json"), [])
                self.assertEqual(traffic.read_json_state(root / "last-applied.json")["report"]["status"], "degraded")

    def test_guard_clear_during_ack_does_not_deadlock_or_allow_new_positive_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            instant = [NOW]
            with patch.object(traffic.time, "time", side_effect=lambda: instant[0]):
                feed, config, _ = run_fixture(root, old_deadline=NOW + 1)
                guard_ran = threading.Event()
                original_apply = traffic.apply_speeds
                def guard():
                    self.assertTrue(traffic.clear_expired_runtime(root, 300))
                    guard_ran.set()
                def request(url, **kwargs):
                    if url.endswith("/report"):
                        instant[0] = NOW + 2
                        worker = threading.Thread(target=guard)
                        worker.start()
                        worker.join(1)
                        self.assertFalse(worker.is_alive(), "ack network must not hold archive lock")
                        self.assertTrue(guard_ran.is_set())
                        return 204, None
                    if url.endswith("/status"):
                        return 200, traffic.read_json_state(root / "pending-report.json")
                    return 200, feed
                def apply(path, state, speeds):
                    self.assertEqual(speeds, {}, "competing guard may clear, never authorize positive write")
                    return original_apply(path, state, speeds)
                with patch.object(traffic, "request_json", side_effect=request), \
                        patch.object(traffic, "routing_dataset", return_value="synthetic-dataset"), \
                        patch.object(traffic, "apply_speeds", side_effect=apply):
                    with self.assertRaisesRegex(RuntimeError, "exact zero traffic generation"):
                        traffic.run(config)
                self.assertEqual(traffic.read_edge_ledger(root / "applied-edges.json"), [])

    def test_changed_local_runtime_after_status_ack_requires_later_retry(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(traffic.time, "time", return_value=NOW):
            root = Path(directory)
            feed, config, _ = run_fixture(root)
            original_apply = traffic.apply_speeds
            def request(url, **kwargs):
                if url.endswith("/report"): return 204, None
                if url.endswith("/status"):
                    acknowledged = traffic.read_json_state(root / "pending-report.json")
                    self.assertTrue(traffic.clear_expired_runtime(root, 300, force=True))
                    return 200, acknowledged
                return 200, feed
            def apply(path, state, speeds):
                self.assertEqual(speeds, {}, "changed runtime cannot inherit the prior zero acknowledgment")
                return original_apply(path, state, speeds)
            with patch.object(traffic, "request_json", side_effect=request), \
                    patch.object(traffic, "routing_dataset", return_value="synthetic-dataset"), \
                    patch.object(traffic, "apply_speeds", side_effect=apply):
                with self.assertRaisesRegex(RuntimeError, "runtime changed during"):
                    traffic.run(config)
            self.assertEqual(traffic.read_edge_ledger(root / "applied-edges.json"), [])

    def test_reappearing_fresh_speeds_without_prepared_ack_never_mutate_archive(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(traffic.time, "time", return_value=NOW):
            root = Path(directory)
            feed, config, _ = run_fixture(root)
            # A backward clock step must not turn an initially expired cohort
            # into a positive write whose zero-generation gate was skipped.
            with patch.object(traffic, "request_json", return_value=(200, feed)), \
                    patch.object(traffic, "routing_dataset", return_value="synthetic-dataset"), \
                    patch.object(traffic, "current_edge_speeds", side_effect=[({}, 0, None), ({EDGE: (10, 80)}, 1, None)]), \
                    patch.object(traffic, "post_report", side_effect=AssertionError("no prepared invalidation")), \
                    patch.object(traffic, "apply_speeds", side_effect=AssertionError("no archive write without ack")):
                with self.assertRaisesRegex(RuntimeError, "without a zero-generation acknowledgment"):
                    traffic.run(config)

    def test_final_current_report_is_newer_than_ack_with_frozen_or_slightly_reversed_clock(self):
        for clock_step in (0, -1):
            with self.subTest(clock_step=clock_step), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                instant = [NOW]
                with patch.object(traffic.time, "time", side_effect=lambda: instant[0]):
                    feed, config, old = run_fixture(root)
                    server_report = copy.deepcopy(old["report"])
                    invalidations = []
                    def request(url, **kwargs):
                        nonlocal server_report
                        if url.endswith("/report"):
                            value = kwargs["payload"]
                            incoming = traffic.parse_iso_timestamp(value["updatedAt"])
                            previous = traffic.parse_iso_timestamp(server_report["updatedAt"])
                            # Match SIM's real strict ordering: equal timestamps
                            # get transport 204 but do not change the generation.
                            if incoming > previous:
                                server_report = copy.deepcopy(value)
                            if value["status"] == "degraded": invalidations.append(copy.deepcopy(value))
                            return 204, None
                        if url.endswith("/status"):
                            result = copy.deepcopy(server_report)
                            instant[0] = NOW + clock_step
                            return 200, result
                        return 200, feed
                    with patch.object(traffic, "request_json", side_effect=request), \
                            patch.object(traffic, "routing_dataset", return_value="synthetic-dataset"):
                        self.assertEqual(traffic.run(config), 0)
                    self.assertEqual(len(invalidations), 1)
                    self.assertEqual(server_report["status"], "current")
                    self.assertGreater(traffic.parse_iso_timestamp(server_report["updatedAt"]),
                                       traffic.parse_iso_timestamp(invalidations[0]["updatedAt"]))
                    self.assertEqual(server_report["updatedAt"], traffic.utc_iso(NOW + 0.000001))
                    runtime = traffic.read_json_state(root / "last-applied.json")
                    self.assertEqual(runtime["report"], server_report)
                    self.assertGreater(traffic.trustworthy_runtime_deadline(runtime, 300, instant[0]), instant[0])

    def test_excessive_clock_drift_before_or_during_apply_clears_without_current_report(self):
        for drift_during_apply in (False, True):
            with self.subTest(drift_during_apply=drift_during_apply), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                instant = [NOW]
                with patch.object(traffic.time, "time", side_effect=lambda: instant[0]):
                    feed, config, _ = run_fixture(root)
                    posts = []
                    writes = []
                    original_apply = traffic.apply_speeds
                    def request(url, **kwargs):
                        if url.endswith("/report"):
                            posts.append(kwargs["payload"])
                            return 204, None
                        if url.endswith("/status"):
                            acknowledged = traffic.read_json_state(root / "pending-report.json")
                            if not drift_during_apply: instant[0] = NOW - 31
                            return 200, acknowledged
                        return 200, feed
                    def apply(path, state, speeds):
                        writes.append(bool(speeds))
                        result = original_apply(path, state, speeds)
                        if drift_during_apply and speeds: instant[0] = NOW - 31
                        return result
                    with patch.object(traffic, "request_json", side_effect=request), \
                            patch.object(traffic, "routing_dataset", return_value="synthetic-dataset"), \
                            patch.object(traffic, "apply_speeds", side_effect=apply):
                        with self.assertRaisesRegex(RuntimeError, "clock drift exceeded"):
                            traffic.run(config)
                    self.assertEqual(writes, [True, False] if drift_during_apply else [False])
                    self.assertEqual(len(posts), 1)
                    self.assertEqual(posts[0]["status"], "degraded")
                    self.assertEqual(traffic.read_edge_ledger(root / "applied-edges.json"), [])
                    runtime = traffic.read_json_state(root / "last-applied.json")
                    self.assertEqual(runtime["report"]["status"], "degraded")
                    self.assertEqual(runtime["report"]["appliedEdgeCount"], 0)
                    offset, _ = traffic.edge_record_location(EDGE, traffic.traffic_tile_offsets(root / "traffic.tar"))
                    with (root / "traffic.tar").open("rb") as stream:
                        stream.seek(offset)
                        self.assertEqual(stream.read(8), bytes(8))

    def test_report_contract_requires_204(self):
        with patch.object(traffic, "request_json", return_value=(204, None)):
            traffic.post_report("http://synthetic", "test", {})
        with patch.object(traffic, "request_json", return_value=(400, {})):
            with self.assertRaisesRegex(RuntimeError, "HTTP 400"):
                traffic.post_report("http://synthetic", "test", {})


if __name__ == "__main__":
    unittest.main()
