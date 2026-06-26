#!/usr/bin/env python3
"""Smoke-test the SIM provider gateway contract used by COP."""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class SmokeError(RuntimeError):
    pass


@dataclass
class Response:
    url: str
    status: int
    body: bytes
    elapsed_ms: int


class Client:
    def __init__(self, base_url: str, timeout_seconds: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def resolve_url(self, path_or_url: str) -> str:
        if path_or_url.startswith("http://") or path_or_url.startswith("https://"):
            return path_or_url
        if not path_or_url.startswith("/"):
            path_or_url = "/" + path_or_url
        return self.base_url + path_or_url

    def request(self, path_or_url: str, headers: dict[str, str] | None = None) -> Response:
        url = self.resolve_url(path_or_url)
        request = Request(url, headers=headers or {})
        start = time.monotonic()
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                body = response.read()
                status = response.status
        except HTTPError as exc:
            body = exc.read()
            status = exc.code
        except URLError as exc:
            raise SmokeError(f"{url}: network error: {exc}") from exc
        elapsed_ms = int((time.monotonic() - start) * 1000)
        return Response(url=url, status=status, body=body, elapsed_ms=elapsed_ms)

    def json(self, path_or_url: str) -> tuple[dict[str, Any], Response]:
        response = self.request(path_or_url, {"Accept": "application/json"})
        require(response.status == 200, f"{response.url}: expected HTTP 200, got {response.status}")
        try:
            payload = json.loads(response.body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            preview = response.body[:200].decode("utf-8", errors="replace")
            raise SmokeError(f"{response.url}: invalid JSON: {preview}") from exc
        require(isinstance(payload, dict), f"{response.url}: expected JSON object")
        return payload, response


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeError(message)


def link_href(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        href = value.get("href") or value.get("url") or value.get("path")
        return href if isinstance(href, str) else None
    return None


def query_path(path: str, params: dict[str, str | int]) -> str:
    return path + "?" + urlencode(params)


def check_health(client: Client) -> dict[str, str]:
    endpoints = {
        "root": "/health/live",
        "flight": "/flight-data/health/ready",
        "situation": "/situation-data/health/ready",
        "safety": "/safety-data/health/ready",
        "tak": "/tak-gateway/health/ready",
    }
    statuses: dict[str, str] = {}
    for name, path in endpoints.items():
        payload, _response = client.json(path)
        status = payload.get("status")
        require(status == "ok", f"{path}: expected status=ok, got {status!r}")
        statuses[name] = status
    return statuses


def check_taxonomy(client: Client, path: str, provider_id: str, required_tokens: list[str]) -> dict[str, Any]:
    payload, response = client.json(path)
    require(payload.get("providerId") == provider_id, f"{path}: unexpected providerId {payload.get('providerId')!r}")
    text = json.dumps(payload, ensure_ascii=False)
    for token in required_tokens:
        require(token in text, f"{path}: missing taxonomy token {token}")
    taxonomies = payload.get("taxonomies")
    require(isinstance(taxonomies, list) and taxonomies, f"{path}: missing taxonomies")
    return {
        "url": response.url,
        "taxonomyCount": len(taxonomies),
    }


def check_feature_flow(client: Client, label: str, summary_paths: list[str]) -> dict[str, Any]:
    tried: list[dict[str, Any]] = []
    selected_payload: dict[str, Any] | None = None
    selected_response: Response | None = None

    for path in summary_paths:
        payload, response = client.json(path)
        features = payload.get("features")
        count = len(features) if isinstance(features, list) else 0
        tried.append({"url": response.url, "features": count, "elapsedMs": response.elapsed_ms})
        if count > 0:
            selected_payload = payload
            selected_response = response
            break

    require(selected_payload is not None and selected_response is not None, f"{label}: no features returned: {tried}")
    feature = selected_payload["features"][0]
    require(isinstance(feature, dict), f"{label}: summary feature is not an object")
    require("geometry" not in feature, f"{label}: summary exposes full geometry")
    geometry_summary = feature.get("geometrySummary")
    require(isinstance(geometry_summary, dict), f"{label}: summary missing geometrySummary")
    require("coordinates" not in geometry_summary, f"{label}: geometrySummary exposes coordinates")

    feature_id = feature.get("featureId")
    require(isinstance(feature_id, str) and feature_id, f"{label}: missing featureId")
    links = feature.get("links")
    require(isinstance(links, dict), f"{label}: missing links")
    detail_link = link_href(links.get("detail"))
    geometry_link = link_href(links.get("geometry"))
    require(detail_link is not None, f"{label}: missing detail link")
    require(geometry_link is not None, f"{label}: missing geometry link")
    require("?" in detail_link, f"{label}: detail link does not preserve query context")
    require("?" in geometry_link, f"{label}: geometry link does not preserve query context")

    detail_payload, detail_response = client.json(detail_link)
    detail_summary = detail_payload.get("summary")
    require(isinstance(detail_summary, dict), f"{label}: detail missing summary")
    require(detail_summary.get("featureId") == feature_id, f"{label}: detail featureId mismatch")
    properties = detail_payload.get("properties")
    require(isinstance(properties, dict), f"{label}: detail missing properties")
    require("raw" not in properties, f"{label}: detail exposes properties.raw")

    geometry_payload, geometry_response = client.json(geometry_link)
    require(geometry_payload.get("featureId") == feature_id, f"{label}: geometry featureId mismatch")
    require(isinstance(geometry_payload.get("geometry"), dict), f"{label}: geometry document missing geometry")
    require(isinstance(geometry_payload.get("geometrySummary"), dict), f"{label}: geometry document missing geometrySummary")

    return {
        "summaryUrl": selected_response.url,
        "featureId": feature_id,
        "sourceId": feature.get("sourceId"),
        "layer": feature.get("layer"),
        "typeCode": feature.get("typeCode"),
        "detailUrl": detail_response.url,
        "geometryUrl": geometry_response.url,
        "tried": tried,
    }


def check_public_access_control(client: Client, public_ip: str) -> dict[str, int]:
    headers = {"X-Forwarded-For": public_ip}
    checks = {
        "provider": ("/safety-data/api/v1/taxonomy", 403),
        "root": ("/", 403),
        "health": ("/health/live", 200),
    }
    statuses: dict[str, int] = {}
    for name, (path, expected_status) in checks.items():
        response = client.request(path, headers)
        require(response.status == expected_status, f"{path}: expected HTTP {expected_status}, got {response.status}")
        statuses[name] = response.status
    return statuses


def run(args: argparse.Namespace) -> dict[str, Any]:
    client = Client(args.base_url, args.timeout_seconds)
    result: dict[str, Any] = {
        "baseUrl": args.base_url.rstrip("/"),
        "health": check_health(client),
        "safetyTaxonomy": check_taxonomy(
            client,
            "/safety-data/api/v1/taxonomy",
            "sim.safety-data",
            ["chmi.sivs", "weather.temperature.high", "hydro.flood.warning", "air_quality.pm10"],
        ),
        "situationTaxonomy": check_taxonomy(
            client,
            "/situation-data/api/v1/taxonomy",
            "sim.situation-data",
            ["sim.situation.geometry_roles", "raster_extent"],
        ),
        "safetyFlow": check_feature_flow(
            client,
            "safety",
            [
                query_path("/safety-data/api/v1/features/summary", {"layers": "weather_alerts", "source": "chmi_alerts", "limit": 3}),
                query_path("/safety-data/api/v1/features/summary", {"layers": "flood", "source": "chmi_hydro", "limit": 3}),
                query_path("/safety-data/api/v1/features/summary", {"limit": 3}),
            ],
        ),
        "situationFlow": check_feature_flow(
            client,
            "situation",
            [
                query_path(
                    "/situation-data/api/v1/features/summary",
                    {"layers": "weather_webcams", "source": "chmi_weather_webcams", "limit": 3},
                ),
                query_path(
                    "/situation-data/api/v1/features/summary",
                    {"layers": "weather", "source": "chmi_weather_stations", "limit": 3},
                ),
                query_path("/situation-data/api/v1/features/summary", {"limit": 3}),
            ],
        ),
    }
    if not args.skip_public_access_control:
        result["publicAccessControl"] = check_public_access_control(client, args.public_ip)
    return result


def parse_args(argv: list[str]) -> argparse.Namespace:
    if argv[:1] == ["--"]:
        argv = argv[1:]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:5020", help="Gateway base URL. Default: %(default)s")
    parser.add_argument("--timeout-seconds", type=float, default=30.0, help="Per-request timeout. Default: %(default)s")
    parser.add_argument("--public-ip", default="203.0.113.10", help="Synthetic public client IP for access-control checks.")
    parser.add_argument("--skip-public-access-control", action="store_true", help="Skip X-Forwarded-For access-control checks.")
    parser.add_argument("--json", action="store_true", help="Print JSON output.")
    parser.add_argument("--quiet", action="store_true", help="Print nothing on success.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        result = run(args)
    except SmokeError as exc:
        print(f"provider gateway smoke failed: {exc}", file=sys.stderr)
        return 1

    if args.quiet:
        return 0
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print("provider gateway smoke passed")
        print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
