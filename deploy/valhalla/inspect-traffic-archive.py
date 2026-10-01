#!/usr/bin/env python3
"""Read-only, aggregate physical-overlay inspection inside Valhalla.

Run on stdin with Python in the existing container. No IDs, records, token or
licensed map geometry leave the process. The shared lock prevents observation
of a half-written generation; no network operation is performed under it.
"""
import fcntl
import json
from pathlib import Path
import re
import struct
import tarfile
import time


def inspect(root: Path) -> dict:
    with (root / "update.lock").open("r") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH)
        revision = json.loads((root / "last-applied.json").read_text())
        ledger = json.loads((root / "applied-edges.json").read_text())
        if not isinstance(ledger, list) or any(type(value) is not int for value in ledger):
            raise ValueError("Invalid edge ledger")
        nonzero = records = tiles = 0
        with tarfile.open(root / "traffic.tar", "r:") as archive:
            for member in archive:
                # Valhalla extracts also contain index.bin; its words are tile
                # offsets, not speed records. Never count metadata as traffic.
                if not member.isfile() or not member.name.endswith(".gph"):
                    continue
                if member.size < 32 or (member.size - 32) % 8 or member.size > 64 * 1024 * 1024:
                    raise ValueError("Invalid traffic tile size")
                stream = archive.extractfile(member)
                if stream is None or len(stream.read(32)) != 32:
                    raise ValueError("Missing traffic header")
                remaining = member.size - 32
                while remaining:
                    payload = stream.read(min(remaining, 65536))
                    if not payload or len(payload) % 8:
                        raise ValueError("Incomplete traffic tile")
                    nonzero += sum(word != 0 for (word,) in struct.iter_unpack("<Q", payload))
                    records += len(payload) // 8
                    remaining -= len(payload)
                tiles += 1
        report = revision.get("report") or {}
        generation = report.get("overlayGeneration")
        result = {"contractVersion": "sim-traffic-physical-inspection-v1", "inspectedAtEpoch": time.time(),
                  "tileCount": tiles, "speedRecordCount": records, "nonzeroSpeedRecordCount": nonzero,
                  "ledgerEdgeCount": len(ledger), "ledgerMatchesPhysicalCount": len(ledger) == nonzero,
                  "reportStatus": report.get("status") if report.get("status") in ("current", "degraded") else "legacy",
                  "hasGeneration": isinstance(generation, str) and bool(re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", generation)),
                  "reportedAppliedEdgeCount": report.get("appliedEdgeCount"),
                  "nextRecomputeAtEpoch": revision.get("nextRecomputeAtEpoch")}
        return result


if __name__ == "__main__":
    try:
        print(json.dumps(inspect(Path("/traffic")), sort_keys=True))
    except (OSError, ValueError, TypeError, tarfile.TarError):
        raise SystemExit("Aggregate traffic inspection failed; no private data disclosed.")
