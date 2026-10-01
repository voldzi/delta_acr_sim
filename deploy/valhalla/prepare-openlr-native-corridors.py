#!/usr/bin/env python3
"""Prepare bounded, private, OFFLINE TMC corridors for a native shadow probe.

Licensed road geometry is never printed, simplified or turned into live edge
mapping. The original static revision is retained for the deterministic subset.
Outputs are mode-0600 JSON gzip snapshots for openlr-native-client.py only.
"""
from __future__ import annotations

import argparse
from collections import Counter
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import struct
import sys
from typing import Any
import zipfile


ROOT = Path(__file__).resolve().parent
DEFAULT_MAX_SEGMENTS = 240
MAX_SEGMENTS = 100_000
MAX_SOURCE_SEGMENTS = 100_000
MAX_STATIC_BYTES = 256 * 1024 * 1024
MAX_PARTS = 16
MAX_POINTS = 512
CONTRACT = "sim-tmc-corridors-v1"


def module(name: str, filename: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError("Offline corridor dependency unavailable")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


geography = module("tmc_geography_for_native_preparation", "audit-tmc-candidate-geography.py")
native = module("native_client_for_corridor_preparation", "openlr-native-client.py")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def corridor_parts(road: Any) -> tuple[list[list[list[float]]] | None, str | None]:
    """Validate every independent point; never trim or simplify a road."""
    if not isinstance(road, list) or not road:
        return None, "no_tmc_road"
    if len(road) > MAX_PARTS:
        return None, "tmc_parts_limit"
    if any(not isinstance(part, list) or len(part) < 2 for part in road):
        return None, "invalid_tmc_geometry"
    if sum(len(part) for part in road) > MAX_POINTS:
        return None, "tmc_points_limit"
    parts: list[list[list[float]]] = []
    for part in road:
        coordinates = []
        for point in part:
            if (not isinstance(point, (list, tuple)) or len(point) != 2 or
                not all(native.finite_number(number) for number in point) or
                not -180 <= point[0] <= 180 or not -85 <= point[1] <= 85):
                return None, "invalid_tmc_geometry"
            coordinates.append([float(point[0]), float(point[1])])
        parts.append(coordinates)
    return parts, None


def stratified_subset(groups: dict[int, list[dict[str, Any]]], maximum: int) -> list[dict[str, Any]]:
    """Equal FRC quotas with sparse-stratum redistribution and stable spacing."""
    ordered = {frc: sorted(values, key=lambda value: value["messageId"])
               for frc, values in sorted(groups.items()) if values}
    quotas = dict.fromkeys(ordered, 0)
    remaining = maximum
    while remaining:
        progress = False
        for frc, values in ordered.items():
            if quotas[frc] < len(values):
                quotas[frc] += 1
                remaining -= 1
                progress = True
                if not remaining:
                    break
        if not progress:
            break
    selected = []
    for frc, values in ordered.items():
        count = quotas[frc]
        selected.extend(values[index * len(values) // count] for index in range(count))
    return selected


def prepare(feed: Any, roads: dict[str, Any], point_roads: dict[str, str], tmc_sha256: str,
            maximum: int = DEFAULT_MAX_SEGMENTS, tolerance_meters: float = 100) -> tuple[dict, dict, dict]:
    if (type(maximum) is not int or not 1 <= maximum <= MAX_SEGMENTS or
        not native.finite_number(tolerance_meters) or not 10 <= tolerance_meters <= 100):
        raise ValueError("Invalid offline preparation bounds")
    if (not isinstance(feed, dict) or not native.hash_value(feed.get("staticRevision", "")) or
        not isinstance(feed.get("segments"), list) or len(feed["segments"]) > MAX_SOURCE_SEGMENTS or
        not native.hash_value(tmc_sha256)):
        raise ValueError("Invalid private static or TMC identity")
    groups: dict[int, list[dict[str, Any]]] = {}
    rejected: Counter[str] = Counter()
    by_frc: dict[int, Counter[str]] = {}
    parts_cache: dict[str, tuple[Any, str | None]] = {}
    eligible_corridors: dict[str, dict] = {}
    identities: set[str] = set()
    for segment in feed["segments"]:
        if not isinstance(segment, dict) or not isinstance(segment.get("messageId"), str) or not segment["messageId"]:
            rejected["invalid_reference_identity"] += 1
            continue
        identity = segment["messageId"]
        if identity in identities:
            raise ValueError("Duplicated static reference identity")
        identities.add(identity)
        try:
            request = native.native_request(segment, 1, "offline-preparation", "a" * 64, feed["staticRevision"])
        except (ValueError, TypeError, KeyError, OverflowError):
            rejected["invalid_reference"] += 1
            continue
        frc = request["lrps"][0]["frc"]
        by_frc.setdefault(frc, Counter())["source"] += 1
        if str(segment.get("countryCode") or "") != "11" or str(segment.get("locationTableNumber") or "") != "25":
            rejected["other_tmc_country_or_table"] += 1
            continue
        road_id = point_roads.get(str(segment.get("locationId") or ""))
        if not road_id or road_id not in roads:
            rejected["no_tmc_road"] += 1
            continue
        if road_id not in parts_cache:
            parts_cache[road_id] = corridor_parts(roads[road_id])
        parts, reason = parts_cache[road_id]
        if reason:
            rejected[reason] += 1
            continue
        endpoints = (segment["coordinates"][0], segment["coordinates"][-1])
        distances = [geography.road_distance_m(tuple(point), parts) for point in endpoints]
        if any(not math.isfinite(distance) or distance > tolerance_meters for distance in distances):
            rejected["endpoint_outside_corridor"] += 1
            continue
        entry = {"toleranceMeters": float(tolerance_meters), "parts": parts}
        native.validate_corridor({"revision": "a" * 64, **entry})
        groups.setdefault(frc, []).append(segment)
        eligible_corridors[identity] = entry
        by_frc[frc]["eligible"] += 1
    selected = stratified_subset(groups, maximum)
    for segment in selected:
        by_frc[int(segment["openlr"]["points"][0]["frc"])]["selected"] += 1
    canonical = {"tmcVersion": "11.0", "tmcSha256": tmc_sha256,
                 "corridors": {segment["messageId"]: eligible_corridors[segment["messageId"]]
                               for segment in selected}}
    revision = hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":"),
                                        allow_nan=False).encode()).hexdigest()
    static = {"staticRevision": feed["staticRevision"], "segments": selected}
    corridors = {"contractVersion": CONTRACT, "revision": revision, **canonical}
    eligible_count = sum(len(values) for values in groups.values())
    report = {"contractVersion": "sim-openlr-native-corridor-preparation-v1", "approvedForLive": False,
              "sourceReferenceCount": len(feed["segments"]), "eligibleReferenceCount": eligible_count,
              "selectedReferenceCount": len(selected), "omittedEligibleReferenceCount": eligible_count - len(selected),
              "maximumSelectedReferences": maximum, "toleranceMeters": float(tolerance_meters),
              "maximumParts": MAX_PARTS, "maximumPoints": MAX_POINTS,
              "staticRevision": feed["staticRevision"], "tmcVersion": "11.0", "tmcSha256": tmc_sha256,
              "corridorRevision": revision, "rejectionCounts": dict(sorted(rejected.items())),
              "byFrc": {str(frc): {name: values[name] for name in ("source", "eligible", "selected")}
                        for frc, values in sorted(by_frc.items())}}
    assert len(selected) + report["omittedEligibleReferenceCount"] + sum(rejected.values()) == len(feed["segments"])
    return static, corridors, report


