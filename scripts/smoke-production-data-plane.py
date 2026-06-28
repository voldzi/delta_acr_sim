#!/usr/bin/env python3
"""Smoke-test SIM production data-plane sources used by COP."""

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

    def json(self, path_or_url: str) -> tuple[dict[str, Any], Response]:
        url = self.resolve_url(path_or_url)
        request = Request(url, headers={"Accept": "application/json"})
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
        response = Response(url=url, status=status, body=body, elapsed_ms=elapsed_ms)
        require(status == 200, f"{url}: expected HTTP 200, got {status}")
        try:
            payload = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            preview = body[:200].decode("utf-8", errors="replace")
            raise SmokeError(f"{url}: invalid JSON: {preview}") from exc
        require(isinstance(payload, dict), f"{url}: expected JSON object")
        return payload, response


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeError(message)


def query_path(path: str, params: dict[str, str | int]) -> str:
    return path + "?" + urlencode(params)


def no_cache(params: dict[str, str | int]) -> dict[str, str | int]:
    return {"nocache": 1, **params}


def source_health(payload: dict[str, Any], source_id: str) -> dict[str, Any]:
    sources = payload.get("sourceHealth")
    require(isinstance(sources, list), "situation health: missing sourceHealth")
    for source in sources:
        if isinstance(source, dict) and source.get("sourceId") == source_id:
            return source
    raise SmokeError(f"situation health: missing sourceHealth for {source_id}")


def feature_collection_count(payload: dict[str, Any], label: str) -> int:
    require(payload.get("type") == "FeatureCollection", f"{label}: expected FeatureCollection")
    features = payload.get("features")
    require(isinstance(features, list), f"{label}: missing features array")
    summary = payload.get("summary")
    if isinstance(summary, dict):
        count = summary.get("featureCount")
        if isinstance(count, int):
            return count
    return len(features)


def require_features(
    client: Client,
    label: str,
    path: str,
    expected_source_id: str | None = None,
    expected_layer_id_prefix: str | None = None,
) -> dict[str, Any]:
    payload, response = client.json(path)
    count = feature_collection_count(payload, label)
    require(count > 0, f"{label}: expected at least one feature")
    feature = payload["features"][0]
    require(isinstance(feature, dict), f"{label}: first feature is not an object")
    properties = feature.get("properties")
    require(isinstance(properties, dict), f"{label}: first feature missing properties")
    if expected_source_id is not None:
        require(properties.get("sourceId") == expected_source_id, f"{label}: unexpected sourceId {properties.get('sourceId')!r}")
    if expected_layer_id_prefix is not None:
        layer_id = properties.get("layerId")
        require(isinstance(layer_id, str) and layer_id.startswith(expected_layer_id_prefix), f"{label}: unexpected layerId {layer_id!r}")
    warnings = payload.get("warnings")
    require(not warnings, f"{label}: unexpected warnings: {warnings}")
    return {
        "url": response.url,
        "elapsedMs": response.elapsed_ms,
        "featureCount": count,
        "firstFeatureId": properties.get("featureId") or feature.get("id"),
        "firstLabel": properties.get("label"),
        "firstLayerId": properties.get("layerId"),
    }


def optional_features(client: Client, label: str, path: str, reason: str) -> dict[str, Any]:
    payload, response = client.json(path)
    count = feature_collection_count(payload, label)
    if count == 0:
        return {
            "url": response.url,
            "elapsedMs": response.elapsed_ms,
            "featureCount": 0,
            "warning": reason,
            "providerWarnings": payload.get("warnings") if isinstance(payload.get("warnings"), list) else [],
        }
    feature = payload["features"][0]
    properties = feature.get("properties") if isinstance(feature, dict) else None
    require(isinstance(properties, dict), f"{label}: first feature missing properties")
    return {
        "url": response.url,
        "elapsedMs": response.elapsed_ms,
        "featureCount": count,
        "firstFeatureId": properties.get("featureId") or feature.get("id"),
        "firstLabel": properties.get("label"),
        "firstLayerId": properties.get("layerId"),
        "readModel": properties.get("readModel"),
    }


