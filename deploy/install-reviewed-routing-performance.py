#!/usr/bin/env python3
"""Root-only narrow rollout; no credential, network or database-policy changes."""
import hashlib
import json
import os
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
    private = STAGE / "root-rollback"
    private.mkdir(mode=0o700, exist_ok=False)
    backup = private / PIN.name
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as out: out.write(original)
    update = json.loads(original)
    update["services"]["situation-data-api"]["image"] = NEW
    replace_pin((json.dumps(update, indent=2) + "\n").encode())
    try:
        after = json.loads(run(DC + ["config", "--format", "json"]))
        expected = json.loads(json.dumps(before))
        expected["services"]["situation-data-api"]["image"] = NEW
        if after != expected: raise RuntimeError("Compose change exceeded image-only scope.")
        run(DC + ["up", "-d", "--no-deps", "--no-build", "situation-data-api"])
        healthy = False
        for _ in range(60):
            if inspect_image("csm-sim-situation-data-api") != NEW: raise RuntimeError("Unexpected image during acceptance.")
            state = run(["docker", "inspect", "-f", "{{.State.Health.Status}}", "csm-sim-situation-data-api"]).strip()
            if state == "healthy": healthy = True; break
            time.sleep(1)
        if not healthy: raise RuntimeError("Candidate did not become ready.")
        current = json.loads(run(["docker", "inspect", "csm-sim-situation-data-api"]))[0]
        for section in ("Env", "Entrypoint", "Cmd", "User", "WorkingDir"):
            if actual["Config"].get(section) != current["Config"].get(section): raise RuntimeError("Runtime configuration changed.")
        for section in ("Binds", "NetworkMode", "PortBindings", "ReadonlyRootfs", "SecurityOpt", "CapDrop"):
            if actual["HostConfig"].get(section) != current["HostConfig"].get(section): raise RuntimeError("Runtime security or mounts changed.")
    except Exception:
        replace_pin(original)
        run(DC + ["up", "-d", "--no-deps", "--no-build", "situation-data-api"])
        raise RuntimeError("Candidate rejected; previous pinned image/configuration restored.") from None
    print("Routing image installed with unchanged runtime/security configuration: " + NEW)
    result = subprocess.run(["bash", str(STAGE / "mobile-coverage/install-renewal.sh"), NEW], cwd="/srv/sim", check=False)
    if result.returncode: raise RuntimeError("Routing installed; renewal installation needs operator attention.")
    print("Follow-up real route, current-speed and concurrency acceptance is still required.")

if __name__ == "__main__":
    main()
