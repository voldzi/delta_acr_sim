#!/usr/bin/env python3
"""One-shot pilot A/B traffic test; never edits the serving traffic archive.

The systemd unit owns the lifecycle. A separate ExecStopPost rollback script
restores the ordinary Valhalla container if this process is interrupted.
"""

from __future__ import annotations

import gzip
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import sys
import time
from typing import Any


RELEASE = "/srv/valhalla/releases/20260929T081714Z/custom_files"
DATASET = "sim-routing-2026-09-29-1790679143"
AUDIT = Path("/home/voldzi/valhalla-owned-deploy/route-audit-v3-20260929.json.gz")
SHADOW = Path("/srv/valhalla/update-tools/traffic-shadow-audit-v3-20260929.py")
RUNTIME = Path("/run/valhalla-traffic")
CANARY = Path("/run/valhalla-traffic-canary")
MARKER = CANARY / "active"
ROLLBACK = "/srv/valhalla/update-tools/traffic-canary-rollback.sh"
RESULT = Path("/srv/valhalla/state/traffic-canary-ab-20260929.json")
CONTAINER = "valhalla-traffic-canary"
AUDIT_SHA256 = "57baa0a37d97d24389ba27c28356a6367b6be5564614e9d7553db3ce1ad8911e"
SHADOW_SHA256 = "51ce64bfe9bc8d45f0fb0f82318a84da3b068093412be692c99dae3c84e40592"


