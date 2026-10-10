#!/usr/bin/env python3
"""Run periodic production checks and emit state-change alerts for CSM SIM."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from valhalla_operational_monitor import evaluate_valhalla_snapshot


ROOT_DIR = Path(os.environ.get('SIM_OPERATIONAL_ROOT', str(Path(__file__).resolve().parents[1])))
X5_ROOT = Path('/srv/x5-production')
X5_UUID = '2f93f595-b61b-4eea-9054-7afa9b275b5b'


class OperationalCheckError(RuntimeError):
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
            raise OperationalCheckError(f"{url}: network error: {exc}") from exc
        elapsed_ms = int((time.monotonic() - start) * 1000)
        return Response(url=url, status=status, body=body, elapsed_ms=elapsed_ms)

    def json(self, path_or_url: str, headers: dict[str, str] | None = None) -> tuple[dict[str, Any], Response]:
        request_headers = {"Accept": "application/json"}
        if headers:
            request_headers.update(headers)
        response = self.request(path_or_url, request_headers)
        require(response.status == 200, f"{response.url}: expected HTTP 200, got {response.status}")
        try:
            payload = json.loads(response.body.decode("utf-8"))
        except json.JSONDecodeError as exc:
            preview = response.body[:200].decode("utf-8", errors="replace")
            raise OperationalCheckError(f"{response.url}: invalid JSON: {preview}") from exc
        require(isinstance(payload, dict), f"{response.url}: expected JSON object")
        return payload, response


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise OperationalCheckError(message)


def env_bool(value: str | None, default: bool) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def env_int(value: str | None, default: int) -> int:
    if value is None or value == "":
        return default
    try:
        parsed = int(value)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


def env_float(value: str | None, default: float) -> float:
    if value is None or value == "":
        return default
    try:
        parsed = float(value)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


def parse_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key] = value
    return values


def env_value(env_file_values: dict[str, str], key: str, default: str = "") -> str:
    value = os.environ.get(key)
    if value is not None:
        return value
    return env_file_values.get(key, default)


def unquote_env_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def query_path(path: str, params: dict[str, str | int]) -> str:
    return path + "?" + urlencode(params)


def no_cache(params: dict[str, str | int]) -> dict[str, str | int]:
    return {"nocache": 1, **params}


def run_command(label: str, command: list[str], timeout_seconds: float) -> dict[str, Any]:
    start = time.monotonic()
    try:
        completed = subprocess.run(
            command,
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise OperationalCheckError(f"{label}: timed out after {timeout_seconds:.0f}s") from exc
    elapsed_ms = int((time.monotonic() - start) * 1000)
    if completed.returncode != 0:
        stderr = completed.stderr.strip()
        stdout = completed.stdout.strip()
        detail = stderr or stdout or f"exit code {completed.returncode}"
        raise OperationalCheckError(f"{label}: {detail[-4000:]}")
    return {
        "elapsedMs": elapsed_ms,
        "command": command[0],
        "stdoutPreview": completed.stdout.strip()[-1000:] if completed.stdout.strip() else "",
    }


def check_provider_gateway_smoke(args: argparse.Namespace) -> dict[str, Any]:
    command = [
        sys.executable,
        "scripts/smoke-provider-gateway.py",
        "--base-url",
        args.base_url,
        "--timeout-seconds",
        str(args.timeout_seconds),
        "--quiet",
    ]
    for service in args.allow_degraded_health:
        command.extend(["--allow-degraded-health", service])
    return run_command("provider gateway smoke", command, args.command_timeout_seconds)


def check_data_plane_smoke(args: argparse.Namespace) -> dict[str, Any]:
    command = [
        sys.executable,
        "scripts/smoke-production-data-plane.py",
        "--base-url",
        args.base_url,
        "--bbox",
        args.bbox,
        "--boundary-bbox",
        args.boundary_bbox,
        "--min-osm-poi",
        str(args.min_osm_poi),
        "--min-osm-boundaries",
        str(args.min_osm_boundaries),
        "--timeout-seconds",
        str(args.timeout_seconds),
        "--require-mobile-coverage-read-model",
        "--quiet",
    ]
    return run_command("production data-plane smoke", command, args.command_timeout_seconds)


def check_metrics_are_internal(client: Client) -> dict[str, Any]:
    response = client.request("/metrics")
    require(response.status == 404, f"/metrics: expected HTTP 404 through sim-web, got {response.status}")
    return {"url": response.url, "status": response.status, "elapsedMs": response.elapsed_ms}


def check_operations_slo(client: Client, args: argparse.Namespace) -> dict[str, Any]:
    live_response = client.request("/health/live", {"Accept": "application/json"})
    require(live_response.status == 200, f"/health/live: expected HTTP 200, got {live_response.status}")
    require(
        live_response.elapsed_ms <= args.slo_max_live_latency_ms,
        f"/health/live latency {live_response.elapsed_ms}ms exceeds SLO {args.slo_max_live_latency_ms}ms",
    )

    summary_headers = {"Authorization": f"Bearer {args.api_token}"} if args.api_token else {}
    summary, summary_response = client.json("/api/v1/operations/summary", summary_headers)
    require(
        summary_response.elapsed_ms <= args.slo_max_summary_latency_ms,
        f"/api/v1/operations/summary latency {summary_response.elapsed_ms}ms exceeds SLO {args.slo_max_summary_latency_ms}ms",
    )
    status = str(summary.get("status") or "unknown")
    alerts = summary.get("alerts") if isinstance(summary.get("alerts"), list) else []
    blocking_alerts = [
        alert
        for alert in alerts
        if isinstance(alert, dict)
        and alert.get("severity") in {"critical", "warning"}
        and alert.get("code") != "operational_check_failed"
    ]
    if args.slo_require_operations_ok:
        require(status == "ok" or not blocking_alerts, f"operations summary status is {status!r}, expected 'ok'")
    else:
        require(status != "critical" or not blocking_alerts, "operations summary status is 'critical'")

    services = summary.get("services") if isinstance(summary.get("services"), list) else []
    readiness_services = [service for service in services if isinstance(service, dict) and service.get("productionReadiness") is not False]
    non_ok_services = [
        f"{service.get('serviceId') or service.get('label') or 'service'}={service.get('status') or 'unknown'}"
        for service in readiness_services
        if service.get("status") != "ok"
    ]
    require(not non_ok_services, "production readiness services not ok: " + ", ".join(non_ok_services))

    alert_counts = {
        "critical": sum(1 for alert in alerts if isinstance(alert, dict) and alert.get("severity") == "critical"),
        "warning": sum(1 for alert in alerts if isinstance(alert, dict) and alert.get("severity") == "warning"),
        "info": sum(1 for alert in alerts if isinstance(alert, dict) and alert.get("severity") == "info"),
    }
    blocking_alert_counts = {
        "critical": sum(1 for alert in blocking_alerts if alert.get("severity") == "critical"),
        "warning": sum(1 for alert in blocking_alerts if alert.get("severity") == "warning"),
    }
    require(blocking_alert_counts["critical"] == 0, f"operations summary reports {blocking_alert_counts['critical']} blocking critical alert(s)")
    require(blocking_alert_counts["warning"] == 0, f"operations summary reports {blocking_alert_counts['warning']} blocking warning alert(s)")

    future_services = [service for service in services if isinstance(service, dict) and service.get("productionReadiness") is False]
    return {
        "status": status,
        "liveLatencyMs": live_response.elapsed_ms,
        "summaryLatencyMs": summary_response.elapsed_ms,
        "authenticated": bool(args.api_token),
        "productionReadinessServices": len(readiness_services),
        "futureServicesExcluded": len(future_services),
        "alertCounts": alert_counts,
        "blockingAlertCounts": blocking_alert_counts,
        "ignoredAlertCodes": ["operational_check_failed"],
        "thresholds": {
            "maxLiveLatencyMs": args.slo_max_live_latency_ms,
            "maxSummaryLatencyMs": args.slo_max_summary_latency_ms,
            "requireOperationsOk": args.slo_require_operations_ok,
        },
    }


def check_dem_health(client: Client, args: argparse.Namespace) -> dict[str, Any]:
    health, response = client.json("/situation-data/health/ready")
    require(health.get("status") == "ok", f"situation-data readiness is {health.get('status')!r}")
    dem = health.get("dem")
    require(isinstance(dem, dict), "situation-data readiness is missing dem block")
    require(dem.get("enabled") is True, f"DEM is not enabled: {dem.get('enabled')!r}")
    require(dem.get("status") == "ok", f"DEM status is {dem.get('status')!r}")
    require(dem.get("datasetId") == args.expected_dem_source, f"DEM dataset is {dem.get('datasetId')!r}")
    tile_count = int(dem.get("tileCount") or 0)
    local_count = int(dem.get("localTileCount") or 0)
    object_count = int(dem.get("objectStoreTileCount") or 0)
    require(tile_count >= args.min_dem_tiles, f"DEM tileCount below {args.min_dem_tiles}: {tile_count}")
    require(local_count >= args.min_dem_tiles, f"DEM localTileCount below {args.min_dem_tiles}: {local_count}")
    require(object_count >= args.min_dem_tiles, f"DEM objectStoreTileCount below {args.min_dem_tiles}: {object_count}")
    warnings = dem.get("warnings")
    require(not warnings, f"DEM warnings present: {warnings}")
    return {
        "url": response.url,
        "elapsedMs": response.elapsed_ms,
        "datasetId": dem.get("datasetId"),
        "status": dem.get("status"),
        "tileCount": tile_count,
        "localTileCount": local_count,
        "objectStoreTileCount": object_count,
        "bbox": dem.get("bbox"),
    }


def feature_collection_features(payload: dict[str, Any], label: str) -> list[dict[str, Any]]:
    require(payload.get("type") == "FeatureCollection", f"{label}: expected FeatureCollection")
    features = payload.get("features")
    require(isinstance(features, list), f"{label}: missing features")
    require(features, f"{label}: expected at least one feature")
    require(all(isinstance(feature, dict) for feature in features), f"{label}: feature array contains non-objects")
    return features


def check_terrain_aware_mobile_coverage(client: Client, args: argparse.Namespace) -> dict[str, Any]:
    payload, response = client.json(
        query_path(
            "/situation-data/api/v1/features",
            no_cache(
                {
                    "bbox": args.terrain_bbox,
                    "layers": "mobile_coverage",
                    "source": "mobile_coverage_model",
                    "technology": "4G",
                    "limit": 3,
                }
            ),
        )
    )
    features = feature_collection_features(payload, "terrain-aware mobile coverage")
    feature = features[0]
    properties = feature.get("properties")
    require(isinstance(properties, dict), "terrain-aware mobile coverage: first feature missing properties")
    assumptions = properties.get("assumptions")
    require(isinstance(assumptions, dict), "terrain-aware mobile coverage: missing assumptions")
    metrics = properties.get("metrics")
    require(isinstance(metrics, dict), "terrain-aware mobile coverage: missing metrics")
    require(properties.get("readModel") is True, f"terrain-aware mobile coverage: readModel is {properties.get('readModel')!r}")
    require(
        properties.get("modelVersion") == args.expected_mobile_model_version,
        f"terrain-aware mobile coverage: modelVersion is {properties.get('modelVersion')!r}",
    )
    require(properties.get("demSource") == args.expected_dem_source, f"terrain-aware mobile coverage: demSource is {properties.get('demSource')!r}")
    require(assumptions.get("terrainAware") is True, f"terrain-aware mobile coverage: terrainAware is {assumptions.get('terrainAware')!r}")
    require(
        assumptions.get("terrainDataAvailable") is True,
        f"terrain-aware mobile coverage: terrainDataAvailable is {assumptions.get('terrainDataAvailable')!r}",
    )
    require(assumptions.get("terrainApplied") is True, f"terrain-aware mobile coverage: terrainApplied is {assumptions.get('terrainApplied')!r}")
    require(metrics.get("terrainSamples") is not None, "terrain-aware mobile coverage: terrainSamples missing")
    return {
        "url": response.url,
        "elapsedMs": response.elapsed_ms,
        "featureCount": len(features),
        "featureId": properties.get("featureId") or feature.get("id"),
        "modelVersion": properties.get("modelVersion"),
        "demSource": properties.get("demSource"),
        "sourceRevision": properties.get("sourceRevision"),
        "terrain": {
            "terrainAware": assumptions.get("terrainAware"),
            "terrainDataAvailable": assumptions.get("terrainDataAvailable"),
            "terrainApplied": assumptions.get("terrainApplied"),
            "propagationModel": assumptions.get("propagationModel"),
            "terrainSamples": metrics.get("terrainSamples"),
            "terrainPenaltyDb": metrics.get("terrainPenaltyDb"),
        },
    }


def check_mobile_network_read_model(client: Client, args: argparse.Namespace) -> dict[str, Any]:
    payload, response = client.json(
        query_path(
            "/situation-data/api/v1/features",
            no_cache(
                {
                    "bbox": args.terrain_bbox,
                    "layers": "mobile_network",
                    "source": "mobile_network_model",
                    "technology": "4G",
                    "limit": 3,
                }
            ),
        )
    )
    features = feature_collection_features(payload, "mobile network read-model")
    feature = features[0]
    properties = feature.get("properties")
    require(isinstance(properties, dict), "mobile network read-model: first feature missing properties")
    require(properties.get("readModel") is True, f"mobile network read-model: readModel is {properties.get('readModel')!r}")
    return {
        "url": response.url,
        "elapsedMs": response.elapsed_ms,
        "featureCount": len(features),
        "featureId": properties.get("featureId") or feature.get("id"),
        "quality": properties.get("quality"),
        "status": properties.get("status"),
        "dataQuality": properties.get("dataQuality"),
    }


def run_named_check(name: str, check: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    started = time.monotonic()
    try:
        details = check()
    except Exception as exc:
        return {
            "status": "failed",
            "elapsedMs": int((time.monotonic() - started) * 1000),
            "error": str(exc),
        }
    elapsed_ms = int((time.monotonic() - started) * 1000)
    if "status" in details:
        details["observedStatus"] = details.pop("status")
    if "elapsedMs" not in details:
        details["elapsedMs"] = elapsed_ms
    return {"status": "ok", **details}


def read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def write_json(path: Path, payload: dict[str, Any]) -> None:
    guard_report_mount(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Readers must never observe a partial report. Temporary files contain no secrets.
    fd, name = tempfile.mkstemp(prefix='.operational-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            json.dump(payload, output, ensure_ascii=False, indent=2, sort_keys=True)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.chmod(name, 0o644)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def guard_report_mount(path: Path) -> None:
    resolved = path.resolve()
    original = path.absolute()
    if X5_ROOT in original.parents:
        require(X5_ROOT in resolved.parents, 'X5_PATH_INVALID: report path must not escape the X5 disk')
    if X5_ROOT not in resolved.parents and resolved != X5_ROOT:
        return
    try:
        result = subprocess.run(
            ['findmnt', '-n', '-o', 'UUID', '--mountpoint', str(X5_ROOT)],
            capture_output=True, text=True, timeout=5, check=False,
        )
        valid = result.returncode == 0 and result.stdout.strip() == X5_UUID
    except (OSError, subprocess.TimeoutExpired):
        valid = False
    require(valid, 'X5_MOUNT_UNAVAILABLE: refusing to publish an operational report on an unverified disk')


def check_valhalla_monitor(client: Client, args: argparse.Namespace) -> dict[str, Any]:
    """Read only a forced status snapshot; never trigger a route/lease or update."""
    start = time.monotonic()
    failure = {'status': 'failed', 'severity': 'critical', 'error': 'VALHALLA_MONITOR_UNAVAILABLE: nelze ověřit aktualizace a stáří map'}
    try:
        key = args.valhalla_monitor_key.expanduser()
        if not key.is_file() or key.stat().st_mode & 0o077:
            return {**failure, 'elapsedMs': int((time.monotonic() - start) * 1000)}
        command = [
            'ssh', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=5',
            '-o', 'ServerAliveInterval=3', '-o', 'ServerAliveCountMax=2',
            '-i', str(key), 'voldzi@valhalla.home.cz', 'status',
        ]
        # A file bounds captured partner/runtime output; neither stdout nor stderr is logged.
        with tempfile.TemporaryFile() as capture:
            process = subprocess.Popen(command, stdout=capture, stderr=subprocess.DEVNULL)
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
                return {**failure, 'elapsedMs': int((time.monotonic() - start) * 1000)}
            capture.seek(0)
            raw = capture.read(65537)
        if process.returncode != 0 or len(raw) > 65536:
            return {**failure, 'elapsedMs': int((time.monotonic() - start) * 1000)}
        health, _ = client.json('/situation-data/health/ready')
        routing = health.get('routing', {})
        dataset = routing.get('routingDataset', {}) if isinstance(routing, dict) else {}
        graph_built_at = dataset.get('builtAt') if isinstance(dataset, dict) else None
        if not isinstance(graph_built_at, str):
            return {**failure, 'elapsedMs': int((time.monotonic() - start) * 1000)}
        result = evaluate_valhalla_snapshot(raw.decode('utf-8'), graph_built_at=graph_built_at)
        if result['status'] != 'ok':
            result['error'] = '; '.join(f"{item['code']}: {item['error']}" for item in result['failures'])
        result['elapsedMs'] = int((time.monotonic() - start) * 1000)
        return result
    except Exception:
        # Provider payloads, local secret paths, SSH error output and DETAIL stay private.
        return {**failure, 'elapsedMs': int((time.monotonic() - start) * 1000)}


def failure_fingerprint(failures: list[dict[str, str]]) -> str:
    material = json.dumps(failures, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def send_webhook(url: str, payload: dict[str, Any], timeout_seconds: float) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = Request(url, data=body, headers={"Content-Type": "application/json", "Accept": "application/json"}, method="POST")
    start = time.monotonic()
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            response.read()
            status = response.status
    except HTTPError as exc:
        preview = exc.read()[:500].decode("utf-8", errors="replace")
        raise OperationalCheckError(f"webhook HTTP {exc.code}: {preview}") from exc
    except URLError as exc:
        raise OperationalCheckError(f"webhook network error: {exc}") from exc
    elapsed_ms = int((time.monotonic() - start) * 1000)
    require(200 <= status < 400, f"webhook expected 2xx/3xx, got {status}")
    return {"httpStatus": status, "elapsedMs": elapsed_ms}


def log_syslog(message: str) -> None:
    result = subprocess.run(["logger", "-t", "csm-sim-operational-check", message], check=False, timeout=5)
    require(result.returncode == 0, 'SYSLOG_DELIVERY_FAILED')


def maybe_alert(report: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    previous_state = read_json(args.state_file)
    failures = report.get("failures") if isinstance(report.get("failures"), list) else []
    fingerprint = failure_fingerprint(failures)
    previous_status = previous_state.get("status")
    previous_fingerprint = previous_state.get("fingerprint")
    should_send = False
    event_type = ""
    if report["status"] == "failed":
        changed_failure = previous_status != "failed" or previous_fingerprint != fingerprint
        last_delivery = previous_state.get('lastExternalAlertAt', 0)
        due_reminder = bool(last_delivery and time.time() - last_delivery >= args.alert_reminder_seconds)
        retry_external = bool(args.webhook_url and previous_state.get('externalDeliveryFailed'))
        should_send = args.alert_every_failure or changed_failure or due_reminder or retry_external
        event_type = "failure"
    elif previous_status == "failed" and args.alert_on_recovery:
        should_send = True
        event_type = "recovery"
    elif args.webhook_url and previous_state.get('externalDeliveryFailed') and previous_state.get('pendingEventType') == 'recovery' and args.alert_on_recovery:
        should_send = True
        event_type = 'recovery'

    delivery: dict[str, Any] = {"eventType": event_type or "none", "sent": False, "channels": []}
    alert_payload = {
        "eventType": event_type,
        "environment": args.environment,
        "host": report["host"],
        "status": report["status"],
        "severity": "critical" if report["status"] == "failed" else "info",
        "summary": report["summary"],
        "startedAt": report["startedAt"],
        "finishedAt": report["finishedAt"],
        "failures": failures,
        "report": report,
    }

    if should_send:
        message = f"{args.environment} SIM operational check {report['status']}: {report['summary']}"
        if not args.no_syslog:
            try:
                log_syslog(message)
                delivery["channels"].append({"type": "syslog", "status": "ok"})
            except Exception:
                delivery['channels'].append({'type': 'syslog', 'status': 'failed', 'error': 'SYSLOG_DELIVERY_FAILED'})
        if args.webhook_url:
            try:
                webhook_result = send_webhook(args.webhook_url, alert_payload, args.webhook_timeout_seconds)
                delivery["channels"].append({"type": "webhook", "status": "ok", **webhook_result})
            except Exception:
                delivery["channels"].append({"type": "webhook", "status": "failed", "error": 'WEBHOOK_DELIVERY_FAILED: notification was not delivered'})
        delivery["sent"] = any(item.get('status') == 'ok' for item in delivery['channels'])
    external = [item for item in delivery['channels'] if item['type'] == 'webhook']
    external_ok = any(item.get('status') == 'ok' for item in external)
    delivery['userNotificationDelivered'] = external_ok

    state = {
        "status": report["status"],
        "fingerprint": fingerprint,
        "updatedAt": report["finishedAt"],
        "summary": report["summary"],
        "lastExternalAlertAt": time.time() if external_ok else previous_state.get('lastExternalAlertAt', 0),
        "externalDeliveryFailed": bool(external and not external_ok) or (not should_send and bool(previous_state.get('externalDeliveryFailed'))),
        "pendingEventType": event_type if external and not external_ok else '',
    }
    write_json(args.state_file, state)
    return delivery


def build_report(args: argparse.Namespace) -> dict[str, Any]:
    started_at = utc_now()
    started = time.monotonic()
    client = Client(args.base_url, args.timeout_seconds)
    checks: dict[str, dict[str, Any]] = {}

    if args.valhalla_monitor_enabled:
        checks['valhallaUpdates'] = check_valhalla_monitor(client, args)

    checks["metricsInternal"] = run_named_check("metricsInternal", lambda: check_metrics_are_internal(client))
    checks["operationsSlo"] = run_named_check("operationsSlo", lambda: check_operations_slo(client, args))
    if not args.skip_provider_gateway_smoke:
        checks["providerGatewaySmoke"] = run_named_check("providerGatewaySmoke", lambda: check_provider_gateway_smoke(args))
    if not args.skip_data_plane_smoke:
        checks["dataPlaneSmoke"] = run_named_check("dataPlaneSmoke", lambda: check_data_plane_smoke(args))
    if args.require_dem:
        checks["demHealth"] = run_named_check("demHealth", lambda: check_dem_health(client, args))
    if args.require_terrain_aware:
        checks["terrainAwareMobileCoverage"] = run_named_check(
            "terrainAwareMobileCoverage",
            lambda: check_terrain_aware_mobile_coverage(client, args),
        )
        checks["mobileNetworkReadModel"] = run_named_check(
            "mobileNetworkReadModel",
            lambda: check_mobile_network_read_model(client, args),
        )

    duration_ms = int((time.monotonic() - started) * 1000)
    checks["totalDurationSlo"] = {
        "status": "ok" if duration_ms <= args.slo_max_total_duration_ms else "failed",
        "elapsedMs": duration_ms,
        "thresholdMs": args.slo_max_total_duration_ms,
        **({} if duration_ms <= args.slo_max_total_duration_ms else {"error": f"operational check duration {duration_ms}ms exceeds SLO {args.slo_max_total_duration_ms}ms"}),
    }
    failures = [{"check": name, "error": check["error"]} for name, check in checks.items() if check.get("status") != "ok"]
    status = "failed" if failures else "ok"
    summary = "all operational checks passed" if status == "ok" else "; ".join(f"{item['check']}: {item['error']}" for item in failures)
    return {
        "schemaVersion": "sim-operational-check/v1",
        "status": status,
        "summary": summary,
        "startedAt": started_at,
        "finishedAt": utc_now(),
        "durationMs": duration_ms,
        "host": socket.gethostname(),
        "environment": args.environment,
        "baseUrl": args.base_url,
        "bbox": args.bbox,
        "terrainBbox": args.terrain_bbox,
        "slo": {
            "availabilityTarget": args.slo_availability_target,
            "checkIntervalSeconds": args.check_interval_seconds,
            "maxLiveLatencyMs": args.slo_max_live_latency_ms,
            "maxSummaryLatencyMs": args.slo_max_summary_latency_ms,
            "maxTotalDurationMs": args.slo_max_total_duration_ms,
            "requireOperationsOk": args.slo_require_operations_ok,
        },
        "checks": checks,
        "failures": failures,
    }


def resolve_args(args: argparse.Namespace, env_file_values: dict[str, str]) -> argparse.Namespace:
    args.base_url = args.base_url or env_value(env_file_values, "SIM_OPERATIONAL_BASE_URL", "http://127.0.0.1:5020")
    args.environment = args.environment or env_value(env_file_values, "SIM_OPERATIONAL_ALERT_ENVIRONMENT", "docker-home")
    args.bbox = args.bbox or env_value(env_file_values, "SIM_OPERATIONAL_CHECK_BBOX", "11.8,48.5,19.2,51.2")
    args.boundary_bbox = args.boundary_bbox or env_value(env_file_values, "SIM_OPERATIONAL_BOUNDARY_BBOX", "12,48,19,51")
    args.terrain_bbox = args.terrain_bbox or env_value(env_file_values, "SIM_OPERATIONAL_TERRAIN_BBOX", "13.95,50.55,14.08,50.65")
    args.expected_dem_source = args.expected_dem_source or env_value(env_file_values, "SIM_OPERATIONAL_EXPECTED_DEM_SOURCE", "copernicus-glo30-cz")
    args.expected_mobile_model_version = args.expected_mobile_model_version or env_value(
        env_file_values,
        "SIM_OPERATIONAL_EXPECTED_MOBILE_MODEL_VERSION",
        "coverage-v2-terrain",
    )
    args.webhook_url = args.webhook_url or env_value(env_file_values, "SIM_OPERATIONAL_ALERT_WEBHOOK_URL", "")
    if args.api_token is None:
        args.api_token = (
            unquote_env_value(env_value(env_file_values, "SIM_OPERATIONAL_API_TOKEN", ""))
            or unquote_env_value(env_value(env_file_values, "SIM_API_INTERNAL_TOKEN", ""))
            or unquote_env_value(env_value(env_file_values, "SIM_API_ADMIN_TOKEN", ""))
        )
    else:
        args.api_token = unquote_env_value(args.api_token)
    if args.state_file is None:
        args.state_file = Path(env_value(env_file_values, "SIM_OPERATIONAL_STATE_FILE", "data/operational-checks/state.json") or 'data/operational-checks/state.json')
    if args.report_file is None:
        default_report = '/srv/x5-production/data/csm-sim/sim-data/operational-checks/latest.json' if ROOT_DIR == Path('/srv/sim') else 'data/operational-checks/latest.json'
        args.report_file = Path(env_value(env_file_values, "SIM_OPERATIONAL_REPORT_FILE", default_report) or default_report)
    if not args.state_file.is_absolute():
        args.state_file = ROOT_DIR / args.state_file
    if not args.report_file.is_absolute():
        args.report_file = ROOT_DIR / args.report_file
    args.require_dem = env_bool(env_value(env_file_values, "SIM_OPERATIONAL_REQUIRE_DEM", "true"), True) if args.require_dem is None else args.require_dem
    args.require_terrain_aware = (
        env_bool(env_value(env_file_values, "SIM_OPERATIONAL_REQUIRE_TERRAIN_AWARE", "true"), True)
        if args.require_terrain_aware is None
        else args.require_terrain_aware
    )
    args.alert_on_recovery = env_bool(env_value(env_file_values, "SIM_OPERATIONAL_ALERT_ON_RECOVERY", "true"), True) if args.alert_on_recovery is None else args.alert_on_recovery
    args.alert_every_failure = env_bool(env_value(env_file_values, "SIM_OPERATIONAL_ALERT_EVERY_FAILURE", "false"), False) if args.alert_every_failure is None else args.alert_every_failure
    args.slo_availability_target = env_float(env_value(env_file_values, "SIM_OPERATIONAL_SLO_AVAILABILITY_TARGET", "0.995"), 0.995) if args.slo_availability_target is None else args.slo_availability_target
    args.check_interval_seconds = env_int(env_value(env_file_values, "SIM_OPERATIONAL_CHECK_INTERVAL_SECONDS", "300"), 300) if args.check_interval_seconds is None else args.check_interval_seconds
    args.slo_max_live_latency_ms = env_int(env_value(env_file_values, "SIM_OPERATIONAL_SLO_MAX_LIVE_LATENCY_MS", "1000"), 1000) if args.slo_max_live_latency_ms is None else args.slo_max_live_latency_ms
    args.slo_max_summary_latency_ms = env_int(env_value(env_file_values, "SIM_OPERATIONAL_SLO_MAX_SUMMARY_LATENCY_MS", "3000"), 3000) if args.slo_max_summary_latency_ms is None else args.slo_max_summary_latency_ms
    args.slo_max_total_duration_ms = env_int(env_value(env_file_values, "SIM_OPERATIONAL_SLO_MAX_TOTAL_DURATION_MS", "180000"), 180000) if args.slo_max_total_duration_ms is None else args.slo_max_total_duration_ms
    args.slo_require_operations_ok = (
        env_bool(env_value(env_file_values, "SIM_OPERATIONAL_SLO_REQUIRE_OPERATIONS_OK", "true"), True)
        if args.slo_require_operations_ok is None
        else args.slo_require_operations_ok
    )
    args.valhalla_monitor_enabled = env_bool(env_value(env_file_values, 'SIM_OPERATIONAL_VALHALLA_MONITOR_ENABLED', 'false'), False)
    args.valhalla_monitor_key = Path(unquote_env_value(env_value(env_file_values, 'SIM_OPERATIONAL_VALHALLA_MONITOR_KEY', '~/.config/csm-sim/valhalla-monitor/id_ed25519')))
    args.alert_reminder_seconds = env_int(env_value(env_file_values, 'SIM_OPERATIONAL_ALERT_REMINDER_SECONDS', '86400'), 86400)
    return args


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=Path(".env"), help="Optional key=value file. Default: %(default)s")
    parser.add_argument('--monitor-env-file', type=Path, default=None, help='Durable host-only monitor settings (no API tokens).')
    parser.add_argument("--base-url", default=None, help="SIM gateway base URL. Default comes from env or http://127.0.0.1:5020.")
    parser.add_argument("--environment", default=None, help="Alert environment label. Default comes from env or docker-home.")
    parser.add_argument("--bbox", default=None, help="Operational bbox for data-plane smoke checks.")
    parser.add_argument("--boundary-bbox", default=None, help="Larger bbox for boundary checks.")
    parser.add_argument("--terrain-bbox", default=None, help="Small bbox used to verify terrain-aware mobile read-model properties.")
    parser.add_argument("--expected-dem-source", default=None, help="Expected DEM dataset/source id.")
    parser.add_argument("--expected-mobile-model-version", default=None, help="Expected mobile coverage model version.")
    parser.add_argument("--timeout-seconds", type=float, default=30.0, help="Per-request timeout. Default: %(default)s")
    parser.add_argument("--command-timeout-seconds", type=float, default=180.0, help="Subprocess smoke timeout. Default: %(default)s")
    parser.add_argument("--webhook-url", default=None, help="Optional generic JSON webhook for state-change alerts.")
    parser.add_argument("--webhook-timeout-seconds", type=float, default=10.0, help="Alert webhook timeout. Default: %(default)s")
    parser.add_argument("--api-token", default=None, help="Bearer token for protected SIM API checks. Defaults to SIM_OPERATIONAL_API_TOKEN, SIM_API_INTERNAL_TOKEN or SIM_API_ADMIN_TOKEN from the env file.")
    parser.add_argument("--state-file", type=Path, default=None, help="State file for failure/recovery deduplication.")
    parser.add_argument("--report-file", type=Path, default=None, help="Latest JSON report output path.")
    parser.add_argument("--allow-degraded-health", action="append", choices=["flight", "situation", "safety", "tak"], default=["tak"])
    parser.add_argument("--min-osm-poi", type=int, default=1000)
    parser.add_argument("--min-osm-boundaries", type=int, default=100)
    parser.add_argument("--min-dem-tiles", type=int, default=36)
    parser.add_argument("--skip-provider-gateway-smoke", action="store_true")
    parser.add_argument("--skip-data-plane-smoke", action="store_true")
    parser.add_argument("--require-dem", dest="require_dem", action="store_true", default=None)
    parser.add_argument("--no-require-dem", dest="require_dem", action="store_false")
    parser.add_argument("--require-terrain-aware", dest="require_terrain_aware", action="store_true", default=None)
    parser.add_argument("--no-require-terrain-aware", dest="require_terrain_aware", action="store_false")
    parser.add_argument("--alert-on-recovery", dest="alert_on_recovery", action="store_true", default=None)
    parser.add_argument("--no-alert-on-recovery", dest="alert_on_recovery", action="store_false")
    parser.add_argument("--alert-every-failure", dest="alert_every_failure", action="store_true", default=None)
    parser.add_argument("--no-alert-every-failure", dest="alert_every_failure", action="store_false")
    parser.add_argument("--slo-availability-target", type=float, default=None)
    parser.add_argument("--check-interval-seconds", type=int, default=None)
    parser.add_argument("--slo-max-live-latency-ms", type=int, default=None)
    parser.add_argument("--slo-max-summary-latency-ms", type=int, default=None)
    parser.add_argument("--slo-max-total-duration-ms", type=int, default=None)
    parser.add_argument("--slo-require-operations-ok", dest="slo_require_operations_ok", action="store_true", default=None)
    parser.add_argument("--no-slo-require-operations-ok", dest="slo_require_operations_ok", action="store_false")
    parser.add_argument("--no-syslog", action="store_true", help="Disable syslog messages on alert events.")
    parser.add_argument("--json", action="store_true", help="Print the full JSON report.")
    parser.add_argument("--quiet", action="store_true", help="Print only failures unless --json is used.")
    args = parser.parse_args(argv)
    env_file = args.env_file if args.env_file.is_absolute() else ROOT_DIR / args.env_file
    values = parse_env_file(env_file)
    if args.monitor_env_file is not None:
        allowed = {'SIM_OPERATIONAL_VALHALLA_MONITOR_ENABLED', 'SIM_OPERATIONAL_VALHALLA_MONITOR_KEY', 'SIM_OPERATIONAL_REPORT_FILE', 'SIM_OPERATIONAL_STATE_FILE', 'SIM_OPERATIONAL_ALERT_REMINDER_SECONDS'}
        monitor_values = parse_env_file(args.monitor_env_file)
        require(not (set(monitor_values) - allowed), 'Monitor config contains unsupported keys')
        values.update(monitor_values)
    return resolve_args(args, values)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        guard_report_mount(args.report_file)
    except OperationalCheckError as exc:
        if not args.no_syslog:
            try:
                log_syslog(str(exc))
            except Exception:
                pass
        print(str(exc), file=sys.stderr)
        return 3
    report = build_report(args)
    alert_delivery = maybe_alert(report, args)
    report["alertDelivery"] = alert_delivery
    write_json(args.report_file, report)

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    elif report["status"] == "ok":
        if not args.quiet:
            print(f"production operational check passed: {report['summary']}")
    else:
        print(f"production operational check failed: {report['summary']}", file=sys.stderr)
    return 0 if report["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
