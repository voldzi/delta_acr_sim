#!/usr/bin/env python3
import copy
import gzip
import hashlib
from io import BytesIO
import importlib.util
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    result = importlib.util.module_from_spec(spec); spec.loader.exec_module(result)
    return result

t = module("traffic", "traffic-update.py")
p = module("promotion", "prepare-native-live-selection.py")


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        self.graph = self.root / "valhalla_tiles.tar"; self.graph.write_bytes(b"synthetic graph")
        self.baseline_path = self.root / "baseline.gz"
        self.baseline = {"matcherVersion": t.MATCHER_VERSION, "routingDataset": "dataset", "staticRevision": "static",
                         "sourceSegmentCount": 10, "mappedSegmentCount": 1, "mapping": {"old": [{"id": 0}]}}
        with gzip.open(self.baseline_path, "wt") as stream: json.dump(self.baseline, stream)
        st = self.graph.stat()
        self.selection = {"contractVersion": "sim-native-reviewed-live-map-v1", "approvedForLive": True,
            "geographicAttestation": "operator-geographic-review-v1", "routingDataset": "dataset", "staticRevision": "static",
            "releaseTarget": str(self.root), "graphIdentity": {"device": st.st_dev, "inode": st.st_ino, "size": st.st_size,
                 "mtimeNs": st.st_mtime_ns, "ctimeNs": st.st_ctime_ns}, "graphSha256": "a"*64,
            "baselineSha256": hashlib.sha256(self.baseline_path.read_bytes()).hexdigest(),
            "candidateSha256": "b"*64, "canarySha256": "c"*64, "acceptedAt": "2026-10-01T18:00:00Z",
            "mapping": {"new": [{"id": 8}]}}

    def tearDown(self): self.temp.cleanup()

    def read(self, **stat_changes):
        raw = json.dumps(self.selection).encode()
        name = "native-reviewed-" + hashlib.sha256(raw).hexdigest()[:20] + ".json"
        path = self.root / name; path.write_bytes(raw)
        metadata = {"st_uid": 0, "st_mode": 0o100600, "st_size": len(raw), **stat_changes}
        with patch.object(t.os, "fstat", return_value=SimpleNamespace(**metadata)):
            return t.reviewed_native_selection({"TRAFFIC_NATIVE_REVIEWED_MAP": str(path),
                "TRAFFIC_MAPPING_CACHE_DIR": str(self.root)}, "dataset", "static", self.root, self.baseline_path)

    def test_default_disabled(self):
        self.assertEqual(t.reviewed_native_selection({}, "d", "s", self.root, self.baseline_path), (None, t.MATCHER_VERSION))

    def test_exact_disjoint_selection(self):
        selection, version = self.read()
        merged = t.merge_reviewed_native(self.baseline, selection, version)
        self.assertEqual(merged["mappedSegmentCount"], 2)
        self.assertEqual(merged["mapping"]["old"], self.baseline["mapping"]["old"])
        self.assertEqual(self.baseline["mappedSegmentCount"], 1)
        self.assertNotEqual(version, t.MATCHER_VERSION)

    def test_graph_rotation_uses_baseline(self):
        for field in ("routingDataset", "staticRevision"):
            old = self.selection[field]; self.selection[field] = "other"
            self.assertEqual(self.read(), (None, t.MATCHER_VERSION))
            self.selection[field] = old

    def test_private_root_ownership_required(self):
        for metadata in ({"st_uid": 1000}, {"st_mode": 0o100644}, {"st_mode": 0o010600}, {"st_size": 9*1024*1024}):
            with self.assertRaises(RuntimeError): self.read(**metadata)

    def test_geographic_attestation_not_invented(self):
        self.selection["geographicAttestation"] = "automated"
        with self.assertRaises(RuntimeError): self.read()

    def test_unapproved_or_unknown_structure_rejected(self):
        self.selection["approvedForLive"] = False
        with self.assertRaises(RuntimeError): self.read()
        self.selection["approvedForLive"] = True; self.selection["extra"] = True
        with self.assertRaises(RuntimeError): self.read()

    def test_modified_graph_rejected(self):
        self.graph.write_bytes(b"changed")
        with self.assertRaises(RuntimeError): self.read()

    def test_modified_baseline_rejected(self):
        self.baseline_path.write_bytes(b"changed")
        with self.assertRaises(RuntimeError): self.read()

    def test_old_reference_and_edge_rejected(self):
        for mapping in ({"old": [{"id": 8}]}, {"new": [{"id": 0}]}, {"new": [{"id": 8}], "new2": [{"id": 8}]}):
            self.selection["mapping"] = mapping
            with self.assertRaises(RuntimeError): self.read()

    def test_offsets_bool_and_unsupported_level_rejected(self):
        for edge in ({"id": 8, "beginFraction": .5}, {"id": True}, {"id": 3}, {"id": 2**46}):
            self.selection["mapping"] = {"new": [edge]}
            with self.assertRaises(RuntimeError): self.read()

    def test_selection_fingerprint_invalidates_runtime_reuse(self):
        _, version = self.read()
        self.assertNotEqual(version, t.MATCHER_VERSION)
        self.selection["acceptedAt"] = "2026-10-01T18:01:00Z"
        self.assertNotEqual(self.read()[1], version)

    def test_accept_only_tested_same_shape_forward_refs(self):
        candidate = {"mapping": {str(i): [{"id": (i+1)*8}] for i in range(4)},
            "routingDataset": "dataset", "staticRevision": "static", "graphSha256": "a"*64, "baselineSha256": "b"*64}
        report = {**{k:candidate[k] for k in ("routingDataset", "staticRevision", "graphSha256", "baselineSha256")},
            "contractVersion": "sim-native-same-flow-canary-v1", "actorVersion": "3.8.3", "approvedForLive": False,
            "automatedPilotPassed": True, "snapshotStillValid": True, "nonVehicleControlsPassed": True,
            "unaffectedControlsPassed": True, "geographicHumanReviewRequired": True, "candidateSha256": "hash",
            "testedForwardRouteCount": 4, "pairs": [{"kind": "forward", "reference": str(i), "paired": True,
                "shapeChanged": False, "baseline": {"status": "ok"}, "candidate": {"status": "ok"},
                "candidateNewEdgeCount": 1, "candidateTargetEdgeCount": 1} for i in range(4)], "forwardRoutesUsingTargetEdges": 4}
        self.assertEqual(len(p.accepted_ids(report, candidate, "hash")), 4)
        for version in (None, "3.8.2", "unknown"):
            broken = copy.deepcopy(report); broken["actorVersion"] = version
            with self.assertRaises(ValueError): p.accepted_ids(broken, candidate, "hash")
        for field in ("automatedPilotPassed", "snapshotStillValid", "nonVehicleControlsPassed", "unaffectedControlsPassed"):
            broken = copy.deepcopy(report); broken[field] = False
            with self.assertRaises(ValueError): p.accepted_ids(broken, candidate, "hash")
        broken = copy.deepcopy(report); broken["pairs"][0]["shapeChanged"] = True
        with self.assertRaises(ValueError): p.accepted_ids(broken, candidate, "hash")
        broken = copy.deepcopy(report); del broken["pairs"][0]["candidateTargetEdgeCount"]
        with self.assertRaises(ValueError): p.accepted_ids(broken, candidate, "hash")
        broken = copy.deepcopy(report); broken["pairs"][0]["candidateTargetEdgeCount"] = 0
        with self.assertRaises(ValueError): p.accepted_ids(broken, candidate, "hash")

    def test_full_generation_activation_and_rollback_preserve_baseline(self):
        cache, runtime = self.root / "cache", self.root / "runtime"
        cache.mkdir(); runtime.mkdir()
        skeleton = self.root / "traffic-skeleton.tar"
        header = t.struct.pack("<2Q4I", 8, 0, 3, 3, 0, 0)
        with t.tarfile.open(skeleton, "w") as archive:
            info = t.tarfile.TarInfo("0/000/000/001.gph"); info.size = len(header) + 24
            archive.addfile(info, BytesIO(header + bytes(24)))
        mapping = {"matcherVersion": t.MATCHER_VERSION, "routingDataset": "dataset", "staticRevision": "static",
            "sourceSegmentCount": 2, "mappedSegmentCount": 1, "mapping": {"old": [{"id": 8}]}}
        baseline = t.mapping_path(cache, "dataset", "static")
        t.write_gzip_json(baseline, mapping)
        original = baseline.read_bytes()
        now = time.time()
        feed = {"contractVersion": "sim-valhalla-live-traffic-feed-v1", "staticRevision": "static", "dynamicRevision": "same",
            "maxAgeSeconds": 1800, "flows": [{"messageId": ident, "averageSpeedKph": speed,
                "observedAt": t.utc_iso(now-1), "validUntil": t.utc_iso(now+120)} for ident,speed in (("old",30),("new",20))]}
        config = {"SIM_TRAFFIC_FEED_BASE_URL": "http://synthetic.test", "SIM_TRAFFIC_CONTROL_TOKEN": "synthetic",
            "VALHALLA_URL": "http://synthetic.test", "TRAFFIC_MAPPING_CACHE_DIR": str(cache),
            "TRAFFIC_RUNTIME_DIR": str(runtime), "TRAFFIC_SKELETON": str(skeleton)}
        selection = {"mapping": {"new": [{"id": 8+(1<<25)}]}}
        with patch.object(t, "routing_dataset", return_value="dataset"), patch.object(t, "request_json", return_value=(200,feed)), \
             patch.object(t, "acknowledge_write_invalidation"), patch.object(t, "deliver_pending_report"):
            with patch.object(t,"reviewed_native_selection",return_value=(selection,"selected-synthetic")):
                self.assertEqual(t.run(config),0)
            state = t.read_json_state(runtime / "last-applied.json")
            self.assertEqual(state["matcherVersion"],"selected-synthetic")
            self.assertEqual(state["report"]["appliedEdgeCount"],2)
            with patch.object(t,"reviewed_native_selection",return_value=(None,t.MATCHER_VERSION)):
                self.assertEqual(t.run(config),0)
            state = t.read_json_state(runtime / "last-applied.json")
            self.assertEqual(state["matcherVersion"],t.MATCHER_VERSION)
            self.assertEqual(state["report"]["appliedEdgeCount"],1)
            self.assertEqual(t.read_edge_ledger(runtime / "applied-edges.json"),[8])
            offset,_ = t.edge_record_location(8+(1<<25), t.traffic_tile_offsets(runtime / "traffic.tar"))
            with (runtime / "traffic.tar").open("rb") as stream:
                stream.seek(offset); self.assertEqual(stream.read(8),bytes(8))
        self.assertEqual(baseline.read_bytes(),original)


if __name__ == "__main__": unittest.main()