def require_density(client: Client, label: str, path: str) -> dict[str, Any]:
    payload, response = client.json(path)
    require(payload.get("contractVersion") == "sim-provider-feature-density-v1", f"{label}: unexpected density contractVersion")
    require(payload.get("type") == "FeatureCollection", f"{label}: expected FeatureCollection")
    density = payload.get("density")
    require(isinstance(density, dict), f"{label}: missing density metadata")
    require(density.get("omittedOriginalGeometry") is True, f"{label}: density response must omit original geometry")
    require(int(density.get("inputFeatureCount") or 0) > 0, f"{label}: expected positive inputFeatureCount")
    require(int(density.get("cellCount") or 0) > 0, f"{label}: expected positive cellCount")
    features = payload.get("features")
    require(isinstance(features, list) and features, f"{label}: missing density cells")
    first_cell = features[0]
    require(isinstance(first_cell, dict), f"{label}: first density cell is not an object")
    geometry = first_cell.get("geometry")
    require(isinstance(geometry, dict) and geometry.get("type") == "Polygon", f"{label}: first density cell is not a polygon")
    properties = first_cell.get("properties")
    require(isinstance(properties, dict), f"{label}: first density cell missing properties")
    require(properties.get("category") == "density_cell", f"{label}: unexpected first density category")
    require("raw" not in properties, f"{label}: density cell exposes raw payload")
    return {
        "url": response.url,
        "elapsedMs": response.elapsed_ms,
        "cellCount": density.get("cellCount"),
        "inputFeatureCount": density.get("inputFeatureCount"),
        "firstCellId": first_cell.get("id"),
        "firstCellFeatureCount": properties.get("featureCount"),
    }


def check_situation_data(client: Client, args: argparse.Namespace) -> dict[str, Any]:
    health, health_response = client.json("/situation-data/health/ready")
    require(health.get("status") == "ok", f"situation health: expected ok, got {health.get('status')!r}")

    osm = source_health(health, "osm_postgis")
    require(osm.get("status") == "ok", f"osm_postgis health: expected ok, got {osm.get('status')!r}")
    require(osm.get("backend") not in (None, "", "unconfigured"), f"osm_postgis health: invalid backend {osm.get('backend')!r}")
    require(int(osm.get("objectCount") or 0) >= args.min_osm_poi, f"osm_postgis health: objectCount below {args.min_osm_poi}")
    require(
        int(osm.get("boundaryFeatureCount") or 0) >= args.min_osm_boundaries,
        f"osm_postgis health: boundaryFeatureCount below {args.min_osm_boundaries}",
    )

    coverage = source_health(health, "mobile_coverage_model")
    require(coverage.get("status") == "ok", f"mobile_coverage_model health: expected ok, got {coverage.get('status')!r}")
    network = source_health(health, "mobile_network_model")
    require(network.get("status") == "ok", f"mobile_network_model health: expected ok, got {network.get('status')!r}")

    osm_features = require_features(
        client,
        "osm infrastructure",
        query_path(
            "/situation-data/api/v1/features",
            no_cache({"bbox": args.bbox, "layers": "ground,mobile", "source": "osm_postgis", "limit": 5}),
        ),
        expected_source_id="osm_postgis",
        expected_layer_id_prefix="reference.infrastructure.",
    )
    osm_boundaries = require_features(
        client,
        "osm boundaries",
        query_path(
            "/situation-data/api/v1/features",
            no_cache({
                "bbox": args.boundary_bbox,
                "layers": "boundary_region,boundary_district,boundary_orp,place_settlements",
                "source": "osm_postgis",
                "limit": 5,
            }),
        ),
        expected_source_id="osm_postgis",
    )
    mobile_coverage = require_features(
        client,
        "mobile coverage",
        query_path(
            "/situation-data/api/v1/features",
            no_cache({"bbox": args.bbox, "layers": "mobile_coverage", "source": "mobile_coverage_model", "technology": "4G", "limit": 5}),
        ),
        expected_source_id="mobile_coverage_model",
        expected_layer_id_prefix="diagnostic.mobile.coverage",
    )
    mobile_network = optional_features(
        client,
        "mobile network",
        query_path(
            "/situation-data/api/v1/features",
            no_cache({"bbox": args.bbox, "layers": "mobile_network", "source": "mobile_network_model", "technology": "4G", "limit": 5}),
        ),
        "mobile_network_model has no features until prepared mobile coverage read-model cells exist for the requested area",
    )
    density = require_density(
        client,
        "situation density",
        query_path(
            "/situation-data/api/v1/features/density",
            no_cache({"bbox": args.bbox, "limit": 50, "cellSizeDegrees": "0.5", "sampleSize": 2}),
        ),
    )

    coverage_payload, metadata_response = client.json("/situation-data/api/v1/mobile-coverage/metadata?nocache=1")
    coverage_text = json.dumps(coverage_payload, ensure_ascii=False)
    require("mobile_coverage" in coverage_text, "mobile coverage metadata: missing mobile_coverage marker")

    read_model = bool(coverage.get("objectCount"))
    coverage_warnings = coverage.get("warnings")
    read_model_warning = None
    if isinstance(coverage_warnings, list) and any("read-model table is empty" in str(item) for item in coverage_warnings):
        read_model = False
        read_model_warning = "mobile_coverage_model is using on-demand fallback because the read-model table is empty"
    if args.require_mobile_coverage_read_model:
        require(read_model, read_model_warning or "mobile_coverage_model read-model is not confirmed")
        require(
            int(mobile_network.get("featureCount") or 0) > 0,
            "mobile_network_model returned no features even though read-model is required",
        )

    return {
        "healthUrl": health_response.url,
        "status": health.get("status"),
        "osm": {
            "backend": osm.get("backend"),
            "objectCount": osm.get("objectCount"),
            "boundaryFeatureCount": osm.get("boundaryFeatureCount"),
            "lastImportAt": osm.get("lastImportAt"),
        },
        "mobileCoverage": {
            "objectCount": coverage.get("objectCount"),
            "readModelConfirmed": read_model,
            "warning": read_model_warning,
        },
        "checks": {
            "osmFeatures": osm_features,
            "osmBoundaries": osm_boundaries,
            "mobileCoverage": mobile_coverage,
            "mobileNetwork": mobile_network,
            "density": density,
            "mobileCoverageMetadata": {"url": metadata_response.url, "elapsedMs": metadata_response.elapsed_ms},
        },
    }


