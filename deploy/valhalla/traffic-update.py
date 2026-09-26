#!/usr/bin/env python3
"""On-demand TPEG2 -> Valhalla live-traffic overlay updater.

The SIM endpoint owns provider authentication and activity leasing. This host-side
worker only consumes normalized data, map-matches static OpenLR reference lines to
the active graph, and updates the fixed-size traffic archive in place.
"""

from __future__ import annotations

import argparse
import concurrent.futures
from datetime import datetime, timezone
import fcntl
import gzip
import hashlib
import json
import math
import re
import os
from pathlib import Path
import shutil
import struct
import sys
import tarfile
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

TRAFFIC_HEADER_SIZE = struct.calcsize("<2Q4I")
TRAFFIC_SPEED_SIZE = struct.calcsize("<Q")
GRAPH_ID_LEVEL_BITS = 3
GRAPH_ID_TILE_BITS = 22
GRAPH_ID_EDGE_SHIFT = GRAPH_ID_LEVEL_BITS + GRAPH_ID_TILE_BITS
GRAPH_ID_TILE_MASK = (1 << GRAPH_ID_TILE_BITS) - 1
UNKNOWN_SPEED_RAW = 127
MAX_SPEED_RAW = 126
# Bump this whenever matching semantics change. The cache key must not reuse a
# result produced by an older matcher against the same graph and TPEG snapshot.
MATCHER_VERSION = "openlr-trace-v2"
ROUTE_MATCHER_VERSION = "openlr-route-candidate-v1"
FRC_ROAD_CLASSES = {
    "0": {"motorway"},
    "1": {"trunk", "primary"},
    "2": {"trunk", "primary", "secondary"},
    "3": {"trunk", "secondary", "tertiary"},
    "4": {"primary", "secondary", "tertiary"},
    "5": {"secondary", "tertiary", "residential"},
    "6": {"tertiary", "unclassified", "residential"},
    "7": {"tertiary", "unclassified", "residential", "service_other"},
}


def load_env(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    if not path.exists():
        return result
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        result[key.strip()] = value.strip().strip('"').strip("'")
    return result


def request_json(
    url: str,
    token: str | None = None,
    payload: dict[str, Any] | None = None,
    timeout: int = 120,
) -> tuple[int, Any | None]:
    headers = {"Accept": "application/json", "User-Agent": "csm-sim-valhalla-traffic/1"}
    data = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    request = Request(url, headers=headers, data=data, method="POST" if payload is not None else "GET")
    try:
        with urlopen(request, timeout=timeout) as response:
            body = response.read()
            return response.status, json.loads(body) if body else None
    except HTTPError as error:
        if error.code == 204:
            return 204, None
        detail = error.read(500).decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {error.code} from {url}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"request failed for {url}: {error.reason}") from error


def routing_dataset(valhalla_url: str) -> str:
    status, body = request_json(f"{valhalla_url.rstrip('/')}/status", timeout=15)
    if status != 200 or not isinstance(body, dict):
        raise RuntimeError("Valhalla status is unavailable")
    modified = int(body.get("tileset_last_modified", 0))
    if modified <= 0:
        raise RuntimeError("Valhalla status has no tileset_last_modified")
    return f"sim-routing-{time.strftime('%Y-%m-%d', time.gmtime(modified))}-{modified}"


def graph_id_parts(graph_id: int) -> tuple[int, int, int]:
    level = graph_id & ((1 << GRAPH_ID_LEVEL_BITS) - 1)
    tile_id = (graph_id >> GRAPH_ID_LEVEL_BITS) & GRAPH_ID_TILE_MASK
    edge_index = graph_id >> GRAPH_ID_EDGE_SHIFT
    return level, tile_id, edge_index


def tile_graph_id(path: str) -> int:
    level_text, tile_path = path[:-4].split("/", 1)
    return int(level_text) | (int(tile_path.replace("/", "")) << GRAPH_ID_LEVEL_BITS)


def traffic_word(speed_kph: float, baseline_kph: float | None = None) -> int:
    encoded = max(1, min(MAX_SPEED_RAW, int(round(speed_kph / 2))))
    baseline = max(speed_kph, baseline_kph or speed_kph)
    congestion = max(1, min(63, int(round(1 + (1 - speed_kph / baseline) * 62))))
    return (
        encoded
        | (encoded << 7)
        | (encoded << 14)
        | (encoded << 21)
        | (255 << 28)
        | (congestion << 44)
    )