def run(args: argparse.Namespace) -> dict:
    sources = {args.static_cache.resolve(), args.tmc_zip.resolve()}
    outputs = (args.output_static.resolve(), args.output_corridors.resolve())
    if (outputs[0] == outputs[1] or any(path in sources or not path.name.endswith(".json.gz") for path in outputs) or
        any(path.is_relative_to(Path("/run")) or path.is_relative_to(Path("/var/run")) for path in outputs)):
        raise ValueError("Private outputs must be separate JSON gzip snapshots outside runtime directories")
    with gzip.open(args.static_cache, "rb") as stream:
        payload = stream.read(MAX_STATIC_BYTES + 1)
    if len(payload) > MAX_STATIC_BYTES:
        raise ValueError("Static snapshot byte limit")
    feed = json.loads(payload)
    with zipfile.ZipFile(args.tmc_zip) as archive:
        if archive.testzip() is not None:
            raise ValueError("TMC ZIP integrity failure")
        roads, point_roads = geography.tmc_roads(archive)
    static, corridors, report = prepare(feed, roads, point_roads, file_sha256(args.tmc_zip),
                                        args.max_segments, args.tolerance_meters)
    native.private_json(args.output_static, static)
    native.private_json(args.output_corridors, corridors)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--static-cache", type=Path, required=True)
    parser.add_argument("--tmc-zip", type=Path, required=True)
    parser.add_argument("--output-static", type=Path, required=True)
    parser.add_argument("--output-corridors", type=Path, required=True)
    parser.add_argument("--max-segments", type=int, default=DEFAULT_MAX_SEGMENTS,
                        help="Default: stratified 240-reference probe. Explicit national batch ceiling: 100000.")
    parser.add_argument("--tolerance-meters", type=float, default=100)
    args = parser.parse_args()
    try:
        report = run(args)
    except (OSError, ValueError, RuntimeError, KeyError, IndexError, EOFError, struct.error, zipfile.BadZipFile):
        print("Offline corridor preparation failed; inspect private inputs and bounds.", file=sys.stderr)
        return 1
    print(json.dumps(report, sort_keys=True, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
