#!/usr/bin/env python3
"""Read-only geographic challenge of candidate paths against licensed TMC roads.

Private source records remain in memory. Output contains aggregate verdicts only.
This is a falsification check, not proof of correct direction or ETA accuracy.
"""

from __future__ import annotations

import argparse
from collections import Counter
import csv
import gzip
import hashlib
import io
import json
import math
import os
import shlex
import struct
import subprocess
import zipfile
from pathlib import Path
from urllib.request import Request, urlopen


PREFIX = "ltcze11_0_cz/data/"
ROAD_STEM = PREFIX + "esri_format/WGS84/ltcze11_0_roads_wgs84"
STATIC_PATH = "/valhalla-traffic-cache/static-segments.json.gz"


def remote_json(host: str, command: str) -> dict:
    payload = subprocess.check_output(
        ["ssh", "-o", "BatchMode=yes", host, command], timeout=60
    )
    return json.loads(gzip.decompress(payload))


def dbf_rows(payload: bytes) -> list[dict[str, str]]:
    count = struct.unpack_from("<I", payload, 4)[0]
    header_length, record_length = struct.unpack_from("<HH", payload, 8)
    fields = []
    for offset in range(32, header_length - 1, 32):
        field = payload[offset:offset + 32]
        fields.append((field[:11].split(b"\0")[0].decode("ascii"), field[16]))
    rows = []
    for index in range(count):
        record = payload[header_length + index * record_length:header_length + (index + 1) * record_length]
        if len(record) != record_length:
            raise ValueError("TMC DBF record truncated")
        if record[:1] == b"*":
            rows.append({})
            continue
        cursor = 1
        row = {}
        for name, width in fields:
            row[name] = record[cursor:cursor + width].decode("latin-1").strip()
            cursor += width
        rows.append(row)
    return rows


def shp_polylines(payload: bytes) -> list[list[list[tuple[float, float]]]]:
    if len(payload) < 100 or struct.unpack_from(">I", payload)[0] != 9994:
        raise ValueError("Invalid TMC shapefile")
    shapes = []
    offset = 100
    while offset < len(payload):
        if offset + 8 > len(payload):
            raise ValueError("TMC shapefile record header truncated")
        words = struct.unpack_from(">I", payload, offset + 4)[0]
        body = payload[offset + 8:offset + 8 + words * 2]
        if len(body) != words * 2:
            raise ValueError("TMC shapefile record truncated")
        kind = struct.unpack_from("<I", body)[0]
        if kind == 0:
            shapes.append([])
        elif kind in (3, 13, 23):
            part_count, point_count = struct.unpack_from("<II", body, 36)
            starts = list(struct.unpack_from(f"<{part_count}I", body, 44))
            points_offset = 44 + part_count * 4
            points = [struct.unpack_from("<dd", body, points_offset + index * 16)
                      for index in range(point_count)]
            shapes.append([points[start:end] for start, end in
                           zip(starts, starts[1:] + [point_count])])
        else:
            raise ValueError("Unexpected TMC road geometry type")
        offset += 8 + words * 2
    return shapes


def tmc_roads(archive: zipfile.ZipFile) -> tuple[dict[str, list[list[tuple[float, float]]]], dict[str, str]]:
    with archive.open(PREFIX + "tmc_format/LOCATIONDATASETS.DAT") as stream:
        datasets = list(csv.DictReader(io.TextIOWrapper(stream, encoding="utf-8-sig"), delimiter=";"))
    if len(datasets) != 1 or any(datasets[0].get(k) != v for k, v in
                                   (("CID", "11"), ("TABCD", "25"), ("VERSION", "11.0"))):
        raise ValueError("Unexpected TMC table identity")
    rows = dbf_rows(archive.read(ROAD_STEM + ".dbf"))
    shapes = shp_polylines(archive.read(ROAD_STEM + ".shp"))
    if len(rows) != len(shapes):
        raise ValueError("TMC road attributes and shapes differ in count")
    roads = {row["LCD"]: shape for row, shape in zip(rows, shapes)
             if row and row.get("CID") == "11" and row.get("TABCD") == "25"}
    with archive.open(PREFIX + "tmc_format/POINTS.DAT") as stream:
        points = list(csv.DictReader(io.TextIOWrapper(stream, encoding="utf-8-sig"), delimiter=";"))
    point_roads = {row["LCD"]: row["ROA_LCD"] for row in points
                   if row.get("CID") == "11" and row.get("TABCD") == "25"}
    return roads, point_roads


