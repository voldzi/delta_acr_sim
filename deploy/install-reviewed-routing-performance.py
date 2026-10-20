#!/usr/bin/env python3
"""Root-only narrow rollout; no credential, network or database-policy changes."""
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import time

OLD = "sha256:3c07a98618867f6bfe3712f6156c8100808d9f9d08f7f8a63e9e5f64b6719d94"
NEW = "sha256:b51f7dbce0407c498d7ba1dea69b6cd481be5fd44eb54ac70a14c66d852bfe04"
PIN_HASH = "524894bf846fe33c8ad55585e34ffafb6043943273fa5065a83ecc32ddb8a534"
PIN = Path("/srv/sim/docker-compose.clean-user-data.json")
STAGE = Path("/srv/sim/.routing-performance-20261020")
FILES = ["/srv/sim/docker-compose.yml", "/srv/sim/docker-compose.x5.yml", "/srv/sim/docker-compose.driver-measurements.yml", "/home/voldzi/sim-erasure-apply-ca1fd6b-v2/deploy/account-safety/database-v2.prepare.compose.yml", str(PIN)]
DC = ["docker", "compose", "--project-name", "sim"] + [arg for path in FILES for arg in ("-f", path)]
COMPOSE_ENV = None

def safe_startup_diagnostics(container):
    """Collect state and allowlisted error categories before removing candidate.

    Never persist raw logs, probe output, environment values or request bodies.
    """
    try:
        result = subprocess.run(["docker", "inspect", container], capture_output=True, text=True, timeout=5)
    except subprocess.TimeoutExpired:
        return {"inspectTimedOut": True}
    if result.returncode:
        return {"inspectExitCode": result.returncode}
    value = json.loads(result.stdout)[0]
    state = value["State"]
    health = state.get("Health", {})
    log_capture = {}
    try:
        logs = subprocess.run(["docker", "logs", "--tail", "100", container], capture_output=True, text=True, timeout=10)
        text = logs.stdout + logs.stderr
        log_capture["logsExitCode"] = logs.returncode
    except subprocess.TimeoutExpired:
        text = ""
        log_capture["logsTimedOut"] = True
    known_codes = ("CLEAN_DATABASE_NOT_READY", "INVALID_CLEAN_DRIVER_CONFIGURATION", "INVALID_CLEAN_CONFIGURATION",
                   "INVALID_PRODUCTION_CLEAN_CONFIGURATION", "CLEAN_LEGACY_COMPOSITION_CONFLICT",
                   "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EACCES", "ENOENT", "ENOSPC",
                   "MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ERR_TLS_CERT_ALTNAME_INVALID",
                   "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT",
                   "ERR_INVALID_ARG_TYPE", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_REQUIRE_ESM",
                   "28P01", "3D000", "42501", "53300", "57P03")
    # Emit source coordinates only from a fixed list of repository-owned modules.
    # Never persist exception messages, function names, arbitrary paths or frames.
    app_modules = (
        "aggregation", "app", "aprs-is-source", "bbox-cache", "catalog", "chmi-radar", "chmi-webcams",
        "chmi-weather-station-detail", "clean-bootstrap", "community-context-source", "config",
        "database-erasure", "dem-catalog", "dem-elevation-sampler", "driver-account-erasure",
        "driver-account-erasure-store", "driver-guarded-execution", "driver-guarded-execution-port",
        "driver-maintenance-cli", "driver-maintenance-owner", "driver-measurement-store",
        "driver-measurements", "driver-owner-composition", "driver-publication", "driver-retention-lifecycle",
        "driver-revocation-actor", "feature-views", "geo-routing", "http", "index",
        "known-closure-graph-rebind", "known-road-closures", "layers", "mapped-road-profile",
        "mobile-coverage-source", "osm-postgis-source", "radar-frames", "radio-planning",
        "rebuild-mobile-coverage", "response-cache", "road-match", "routing-safety", "routing-service",
        "routing-work", "search-data", "shared-cache", "sim-user-data-relay", "sources", "spatial-limit",
        "tpeg2-source", "transit-detail", "transit-static-model", "types", "valhalla-traffic-coordinator",
        "weather-forecast")
    module_pattern = (r"apps/situation-data-api/dist/(?:" + "|".join(app_modules) + r")\.js|"
                      r"packages/clean-lifecycle/(?:runtime|store|http|completed-replay)\.mjs")
    frame_pattern = re.compile(r"^\s*at\s+(?:[^\n]*?\()?"
                               r"(?:file://)?/app/(?P<module>" + module_pattern + r")"
                               r":(?P<line>[1-9][0-9]{0,6}):(?P<column>[1-9][0-9]{0,5})\)?\s*$",
                               re.MULTILINE)
    stack_sites = []
    for frame in frame_pattern.finditer(text):
        site = {"module": frame.group("module"), "line": int(frame.group("line")), "column": int(frame.group("column"))}
        if site not in stack_sites:
            stack_sites.append(site)
        if len(stack_sites) == 12:
            break
    probes = []
    for entry in health.get("Log", []):
        output = entry.get("Output", "")
        probes.append({"start": entry.get("Start"), "exitCode": entry.get("ExitCode"),
                       "errorCodes": [code for code in known_codes if code in output]})
    return {"image": value["Image"], "status": state.get("Status"), "running": state.get("Running"),
            "exitCode": state.get("ExitCode"), "oomKilled": state.get("OOMKilled"),
            "restartCount": value.get("RestartCount"), "startedAt": state.get("StartedAt"),
            "finishedAt": state.get("FinishedAt"), "health": health.get("Status"), "probes": probes,
            "startupErrorCodes": [code for code in known_codes if re.search(r"\b" + code + r"\b", text)],
            "exceptionClasses": [name for name in ("TypeError", "ReferenceError", "SyntaxError", "RangeError") if name + ":" in text],
            "startupStackSites": stack_sites, **log_capture,
            "startupListeningObserved": "Situation Data API listening on" in text}

