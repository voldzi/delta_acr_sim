#!/usr/bin/env python3
"""Convert a Geofabrik .poly boundary to a buffered GeoJSON polygon."""

import json
import sys
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import Polygon, mapping
from shapely.ops import transform, unary_union


def read_poly(path: Path):
    outers = []
    holes = []
    current = []
    is_hole = False

    for raw_line in path.read_text(encoding="utf-8").splitlines()[1:]:
        line = raw_line.strip()
        if not line:
            continue
        if line == "END":
            if current:
                polygon = Polygon(current)
                (holes if is_hole else outers).append(polygon)
                current = []
                is_hole = False
                continue
            break
        if len(line.split()) == 1:
            is_hole = line.startswith("!")
            continue
        lon, lat = (float(value) for value in line.split()[:2])
        current.append((lon, lat))

    if not outers:
        raise ValueError(f"No outer polygon found in {path}")

    geometry = unary_union(outers)
    if holes:
        geometry = geometry.difference(unary_union(holes))
    return geometry


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: make-buffer.py INPUT.poly OUTPUT.geojson BUFFER_METERS")

    source = Path(sys.argv[1])
    destination = Path(sys.argv[2])
    buffer_meters = float(sys.argv[3])

    to_metric = Transformer.from_crs("EPSG:4326", "EPSG:3035", always_xy=True).transform
    to_wgs84 = Transformer.from_crs("EPSG:3035", "EPSG:4326", always_xy=True).transform

    boundary = read_poly(source)
    buffered = transform(to_metric, boundary).buffer(buffer_meters)
    buffered = buffered.simplify(250, preserve_topology=True)
    buffered = transform(to_wgs84, buffered)

    destination.write_text(
        json.dumps({"type": "Feature", "properties": {}, "geometry": mapping(buffered)}),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