def decode_polyline6(value: str) -> list[tuple[float, float]]:
    coords = []
    index = lat = lon = 0
    while index < len(value):
        pair = []
        for _ in range(2):
            number = shift = 0
            while True:
                if index >= len(value):
                    raise ValueError("Invalid route shape")
                byte = ord(value[index]) - 63
                index += 1
                number |= (byte & 31) << shift
                shift += 5
                if byte < 32:
                    break
            pair.append(~(number >> 1) if number & 1 else number >> 1)
        lat += pair[0]
        lon += pair[1]
        coords.append((lon / 1_000_000, lat / 1_000_000))
    return coords


def point_segment_m(point: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    scale = 111_320 * math.cos(math.radians(point[1]))
    ax, ay = (a[0] - point[0]) * scale, (a[1] - point[1]) * 111_320
    bx, by = (b[0] - point[0]) * scale, (b[1] - point[1]) * 111_320
    dx, dy = bx - ax, by - ay
    fraction = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) if dx or dy else 0.0
    return math.hypot(ax + fraction * dx, ay + fraction * dy)


def road_distance_m(point: tuple[float, float], parts: list[list[tuple[float, float]]]) -> float:
    return min((point_segment_m(point, a, b) for part in parts
                for a, b in zip(part, part[1:])), default=math.inf)


def path_projection(point: tuple[float, float], shape: list[tuple[float, float]]) -> tuple[float, float, float]:
    """Nearest directed path position: distance m, progress m, bearing degrees."""
    scale = 111_320 * math.cos(math.radians(point[1]))
    best = (math.inf, 0.0, 0.0)
    progress = 0.0
    for a, b in zip(shape, shape[1:]):
        ax, ay = (a[0] - point[0]) * scale, (a[1] - point[1]) * 111_320
        bx, by = (b[0] - point[0]) * scale, (b[1] - point[1]) * 111_320
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        if length <= 0:
            continue
        fraction = max(0.0, min(1.0, -(ax * dx + ay * dy) / (length * length)))
        distance = math.hypot(ax + fraction * dx, ay + fraction * dy)
        if distance < best[0]:
            best = (distance, progress + fraction * length, math.degrees(math.atan2(dx, dy)) % 360)
        progress += length
    return best


def angular_difference(a: float, b: float) -> float:
    return abs((a - b + 180) % 360 - 180)


def quantiles(values: list[float]) -> dict[str, int]:
    if not values:
        return {}
    values.sort()
    return {name: round(values[int((len(values) - 1) * q)]) for name, q in
            (("p50", .5), ("p90", .9), ("max", 1.0))}


