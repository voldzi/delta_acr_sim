#!/usr/bin/env python3
"""One approved diagnostic start. Always restore OLD; never install a timer."""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

spec = importlib.util.spec_from_file_location("reviewed_support", Path(__file__).with_name("install-reviewed-routing-performance.py"))
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)
CONTAINER = "csm-sim-situation-data-api"

def run(args):
    try:
        return subprocess.check_output(args, cwd="/srv/sim", stderr=subprocess.PIPE, text=True,
            timeout=90 if "up" in args else 15,
            env=support.COMPOSE_ENV if args[:2] == ["docker", "compose"] else None)
    except subprocess.CalledProcessError as error:
        raise RuntimeError("COMMAND_EXIT_%d" % error.returncode) from None
    except subprocess.TimeoutExpired:
        raise RuntimeError("COMMAND_TIMEOUT") from None

def inspect():
    return json.loads(run(["docker", "inspect", CONTAINER]))[0]

def wait_healthy(expected, seconds=60):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        value = inspect()
        state = value["State"]
        if value["Image"] != expected: return "image_mismatch"
        if state.get("OOMKilled"): return "oom_killed"
        if state.get("Status") in ("dead", "exited"): return "process_exited"
        if state.get("Restarting") or value.get("RestartCount", 0): return "process_restarted"
        health = state.get("Health", {}).get("Status")
        if health == "healthy": return "healthy"
        if health == "unhealthy": return "unhealthy"
        if not health: return "health_probe_missing"
        time.sleep(1)
    return "health_deadline"

def write_receipt(path, value, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    os.fchmod(fd, mode)
    with os.fdopen(fd, "w") as out:
        json.dump(value, out)
        out.flush()
        os.fsync(out.fileno())

def restore(original, before):
    support.replace_pin(original)
    run(support.DC + ["up", "-d", "--no-deps", "--no-build", "situation-data-api"])
    outcome = wait_healthy(support.OLD)
    current = inspect()
    differences = support.runtime_differences(before, current)
    if before["Config"].get("Healthcheck") != current["Config"].get("Healthcheck"):
        differences.append("Config.Healthcheck")
    return {"health": outcome, "differentFields": differences,
        "verified": outcome == "healthy" and not differences and support.PIN.read_bytes() == original}

def diagnostic(original, before, compose, private, result_path):
    receipt = {"diagnosticOnly": True, "candidate": support.NEW}
    phase = "compose-image-only-parity"
    changed = json.loads(original)
    changed["services"]["situation-data-api"]["image"] = support.NEW
    try:
        support.replace_pin((json.dumps(changed, indent=2) + "\n").encode())
        after = json.loads(run(support.DC + ["config", "--format", "json"]))
        expected = json.loads(json.dumps(compose))
        expected["services"]["situation-data-api"]["image"] = support.NEW
        if after != expected: raise RuntimeError("COMPOSE_PARITY_FAILED")
        phase = "candidate-start"
        run(support.DC + ["up", "-d", "--no-deps", "--no-build", "situation-data-api"])
        phase = "candidate-health"
        receipt["healthOutcome"] = wait_healthy(support.NEW)
        current = inspect()
        receipt["differentFields"] = support.runtime_differences(before, current)
        if before["Config"].get("Healthcheck") != current["Config"].get("Healthcheck"):
            receipt["differentFields"].append("Config.Healthcheck")
        receipt["candidatePassed"] = receipt["healthOutcome"] == "healthy" and not receipt["differentFields"]
    except BaseException as error:
        receipt["candidatePassed"] = False
        receipt["failureCategory"] = "interrupted" if isinstance(error, KeyboardInterrupt) else "command_or_validation_failure"
        if isinstance(error, RuntimeError) and re_safe_failure(str(error)):
            receipt["failureCode"] = str(error)
    finally:
        for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, signal.SIG_IGN)
        receipt["phase"] = phase
        try:
            receipt["startup"] = support.safe_startup_diagnostics(CONTAINER)
        except BaseException:
            receipt["startup"] = {"diagnosticCaptureFailed": True}
        # Receipt creation or collection MUST NOT prevent rollback.
        try:
            receipt["rollback"] = restore(original, before)
        except BaseException:
            receipt["rollback"] = {"verified": False}
        try:
            write_receipt(private / "result.json", receipt, 0o600)
            # Schema contains only safe state, enum codes, image IDs and stack sites.
            write_receipt(result_path, receipt, 0o644)
        except BaseException:
            receipt["receiptWriteFailed"] = True
        print("SAFE_STARTUP_DIAGNOSTIC=" + json.dumps(receipt), flush=True)
        if not receipt["rollback"].get("verified"):
            raise RuntimeError("ROLLBACK_NOT_VERIFIED: operator attention required.") from None
    return receipt