def angular_difference(a: float, b: float) -> float:
    return abs((a - b + 180) % 360 - 180)


def trace_rejection_reason(segment: dict[str, Any], edges: list[dict[str, Any]]) -> str | None:
    """Reject traces that disagree with the reference length or direction.

    TPEG2 OpenLR bearings use 0..255 for a full revolution. The final LRP
    points back along the path, opposite the matched edge's end heading.
    """
    openlr = segment.get("openlr")
    if not isinstance(openlr, dict):
        return "missing_openlr"
    try:
        positive_offset = float(openlr.get("positiveOffsetMeters") or 0)
        negative_offset = float(openlr.get("negativeOffsetMeters") or 0)
    except (TypeError, ValueError, OverflowError):
        return "invalid_reference_properties"
    if not math.isfinite(positive_offset) or not math.isfinite(negative_offset):
        return "invalid_reference_properties"
    if positive_offset > 0 or negative_offset > 0:
        # Speeds on an offset location must not be applied to the full LRP path.
        return "offset_not_supported"
    points = openlr.get("points")
    if not isinstance(points, list) or len(points) < 2 or not edges:
        return "missing_reference_points_or_edges"
    try:
        expected_m = sum(float(point.get("distanceToNext") or 0) for point in points[:-1] if isinstance(point, dict))
    except (TypeError, ValueError, OverflowError):
        return "invalid_reference_properties"
    if expected_m <= 0:
        return "missing_reference_distance"
    try:
        actual_m = sum(float(edge["length"]) * 1000 for edge in edges)
        first_bearing = float(points[0]["bearing"]) * 360 / 256
        last_bearing = (float(points[-1]["bearing"]) * 360 / 256 + 180) % 360
        first_heading = float(edges[0]["begin_heading"])
        last_heading = float(edges[-1]["end_heading"])
    except (KeyError, TypeError, ValueError, OverflowError):
        return "missing_trace_attributes"
    if not all(math.isfinite(value) for value in (expected_m, actual_m, first_bearing, last_bearing, first_heading, last_heading)):
        return "invalid_trace_attributes"
    if abs(actual_m - expected_m) > max(35, expected_m * 0.1):
        return "length_mismatch"
    if angular_difference(first_bearing, first_heading) > 35:
        return "first_bearing_mismatch"
    if angular_difference(last_bearing, last_heading) > 35:
        return "last_bearing_mismatch"
    return None


def trace_matches_openlr(segment: dict[str, Any], edges: list[dict[str, Any]]) -> bool:
    return trace_rejection_reason(segment, edges) is None


def valhalla_failure_reason(error: Exception) -> str:
    """Classify trace failures without recording provider payloads or locations."""
    detail = str(error)
    if "HTTP 400" in detail:
        code = re.search(r'"error_code"\s*:\s*(\d+)', detail)
        if code:
            return f"valhalla_error_{code.group(1)}"
    if "HTTP 444" in detail:
        return "valhalla_error_444"
    if "HTTP 4" in detail:
        return "valhalla_4xx"
    if "HTTP 5" in detail:
        return "valhalla_5xx"
    if isinstance(error, TimeoutError) or "timed out" in detail.lower():
        return "valhalla_timeout"
    return "valhalla_request_error"


