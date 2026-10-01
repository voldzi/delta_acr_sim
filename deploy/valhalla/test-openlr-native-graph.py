#!/usr/bin/env python3
"""Build synthetic OSM PBF/Valhalla tiles and test the real native decoder.

Only invented roads are used. Run inside a disposable Valhalla3.8.3 builder
with a read-only source mount, no network and no production graph mounts.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import struct
import subprocess
import tarfile
import tempfile
import zlib


def varint(value: int) -> bytes:
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128)
        value >>= 7
    result.append(value)
    return bytes(result)


def sint(value: int) -> bytes:
    return varint((value << 1) ^ (value >> 63))


def scalar(field: int, value: int) -> bytes:
    return varint(field << 3) + varint(value)


def message(field: int, value: bytes) -> bytes:
    return varint((field << 3) | 2) + varint(len(value)) + value


def osm_pbf(nodes: dict[int, tuple[float, float]], ways: list[tuple[int, list[int], dict]],
            relations: list[tuple[int, dict, list[tuple[int, int, str]]]], node_tags=None) -> bytes:
    strings = [""]
    def index(value: str) -> int:
        if value not in strings:
            strings.append(value)
        return strings.index(value)
    def tags(values: dict) -> bytes:
        return message(2, b"".join(varint(index(key)) for key in values)) + \
               message(3, b"".join(varint(index(value)) for value in values.values()))
    group = b""
    for ident, (lon, lat) in sorted(nodes.items()):
        node = varint(1 << 3) + sint(ident)
        if node_tags and ident in node_tags:
            node += tags(node_tags[ident])
        node += varint(8 << 3) + sint(round(lat * 10_000_000))
        node += varint(9 << 3) + sint(round(lon * 10_000_000))
        group += message(1, node)
    for ident, references, values in ways:
        previous = 0
        deltas = []
        for reference in references:
            deltas.append(sint(reference - previous))
            previous = reference
        group += message(3, scalar(1, ident) + tags(values) + message(8, b"".join(deltas)))
    for ident, values, members in relations:
        previous = 0
        deltas = []
        for _, reference, _ in members:
            deltas.append(sint(reference - previous))
            previous = reference
        relation = scalar(1, ident) + tags(values)
        relation += message(8, b"".join(varint(index(role)) for _, _, role in members))
        relation += message(9, b"".join(deltas))
        relation += message(10, b"".join(varint(kind) for kind, _, _ in members))
        group += message(4, relation)
    table = b"".join(message(1, value.encode()) for value in strings)
    primitive = message(1, table) + message(2, group) + scalar(17, 100)
    header = message(4, b"OsmSchema-V0.6") + message(16, b"csm-sim-synthetic-openlr-test")
    def block(kind: bytes, payload: bytes) -> bytes:
        blob = scalar(2, len(payload)) + message(3, zlib.compress(payload))
        blob_header = message(1, kind) + scalar(3, len(blob))
        return struct.pack(">I", len(blob_header)) + blob_header + blob
    return block(b"OSMHeader", header) + block(b"OSMData", primitive)


def distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    hav = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 12_742_000 * math.asin(math.sqrt(hav))


def heading(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (*a, *b))
    return math.degrees(math.atan2(math.sin(lon2 - lon1) * math.cos(lat2),
      math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(lon2 - lon1))) % 360


def fixture() -> bytes:
    nodes = {
      1: (14., 50.), 2: (14.003, 50.), 3: (14.006, 50.),
      10: (14.02, 50.), 11: (14.023, 50.), 12: (14.026, 50.),
      20: (14.04, 50.), 21: (14.041, 50.), 22: (14.043, 50.), 23: (14.044, 50.),
      24: (14.042, 50.0001), 25: (14.042, 49.9999),
      30: (14.06, 50.), 31: (14.061, 50.), 32: (14.061, 50.0015),
      33: (14.062, 50.),
      40: (14.08, 50.), 41: (14.083, 50.),
      42: (14.0815, 49.999), 43: (14.0815, 50.001),
      50: (14.10, 50.), 51: (14.101, 50.), 52: (14.102, 50.), 53: (14.101, 50.001),
      60: (14.12, 50.), 61: (14.122, 50.), 62: (14.124, 50.), 63: (14.126, 50.),
      70: (14.14, 50.), 71: (14.142, 50.), 72: (14.141, 50.001), 73: (14.138, 50.),
      80: (14.16, 50.), 81: (14.162, 50.), 82: (14.164, 50.),
      90: (14.18, 50.), 91: (14.182, 50.), 92: (14.184, 50.), 93: (14.186, 50.),
      94: (14.182, 50.001), 95: (14.184, 49.999),
      110: (14.20, 50.), 111: (14.201, 50.), 112: (14.202, 50.),
    }
    def road(ident, refs, **extra):
        return (ident, refs, {"highway": "primary", "name": "Synthetic " + str(ident), "maxspeed": "50", **extra})
    ways = [road(101, [1, 2, 3]), road(201, [10, 11, 12], oneway="yes"),
            road(301, [20, 21]), road(302, [21, 24, 22]), road(303, [21, 25, 22]), road(304, [22, 23]),
            road(401, [30, 31]), road(402, [31, 32]), road(403, [31, 33]),
            road(501, [40, 41], bridge="yes", layer="1"), road(502, [42, 43]),
            road(601, [50, 51]), road(602, [51, 52]), road(603, [51, 53]),
            road(701, [60, 61], oneway="yes"), road(702, [61, 62], highway="tertiary", oneway="yes"),
            road(703, [62, 63], oneway="yes"),
            road(801, [70, 71, 72, 70], junction="roundabout"), road(802, [73, 70]),
            road(901, [80, 81, 82], highway="primary_link", oneway="yes"),
            road(1001, [90, 91]), road(1002, [91, 92]), road(1003, [92, 93]),
            road(1004, [91, 94]), road(1005, [92, 95]), road(1101, [110, 111, 112])]
    restrictions = [(901, {"type": "restriction", "restriction": "no_left_turn"},
                     [(1, 401, "from"), (0, 31, "via"), (1, 402, "to")]),
                    (1006, {"type": "restriction", "restriction": "no_straight_on"},
                     [(1, 1001, "from"), (1, 1002, "via"), (1, 1003, "to")])]
    return osm_pbf(nodes, ways, restrictions, {111: {"barrier": "bollard", "motor_vehicle": "no"}})


def checked_run(command: list[str]) -> subprocess.CompletedProcess:
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)
    if result.returncode:
        raise RuntimeError("Synthetic build failed: " + "\n".join(result.stdout.splitlines()[-15:]))
    return result


def run(helper: Path, work: Path, hierarchy: bool = False) -> None:
    work.mkdir(parents=True, exist_ok=True)
    pbf, config_path, extract = work / "synthetic.osm.pbf", work / "valhalla.json", work / "tiles.tar"
    pbf.write_bytes(fixture())
    config = json.loads(checked_run(["/usr/local/bin/valhalla_build_config", "--mjolnir-tile-dir", str(work / "tiles"),
      "--mjolnir-tile-extract", str(extract), "--mjolnir-concurrency", "1",
      "--mjolnir-shortcuts", "false", "--mjolnir-hierarchy", "true" if hierarchy else "false",
      "--mjolnir-data-processing-use-admin-db", "false", "--mjolnir-admin", "",
      "--mjolnir-timezone", "", "--logging-type", "std_err"]).stdout)
    # This graph has no live traffic. It must not consult a default archive.
    config["mjolnir"]["traffic_extract"] = ""
    config_path.write_text(json.dumps(config))
    checked_run(["/usr/local/bin/valhalla_build_tiles", "-c", str(config_path), "-j", "1", str(pbf)])
    checked_run(["/usr/local/bin/valhalla_build_extract", "-c", str(config_path), "-O"])
    graph_hash = hashlib.sha256(extract.read_bytes()).hexdigest()
    dataset = "sim-routing-synthetic-native-test"
    process = subprocess.Popen([str(helper), str(config_path), dataset, graph_hash],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    requests = []
    def linear(a, b, *, middle=None, length=None, **extra):
        positions = [a, b] if middle is None else [a, middle, b]
        lrps = []
        for i, position in enumerate(positions):
            target = positions[i + 1] if i + 1 < len(positions) else positions[i - 1]
            item = {"lon": position[0], "lat": position[1], "bearingDegrees": heading(position, target), "frc": 2, "fow": 3}
            if i + 1 < len(positions):
                item.update(distanceToNext=length if length is not None else distance(position, target), lowestFrcToNext=2)
            lrps.append(item)
        return {"requestId": len(requests) + 1, "routingDataset": dataset, "graphSha256": graph_hash,
                "staticRevision": "0" * 64, "lrps": lrps, **extra}
    def submit(label, request, expected):
        requests.append((label, request, expected))
    submit("same edge", linear((14.0005, 50.), (14.0055, 50.)), {"matched"})
    submit("same edge offsets", linear((14.0005, 50.), (14.0055, 50.), positiveOffsetMeters=20, negativeOffsetMeters=10), {"matched"})
    submit("multiple LRPs", linear((14.0005, 50.), (14.0055, 50.), middle=(14.003, 50.)), {"matched"})
    submit("one-way forward", linear((14.0205, 50.), (14.0255, 50.)), {"matched"})
    submit("one-way reverse", linear((14.0255, 50.), (14.0205, 50.)), {"no_endpoint", "unmatched"})
    divided = linear((14.0205, 50.), (14.0255, 50.))
    for lrp in divided["lrps"]:
        lrp["fow"] = 2
    submit("one-way divided form", divided, {"matched"})
    submit("parallel equal-distance paths", linear((14.0402, 50.), (14.0438, 50.), length=260), {"ambiguous"})
    guided = linear((14.0402, 50.), (14.0438, 50.), length=260)
    guided["corridor"] = {"revision": "c" * 64, "toleranceMeters": 10,
      "parts": [[[14.0402, 50.], [14.041, 50.], [14.042, 50.0001], [14.043, 50.], [14.0438, 50.]]]}
    submit("corridor during search disambiguates upper branch", guided, {"matched"})
    outside = linear((14.0005, 50.), (14.0055, 50.))
    outside["corridor"] = {"revision": "d" * 64, "toleranceMeters": 10,
      "parts": [[[14.0005, 50.001], [14.0055, 50.001]]]}
    submit("same edge outside independent corridor", outside, {"unmatched"})
    partial = linear((14.0005, 50.), (14.0055, 50.))
    partial["corridor"] = {"revision": "e" * 64, "toleranceMeters": 10,
      "parts": [[[14.0005, 50.], [14.0055, 50.]]]}
    submit("corridor clips partial endpoint intervals", partial, {"matched"})
    a, corner, b = (14.0602, 50.), (14.061, 50.), (14.061, 50.0012)
    turn = linear(a, b, length=distance(a, corner) + distance(corner, b))
    turn["lrps"][0]["bearingDegrees"] = 90
    turn["lrps"][-1]["bearingDegrees"] = 180
    submit("forbidden native turn", turn, {"unmatched", "unsupported_restriction"})
    crossing = linear((14.0802, 50.), (14.0815, 50.0008), length=180)
    crossing["lrps"][0]["bearingDegrees"] = 90
    crossing["lrps"][-1]["bearingDegrees"] = 180
    submit("disconnected overpass", crossing, {"unmatched"})
    submit("native snapped junction", linear((14.1002, 50.), (14.1018, 50.), middle=(14.101, 50.)), {"matched"})
    lowest = linear((14.1202, 50.), (14.1258, 50.))
    submit("LFRCNP excludes tertiary path", lowest, {"unmatched"})
    allowed_lowest = linear((14.1202, 50.), (14.1258, 50.))
    allowed_lowest["lrps"][0]["lowestFrcToNext"] = 4
    submit("LFRCNP permits tertiary path", allowed_lowest, {"matched"})
    ring = linear((14.1402, 50.), (14.1418, 50.))
    for lrp in ring["lrps"]:
        lrp["fow"] = 4
    submit("native roundabout form", ring, {"matched"})
    submit("roundabout mislabeled ordinary", linear((14.1402, 50.), (14.1418, 50.)), {"no_endpoint"})
    ramp = linear((14.1602, 50.), (14.1638, 50.))
    for lrp in ramp["lrps"]:
        lrp["fow"] = 6
    submit("native slip road form", ramp, {"matched"})
    submit("slip road mislabeled ordinary", linear((14.1602, 50.), (14.1638, 50.)), {"no_endpoint"})
    submit("complex via-way restriction unsupported", linear((14.1802, 50.), (14.1858, 50.)), {"unsupported_restriction"})
    submit("native vehicular node barrier respected", linear((14.2002, 50.), (14.2018, 50.)), {"unmatched", "no_endpoint"})
    wrong_graph = linear((14.0005, 50.), (14.0055, 50.)); wrong_graph["graphSha256"] = "f" * 64
    submit("graph identity", wrong_graph, {"graph_mismatch"})
    no_class = linear((14.0005, 50.), (14.0055, 50.)); del no_class["lrps"][0]["lowestFrcToNext"]
    submit("missing LFRCNP", no_class, {"invalid_reference"})
    wrong_form = linear((14.0005, 50.), (14.0055, 50.)); wrong_form["lrps"][0]["fow"] = 4
    submit("false roundabout", wrong_form, {"no_endpoint"})
    reverse = linear((14.0005, 50.), (14.0055, 50.)); reverse["lrps"][0]["againstDrivingDirection"] = True
    submit("unverified TPEG driving direction", reverse, {"unsupported_driving_direction"})
    unknown = linear((14.0005, 50.), (14.0055, 50.)); unknown["chatContext"] = "invalid"
    submit("unknown field", unknown, {"invalid_reference"})
    unsupported_form = linear((14.0005, 50.), (14.0055, 50.)); unsupported_form["lrps"][0]["fow"] = 0
    submit("undefined form explicitly unsupported", unsupported_form, {"unsupported_fow"})
    # Exercise the entire directed/corridor/restriction contract both with and
    # without road hierarchy, not only a successful same-edge reference.
    results = []
    extra_checks = {}
    try:
        assert process.stdin is not None and process.stdout is not None
        for label, request, expected in requests:
            process.stdin.write(json.dumps(request) + "\n"); process.stdin.flush()
            line = process.stdout.readline()
            if not line:
                detail = process.stderr.read() if process.stderr else ""
                raise AssertionError(f"Native helper stopped at {label}: {detail[-1500:]}")
            result = json.loads(line)
            assert result["requestId"] == request["requestId"], (label, "response identity")
            assert result["corridorRevision"] == request.get("corridor", {}).get("revision", ""), (label, "corridor identity")
            assert result["status"] in expected, (label, result, expected)
            if result["status"] == "matched":
                assert result["intervals"] and all(0 <= i["beginFraction"] < i["endFraction"] <= 1 for i in result["intervals"])
                assert result["decoderVersion"] == "openlr-native-v2"
            results.append(result)
        if hierarchy:
            mixed = results[[label for label, _, _ in requests].index("LFRCNP permits tertiary path")]
            assert len({interval["edgeId"] & 7 for interval in mixed["intervals"]}) >= 2
            extra_checks["real multi-level directed path"] = "matched"
        if not hierarchy:
            assert math.isclose(results[0]["lengthMeters"] - results[1]["lengthMeters"], 30, abs_tol=.001)
            assert results[0]["intervals"][0]["edgeId"] == results[1]["intervals"][0]["edgeId"]
            assert len(results[2]["intervals"]) == 1
            # Exercise the actual byte-bearing adapter and immutable extract
            # protocol, not just hand-built native JSON requests.
            spec = importlib.util.spec_from_file_location("native_client", Path(__file__).with_name("openlr-native-client.py"))
            assert spec and spec.loader
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            normalized = {"messageId": "synthetic-roundtrip", "coordinates": [[14.0005, 50.], [14.0055, 50.]],
                "openlr": {"points": [{"role": "first", "bearing": 64, "frc": "2", "fow": "3",
                    "distanceToNext": 358, "lowestFrcToNext": "2"},
                    {"role": "last", "bearing": 192, "frc": "2", "fow": "3"}]}}
            native_client = module.NativeDecoderClient(helper, config_path, dataset, graph_hash)
            try:
                adapted = native_client.decode(normalized, "0" * 64)
                assert adapted["status"] == "matched" and adapted["fullEdgeIds"] == []
                extra_checks["real TPEG-byte client/native roundtrip"] = "matched"
            finally:
                native_client.close()
            # An unhashed tile_dir cannot supplement an otherwise empty extract.
            empty_extract = work / "empty.tar"
            with tarfile.open(empty_extract, "w"):
                pass
            empty_config = work / "unhashed-directory.json"
            fallback = dict(config); fallback["mjolnir"] = {**config["mjolnir"], "tile_extract": str(empty_extract)}
            empty_config.write_text(json.dumps(fallback))
            empty_hash = hashlib.sha256(empty_extract.read_bytes()).hexdigest()
            no_fallback = module.NativeDecoderClient(helper, empty_config, dataset, empty_hash)
            try:
                assert no_fallback.decode(normalized, "0" * 64)["status"] == "no_endpoint"
                extra_checks["unhashed tile directory fallback blocked"] = "no_endpoint"
            finally:
                no_fallback.close()
            # Mutating even a padding byte after the last response must be
            # caught by the final full SHA256 verification before audit save.
            changed_extract = work / "changing.tar"
            changed_extract.write_bytes(extract.read_bytes())
            changed_config = work / "changing.json"
            altered = dict(config); altered["mjolnir"] = {**config["mjolnir"], "tile_extract": str(changed_extract)}
            changed_config.write_text(json.dumps(altered))
            changing = module.NativeDecoderClient(helper, changed_config, dataset, graph_hash)
            assert changing.decode(normalized, "0" * 64)["status"] == "matched"
            with changed_extract.open("r+b") as stream:
                stream.seek(-1, 2); stream.write(b"X")
            try:
                changing.close()
                raise AssertionError("Final graph mutation was accepted")
            except RuntimeError:
                extra_checks["final graph mutation rejected"] = "rejected"
        print(json.dumps({"contractVersion": "sim-openlr-native-graph-tests-v1", "valhallaVersion": "3.8.3",
          "syntheticGraphSha256": graph_hash, "checksPassed": len(results) + len(extra_checks),
          "hierarchyEnabled": hierarchy,
          "statuses": {**{label: result["status"] for (label, _, _), result in zip(requests, results)}, **extra_checks}}, sort_keys=True))
    finally:
        if process.stdin:
            process.stdin.close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helper", type=Path, required=True)
    parser.add_argument("--work", type=Path)
    parser.add_argument("--hierarchy", action="store_true")
    args = parser.parse_args()
    if args.work:
        run(args.helper, args.work, args.hierarchy)
    else:
        with tempfile.TemporaryDirectory(prefix="sim-openlr-synthetic-") as directory:
            run(args.helper, Path(directory), args.hierarchy)
