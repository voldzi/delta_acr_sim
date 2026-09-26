#!/usr/bin/env python3
from __future__ import annotations

from io import BytesIO
import importlib.util
import json
from pathlib import Path
import struct
import tarfile
import tempfile

MODULE_PATH = Path(__file__).with_name("traffic-update.py")
SPEC = importlib.util.spec_from_file_location("traffic_update", MODULE_PATH)
assert SPEC and SPEC.loader
traffic = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(traffic)


def graph_id(level: int, tile_id: int, edge_index: int) -> int:
    return level | (tile_id << 3) | (edge_index << 25)


def make_archive(path: Path, level: int, tile_id: int, edges: int) -> None:
    tile_name = f"{level}/{tile_id // 1000000:03d}/{tile_id // 1000 % 1000:03d}/{tile_id % 1000:03d}.gph"
    header = struct.pack("<2Q4I", level | (tile_id << 3), 0, edges, 3, 0, 0)
    with tarfile.open(path, "w") as archive:
        info = tarfile.TarInfo(tile_name)
        info.size = len(header) + edges * 8
        archive.addfile(info, BytesIO(header + b"\0" * (edges * 8)))


def main() -> None:
    assert traffic.graph_id_parts(graph_id(2, 807177, 210837)) == (2, 807177, 210837)
    assert traffic.parse_iso_timestamp("2026-09-14T19:49:03+02:00") == traffic.parse_iso_timestamp("2026-09-14T17:49:03Z")
    word = traffic.traffic_word(36, 90)
    assert word & 0x7F == 18
    assert (word >> 28) & 0xFF == 255
    assert (word >> 44) & 0x3F > 1

    reference = {"openlr": {"points": [
        {"role": "first", "bearing": 42, "distanceToNext": 287},
        {"role": "last", "bearing": 172},
    ]}}
    valid_edges = [
        {"id": 1, "length": 0.140, "begin_heading": 61, "end_heading": 62},
        {"id": 2, "length": 0.147, "begin_heading": 62, "end_heading": 63},
    ]
    assert traffic.trace_matches_openlr(reference, valid_edges)
    assert not traffic.trace_matches_openlr(reference, [{**valid_edges[0], "length": 0.62}])
    assert not traffic.trace_matches_openlr(reference, [{**valid_edges[0], "begin_heading": 160}, valid_edges[1]])
    assert not traffic.trace_matches_openlr(reference, [valid_edges[0], {**valid_edges[1], "end_heading": 160}])
    assert not traffic.trace_matches_openlr({"openlr": {**reference["openlr"], "positiveOffsetMeters": 10}}, valid_edges)
    assert not traffic.trace_matches_openlr({"openlr": {**reference["openlr"], "negativeOffsetMeters": 10}}, valid_edges)
    assert not traffic.trace_matches_openlr({"openlr": {"points": [{"role": "first"}, {"role": "last"}]}}, valid_edges)
    assert traffic.trace_rejection_reason(reference, valid_edges) is None
    assert traffic.trace_rejection_reason(reference, [{**valid_edges[0], "length": 0.62}]) == "length_mismatch"
    assert traffic.trace_rejection_reason(reference, [{**valid_edges[0], "begin_heading": 160}, valid_edges[1]]) == "first_bearing_mismatch"
    assert traffic.trace_rejection_reason(reference, [valid_edges[0], {**valid_edges[1], "end_heading": 160}]) == "last_bearing_mismatch"
    assert traffic.trace_rejection_reason({"openlr": {**reference["openlr"], "positiveOffsetMeters": 10}}, valid_edges) == "offset_not_supported"
    assert traffic.mapping_path(Path("/tmp"), "dataset", "revision") != traffic.mapping_path(Path("/tmp"), "dataset", "other-revision")
    assert traffic.mapping_path(Path("/tmp"), "dataset", "revision") != traffic.mapping_path(Path("/tmp"), "dataset", "revision", traffic.ROUTE_MATCHER_VERSION)
    original_request_json = traffic.request_json
    try:
        traffic.request_json = lambda *args, **kwargs: (200, {"edges": valid_edges})
        matched_id, matched_edges, matched_reason = traffic.map_segment("http://valhalla.test", {
            "messageId": "reference-1", "coordinates": [[14.0, 50.0], [14.001, 50.001]], **reference
        })
        assert matched_id == "reference-1" and [edge["id"] for edge in matched_edges] == [1, 2] and matched_reason == "matched"
        rejected_id, rejected_edges, rejected_reason = traffic.map_segment("http://valhalla.test", {
            "messageId": "reference-2", "coordinates": [[14.0, 50.0], [14.001, 50.001]],
            "openlr": {**reference["openlr"], "positiveOffsetMeters": 10},
        })
        assert rejected_id == "reference-2" and rejected_edges == [] and rejected_reason == "offset_not_supported"
        traffic.request_json = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("HTTP 444 from Valhalla"))
        _, _, reason = traffic.map_segment("http://valhalla.test", {
            "messageId": "reference-3", "coordinates": [[14.0, 50.0], [14.001, 50.001]], **reference
        })
        assert reason == "valhalla_error_444"
        assert traffic.valhalla_failure_reason(RuntimeError('HTTP 400 from Valhalla: {"error_code":444,"error":"no path"}')) == "valhalla_error_444"
        assert traffic.valhalla_failure_reason(RuntimeError('HTTP 400 from Valhalla: {"error_code":171}')) == "valhalla_error_171"
        assert traffic.valhalla_failure_reason(RuntimeError("HTTP 502 from Valhalla")) == "valhalla_5xx"
        assert traffic.valhalla_failure_reason(TimeoutError("timed out")) == "valhalla_timeout"
        route_reference = {
            "messageId": "route-reference", "coordinates": [[14.0, 50.0], [14.001, 50.001]],
            "openlr": {"points": [
                {"frc": "3", "fow": "3", "bearing": 42, "distanceToNext": 287},
                {"bearing": 172},
            ]},
        }
        def locate_edge(edge_id: int, percent: float) -> dict:
            return {"edge_id": {"value": edge_id}, "distance": 2, "heading": 62,
                    "percent_along": percent, "edge": {"classification": {"classification": "secondary"}}}
        located = [{"edges": [locate_edge(1, 0)]}, {"edges": [locate_edge(2, 1)]}]
        route_edges = [
            {**valid_edges[0], "road_class": "secondary", "speed": 80},
            {**valid_edges[1], "road_class": "secondary", "speed": 80},
        ]
        def route_request(url: str, **kwargs: object) -> tuple[int, object]:
            if url.endswith("/locate"):
                assert kwargs["payload"]["locations"][0]["radius"] == 20
                return 200, located
            if url.endswith("/route"):
                return 200, {"trip": {"legs": [{"shape": "encoded-route"}]}}
            if kwargs["payload"].get("shape_match") == "edge_walk":
                return 200, {"edges": route_edges}
            raise RuntimeError('HTTP 400 from Valhalla: {"error_code":444}')
        traffic.request_json = route_request
        _, default_edges, default_reason = traffic.map_segment("http://valhalla.test", route_reference)
        assert default_edges == [] and default_reason == "valhalla_error_444"
        _, fallback_edges, fallback_reason = traffic.map_segment("http://valhalla.test", route_reference, True)
        assert [edge["id"] for edge in fallback_edges] == [1, 2] and fallback_reason == "route_matched"
        located[0]["edges"].append(locate_edge(3, 0))
        _, ambiguous_edges, ambiguous_reason = traffic.map_segment("http://valhalla.test", route_reference, True)
        assert ambiguous_edges == [] and ambiguous_reason == "route_ambiguous_endpoint"
        located[0]["edges"].pop()
        route_edges[0]["source_percent_along"] = 0.2
        _, partial_edges, partial_reason = traffic.map_segment("http://valhalla.test", route_reference, True)
        assert partial_edges == [] and partial_reason == "route_partial_edge"
        route_edges[0].pop("source_percent_along")
        route_edges[0]["road_class"] = "motorway"
        _, wrong_road_edges, wrong_road_reason = traffic.map_segment("http://valhalla.test", route_reference, True)
        assert wrong_road_edges == [] and wrong_road_reason == "route_road_class_mismatch"
        route_edges[0]["road_class"] = "secondary"
        _, offset_edges, offset_reason = traffic.map_segment("http://valhalla.test", {
            **route_reference, "openlr": {**route_reference["openlr"], "positiveOffsetMeters": 10}
        }, True)
        assert offset_edges == [] and offset_reason == "offset_not_supported"
        traffic.request_json = lambda *args, **kwargs: (200, {"edges": valid_edges})
        summary = traffic.build_mapping("http://valhalla.test", "dataset", "revision", [
            {"messageId": "ok", "coordinates": [[14.0, 50.0], [14.001, 50.001]],
             "openlr": {"points": [{"frc": "2", "bearing": 42, "distanceToNext": 287}, {"bearing": 172}]}},
            {"messageId": "offset", "coordinates": [[14.0, 50.0], [14.001, 50.001]],
             "openlr": {"positiveOffsetMeters": 10, "points": [{"frc": "3", "bearing": 42, "distanceToNext": 287}, {"bearing": 172}]}},
        ], 1)
        assert summary["matcherVersion"] == traffic.MATCHER_VERSION
        assert summary["sourceSegmentCount"] == summary["mappedSegmentCount"] + sum(summary["rejectionCounts"].values())
        assert summary["sourceByFrc"] == {"2": 1, "3": 1}
        assert summary["matchedByFrc"] == {"2": 1}
        assert summary["matchedByMethod"] == {"matched": 1}
        assert summary["rejectionCounts"] == {"offset_not_supported": 1}
    finally:
        traffic.request_json = original_request_json

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        baseline = traffic.mapping_path(root, "sim-routing-2026-09-20-1789879440", "static-revision")
        traffic.write_gzip_json(baseline, {
            "matcherVersion": traffic.MATCHER_VERSION,
            "routingDataset": "sim-routing-2026-09-20-1789879440",
            "staticRevision": "static-revision",
            "mapping": {"already-matched": [{"id": 1, "baselineSpeedKph": 80}]},
        })
        original_build_mapping = traffic.build_mapping
        original_post_report = traffic.post_report
        try:
            def audit_request(url: str, **kwargs: object) -> tuple[int, object]:
                if url.endswith("/status"):
                    return 200, {"tileset_last_modified": 1789879440}
                if "includeStatic=true" in url:
                    return 200, {"staticRevision": "static-revision", "segments": [
                        {"messageId": "already-matched"}, {"messageId": "new-candidate"},
                    ]}
                raise AssertionError(f"Unexpected audit request: {url}")
            def audit_mapping(url: str, dataset: str, revision: str, segments: list, workers: int, fallback: bool) -> dict:
                assert fallback and [segment["messageId"] for segment in segments] == ["new-candidate"]
                return {"mappedSegmentCount": 1, "matchedByMethod": {"route_matched": 1},
                        "rejectionCounts": {}, "mapping": {"new-candidate": [{"id": 2, "baselineSpeedKph": 60}]}}
            traffic.request_json = audit_request
            traffic.build_mapping = audit_mapping
            traffic.post_report = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("audit must not report to SIM"))
            assert traffic.audit_route_fallback({
                "SIM_TRAFFIC_FEED_BASE_URL": "http://sim.test/feed-root",
                "SIM_TRAFFIC_CONTROL_TOKEN": "test-token",
                "VALHALLA_URL": "http://valhalla.test", "TRAFFIC_MAPPING_CACHE_DIR": str(root),
            }) == 0
            audits = list(root.glob("openlr-route-candidate-audit-*.json.gz"))
            assert len(audits) == 1
            audit = traffic.read_gzip_json(audits[0])
            assert audit["baselineMappedSegmentCount"] == 1
            assert audit["newlyMappedSegmentCount"] == 1
            assert audit["combinedCoveragePercent"] == 100
            assert not (root / "traffic.tar").exists()
        finally:
            traffic.request_json = original_request_json
            traffic.build_mapping = original_build_mapping
            traffic.post_report = original_post_report

    now = "2099-01-01T00:00:00Z"
    mapping = {"mapping": {"flow-1": [{"id": graph_id(1, 50594, 2), "baselineSpeedKph": 80}]}}
    feed = {"flows": [{"messageId": "flow-1", "averageSpeedKph": 24, "validUntil": now}]}
    speeds, flow_count, _ = traffic.current_edge_speeds(feed, mapping, 10**10)
    assert flow_count == 1 and list(speeds) == [graph_id(1, 50594, 2)]

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        archive = root / "traffic.tar"
        state = root / "applied-edges.json"
        make_archive(archive, 1, 50594, 4)
        applied = traffic.apply_speeds(archive, state, speeds)
        assert applied == 1
        offset, _ = traffic.edge_record_location(graph_id(1, 50594, 2), traffic.traffic_tile_offsets(archive))
        with archive.open("rb") as stream:
            stream.seek(offset)
            assert struct.unpack("<Q", stream.read(8))[0] == traffic.traffic_word(24, 80)
        assert json.loads(state.read_text()) == [graph_id(1, 50594, 2)]
        revision = root / "last-applied.json"
        revision.write_text(json.dumps({"appliedAtEpoch": 1}))
        assert traffic.clear_expired_runtime(root, 1)
        with archive.open("rb") as stream:
            stream.seek(offset)
            assert struct.unpack("<Q", stream.read(8))[0] == 0
    print("Valhalla traffic updater tests passed.")


if __name__ == "__main__":
    main()
