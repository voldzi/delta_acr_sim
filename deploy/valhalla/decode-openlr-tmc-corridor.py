#!/usr/bin/env python3
"""Isolated TMC-corridor OpenLR decoder probe; never writes live traffic.

The licensed road geometry and SIM static records stay in process memory.
Only aggregate rejection counts are printed. A match is exploratory until
independent edge/direction review and the ADR 0027 acceptance gate pass.
"""

from __future__ import annotations

import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path
import select
import shlex
import subprocess
import threading
import zipfile
from urllib.request import urlopen


HERE = Path(__file__).resolve().parent


def import_file(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError("Required decoder module is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


traffic = import_file("traffic_update_probe", "traffic-update.py")
geography = import_file("tmc_geography_probe", "audit-tmc-candidate-geography.py")


class CorridorGraphClient:
    def __init__(self, host: str, helper: str) -> None:
        command = "docker exec -i valhalla " + shlex.quote(helper) + " /custom_files/valhalla.json --corridor-stream"
        self.process = subprocess.Popen(
            ["ssh", "-o", "BatchMode=yes", host, command],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        self.lock = threading.Lock()
        self.request_id = 0

    def path(self, source: int, source_percent: float, target: int, target_percent: float,
             max_m: float, class_mask: int, parts: list[list[tuple[float, float]]]) -> dict:
        with self.lock:
            if self.process.poll() is not None or self.process.stdin is None or self.process.stdout is None:
                raise RuntimeError("Corridor graph helper unavailable")
            self.request_id += 1
            request = {
                "requestId": self.request_id,
                "sourceEdge": source,
                "sourcePercent": source_percent,
                "targetEdge": target,
                "targetPercent": target_percent,
                "maxMeters": max_m,
                "roadClasses": class_mask,
                "corridorRadiusMeters": 100,
                "corridorParts": parts,
            }
            try:
                self.process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
                self.process.stdin.flush()
            except BrokenPipeError as exc:
                raise RuntimeError("Corridor graph helper stopped before request") from exc
            for _ in range(64):
                if not select.select([self.process.stdout], [], [], 30)[0]:
                    self.process.kill()
                    raise TimeoutError("Corridor graph helper timed out")
                line = self.process.stdout.readline()
                if not line:
                    raise RuntimeError("Corridor graph helper stopped")
                try:
                    result = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(result, dict) or "requestId" not in result:
                    continue
                if result["requestId"] != self.request_id:
                    raise RuntimeError("Corridor graph response out of sequence")
                return result
            raise RuntimeError("Too many graph helper diagnostic lines")

    def close(self) -> None:
        if self.process.stdin:
            try:
                self.process.stdin.close()
            except BrokenPipeError:
                pass
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)


class SegmentCorridor:
    def __init__(self, client: CorridorGraphClient, road: list[list[tuple[float, float]]]) -> None:
        self.client = client
        self.road = road

    def path(self, source: int, source_percent: float, target: int, target_percent: float,
             max_m: float, class_mask: int) -> dict:
        return self.client.path(source, source_percent, target, target_percent,
                                max_m, class_mask, self.road)


def run(args: argparse.Namespace) -> dict:
    source = geography.remote_json(args.docker_host,
                                   "docker exec csm-sim-situation-data-api cat " +
                                   shlex.quote(geography.STATIC_PATH))
    audit = geography.remote_json(args.valhalla_host,
                                  "cat " + shlex.quote(args.route_audit))
    with zipfile.ZipFile(args.zip) as archive:
        if archive.testzip() is not None:
            raise ValueError("TMC table ZIP integrity failure")
        roads, point_roads = geography.tmc_roads(archive)
    with urlopen(args.valhalla_url.rstrip("/") + "/status", timeout=10) as response:
        status = json.load(response)
    dataset = "sim-routing-2026-09-29-" + str(status["tileset_last_modified"])
    if audit["routingDataset"] != dataset or audit["staticRevision"] != source["staticRevision"]:
        raise ValueError("Graph/static revision does not match route audit")
    selected = geography.sample(source, audit, args.per_frc)
    if args.max_segments:
        selected = selected[:args.max_segments]
    counts: Counter[str] = Counter()
    output: dict[str, list[dict]] = {}
    matched: dict[str, tuple[dict, list[list[tuple[float, float]]]]] = {}
    client = CorridorGraphClient(args.valhalla_host, args.helper)
    try:
        for segment in selected:
            message_id = str(segment["messageId"])
            road_id = point_roads.get(str(segment.get("locationId") or ""))
            road = roads.get(road_id or "")
            if not road:
                counts["no_tmc_road"] += 1
                continue
            if sum(map(len, road)) > 4000:
                counts["road_too_large"] += 1
                continue
            reference = segment.get("coordinates") or []
            if len(reference) != 2 or any(geography.road_distance_m(tuple(point), road) > 100
                                          for point in reference):
                counts["reference_outside_tmc_road"] += 1
                continue
            edges, reason = traffic.bounded_graph_candidate(
                args.valhalla_url, segment, SegmentCorridor(client, road))
            counts[reason] += 1
            if edges:
                output[message_id] = edges
                matched[message_id] = (segment, road)
    finally:
        client.close()
    with urlopen(args.valhalla_url.rstrip("/") + "/status", timeout=10) as response:
        after = json.load(response)
    if after.get("tileset_last_modified") != status.get("tileset_last_modified"):
        raise ValueError("Routing graph changed during decoder probe")
    if output:
        shape_ids = {int(edge["id"]) for path in output.values() for edge in path}
        shapes = geography.batched_graph_shapes(args.valhalla_host, shape_ids)
        for message_id, path in output.items():
            segment, road = matched[message_id]
            points = (segment.get("openlr") or {}).get("points") or []
            try:
                shape = geography.connected_edge_shape([int(edge["id"]) for edge in path], shapes)
                reference = [tuple(map(float, pair)) for pair in segment["coordinates"]]
                start, end = (geography.path_projection(point, shape) for point in reference)
                headings = [float(points[0]["bearing"]) * 360 / 256,
                            (float(points[1]["bearing"]) * 360 / 256 + 180) % 360]
                if start[0] > 35 or end[0] > 35 or start[1] >= end[1] - 1:
                    counts["independent_endpoint_or_direction_reject"] += 1
                elif any(geography.angular_difference(value[2], heading) > 45
                         for value, heading in zip((start, end), headings)):
                    counts["independent_bearing_reject"] += 1
                elif max(geography.road_distance_m(point, road) for point in shape) > 100:
                    counts["independent_corridor_reject"] += 1
                else:
                    counts["independent_geography_pass"] += 1
            except (ValueError, KeyError, IndexError, TypeError):
                counts["independent_invalid_graph_shape"] += 1
    # No private map is written or used by live traffic. Multiple plausible
    # paths and large-sample false-positive rates remain separate gates.
    return {"contractVersion": "openlr-tmc-corridor-probe-v1", "routingDataset": dataset,
            "testedReferences": len(selected), "candidatePathCount": len(output),
            "rejectionCounts": dict(sorted(counts.items())),
            "note": "Probe only; no candidate is approved for live traffic."}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", type=Path, required=True)
    parser.add_argument("--route-audit", default="/home/voldzi/valhalla-owned-deploy/route-audit-v3-20260929.json.gz")
    parser.add_argument("--valhalla-host", default="valhalla.home.cz")
    parser.add_argument("--docker-host", default="docker.home.cz")
    parser.add_argument("--valhalla-url", default="http://valhalla.home.cz:8002")
    parser.add_argument("--helper", default="/tmp/openlr-corridor-probe")
    parser.add_argument("--per-frc", type=int, default=8)
    parser.add_argument("--max-segments", type=int, default=0)
    args = parser.parse_args()
    if not 1 <= args.per_frc <= 30 or not 0 <= args.max_segments <= 240:
        parser.error("Probe limit must be 1–30 per FRC and at most 240 total")
    print(json.dumps(run(args), sort_keys=True))


if __name__ == "__main__":
    main()
