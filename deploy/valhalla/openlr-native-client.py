#!/usr/bin/env python3
"""Offline client for the version-pinned native OpenLR protocol.

Consumes only a private normalized static feed and immutable graph. It writes
an independent mode-0600 audit, never runtime traffic state or traffic.tar.
Native matches remain candidates until the geographic/ownership gates pass.
"""
from __future__ import annotations

import argparse
from collections import Counter
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import select
import signal
import subprocess
import threading
import time
from typing import Any

DECODER_VERSION = "openlr-native-v1"


def hash_value(value: str) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(character in "0123456789abcdef" for character in value)


def finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_response(result: Any, request_id: int, dataset: str, graph_hash: str, corridor_revision: str = "") -> None:
    statuses = {"matched", "unmatched", "no_endpoint", "ambiguous", "search_limit", "candidate_limit",
                "invalid_reference", "graph_error", "graph_mismatch", "disconnected_lrps",
                "unsupported_fow", "unsupported_driving_direction", "unsupported_restriction", "unsupported_hierarchy"}
    keys = {"requestId", "decoderVersion", "routingDataset", "graphSha256", "corridorRevision", "status", "expansions"}
    if (not isinstance(result, dict) or type(result.get("requestId")) is not int or
        result.get("requestId") != request_id or result.get("decoderVersion") != DECODER_VERSION or
        result.get("routingDataset") != dataset or result.get("graphSha256") != graph_hash or
        result.get("corridorRevision") != corridor_revision or
        result.get("status") not in statuses or type(result.get("expansions")) is not int or result["expansions"] < 0):
        raise RuntimeError("Native decoder response identity mismatch")
    if result["status"] != "matched":
        if set(result) != keys:
            raise RuntimeError("Native decoder error response contains unexpected data")
        return
    if set(result) != keys | {"intervals", "fullEdgeIds", "lengthMeters"}:
        raise RuntimeError("Native decoder matched response contains unexpected data")
    intervals = result["intervals"]
    if not isinstance(intervals, list) or not 1 <= len(intervals) <= 1024:
        raise RuntimeError("Native decoder returned invalid intervals")
    ids, length = [], 0.
    for interval in intervals:
        if (not isinstance(interval, dict) or set(interval) != {
            "edgeId", "beginFraction", "endFraction", "edgeLengthMeters"} or
            type(interval["edgeId"]) is not int or not 0 <= interval["edgeId"] < 2**64 or
            not all(finite_number(interval[key]) for key in ("beginFraction", "endFraction", "edgeLengthMeters")) or
            not 0 <= interval["beginFraction"] < interval["endFraction"] <= 1 or interval["edgeLengthMeters"] <= 0):
            raise RuntimeError("Native decoder returned invalid interval")
        ids.append(interval["edgeId"])
        length += (interval["endFraction"] - interval["beginFraction"]) * interval["edgeLengthMeters"]
    full = [i["edgeId"] for i in intervals if i["beginFraction"] <= 1e-7 and i["endFraction"] >= 1 - 1e-7]
    if (len(set(ids)) != len(ids) or result["fullEdgeIds"] != full or
        not finite_number(result["lengthMeters"]) or not math.isclose(length, result["lengthMeters"], abs_tol=.001)):
        raise RuntimeError("Native decoder edge interval ownership mismatch")


def validate_corridor(value: Any) -> None:
    if (not isinstance(value, dict) or set(value) != {"revision", "toleranceMeters", "parts"} or
        not hash_value(value["revision"]) or not finite_number(value["toleranceMeters"]) or
        not 10 <= value["toleranceMeters"] <= 100 or not isinstance(value["parts"], list) or
        not 1 <= len(value["parts"]) <= 16):
        raise ValueError("Invalid independent corridor")
    count = 0
    for part in value["parts"]:
        if not isinstance(part, list) or len(part) < 2:
            raise ValueError("Invalid independent corridor part")
        count += len(part)
        for point in part:
            if (not isinstance(point, list) or len(point) != 2 or not all(finite_number(n) for n in point) or
                not -180 <= point[0] <= 180 or not -85 <= point[1] <= 85):
                raise ValueError("Invalid independent corridor coordinate")
    if count > 512:
        raise ValueError("Independent corridor point limit")