def route_candidate(valhalla_url: str, segment: dict[str, Any]) -> tuple[list[dict[str, Any]], str]:
    """Resolve only an unambiguous, full-edge OpenLR path; never guess a path."""
    reference = segment.get("openlr") or {}
    if not isinstance(reference, dict):
        return [], "route_invalid_reference"
    points = reference.get("points") or []
    coordinates = segment.get("coordinates") or []
    if (not isinstance(points, list) or not isinstance(coordinates, list) or
        len(points) != 2 or len(coordinates) != 2 or any(not isinstance(point, dict) for point in points)):
        return [], "route_reference_shape"
    try:
        positive_offset = float(reference.get("positiveOffsetMeters") or 0)
        negative_offset = float(reference.get("negativeOffsetMeters") or 0)
    except (TypeError, ValueError, OverflowError):
        return [], "route_invalid_reference"
    if not math.isfinite(positive_offset) or not math.isfinite(negative_offset):
        return [], "route_invalid_reference"
    if positive_offset > 0 or negative_offset > 0:
        return [], "offset_not_supported"
    frc = str(points[0].get("frc", ""))
    allowed_classes = FRC_ROAD_CLASSES.get(frc)
    if not allowed_classes:
        return [], "route_unknown_frc"
    try:
        first_heading = float(points[0]["bearing"]) * 360 / 256
        last_heading = (float(points[-1]["bearing"]) * 360 / 256 + 180) % 360
        locations = [
            {"lon": float(lon), "lat": float(lat), "radius": 20, "search_cutoff": 20,
             "heading": first_heading if index == 0 else last_heading, "heading_tolerance": 34}
            for index, (lon, lat) in enumerate(coordinates)
        ]
    except (KeyError, TypeError, ValueError, OverflowError):
        return [], "route_invalid_reference"
    if not all(math.isfinite(float(value)) for location in locations for value in location.values()):
        return [], "route_invalid_reference"
    base = valhalla_url.rstrip("/")
    try:
        located_status, located = request_json(f"{base}/locate", payload={"locations": locations, "costing": "auto", "verbose": True}, timeout=15)
        if located_status != 200 or not isinstance(located, list) or len(located) != 2:
            return [], "route_locate_failed"
        route_status, route = request_json(f"{base}/route", payload={"locations": locations, "costing": "auto", "directions_type": "none"}, timeout=20)
        if route_status != 200 or not isinstance(route, dict):
            return [], "route_failed"
        trip = route.get("trip")
        legs = (trip.get("legs") or []) if isinstance(trip, dict) else []
        shape = legs[0].get("shape") if legs and isinstance(legs[0], dict) else None
        if not isinstance(shape, str) or not shape:
            return [], "route_missing_shape"
        trace_status, trace = request_json(f"{base}/trace_attributes", payload={
            "encoded_polyline": shape, "costing": "auto", "shape_match": "edge_walk",
            "filters": {"action": "include", "attributes": ["edge.id", "edge.speed", "edge.length", "edge.begin_heading", "edge.end_heading", "edge.road_class", "edge.use"]},
        }, timeout=20)
    except (RuntimeError, TimeoutError, OSError) as error:
        return [], f"route_{valhalla_failure_reason(error)}"
    if trace_status != 200 or not isinstance(trace, dict) or not isinstance(trace.get("edges"), list):
        return [], "route_trace_failed"
    edges = trace["edges"]
    if not edges or len(edges) > 64 or any(not isinstance(edge, dict) for edge in edges):
        return [], "route_edge_count"
    rejection = trace_rejection_reason(segment, edges)
    if rejection:
        return [], f"route_{rejection}"
    try:
        source_fraction = float(edges[0].get("source_percent_along", 0))
        target_fraction = float(edges[-1].get("target_percent_along", 1))
        if not (0 <= source_fraction <= 0.05 and 0.95 <= target_fraction <= 1):
            return [], "route_partial_edge"
        if any(edge.get("road_class") not in allowed_classes for edge in edges):
            return [], "route_road_class_mismatch"
        # OpenLR form-of-way 1 is motorway; 6 is a slip road. Other FOW types
        # are not inferred from OSM road_class alone.
        first_fow = str(points[0].get("fow", ""))
        if first_fow == "1" and any(edge.get("road_class") != "motorway" for edge in edges):
            return [], "route_form_of_way_mismatch"
        if first_fow == "6" and not any(edge.get("use") in {"ramp", "turn_channel"} for edge in edges):
            return [], "route_form_of_way_mismatch"
        def near_ids(location: dict[str, Any], heading: float, at_start: bool) -> set[int]:
            result: set[int] = set()
            if not isinstance(location, dict):
                return result
            for edge in location.get("edges", []):
                if not isinstance(edge, dict):
                    continue
                distance = float(edge.get("distance", math.inf))
                candidate_heading = float(edge.get("heading", math.nan))
                if (not math.isfinite(distance) or not math.isfinite(candidate_heading) or
                    distance > 20 or angular_difference(heading, candidate_heading) > 35 or
                    edge.get("edge", {}).get("classification", {}).get("classification") not in allowed_classes):
                    continue
                percent = float(edge.get("percent_along", math.nan))
                if (at_start and percent <= 0.05) or (not at_start and percent >= 0.95):
                    result.add(int(edge["edge_id"]["value"]))
            return result
        first_ids = near_ids(located[0], first_heading, True)
        last_ids = near_ids(located[1], last_heading, False)
        if len(first_ids) != 1 or len(last_ids) != 1:
            return [], "route_ambiguous_endpoint"
        if int(edges[0]["id"]) not in first_ids or int(edges[-1]["id"]) not in last_ids:
            return [], "route_endpoint_disagreement"
    except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
        return [], "route_invalid_attributes"
    return edges, "route_matched"


