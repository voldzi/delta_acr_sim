#!/usr/bin/env python3
"""Compare isolated OpenLR mapping audits using aggregate, non-location output."""

from __future__ import annotations

import argparse
from collections import Counter
import gzip
import json
from pathlib import Path


def load(path: Path) -> dict:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def contiguous_subsequence(shorter: list[int], longer: list[int]) -> bool:
    return bool(shorter) and any(longer[index:index + len(shorter)] == shorter
                                 for index in range(len(longer) - len(shorter) + 1))


def compare(graph: dict, route: dict, static: dict) -> dict:
    if (graph.get("routingDataset") != route.get("routingDataset") or
        graph.get("staticRevision") != route.get("staticRevision") or
        graph.get("staticRevision") != static.get("staticRevision")):
        raise RuntimeError("audits or static cache use different graph/source revisions")
    graph_map = graph["mapping"]
    route_map = route["mapping"]
    shared = set(graph_map) & set(route_map)
    relation: Counter[str] = Counter()
    graph_only_fow: Counter[str] = Counter()
    disagreement_fow: Counter[str] = Counter()
    def form_of_way(segment: dict) -> str:
        reference = segment.get("openlr") or {}
        points = reference.get("points") or []
        return str(points[0].get("fow", "unknown")) if points else "unknown"

    fow_by_id = {str(segment["messageId"]): form_of_way(segment) for segment in static["segments"]}
    for message_id in shared:
        graph_ids = [int(edge["id"]) for edge in graph_map[message_id]]
        route_ids = [int(edge["id"]) for edge in route_map[message_id]]
        if graph_ids == route_ids:
            relation["identical"] += 1
        elif contiguous_subsequence(graph_ids, route_ids):
            relation["graph_is_contiguous_subpath"] += 1
        elif set(graph_ids) & set(route_ids):
            relation["some_shared_edges"] += 1
            disagreement_fow[fow_by_id.get(message_id, "unknown")] += 1
        else:
            relation["disjoint_edges"] += 1
            disagreement_fow[fow_by_id.get(message_id, "unknown")] += 1
    for message_id in set(graph_map) - set(route_map):
        graph_only_fow[fow_by_id.get(message_id, "unknown")] += 1
    return {
        "graphMapped": len(graph_map), "routeMapped": len(route_map),
        "sharedSegmentCount": len(shared),
        "graphOnlyCount": len(set(graph_map) - set(route_map)),
        "routeOnlyCount": len(set(route_map) - set(graph_map)),
        "sharedEdgeRelation": dict(relation),
        "graphOnlyByFormOfWay": dict(graph_only_fow),
        "disagreementByFormOfWay": dict(disagreement_fow),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--graph-audit", type=Path, required=True)
    parser.add_argument("--route-audit", type=Path, required=True)
    parser.add_argument("--static", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(compare(load(args.graph_audit), load(args.route_audit), load(args.static)), sort_keys=True))


if __name__ == "__main__":
    main()
