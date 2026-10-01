#!/usr/bin/env python3
"""Private, read-only geometry export in an isolated pinned Valhalla container.

stdin is a bounded list of directed IDs; stdout is PRIVATE gzip JSON, never a
public log. No provider API, traffic archive or unhashed tile fallback is used.
"""
import gzip
import hashlib
import json
import os
from pathlib import Path
import sys

from valhalla.baldr import GraphId
from valhalla.baldr.utils import GraphUtils


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    if len(sys.argv) != 2 or len(sys.argv[1]) != 64:
        raise ValueError("Invalid immutable graph identity")
    raw = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError("Private ID request limit")
    ids = json.loads(raw)
    if (not isinstance(ids, list) or not 1 <= len(ids) <= 100000 or len(set(ids)) != len(ids) or
            any(type(i) is not int or not 0 <= i < 2**46 or (i & 7) > 2 for i in ids)):
        raise ValueError("Invalid directed edge request")
    extract = Path("/graph/valhalla_tiles.tar")
    if file_hash(extract) != sys.argv[1]:
        raise ValueError("Graph mismatch")
    identity = (extract.stat().st_size, extract.stat().st_mtime_ns)
    config = Path("/tmp/shape-config.json")
    config.write_text(json.dumps({"mjolnir": {"tile_extract": str(extract), "tile_dir": "/__no_unhashed_tiles__",
        "tile_url": "", "traffic_extract": "", "max_cache_size": 134217728}}))
    # Suppress native stdout diagnostics while assembling a binary private
    # export. They must not corrupt gzip or disclose edge identifiers in logs.
    saved_stdout = os.dup(1)
    with open(os.devnull, "wb") as null:
        os.dup2(null.fileno(), 1)
    graph = GraphUtils(str(config))
    shapes, points = {}, 0
    for ident in ids:
        shape = graph.get_edge_shape(GraphId(ident))
        points += len(shape)
        if points > 2_000_000:
            raise ValueError("Private geometry point limit")
        shapes[str(ident)] = shape
    if identity != (extract.stat().st_size, extract.stat().st_mtime_ns) or file_hash(extract) != sys.argv[1]:
        raise ValueError("Graph changed")
    payload = json.dumps({"contractVersion": "sim-native-directed-shapes-v1", "graphSha256": sys.argv[1],
                          "shapes": shapes}, separators=(",", ":"), allow_nan=False).encode()
    if len(payload) > 128 * 1024 * 1024:
        raise ValueError("Private geometry output limit")
    os.dup2(saved_stdout, 1)
    os.close(saved_stdout)
    sys.stdout.buffer.write(gzip.compress(payload, mtime=0))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Private read-only geometry export failed.", file=sys.stderr)
        raise SystemExit(1)
