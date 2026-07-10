#!/usr/bin/env python3
"""Print a GeoJSON geometry bounding box as west,south,east,north."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Iterator


def coordinate_pairs(value: Any) -> Iterator[tuple[float, float]]:
    if isinstance(value, list) and len(value) >= 2 and all(isinstance(item, (int, float)) for item in value[:2]):
        yield float(value[0]), float(value[1])
        return
    if isinstance(value, list):
        for item in value:
            yield from coordinate_pairs(item)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: geojson-bbox.py FILE", file=sys.stderr)
        return 2
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    geometry = payload.get("geometry", payload) if isinstance(payload, dict) else None
    coordinates = geometry.get("coordinates") if isinstance(geometry, dict) else None
    pairs = list(coordinate_pairs(coordinates))
    if not pairs:
        print("GeoJSON contains no coordinates", file=sys.stderr)
        return 1
    longitudes, latitudes = zip(*pairs)
    print(f"{min(longitudes):.8f},{min(latitudes):.8f},{max(longitudes):.8f},{max(latitudes):.8f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