def map_segment(valhalla_url: str, segment: dict[str, Any], allow_route_fallback: bool = False) -> tuple[str, list[dict[str, int | float]], str]:
    message_id = str(segment.get("messageId", ""))
    coordinates = segment.get("coordinates")
    if not message_id or not isinstance(coordinates, list) or len(coordinates) < 2:
        return message_id, [], "missing_coordinates"
    shape = []
    for coordinate in coordinates:
        if not isinstance(coordinate, list) or len(coordinate) < 2:
            return message_id, [], "invalid_coordinates"
        try:
            lon, lat = float(coordinate[0]), float(coordinate[1])
        except (TypeError, ValueError, OverflowError):
            return message_id, [], "invalid_coordinates"
        if not math.isfinite(lon) or not math.isfinite(lat):
            return message_id, [], "invalid_coordinates"
        shape.append({"lon": lon, "lat": lat, "type": "through", "radius": 100})
    payload = {
        "shape": shape,
        "costing": "auto",
        "shape_match": "walk_or_snap",
        "trace_options": {
            "search_radius": 100,
            "gps_accuracy": 50,
            "breakage_distance": 20000,
            "interpolation_distance": 10,
        },
        "filters": {"action": "include", "attributes": ["edge.id", "edge.speed", "edge.length", "edge.begin_heading", "edge.end_heading"]},
    }
    match_reason = "matched"
    try:
        status, body = request_json(f"{valhalla_url.rstrip('/')}/trace_attributes", payload=payload, timeout=30)
    except (RuntimeError, TimeoutError, OSError) as error:
        reason = valhalla_failure_reason(error)
        if allow_route_fallback and reason == "valhalla_error_444":
            fallback_edges, fallback_reason = route_candidate(valhalla_url, segment)
            if fallback_edges:
                body = {"edges": fallback_edges}
                status = 200
                match_reason = "route_matched"
            else:
                return message_id, [], fallback_reason
        else:
            return message_id, [], reason
    if status != 200 or not isinstance(body, dict) or not isinstance(body.get("edges"), list):
        return message_id, [], "invalid_trace_response"
    rejection = trace_rejection_reason(segment, body["edges"])
    if rejection:
        return message_id, [], rejection
    edges: list[dict[str, int | float]] = []
    seen: set[int] = set()
    for edge in body["edges"]:
        if not isinstance(edge, dict):
            continue
        try:
            edge_id = int(edge["id"])
        except (KeyError, TypeError, ValueError):
            continue
        if edge_id in seen:
            continue
        seen.add(edge_id)
        edges.append({"id": edge_id, "baselineSpeedKph": float(edge.get("speed", 0) or 0)})
    return message_id, edges, match_reason if edges else "missing_edge_ids"


def build_mapping(
    valhalla_url: str,
    dataset: str,
    static_revision: str,
    segments: list[dict[str, Any]],
    workers: int,
    allow_route_fallback: bool = False,
) -> dict[str, Any]:
    matcher_version = ROUTE_MATCHER_VERSION if allow_route_fallback else MATCHER_VERSION
    mapping: dict[str, list[dict[str, int | float]]] = {}
    rejection_counts: dict[str, int] = {}
    matched_by_method: dict[str, int] = {}
    source_by_frc: dict[str, int] = {}
    matched_by_frc: dict[str, int] = {}
    frc_by_message_id: dict[str, str] = {}
    for segment in segments:
        points = (segment.get("openlr") or {}).get("points") or [{}]
        frc_by_message_id[str(segment.get("messageId", ""))] = str(points[0].get("frc", "unknown"))
    for frc in frc_by_message_id.values():
        source_by_frc[frc] = source_by_frc.get(frc, 0) + 1
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(4, workers))) as executor:
        futures = [executor.submit(map_segment, valhalla_url, segment, allow_route_fallback) for segment in segments]
        for index, future in enumerate(concurrent.futures.as_completed(futures), 1):
            message_id, edges, reason = future.result()
            if message_id and edges:
                mapping[message_id] = edges
                matched_by_method[reason] = matched_by_method.get(reason, 0) + 1
                frc = frc_by_message_id.get(message_id, "unknown")
                matched_by_frc[frc] = matched_by_frc.get(frc, 0) + 1
            else:
                rejection_counts[reason] = rejection_counts.get(reason, 0) + 1
            if index % 1000 == 0:
                print(f"Mapped {index}/{len(segments)} TPEG2 segments", flush=True)
    print(f"OpenLR mapping diagnostics: {json.dumps({'rejections': rejection_counts, 'matchedByMethod': matched_by_method, 'sourceByFrc': source_by_frc, 'matchedByFrc': matched_by_frc}, sort_keys=True)}", flush=True)
    return {
        "contractVersion": "valhalla-openlr-edge-map-v2",
        "matcherVersion": matcher_version,
        "routingDataset": dataset,
        "staticRevision": static_revision,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sourceSegmentCount": len(segments),
        "mappedSegmentCount": len(mapping),
        "rejectionCounts": rejection_counts,
        "matchedByMethod": matched_by_method,
        "sourceByFrc": source_by_frc,
        "matchedByFrc": matched_by_frc,
        "mapping": mapping,
    }


