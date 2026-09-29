#!/usr/bin/env python3
"""Read-only, aggregate audit of a licensed Czech TMC table against SIM TPEG2.

The licensed ZIP and source references are never copied into Git or printed.
This audit does not authorize mapping a TMC location to Valhalla graph edges.
"""

from __future__ import annotations

import argparse
from collections import Counter
import csv
import gzip
import io
import json
import math
from pathlib import Path
import sys
import zipfile


PREFIX = "ltcze11_0_cz/data/tmc_format/"
EXPECTED_CID = "11"
EXPECTED_TABCD = "25"
EXPECTED_VERSION = "11.0"


def distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = map(math.radians, a)
    lon2, lat2 = map(math.radians, b)
    delta_lon, delta_lat = lon2 - lon1, lat2 - lat1
    hav = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    return 12_742_000 * math.asin(min(1, math.sqrt(hav)))


def quantiles(values: list[float]) -> dict[str, int]:
    if not values:
        return {}
    values.sort()
    return {key: round(values[int((len(values) - 1) * fraction)]) for key, fraction in
            (("p50", 0.5), ("p90", 0.9), ("p99", 0.99))}


def read_table(archive: zipfile.ZipFile, name: str) -> list[dict[str, str]]:
    with archive.open(PREFIX + name) as stream:
        text = io.TextIOWrapper(stream, encoding="utf-8-sig", newline="")
        return list(csv.DictReader(text, delimiter=";"))


def audit(zip_path: Path, static_path: Path | None = None, baseline_path: Path | None = None) -> dict:
    if baseline_path is not None and static_path is None:
        raise ValueError("Baseline comparison requires a static snapshot")
    with zipfile.ZipFile(zip_path) as archive:
        if archive.testzip() is not None:
            raise ValueError("TMC archive failed ZIP integrity check")
        datasets = read_table(archive, "LOCATIONDATASETS.DAT")
        if len(datasets) != 1 or any(
            datasets[0].get(field) != value
            for field, value in (("CID", EXPECTED_CID), ("TABCD", EXPECTED_TABCD), ("VERSION", EXPECTED_VERSION))
        ):
            raise ValueError("TMC archive is not Czech location table 11.0 / CID 11 / TABCD 25")
        locations: dict[str, str] = {}
        point_coordinates: dict[str, tuple[float, float]] = {}
        for name, kind in (("POINTS.DAT", "point"), ("SEGMENTS.DAT", "segment"), ("ROADS.DAT", "road")):
            for row in read_table(archive, name):
                if row.get("CID") != EXPECTED_CID or row.get("TABCD") != EXPECTED_TABCD:
                    raise ValueError(f"Unexpected country or table number in {name}")
                location_id = row.get("LCD", "")
                if not location_id or location_id in locations:
                    raise ValueError(f"Missing or duplicate location code in {name}")
                locations[location_id] = kind
                if kind == "point":
                    point_coordinates[location_id] = (
                        int(row["XCOORD"]) / 100_000, int(row["YCOORD"]) / 100_000
                    ) if row.get("XCOORD") and row.get("YCOORD") else (float("nan"), float("nan"))
        result: dict = {
            "tableVersion": EXPECTED_VERSION,
            "countryCode": EXPECTED_CID,
            "tableNumber": EXPECTED_TABCD,
            "locationCount": len(locations),
            "locationTypes": dict(sorted(Counter(locations.values()).items())),
            "warning": "TMC references are location anchors, not directed Valhalla edge paths; no live speed activation is implied.",
        }
        if static_path is None:
            return result
        if str(static_path) == "-":
            with gzip.GzipFile(fileobj=sys.stdin.buffer) as compressed:
                snapshot = json.load(io.TextIOWrapper(compressed, encoding="utf-8"))
        else:
            with gzip.open(static_path, "rt", encoding="utf-8") as stream:
                snapshot = json.load(stream)
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get("segments"), list):
            raise ValueError("Invalid normalized SIM static snapshot")
        baseline_ids: set[str] | None = None
        if baseline_path is not None:
            with gzip.open(baseline_path, "rt", encoding="utf-8") as stream:
                baseline = json.load(stream)
            if (not isinstance(baseline, dict) or not isinstance(baseline.get("mapping"), dict)
                or baseline.get("staticRevision") != snapshot.get("staticRevision")):
                raise ValueError("Baseline mapping and SIM static snapshot have different revisions")
            baseline_ids = set(baseline["mapping"])
        counts: Counter[str] = Counter()
        endpoint_distances: list[float] = []
        matched_endpoint_distances: list[float] = []
        unmatched_endpoint_distances: list[float] = []
        for segment in snapshot["segments"]:
            if not isinstance(segment, dict):
                counts["invalid_segment"] += 1
                continue
            location_id = str(segment.get("locationId") or "")
            country = str(segment.get("countryCode") or "")
            table = str(segment.get("locationTableNumber") or "")
            if not location_id:
                counts["no_tmc_reference"] += 1
            elif country != EXPECTED_CID or table != EXPECTED_TABCD:
                counts["other_country_or_table"] += 1
            elif location_id not in locations:
                counts["unknown_location"] += 1
            else:
                counts[f"matched_{locations[location_id]}"] += 1
                anchor = point_coordinates.get(location_id)
                shape = segment.get("coordinates")
                if anchor and all(map(math.isfinite, anchor)) and isinstance(shape, list) and len(shape) >= 2:
                    try:
                        endpoints = (tuple(map(float, shape[0])), tuple(map(float, shape[-1])))
                        if all(len(item) == 2 and all(map(math.isfinite, item)) for item in endpoints):
                            separation = min(distance_m(anchor, point) for point in endpoints)
                            endpoint_distances.append(separation)
                            if baseline_ids is not None:
                                (matched_endpoint_distances if str(segment.get("messageId")) in baseline_ids
                                 else unmatched_endpoint_distances).append(separation)
                    except (TypeError, ValueError, OverflowError):
                        pass
        result["staticRevision"] = str(snapshot.get("staticRevision") or "")
        result["staticSegmentCount"] = len(snapshot["segments"])
        result["referenceCounts"] = dict(sorted(counts.items()))
        result["tmcPointToNearestOpenlrEndpointMeters"] = quantiles(endpoint_distances)
        result["tmcPointEndpointComparisonCount"] = len(endpoint_distances)
        if baseline_ids is not None:
            result["baselineMappedSegmentCount"] = len(baseline_ids)
            result["baselineMappedAnchorMeters"] = quantiles(matched_endpoint_distances)
            result["baselineUnmappedAnchorMeters"] = quantiles(unmatched_endpoint_distances)
        return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--zip", required=True, type=Path, help="Private licensed LT_v11.zip")
    parser.add_argument("--static-cache", type=Path, help="Private SIM static-segments.json.gz, or - for stdin")
    parser.add_argument("--baseline-cache", type=Path, help="Private validated OpenLR edge map for revision-matched comparison")
    args = parser.parse_args()
    print(json.dumps(audit(args.zip, args.static_cache, args.baseline_cache), ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