def command(*args: str, timeout: int = 60) -> str:
    return subprocess.run(args, check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()


def load_traffic_module() -> Any:
    spec = importlib.util.spec_from_file_location("traffic_shadow_audit", SHADOW)
    if spec is None or spec.loader is None:
        raise RuntimeError("shadow audit module cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verified_sha256(path: Path, expected: str) -> None:
    with path.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != expected:
        raise RuntimeError(f"verified input changed: {path.name}")


def route_request(segment: dict[str, Any]) -> dict[str, Any] | None:
    points = (segment.get("openlr") or {}).get("points") or []
    coordinates = segment.get("coordinates") or []
    if len(points) != 2 or len(coordinates) != 2:
        return None
    try:
        first = float(points[0]["bearing"]) * 360 / 256
        last = (float(points[1]["bearing"]) * 360 / 256 + 180) % 360
        locations = [
            {"lon": float(coordinates[index][0]), "lat": float(coordinates[index][1]),
             "radius": 20, "search_cutoff": 20, "heading": heading, "heading_tolerance": 34}
            for index, heading in enumerate((first, last))
        ]
    except (IndexError, KeyError, TypeError, ValueError, OverflowError):
        return None
    if not all(math.isfinite(float(value)) for location in locations for value in location.values()):
        return None
    return {"locations": locations, "costing": "auto", "date_time": {"type": 0}, "directions_type": "none"}


def select_requests(static_feed: dict[str, Any], dynamic_feed: dict[str, Any], audit: dict[str, Any], traffic: Any) -> list[dict[str, Any]]:
    now = time.time()
    candidate_ids = set(audit["mapping"])
    fresh_ids: set[str] = set()
    for flow in dynamic_feed.get("flows", []):
        if not isinstance(flow, dict):
            continue
        message_id = str(flow.get("messageId", ""))
        observed = traffic.parse_iso_timestamp(flow.get("observedAt"))
        valid_until = traffic.parse_iso_timestamp(flow.get("validUntil"))
        if (message_id in candidate_ids and observed is not None and
            0 <= now - observed <= 1800 and (valid_until is None or valid_until >= now)):
            fresh_ids.add(message_id)
    by_class: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for segment in static_feed.get("segments", []):
        message_id = str(segment.get("messageId", ""))
        if message_id not in fresh_ids:
            continue
        payload = route_request(segment)
        if payload is None:
            continue
        road_class = str(segment["openlr"]["points"][0].get("frc", "unknown"))
        by_class.setdefault(road_class, []).append((message_id, payload))
    requests: list[dict[str, Any]] = []
    for road_class in sorted(by_class):
        group = sorted(by_class[road_class], key=lambda item: item[0])
        count = min(2, len(group))
        for index in range(count):
            requests.append(group[(index * len(group)) // count][1])
    return requests[:16]


def flow_diagnostics(feed: dict[str, Any], audit: dict[str, Any], traffic: Any,
                     max_age_seconds: int, *, now: float | None = None) -> dict[str, int]:
    """Count candidate-flow rejection reasons without exposing licensed records."""
    instant = time.time() if now is None else now
    candidate_ids = set(audit["mapping"])
    counts = {
        "totalFlowRecords": 0,
        "candidateIdRecords": 0,
        "candidateValidSpeedRecords": 0,
        "candidateFreshRecords": 0,
        "candidateInvalidSpeedRecords": 0,
        "candidateInvalidObservedAtRecords": 0,
        "candidateFutureRecords": 0,
        "candidateStaleRecords": 0,
        "candidateExpiredRecords": 0,
        "candidateExpiryBeforeObservationRecords": 0,
        "candidateExpiredWithin5MinutesRecords": 0,
        "candidateExpiredWithin30MinutesRecords": 0,
        "candidateExpiredOver30MinutesRecords": 0,
    }
    for flow in feed.get("flows", []):
        if not isinstance(flow, dict):
            continue
        counts["totalFlowRecords"] += 1
        if str(flow.get("messageId", "")) not in candidate_ids:
            continue
        counts["candidateIdRecords"] += 1
        try:
            speed = float(flow["averageSpeedKph"])
        except (KeyError, TypeError, ValueError):
            counts["candidateInvalidSpeedRecords"] += 1
            continue
        if not math.isfinite(speed) or speed <= 0:
            counts["candidateInvalidSpeedRecords"] += 1
            continue
        counts["candidateValidSpeedRecords"] += 1
        observed = traffic.parse_iso_timestamp(flow.get("observedAt"))
        valid_until = traffic.parse_iso_timestamp(flow.get("validUntil"))
        if observed is None:
            counts["candidateInvalidObservedAtRecords"] += 1
        elif observed > instant:
            counts["candidateFutureRecords"] += 1
        elif instant - observed > max_age_seconds:
            counts["candidateStaleRecords"] += 1
        elif valid_until is not None and valid_until < instant:
            counts["candidateExpiredRecords"] += 1
            if valid_until < observed:
                counts["candidateExpiryBeforeObservationRecords"] += 1
            expiry_age = instant - valid_until
            if expiry_age <= 300:
                counts["candidateExpiredWithin5MinutesRecords"] += 1
            elif expiry_age <= 1800:
                counts["candidateExpiredWithin30MinutesRecords"] += 1
            else:
                counts["candidateExpiredOver30MinutesRecords"] += 1
        else:
            counts["candidateFreshRecords"] += 1
    return counts


def route_summary(body: Any) -> dict[str, Any] | None:
    if not isinstance(body, dict):
        return None
    trip = body.get("trip") or {}
    summary = trip.get("summary") or {}
    legs = trip.get("legs") or []
    try:
        duration = float(summary["time"])
        distance = float(summary["length"])
        shape = str(legs[0]["shape"])
    except (IndexError, KeyError, TypeError, ValueError):
        return None
    if not math.isfinite(duration) or not math.isfinite(distance) or not shape:
        return None
    return {"time": duration, "length": distance, "shape": shape}


def measure_baseline(traffic: Any, url: str, requests: list[dict[str, Any]]) -> list[dict[str, Any] | None]:
    results: list[dict[str, Any] | None] = []
    for payload in requests:
        try:
            status, body = traffic.request_json(f"{url.rstrip('/')}/route", payload=payload, timeout=20)
            results.append(route_summary(body) if status == 200 else None)
        except (OSError, RuntimeError, TimeoutError):
            results.append(None)
    return results


def measure_canary(requests: list[dict[str, Any]]) -> list[dict[str, Any] | None]:
    results: list[dict[str, Any] | None] = []
    for payload in requests:
        try:
            completed = subprocess.run(
                ["docker", "exec", "-i", CONTAINER, "curl", "-fsS", "--max-time", "20",
                 "-H", "Content-Type: application/json", "--data-binary", "@-",
                 "http://127.0.0.1:8002/route"],
                input=json.dumps(payload, separators=(",", ":")),
                capture_output=True, text=True, check=True, timeout=25,
            )
            results.append(route_summary(json.loads(completed.stdout)))
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError):
            results.append(None)
    return results


def comparison(baseline: list[dict[str, Any] | None], canary: list[dict[str, Any] | None]) -> dict[str, Any]:
    pairs = [(left, right) for left, right in zip(baseline, canary) if left and right]
    deltas = [right["time"] - left["time"] for left, right in pairs]
    return {
        "requestedRouteCount": len(baseline),
        "pairedRouteCount": len(pairs),
        "baselineFailureCount": sum(item is None for item in baseline),
        "canaryFailureCount": sum(item is None for item in canary),
        "changedEtaCount": sum(abs(delta) >= 1 for delta in deltas),
        "changedGeometryCount": sum(left["shape"] != right["shape"] for left, right in pairs),
        "medianEtaDeltaSeconds": round(statistics.median(deltas), 2) if deltas else None,
        "minEtaDeltaSeconds": round(min(deltas), 2) if deltas else None,
        "maxEtaDeltaSeconds": round(max(deltas), 2) if deltas else None,
    }


def wait_for_status(traffic: Any, url: str, *, container: bool = False, seconds: int = 150) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if container:
                body = command("docker", "exec", CONTAINER, "curl", "-fsS", "--max-time", "5",
                               "http://127.0.0.1:8002/status", timeout=8)
                status = json.loads(body)
            else:
                _, status = traffic.request_json(f"{url.rstrip('/')}/status", timeout=5)
            if isinstance(status, dict) and status.get("tileset_last_modified") == 1790679143:
                return
        except (OSError, RuntimeError, TimeoutError, subprocess.CalledProcessError,
                subprocess.TimeoutExpired, ValueError):
            pass
        time.sleep(3)
    raise RuntimeError("Valhalla did not become ready with the expected graph")


def prepare(traffic: Any, config: dict[str, str], audit: dict[str, Any], url: str) -> tuple[list[dict[str, Any]], int, str]:
    feed_url = traffic.required(config, "SIM_TRAFFIC_FEED_BASE_URL").rstrip("/")
    token = traffic.required(config, "SIM_TRAFFIC_CONTROL_TOKEN")
    status, feed = traffic.request_json(f"{feed_url}/feed", token=token)
    static_status, static_feed = traffic.request_json(f"{feed_url}/feed?includeStatic=true", token=token)
    if status != 200 or static_status != 200 or not isinstance(feed, dict) or not isinstance(static_feed, dict):
        raise RuntimeError("active SIM traffic lease and static feed are required")
    dataset = traffic.routing_dataset(url)
    revision = str(feed.get("staticRevision", ""))
    dynamic = str(feed.get("dynamicRevision", ""))
    if (dataset != DATASET or audit.get("matcherVersion") != traffic.ROUTE_MATCHER_VERSION or
        audit.get("routingDataset") != dataset or audit.get("staticRevision") != revision or
        static_feed.get("staticRevision") != revision or static_feed.get("dynamicRevision") != dynamic):
        raise RuntimeError("audit, active graph, static feed or dynamic feed revision mismatch")
    report = json.loads((RUNTIME / "last-applied.json").read_text(encoding="utf-8"))
    if (report.get("routingDataset") != dataset or report.get("staticRevision") != revision or
        report.get("dynamicRevision") != dynamic):
        raise RuntimeError("live traffic archive and SIM feed are not the same revision")
    applied_at = float(report.get("appliedAtEpoch") or 0)
    if applied_at <= 0 or time.time() - applied_at > 600:
        raise RuntimeError("live traffic archive was not refreshed recently enough for A/B comparison")
    active_edges = set(traffic.read_previous_edges(RUNTIME / "applied-edges.json"))
    candidate_list = [int(edge["id"]) for edges in audit["mapping"].values() for edge in edges]
    candidate_edges = set(candidate_list)
    if len(candidate_edges) != len(candidate_list):
        raise RuntimeError("candidate edge ownership is not unique")
    if candidate_edges & active_edges:
        raise RuntimeError("candidate edges overlap the active baseline traffic archive")
    max_age_seconds = int(feed.get("maxAgeSeconds", 1800))
    diagnostics = flow_diagnostics(feed, audit, traffic, max_age_seconds)
    print(json.dumps({"pilotFlowDiagnostics": diagnostics}, sort_keys=True), flush=True)
    speeds, flow_count, _ = traffic.current_edge_speeds(feed, audit, max_age_seconds)
    if not speeds or flow_count <= 0 or diagnostics["candidateFreshRecords"] == 0:
        raise RuntimeError("no fresh candidate flows are available; see aggregate flow diagnostics")
    requests = select_requests(static_feed, feed, audit, traffic)
    if len(requests) < 4:
        raise RuntimeError("not enough fresh, geographically stratified candidate routes")
    shutil.copyfile(RUNTIME / "traffic.tar", CANARY / "traffic.tar")
    os.chmod(CANARY / "traffic.tar", 0o600)
    applied = traffic.apply_speeds(CANARY / "traffic.tar", CANARY / "applied-edges.json", speeds)
    if applied <= 0:
        raise RuntimeError("candidate speeds did not fit the active traffic archive")
    return requests, applied, dynamic


def run(*, diagnose_flows: bool = False) -> int:
    if os.geteuid() != 0:
        raise RuntimeError("this isolated pilot test requires root to preserve automatic rollback")
    if Path("/srv/valhalla/current").resolve().as_posix() != RELEASE:
        raise RuntimeError("active graph differs from the audited 29 September release")
    if command("systemctl", "show", "valhalla-weekly-update.service", "-p", "ActiveState", "--value") != "inactive":
        raise RuntimeError("weekly graph update is active")
    if command("systemctl", "show", "valhalla-traffic-update.timer", "-p", "ActiveState", "--value") != "active":
        raise RuntimeError("ordinary traffic timer is not active")
    if command("docker", "inspect", "--format", "{{.State.Running}}", "valhalla") != "true":
        raise RuntimeError("ordinary Valhalla container is not running")
    if MARKER.exists():
        raise RuntimeError("previous canary recovery marker exists")
    CANARY.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(CANARY, 0o700)
    verified_sha256(SHADOW, SHADOW_SHA256)
    verified_sha256(AUDIT, AUDIT_SHA256)
    traffic = load_traffic_module()
    config = traffic.load_env(Path("/srv/valhalla/.traffic.env"))
    url = config.get("VALHALLA_URL", "http://192.168.10.134:8002")
    audit = json.load(gzip.open(AUDIT, "rt", encoding="utf-8"))
    if (len(audit.get("mapping", {})) != 5286 or audit.get("baselineMappedSegmentCount") != 35639 or
        audit.get("sourceSegmentCount") != 55150 or
        sum(audit.get("rejectionCounts", {}).values()) != 14225):
        raise RuntimeError("audit candidate count or baseline differs from the reviewed report")
    image = command("docker", "inspect", "--format", "{{.Config.Image}}", "valhalla")
    if not image.startswith("ghcr.io/valhalla/valhalla-scripted:3.8.3@sha256:"):
        raise RuntimeError("unexpected Valhalla image")
    wait_for_status(traffic, url)
    if diagnose_flows:
        feed_url = traffic.required(config, "SIM_TRAFFIC_FEED_BASE_URL").rstrip("/")
        token = traffic.required(config, "SIM_TRAFFIC_CONTROL_TOKEN")
        status, feed = traffic.request_json(f"{feed_url}/feed", token=token)
        if status != 200 or not isinstance(feed, dict):
            raise RuntimeError("active SIM traffic feed is unavailable")
        if (traffic.routing_dataset(url) != DATASET or
            feed.get("staticRevision") != audit.get("staticRevision")):
            raise RuntimeError("feed, audit or routing graph revision mismatch")
        diagnostics = flow_diagnostics(feed, audit, traffic, int(feed.get("maxAgeSeconds", 1800)))
        print(json.dumps({"pilotFlowDiagnostics": diagnostics}, sort_keys=True), flush=True)
        return 0
    MARKER.touch(mode=0o600, exist_ok=False)
    os.chmod(MARKER, 0o600)
    try:
        command("systemctl", "stop", "valhalla-traffic-update.timer", "valhalla-traffic-update.service", timeout=90)
        requests, applied, dynamic = prepare(traffic, config, audit, url)
        baseline = measure_baseline(traffic, url, requests)
        if sum(item is not None for item in baseline) < 4:
            raise RuntimeError("insufficient baseline routes; no service swap performed")
        command("docker", "stop", "valhalla", timeout=45)
        command(
            "docker", "run", "--detach", "--rm", "--network", "none", "--memory", "6g",
            "--name", CONTAINER,
            "--volume", "/srv/valhalla/current:/custom_files:ro",
            "--volume", f"{CANARY}:/traffic",
            "--volume", "/srv/valhalla/update-tools/runtime-entrypoint.sh:/usr/local/bin/valhalla-runtime-entrypoint:ro",
            "--entrypoint", "/usr/local/bin/valhalla-runtime-entrypoint",
            image, "/custom_files/valhalla.json", "2", timeout=45,
        )
        wait_for_status(traffic, url, container=True)
        candidate = measure_canary(requests)
        report = {
            "contractVersion": "valhalla-traffic-pilot-ab-v1",
            "routingDataset": DATASET,
            "matcherVersion": audit["matcherVersion"],
            "dynamicRevision": dynamic,
            "baselineMappedSegmentCount": 35639,
            "candidateMappedSegmentCount": 5286,
            "candidateAppliedEdgeCount": applied,
            "comparison": comparison(baseline, candidate),
            "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "note": "Pilot route differences only; observed travel-time accuracy is not established.",
        }
    finally:
        command(ROLLBACK, timeout=210)
    RESULT.write_text(json.dumps(report, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(RESULT, 0o600)
    print(json.dumps(report, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    try:
        if len(sys.argv) > 2 or (len(sys.argv) == 2 and sys.argv[1] != "--diagnose-flows"):
            raise RuntimeError("usage: traffic-canary-ab.py [--diagnose-flows]")
        raise SystemExit(run(diagnose_flows=len(sys.argv) == 2))
    except Exception as error:
        print(f"Pilot A/B test failed safely: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
