#!/usr/bin/env python3
"""Synthetic-only tests of private offline native corridor preparation."""
from __future__ import annotations

import argparse
import copy
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("prepare_native_corridors", ROOT / "prepare-openlr-native-corridors.py")
assert SPEC and SPEC.loader
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)
REVISION, TMC_HASH = "b" * 64, "c" * 64
ROAD = [[(14., 50.), (14.003, 50.)]]


def segment(identity="synthetic-only-secret-reference", frc=2):
    return {"messageId": identity, "locationId": "101", "countryCode": "11", "locationTableNumber": "25",
            "coordinates": [[14., 50.], [14.003, 50.]], "openlr": {"points": [
                {"role": "first", "bearing": 64, "frc": str(frc), "fow": "3", "distanceToNext": 215,
                 "lowestFrcToNext": str(frc), "againstDrivingDirection": False},
                {"role": "last", "bearing": 192, "frc": str(frc), "fow": "3"}]}}


def feed(*segments):
    return {"staticRevision": REVISION, "segments": list(segments)}


def synthetic_tmc_zip(path: Path):
    """Minimal real DBF/SHP/LOCATIONDATASETS/POINTS layout read by tmc_roads."""
    field_names = ("CID", "TABCD", "LCD")
    width = 8
    header_length = 32 + 32 * len(field_names) + 1
    record_length = 1 + width * len(field_names)
    header = bytearray(header_length)
    header[0] = 3
    struct.pack_into("<IHH", header, 4, 1, header_length, record_length)
    for index, name in enumerate(field_names):
        descriptor = 32 + index * 32
        header[descriptor:descriptor + len(name)] = name.encode()
        header[descriptor + 11] = ord("C")
        header[descriptor + 16] = width
    header[-1] = 13
    dbf = bytes(header) + b" " + b"".join(value.encode().ljust(width) for value in ("11", "25", "301"))
    body = struct.pack("<I4dII", 3, 14., 50., 14.003, 50., 1, 2) + struct.pack("<I", 0)
    body += b"".join(struct.pack("<dd", *point) for point in ROAD[0])
    shp_header = bytearray(100)
    struct.pack_into(">I", shp_header, 0, 9994)
    shp = bytes(shp_header) + struct.pack(">II", 1, len(body) // 2) + body
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(prepare.geography.PREFIX + "tmc_format/LOCATIONDATASETS.DAT", "CID;TABCD;VERSION\n11;25;11.0\n")
        archive.writestr(prepare.geography.PREFIX + "tmc_format/POINTS.DAT", "CID;TABCD;LCD;ROA_LCD\n11;25;101;301\n")
        archive.writestr(prepare.geography.ROAD_STEM + ".dbf", dbf)
        archive.writestr(prepare.geography.ROAD_STEM + ".shp", shp)


class NativeCorridorPreparationTests(unittest.TestCase):
    def test_canonical_native_contract_and_geometry_preserved(self):
        original = segment()
        source = feed(original)
        before = copy.deepcopy(source)
        static, corridors, report = prepare.prepare(source, {"301": ROAD}, {"101": "301"}, TMC_HASH)
        self.assertEqual(source, before)
        self.assertEqual(static, before)
        self.assertEqual(report["selectedReferenceCount"], 1)
        self.assertFalse(report["approvedForLive"])
        self.assertEqual(corridors["contractVersion"], "sim-tmc-corridors-v1")
        canonical = {key: corridors[key] for key in ("tmcVersion", "tmcSha256", "corridors")}
        digest = hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
        self.assertEqual(digest, corridors["revision"])
        entry = corridors["corridors"][original["messageId"]]
        self.assertEqual(entry["parts"], [[[14., 50.], [14.003, 50.]]])
        prepare.native.validate_corridor({"revision": digest, **entry})
        prepare.native.native_request(original, 1, "synthetic", "a" * 64, REVISION, {"revision": digest, **entry})

    def test_missing_road_and_wrong_table_do_not_guess_by_coordinate(self):
        cases = [segment("missing"), segment("table"), segment("country")]
        cases[0]["locationId"] = "999"
        cases[1]["locationTableNumber"] = "26"
        cases[2]["countryCode"] = "12"
        static, corridors, report = prepare.prepare(feed(*cases), {"301": ROAD}, {"101": "301"}, TMC_HASH)
        self.assertEqual(static["segments"], [])
        self.assertEqual(corridors["corridors"], {})
        self.assertEqual(report["rejectionCounts"], {"no_tmc_road": 1, "other_tmc_country_or_table": 2})

    def test_endpoints_outside_corridor_are_not_shifted(self):
        source = segment()
        source["coordinates"][-1][1] += .002
        before = copy.deepcopy(source)
        static, _, report = prepare.prepare(feed(source), {"301": ROAD}, {"101": "301"}, TMC_HASH)
        self.assertEqual(static["segments"], [])
        self.assertEqual(source, before)
        self.assertEqual(report["rejectionCounts"], {"endpoint_outside_corridor": 1})

    def test_parts_and_points_limits_do_not_simplify(self):
        for road, reason in [([ROAD[0]] * 17, "tmc_parts_limit"),
                             ([[(14. + index * .003 / 512, 50.) for index in range(513)]], "tmc_points_limit")]:
            original = copy.deepcopy(road)
            static, _, report = prepare.prepare(feed(segment()), {"301": road}, {"101": "301"}, TMC_HASH)
            self.assertEqual(static["segments"], [])
            self.assertEqual(report["rejectionCounts"], {reason: 1})
            self.assertEqual(road, original)
        self.assertIsNone(prepare.corridor_parts([ROAD[0]] * 16)[1])
        self.assertIsNone(prepare.corridor_parts([[(14. + index * .003 / 511, 50.) for index in range(512)]])[1])

    def test_invalid_independent_geometry_is_rejected(self):
        for road in ([[(float("nan"), 50.), (14.003, 50.)]], [[(True, 50.), (14.003, 50.)]],
                     [[(14., 86.), (14.003, 86.)]], [[(14., 50.)]], [], None):
            with self.subTest(road=road):
                static, _, report = prepare.prepare(feed(segment()), {"301": road}, {"101": "301"}, TMC_HASH)
                self.assertEqual(static["segments"], [])
                self.assertEqual(sum(report["rejectionCounts"].values()), 1)

    def test_invalid_openlr_is_rejected_before_corridor_creation(self):
        mutations = [lambda s: s["openlr"]["points"][0].update(bearing=True),
                     lambda s: s["openlr"]["points"][0].update(distanceToNext=float("nan")),
                     lambda s: s.update(coordinates=[[14, 50]]),
                     lambda s: s["openlr"].update(positiveOffsetMeters=-1)]
        for mutate in mutations:
            source = segment()
            mutate(source)
            static, _, report = prepare.prepare(feed(source), {"301": ROAD}, {"101": "301"}, TMC_HASH)
            self.assertEqual(static["segments"], [])
            self.assertEqual(report["rejectionCounts"], {"invalid_reference": 1})

    def test_stratified_choice_is_bounded_deterministic_and_input_order_independent(self):
        members = [segment(f"synthetic-{frc}-{index:03}", frc) for frc in range(8) for index in range(40)]
        static, corridors, report = prepare.prepare(feed(*members), {"301": ROAD}, {"101": "301"}, TMC_HASH)
        reversed_static, reversed_corridors, reversed_report = prepare.prepare(feed(*reversed(members)), {"301": ROAD}, {"101": "301"}, TMC_HASH)
        self.assertEqual(static, reversed_static)
        self.assertEqual(corridors, reversed_corridors)
        self.assertEqual(report, reversed_report)
        self.assertEqual(report["selectedReferenceCount"], 240)
        self.assertEqual(report["omittedEligibleReferenceCount"], 80)
        self.assertEqual({values["selected"] for values in report["byFrc"].values()}, {30})
        self.assertEqual(len({s["messageId"] for s in static["segments"]}), 240)
        national, _, national_report = prepare.prepare(feed(*members), {"301": ROAD}, {"101": "301"}, TMC_HASH, maximum=100000)
        self.assertEqual(len(national["segments"]), 320)
        self.assertEqual(national_report["omittedEligibleReferenceCount"], 0)

    def test_sparse_strata_redistribute_quota_without_duplicates(self):
        members = [segment("one", 0)] + [segment(f"many-{index:03}", 6) for index in range(20)]
        static, _, report = prepare.prepare(feed(*members), {"301": ROAD}, {"101": "301"}, TMC_HASH, maximum=10)
        self.assertEqual(report["byFrc"]["0"]["selected"], 1)
        self.assertEqual(report["byFrc"]["6"]["selected"], 9)
        self.assertEqual(len({s["messageId"] for s in static["segments"]}), 10)

    def test_identity_and_bound_errors_fail_closed(self):
        for maximum, tolerance in ((0, 100), (100001, 100), (True, 100), (240, 101), (240, 9), (240, float("inf")), (240, True)):
            with self.subTest(maximum=maximum, tolerance=tolerance), self.assertRaises(ValueError):
                prepare.prepare(feed(segment()), {"301": ROAD}, {"101": "301"}, TMC_HASH, maximum, tolerance)
        with self.assertRaisesRegex(ValueError, "Duplicated"):
            prepare.prepare(feed(segment(), segment()), {"301": ROAD}, {"101": "301"}, TMC_HASH)
        for invalid in ({"staticRevision": "bad", "segments": []}, {"staticRevision": REVISION, "segments": "bad"}):
            with self.assertRaises(ValueError):
                prepare.prepare(invalid, {}, {}, TMC_HASH)

    def test_private_files_and_cli_stdout_contain_only_aggregates(self):
        with tempfile.TemporaryDirectory(prefix="sim-native-corridors-test-") as work:
            directory = Path(work)
            source, table = directory / "input.json.gz", directory / "synthetic.zip"
            output_static, output_corridors = directory / "selected.json.gz", directory / "corridors.json.gz"
            prepare.native.private_json(source, feed(segment()))
            synthetic_tmc_zip(table)
            result = subprocess.run([sys.executable, str(ROOT / "prepare-openlr-native-corridors.py"),
                "--static-cache", str(source), "--tmc-zip", str(table),
                "--output-static", str(output_static), "--output-corridors", str(output_corridors)],
                capture_output=True, text=True, check=True)
            report = json.loads(result.stdout)
            self.assertEqual(report["selectedReferenceCount"], 1)
            self.assertNotIn("synthetic-only-secret-reference", result.stdout + result.stderr)
            self.assertNotIn("coordinates", result.stdout)
            self.assertNotIn("parts", result.stdout)
            for path in (output_static, output_corridors):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            with gzip.open(output_corridors, "rt") as stream:
                private = json.load(stream)
            self.assertEqual(private["tmcSha256"], prepare.file_sha256(table))
            self.assertIn("synthetic-only-secret-reference", private["corridors"])

    def test_output_cannot_replace_input_or_runtime_data(self):
        for output_static, output_corridors in (("source.json.gz", "corridors.json.gz"),
                                                ("same.json.gz", "same.json.gz"),
                                                ("selected.json", "corridors.json.gz"),
                                                ("/run/valhalla-traffic/selected.json.gz", "corridors.json.gz")):
            with self.subTest(output_static=output_static), self.assertRaises(ValueError):
                prepare.run(argparse.Namespace(static_cache=Path("source.json.gz"), tmc_zip=Path("table.zip"),
                    output_static=Path(output_static), output_corridors=Path(output_corridors),
                    max_segments=240, tolerance_meters=100))


if __name__ == "__main__":
    unittest.main(verbosity=2)