def re_safe_failure(value):
    import re
    return bool(re.fullmatch(r"COMMAND_EXIT_[0-9]{1,3}|COMMAND_TIMEOUT|COMPOSE_PARITY_FAILED", value))

def main():
    if os.geteuid() != 0: raise RuntimeError("Run this reviewed diagnostic as root.")
    support.run = run
    if run(["findmnt", "-n", "-o", "UUID", "--mountpoint", "/srv/x5-production"]).strip() != "2f93f595-b61b-4eea-9054-7afa9b275b5b":
        raise RuntimeError("Wrong X5 mount; no changes performed.")
    if support.PIN.is_symlink() or not support.PIN.is_file() or support.PIN.stat().st_uid != 0:
        raise RuntimeError("Unexpected authoritative pin.")
    original = support.PIN.read_bytes()
    if hashlib.sha256(original).hexdigest() != support.PIN_HASH: raise RuntimeError("Deployment pin changed.")
    before = inspect()
    if before["Image"] != support.OLD or before["State"].get("Health", {}).get("Status") != "healthy":
        raise RuntimeError("Old image must be healthy before diagnostic.")
    support.COMPOSE_ENV = support.reviewed_compose_environment(json.loads(original))
    if support.inspect_image("csm-sim-ai-router-api") != support.COMPOSE_ENV["SIM_ERASURE_ROUTER_IMAGE"]:
        raise RuntimeError("Router image differs from reviewed pin.")
    if run(["docker", "image", "inspect", "-f", "{{.Id}}", support.NEW]).strip() != support.NEW:
        raise RuntimeError("Candidate image absent.")
    compose = json.loads(run(support.DC + ["config", "--format", "json"]))
    image = json.loads(run(["docker", "image", "inspect", support.OLD]))[0]
    env = support.environment_map(image["Config"]["Env"])
    env.update({key: str(value) for key, value in compose["services"]["situation-data-api"].get("environment", {}).items()})
    if env != support.environment_map(before["Config"]["Env"]): raise RuntimeError("Live environment differs.")
    if compose["services"]["situation-data-api"]["image"] != support.OLD: raise RuntimeError("Compose pin differs.")
    private, result_path = support.STAGE / "root-diagnostic-v4", support.STAGE / "diagnostic-result-v4.json"
    if private.exists() or result_path.exists() or result_path.is_symlink():
        raise RuntimeError("Diagnostic already attempted; no restart. Review diagnostic-result-v4.json.")
    private.mkdir(mode=0o700, exist_ok=False)
    fd = os.open(private / support.PIN.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as out:
        out.write(original)
        out.flush()
        os.fsync(out.fileno())
    diagnostic(original, before, compose, private, result_path)
    print("Diagnostic complete; old image restored and healthy. No deployment or timer activation performed.")

if __name__ == "__main__":
    if sys.argv[1:] != ["--start-once"]: raise SystemExit("Required: --start-once (diagnostic only; always rollback).")
    if os.geteuid() != 0: raise SystemExit("Root operator required.")
    lock = os.open(support.STAGE / ".diagnostic-v4.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        if os.fstat(lock).st_uid != 0: raise RuntimeError("Unexpected lock owner.")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        def interrupted(_signum, _frame): raise KeyboardInterrupt()
        for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM): signal.signal(sig, interrupted)
        main()
    finally:
        os.close(lock)
