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
    try:
        traffic.run({"SIM_TRAFFIC_FEED_BASE_URL": "http://sim.test",
                     "SIM_TRAFFIC_CONTROL_TOKEN": "test", "TRAFFIC_OPENLR_ROUTE_FALLBACK": "true"})
    except RuntimeError as error:
        assert "not approved for live speeds" in str(error)
    else:
        raise AssertionError("unapproved route fallback must be refused")
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
        direct_reference = {
            "messageId": "direct-reference", "coordinates": [[14.0, 50.0], [14.001, 50.001]],
            "openlr": {"points": [
                {"frc": "3", "fow": "3", "bearing": 42, "distanceToNext": 100},
                {"bearing": 172},
            ]},
        }
        def direct_edge(edge_id: int, percent: float, heading: float = 62) -> dict:
            return {"edge_id": {"value": edge_id}, "distance": 2, "heading": heading,
                    "percent_along": percent, "edge": {
                        "classification": {"classification": "secondary", "use": "road"},
                        "geo_attributes": {"length": 100}, "speeds": {"default": 20},
                        "access": {"car": True},
                    }}
        direct_locations = [{"edges": [direct_edge(5, 0)]}, {"edges": [direct_edge(5, 1)]}]
        traffic.request_json = lambda *args, **kwargs: (200, direct_locations)
        direct_edges, direct_reason = traffic.directed_single_edge_candidate("http://valhalla.test", direct_reference)
        assert direct_reason == "direct_matched" and direct_edges == [{"id": 5, "baselineSpeedKph": 72}]
        direct_locations[1]["edges"][0] = direct_edge(6, 1)
        assert traffic.directed_single_edge_candidate("http://valhalla.test", direct_reference)[1] == "direct_ambiguous_or_unmatched"
        direct_locations[1]["edges"][0] = direct_edge(5, 1, 240)
        assert traffic.directed_single_edge_candidate("http://valhalla.test", direct_reference)[1] == "direct_ambiguous_or_unmatched"
        direct_locations[1]["edges"][0] = direct_edge(5, 1)
        assert traffic.directed_single_edge_candidate("http://valhalla.test", {
            **direct_reference, "openlr": {**direct_reference["openlr"], "positiveOffsetMeters": 4},
        })[1] == "direct_offset_not_supported"
        assert traffic.directed_single_edge_candidate("http://valhalla.test", {
            **direct_reference, "openlr": {"points": [
                {**direct_reference["openlr"]["points"][0], "distanceToNext": 200},
                direct_reference["openlr"]["points"][1],
            ]},
        })[1] == "direct_length_mismatch"
        class FakeGraph:
            def __init__(self) -> None:
                self.result = {"status": "ok", "lengthMeters": 100, "edges": [5, 6]}
                self.calls = 0
            def path(self, source: int, source_percent: float, target: int,
                     target_percent: float, max_m: float, class_mask: int) -> dict:
                self.calls += 1
                assert (source, target) == (5, 6)
                assert source_percent == 0 and target_percent == 1
                assert max_m == 135 and class_mask & (1 << 3)
                return self.result
        fake_graph = FakeGraph()
        direct_locations[1]["edges"][0] = direct_edge(6, 1)
        graph_edges, graph_reason = traffic.bounded_graph_candidate("http://valhalla.test", direct_reference, fake_graph)
        assert graph_reason == "graph_matched" and [edge["id"] for edge in graph_edges] == [5, 6]
        assert fake_graph.calls == 1
        fake_graph.result = {"status": "ok", "lengthMeters": 180, "edges": [5, 6]}
        assert traffic.bounded_graph_candidate("http://valhalla.test", direct_reference, fake_graph)[1] == "graph_length_mismatch"
        fake_graph.result = {"status": "ok", "lengthMeters": 100, "edges": [6, 5]}
        assert traffic.bounded_graph_candidate("http://valhalla.test", direct_reference, fake_graph)[1] == "graph_path_shape_mismatch"
        direct_locations[0]["edges"].append(direct_edge(7, 0))
        class AlternativeGraph:
            def path(self, source: int, source_percent: float, target: int,
                     target_percent: float, max_m: float, class_mask: int) -> dict:
                return {"status": "ok", "lengthMeters": 100, "edges": [source, target]}
        assert traffic.bounded_graph_candidate(
            "http://valhalla.test", direct_reference, AlternativeGraph(),
        )[1] == "graph_ambiguous_path"
        class SamePathGraph:
            def path(self, source: int, source_percent: float, target: int,
                     target_percent: float, max_m: float, class_mask: int) -> dict:
                return {"status": "ok", "lengthMeters": 100, "edges": [5, 6]}
        assert traffic.bounded_graph_candidate(
            "http://valhalla.test", direct_reference, SamePathGraph(),
        )[1] == "graph_matched"
        direct_locations[0]["edges"].pop()
        direct_locations[0]["edges"][0]["percent_along"] = 0.03
        partial_edges, partial_reason = traffic.bounded_graph_candidate(
            "http://valhalla.test", direct_reference, AlternativeGraph(),
        )
        assert partial_reason == "graph_matched" and [edge["id"] for edge in partial_edges] == [6]
        direct_locations[1]["edges"][0]["percent_along"] = 0.97
        assert traffic.bounded_graph_candidate(
            "http://valhalla.test", direct_reference, AlternativeGraph(),
        )[1] == "graph_no_whole_edge"
        direct_locations[0]["edges"][0]["percent_along"] = 0
        direct_locations[1]["edges"][0]["percent_along"] = 1
        assert traffic.bounded_graph_candidate("http://valhalla.test", {
            **direct_reference, "openlr": {**direct_reference["openlr"], "negativeOffsetMeters": 10},
        }, fake_graph)[1] == "graph_offset_not_supported"
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
                shape = "encoded-shortest" if kwargs["payload"].get("costing_options") else "encoded-route"
                return 200, {"trip": {"legs": [{"shape": shape}]}}
            if kwargs["payload"].get("shape_match") == "edge_walk":
                if kwargs["payload"].get("encoded_polyline") == "encoded-shortest" and shortest_disagrees[0]:
                    return 200, {"edges": [{"id": 1}, {"id": 99}]}
                return 200, {"edges": route_edges}
            raise RuntimeError('HTTP 400 from Valhalla: {"error_code":444}')
        shortest_disagrees = [False]
        traffic.request_json = route_request
        _, default_edges, default_reason = traffic.map_segment("http://valhalla.test", route_reference)
        assert default_edges == [] and default_reason == "valhalla_error_444"
        _, fallback_edges, fallback_reason = traffic.map_segment("http://valhalla.test", route_reference, True)
        assert [edge["id"] for edge in fallback_edges] == [1, 2] and fallback_reason == "route_matched"
        shortest_disagrees[0] = True
        _, disagree_edges, disagree_reason = traffic.map_segment("http://valhalla.test", route_reference, True)
        assert disagree_edges == [] and disagree_reason == "route_costing_disagreement"
        shortest_disagrees[0] = False
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
            def audit_mapping(url: str, dataset: str, revision: str, segments: list, workers: int, fallback: bool, baseline_mapping: dict) -> dict:
                assert fallback and [segment["messageId"] for segment in segments] == ["new-candidate"]
                assert baseline_mapping == {"already-matched": [{"id": 1, "baselineSpeedKph": 80}]}
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

    original_map_segment = traffic.map_segment
    try:
        def overlap_segment(_url: str, segment: dict, _fallback: bool) -> tuple[str, list[dict], str]:
            choices = {
                "base": ([1], "matched"),
                "overlap-base": ([1, 2], "route_matched"),
                "overlap-candidate-a": ([3, 4], "route_matched"),
                "overlap-candidate-b": ([4, 5], "route_matched"),
                "safe": ([6, 7], "route_matched"),
            }
            ids, reason = choices[segment["messageId"]]
            return segment["messageId"], [{"id": edge_id, "baselineSpeedKph": 60} for edge_id in ids], reason
        traffic.map_segment = overlap_segment
        segments = [
            {"messageId": message_id, "openlr": {"points": [{"frc": "3"}]}}
            for message_id in ("base", "overlap-base", "overlap-candidate-a", "overlap-candidate-b", "safe")
        ]
        result = traffic.build_mapping("http://valhalla.test", "dataset", "revision", segments, 1, True)
        assert set(result["mapping"]) == {"base", "safe"}
        assert result["mappedSegmentCount"] == 2
        assert result["matchedByMethod"] == {"matched": 1, "route_matched": 1}
        assert result["rejectionCounts"] == {
            "route_edge_overlap_baseline": 1, "route_edge_overlap_candidate": 2,
        }
        audit_result = traffic.build_mapping("http://valhalla.test", "dataset", "revision", segments[1:], 1, True,
                                             {"already-baseline": [{"id": 1, "baselineSpeedKph": 80}]})
        assert set(audit_result["mapping"]) == {"safe"}
        assert audit_result["mappedSegmentCount"] == 1
    finally:
        traffic.map_segment = original_map_segment

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        dataset = "sim-routing-2026-09-20-1789879440"
        traffic.write_gzip_json(traffic.mapping_path(root, dataset, "static-revision"), {
            "matcherVersion": traffic.MATCHER_VERSION, "routingDataset": dataset,
            "staticRevision": "static-revision",
            "mapping": {"baseline": [{"id": 1, "baselineSpeedKph": 80}]},
        })
        original_direct = traffic.directed_single_edge_candidate
        original_report = traffic.post_report
        try:
            def direct_audit_request(url: str, **kwargs: object) -> tuple[int, object]:
                if url.endswith("/status"):
                    return 200, {"tileset_last_modified": 1789879440}
                if "includeStatic=true" in url:
                    return 200, {"staticRevision": "static-revision", "segments": [
                        {"messageId": key} for key in ("baseline", "overlap", "candidate-a", "candidate-b", "safe")
                    ]}
                raise AssertionError(url)
            def direct_audit_candidate(_url: str, segment: dict) -> tuple[list[dict], str]:
                return [{"id": {"overlap": 1, "candidate-a": 2, "candidate-b": 2, "safe": 3}[segment["messageId"]],
                         "baselineSpeedKph": 60}], "direct_matched"
            traffic.request_json = direct_audit_request
            traffic.directed_single_edge_candidate = direct_audit_candidate
            traffic.post_report = lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("audit must not report to SIM"))
            assert traffic.audit_direct_matcher({
                "SIM_TRAFFIC_FEED_BASE_URL": "http://sim.test/feed-root", "SIM_TRAFFIC_CONTROL_TOKEN": "test-token",
                "VALHALLA_URL": "http://valhalla.test", "TRAFFIC_MAPPING_CACHE_DIR": str(root),
            }) == 0
            audits = list(root.glob("openlr-direct-audit-*.json.gz"))
            assert len(audits) == 1
            audit = traffic.read_gzip_json(audits[0])
            assert set(audit["mapping"]) == {"safe"}
            assert audit["rejectionCounts"] == {
                "direct_edge_overlap_baseline": 1, "direct_edge_overlap_candidate": 2,
            }
            assert audit["combinedCoveragePercent"] == 40
            assert not (root / "traffic.tar").exists()
        finally:
            traffic.request_json = original_request_json
            traffic.directed_single_edge_candidate = original_direct
            traffic.post_report = original_report

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
