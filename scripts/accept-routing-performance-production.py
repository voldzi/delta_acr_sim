#!/usr/bin/env python3
"""Bounded read-only acceptance. Emits aggregates only; normal traffic lease only."""
import concurrent.futures
import datetime
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:5020/situation-data/api/v1"
DATASET = "sim-routing-2026-10-18-1792292102"
PREFIX = "situation_data_routing_"
BODY = {"profileId": "car", "from": {"lon": 14.42076, "lat": 50.08804},
        "to": {"lon": 14.4461, "lat": 50.0755}, "includeTraffic": True, "alternatives": 1}

def request(path, body=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try: value = json.load(error)
        except Exception: value = {}
        return error.code, value

def metrics():
    code = 'const r=await fetch("http://127.0.0.1:4020/metrics",{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error("metrics unavailable");console.log((await r.text()).split("\\n").filter(l=>l.startsWith("situation_data_routing_")).join("\\n"));'
    text = subprocess.check_output(["docker", "exec", "csm-sim-situation-data-api", "node", "--input-type=module", "-e", code], text=True, timeout=20)
    return {line.split()[0]: int(float(line.split()[1])) for line in text.splitlines() if line.startswith(PREFIX)}

def summarize(status, value, ms):
    routes = value.get("routes", [])
    return {"http": status, "ms": round(ms), "routeCount": len(routes),
            "routesOk": bool(routes) and all(r.get("status") == "ok" for r in routes),
            "closuresApplied": bool(routes) and all(r.get("knownClosures", {}).get("state") == "applied" for r in routes),
            "dataset": value.get("coverage", {}).get("routingDataset", {}).get("version"),
            "errorCode": value.get("error", {}).get("code")}

def one_gateway(start_at):
    time.sleep(max(0, start_at / 1000 - time.time()))
    started = time.monotonic()
    status, value = request("/routing/route", BODY)
    return summarize(status, value, (time.monotonic() - started) * 1000)

def cop_requests(start_at):
    # Use COP's real configured SIM address inside COP; never extract credentials.
    code = '''
const base=process.env.COP_SITUATION_DATA_BASE_URL;
if(!base)throw Error("COP SIM address missing");
const url=base.replace(/\\/$/,"")+"/routing/route";
const body=''' + json.dumps(BODY) + ''';
await new Promise(r=>setTimeout(r,Math.max(0,''' + str(start_at) + '''-Date.now())));
const rows=await Promise.all(Array.from({length:4},async()=>{
 const at=performance.now();const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
 const d=await r.json();const rows=d.routes??[];
 return {http:r.status,ms:Math.round(performance.now()-at),routeCount:rows.length,routesOk:rows.length>0&&rows.every(x=>x.status==="ok"),closuresApplied:rows.length>0&&rows.every(x=>x.knownClosures?.state==="applied"),dataset:d.coverage?.routingDataset?.version,errorCode:d.error?.code??null};
}));console.log(JSON.stringify(rows));'''
    output = subprocess.check_output(["docker", "exec", "cop-cop-api-1", "node", "--input-type=module", "-e", code], text=True, timeout=55)
    return json.loads(output)

def concurrency():
    before = metrics()
    start_at = int(time.time() * 1000) + 1500
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        cop = pool.submit(cop_requests, start_at)
        gateway = list(pool.map(one_gateway, [start_at] * 4))
        cop_rows = cop.result()
    after = metrics()
    delta = {key: after.get(key, 0) - before.get(key, 0) for key in after if key.endswith("_total")}
    rows = gateway + cop_rows
    verified = len(rows) == 8 and all(x["http"] == 200 and x["routesOk"] and x["closuresApplied"] and x["dataset"] == DATASET for x in rows)
    engines, coalesced = delta.get(PREFIX + "engine_started_total", 0), delta.get(PREFIX + "native_coalesced_total", 0)
    work_verified = 0 < engines < 8 and coalesced > 0 and engines + coalesced == 8 and \
        delta.get(PREFIX + "engine_rejected_total", 0) == 0 and delta.get(PREFIX + "status_rejected_total", 0) == 0 and \
        after.get(PREFIX + "engine_active") == 0 and after.get(PREFIX + "engine_queued") == 0
    return {"verified": verified and work_verified, "coalescingVerified": work_verified,
            "gateway": gateway, "copServer": cop_rows, "counterDelta": delta,
            "engineActiveAfter": after.get(PREFIX + "engine_active"), "engineQueuedAfter": after.get(PREFIX + "engine_queued")}

def mobile():
    result = []
    for technology in ("2G", "4G", "5G"):
        status, value = request("/features?bbox=14.40,50.06,14.46,50.10&layers=mobile_coverage&source=mobile_coverage_model&technology=" + technology + "&limit=5")
        rows = value.get("features", [])
        result.append({"technology": technology, "http": status, "count": len(rows),
                       "readModel": bool(rows) and all(x.get("properties", {}).get("readModel") is True for x in rows),
                       "resolution1000": bool(rows) and all(x.get("properties", {}).get("resolutionM") == 1000 for x in rows),
                       "staleCount": sum(x.get("properties", {}).get("stale") is True for x in rows), "warningCount": len(value.get("warnings", []))})
    return result

def fresh_speed():
    status, value = request("/routing/route", BODY)
    traffic = value.get("traffic", {}).get("liveSpeeds", {}) or {}
    now = datetime.datetime.now(datetime.timezone.utc)
    def timestamp(value):
        try:
            parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo is not None else None
        except (ValueError, TypeError, AttributeError): return None
    until, observed = timestamp(traffic.get("usableUntil")), timestamp(traffic.get("sourceObservedAt"))
    verified = status == 200 and traffic.get("state") == "current" and traffic.get("status") == "current" and \
        traffic.get("routingDataset") == DATASET and value.get("coverage", {}).get("routingDataset", {}).get("version") == DATASET and \
        traffic.get("appliedFlowCount", 0) > 0 and traffic.get("appliedEdgeCount", 0) > 0 and until is not None and until > now and \
        observed is not None and observed <= now + datetime.timedelta(seconds=30)
    return {"verified": bool(verified), "checkedAt": now.isoformat(), "http": status,
            **{key: traffic.get(key) for key in ("state", "status", "routingDataset", "appliedFlowCount", "appliedEdgeCount", "sourceObservedAt", "usableUntil")}}

if __name__ == "__main__":
    if sys.argv[1:] != ["--run"]: raise SystemExit("Required: --run (8 simultaneous normal routes, 3 small map queries, 1 final route).")
    result = {"concurrency": concurrency(), "mobile": mobile(), "freshSpeed": fresh_speed()}
    print(json.dumps(result))
