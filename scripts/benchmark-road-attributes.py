#!/usr/bin/env python3
"""Read-only Valhalla route/edge-walk probe; prints aggregate values only."""
import json
import math
import subprocess
import sys
import time

if len(sys.argv) != 2:
    raise SystemExit("Usage: benchmark-road-attributes.py INTERNAL_VALHALLA_BASE_URL")
BASE_URL = sys.argv[1].rstrip("/")
SCENARIOS = {
    "parallel_urban_roads": ((50.0806, 14.4312), (50.0875, 14.4285)),
    "motorway_ramp": ((50.0370, 14.4970), (50.0240, 14.5060)),
    "roundabout": ((50.0984, 14.3940), (50.1004, 14.4005)),
    "one_way_streets": ((50.0840, 14.4140), (50.0860, 14.4190)),
    "speed_change": ((50.0870, 14.4160), (50.0700, 14.4900)),
    "conditional_restriction_candidate": ((50.0660, 14.4110), (50.0610, 14.4160)),
    "cross_border": ((50.6400, 13.8200), (50.7600, 13.7500)),
}


def post(path, payload):
    started = time.perf_counter()
    process = subprocess.run(["curl", "--silent", "--show-error", "--max-time", "20", "--header", "Content-Type: application/json", "--data-binary", "@-", BASE_URL + path], input=json.dumps(payload), text=True, capture_output=True, timeout=25)
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    if process.returncode:
        raise RuntimeError(process.stderr.strip()[:160])
    data = json.loads(process.stdout)
    if data.get("error") or data.get("status_message") == "No route found":
        raise RuntimeError(str(data.get("error") or data.get("status_message"))[:160])
    return data, elapsed_ms, len(process.stdout.encode())


def decode(encoded):
    index = lat = lon = 0
    points = []
    while index < len(encoded):
        values = []
        for _ in range(2):
            shift = result = 0
            while True:
                byte = ord(encoded[index]) - 63
                index += 1
                result |= (byte & 0x1f) << shift
                shift += 5
                if byte < 0x20:
                    break
            values.append((result >> 1) ^ (-(result & 1)))
        lat += values[0]
        lon += values[1]
        points.append((lon / 1e6, lat / 1e6))
    return points


def meters(a, b):
    r1, r2 = math.radians(a[1]), math.radians(b[1])
    dr, dl = r2 - r1, math.radians(b[0] - a[0])
    return 2 * 6371000 * math.asin(math.sqrt(math.sin(dr/2)**2 + math.cos(r1)*math.cos(r2)*math.sin(dl/2)**2))


for name, (start, end) in SCENARIOS.items():
    try:
        route, route_ms, route_bytes = post("/route", {"locations": [{"lat": start[0], "lon": start[1]}, {"lat": end[0], "lon": end[1]}], "costing": "auto", "units": "kilometers"})
        legs = route.get("trip", {}).get("legs", [])
        if len(legs) != 1:
            raise RuntimeError("route did not return exactly one leg")
        shape = legs[0]["shape"]
        trace, trace_ms, trace_bytes = post("/trace_attributes", {"encoded_polyline": shape, "shape_match": "edge_walk", "costing": "auto", "units": "kilometers", "filters": {"action": "include", "attributes": ["shape", "edge.begin_shape_index", "edge.end_shape_index", "edge.speed_limit", "shape_attributes.closure", "osm_changeset"]}})
        points = decode(trace.get("shape", ""))
        edges = trace.get("edges", [])
        mismatches = int(trace.get("shape") != shape)
        total = known = 0.0
        for edge in edges:
            begin, finish = edge.get("begin_shape_index"), edge.get("end_shape_index")
            if not isinstance(begin, int) or not isinstance(finish, int) or begin < 0 or finish <= begin or finish >= len(points):
                mismatches += 1
                continue
            length = sum(meters(points[i], points[i+1]) for i in range(begin, finish))
            total += length
            limit = edge.get("speed_limit")
            if isinstance(limit, (int, float)) and 10 <= limit <= 160:
                known += length
        print(json.dumps({"scenario": name, "status": "ok", "routeMs": route_ms, "traceMs": trace_ms, "routeBytes": route_bytes, "traceBytes": trace_bytes, "edgeCount": len(edges), "geometryMismatches": mismatches, "knownLimitCoveragePercent": round(100 * known / total, 1) if total else 0, "closureCount": len(trace.get("shape_attributes", {}).get("closure", []))}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"scenario": name, "status": "unavailable", "reason": str(error)}, ensure_ascii=False))