def mapping_path(cache_dir: Path, dataset: str, static_revision: str, matcher_version: str = MATCHER_VERSION) -> Path:
    token = hashlib.sha256(f"{matcher_version}:{dataset}:{static_revision}".encode()).hexdigest()[:20]
    return cache_dir / f"openlr-edge-map-{token}.json.gz"


def write_gzip_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + f".tmp-{os.getpid()}")
    with gzip.open(temporary, "wt", encoding="utf-8", compresslevel=6) as stream:
        json.dump(value, stream, separators=(",", ":"))
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def read_gzip_json(path: Path) -> Any:
    with gzip.open(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def ensure_runtime_archive(runtime_archive: Path, skeleton: Path) -> None:
    runtime_archive.parent.mkdir(parents=True, exist_ok=True)
    if runtime_archive.exists():
        return
    if not skeleton.is_file():
        raise RuntimeError(f"traffic skeleton does not exist: {skeleton}")
    temporary = runtime_archive.with_suffix(f".tmp-{os.getpid()}")
    shutil.copyfile(skeleton, temporary)
    # Valhalla runs as an unprivileged container user and only needs read
    # access; the root-owned host updater remains the sole writer.
    os.chmod(temporary, 0o644)
    os.replace(temporary, runtime_archive)


def traffic_tile_offsets(archive: Path) -> dict[int, tuple[int, int]]:
    result: dict[int, tuple[int, int]] = {}
    with tarfile.open(archive, "r") as tar:
        for member in tar.getmembers():
            if not member.name.endswith(".gph"):
                continue
            result[tile_graph_id(member.name)] = (member.offset_data, member.size)
    return result


def read_previous_edges(path: Path) -> list[int]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return [int(item) for item in value] if isinstance(value, list) else []
    except (FileNotFoundError, json.JSONDecodeError, TypeError, ValueError):
        return []


def current_edge_speeds(
    feed: dict[str, Any], mapping: dict[str, Any], max_age_seconds: int
) -> tuple[dict[int, tuple[float, float]], int, str | None]:
    now = time.time()
    selected: dict[int, tuple[float, float]] = {}
    applied_flows = 0
    latest_observed: float | None = None
    edge_map = mapping.get("mapping", {})
    for flow in feed.get("flows", []):
        if not isinstance(flow, dict):
            continue
        try:
            speed = float(flow["averageSpeedKph"])
        except (KeyError, TypeError, ValueError):
            continue
        if not math.isfinite(speed) or speed <= 0:
            continue
        observed_text = flow.get("observedAt")
        observed = parse_iso_timestamp(observed_text)
        valid_until = parse_iso_timestamp(flow.get("validUntil"))
        if observed is not None and now - observed > max_age_seconds:
            continue
        if valid_until is not None and valid_until < now:
            continue
        edges = edge_map.get(str(flow.get("messageId", "")), [])
        if not edges:
            continue
        applied_flows += 1
        if observed is not None:
            latest_observed = max(latest_observed or observed, observed)
        for edge in edges:
            edge_id = int(edge["id"])
            baseline = float(edge.get("baselineSpeedKph", 0) or 0)
            existing = selected.get(edge_id)
            if existing is None or speed < existing[0]:
                selected[edge_id] = (speed, baseline)
    observed_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(latest_observed)) if latest_observed else None
    return selected, applied_flows, observed_iso


