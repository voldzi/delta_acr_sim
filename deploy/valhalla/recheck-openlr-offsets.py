#!/usr/bin/env python3
"""Independently recheck a bounded sample of offset OpenLR audit matches."""

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


def sample(segments: list[dict], mapping: dict, per_frc: int) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for segment in segments:
        if str(segment.get("messageId", "")) not in mapping:
            continue
        reference = segment.get("openlr") or {}
        if not (reference.get("positiveOffsetMeters") or reference.get("negativeOffsetMeters")):
            continue
        points = reference.get("points") or []
        if points:
            groups.setdefault(str(points[0].get("frc", "unknown")), []).append(segment)
    chosen: list[dict] = []
    for frc in sorted(groups):
        group = sorted(groups[frc], key=lambda value: str(value["messageId"]))
        count = min(per_frc, len(group))
        chosen.extend(group[index * len(group) // count] for index in range(count))
    return chosen


def check(updater, url: str, segment: dict, mapped: list[dict]) -> str:
    reference = segment["openlr"]
    points = reference["points"]
    try:
        headings = [float(points[0]["bearing"]) * 360 / 256,
                    (float(points[-1]["bearing"]) * 360 / 256 + 180) % 360]
        locations = [
            {"lon": float(coordinate[0]), "lat": float(coordinate[1]),
             "radius": 20, "search_cutoff": 20, "heading": headings[index],
             "heading_tolerance": 34}
            for index, coordinate in enumerate(segment["coordinates"])
        ]
        status, route = updater.request_json(f"{url.rstrip('/')}/route", payload={
            "locations": locations, "costing": "auto",
            "costing_options": {"auto": {"shortest": True}}, "directions_type": "none",
        }, timeout=20)
        if status != 200 or not isinstance(route, dict):
            return "route_unavailable"
        shape = route["trip"]["legs"][0]["shape"]
        status, trace = updater.request_json(f"{url.rstrip('/')}/trace_attributes", payload={
            "encoded_polyline": shape, "costing": "auto", "shape_match": "edge_walk",
        }, timeout=20)
        if status != 200 or not isinstance(trace, dict):
            return "trace_unavailable"
        edges = trace["edges"]
        ids = [int(edge["id"]) for edge in edges]
        lengths_m = [float(edge["length"]) * 1000 for edge in edges]
        source_percent = float(edges[0].get("source_percent_along", 0))
        target_percent = float(edges[-1].get("target_percent_along", 1))
        checked = updater.fully_covered_edges(
            ids, lengths_m, source_percent, target_percent,
            float(reference.get("positiveOffsetMeters") or 0),
            float(reference.get("negativeOffsetMeters") or 0),
        )
        mapped_ids = [int(edge["id"]) for edge in mapped]
        if checked == mapped_ids:
            return "identical_whole_edges"
        if checked and any(checked[index:index + len(mapped_ids)] == mapped_ids
                           for index in range(len(checked) - len(mapped_ids) + 1)):
            return "graph_is_contiguous_subpath"
        if set(checked) & set(mapped_ids):
            return "different_with_shared_edges"
        return "different_disjoint_edges"
    except (KeyError, IndexError, TypeError, ValueError, OverflowError, RuntimeError, OSError) as error:
        return f"unavailable_or_invalid_{type(error).__name__}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--updater", type=Path, required=True)
    parser.add_argument("--static", type=Path, required=True)
    parser.add_argument("--graph-audit", type=Path, required=True)
    parser.add_argument("--valhalla-url", default="http://127.0.0.1:8002")
    parser.add_argument("--per-frc", type=int, default=6)
    args = parser.parse_args()
    if not 1 <= args.per_frc <= 10:
        parser.error("--per-frc must be between 1 and 10")
    updater = load_updater(args.updater)
    source = updater.read_gzip_json(args.static)
    audit = updater.read_gzip_json(args.graph_audit)
    if (source.get("staticRevision") != audit.get("staticRevision") or
        updater.routing_dataset(args.valhalla_url) != audit.get("routingDataset")):
        raise RuntimeError("audit and active source/map revisions differ")
    selected = sample(source["segments"], audit["mapping"], args.per_frc)
    results: Counter[str] = Counter()
    disagreements_by_fow: Counter[str] = Counter()
    for segment in selected:
        reason = check(updater, args.valhalla_url, segment,
                       audit["mapping"][str(segment["messageId"])])
        results[reason] += 1
        if reason.startswith("different_"):
            disagreements_by_fow[str(segment["openlr"]["points"][0].get("fow", "unknown"))] += 1
    print(json.dumps({"sampleCount": len(selected), "results": dict(results),
                      "disagreementsByFormOfWay": dict(disagreements_by_fow)}, sort_keys=True))


if __name__ == "__main__":
    main()
