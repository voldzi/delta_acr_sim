"""Pure, bounded evaluation of the restricted Valhalla maintenance snapshot.

No network, shell execution, filesystem access, leases or provider requests occur
in this module. The caller obtains a fresh status-only SSH response. For persisted
responses it must pass ``{"statusText": text, "generatedAt": ISO_timestamp}``.
Only allowlisted operational metadata is returned; raw diagnostics are discarded.
"""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, timezone
from typing import Any

MAX_SNAPSHOT_BYTES = 64 * 1024
_RELEASE = re.compile(r"20\d{6}T\d{6}Z\Z")
_TARGET = re.compile(r"/srv/valhalla/releases/(20\d{6}T\d{6}Z)/custom_files\Z")
_ISO = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\Z")
_STATES = {"active", "inactive", "activating", "deactivating", "failed", "reloading"}
_SUBSTATES = {"dead", "running", "start", "start-pre", "start-post", "stop", "stop-sigterm", "auto-restart", "exited", "failed", "waiting", "elapsed"}
_RESULTS = {"success", "exit-code", "timeout", "signal", "resources", "watchdog", "core-dump", "start-limit-hit", "dependency", "protocol", "assert", "condition", "oom-kill"}
_UNIT_STATES = {"enabled", "enabled-runtime", "disabled", "static", "indirect", "masked", "masked-runtime", "generated", "transient", "linked", "linked-runtime"}
_PHASES = {"initializing", "preparing", "downloading", "extracting", "merging", "admins", "elevation", "tiles",
           "building", "validating", "validating_candidate", "candidate_ready", "activating", "complete", "recovering", "recovered", "failed"}
_SECTIONS = {"last-attempt.env", "last-success.env", "current", "releases", "disk", "valhalla-status", "traffic-runtime", "traffic-cache"}
_MESSAGES = {
    "VALHALLA_SNAPSHOT_INVALID": "Valhalla maintenance snapshot is invalid.",
    "VALHALLA_SNAPSHOT_TOO_LARGE": "Valhalla maintenance snapshot exceeds the size limit.",
    "VALHALLA_SNAPSHOT_STALE": "Valhalla maintenance snapshot is too old.",
    "VALHALLA_SNAPSHOT_TIME_INVALID": "Valhalla snapshot timestamp is invalid or in the future.",
    "VALHALLA_CLOCK_INVALID": "Valhalla monitoring clock is invalid.",
    "VALHALLA_WEEKLY_SERVICE_INVALID": "Valhalla weekly service metadata is missing or invalid.",
    "VALHALLA_WEEKLY_TIMER_INVALID": "Valhalla weekly timer metadata is missing or invalid.",
    "VALHALLA_WEEKLY_TIMER_INACTIVE": "Časovač automatické aktualizace map Valhally neběží.",
    "VALHALLA_WEEKLY_TIMER_DISABLED": "Valhalla weekly update timer is disabled or masked.",
    "VALHALLA_WEEKLY_TIMER_UNSCHEDULED": "Valhalla weekly update timer has no valid next run.",
    "VALHALLA_WEEKLY_UPDATE_FAILED": "Služba automatické aktualizace map Valhally selhala.",
    "VALHALLA_WEEKLY_ATTEMPT_FAILED": "Poslední automatická aktualizace map Valhally selhala.",
    "VALHALLA_ATTEMPT_INVALID": "Valhalla update attempt metadata is missing or invalid.",
    "VALHALLA_ATTEMPT_TIME_INVALID": "Valhalla update attempt timestamps are invalid or in the future.",
    "VALHALLA_BUILD_OVERRUN": "Aktualizace map Valhally běží déle než šest hodin a vyžaduje kontrolu.",
    "VALHALLA_SUCCESS_MISSING": "Valhalla last successful activation metadata is missing or invalid.",
    "VALHALLA_SUCCESS_TIME_INVALID": "Valhalla successful activation timestamp is invalid or in the future.",
    "VALHALLA_RELEASE_BINDING_INVALID": "Valhalla active release binding is missing or invalid.",
    "VALHALLA_RELEASE_MISMATCH": "Valhalla current release does not match the last successful activation.",
    "VALHALLA_GRAPH_METADATA_INVALID": "Valhalla graph timestamp or API status metadata is invalid.",
    "VALHALLA_GRAPH_TIME_FUTURE": "Valhalla graph build timestamp is in the future.",
    "VALHALLA_MAP_AGE_WARNING": "Mapy Valhally jsou nejméně osm dní staré; ověřte automatickou aktualizaci.",
    "VALHALLA_MAP_AGE_CRITICAL": "Mapy Valhally jsou nejméně devět dní staré; aktualizace vyžaduje zásah.",
    "VALHALLA_DISK_METADATA_INVALID": "Valhalla runtime disk metadata is missing or invalid.",
    "VALHALLA_RUNTIME_DISK_LOW": "Valhalla runtime free disk is below its safety minimum.",
    "VALHALLA_HEALTHCHECK_FAILED": "Valhalla host healthcheck has failed.",
}


