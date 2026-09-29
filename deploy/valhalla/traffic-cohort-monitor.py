#!/usr/bin/env python3
"""Bounded aggregate-only comparison of TPEG2 baseline and candidate freshness.

This process never edits Valhalla, its traffic archive, provider cache or source
records. Only numeric cohort summaries are written to the protected report.
"""

from __future__ import annotations

import gzip
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time
from typing import Any


RELEASE = "/srv/valhalla/releases/20260929T081714Z/custom_files"
DATASET = "sim-routing-2026-09-29-1790679143"
AUDIT = Path("/home/voldzi/valhalla-owned-deploy/route-audit-v3-20260929.json.gz")
AUDIT_SHA256 = "57baa0a37d97d24389ba27c28356a6367b6be5564614e9d7553db3ce1ad8911e"
TRAFFIC = Path("/srv/valhalla/update-tools/traffic-update.py")
ENV = Path("/srv/valhalla/.traffic.env")
REPORT = Path("/srv/valhalla/state/traffic-cohort-monitor-20260929.json")
DURATION_SECONDS = 780
INTERVAL_SECONDS = 30


def load_traffic() -> Any:
    spec = importlib.util.spec_from_file_location("traffic_update_monitor", TRAFFIC)
    if spec is None or spec.loader is None:
        raise RuntimeError("traffic updater module cannot be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def median(values: list[float]) -> int | None:
    return round(statistics.median(values)) if values else None


def cohort_summary(flows: list[Any], ids: set[str], traffic: Any,
                   max_age_seconds: int, now: float) -> dict[str, int | None]:
    counts: dict[str, int | None] = {
        "recordCount": 0, "uniqueMessageCount": 0, "duplicateRecords": 0,
        "validSpeedCount": 0, "freshCount": 0, "expiredCount": 0,
        "expiredWithin5MinutesCount": 0, "expiredWithin30MinutesCount": 0,
        "expiredOver30MinutesCount": 0, "expiryBeforeObservationCount": 0,
        "staleObservationCount": 0, "futureObservationCount": 0,
        "invalidObservationCount": 0, "invalidExpiryCount": 0,
        "missingExpiryCount": 0, "invalidSpeedCount": 0,
        "expiredAgeSecondsMedian": None, "observedAgeSecondsMedian": None,
        "freshRemainingSecondsMedian": None,
    }
    seen: set[str] = set()
    expiry_ages: list[float] = []
    observed_ages: list[float] = []
    remaining: list[float] = []
    for flow in flows:
        if not isinstance(flow, dict):
            continue
        message_id = str(flow.get("messageId", ""))
        if message_id not in ids:
            continue
        counts["recordCount"] += 1
        if message_id in seen:
            counts["duplicateRecords"] += 1
        seen.add(message_id)
        try:
            speed = float(flow["averageSpeedKph"])
        except (KeyError, TypeError, ValueError):
            counts["invalidSpeedCount"] += 1
            continue
        if not math.isfinite(speed) or speed <= 0:
            counts["invalidSpeedCount"] += 1
            continue
        counts["validSpeedCount"] += 1
        observed = traffic.parse_iso_timestamp(flow.get("observedAt"))
        expiry_value = flow.get("validUntil")
        expiry = traffic.parse_iso_timestamp(expiry_value)
        if observed is None:
            counts["invalidObservationCount"] += 1
            continue
        observed_ages.append(now - observed)
        if expiry_value is None:
            counts["missingExpiryCount"] += 1
        elif expiry is None:
            counts["invalidExpiryCount"] += 1
            continue
        elif expiry < observed:
            counts["expiryBeforeObservationCount"] += 1
        if observed > now:
            counts["futureObservationCount"] += 1
        elif now - observed > max_age_seconds:
            counts["staleObservationCount"] += 1
        elif expiry is not None and expiry < now:
            counts["expiredCount"] += 1
            age = now - expiry
            expiry_ages.append(age)
            if age <= 300:
                counts["expiredWithin5MinutesCount"] += 1
            elif age <= 1800:
                counts["expiredWithin30MinutesCount"] += 1
            else:
                counts["expiredOver30MinutesCount"] += 1
        else:
            counts["freshCount"] += 1
            if expiry is not None:
                remaining.append(expiry - now)
    counts["uniqueMessageCount"] = len(seen)
    counts["expiredAgeSecondsMedian"] = median(expiry_ages)
    counts["observedAgeSecondsMedian"] = median(observed_ages)
    counts["freshRemainingSecondsMedian"] = median(remaining)
    return counts


def write_report(report: dict[str, Any]) -> None:
    temporary = REPORT.with_suffix(".json.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        json.dump(report, stream, sort_keys=True, separators=(",", ":"))
        stream.write("\n")
    os.chmod(temporary, 0o600)
    os.replace(temporary, REPORT)


def run() -> int:
    if os.geteuid() != 0:
        raise RuntimeError("protected feed and audit require the approved root-run unit")
    if Path("/srv/valhalla/current").resolve().as_posix() != RELEASE:
        raise RuntimeError("active routing graph differs from the audited release")
    if subprocess.run(["systemctl", "show", "valhalla-weekly-update.service", "-p", "ActiveState", "--value"],
                      capture_output=True, text=True, check=True).stdout.strip() != "inactive":
        raise RuntimeError("weekly graph update is active")
    if subprocess.run(["docker", "inspect", "--format", "{{.State.Running}}", "valhalla"],
                      capture_output=True, text=True, check=True).stdout.strip() != "true":
        raise RuntimeError("ordinary Valhalla is not running")
    if Path("/run/valhalla-traffic-canary/active").exists():
        raise RuntimeError("an isolated Valhalla canary is active")
    with AUDIT.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != AUDIT_SHA256:
            raise RuntimeError("candidate audit changed")
    audit = json.load(gzip.open(AUDIT, "rt", encoding="utf-8"))
    if (audit.get("routingDataset") != DATASET or len(audit.get("mapping", {})) != 5286 or
        audit.get("baselineMappedSegmentCount") != 35639):
        raise RuntimeError("candidate audit does not match the reviewed map")
    traffic = load_traffic()
    config = traffic.load_env(ENV)
    url = config.get("VALHALLA_URL", "http://192.168.10.134:8002")
    if traffic.routing_dataset(url) != DATASET:
        raise RuntimeError("serving graph changed")
    baseline_path = traffic.mapping_path(
        Path(config.get("TRAFFIC_MAPPING_CACHE_DIR", "/srv/valhalla/traffic-cache")),
        DATASET, audit["staticRevision"], traffic.MATCHER_VERSION,
    )
    baseline = traffic.read_gzip_json(baseline_path)
    if (baseline.get("routingDataset") != DATASET or
        baseline.get("staticRevision") != audit["staticRevision"] or
        baseline.get("matcherVersion") != traffic.MATCHER_VERSION or
        len(baseline.get("mapping", {})) != 35639):
        raise RuntimeError("baseline map does not match the audited source")
    candidate_ids = set(audit["mapping"])
    baseline_ids = set(baseline["mapping"])
    if candidate_ids & baseline_ids:
        raise RuntimeError("candidate and baseline cohorts are not disjoint")
    feed_url = traffic.required(config, "SIM_TRAFFIC_FEED_BASE_URL").rstrip("/")
    token = traffic.required(config, "SIM_TRAFFIC_CONTROL_TOKEN")
    report: dict[str, Any] = {
        "contractVersion": "valhalla-traffic-cohort-monitor-v1",
        "routingDataset": DATASET,
        "baselineStaticReferenceCount": len(baseline_ids),
        "candidateStaticReferenceCount": len(candidate_ids),
        "intervalSeconds": INTERVAL_SECONDS,
        "durationSeconds": DURATION_SECONDS,
        "status": "running", "samples": [],
        "note": "Aggregate feed quality only; not evidence of ETA accuracy.",
    }
    started = time.monotonic()
    previous_revision: str | None = None
    while True:
        now = time.time()
        if Path("/srv/valhalla/current").resolve().as_posix() != RELEASE:
            raise RuntimeError("routing graph changed during cohort observation")
        try:
            status, feed = traffic.request_json(f"{feed_url}/feed", token=token, timeout=20)
        except (OSError, RuntimeError, TimeoutError) as error:
            raise RuntimeError("authenticated SIM feed request failed") from error
        if status != 200 or not isinstance(feed, dict):
            raise RuntimeError("active authenticated SIM traffic feed is unavailable")
        if feed.get("staticRevision") != audit["staticRevision"]:
            raise RuntimeError("static feed revision changed during cohort observation")
        flows = feed.get("flows")
        if not isinstance(flows, list):
            raise RuntimeError("dynamic feed shape changed")
        revision = str(feed.get("dynamicRevision", ""))
        if not revision:
            raise RuntimeError("dynamic feed revision is missing")
        generated = traffic.parse_iso_timestamp(feed.get("generatedAt"))
        max_age = int(feed.get("maxAgeSeconds", 1800))
        sample = {
            "sampledAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
            "simRefreshAgeSeconds": round(now - generated) if generated is not None else None,
            "newDynamicRevision": previous_revision is not None and revision != previous_revision,
            "totalFlowRecords": len(flows),
            "baseline": cohort_summary(flows, baseline_ids, traffic, max_age, now),
            "candidate": cohort_summary(flows, candidate_ids, traffic, max_age, now),
        }
        report["samples"].append(sample)
        previous_revision = revision
        write_report(report)
        print(json.dumps({"sample": len(report["samples"]), "newDynamicRevision": sample["newDynamicRevision"],
                          "baselineFresh": sample["baseline"]["freshCount"],
                          "candidateFresh": sample["candidate"]["freshCount"]}, sort_keys=True), flush=True)
        remaining = DURATION_SECONDS - (time.monotonic() - started)
        if remaining <= 0:
            break
        time.sleep(min(INTERVAL_SECONDS, remaining))
    report["status"] = "complete"
    report["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    write_report(report)
    print(json.dumps({"status": "complete", "sampleCount": len(report["samples"]),
                      "candidateEverFresh": any(s["candidate"]["freshCount"] > 0 for s in report["samples"]),
                      "revisionTransitionCount": sum(s["newDynamicRevision"] for s in report["samples"])},
                     sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(run())
    except Exception as error:
        print(f"Aggregate cohort observation stopped: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