def native_request(segment: dict[str, Any], request_id: int, dataset: str,
                   graph_hash: str, static_revision: str, corridor: dict[str, Any] | None = None) -> dict[str, Any]:
    """Translate normalized TPEG byte bearings into the native degree contract."""
    if not hash_value(graph_hash) or not hash_value(static_revision):
        raise ValueError("Invalid graph/static identity")
    reference, coordinates = segment.get("openlr"), segment.get("coordinates")
    if not isinstance(reference, dict) or not isinstance(coordinates, list):
        raise ValueError("Missing OpenLR reference")
    points = reference.get("points")
    if not isinstance(points, list) or not 2 <= len(points) <= 16 or len(points) != len(coordinates):
        raise ValueError("Invalid LRP count")
    lrps = []
    for index, (point, coordinate) in enumerate(zip(points, coordinates)):
        if not isinstance(point, dict) or not isinstance(coordinate, list) or len(coordinate) != 2:
            raise ValueError("Invalid LRP")
        lon, lat, bearing = float(coordinate[0]), float(coordinate[1]), float(point["bearing"])
        if (any(isinstance(value, bool) for value in (*coordinate, point["bearing"])) or
            not all(map(math.isfinite, (lon, lat, bearing))) or not -180 <= lon <= 180 or not -85 <= lat <= 85 or
            not 0 <= bearing <= 255 or not bearing.is_integer()):
            raise ValueError("Invalid bearing/coordinate")
        frc, fow = int(point["frc"]), int(point["fow"])
        if str(frc) != str(point["frc"]) or str(fow) != str(point["fow"]) or not 0 <= frc <= 7 or not 0 <= fow <= 7:
            raise ValueError("Invalid road properties")
        lrp = {"lon": lon, "lat": lat, "bearingDegrees": bearing * 360 / 256,
               "frc": frc, "fow": fow}
        if index + 1 < len(points):
            dnp, lowest = float(point["distanceToNext"]), int(point["lowestFrcToNext"])
            if (isinstance(point["distanceToNext"], bool) or not math.isfinite(dnp) or not 1 <= dnp <= 20000 or
                str(lowest) != str(point["lowestFrcToNext"]) or not 0 <= lowest <= 7):
                raise ValueError("Invalid path properties")
            lrp["distanceToNext"], lrp["lowestFrcToNext"] = dnp, lowest
        elif "distanceToNext" in point or "lowestFrcToNext" in point:
            raise ValueError("Final LRP has path properties")
        if "againstDrivingDirection" in point:
            if not isinstance(point["againstDrivingDirection"], bool):
                raise ValueError("Invalid driving direction")
            lrp["againstDrivingDirection"] = point["againstDrivingDirection"]
        lrps.append(lrp)
    result = {"requestId": request_id, "routingDataset": dataset, "graphSha256": graph_hash,
              "staticRevision": static_revision, "lrps": lrps}
    for key in ("positiveOffsetMeters", "negativeOffsetMeters"):
        if key in reference:
            value = float(reference[key])
            if isinstance(reference[key], bool) or not math.isfinite(value) or not 0 <= value <= 20000:
                raise ValueError("Invalid offset")
            result[key] = value
    if corridor is not None:
        validate_corridor(corridor)
        result["corridor"] = corridor
    return result


