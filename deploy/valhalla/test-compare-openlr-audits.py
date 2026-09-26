#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path


spec = importlib.util.spec_from_file_location("compare_openlr_audits", Path(__file__).with_name("compare-openlr-audits.py"))
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def main() -> None:
    revision = {"routingDataset": "dataset", "staticRevision": "static"}
    graph = {**revision, "mapping": {
        "identical": [{"id": 1}, {"id": 2}],
        "subpath": [{"id": 4}],
        "different": [{"id": 9}],
        "graph-only": [{"id": 10}],
    }}
    route = {**revision, "mapping": {
        "identical": [{"id": 1}, {"id": 2}],
        "subpath": [{"id": 3}, {"id": 4}, {"id": 5}],
        "different": [{"id": 8}],
        "route-only": [{"id": 11}],
    }}
    static = {"staticRevision": "static", "segments": [
        {"messageId": "graph-only", "openlr": {"points": [{"fow": "4"}]}},
        {"messageId": "different", "openlr": {"points": [{"fow": "3"}]}},
    ]}
    result = module.compare(graph, route, static)
    assert result["sharedSegmentCount"] == 3
    assert result["sharedEdgeRelation"] == {
        "identical": 1, "graph_is_contiguous_subpath": 1, "disjoint_edges": 1,
    }
    assert result["graphOnlyByFormOfWay"] == {"4": 1}
    assert result["disagreementByFormOfWay"] == {"3": 1}
    try:
        module.compare(graph, {**route, "staticRevision": "other"}, static)
    except RuntimeError as error:
        assert "different" in str(error)
    else:
        raise AssertionError("cross-release comparison must be refused")
    print("OpenLR audit comparison tests passed.")


if __name__ == "__main__":
    main()