def check_safety_data(client: Client, args: argparse.Namespace) -> dict[str, Any]:
    health, health_response = client.json("/safety-data/health/ready")
    require(health.get("status") == "ok", f"safety health: expected ok, got {health.get('status')!r}")
    boundary = require_features(
        client,
        "safety admin boundaries",
        query_path(
            "/safety-data/api/v1/features",
            no_cache({"bbox": args.boundary_bbox, "layers": "boundary_admin", "source": "admin_boundaries", "limit": 5}),
        ),
        expected_source_id="admin_boundaries",
    )
    return {"healthUrl": health_response.url, "status": health.get("status"), "checks": {"adminBoundaries": boundary}}


def check_cop_catalog(args: argparse.Namespace) -> dict[str, Any] | None:
    if not args.cop_base_url:
        return None
    client = Client(args.cop_base_url, args.timeout_seconds)
    catalog, response = client.json("/api/v1/map/catalog")
    sources = catalog.get("sources")
    layers = catalog.get("layers")
    require(isinstance(sources, list), "COP catalog: missing sources")
    require(isinstance(layers, list), "COP catalog: missing layers")
    osm_source = next((source for source in sources if isinstance(source, dict) and source.get("sourceId") == "osm_postgis"), None)
    require(isinstance(osm_source, dict), "COP catalog: missing osm_postgis source")
    require(osm_source.get("enabled") is True, f"COP catalog: osm_postgis source not enabled: {osm_source!r}")
    required_layers = {
        "reference.infrastructure.communications",
        "reference.infrastructure.healthcare",
        "reference.infrastructure.emergency",
        "reference.infrastructure.civic",
        "public.boundary.region",
        "public.boundary.district",
        "public.place.settlements",
    }
    present_layers = {layer.get("layerId") for layer in layers if isinstance(layer, dict)}
    missing = sorted(required_layers - present_layers)
    require(not missing, f"COP catalog: missing OSM-backed layers: {missing}")
    return {
        "url": response.url,
        "source": {
            "providerId": osm_source.get("providerId"),
            "sourceId": osm_source.get("sourceId"),
            "label": osm_source.get("label"),
            "selectableInMap": osm_source.get("selectableInMap"),
        },
        "requiredLayers": sorted(required_layers),
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    client = Client(args.base_url, args.timeout_seconds)
    result: dict[str, Any] = {
        "baseUrl": args.base_url.rstrip("/"),
        "situationData": check_situation_data(client, args),
        "safetyData": check_safety_data(client, args),
    }
    cop_catalog = check_cop_catalog(args)
    if cop_catalog is not None:
        result["copCatalog"] = cop_catalog
    return result


def parse_args(argv: list[str]) -> argparse.Namespace:
    if argv[:1] == ["--"]:
        argv = argv[1:]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:5020", help="SIM gateway base URL. Default: %(default)s")
    parser.add_argument("--cop-base-url", default="", help="Optional COP API base URL for catalog checks, for example http://127.0.0.1:4310.")
    parser.add_argument("--timeout-seconds", type=float, default=30.0, help="Per-request timeout. Default: %(default)s")
    parser.add_argument("--bbox", default="13.8,49.8,15.4,50.4", help="Operational bbox for feature smoke checks.")
    parser.add_argument("--boundary-bbox", default="12,48,19,51", help="Larger bbox for administrative boundary checks.")
    parser.add_argument("--min-osm-poi", type=int, default=1000, help="Minimum acceptable OSM POI count in readiness.")
    parser.add_argument("--min-osm-boundaries", type=int, default=100, help="Minimum acceptable OSM boundary count in readiness.")
    parser.add_argument("--require-mobile-coverage-read-model", action="store_true", help="Fail if mobile coverage falls back to on-demand generation.")
    parser.add_argument("--json", action="store_true", help="Print full JSON output.")
    parser.add_argument("--quiet", action="store_true", help="Print nothing on success.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        result = run(args)
    except SmokeError as exc:
        print(f"production data-plane smoke failed: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    elif not args.quiet:
        print("production data-plane smoke passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
