#!/usr/bin/env python3
"""Validate privacy-safe Valhalla health and routing responses."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid JSON response: {exc}") from exc


def finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def validate_status(payload: Any) -> None:
    if not isinstance(payload, dict):
        raise ValueError("status response must be an object")
    version = payload.get("version")
    actions = payload.get("available_actions")
    required = {"status", "route", "locate", "isochrone", "height"}
    if not isinstance(version, str) or not version.strip():
        raise ValueError("status response has no version")
    if not isinstance(actions, list) or not required.issubset(set(actions)):
        missing = sorted(required.difference(actions if isinstance(actions, list) else []))
        raise ValueError(f"status response is missing actions: {', '.join(missing)}")


def decode_polyline6(value: str) -> list[tuple[float, float]]:
    coordinates: list[tuple[float, float]] = []
    index = 0
    latitude = 0
    longitude = 0
    while index < len(value):
        deltas = []
        for _ in range(2):
            result = 0
            shift = 0
            while True:
                if index >= len(value):
                    raise ValueError("route contains an invalid polyline6 shape")
                byte = ord(value[index]) - 63
                index += 1
                result |= (byte & 0x1F) << shift
                shift += 5
                if byte < 0x20:
                    break
            deltas.append(~(result >> 1) if result & 1 else result >> 1)
        latitude += deltas[0]
        longitude += deltas[1]
        coordinates.append((latitude / 1_000_000, longitude / 1_000_000))
    return coordinates


def validate_route(
    payload: Any,
    max_km: float,
    expected_admins: set[str],
    endpoints: tuple[float, float, float, float] | None,
    max_snap_m: float,
    require_elevation: bool,
) -> None:
    if not isinstance(payload, dict):
        raise ValueError("route response must be an object")
    trip = payload.get("trip")
    if not isinstance(trip, dict) or trip.get("status") != 0:
        raise ValueError(f"route failed: {payload.get('error') or payload.get('status_message') or 'missing trip'}")
    summary = trip.get("summary")
    length = summary.get("length") if isinstance(summary, dict) else None
    duration = summary.get("time") if isinstance(summary, dict) else None
    if not finite_number(length) or not 0 < float(length) <= max_km:
        raise ValueError(f"route length {length!r} is outside (0, {max_km}] km")
    if not finite_number(duration) or float(duration) <= 0:
        raise ValueError("route duration is missing or non-positive")
    legs = trip.get("legs")
    if not isinstance(legs, list) or not legs:
        raise ValueError("route response has no legs")
    found_admins = {
        str(admin.get("country_code")).upper()
        for leg in legs
        if isinstance(leg, dict)
        for admin in ((leg.get("summary") or {}).get("admins") or [])
        if isinstance(admin, dict) and admin.get("country_code")
    }
    missing_admins = sorted(expected_admins.difference(found_admins))
    if missing_admins:
        raise ValueError(
            f"route is missing expected admins: {', '.join(missing_admins)}; found: {', '.join(sorted(found_admins))}"
        )
    shapes = [leg.get("shape") for leg in legs if isinstance(leg, dict) and isinstance(leg.get("shape"), str)]
    if len(shapes) != len(legs):
        raise ValueError("route response has a leg without polyline6 shape")
    if require_elevation:
        for leg in legs:
            elevations = leg.get("elevation") if isinstance(leg, dict) else None
            interval = leg.get("elevation_interval") if isinstance(leg, dict) else None
            if not isinstance(elevations, list) or len(elevations) < 2 or not all(finite_number(value) for value in elevations):
                raise ValueError("route response has missing or non-finite graph elevation samples")
            if not finite_number(interval) or float(interval) <= 0:
                raise ValueError("route response has no positive elevation interval")
    if endpoints is not None:
        start_lat, start_lon, end_lat, end_lon = endpoints
        first_shape = decode_polyline6(shapes[0])
        last_shape = decode_polyline6(shapes[-1])
        if not first_shape or not last_shape:
            raise ValueError("route response has an empty polyline6 shape")
        start_snap_m = haversine_meters(start_lat, start_lon, *first_shape[0])
        end_snap_m = haversine_meters(end_lat, end_lon, *last_shape[-1])
        if start_snap_m > max_snap_m or end_snap_m > max_snap_m:
            raise ValueError(
                f"route endpoint snap exceeds {max_snap_m} m: start={start_snap_m:.1f}, end={end_snap_m:.1f}"
            )


def haversine_meters(lat_a: float, lon_a: float, lat_b: float, lon_b: float) -> float:
    radius_m = 6_371_008.8
    lat_a_rad = math.radians(lat_a)
    lat_b_rad = math.radians(lat_b)
    delta_lat = lat_b_rad - lat_a_rad
    delta_lon = math.radians(lon_b - lon_a)
    value = math.sin(delta_lat / 2) ** 2 + math.cos(lat_a_rad) * math.cos(lat_b_rad) * math.sin(delta_lon / 2) ** 2
    value = min(1.0, max(0.0, value))
    return radius_m * 2 * math.atan2(math.sqrt(value), math.sqrt(1 - value))


def validate_locate(payload: Any, max_snap_m: float) -> None:
    if not isinstance(payload, list) or len(payload) != 1 or not isinstance(payload[0], dict):
        raise ValueError("locate response must contain one location")
    edges = payload[0].get("edges")
    if not isinstance(edges, list) or not edges:
        raise ValueError("locate response has no routable edges")
    input_lat = payload[0].get("input_lat")
    input_lon = payload[0].get("input_lon")
    if not finite_number(input_lat) or not finite_number(input_lon):
        raise ValueError("locate response has no input coordinate")
    distances = []
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        correlated_lat = edge.get("correlated_lat")
        correlated_lon = edge.get("correlated_lon")
        if finite_number(correlated_lat) and finite_number(correlated_lon):
            distances.append(haversine_meters(float(input_lat), float(input_lon), float(correlated_lat), float(correlated_lon)))
    if not distances or min(distances) > max_snap_m:
        nearest = min(distances) if distances else None
        raise ValueError(f"nearest routable edge is {nearest!r} m away; maximum is {max_snap_m} m")


def validate_isochrone(payload: Any) -> None:
    if not isinstance(payload, dict) or payload.get("type") != "FeatureCollection":
        raise ValueError("isochrone response must be a FeatureCollection")
    features = payload.get("features")
    if not isinstance(features, list) or not features:
        raise ValueError("isochrone response has no features")
    geometry = features[0].get("geometry") if isinstance(features[0], dict) else None
    if not isinstance(geometry, dict) or geometry.get("type") not in {"Polygon", "MultiPolygon"}:
        raise ValueError("isochrone response has no polygon geometry")
    if not geometry.get("coordinates"):
        raise ValueError("isochrone polygon is empty")


def validate_height(payload: Any, min_samples: int) -> None:
    if not isinstance(payload, dict):
        raise ValueError("height response must be an object")
    heights = payload.get("range_height") or payload.get("height")
    if not isinstance(heights, list) or len(heights) < min_samples:
        raise ValueError(f"height response has fewer than {min_samples} samples")
    values: list[Any] = []
    for item in heights:
        if isinstance(item, list) and len(item) >= 2:
            values.append(item[1])
        else:
            values.append(item)
    if not all(finite_number(value) for value in values):
        raise ValueError("height response contains a missing or non-finite elevation")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=("status", "route", "locate", "isochrone", "height"))
    parser.add_argument("response", type=Path)
    parser.add_argument("--max-km", type=float, default=1000.0)
    parser.add_argument("--max-snap-m", type=float, default=2500.0)
    parser.add_argument("--min-samples", type=int, default=2)
    parser.add_argument("--expected-admins", default="")
    parser.add_argument("--from-lat", type=float)
    parser.add_argument("--from-lon", type=float)
    parser.add_argument("--to-lat", type=float)
    parser.add_argument("--to-lon", type=float)
    parser.add_argument("--require-elevation", action="store_true")
    args = parser.parse_args()

    try:
        payload = load_json(args.response)
        if args.kind == "status":
            validate_status(payload)
        elif args.kind == "route":
            endpoint_values = (args.from_lat, args.from_lon, args.to_lat, args.to_lon)
            endpoints = None if any(value is None for value in endpoint_values) else tuple(float(value) for value in endpoint_values)
            validate_route(
                payload,
                args.max_km,
                {value.strip().upper() for value in args.expected_admins.split(",") if value.strip()},
                endpoints,
                args.max_snap_m,
                args.require_elevation,
            )
        elif args.kind == "locate":
            validate_locate(payload, args.max_snap_m)
        elif args.kind == "isochrone":
            validate_isochrone(payload)
        else:
            validate_height(payload, args.min_samples)
    except ValueError as exc:
        print(exc)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
