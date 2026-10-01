#!/usr/bin/env python3
"""Collect private directed geometry from a read-only, resource-limited sidecar.

Staged exporter is required. No provider token, HTTP route or traffic mmap is
opened. Only aggregate counts are printed; generated data stay mode 0600.
"""
import argparse
import gzip
import io
import json
import os
from pathlib import Path
import shlex
import subprocess


def main(args):
    destination = args.output.resolve()
    if (not destination.name.endswith(".json.gz") or destination == args.audit.resolve() or destination.exists() or
            any(destination.is_relative_to(root.resolve()) for root in (Path("/run"), Path("/var/run")))):
        raise ValueError("Invalid separate private output")
    with gzip.open(args.audit, "rb") as stream:
        raw = stream.read(256 * 1024 * 1024 + 1)
    if len(raw) > 256 * 1024 * 1024:
        raise ValueError("Private audit input limit")
    audit = json.loads(raw)
    if audit.get("decoderVersion") != "openlr-native-v2" or audit.get("approvedForLive") is not False:
        raise ValueError("Invalid private native audit")
    graph_hash = audit["graphSha256"]
    if len(graph_hash) != 64 or any(c not in "0123456789abcdef" for c in graph_hash):
        raise ValueError("Invalid graph hash")
    ids = sorted({i["edgeId"] for p in audit["intervalCandidates"].values() for i in p})
    if not 1 <= len(ids) <= 100000 or any(type(i) is not int or not 0 <= i < 2**46 or (i & 7) > 2 for i in ids):
        raise ValueError("Private edge export limit")
    work = "/home/voldzi/valhalla-owned-deploy/native-shadow-v2-20261001"
    graph = "/srv/valhalla/releases/20260929T081714Z/custom_files"
    image = "ghcr.io/valhalla/valhalla-scripted:3.8.3@sha256:24ef7955899dececb94e26c6dfb89d64fabfae875f980432694b0261eb6c251b"
    command = f"""set -eu
test "$(readlink -f /srv/valhalla/current)" = {shlex.quote(graph)}
name=sim-openlr-native-directed-shapes-v2-20261001
! docker container inspect "$name" >/dev/null 2>&1
umask 077
control=$(mktemp -d /tmp/sim-native-shapes-control.XXXXXX)
cidfile="$control/container-id"
cleanup() {{
  if test -s "$cidfile"; then
    owned_id=$(head -n 1 "$cidfile")
    if printf '%s' "$owned_id" | LC_ALL=C grep -Eq '^[0-9a-f]{{64}}$'; then docker rm -f "$owned_id" >/dev/null 2>&1 || true; fi
  fi
  rm -f -- "$cidfile"
  rmdir -- "$control" 2>/dev/null || true
}}
trap cleanup EXIT HUP INT TERM
timeout --foreground --signal=TERM --kill-after=5s 180 docker run --rm -i --name "$name" --cidfile "$cidfile" \
  --network none --read-only --user "$(id -u):$(id -g)" --cpus 1 --memory 768m --pids-limit 64 \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,size=1m,mode=1777 \
  --mount type=bind,src={graph}/valhalla_tiles.tar,dst=/graph/valhalla_tiles.tar,readonly \
  --mount type=bind,src={work},dst=/work,readonly \
  --entrypoint python3 {image} /work/export-native-edge-shapes.py {graph_hash}
test "$(readlink -f /srv/valhalla/current)" = {shlex.quote(graph)}"""
    response = subprocess.run(["ssh", "-o", "BatchMode=yes", "valhalla.home.cz", command],
        input=json.dumps(ids).encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=210)
    if response.returncode or len(response.stdout) > 128 * 1024 * 1024:
        raise RuntimeError("Private isolated geometry export failed")
    with gzip.GzipFile(fileobj=io.BytesIO(response.stdout)) as stream:
        raw_export = stream.read(128 * 1024 * 1024 + 1)
    if len(raw_export) > 128 * 1024 * 1024:
        raise ValueError("Private geometry output limit")
    exported = json.loads(raw_export)
    if (set(exported) != {"contractVersion", "graphSha256", "shapes"} or
            exported.get("contractVersion") != "sim-native-directed-shapes-v1" or
            exported.get("graphSha256") != graph_hash or not isinstance(exported.get("shapes"), dict) or
            set(exported["shapes"]) != set(map(str, ids))):
        raise ValueError("Private directed geometry identity mismatch")
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(destination), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(response.stdout)
    print(json.dumps({"contractVersion": "sim-native-directed-shape-collection-v1", "graphSha256": graph_hash,
                      "directedEdgeCount": len(ids), "privateCompressedBytes": len(response.stdout)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    main(parser.parse_args())