def parse_iso_timestamp(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except ValueError:
        return None


def apply_speeds(archive: Path, state_path: Path, speeds: dict[int, tuple[float, float]]) -> int:
    offsets = traffic_tile_offsets(archive)
    previous = read_previous_edges(state_path)
    # Persist the superset before touching the mmap-backed archive. If the
    # process is interrupted, the next run can still clear every possibly
    # modified record.
    state_path.write_text(json.dumps(sorted(set(previous) | set(speeds))), encoding="utf-8")
    os.chmod(state_path, 0o600)
    touched_tiles: set[int] = set()
    applied = 0
    with archive.open("r+b", buffering=0) as stream:
        for graph_id in previous:
            location = edge_record_location(graph_id, offsets)
            if location is not None:
                offset, tile_graph = location
                stream.seek(offset)
                stream.write(struct.pack("<Q", 0))
                touched_tiles.add(tile_graph)
        for graph_id, (speed, baseline) in speeds.items():
            location = edge_record_location(graph_id, offsets)
            if location is None:
                continue
            offset, tile_graph = location
            stream.seek(offset)
            stream.write(struct.pack("<Q", traffic_word(speed, baseline)))
            touched_tiles.add(tile_graph)
            applied += 1
        timestamp = int(time.time())
        for tile_graph in touched_tiles:
            tile_offset, _ = offsets[tile_graph]
            stream.seek(tile_offset + 8)
            stream.write(struct.pack("<Q", timestamp))
    state_path.write_text(json.dumps(sorted(speeds)), encoding="utf-8")
    os.chmod(state_path, 0o600)
    return applied


def edge_record_location(graph_id: int, offsets: dict[int, tuple[int, int]]) -> tuple[int, int] | None:
    level, tile_id, edge_index = graph_id_parts(graph_id)
    tile_graph = level | (tile_id << GRAPH_ID_LEVEL_BITS)
    tile = offsets.get(tile_graph)
    if tile is None:
        return None
    tile_offset, tile_size = tile
    record_offset = tile_offset + TRAFFIC_HEADER_SIZE + edge_index * TRAFFIC_SPEED_SIZE
    if record_offset + TRAFFIC_SPEED_SIZE > tile_offset + tile_size:
        return None
    return record_offset, tile_graph


def post_report(feed_base_url: str, token: str, report: dict[str, Any]) -> None:
    request_json(f"{feed_base_url.rstrip('/')}/report", token=token, payload=report, timeout=30)


def clear_expired_runtime(runtime_dir: Path, max_age_seconds: int) -> bool:
    archive = runtime_dir / "traffic.tar"
    state_path = runtime_dir / "applied-edges.json"
    revision_path = runtime_dir / "last-applied.json"
    if not archive.exists() or not state_path.exists():
        return False
    try:
        revision = json.loads(revision_path.read_text(encoding="utf-8"))
        applied_at = float(revision.get("appliedAtEpoch", 0))
    except (FileNotFoundError, json.JSONDecodeError, TypeError, ValueError):
        applied_at = state_path.stat().st_mtime
    if applied_at > 0 and time.time() - applied_at <= max_age_seconds:
        return False
    lock_path = runtime_dir / "update.lock"
    lock_path.touch(mode=0o600, exist_ok=True)
    with lock_path.open("r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        apply_speeds(archive, state_path, {})
    revision_path.unlink(missing_ok=True)
    print("Cleared expired Valhalla live speeds while the SIM activity lease is idle.", flush=True)
    return True


def run(config: dict[str, str]) -> int:
    feed_base_url = required(config, "SIM_TRAFFIC_FEED_BASE_URL")
    token = required(config, "SIM_TRAFFIC_CONTROL_TOKEN")
    valhalla_url = config.get("VALHALLA_URL", "http://127.0.0.1:8002")
    cache_dir = Path(config.get("TRAFFIC_MAPPING_CACHE_DIR", "/srv/valhalla/traffic-cache"))
    runtime_dir = Path(config.get("TRAFFIC_RUNTIME_DIR", "/run/valhalla-traffic"))
    skeleton = Path(config.get("TRAFFIC_SKELETON", "/srv/valhalla/current/traffic-skeleton.tar"))
    archive = runtime_dir / "traffic.tar"
    state_path = runtime_dir / "applied-edges.json"
    revision_state_path = runtime_dir / "last-applied.json"
    workers = int(config.get("TRAFFIC_MAPPING_WORKERS", "2"))
    allow_route_fallback = config.get("TRAFFIC_OPENLR_ROUTE_FALLBACK", "false").lower() == "true"
    matcher_version = ROUTE_MATCHER_VERSION if allow_route_fallback else MATCHER_VERSION

    status, feed = request_json(f"{feed_base_url.rstrip('/')}/feed", token=token)
    if status == 204:
        clear_expired_runtime(runtime_dir, int(config.get("TRAFFIC_MAX_AGE_SECONDS", "1800")))
        return 0
    if status != 200 or not isinstance(feed, dict) or feed.get("contractVersion") != "sim-valhalla-live-traffic-feed-v1":
        raise RuntimeError("SIM returned an invalid Valhalla traffic feed")
    dataset = routing_dataset(valhalla_url)
    static_revision = str(feed.get("staticRevision", ""))
    dynamic_revision = str(feed.get("dynamicRevision", ""))
    if not static_revision or not dynamic_revision:
        raise RuntimeError("SIM traffic feed has no revision identifiers")
    path = mapping_path(cache_dir, dataset, static_revision, matcher_version)
    mapping_built = False
    try:
        revision_state = json.loads(revision_state_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        revision_state = {}
    if (
        path.exists()
        and archive.exists()
        and state_path.exists()
        and revision_state.get("routingDataset") == dataset
        and revision_state.get("staticRevision") == static_revision
        and revision_state.get("dynamicRevision") == dynamic_revision
        and revision_state.get("matcherVersion") == matcher_version
    ):
        return 0
    if path.exists():
        mapping = read_gzip_json(path)
        if mapping.get("matcherVersion") != matcher_version:
            raise RuntimeError("Traffic mapping cache was built by a different matcher")
    else:
        query = urlencode({"includeStatic": "true"})
        static_status, static_feed = request_json(f"{feed_base_url.rstrip('/')}/feed?{query}", token=token)
        if static_status != 200 or not isinstance(static_feed, dict) or not isinstance(static_feed.get("segments"), list):
            raise RuntimeError("SIM did not return static TPEG2 segments for a new graph mapping")
        if static_feed.get("staticRevision") != static_revision:
            raise RuntimeError("TPEG2 static revision changed during graph mapping preparation")
        mapping = build_mapping(valhalla_url, dataset, static_revision, static_feed["segments"], workers, allow_route_fallback)
        write_gzip_json(path, mapping)
        mapping_built = True

    if mapping_built:
        latest_status, latest_feed = request_json(f"{feed_base_url.rstrip('/')}/feed", token=token)
        if latest_status == 204:
            return 0
        if latest_status != 200 or not isinstance(latest_feed, dict):
            raise RuntimeError("SIM did not return a fresh speed feed after graph mapping")
        if latest_feed.get("staticRevision") != static_revision:
            raise RuntimeError("TPEG2 static revision changed while graph mapping was running")
        feed = latest_feed
        dynamic_revision = str(feed.get("dynamicRevision", ""))

    ensure_runtime_archive(archive, skeleton)
    max_age = int(feed.get("maxAgeSeconds", config.get("TRAFFIC_MAX_AGE_SECONDS", "1800")))
    speeds, applied_flows, source_observed = current_edge_speeds(feed, mapping, max_age)
    lock_path = runtime_dir / "update.lock"
    lock_path.touch(mode=0o600, exist_ok=True)
    with lock_path.open("r+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        applied_edges = apply_speeds(archive, state_path, speeds)
    source_count = int(mapping.get("sourceSegmentCount", 0))
    mapped_count = int(mapping.get("mappedSegmentCount", 0))
    mapped_edge_count = len({int(edge["id"]) for edges in mapping.get("mapping", {}).values() for edge in edges})
    coverage = round(100 * mapped_count / source_count, 2) if source_count else 0
    report_status = "current" if coverage >= 50 and applied_edges > 0 else "degraded"
    report = {
        "routingDataset": dataset,
        "staticRevision": static_revision,
        "dynamicRevision": dynamic_revision,
        "status": report_status,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "mappedSegmentCount": mapped_count,
        "mappedEdgeCount": mapped_edge_count,
        "appliedFlowCount": applied_flows,
        "appliedEdgeCount": applied_edges,
        "mappingCoveragePercent": coverage,
    }
    if source_observed:
        report["sourceObservedAt"] = source_observed
    if report_status != "current":
        report["detail"] = "No sufficiently covered set of fresh mapped TPEG2 speeds was available."
    post_report(feed_base_url, token, report)
    revision_state_path.write_text(
        json.dumps(
            {
                "routingDataset": dataset,
                "staticRevision": static_revision,
                "dynamicRevision": dynamic_revision,
                "matcherVersion": matcher_version,
                "appliedAtEpoch": time.time(),
            }
        ),
        encoding="utf-8",
    )
    os.chmod(revision_state_path, 0o600)
    print(json.dumps(report, separators=(",", ":")), flush=True)
    return 0


def required(config: dict[str, str], key: str) -> str:
    value = config.get(key)
    if not value:
        raise RuntimeError(f"missing required setting {key}")
    return value


def audit_route_fallback(config: dict[str, str]) -> int:
    """Build an isolated candidate map without touching runtime traffic or SIM reports."""
    feed_base_url = required(config, "SIM_TRAFFIC_FEED_BASE_URL")
    token = required(config, "SIM_TRAFFIC_CONTROL_TOKEN")
    valhalla_url = config.get("VALHALLA_URL", "http://127.0.0.1:8002")
    cache_dir = Path(config.get("TRAFFIC_MAPPING_CACHE_DIR", "/srv/valhalla/traffic-cache"))
    status, feed = request_json(f"{feed_base_url.rstrip('/')}/feed?includeStatic=true", token=token)
    if status != 200 or not isinstance(feed, dict) or not isinstance(feed.get("segments"), list):
        raise RuntimeError("An active SIM traffic lease with a static feed is required for audit")
    dataset = routing_dataset(valhalla_url)
    static_revision = str(feed.get("staticRevision") or "")
    if not static_revision:
        raise RuntimeError("SIM static revision is missing")
    baseline_path = mapping_path(cache_dir, dataset, static_revision)
    if not baseline_path.is_file():
        raise RuntimeError("The validated baseline graph mapping is unavailable")
    baseline = read_gzip_json(baseline_path)
    if (baseline.get("matcherVersion") != MATCHER_VERSION or baseline.get("routingDataset") != dataset or
        baseline.get("staticRevision") != static_revision):
        raise RuntimeError("The baseline graph mapping does not match the active dataset")
    baseline_ids = set(baseline.get("mapping", {}))
    unmatched = [segment for segment in feed["segments"] if str(segment.get("messageId", "")) not in baseline_ids]
    candidates = build_mapping(
        valhalla_url, dataset, static_revision, unmatched,
        int(config.get("TRAFFIC_MAPPING_WORKERS", "2")), True,
    )
    if routing_dataset(valhalla_url) != dataset:
        raise RuntimeError("Valhalla routing dataset changed during the audit")
    newly_matched = int(candidates["mappedSegmentCount"])
    source_count = len(feed["segments"])
    report = {
        "contractVersion": "valhalla-openlr-route-audit-v1",
        "matcherVersion": ROUTE_MATCHER_VERSION,
        "routingDataset": dataset,
        "staticRevision": static_revision,
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sourceSegmentCount": source_count,
        "baselineMappedSegmentCount": len(baseline_ids),
        "newlyMappedSegmentCount": newly_matched,
        "combinedCoveragePercent": round(100 * (len(baseline_ids) + newly_matched) / source_count, 2) if source_count else 0,
        "matchedByMethod": candidates["matchedByMethod"],
        "rejectionCounts": candidates["rejectionCounts"],
        "mapping": candidates["mapping"],
    }
    token_hash = hashlib.sha256(f"{ROUTE_MATCHER_VERSION}:{dataset}:{static_revision}".encode()).hexdigest()[:20]
    audit_path = cache_dir / f"openlr-route-candidate-audit-{token_hash}.json.gz"
    write_gzip_json(audit_path, report)
    print(json.dumps({key: value for key, value in report.items() if key != "mapping"}, sort_keys=True), flush=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env", type=Path, default=Path("/srv/valhalla/.traffic.env"))
    parser.add_argument("--audit-route-fallback", action="store_true")
    args = parser.parse_args()
    config = {**load_env(args.env), **os.environ}
    try:
        return audit_route_fallback(config) if args.audit_route_fallback else run(config)
    except Exception as error:  # systemd captures the sanitized failure; secrets are never interpolated
        print(f"Valhalla traffic update failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