def reviewed_compose_environment(pin):
    """Satisfy required intermediate interpolation from authoritative pins only."""
    env = os.environ.copy()
    for variable, service in (("SIM_ERASURE_DRIVER_IMAGE", "situation-data-api"),
                              ("SIM_ERASURE_ROUTER_IMAGE", "ai-router-api")):
        value = pin["services"][service]["image"]
        if not isinstance(value, str) or not value.startswith("sha256:") or len(value) != 71:
            raise RuntimeError("Expected an immutable reviewed image pin.")
        if any(c not in "0123456789abcdef" for c in value[7:]):
            raise RuntimeError("Invalid reviewed image digest.")
        env[variable] = value
    return env

def run(args):
    try:
        return subprocess.check_output(args, cwd="/srv/sim", stderr=subprocess.PIPE,
                                       text=True, env=COMPOSE_ENV if args[:2] == ["docker", "compose"] else None)
    except subprocess.CalledProcessError as error:
        # Compose output may contain interpolated secrets. Never print it.
        raise RuntimeError("Deployment command failed (exit %d); captured output withheld to protect secrets." % error.returncode) from None

def inspect_image(name):
    return run(["docker", "inspect", "-f", "{{.Image}}", name]).strip()

def environment_map(values):
    result = dict(value.split("=", 1) for value in values)
    if len(result) != len(values):
        raise RuntimeError("Duplicate environment names rejected.")
    return result

def runtime_differences(before, after):
    differences = []
    for field in ("Env", "Entrypoint", "Cmd", "User", "WorkingDir"):
        a, b = before["Config"].get(field), after["Config"].get(field)
        if field == "Env": a, b = environment_map(a), environment_map(b)
        if a != b: differences.append("Config." + field)
    for field in ("Binds", "NetworkMode", "PortBindings", "ReadonlyRootfs", "SecurityOpt", "CapDrop", "Mounts"):
        a, b = before["HostConfig"].get(field), after["HostConfig"].get(field)
        if isinstance(a, list) and isinstance(b, list):
            a, b = sorted(json.dumps(v, sort_keys=True) for v in a), sorted(json.dumps(v, sort_keys=True) for v in b)
        if a != b: differences.append("HostConfig." + field)
    if sorted(json.dumps(v, sort_keys=True) for v in before["Mounts"]) != sorted(json.dumps(v, sort_keys=True) for v in after["Mounts"]):
        differences.append("Mounts")
    return differences

def reject_previous_attempt(private):
    """Never overwrite a rollback or silently retry a rejected candidate."""
    if not private.exists():
        return
    receipt = private / "failure.json"
    if receipt.is_symlink():
        raise RuntimeError("Previous attempt requires operator review; unsafe receipt path.")
    if receipt.is_file():
        data = json.loads(receipt.read_text())
        phases = {"compose-image-only-parity", "compose-up", "candidate-health", "runtime-security-parity"}
        phase = data.get("phase")
        if phase not in phases:
            phase = "unknown"
        allowed_fields = {"Config." + x for x in ("Env", "Entrypoint", "Cmd", "User", "WorkingDir")}
        allowed_fields.update("HostConfig." + x for x in ("Binds", "NetworkMode", "PortBindings", "ReadonlyRootfs", "SecurityOpt", "CapDrop", "Mounts"))
        allowed_fields.add("Mounts")
        fields = sorted(x for x in data.get("differentFields", []) if isinstance(x, str) and x in allowed_fields)
        raise RuntimeError("Previous attempt rejected at " + phase + "; fields=" + ",".join(fields) + ". No retry or production change performed.")
    raise RuntimeError("Previous attempt exists without a failure receipt; operator review required. No retry performed.")

