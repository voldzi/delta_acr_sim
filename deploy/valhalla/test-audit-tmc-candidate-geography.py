#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import math
from pathlib import Path
import struct
import unittest


SPEC = importlib.util.spec_from_file_location(
    "tmc_geography", Path(__file__).with_name("audit-tmc-candidate-geography.py")
)
assert SPEC and SPEC.loader
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


class GeographyAuditTest(unittest.TestCase):
    def test_distance_to_independent_road_geometry(self) -> None:
        road = [[(14.0, 50.0), (14.01, 50.0)]]
        self.assertLess(module.road_distance_m((14.005, 50.0001), road), 12)
        self.assertGreater(module.road_distance_m((14.005, 50.002), road), 200)
        self.assertTrue(math.isinf(module.road_distance_m((14, 50), [])))

    def test_polyline_and_stratified_selection(self) -> None:
        self.assertEqual(module.decode_polyline6("??"), [(0.0, 0.0)])
        source = {"segments": [
            {"messageId": str(index), "openlr": {"points": [{"frc": index % 2}]}}
            for index in range(20)
        ]}
        audit = {"mapping": {str(index): [] for index in range(20)}}
        selected = module.sample(source, audit, 3)
        self.assertEqual(len(selected), 6)
        self.assertEqual(len({item["messageId"] for item in selected}), 6)

    def test_shapefile_rejects_invalid_header(self) -> None:
        with self.assertRaises(ValueError):
            module.shp_polylines(b"short")
        header = bytearray(100)
        struct.pack_into(">I", header, 0, 9994)
        self.assertEqual(module.shp_polylines(bytes(header)), [])


if __name__ == "__main__":
    unittest.main()
