#!/usr/bin/env python3
"""Bounded graph-native v2 same-snapshot pilot, inside an isolated RO sidecar.

No production writes, source calls, secrets, ports or serving-container actions.
Results contain private reference identities and MUST stay mode 0600.
An automated pass is deliberately not geographic or live-use approval.
"""
from __future__ import annotations

from datetime import datetime
import gzip
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import time
from zoneinfo import ZoneInfo

DATASET = "sim-routing-2026-09-29-1790679143"
GRAPH = "301b222d431aca366841117a1093e26dd763a2c3a721e41f74244e2ce5a22909"
STATIC = "10b52da1cef6b14e56c112ce1b78770cccaf6fd77ae96e2e1a01d719e1e01a08"
BASELINE = "2281f0fd88d64a015dcf335db4e9fe793a2e2ec6fa0bd46af95a700b9563d252"


def load(path):
    if path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("Input compressed size bound")
    with gzip.open(path, "rb") as stream:
        raw = stream.read(64 * 1024 * 1024 + 1)
    if len(raw) > 64 * 1024 * 1024:
        raise ValueError("Input expanded size bound")
    return json.loads(raw)


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def validate(candidate, baseline, static, feed, baseline_sha):
    if (candidate.get("contractVersion") != "sim-native-baseline-review-v1" or
            candidate.get("approvedForLive") is not False or
            candidate.get("routingDataset") != DATASET or candidate.get("graphSha256") != GRAPH or
            candidate.get("staticRevision") != STATIC or candidate.get("baselineSha256") != baseline_sha or
            baseline_sha != BASELINE or baseline.get("matcherVersion") != "openlr-trace-v2" or
            baseline.get("contractVersion") != "valhalla-openlr-edge-map-v2" or
            baseline.get("routingDataset") != DATASET or baseline.get("staticRevision") != STATIC or
            static.get("staticRevision") != STATIC or feed.get("staticRevision") != STATIC or
            feed.get("contractVersion") != "sim-valhalla-live-traffic-feed-v1" or
            not isinstance(feed.get("flows"), list) or len(feed["flows"]) > 100000 or
            type(feed.get("maxAgeSeconds")) is not int or not 0 < feed["maxAgeSeconds"] <= 1800):
        raise ValueError("Pilot artifact identity mismatch")
    if (not isinstance(candidate.get("mapping"), dict) or len(candidate["mapping"]) != 427 or
            candidate.get("isolatedCandidateReferenceCount") != 427 or
            not isinstance(baseline.get("mapping"), dict) or len(baseline["mapping"]) != 35639 or
            baseline.get("mappedSegmentCount") != 35639):
        raise ValueError("Pilot cohort identity mismatch")
    owned = {edge["id"] for path in baseline["mapping"].values() for edge in path}
    added = set()
    for ident, path in candidate["mapping"].items():
        if ident in baseline["mapping"] or not isinstance(path, list) or not 1 <= len(path) <= 1024:
            raise ValueError("Pilot reference overlap")
        for edge in path:
            if (not isinstance(edge, dict) or set(edge) != {"id"} or type(edge["id"]) is not int or
                    not 0 <= edge["id"] < 2**46 or (edge["id"] & 7) > 2 or
                    edge["id"] in owned or edge["id"] in added):
                raise ValueError("Pilot edge ownership conflict")
            added.add(edge["id"])
    if len(added) != 2870 or candidate.get("isolatedCandidateEdgeCount") != 2870:
        raise ValueError("Pilot edge count mismatch")
    return added


def request(segment, departure, *, reverse=False):
    coordinates = segment.get("coordinates", [])
    points = segment.get("openlr", {}).get("points", [])
    if not 2 <= len(coordinates) == len(points) <= 32:
        raise ValueError("Pilot source geometry invalid")
    headings = [float(points[0]["bearing"]) * 360 / 256,
                (float(points[-1]["bearing"]) * 360 / 256 + 180) % 360]
    locations = [{"lon": coordinates[i][0], "lat": coordinates[i][1], "radius": 20,
                  "search_cutoff": 20, "heading": headings[j], "heading_tolerance": 34}
                 for j, i in enumerate((0, -1))]
    if any(not math.isfinite(float(v)) for p in locations for v in p.values()):
        raise ValueError("Pilot nonfinite coordinate")
    if reverse:
        locations.reverse()
        for p in locations:
            p["heading"] = (p["heading"] + 180) % 360
    return {"locations": locations, "costing": "auto", "date_time": {"type": 1, "value": departure},
            "directions_type": "none", "units": "kilometers"}


