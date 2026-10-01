#!/usr/bin/env python3
"""Independent Python falsification of native paths. Never authorizes live use.

Uses exported exact directed geometry, source bearings/order and licensed TMC
geometry independently of the native path finder. All stdout is aggregate.
"""
from collections import Counter
import argparse
import gzip
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("tmc_review_geometry", ROOT / "audit-tmc-candidate-geography.py")
geography = importlib.util.module_from_spec(spec)
spec.loader.exec_module(geography)


def read_private(path):
    with gzip.open(path, "rb") as stream:
        raw = stream.read(256 * 1024 * 1024 + 1)
    if len(raw) > 256 * 1024 * 1024:
        raise ValueError("Private input limit")
    return json.loads(raw)


def clip_shape(shape, begin, end):
    if (not isinstance(shape, list) or len(shape) < 2 or not 0 <= begin < end <= 1 or
            any(not isinstance(p, (tuple, list)) or len(p) != 2 or
                any(type(v) not in (float, int) or not math.isfinite(v) for v in p) for p in shape)):
        raise ValueError("Invalid directed geometry")
    lengths = [geography.point_segment_m(a, b, b) for a, b in zip(shape, shape[1:])]
    total = sum(lengths)
    if total <= 0:
        raise ValueError("Empty directed geometry")
    low, high, walked, output = begin * total, end * total, 0., []
    for a, b, distance in zip(shape, shape[1:], lengths):
        if distance > 0 and walked + distance >= low and walked <= high:
            start = max(low, walked); stop = min(high, walked + distance)
            for at in (start, stop):
                fraction = (at - walked) / distance
                point = (a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction)
                if not output or point != output[-1]:
                    output.append(point)
        walked += distance
    if len(output) < 2:
        raise ValueError("Empty clipped geometry")
    return output


def review(segment, intervals, shapes, road):
    reference = segment["openlr"]
    if any(reference.get(key, 0) != 0 for key in ("positiveOffsetMeters", "negativeOffsetMeters")):
        return "offset_review_required"  # Do not invent pre-offset path provenance.
    path = []
    for interval in intervals:
        part = clip_shape(shapes[str(interval["edgeId"])], interval["beginFraction"], interval["endFraction"])
        if path and geography.point_segment_m(path[-1], part[0], part[0]) > 2:
            return "disconnected_geometry"
        path.extend(part if not path else part[1:])
    previous = -1.
    for index, (coordinate, point) in enumerate(zip(segment["coordinates"], reference["points"])):
        distance, progress, bearing = geography.path_projection(tuple(coordinate), path)
        if distance > 22:
            return "lrp_outside_path"
        if progress <= previous + .01:
            return "lrp_order_or_direction_mismatch"
        previous = progress
        expected = float(point["bearing"]) * 360 / 256
        if index + 1 == len(reference["points"]):
            expected = (expected + 180) % 360
        if geography.angular_difference(bearing, expected) > 36:
            return "lrp_bearing_mismatch"
    for a, b in zip(path, path[1:]):
        distance = geography.point_segment_m(a, b, b)
        samples = max(1, math.ceil(distance / 10))
        for i in range(samples + 1):
            point = (a[0] + (b[0] - a[0]) * i / samples, a[1] + (b[1] - a[1]) * i / samples)
            if geography.road_distance_m(point, road) > 100:
                return "tmc_corridor_divergence"
    return "independent_geometry_direction_pass"


def write_private(path, value, inputs):
    output = path.resolve()
    if (not path.name.endswith(".json.gz") or
            any(output.is_relative_to(root.resolve()) for root in (Path("/run"), Path("/var/run"))) or
            any(output == source.resolve() or (path.exists() and source.exists() and path.samefile(source))
                for source in inputs)):
        raise ValueError("Private review must not replace an input or runtime state")
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            with gzip.GzipFile(fileobj=stream, mode="wb", mtime=0) as compressed:
                compressed.write(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode())
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def run(args):
    source, audit, exported = map(read_private, (args.static_cache, args.audit, args.shapes))
    if (audit.get("decoderVersion") != "openlr-native-v2" or audit.get("approvedForLive") is not False or
            source["staticRevision"] != audit["staticRevision"] or
            exported.get("contractVersion") != "sim-native-directed-shapes-v1" or
            exported["graphSha256"] != audit["graphSha256"]):
        raise ValueError("Independent review identity mismatch")
    tmc_hash = hashlib.sha256(args.tmc_zip.read_bytes()).hexdigest()
    if tmc_hash != audit["tmcSha256"]:
        raise ValueError("Independent TMC identity mismatch")
    with zipfile.ZipFile(args.tmc_zip) as archive:
        if archive.testzip() is not None:
            raise ValueError("Independent TMC integrity failure")
        roads, point_roads = geography.tmc_roads(archive)
    segments = {s["messageId"]: s for s in source["segments"]}
    counts, whole_counts, frc_counts, geometry_cache, verdicts = Counter(), Counter(), {}, {}, {}
    for ident, intervals in audit["intervalCandidates"].items():
        segment = segments[ident]
        road_id = point_roads.get(str(segment.get("locationId")))
        if str(segment.get("countryCode")) != "11" or str(segment.get("locationTableNumber")) != "25" or road_id not in roads:
            verdict = "invalid_tmc_membership"
        else:
            if road_id not in geometry_cache:
                geometry_cache[road_id] = [[(float(lon), float(lat)) for lon, lat in part]
                                           for part in roads[road_id]]
            try:
                verdict = review(segment, intervals, exported["shapes"], geometry_cache[road_id])
            except (ValueError, KeyError, TypeError, OverflowError):
                verdict = "invalid_or_missing_geometry"
        counts[verdict] += 1
        verdicts[ident] = verdict
        if ident in audit["mapping"]:
            whole_counts[verdict] += 1
        frc_counts.setdefault(str(segment["openlr"]["points"][0]["frc"]), Counter())[verdict] += 1
    if sum(counts.values()) != audit["matchedIntervalReferenceCount"] or sum(whole_counts.values()) != audit["wholeEdgeCandidateReferenceCount"]:
        raise ValueError("Independent review count mismatch")
    summary = {"contractVersion": "sim-native-direction-review-v1", "approvedForLive": False,
            "routingDataset": audit["routingDataset"], "graphSha256": audit["graphSha256"],
            "staticRevision": audit["staticRevision"], "tmcSha256": tmc_hash,
            "nativeAuditSha256": hashlib.sha256(args.audit.read_bytes()).hexdigest(),
            "directedShapesSha256": hashlib.sha256(args.shapes.read_bytes()).hexdigest(),
            "reviewedIntervalReferenceCount": sum(counts.values()), "resultCounts": dict(sorted(counts.items())),
            "wholeEdgeResultCounts": dict(sorted(whole_counts.items())),
            "byFrc": {k: dict(sorted(v.items())) for k, v in sorted(frc_counts.items())},
            "caveat": "Independent falsification, not provider provenance, complete turn/access or ETA ground truth; nonzero offsets require separate review."}
    if getattr(args, "output", None) is not None:
        write_private(args.output, {**summary, "verdicts": verdicts},
                      [args.static_cache, args.audit, args.shapes, args.tmc_zip])
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("static-cache", "audit", "shapes", "tmc-zip"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--output", type=Path, help="Optional separate private verdict snapshot, never runtime mapping.")
    print(json.dumps(run(parser.parse_args()), sort_keys=True))
