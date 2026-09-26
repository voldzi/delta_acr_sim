#!/usr/bin/env python3
"""Read-only, bounded independent recheck of a Valhalla route audit.

The two gzip payloads are streamed over SSH into memory, never written locally.
Only aggregate counts are printed; source coordinates and message IDs stay hidden.
"""

from __future__ import annotations

import argparse
from collections import Counter
import gzip
import json
import math
import shlex
import subprocess
from urllib.request import Request, urlopen

def remote_gzip(command: list[str]) -> dict:
    return json.loads(gzip.decompress(subprocess.check_output(command, timeout=45)))


def post(base_url: str, path: str, payload: dict) -> dict:
    request = Request(
        f"{base_url.rstrip('/')}{path}",
        data=json.dumps(payload, separators=(",", ":")).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urlopen(request, timeout=20) as response:
        return json.load(response)


def angle_difference(a: float, b: float) -> float:
    return abs((a - b + 180) % 360 - 180)


def sample_ids(source: dict, audit: dict) -> list[str]:
    groups: dict[str, list[str]] = {}
    for segment in source["segments"]:
        message_id = str(segment["messageId"])
        if message_id in audit["mapping"]:
            frc = str(segment["openlr"]["points"][0]["frc"])
            groups.setdefault(frc, []).append(message_id)
    chosen = []
    for group in groups.values():
        group.sort()
        count = min(8, len(group))
        chosen.extend(group[(index * len(group)) // count] for index in range(count))
    return chosen


def recheck(base_url: str, segment: dict, mapped_edges: list[dict]) -> str:
    points = segment["openlr"]["points"]
    start_heading = float(points[0]["bearing"]) * 360 / 256
    end_heading = (float(points[-1]["bearing"]) * 360 / 256 + 180) % 360
    locations = [
        {"lon": lon, "lat": lat, "radius": 20, "search_cutoff": 20,
         "heading": start_heading if index == 0 else end_heading, "heading_tolerance": 34}
        for index, (lon, lat) in enumerate(segment["coordinates"])
    ]
    try:
        route = post(base_url, "/route", {"locations": locations, "costing": "auto", "directions_type": "none"})
        shape = route["trip"]["legs"][0]["shape"]
        trace = post(base_url, "/trace_attributes", {
            "encoded_polyline": shape, "costing": "auto", "shape_match": "edge_walk",
            "filters": {"action": "include", "attributes": [
                "edge.id", "edge.length", "edge.begin_heading", "edge.end_heading",
                "edge.road_class", "edge.speed",
            ]},
        })
        edges = trace["edges"]
        if [int(edge["id"]) for edge in edges] != [int(edge["id"]) for edge in mapped_edges]:
            return "edge_sequence_changed"
        expected = sum(float(point.get("distanceToNext") or 0) for point in points[:-1])
        actual = sum(float(edge["length"]) * 1000 for edge in edges)
        if not math.isfinite(expected) or abs(expected - actual) > max(35, expected * 0.1):
            return "length_mismatch"
        if (angle_difference(start_heading, float(edges[0]["begin_heading"])) > 35 or
            angle_difference(end_heading, float(edges[-1]["end_heading"])) > 35):
            return "bearing_mismatch"
        if float(edges[0].get("source_percent_along", 0)) > 0.05 or float(edges[-1].get("target_percent_along", 1)) < 0.95:
            return "partial_edge"
        return "consistent"
    except (KeyError, IndexError, TypeError, ValueError, TimeoutError, OSError) as error:
        return f"request_or_response_error:{type(error).__name__}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audit-path", required=True, help="Readable route-audit gzip path on the Valhalla host")
    parser.add_argument("--valhalla-host", default="valhalla.home.cz")
    parser.add_argument("--docker-host", default="docker.home.cz")
    parser.add_argument("--valhalla-url", default="http://valhalla.home.cz:8002")
    parser.add_argument("--static-cache", default="/valhalla-traffic-cache/static-segments.json.gz")
    args = parser.parse_args()
    audit = remote_gzip([
        "ssh", "-o", "BatchMode=yes", args.valhalla_host,
        f"cat {shlex.quote(args.audit_path)}",
    ])
    source = remote_gzip([
        "ssh", "-o", "BatchMode=yes", args.docker_host,
        f"docker exec csm-sim-situation-data-api cat {shlex.quote(args.static_cache)}",
    ])
    if audit["staticRevision"] != source["staticRevision"]:
        raise RuntimeError("Audit and source static revisions differ")
    by_id = {str(segment["messageId"]): segment for segment in source["segments"]}
    results = Counter()
    sample = sample_ids(source, audit)
    for index, message_id in enumerate(sample, 1):
        results[recheck(args.valhalla_url, by_id[message_id], audit["mapping"][message_id])] += 1
        if index % 10 == 0:
            print(f"Rechecked {index}/{len(sample)} candidate paths", flush=True)
    print(json.dumps({"sampleCount": len(sample), "byResult": dict(results)}, sort_keys=True))


if __name__ == "__main__":
    main()