def select(static, candidate, feed, traffic, now):
    fresh = {str(f.get("messageId")) for f in feed["flows"] if isinstance(f, dict) and
             traffic.flow_deadline(f, feed["maxAgeSeconds"], now) is not None and
             type(f.get("averageSpeedKph")) in (int, float) and
             math.isfinite(f["averageSpeedKph"]) and 0 < f["averageSpeedKph"] <= 250}
    groups = {}
    for segment in static["segments"]:
        ident = segment.get("messageId")
        if ident not in candidate["mapping"] or ident not in fresh:
            continue
        key = str(segment["openlr"]["points"][0].get("frc"))
        groups.setdefault(key, []).append(segment)
    selected = []
    for key in sorted(groups):
        group = sorted(groups[key], key=lambda s: s["messageId"])
        for i in range(min(2, len(group))):
            selected.append(group[i * len(group) // min(2, len(group))])
    if len(selected) < 4:
        raise ValueError("Insufficient fresh stratified routes")
    return selected[:16]


def measure(actor, payload, added, target):
    try:
        body = actor.route(payload)
        if isinstance(body, str):
            body = json.loads(body)
        trip = body["trip"]
        summary = trip["summary"]
        shape = trip["legs"][0]["shape"]
        trace = actor.trace_attributes({"encoded_polyline": shape, "shape_match": "edge_walk",
            "costing": payload["costing"], "date_time": payload["date_time"],
            "filters": {"action": "include", "attributes": ["edge.id"]}})
        if isinstance(trace, str):
            trace = json.loads(trace)
        edges = {e["id"] for e in trace["edges"]}
        if not all(type(v) in (int, float) and math.isfinite(v) and v > 0
                   for v in (summary["time"], summary["length"])):
            raise ValueError("Nonfinite route result")
        return {"status": "ok", "seconds": summary["time"], "kilometers": summary["length"],
                "shapeSha256": hashlib.sha256(shape.encode()).hexdigest(),
                "newEdgeCount": len(edges & added), "targetEdgeCount": len(edges & target)}
    except Exception:
        return {"status": "unavailable"}


def compare(left, right):
    if left["status"] != "ok" or right["status"] != "ok":
        return {"paired": False}
    return {"paired": True, "deltaSeconds": round(right["seconds"] - left["seconds"], 3),
            "shapeChanged": left["shapeSha256"] != right["shapeSha256"],
            "baselineNewEdgeCount": left["newEdgeCount"], "candidateNewEdgeCount": right["newEdgeCount"],
            "baselineTargetEdgeCount": left.get("targetEdgeCount", 0), "candidateTargetEdgeCount": right.get("targetEdgeCount", 0)}


def run():
    from valhalla import Actor
    work, results = Path("/work"), Path("/results")
    spec = importlib.util.spec_from_file_location("traffic", work / "traffic-update.py")
    traffic = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(traffic)
    candidate, baseline, static, feed = [load(work / name) for name in
        ("candidates.json.gz", "baseline.json.gz", "static.json.gz", "feed.json.gz")]
    added = validate(candidate, baseline, static, feed, sha(work / "baseline.json.gz"))
    if sha(Path("/custom_files/valhalla_tiles.tar")) != GRAPH:
        raise ValueError("Pilot graph hash changed")
    now = time.time()
    selected = select(static, candidate, feed, traffic, now)
    deadline = traffic.next_flow_recompute_epoch(feed, {"mapping": candidate["mapping"]}, feed["maxAgeSeconds"], now)
    if deadline - now < 90:
        raise ValueError("Pilot snapshot has insufficient remaining validity")
    departure = datetime.fromtimestamp(now, ZoneInfo("Europe/Prague")).strftime("%Y-%m-%dT%H:%M")
    payloads = []
    for segment in selected:
        payloads.extend([(segment["messageId"], "forward", request(segment, departure)),
                         (segment["messageId"], "reverse", request(segment, departure, reverse=True))])
    # Non-vehicle controls across actual candidate corridors, not just unrelated cities.
    for costing in ("pedestrian", "bicycle"):
        payload = request(selected[0], departure)
        payload["costing"] = costing
        payloads.append((selected[0]["messageId"], costing, payload))
    directory = Path("/tmp/native-traffic")
    directory.mkdir(mode=0o700)
    archive = directory / "traffic.tar"
    shutil.copyfile("/custom_files/traffic-skeleton.tar", archive)
    archive.chmod(0o600)
    config = json.loads(Path("/custom_files/valhalla.json").read_text())
    config["mjolnir"]["traffic_extract"] = str(archive)
    config["mjolnir"]["max_cache_size"] = 100000000
    speeds, _, _ = traffic.current_edge_speeds(feed, baseline, feed["maxAgeSeconds"], now)
    baseline_applied = traffic.apply_speeds(archive, directory / "applied-edges.json", speeds)
    actor = Actor(config)
    status = actor.status({})
    if isinstance(status, str): status = json.loads(status)
    if status.get("version") != "3.8.3": raise ValueError("Pilot actor version mismatch")
    before = [measure(actor, p, added, {e["id"] for e in candidate["mapping"][ident]}) for ident, _, p in payloads]
    candidate_speeds, candidate_flows, _ = traffic.current_edge_speeds(feed, candidate, feed["maxAgeSeconds"], now)
    merged = {**speeds, **candidate_speeds}
    if set(speeds) & set(candidate_speeds):
        raise ValueError("Pilot speed edge collision")
    actual = traffic.apply_speeds(archive, directory / "applied-edges.json", merged)
    if actual != len(merged):
        raise ValueError("Pilot archive rejected edge identities")
    after = [measure(actor, p, added, {e["id"] for e in candidate["mapping"][ident]}) for ident, _, p in payloads]
    pairs = [{"reference": ident, "kind": kind, "baseline": a, "candidate": b, **compare(a, b)}
             for (ident, kind, _), a, b in zip(payloads, before, after)]
    forward = [p for p in pairs if p["kind"] == "forward"]
    controls = [p for p in pairs if p["kind"] in ("pedestrian", "bicycle")]
    unaffected = [p for p in pairs if p.get("paired") and p.get("baselineNewEdgeCount") == 0 and p.get("candidateNewEdgeCount") == 0]
    controls_pass = all(p.get("paired") and not p["shapeChanged"] and abs(p["deltaSeconds"]) <= 0.01 for p in controls)
    unaffected_pass = all(not p["shapeChanged"] and abs(p["deltaSeconds"]) <= 0.01 for p in unaffected)
    forward_pass = sum(p.get("paired", False) and p.get("candidateNewEdgeCount", 0) > 0 for p in forward)
    target_pass = sum(p.get("paired", False) and p.get("candidateTargetEdgeCount", 0) > 0 and not p["shapeChanged"] for p in forward)
    changed = sum(p.get("paired", False) and abs(p.get("deltaSeconds", 0)) > 0.01 for p in forward)
    valid = time.time() < deadline and sha(Path("/custom_files/valhalla_tiles.tar")) == GRAPH
    passed = valid and target_pass >= 4 and changed > 0 and controls_pass and unaffected_pass
    report = {"contractVersion": "sim-native-same-flow-canary-v1", "approvedForLive": False,
        "routingDataset": DATASET, "graphSha256": GRAPH, "staticRevision": STATIC,
        "candidateSha256": sha(work / "candidates.json.gz"), "baselineSha256": BASELINE,
        "dynamicRevision": feed["dynamicRevision"], "departureLocal": departure,
        "finishedAt": datetime.now(ZoneInfo("Europe/Prague")).isoformat(),
        "snapshotStillValid": valid, "baselineAppliedEdgeCount": baseline_applied,
        "candidateAppliedFlowCount": candidate_flows, "candidateAppliedEdgeCount": len(candidate_speeds),
        "testedForwardRouteCount": len(forward), "forwardRoutesUsingNewEdges": forward_pass,
        "forwardTimeChanges": changed, "nonVehicleControlsPassed": controls_pass,
        "forwardRoutesUsingTargetEdges": target_pass, "actorVersion": status["version"],
        "unaffectedControlsPassed": unaffected_pass, "automatedPilotPassed": passed,
        "geographicHumanReviewRequired": True, "pairs": pairs,
        "caveat": "Same-snapshot technical comparison only, not ETA accuracy or live authorization."}
    fd = os.open(results / "report.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(report, stream, separators=(",", ":"))
    return 0 if passed else 2


if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except Exception as error:
        # No input/coordinate/token values in diagnostics.
        print("Native isolated pilot refused:", type(error).__name__, file=__import__("sys").stderr)
        raise SystemExit(1)