class NativeDecoderClient:
    def __init__(self, helper: Path, graph_config: Path, dataset: str, graph_hash: str,
                 timeout_seconds: float = 30) -> None:
        if not hash_value(graph_hash) or not dataset or not 1 <= timeout_seconds <= 120:
            raise ValueError("Invalid native decoder configuration")
        self.dataset, self.graph_hash, self.timeout_seconds = dataset, graph_hash, timeout_seconds
        self.request_id, self.lock = 0, threading.Lock()
        self.failed = False
        self.process = subprocess.Popen([str(helper), str(graph_config), dataset, graph_hash],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            bufsize=0, start_new_session=True)

    def _terminate_process_group(self) -> None:
        """Stop only this helper's new POSIX session, including wrapper children."""
        group_id = self.process.pid
        try:
            os.killpg(group_id, signal.SIGTERM)
        except ProcessLookupError:
            pass
        deadline = time.monotonic() + 1
        while True:
            # Reap our direct child even if a wrapper descendant still survives.
            self.process.poll()
            try:
                os.killpg(group_id, 0)
            except ProcessLookupError:
                break
            except PermissionError:
                # Darwin can briefly return EPERM while an owned group is
                # exiting, before a later probe yields ESRCH. Do not certify
                # cleanup from EPERM: retry within the same bounded grace.
                if time.monotonic() >= deadline:
                    raise
                time.sleep(min(.02, max(0, deadline - time.monotonic())))
                continue
            if time.monotonic() >= deadline:
                try:
                    os.killpg(group_id, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                break
            time.sleep(min(.02, max(0, deadline - time.monotonic())))
        self.process.wait(timeout=5)

    def decode(self, segment: dict[str, Any], static_revision: str,
               corridor: dict[str, Any] | None = None) -> dict[str, Any]:
        with self.lock:
            if self.process.poll() is not None or self.process.stdin is None or self.process.stdout is None:
                self.failed = True
                self._terminate_process_group()
                raise RuntimeError("Native decoder unavailable")
            self.request_id += 1
            request = native_request(segment, self.request_id, self.dataset, self.graph_hash, static_revision, corridor)
            deadline, payload = time.monotonic() + self.timeout_seconds, b""
            try:
                self.process.stdin.write((json.dumps(request, separators=(",", ":"), allow_nan=False) + "\n").encode())
                self.process.stdin.flush()
                while not payload.endswith(b"\n"):
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not select.select([self.process.stdout], [], [], remaining)[0]:
                        raise TimeoutError("Native decoder request exceeded bounded timeout")
                    chunk = os.read(self.process.stdout.fileno(), 4096)
                    if not chunk:
                        raise RuntimeError("Native decoder stopped without a response")
                    payload += chunk
                    if len(payload) > 256 * 1024 or b"\n" in payload[:-1]:
                        raise RuntimeError("Native decoder exceeded protocol bounds")
                result = json.loads(payload)
                validate_response(result, self.request_id, self.dataset, self.graph_hash,
                                  corridor["revision"] if corridor is not None else "")
            except Exception:
                self.failed = True
                self._terminate_process_group()
                raise
            return result

    def close(self) -> None:
        if self.process.stdin:
            try:
                self.process.stdin.close()
            except BrokenPipeError:
                pass
        try:
            returncode = self.process.wait(timeout=self.timeout_seconds)
        except subprocess.TimeoutExpired:
            self._terminate_process_group()
            if not self.failed:
                raise RuntimeError("Native decoder final graph verification timed out")
        else:
            if returncode and not self.failed:
                raise RuntimeError("Native decoder failed final graph verification")
        finally:
            if self.process.stdout:
                self.process.stdout.close()


def private_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp-" + str(os.getpid()))
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as raw:
            with gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as compressed:
                compressed.write(json.dumps(value, separators=(",", ":"), sort_keys=True).encode())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def validate_audit_output(args: argparse.Namespace) -> None:
    """An offline audit must not replace its inputs or writable runtime state."""
    output = args.output.resolve()
    runtime_roots = {Path("/run"), Path("/var/run"),
                     Path("/run").resolve(), Path("/var/run").resolve()}
    if (not args.output.name.endswith(".json.gz") or
        any(output.is_relative_to(root) for root in runtime_roots)):
        raise ValueError("Private audit output must be a separate JSON gzip snapshot outside runtime directories")
    inputs = [args.static_cache, args.helper, args.graph_config]
    if getattr(args, "corridor_cache", None) is not None:
        inputs.append(args.corridor_cache)
    for source in inputs:
        if output == source.resolve() or (output.exists() and source.exists() and output.samefile(source)):
            raise ValueError("Private audit output must not replace an input, helper or configuration")


def run(args: argparse.Namespace) -> dict[str, Any]:
    validate_audit_output(args)
    with gzip.open(args.static_cache, "rt", encoding="utf-8") as stream:
        feed = json.load(stream)
    if not isinstance(feed, dict) or not isinstance(feed.get("segments"), list) or not hash_value(feed.get("staticRevision", "")):
        raise ValueError("Invalid private static snapshot")
    if len(feed["segments"]) > 100000:
        raise ValueError("Static reference limit")
    corridor_feed = None
    if getattr(args, "corridor_cache", None):
        with gzip.open(args.corridor_cache, "rt", encoding="utf-8") as stream:
            corridor_feed = json.load(stream)
        if (not isinstance(corridor_feed, dict) or set(corridor_feed) != {
            "contractVersion", "revision", "tmcVersion", "tmcSha256", "corridors"} or
            corridor_feed["contractVersion"] != "sim-tmc-corridors-v1" or not hash_value(corridor_feed["revision"]) or
            not hash_value(corridor_feed["tmcSha256"]) or not isinstance(corridor_feed["tmcVersion"], str) or
            not 1 <= len(corridor_feed["tmcVersion"]) <= 20 or
            not isinstance(corridor_feed["corridors"], dict)):
            raise ValueError("Invalid independent corridor snapshot")
        canonical = {key: corridor_feed[key] for key in ("tmcVersion", "tmcSha256", "corridors")}
        actual_revision = hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
        if actual_revision != corridor_feed["revision"]:
            raise ValueError("Independent corridor snapshot hash mismatch")
    client = NativeDecoderClient(args.helper, args.graph_config, args.routing_dataset, args.graph_sha256)
    counts: Counter[str] = Counter()
    intervals, owners = {}, {}
    source_ids = set()
    try:
        for segment in feed["segments"]:
            message_id = str(segment.get("messageId", "")) if isinstance(segment, dict) else ""
            if not message_id or message_id in source_ids:
                raise ValueError("Missing or duplicated reference identity")
            source_ids.add(message_id)
            corridor = None
            if corridor_feed is not None:
                entry = corridor_feed["corridors"].get(message_id)
                if entry is None:
                    counts["missing_corridor"] += 1
                    continue
                if not isinstance(entry, dict) or set(entry) != {"toleranceMeters", "parts"}:
                    raise ValueError("Invalid independent corridor entry")
                corridor = {"revision": corridor_feed["revision"], **entry}
            try:
                result = client.decode(segment, feed["staticRevision"], corridor)
            except (ValueError, KeyError, TypeError, OverflowError):
                counts["invalid_reference"] += 1
                continue
            status = str(result.get("status", "invalid_response"))
            counts[status] += 1
            if status == "matched":
                intervals[message_id] = result["intervals"]
                # Even another reference's partial claim blocks activation of
                # the full edge; partial runtime speed semantics are unapproved.
                for edge_id in {item["edgeId"] for item in result["intervals"]}:
                    owners.setdefault(edge_id, set()).add(message_id)
    finally:
        client.close()
    # Ambiguity is resolved above with complete intervals. Separate ownership
    # rejection applies after all references are decoded; no last-write-wins.
    collision_ids = {ident for claims in owners.values() if len(claims) > 1 for ident in claims}
    full_mapping = {}
    for ident, path in intervals.items():
        if ident in collision_ids:
            continue
        edges = [{"id": i["edgeId"]} for i in path if i["beginFraction"] <= 1e-7 and i["endFraction"] >= 1 - 1e-7]
        if edges:
            full_mapping[ident] = edges
    corridor_revision = corridor_feed["revision"] if corridor_feed is not None else ""
    key = hashlib.sha256(f"{DECODER_VERSION}:{args.routing_dataset}:{args.graph_sha256}:{feed['staticRevision']}:{corridor_revision}".encode()).hexdigest()
    report = {"contractVersion": "sim-openlr-native-audit-v1", "decoderVersion": DECODER_VERSION,
      "routingDataset": args.routing_dataset, "graphSha256": args.graph_sha256, "staticRevision": feed["staticRevision"],
      "cacheKey": key, "sourceReferenceCount": len(feed["segments"]), "resultCounts": dict(sorted(counts.items())),
      "independentCorridorRevision": corridor_revision or None,
      "tmcVersion": corridor_feed["tmcVersion"] if corridor_feed is not None else None,
      "tmcSha256": corridor_feed["tmcSha256"] if corridor_feed is not None else None,
      "matchedIntervalReferenceCount": len(intervals), "wholeEdgeCandidateReferenceCount": len(full_mapping),
      "collisionReferenceCount": len(collision_ids), "approvedForLive": False,
      "intervalCandidates": intervals, "mapping": full_mapping}
    private_json(args.output, report)
    return {key: value for key, value in report.items() if key not in {"intervalCandidates", "mapping"}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--graph-config", type=Path, required=True)
    parser.add_argument("--routing-dataset", required=True)
    parser.add_argument("--graph-sha256", required=True)
    parser.add_argument("--static-cache", type=Path, required=True)
    parser.add_argument("--corridor-cache", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args), sort_keys=True))
