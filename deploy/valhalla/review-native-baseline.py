#!/usr/bin/env python3
"""Offline baseline ownership gate. Never approves or changes live mapping.

Every active edge claim blocks a new candidate, even a native partial interval.
Previously mapped references stay untouched. All stdout is aggregate only.
"""
import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import math
from pathlib import Path

spec = importlib.util.spec_from_file_location("independent_direction_review", Path(__file__).with_name("review-native-directions.py"))
directions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(directions)


def edge_id(value):
    if type(value) is not int or not 0 <= value < 2**46 or (value & 7) > 2:
        raise ValueError("Invalid directed road edge")
    return value


def gate(audit, baseline, review, audit_hash, baseline_hash):
    if (audit.get("contractVersion") != "sim-openlr-native-audit-v1" or
            audit.get("decoderVersion") != "openlr-native-v2" or audit.get("approvedForLive") is not False or
            baseline.get("contractVersion") != "valhalla-openlr-edge-map-v2" or
            baseline.get("matcherVersion") != "openlr-trace-v2" or
            review.get("contractVersion") != "sim-native-direction-review-v1" or review.get("approvedForLive") is not False or
            review.get("nativeAuditSha256") != audit_hash):
        raise ValueError("Baseline gate artifact identity mismatch")
    for key in ("routingDataset", "staticRevision"):
        if not audit.get(key) or audit[key] != baseline.get(key) or audit[key] != review.get(key):
            raise ValueError("Baseline gate graph/static mismatch")
    for key in ("graphSha256", "tmcSha256"):
        if not audit.get(key) or audit[key] != review.get(key):
            raise ValueError("Baseline gate directed review mismatch")
    if (not isinstance(baseline.get("mapping"), dict) or
            baseline.get("mappedSegmentCount") != len(baseline["mapping"]) or
            not isinstance(audit.get("mapping"), dict) or not isinstance(audit.get("intervalCandidates"), dict) or
            audit.get("wholeEdgeCandidateReferenceCount") != len(audit["mapping"]) or
            audit.get("matchedIntervalReferenceCount") != len(audit["intervalCandidates"]) or
            not isinstance(review.get("verdicts"), dict) or len(audit["intervalCandidates"]) > 100000 or
            set(review["verdicts"]) != set(audit["intervalCandidates"])):
        raise ValueError("Baseline gate incomplete reference set")
    owned = set()
    for ident, path in baseline["mapping"].items():
        if not isinstance(ident, str) or not ident or not isinstance(path, list) or not path:
            raise ValueError("Invalid active mapping")
        for item in path:
            if not isinstance(item, dict) or "id" not in item:
                raise ValueError("Invalid active edge claim")
            owned.add(edge_id(item["id"]))
    counts, candidates = Counter(), {}
    for ident, path in audit["intervalCandidates"].items():
        if not isinstance(path, list) or not 1 <= len(path) <= 1024:
            raise ValueError("Invalid candidate interval set")
        claims, full = set(), []
        for item in path:
            if not isinstance(item, dict) or set(item) != {"edgeId", "beginFraction", "endFraction", "edgeLengthMeters"}:
                raise ValueError("Invalid candidate interval")
            ident_edge = edge_id(item["edgeId"])
            begin, end = item["beginFraction"], item["endFraction"]
            if (type(begin) not in (float, int) or type(end) not in (float, int) or not 0 <= begin < end <= 1 or
                    type(item["edgeLengthMeters"]) not in (float, int) or
                    not math.isfinite(item["edgeLengthMeters"]) or item["edgeLengthMeters"] <= 0 or ident_edge in claims):
                raise ValueError("Invalid candidate interval extent")
            claims.add(ident_edge)
            if begin <= 1e-7 and end >= 1 - 1e-7:
                full.append(ident_edge)
        if ident in baseline["mapping"]:
            verdict = "already_active_reference"
        elif review["verdicts"][ident] != "independent_geometry_direction_pass":
            verdict = "independent_direction_not_passed"
        elif ident not in audit["mapping"]:
            verdict = "native_collision_or_no_whole_edge"
        elif claims & owned:
            verdict = "active_edge_overlap"
        else:
            if (not isinstance(audit["mapping"][ident], list) or
                    any(not isinstance(item, dict) or set(item) != {"id"} for item in audit["mapping"][ident])):
                raise ValueError("Candidate whole-edge structure mismatch")
            reported = [edge_id(item["id"]) for item in audit["mapping"][ident]]
            if not full or full != reported:
                raise ValueError("Candidate whole-edge identity mismatch")
            verdict = "isolated_canary_candidate"
            candidates[ident] = [{"id": item} for item in full]
        counts[verdict] += 1
    # Recompute rather than trust earlier collision diagnostics. A partial claim
    # by any candidate is still ownership, including a direction-rejected one.
    all_claims = {}
    for ident, path in audit["intervalCandidates"].items():
        for item in path:
            all_claims.setdefault(item["edgeId"], set()).add(ident)
    conflicts = {ident for owners in all_claims.values() if len(owners) > 1 for ident in owners} & set(candidates)
    for ident in conflicts:
        del candidates[ident]
        counts["isolated_canary_candidate"] -= 1
        counts["recomputed_candidate_overlap"] += 1
    summary = {"contractVersion": "sim-native-baseline-review-v1", "approvedForLive": False,
               "routingDataset": audit["routingDataset"], "staticRevision": audit["staticRevision"],
               "graphSha256": audit["graphSha256"], "tmcSha256": audit["tmcSha256"],
               "nativeAuditSha256": audit_hash, "baselineSha256": baseline_hash,
               "activeReferenceCount": len(baseline["mapping"]), "activeUniqueEdgeCount": len(owned),
               "reviewedReferenceCount": len(audit["intervalCandidates"]), "resultCounts": dict(sorted(counts.items())),
               "isolatedCandidateReferenceCount": len(candidates),
               "isolatedCandidateEdgeCount": sum(len(path) for path in candidates.values()),
               "caveat": "Conservative ownership and independent geometry gates only; isolated canary and operational acceptance are still required. No ETA accuracy claim."}
    return summary, candidates


def run(args):
    audit, baseline, review = map(directions.read_private, (args.audit, args.baseline, args.review))
    summary, candidates = gate(audit, baseline, review, hashlib.sha256(args.audit.read_bytes()).hexdigest(),
                               hashlib.sha256(args.baseline.read_bytes()).hexdigest())
    if args.output is not None:
        directions.write_private(args.output, {**summary, "mapping": candidates}, [args.audit, args.baseline, args.review])
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("audit", "baseline", "review"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--output", type=Path, help="Separate private canary-candidate artifact, never a live cache.")
    print(json.dumps(run(parser.parse_args()), sort_keys=True))