def sample(source: dict, audit: dict, per_frc: int) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for segment in source["segments"]:
        if str(segment.get("messageId")) not in audit["mapping"]:
            continue
        points = (segment.get("openlr") or {}).get("points") or []
        if points:
            group = str(points[0].get("frc", "unknown"))
            groups.setdefault(group, []).append(segment)
    selected = []
    for group in sorted(groups):
        members = sorted(groups[group], key=lambda item: str(item["messageId"]))
        count = min(per_frc, len(members))
        selected.extend(members[index * len(members) // count] for index in range(count))
    return selected


def post(base: str, path: str, payload: dict) -> dict:
    request = Request(base.rstrip("/") + path,
                      data=json.dumps(payload, separators=(",", ":")).encode(),
                      headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=20) as response:
        return json.load(response)


def graph_edge_shapes(host: str, edge_ids: set[int]) -> dict[int, list[tuple[float, float]]]:
    """Read exact directed shapes from the serving container, without local files."""
    if len(edge_ids) > 1000:
        raise ValueError("Graph shape sample exceeds the bounded audit limit")
    code = (
        "from valhalla.baldr.utils import GraphUtils; "
        "from valhalla.baldr import GraphId; "
        "import json,sys; "
        "ids=json.load(sys.stdin); "
        "graph=GraphUtils('/custom_files/valhalla.json'); "
        "shapes={str(i):graph.get_edge_shape(GraphId(int(i))) for i in ids}; "
        "print('EDGE_SHAPES_JSON='+json.dumps(shapes,separators=(',',':')))"
    )
    completed = subprocess.run(
        ["ssh", "-o", "BatchMode=yes", host,
         "docker exec -i valhalla python3 -c " + shlex.quote(code)],
        input=json.dumps(sorted(edge_ids)), text=True, capture_output=True, timeout=90,
        check=True,
    )
    lines = [line.removeprefix("EDGE_SHAPES_JSON=") for line in completed.stdout.splitlines()
             if line.startswith("EDGE_SHAPES_JSON=")]
    if len(lines) != 1:
        raise ValueError("Graph shape response missing or duplicated")
    raw = json.loads(lines[0])
    if set(map(int, raw)) != edge_ids:
        raise ValueError("Graph shape response does not match request")
    return {int(key): [(float(lon), float(lat)) for lon, lat in shape]
            for key, shape in raw.items()}


def batched_graph_shapes(host: str, edge_ids: set[int]) -> dict[int, list[tuple[float, float]]]:
    ordered = sorted(edge_ids)
    result = {}
    for offset in range(0, len(ordered), 1000):
        result.update(graph_edge_shapes(host, set(ordered[offset:offset + 1000])))
    return result


def connected_edge_shape(edge_ids: list[int], shapes: dict[int, list[tuple[float, float]]]) -> list[tuple[float, float]]:
    result: list[tuple[float, float]] = []
    for edge_id in edge_ids:
        shape = shapes[edge_id]
        if len(shape) < 2 or not all(math.isfinite(value) for point in shape for value in point):
            raise ValueError("Invalid graph edge geometry")
        if result:
            if point_segment_m(result[-1], shape[0], shape[0]) > 30:
                raise ValueError("Directed graph edge sequence is disconnected")
            result.extend(shape[1:])
        else:
            result.extend(shape)
    return result


def run(args: argparse.Namespace) -> dict:
    audit = remote_json(args.valhalla_host,
                        "cat " + shlex.quote(args.audit_path))
    source = remote_json(args.docker_host,
                         "docker exec csm-sim-situation-data-api cat " + shlex.quote(STATIC_PATH))
    with zipfile.ZipFile(args.zip) as archive:
        if archive.testzip() is not None:
            raise ValueError("TMC ZIP integrity failure")
        roads, point_roads = tmc_roads(archive)
    with urlopen(args.valhalla_url.rstrip("/") + "/status", timeout=10) as response:
        status = json.load(response)
    dataset = "sim-routing-2026-09-29-" + str(status["tileset_last_modified"])
    if audit["staticRevision"] != source["staticRevision"]:
        raise ValueError("Static source revision differs from audit")
    if not args.historical_control and audit["routingDataset"] != dataset:
        raise ValueError("Graph revision differs from candidate audit")
    verdicts: Counter[str] = Counter()
    by_frc: dict[str, Counter[str]] = {}
    distances = []
    endpoint_distances = []
    selected = ([segment for segment in source["segments"]
                 if str(segment.get("messageId")) in audit["mapping"]]
                if args.all_candidates else sample(source, audit, args.per_frc))
    shapes = None
    if args.graph_shapes:
        if args.historical_control:
            raise ValueError("Old baseline graph IDs cannot be inspected on the current graph")
        edge_ids = {int(edge["id"]) for segment in selected
                    for edge in audit["mapping"][str(segment["messageId"]) ]}
        shapes = batched_graph_shapes(args.valhalla_host, edge_ids)
    accepted: set[str] = set()
    for segment in selected:
        message_id = str(segment["messageId"])
        frc = str(((segment.get("openlr") or {}).get("points") or [{}])[0].get("frc", "unknown"))
        frc_counts = by_frc.setdefault(frc, Counter())
        def record(reason: str) -> None:
            verdicts[reason] += 1
            frc_counts[reason] += 1
        road_id = point_roads.get(str(segment.get("locationId") or ""))
        road = roads.get(road_id or "")
        if not road or not any(len(part) > 1 for part in road):
            record("no_comparable_tmc_road")
            continue
        coords = segment.get("coordinates") or []
        points = (segment.get("openlr") or {}).get("points") or []
        if len(coords) != 2 or len(points) != 2:
            record("unsupported_reference_shape")
            continue
        try:
            expected = [int(edge["id"]) for edge in audit["mapping"][message_id]]
            if shapes is not None:
                shape_coords = connected_edge_shape(expected, shapes)
                reference_coords = [(float(lon), float(lat)) for lon, lat in coords]
                start = path_projection(reference_coords[0], shape_coords)
                end = path_projection(reference_coords[-1], shape_coords)
                if start[0] > 35 or end[0] > 35:
                    record("graph_path_endpoint_mismatch")
                    continue
                if start[1] >= end[1] - 1:
                    record("graph_path_wrong_direction")
                    continue
                headings = [float(points[0]["bearing"]) * 360 / 256,
                            (float(points[1]["bearing"]) * 360 / 256 + 180) % 360]
                if any(angular_difference(projected[2], heading) > 45
                       for projected, heading in zip((start, end), headings)):
                    record("graph_path_bearing_mismatch")
                    continue
            else:
                headings = [float(points[0]["bearing"]) * 360 / 256,
                            (float(points[1]["bearing"]) * 360 / 256 + 180) % 360]
                locations = [{"lon": float(lon), "lat": float(lat), "radius": 20,
                              "search_cutoff": 20, "heading": headings[index], "heading_tolerance": 34}
                             for index, (lon, lat) in enumerate(coords)]
                route = post(args.valhalla_url, "/route", {"locations": locations, "costing": "auto",
                                                           "directions_type": "none"})
                shape = route["trip"]["legs"][0]["shape"]
                trace = post(args.valhalla_url, "/trace_attributes", {
                    "encoded_polyline": shape, "costing": "auto", "shape_match": "edge_walk",
                    "filters": {"action": "include", "attributes": ["edge.id"]},
                })
                actual = [int(edge["id"]) for edge in trace["edges"]]
                if not args.historical_control and actual != expected:
                    record("route_differs_from_candidate")
                    continue
                shape_coords = decode_polyline6(shape)
            if len(shape_coords) < 2:
                record("empty_shape")
                continue
            samples = shape_coords[::max(1, len(shape_coords) // 30)]
            if samples[-1] != shape_coords[-1]:
                samples.append(shape_coords[-1])
            endpoint_max = max(road_distance_m(point, road) for point in (shape_coords[0], shape_coords[-1]))
            max_distance = max(road_distance_m(point, road) for point in samples)
            if not math.isfinite(max_distance):
                record("invalid_tmc_geometry")
                continue
            distances.append(max_distance)
            endpoint_distances.append(endpoint_max)
            if endpoint_max > 100:
                record("tmc_geometry_not_aligned_at_endpoints")
            elif max_distance > 100:
                record("path_diverges_from_tmc_road")
            else:
                record("within_100m_of_tmc_road")
                accepted.add(message_id)
        except ValueError:
            record("graph_path_disconnected_or_invalid" if shapes is not None else "route_or_trace_error")
        except (KeyError, IndexError, TypeError, OSError, TimeoutError):
            record("graph_shape_error" if shapes is not None else "route_or_trace_error")
    with urlopen(args.valhalla_url.rstrip("/") + "/status", timeout=10) as response:
        after = json.load(response)
    if after.get("tileset_last_modified") != status.get("tileset_last_modified"):
        raise ValueError("Graph changed during audit")
    if args.private_output:
        if not args.graph_shapes or not args.all_candidates or args.historical_control:
            raise ValueError("Private output requires complete current-graph candidate audit")
        destination = args.private_output.resolve()
        private_root = (Path(__file__).resolve().parents[2] / "data/valhalla/tmc").resolve()
        if not destination.is_relative_to(private_root):
            raise ValueError("Private audit output must remain under ignored TMC data directory")
        destination.parent.mkdir(parents=True, exist_ok=True)
        archive_hash = hashlib.sha256(args.zip.read_bytes()).hexdigest()
        report = {
            "contractVersion": "tmc-graph-corridor-shadow-v1",
            "routingDataset": dataset,
            "staticRevision": source["staticRevision"],
            "inputMatcherVersion": audit["matcherVersion"],
            "tmcTableSha256": archive_hash,
            "sourceAuditSha256": hashlib.sha256(json.dumps(audit, sort_keys=True).encode()).hexdigest(),
            "mapping": {key: audit["mapping"][key] for key in sorted(accepted)},
        }
        descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as stream:
            with gzip.GzipFile(fileobj=stream, mode="wb") as compressed:
                compressed.write(json.dumps(report, separators=(",", ":"), sort_keys=True).encode())
    return {"contractVersion": "tmc-candidate-geography-v1", "routingDataset": dataset,
            "cohort": "historical_baseline_ids" if args.historical_control else "current_route_candidates",
            "geometryMethod": "directed_graph_edges" if args.graph_shapes else "valhalla_reroute",
            "sampleCount": len(selected), "byResult": dict(sorted(verdicts.items())),
            "shadowGeographyPassCount": len(accepted),
            "byFrc": {frc: dict(sorted(counts.items())) for frc, counts in sorted(by_frc.items())},
            "endpointToTmcRoadMaxDistanceMeters": quantiles(endpoint_distances),
            "routeToTmcRoadMaxDistanceMeters": quantiles(distances),
            "caveat": "TMC road proximity is an independent corridor check, not proof of directed-edge or ETA correctness."}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", required=True, type=Path)
    parser.add_argument("--audit-path", default="/home/voldzi/valhalla-owned-deploy/route-audit-v3-20260929.json.gz")
    parser.add_argument("--valhalla-host", default="valhalla.home.cz")
    parser.add_argument("--docker-host", default="docker.home.cz")
    parser.add_argument("--valhalla-url", default="http://valhalla.home.cz:8002")
    parser.add_argument("--per-frc", type=int, default=12)
    parser.add_argument("--historical-control", action="store_true",
                        help="Use old baseline IDs as a geometry control; do not compare old edge IDs")
    parser.add_argument("--graph-shapes", action="store_true",
                        help="Read exact candidate edge geometry from active Valhalla GraphUtils")
    parser.add_argument("--all-candidates", action="store_true",
                        help="Audit every existing route candidate, not a sample")
    parser.add_argument("--private-output", type=Path,
                        help="Write a mode-0600 shadow-only map inside ignored data/valhalla/tmc")
    args = parser.parse_args()
    if not 1 <= args.per_frc <= 30:
        parser.error("--per-frc must be between 1 and 30")
    print(json.dumps(run(args), sort_keys=True))


if __name__ == "__main__":
    main()
