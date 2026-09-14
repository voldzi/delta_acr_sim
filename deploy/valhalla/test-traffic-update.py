#!/usr/bin/env python3
from __future__ import annotations

from io import BytesIO
import importlib.util
import json
from pathlib import Path
import struct
import tarfile
import tempfile

MODULE_PATH = Path(__file__).with_name("traffic-update.py")
SPEC = importlib.util.spec_from_file_location("traffic_update", MODULE_PATH)
assert SPEC and SPEC.loader
traffic = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(traffic)


def graph_id(level: int, tile_id: int, edge_index: int) -> int:
    return level | (tile_id << 3) | (edge_index << 25)


def make_archive(path: Path, level: int, tile_id: int, edges: int) -> None:
    tile_name = f"{level}/{tile_id // 1000000:03d}/{tile_id // 1000 % 1000:03d}/{tile_id % 1000:03d}.gph"
    header = struct.pack("<2Q4I", level | (tile_id << 3), 0, edges, 3, 0, 0)
    with tarfile.open(path, "w") as archive:
        info = tarfile.TarInfo(tile_name)
        info.size = len(header) + edges * 8
        archive.addfile(info, BytesIO(header + b"\0" * (edges * 8)))


def main() -> None:
    assert traffic.graph_id_parts(graph_id(2, 807177, 210837)) == (2, 807177, 210837)
    assert traffic.parse_iso_timestamp("2026-09-14T19:49:03+02:00") == traffic.parse_iso_timestamp("2026-09-14T17:49:03Z")
    word = traffic.traffic_word(36, 90)
    assert word & 0x7F == 18
    assert (word >> 28) & 0xFF == 255
    assert (word >> 44) & 0x3F > 1

    now = "2099-01-01T00:00:00Z"
    mapping = {"mapping": {"flow-1": [{"id": graph_id(1, 50594, 2), "baselineSpeedKph": 80}]}}
    feed = {"flows": [{"messageId": "flow-1", "averageSpeedKph": 24, "validUntil": now}]}
    speeds, flow_count, _ = traffic.current_edge_speeds(feed, mapping, 10**10)
    assert flow_count == 1 and list(speeds) == [graph_id(1, 50594, 2)]

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        archive = root / "traffic.tar"
        state = root / "applied-edges.json"
        make_archive(archive, 1, 50594, 4)
        applied = traffic.apply_speeds(archive, state, speeds)
        assert applied == 1
        offset, _ = traffic.edge_record_location(graph_id(1, 50594, 2), traffic.traffic_tile_offsets(archive))
        with archive.open("rb") as stream:
            stream.seek(offset)
            assert struct.unpack("<Q", stream.read(8))[0] == traffic.traffic_word(24, 80)
        assert json.loads(state.read_text()) == [graph_id(1, 50594, 2)]
        revision = root / "last-applied.json"
        revision.write_text(json.dumps({"appliedAtEpoch": 1}))
        assert traffic.clear_expired_runtime(root, 1)
        with archive.open("rb") as stream:
            stream.seek(offset)
            assert struct.unpack("<Q", stream.read(8))[0] == 0
    print("Valhalla traffic updater tests passed.")


if __name__ == "__main__":
    main()
