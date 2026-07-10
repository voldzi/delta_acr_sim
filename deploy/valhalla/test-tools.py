#!/usr/bin/env python3
"""Fast unit checks for Valhalla deployment validators."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType


ROOT = Path(__file__).resolve().parent


def load_module(name: str, filename: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {filename}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validator = load_module("validate_response", "validate-response.py")


def encode_polyline6(coordinates: list[tuple[float, float]]) -> str:
    output = []
    previous_lat = 0
    previous_lon = 0
    for lat, lon in coordinates:
        current_lat = round(lat * 1_000_000)
        current_lon = round(lon * 1_000_000)
        for delta in (current_lat - previous_lat, current_lon - previous_lon):
            value = ~(delta << 1) if delta < 0 else delta << 1
            while value >= 0x20:
                output.append(chr((0x20 | (value & 0x1F)) + 63))
                value >>= 5
            output.append(chr(value + 63))
        previous_lat = current_lat
        previous_lon = current_lon
    return "".join(output)


def expect_failure(callback, text: str) -> None:
    try:
        callback()
    except ValueError as exc:
        assert text in str(exc), str(exc)
    else:
        raise AssertionError(f"expected failure containing {text!r}")


def main() -> int:
    shape = encode_polyline6([(50.08, 14.42), (50.09, 14.43), (50.10, 14.45)])
    route = {
        "trip": {
            "status": 0,
            "summary": {"length": 4.2, "time": 600},
            "legs": [
                {
                    "shape": shape,
                    "elevation": [220, 225, 230],
                    "elevation_interval": 100,
                    "summary": {"admins": [{"country_code": "CZ"}, {"country_code": "DE"}]},
                }
            ],
        }
    }
    validator.validate_route(route, 10, {"CZ", "DE"}, (50.08, 14.42, 50.10, 14.45), 2500, True)
    expect_failure(lambda: validator.validate_route(route, 10, {"AT"}, None, 2500, True), "missing expected admins")
    expect_failure(
        lambda: validator.validate_route(route, 10, {"CZ"}, (49.0, 13.0, 50.10, 14.45), 2500, True),
        "endpoint snap exceeds",
    )

    near = [{"input_lat": 50.08, "input_lon": 14.42, "edges": [{"correlated_lat": 50.0801, "correlated_lon": 14.4201}]}]
    far = [{"input_lat": 50.08, "input_lon": 14.42, "edges": [{"correlated_lat": 50.18, "correlated_lon": 14.62}]}]
    validator.validate_locate(near, 2500)
    expect_failure(lambda: validator.validate_locate(far, 2500), "maximum is")

    validator.validate_height({"range_height": [[0, 220], [1000, 230]]}, 2)
    expect_failure(lambda: validator.validate_height({"range_height": [[0, 220], [1000, None]]}, 2), "non-finite")
    validator.validate_isochrone(
        {"type": "FeatureCollection", "features": [{"geometry": {"type": "Polygon", "coordinates": [[[1, 1], [2, 1], [1, 1]]]}}]}
    )
    print("Valhalla deployment tool tests passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
