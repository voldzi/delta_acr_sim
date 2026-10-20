#!/usr/bin/env python3
"""Final image-only activation gated by the successful one-shot diagnostic."""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import time
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location("reviewed_diagnostic", Path(__file__).with_name("diagnose-routing-startup.py"))
diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)
DATASET = "sim-routing-2026-10-18-1792292102"
URL = "http://127.0.0.1:5020/situation-data/api/v1/routing/route"
WARMING_CODES = {"ROUTING_KNOWN_CLOSURES_REVIEW_REQUIRED", "ROUTING_KNOWN_CLOSURES_UNAVAILABLE"}

def request_route(origin, destination):
    body = {"profileId": "car", "from": {"lon": origin[0], "lat": origin[1]},
            "to": {"lon": destination[0], "lat": destination[1]}, "includeTraffic": True, "alternatives": 1}
    req = urllib.request.Request(URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try: value = json.load(error)
        except Exception: value = {}
        return error.code, value

def valid_route(status, value):
    routes = value.get("routes", [])
    return status == 200 and value.get("source", {}).get("backend") == "valhalla" and \
        value.get("coverage", {}).get("routingDataset", {}).get("version") == DATASET and bool(routes) and all(
            route.get("status") == "ok" and route.get("distanceM", 0) > 0 and route.get("durationSeconds", 0) > 0 and
            route.get("knownClosures", {}).get("state") == "applied" and
            route.get("knownClosures", {}).get("routingDataset", {}).get("version") == DATASET and
            route.get("knownClosures", {}).get("engine", {}).get("fallbackUsed") is False
            for route in routes)

def accept_routes():
    urban = ((14.42076, 50.08804), (14.4461, 50.0755))
    deadline = time.monotonic() + 420
    while True:
        status, value = request_route(*urban)
        if valid_route(status, value): break
        code = value.get("error", {}).get("code")
        # Ordinary requests only; persisted provider quota and graph backoff remain
        # in charge. Never accept 503, mutate review files or force a refresh.
        if status != 503 or code not in WARMING_CODES or time.monotonic() >= deadline:
            raise RuntimeError("Real route acceptance failed; guards remain active.")
        print("Waiting for normal provider/graph readiness; no refresh forced.", flush=True)
        time.sleep(min(60, max(0, deadline - time.monotonic())))
    results = [{"fixture": "urban", "http": status, "routeCount": len(value["routes"])}]
    for name, destination in (("cross_CZ", (18.282, 49.835)), ("CZ_AT", (16.367277, 48.216906))):
        status, value = request_route(urban[0], destination)
        if not valid_route(status, value): raise RuntimeError("Cross-region route acceptance failed.")
        results.append({"fixture": name, "http": status, "routeCount": len(value["routes"])})
    status, value = request_route((16.61158, 49.19114), (16.37208, 48.20849))
    if status != 422 or value.get("error", {}).get("code") != "ROUTING_LOCATION_NOT_ROUTABLE":
        raise RuntimeError("Unroutable fixture did not fail closed.")
    results.append({"fixture": "unroutable", "http": status, "code": "ROUTING_LOCATION_NOT_ROUTABLE"})
    return {"verified": True, "routingDataset": DATASET, "routes": results,
            "freshSpeedsAcceptancePending": True, "concurrencyAcceptancePending": True}

def main():
    receipt = diagnostic.main(deploy=True, acceptance=accept_routes)
    if not receipt.get("deploymentCommitted"):
        raise RuntimeError("Deployment not committed; original service restored.")
    installer = diagnostic.support.STAGE / "mobile-coverage/install-renewal.sh"
    if installer.is_symlink() or hashlib.sha256(installer.read_bytes()).hexdigest() != "d2366329a26fe2c9cbf61b8d816e874e74eca283aeb57a9fe9cbc9601caa25a2":
        raise RuntimeError("Routing installed; renewal package differs and was not executed.")
    diagnostic.run(["bash", str(installer), diagnostic.support.NEW])
    print("Image and renewal timer installed. Independent fresh-speed, mobile read-model and concurrency acceptance remains required.")

if __name__ == "__main__":
    if sys.argv[1:] != ["--install"]: raise SystemExit("Required mode: --install")
    if os.geteuid() != 0: raise SystemExit("Root operator required for protected image pin and timer.")
    lock = os.open(diagnostic.support.STAGE / ".diagnostic-v4.lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        if os.fstat(lock).st_uid != 0: raise RuntimeError("Unexpected lock owner.")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        def interrupted(_signum, _frame): raise KeyboardInterrupt()
        for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT): signal.signal(sig, interrupted)
        main()
    finally:
        os.close(lock)
