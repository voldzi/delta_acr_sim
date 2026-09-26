#!/usr/bin/env python3
"""Compare two read-only OpenLR decoders without printing provider locations."""

from __future__ import annotations

import argparse
from collections import Counter
import importlib.util
import json
from pathlib import Path


def load_updater(path: Path):
    spec = importlib.util.spec_from_file_location("traffic_update", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load traffic updater")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def select_segments(segments: list[dict], mapped: dict, per_frc: int) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for segment in segments:
        if str(segment.get("messageId", "")) not in mapped:
            continue
        points = segment.get("openlr", {}).get("points") or []
        if not points:
            continue
        groups.setdefault(str(points[0].get("frc", "unknown")), []).append(segment)
    chosen: list[dict] = []
    for frc in sorted(groups):
        group = sorted(groups[frc], key=lambda item: str(item["messageId"]))
        count = min(per_frc, len(group))
        chosen.extend(group[index * len(group) // count] for index in range(count))
    return chosen


def compare(module, selected: list[dict], mapped: dict, graph, url: str) -> dict:
    reasons: Counter[str] = Counter()
    graph_status: Counter[str] = Counter()
    graph_errors: Counter[str] = Counter()
    length_relation: Counter[str] = Counter()
    close_path_shape: Counter[str] = Counter()
    matching_edges = 0
    for segment in selected:
        class ObservedGraph:
            def path(self, *args):
                try:
                    result = graph.path(*args)
                except (RuntimeError, OSError, ValueError, json.JSONDecodeError) as error:
                    graph_errors[type(error).__name__] += 1
                    raise
                graph_status[str(result.get("status", "missing"))] += 1
                if result.get("status") == "ok":
                    expected = float(segment["openlr"]["points"][0]["distanceToNext"])
                    actual = float(result["lengthMeters"])
                    ratio = actual / expected
                    length_relation["short" if ratio < 0.9 else "long" if ratio > 1.1 else "close"] += 1
                    if abs(actual - expected) <= max(35, expected * 0.1):
                        ids = [int(value) for value in result["edges"]]
                        route_ids = [int(edge["id"]) for edge in mapped[str(segment["messageId"])]]
                        close_path_shape["source_matches" if ids and ids[0] == args[0] else "source_differs"] += 1
                        close_path_shape["target_matches" if ids and ids[-1] == args[2] else "target_differs"] += 1
                        close_path_shape["first_is_target" if ids and ids[0] == args[2] else "first_not_target"] += 1
                        close_path_shape["last_is_source" if ids and ids[-1] == args[0] else "last_not_source"] += 1
                        close_path_shape["unique" if len(ids) == len(set(ids)) else "repeated_edge"] += 1
                        close_path_shape["same_as_route" if ids == route_ids else "different_from_route"] += 1
                return result
        edges, reason = module.bounded_graph_candidate(url, segment, ObservedGraph())
        reasons[reason] += 1
        if edges and [int(edge["id"]) for edge in edges] == [
            int(edge["id"]) for edge in mapped[str(segment["messageId"])]]:
            matching_edges += 1
    return {
        "sampleCount": len(selected), "graphReasonCounts": dict(reasons),
        "graphErrorTypes": dict(graph_errors),
        "graphPathStatusCounts": dict(graph_status),
        "pathLengthRelationCounts": dict(length_relation),
        "closePathShapeCounts": dict(close_path_shape),
        "sameDirectedEdgeSequenceCount": matching_edges,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--updater", type=Path, required=True)
    parser.add_argument("--static", type=Path, required=True)
    parser.add_argument("--route-audit", type=Path, required=True)
    parser.add_argument("--graph-helper", type=Path, required=True)
    parser.add_argument("--graph-config", type=Path, required=True)
    parser.add_argument("--valhalla-url", default="http://127.0.0.1:8002")
    parser.add_argument("--per-frc", type=int, default=8)
    args = parser.parse_args()
    if not 1 <= args.per_frc <= 20:
        parser.error("--per-frc must be between 1 and 20")
    updater = load_updater(args.updater)
    source = updater.read_gzip_json(args.static)
    audit = updater.read_gzip_json(args.route_audit)
    if source.get("staticRevision") != audit.get("staticRevision"):
        raise RuntimeError("route audit and static cache revisions differ")
    if updater.routing_dataset(args.valhalla_url) != audit.get("routingDataset"):
        raise RuntimeError("route audit and active graph revisions differ")
    selected = select_segments(source["segments"], audit["mapping"], args.per_frc)
    graph = updater.GraphPathClient(args.graph_helper, args.graph_config)
    try:
        result = compare(updater, selected, audit["mapping"], graph, args.valhalla_url)
    finally:
        graph.close()
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