def _instant(value: Any) -> datetime | None:
    try:
        if isinstance(value, datetime):
            return value.astimezone(timezone.utc) if value.tzinfo is not None and value.utcoffset() is not None else None
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
            return datetime.fromtimestamp(value, timezone.utc)
        if isinstance(value, str) and _ISO.fullmatch(value):
            return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (ValueError, OverflowError, OSError):
        pass
    return None


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _release(value: Any) -> str | None:
    if not isinstance(value, str) or not _RELEASE.fullmatch(value):
        return None
    try:
        datetime.strptime(value, "%Y%m%dT%H%M%SZ")
    except ValueError:
        return None
    return value


def _target(value: Any) -> str | None:
    match = _TARGET.fullmatch(value) if isinstance(value, str) else None
    return _release(match.group(1)) if match else None


def _unit(raw: dict[str, str]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for source, target, allowed in (("ActiveState", "activeState", _STATES), ("SubState", "subState", _SUBSTATES),
                                    ("Result", "result", _RESULTS), ("UnitFileState", "unitFileState", _UNIT_STATES)):
        if raw.get(source) in allowed:
            output[target] = raw[source]
    status = raw.get("ExecMainStatus", "")
    if re.fullmatch(r"\d{1,3}", status) and int(status) <= 255:
        output["execMainStatus"] = int(status)
    return output


def _next_run(value: str | None) -> datetime | None:
    direct = _instant(value)
    if direct:
        return direct
    match = re.fullmatch(r"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? UTC", value or "")
    return _instant(f"{match.group(1)}T{match.group(2)}Z") if match else None


def _disk_bytes(lines: list[str]) -> int | None:
    rows = []
    for line in lines:
        match = re.fullmatch(r"\S+\s+\S+\s+\S+\s+(\d+(?:\.\d+)?)([KMGTPE]?)(?:i?B)?\s+\d{1,3}%\s+\S+", line)
        if match:
            scale = " KMGTPE".index(match.group(2) or " ")
            rows.append(int(float(match.group(1)) * 1024 ** scale))
    return rows[0] if len(rows) == 1 else None


def _parse(text: str) -> tuple[list[dict[str, str]], dict[str, list[str]]]:
    units: list[dict[str, str]] = []
    sections: dict[str, list[str]] = {}
    section: str | None = None
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if line in _SECTIONS:
            section = line
            sections.setdefault(section, [])
            continue
        if section is not None:
            if line:
                sections[section].append(line)
        elif line.startswith("ActiveState="):
            units.append({"ActiveState": line.split("=", 1)[1]})
        elif units and "=" in line:
            key, value = line.split("=", 1)
            if key in {"SubState", "Result", "ExecMainStatus", "NextElapseUSecRealtime", "UnitFileState"}:
                units[-1][key] = value
    return units, sections


def _fields(lines: list[str], allowed: set[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in lines:
        if "=" in line:
            key, value = line.split("=", 1)
            if key in allowed:
                result[key] = value
    return result


def evaluate_valhalla_snapshot(
    raw: str | bytes | dict[str, Any], *, now: datetime | float | int | None = None,
    warn_age_seconds: int = 691200, critical_age_seconds: int = 777600,
    build_max_age_seconds: int = 21600, snapshot_max_age_seconds: int = 900,
    graph_built_at: str | datetime | float | int | None = None, runtime_min_free_gb: float = 10,
) -> dict[str, Any]:
    """Return sanitized ``status``, ``severity``, ``details`` and stable failures.

    ``str``/``bytes`` means a just-completed live SSH poll. Cached input requires
    the envelope's ``generatedAt``; missing or invalid envelope time fails closed.
    ``graph_built_at`` optionally supplies independently observed API graph time;
    the *oldest* graph/activation time controls freshness. Ages never enter error
    strings, keeping repeated warnings/failures deduplicable.
    """
    failures: list[dict[str, str]] = []
    details: dict[str, Any] = {}

    def fail(code: str, severity: str = "critical") -> None:
        if not any(item["code"] == code for item in failures):
            failures.append({"code": code, "error": _MESSAGES[code], "severity": severity})

    def finish() -> dict[str, Any]:
        severity = "critical" if any(f["severity"] == "critical" for f in failures) else "warning" if failures else "info"
        return {"status": "failed" if failures else "ok", "severity": severity, "details": details, "failures": failures}

    instant = _instant(now) if now is not None else datetime.now(timezone.utc)
    if instant is None:
        fail("VALHALLA_CLOCK_INVALID")
        return finish()
    if (not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0
                for v in (warn_age_seconds, critical_age_seconds, build_max_age_seconds, snapshot_max_age_seconds, runtime_min_free_gb))
            or warn_age_seconds >= critical_age_seconds):
        fail("VALHALLA_SNAPSHOT_INVALID")
        return finish()
    details["observedAt"] = _iso(instant)
    if isinstance(raw, dict):
        stamp = _instant(raw.get("generatedAt"))
        if stamp is None or (stamp - instant).total_seconds() > 30:
            fail("VALHALLA_SNAPSHOT_TIME_INVALID")
        else:
            details["snapshotGeneratedAt"] = _iso(stamp)
            details["snapshotAgeSeconds"] = max(0, int((instant - stamp).total_seconds()))
            if (instant - stamp).total_seconds() > snapshot_max_age_seconds:
                fail("VALHALLA_SNAPSHOT_STALE")
        raw = raw.get("statusText")
    if not isinstance(raw, (str, bytes)):
        fail("VALHALLA_SNAPSHOT_INVALID")
        return finish()
    if len(raw if isinstance(raw, bytes) else raw.encode("utf-8")) > MAX_SNAPSHOT_BYTES:
        fail("VALHALLA_SNAPSHOT_TOO_LARGE")
        return finish()
    try:
        text = raw.decode("utf-8", errors="strict") if isinstance(raw, bytes) else raw
    except UnicodeError:
        fail("VALHALLA_SNAPSHOT_INVALID")
        return finish()
    units, sections = _parse(text)
    service = _unit(units[0]) if units else {}
    timer = _unit(units[1]) if len(units) > 1 else {}
    details["weeklyService"] = service
    details["weeklyTimer"] = timer
    if "activeState" not in service or "result" not in service or "execMainStatus" not in service:
        fail("VALHALLA_WEEKLY_SERVICE_INVALID")
    elif service["activeState"] == "failed" or ((service["result"] != "success" or service["execMainStatus"] != 0)
                                               and service["activeState"] not in {"activating", "active"}):
        fail("VALHALLA_WEEKLY_UPDATE_FAILED")
    if "activeState" not in timer:
        fail("VALHALLA_WEEKLY_TIMER_INVALID")
    elif timer["activeState"] != "active":
        fail("VALHALLA_WEEKLY_TIMER_INACTIVE")
    if timer.get("unitFileState") in {"disabled", "masked", "masked-runtime"}:
        fail("VALHALLA_WEEKLY_TIMER_DISABLED")
    next_run = _next_run(units[1].get("NextElapseUSecRealtime")) if len(units) > 1 else None
    if next_run is None:
        fail("VALHALLA_WEEKLY_TIMER_UNSCHEDULED")
    else:
        timer["nextRunAt"] = _iso(next_run)
    if len(units) > 2:
        health = _unit(units[2])
        details["healthcheck"] = health
        if health.get("activeState") == "failed" or (health.get("result") not in {None, "success"} and health.get("activeState") != "activating"):
            fail("VALHALLA_HEALTHCHECK_FAILED")

    attempt = _fields(sections.get("last-attempt.env", []), {"RELEASE_ID", "STATUS", "PHASE", "STARTED_AT", "UPDATED_AT"})
    attempt_id = _release(attempt.get("RELEASE_ID"))
    attempt_status = attempt.get("STATUS") if attempt.get("STATUS") in {"running", "success", "failed"} else None
    attempt_phase = attempt.get("PHASE") if attempt.get("PHASE") in _PHASES else None
    details["lastAttempt"] = {k: v for k, v in {"releaseId": attempt_id, "status": attempt_status, "phase": attempt_phase}.items() if v is not None}
    if attempt_id is None or attempt_status is None or attempt_phase is None:
        fail("VALHALLA_ATTEMPT_INVALID")
    if attempt_status == "failed":
        fail("VALHALLA_WEEKLY_ATTEMPT_FAILED")
    start, updated = _instant(attempt.get("STARTED_AT")), _instant(attempt.get("UPDATED_AT"))
    if start is None or updated is None or updated < start or any((d - instant).total_seconds() > 30 for d in (start, updated) if d is not None):
        fail("VALHALLA_ATTEMPT_TIME_INVALID")
    else:
        details["lastAttempt"].update({"startedAt": _iso(start), "updatedAt": _iso(updated)})
    if (attempt_status == "running" or service.get("activeState") in {"activating", "active"}) and start is not None:
        duration = max(0, int((instant - start).total_seconds()))
        details["buildRunningSeconds"] = duration
        if (instant - start).total_seconds() >= build_max_age_seconds:
            fail("VALHALLA_BUILD_OVERRUN")

    success = _fields(sections.get("last-success.env", []), {"RELEASE_ID", "TARGET", "ACTIVATED_AT"})
    success_id = _release(success.get("RELEASE_ID"))
    success_target = _target(success.get("TARGET"))
    activation = _instant(success.get("ACTIVATED_AT"))
    details["lastSuccess"] = {"releaseId": success_id}
    if success_id is None or success_target is None or success_id != success_target:
        fail("VALHALLA_SUCCESS_MISSING")
    if activation is None or (activation - instant).total_seconds() > 30:
        fail("VALHALLA_SUCCESS_TIME_INVALID")
        activation = None
    else:
        details["lastSuccess"]["activatedAt"] = _iso(activation)
    current_lines = sections.get("current", [])
    current_id = _target(current_lines[0]) if len(current_lines) == 1 else None
    details["activeReleaseId"] = current_id
    if current_id is None:
        fail("VALHALLA_RELEASE_BINDING_INVALID")
    elif success_id is not None and current_id != success_id:
        fail("VALHALLA_RELEASE_MISMATCH")

    graph_times = []
    for line in sections.get("valhalla-status", []):
        if not line.startswith("{"):
            continue
        try:
            payload = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(payload, dict):
            continue
        epoch = payload.get("tileset_last_modified")
        version = payload.get("version")
        if isinstance(epoch, int) and not isinstance(epoch, bool) and epoch > 0 and isinstance(version, str) and re.fullmatch(r"\d{1,3}\.\d{1,3}\.\d{1,3}", version):
            graph = _instant(epoch)
            if graph is not None:
                graph_times.append(graph)
                details["engineVersion"] = version
                details["routingDataset"] = f"sim-routing-{graph.date().isoformat()}-{epoch}"
    if not graph_times:
        fail("VALHALLA_GRAPH_METADATA_INVALID")
    if graph_built_at is not None:
        independent = _instant(graph_built_at)
        if independent is None:
            fail("VALHALLA_GRAPH_METADATA_INVALID")
        else:
            graph_times.append(independent)
    if any((d - instant).total_seconds() > 30 for d in graph_times):
        fail("VALHALLA_GRAPH_TIME_FUTURE")
    else:
        freshness_times = graph_times + ([activation] if activation is not None else [])
        if freshness_times:
            oldest = min(freshness_times)
            age = max(0, int((instant - oldest).total_seconds()))
            details.update({"freshnessAt": _iso(oldest), "freshnessAgeSeconds": age,
                            "warnAgeSeconds": warn_age_seconds, "criticalAgeSeconds": critical_age_seconds})
            if age >= critical_age_seconds:
                fail("VALHALLA_MAP_AGE_CRITICAL")
            elif age >= warn_age_seconds:
                fail("VALHALLA_MAP_AGE_WARNING", "warning")
    available = _disk_bytes(sections.get("disk", []))
    details["disk"] = {"availableBytes": available, "minRuntimeFreeBytes": int(runtime_min_free_gb * 1024 ** 3)}
    if available is None:
        fail("VALHALLA_DISK_METADATA_INVALID")
    elif available < runtime_min_free_gb * 1024 ** 3:
        fail("VALHALLA_RUNTIME_DISK_LOW")
    return finish()
