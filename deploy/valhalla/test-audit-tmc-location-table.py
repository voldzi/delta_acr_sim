#!/usr/bin/env python3
from __future__ import annotations

import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile


SPEC = importlib.util.spec_from_file_location("tmc_audit", Path(__file__).with_name("audit-tmc-location-table.py"))
assert SPEC and SPEC.loader
audit_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit_module)


class TmcAuditTest(unittest.TestCase):
    def test_reference_classes_and_mismatch_are_aggregated(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            archive_path = base / "table.zip"
            prefix = audit_module.PREFIX
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr(prefix + "LOCATIONDATASETS.DAT", "CID;TABCD;VERSION\n11;25;11.0\n")
                archive.writestr(prefix + "POINTS.DAT", "CID;TABCD;LCD\n11;25;101\n")
                archive.writestr(prefix + "SEGMENTS.DAT", "CID;TABCD;LCD\n11;25;201\n")
                archive.writestr(prefix + "ROADS.DAT", "CID;TABCD;LCD\n11;25;301\n")
            static_path = base / "static.json.gz"
            segments = [
                {"locationId": "101", "countryCode": "11", "locationTableNumber": "25"},
                {"locationId": "201", "countryCode": "11", "locationTableNumber": "25"},
                {"locationId": "301", "countryCode": "11", "locationTableNumber": "25"},
                {"locationId": "999", "countryCode": "11", "locationTableNumber": "25"},
                {"locationId": "101", "countryCode": "11", "locationTableNumber": "24"},
                {"locationId": ""},
            ]
            with gzip.open(static_path, "wt", encoding="utf-8") as stream:
                json.dump({"staticRevision": "synthetic", "segments": segments}, stream)
            result = audit_module.audit(archive_path, static_path)
            self.assertEqual(result["locationCount"], 3)
            self.assertEqual(result["staticSegmentCount"], 6)
            self.assertEqual(result["referenceCounts"], {
                "matched_point": 1, "matched_road": 1, "matched_segment": 1,
                "no_tmc_reference": 1, "other_country_or_table": 1, "unknown_location": 1,
            })
            baseline_path = base / "baseline.json.gz"
            with gzip.open(baseline_path, "wt", encoding="utf-8") as stream:
                json.dump({"staticRevision": "wrong", "mapping": {}}, stream)
            with self.assertRaises(ValueError):
                audit_module.audit(archive_path, static_path, baseline_path)
            with gzip.open(baseline_path, "wt", encoding="utf-8") as stream:
                json.dump({"staticRevision": "synthetic", "mapping": {"first": []}}, stream)
            self.assertEqual(audit_module.audit(archive_path, static_path, baseline_path)["baselineMappedSegmentCount"], 1)
            bad_archive = base / "bad-table.zip"
            with zipfile.ZipFile(bad_archive, "w") as archive:
                archive.writestr(prefix + "LOCATIONDATASETS.DAT", "CID;TABCD;VERSION\n11;26;11.0\n")
            with self.assertRaises(ValueError):
                audit_module.audit(bad_archive)


if __name__ == "__main__":
    unittest.main()
