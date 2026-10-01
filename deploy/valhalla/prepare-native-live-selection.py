#!/usr/bin/env python3
"""Root/operator acceptance of ONLY same-shape forward routes tested in canary.

Requires real geographic review explicitly confirmed by the operator, not by an
automated flag or by this tool. Does not itself change the runtime/configuration.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path

WORK = Path("/home/voldzi/valhalla-owned-deploy/native-canary-v2-20261001")
RELEASE = Path("/srv/valhalla/releases/20260929T081714Z/custom_files")


def accepted_ids(report, candidate, candidate_hash):
    if (report.get("contractVersion") != "sim-native-same-flow-canary-v1" or
            report.get("actorVersion") != "3.8.3" or
            report.get("approvedForLive") is not False or report.get("automatedPilotPassed") is not True or
            report.get("snapshotStillValid") is not True or report.get("nonVehicleControlsPassed") is not True or
            report.get("unaffectedControlsPassed") is not True or report.get("geographicHumanReviewRequired") is not True or
            report.get("candidateSha256") != candidate_hash or
            any(report.get(k) != candidate.get(k) for k in ("routingDataset", "staticRevision", "graphSha256", "baselineSha256")) or
            not isinstance(report.get("pairs"), list) or len(report["pairs"]) > 34):
        raise ValueError("Unaccepted or inconsistent canary proof")
    ids = set()
    for pair in report["pairs"]:
        if pair.get("kind") != "forward":
            continue
        if (pair.get("candidateTargetEdgeCount") == 0 or pair.get("shapeChanged") is True):
            continue  # A neighbour's new edge is not proof for this reference.
        if (pair.get("paired") is not True or pair.get("shapeChanged") is not False or
                pair.get("baseline", {}).get("status") != "ok" or pair.get("candidate", {}).get("status") != "ok" or
                type(pair.get("candidateNewEdgeCount")) is not int or pair["candidateNewEdgeCount"] < 1 or
                type(pair.get("candidateTargetEdgeCount")) is not int or pair["candidateTargetEdgeCount"] < 1 or
                pair.get("reference") not in candidate["mapping"] or pair["reference"] in ids):
            raise ValueError("Forward route acceptance incomplete")
        ids.add(pair["reference"])
    if not 4 <= len(ids) <= 16 or len(ids) != report.get("forwardRoutesUsingTargetEdges"):
        raise ValueError("Canary tested cohort bounds")
    return ids


def run(args):
    if not args.geographic_review_confirmed:
        raise ValueError("Operator geographic review must be confirmed separately")
    if os.geteuid() != 0 or Path("/srv/valhalla/current").resolve() != RELEASE:
        raise ValueError("Exact active graph and root/operator are required")
    spec = importlib.util.spec_from_file_location("native_pilot", WORK / "native-canary-ab.py")
    pilot = importlib.util.module_from_spec(spec); spec.loader.exec_module(pilot)
    candidate, baseline, static = [pilot.load(WORK / n) for n in ("candidates.json.gz", "baseline.json.gz", "static.json.gz")]
    report_path = WORK / "results-20261001T192501Z/report.json"
    if report_path.stat().st_size > 1024 * 1024:
        raise ValueError("Canary proof size bound")
    report = json.loads(report_path.read_text())
    if pilot.sha(report_path) != "faa70eef659aaf91029e41b2c2fcdac65bead2c14a99a07447b3c5aada714d70":
        raise ValueError("Recorded canary proof changed")
    # Validate the same audited artifacts with a synthetic empty dynamic feed;
    # no token/provider access is needed to accept a previously executed test.
    pilot.validate(candidate, baseline, static, {"contractVersion": "sim-valhalla-live-traffic-feed-v1",
        "staticRevision": pilot.STATIC, "flows": [], "maxAgeSeconds": 1800}, pilot.sha(WORK / "baseline.json.gz"))
    candidate_hash = pilot.sha(WORK / "candidates.json.gz")
    if candidate_hash != "5d6b5799178391ad04a5b37a16ce69dc9b6e1db7554ee02e14c302ce917b0029":
        raise ValueError("Candidate audit changed")
    ids = accepted_ids(report, candidate, candidate_hash)
    graph = RELEASE / "valhalla_tiles.tar"
    if pilot.sha(graph) != pilot.GRAPH:
        raise ValueError("Active graph hash differs from reviewed graph")
    baseline_path = Path("/srv/valhalla/traffic-cache/openlr-edge-map-b5a745f4aa6fe487b64b.json.gz")
    if pilot.sha(baseline_path) != pilot.BASELINE:
        raise ValueError("Active baseline changed")
    st = graph.stat()
    value = {"contractVersion": "sim-native-reviewed-live-map-v1", "approvedForLive": True,
        "geographicAttestation": "operator-geographic-review-v1", "routingDataset": pilot.DATASET,
        "staticRevision": pilot.STATIC, "releaseTarget": str(RELEASE), "graphSha256": pilot.GRAPH,
        "graphIdentity": {"device": st.st_dev, "inode": st.st_ino, "size": st.st_size,
                          "mtimeNs": st.st_mtime_ns, "ctimeNs": st.st_ctime_ns},
        "baselineSha256": pilot.BASELINE, "candidateSha256": candidate_hash,
        "canarySha256": pilot.sha(report_path), "acceptedAt": datetime.now(timezone.utc).isoformat(),
        "mapping": {ident: candidate["mapping"][ident] for ident in sorted(ids)}}
    raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    fingerprint = hashlib.sha256(raw).hexdigest()[:20]
    output = Path(f"/srv/valhalla/traffic-cache/native-reviewed-{fingerprint}.json")
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream: stream.write(raw)
    print(str(output))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--geographic-review-confirmed", action="store_true")
    run(parser.parse_args())