def replace_pin(data):
    temporary = PIN.with_name(".routing-performance-pin.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, PIN)
    finally:
        if temporary.exists(): temporary.unlink()

def main():
    global COMPOSE_ENV
    if os.geteuid() != 0: raise RuntimeError("Run this reviewed installer as root.")
    if run(["findmnt", "-n", "-o", "UUID", "--mountpoint", "/srv/x5-production"]).strip() != "2f93f595-b61b-4eea-9054-7afa9b275b5b": raise RuntimeError("Wrong X5 mount.")
    if PIN.is_symlink() or not PIN.is_file() or PIN.stat().st_uid != 0: raise RuntimeError("Unexpected deployment pin.")
    original = PIN.read_bytes()
    if hashlib.sha256(original).hexdigest() != PIN_HASH or inspect_image("csm-sim-situation-data-api") != OLD: raise RuntimeError("Deployment changed; stop for fresh review.")
    COMPOSE_ENV = reviewed_compose_environment(json.loads(original))
    if inspect_image("csm-sim-ai-router-api") != COMPOSE_ENV["SIM_ERASURE_ROUTER_IMAGE"]:
        raise RuntimeError("Router image differs from reviewed pin; no deployment performed.")
    if run(["docker", "image", "inspect", "-f", "{{.Id}}", NEW]).strip() != NEW: raise RuntimeError("Candidate image absent.")
    before = json.loads(run(DC + ["config", "--format", "json"]))
    if before["services"]["situation-data-api"]["image"] != OLD: raise RuntimeError("Unexpected Compose image.")
    actual = json.loads(run(["docker", "inspect", "csm-sim-situation-data-api"]))[0]
    image = json.loads(run(["docker", "image", "inspect", OLD]))[0]
    env = dict(s.split("=", 1) for s in image["Config"]["Env"])
    env.update({k: str(v) for k, v in before["services"]["situation-data-api"].get("environment", {}).items()})
    if env != dict(s.split("=", 1) for s in actual["Config"]["Env"]): raise RuntimeError("Live environment differs from Compose; no deployment performed.")
    private = STAGE / "root-diagnostic-v4"
    reject_previous_attempt(private)
    private.mkdir(mode=0o700, exist_ok=False)
    backup = private / PIN.name
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as out: out.write(original)
    update = json.loads(original)
    update["services"]["situation-data-api"]["image"] = NEW
    replace_pin((json.dumps(update, indent=2) + "\n").encode())
    phase = "compose-image-only-parity"
    differences = []
    try:
        after = json.loads(run(DC + ["config", "--format", "json"]))
        expected = json.loads(json.dumps(before))
        expected["services"]["situation-data-api"]["image"] = NEW
        if after != expected: raise RuntimeError("Compose change exceeded image-only scope.")
        phase = "compose-up"
        run(DC + ["up", "-d", "--no-deps", "--no-build", "situation-data-api"])
        phase = "candidate-health"
        healthy = False
        for _ in range(60):
            if inspect_image("csm-sim-situation-data-api") != NEW: raise RuntimeError("Unexpected image during acceptance.")
            state = run(["docker", "inspect", "-f", "{{.State.Health.Status}}", "csm-sim-situation-data-api"]).strip()
            if state == "healthy": healthy = True; break
            time.sleep(1)
        if not healthy: raise RuntimeError("Candidate did not become ready.")
        current = json.loads(run(["docker", "inspect", "csm-sim-situation-data-api"]))[0]
        phase = "runtime-security-parity"
        differences = runtime_differences(actual, current)
        if differences: raise RuntimeError("Runtime configuration differs.")
    except Exception:
        # Safe receipt retains stage and field names only, never captured output.
        receipt = {"phase": phase, "differentFields": differences, "candidate": NEW}
        try:
            receipt["startup"] = safe_startup_diagnostics("csm-sim-situation-data-api")
        except Exception:
            receipt["startup"] = {"diagnosticCaptureFailed": True}
        fd = os.open(private / "failure.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as out: json.dump(receipt, out)
        replace_pin(original)
        run(DC + ["up", "-d", "--no-deps", "--no-build", "situation-data-api"])
        if inspect_image("csm-sim-situation-data-api") != OLD:
            raise RuntimeError("Rollback image verification failed; operator attention required.") from None
        print("SAFE_STARTUP_DIAGNOSTIC=" + json.dumps(receipt), flush=True)
        raise RuntimeError("Candidate rejected at " + phase + "; fields=" + ",".join(differences) + "; previous pinned image restored.") from None
    print("Routing image installed with unchanged runtime/security configuration: " + NEW)
    result = subprocess.run(["bash", str(STAGE / "mobile-coverage/install-renewal.sh"), NEW], cwd="/srv/sim", check=False)
    if result.returncode: raise RuntimeError("Routing installed; renewal installation needs operator attention.")
    print("Follow-up real route, current-speed and concurrency acceptance is still required.")

if __name__ == "__main__":
    main()
