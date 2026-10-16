#!/usr/bin/env python3
"""Own-container lifecycle for the isolated actual COP/SIM whole-erasure test.

No host mounts, published ports, pulls, builds or production configuration.
Private actor/environment JSON is copied in memory from a named fixture carrier
into private container tmpfs; this program never prints or persists its values.
The shared PostgreSQL namespace holder and databases are never removed here.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import shlex
import subprocess
import tarfile
import time

ROOT = Path(__file__).resolve().parents[2]
PROFILES = {
    "negative-v1": {
        "owner": "cop-messaging-joint-d2630fa78b21",
        "input_carrier": "cop-erasure-whole-a7d2df56a653-node",
        "input_owner": "cop-erasure-whole-a7d2df56a653",
        "input_path": "/tmp/cop-sim-whole-erasure-fixture-20261016.json",
        "holder": "8b3f25a792bf75b58edfca4519c4671a2b1db165a8c0d22285505dc892c7b30e",
    },
    "full-v2": {
        "owner": "cop-messaging-joint-7fb1c640a2de",
        "input_carrier": "cop-erasure-whole-e70f147c5b2f-node",
        "input_owner": "cop-erasure-whole-e70f147c5b2f",
        "input_path": "/tmp/cop-sim-whole-erasure-fixture-full-20261016.json",
        "holder": "3a2f1f879b6fd76038c2ad619f5e405fac62b1cbd0ad5e7d654515a875bb062f",
        "input_sha256": "403dcdec41b97f9bc1bc3027e36afbf90c437fef5681371e89dcd7035e13d9a4",
    },
}


def select_profile(name):
    # Closed, reviewed fixture identities only; never an arbitrary deployment.
    global PROFILE, OWNER, INPUT_CARRIER, INPUT_OWNER, HOLDER, NAMES
    PROFILE = PROFILES[name]
    OWNER = PROFILE["owner"]
    INPUT_CARRIER = PROFILE["input_carrier"]
    INPUT_OWNER = PROFILE["input_owner"]
    HOLDER = PROFILE["holder"]
    NAMES = {part: OWNER + "-sim-" + part for part in ("control", "driver", "router")}


select_profile("negative-v1")
IMAGES = {
    "driver": "sha256:ff8e60608936d4c97cba01e8d96ad064ce3950c6e2a9a115df88dd75fb8fb23d",
    "router": "sha256:d4176d79106315d8fe8df1649c7755d1bc2b5189f390fca796a4dbd23778cd2e",
}
SQL = [
    "deploy/driver-measurements/schema.sql",
    "deploy/driver-measurements/002_account_erasure.sql",
    "deploy/driver-measurements/008_eta_contributor_binding_database_v2.sql",
    "deploy/ai-router/001_schema.sql", "deploy/ai-router/002_separate_billing.sql",
    "deploy/ai-router/003_account_erasure.sql",
    "deploy/account-safety/010_sim_database_safety_v2.sql",
    "deploy/account-safety/011_sim_target_binding.sql",
]
RUNTIME = "scripts/fixtures/whole-erasure-sim-fixture.mjs"
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o",
       "HostName=192.168.10.116", "-o", "HostKeyAlias=docker.home.cz", "docker.home.cz"]


def remote(args, data=None, timeout=40, optional=False):
    result = subprocess.run(SSH + [shlex.join(args)], input=data, capture_output=True, timeout=timeout)
    if result.returncode and not optional:
        # Do not relay arbitrary subprocess stderr, which may include actor data.
        raise RuntimeError("SIM_FIXTURE_REMOTE_OPERATION_FAILED")
    return result


def inspect(name):
    result = remote(["docker", "inspect", name], optional=True)
    return json.loads(result.stdout)[0] if result.returncode == 0 else None


def holder():
    value = inspect(HOLDER)
    assert value and value["Id"] == HOLDER and value["Name"] == "/" + OWNER + "-pg"
    assert value["Config"]["Labels"].get("cop.test.owner") == OWNER
    assert value["HostConfig"]["NetworkMode"] == "none" and value["State"]["Running"]
    assert not value["HostConfig"].get("PortBindings") and not value["Mounts"]
    return value


def owned(part, required=True):
    value = inspect(NAMES[part])
    if value is None:
        assert not required
        return None
    labels = value["Config"].get("Labels") or {}
    assert labels.get("cop.test.owner") == OWNER
    assert labels.get("cop.test.component") == "sim-whole-erasure-" + part
    assert value["HostConfig"]["NetworkMode"] == "container:" + HOLDER
    assert not value["HostConfig"].get("PortBindings") and not value["Mounts"]
    assert value["HostConfig"]["ReadonlyRootfs"]
    assert value["Image"] == IMAGES["driver" if part == "driver" else "router"]
    return value


def create(part):
    holder()
    assert inspect(NAMES[part]) is None, "Refuse existing container"
    image = IMAGES["driver" if part == "driver" else "router"]
    metadata = json.loads(remote(["docker", "image", "inspect", image]).stdout)[0]
    assert metadata["Id"] == image
    assert metadata["Config"]["Labels"]["org.opencontainers.image.revision"] == "ca1fd6b6046745e91cca6648e1e5bd3f93fc8422"
    remote(["docker", "create", "--pull", "never", "--name", NAMES[part],
            "--label", "cop.test.owner=" + OWNER,
            "--label", "cop.test.component=sim-whole-erasure-" + part,
            "--network", "container:" + HOLDER, "--read-only", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges", "--memory", "256m", "--pids-limit", "80",
            "--tmpfs", "/fixture:rw,nosuid,nodev,size=16777216,mode=0700",
            "--tmpfs", "/private/tmp:rw,nosuid,nodev,size=16777216,mode=0700",
            "--env", "NODE_ENV=test", "--env", "SIM_FIXTURE_OWNER=" + OWNER,
            "--entrypoint", "node", image, "-e", "setInterval(()=>{},1000000)"])
    remote(["docker", "start", NAMES[part]])
    owned(part)


def archive(files):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as tar:
        directories = set()
        for path in files:
            for parent in Path(path).parents:
                if str(parent) != ".":
                    directories.add(str(parent))
        for path in sorted(directories, key=lambda value: (value.count("/"), value)):
            info = tarfile.TarInfo(path)
            info.type, info.mode = tarfile.DIRTYPE, 0o700
            tar.addfile(info)
        for path, content in files.items():
            info = tarfile.TarInfo(path)
            info.size, info.mode = len(content), 0o600
            tar.addfile(info, io.BytesIO(content))
    return output.getvalue()


def install(part, private):
    holder(); owned(part)
    files = {path: (ROOT / path).read_bytes() for path in [RUNTIME] + SQL}
    files["private.json"] = private
    # Docker archive-copy writes the daemon rootfs and refuses read-only roots.
    # Extract inside the running container into its existing private tmpfs;
    # the read-only root and all capability/network restrictions stay intact.
    remote(["docker", "exec", "-i", NAMES[part], "tar", "-x", "-C", "/fixture"], archive(files))


def run(part, action, component=None):
    holder(); owned(part)
    argv = ["docker", "exec", NAMES[part], "node", "/fixture/" + RUNTIME, action]
    if component:
        argv.append(component)
    result = remote(argv, timeout=90)
    value = json.loads(result.stdout)
    assert isinstance(value, dict)
    return value


def private_state():
    holder(); owned("control")
    return remote(["docker", "exec", NAMES["control"], "cat", "/fixture/private.json"]).stdout


def start_service(part):
    holder(); owned(part)
    remote(["docker", "exec", "-d", NAMES[part], "node", "/fixture/" + RUNTIME, "serve", part])


def ready():
    holder(); owned("control")
    # A real authenticated HTTP capability, not container liveness or a mock.
    code = """const fs=require('fs');const s=JSON.parse(fs.readFileSync('/fixture/private.json'));const paths={driver:'http://127.0.0.1:4311/api/v1/internal/driver-measurements/v1/account-erasure-operations/capability',router:'http://127.0.0.1:4312/api/v1/ai-router/cop/users/me/erasure-operations/capability'};const out={};for(const [k,u] of Object.entries(paths)){const r=await fetch(u,{headers:{authorization:'Bearer '+s.input.environment.copServiceToken},signal:AbortSignal.timeout(3000)});const b=await r.json();out[k]={status:r.status,ready:b.ready===true,wholeAccountComplete:b.wholeAccountComplete};}console.log(JSON.stringify(out));"""
    return json.loads(remote(["docker", "exec", NAMES["control"], "node", "--input-type=module", "-e", code.replace("const fs=require('fs');", "import fs from 'node:fs';")]).stdout)


def verify_readback():
    holder(); owned("control")
    for part in ("driver", "router"):
        owned(part)
    code = r"""
import fs from 'node:fs';import assert from 'node:assert/strict';
const state=JSON.parse(fs.readFileSync('/fixture/private.json'));
const auth={authorization:'Bearer '+state.input.environment.copServiceToken};
let checks=0;const check=(value)=>{assert.ok(value);checks++;};const baseline={};
async function get(url,options={}){
 for(let i=0;i<30;i++){
  const r=await fetch(url,{...options,signal:AbortSignal.timeout(5000)});
  const body=await r.json();if(r.status!==503)return {status:r.status,body,cache:r.headers.get('cache-control')};
  await new Promise(resolve=>setTimeout(resolve,50));
 }throw Error('READBACK_UNAVAILABLE');
}
for(const [part,port,owner,count] of [['driver',4321,'sim_measurements',3],['router',4322,'ai_router',4]]){
 const url='http://127.0.0.1:'+port+'/readback';
 check((await get(url)).status===401);
 check((await get(url,{headers:{authorization:'Bearer invalid-synthetic-token'}})).status===401);
 check((await get(url,{method:'POST',headers:auth})).status===404);
 check((await get(url+'/unknown',{headers:auth})).status===404);
 check((await get(url+'?query=not-allowed',{headers:auth})).status===404);
 check((await get(url,{headers:{...auth,origin:'https://browser.invalid'}})).status===404);
 const first=await get(url,{headers:auth});check(first.status===200);check(first.cache==='no-store');
 check(first.body.contractVersion==='cop-whole-erasure-readback-v1');
 check(Object.keys(first.body.owners).length===1&&Object.hasOwn(first.body.owners,owner));
 const actual=first.body.owners[owner];check(actual.removableA===count&&actual.removableB===count);
 check(/^[0-9a-f]{64}$/.test(actual.preservedBFingerprint));
 check(first.body.productionChanged===false&&first.body.wholeCopAccepted===false);
 const second=await get(url,{headers:auth});check(second.status===200&&second.body.owners[owner].preservedBFingerprint===actual.preservedBFingerprint);
 if(part==='router')check(first.body.simPreserved.syntheticKeyIntact===true&&first.body.simPreserved.keys===1&&first.body.simPreserved.requests===1&&first.body.simPreserved.billing===1);
 baseline[owner]=first.body;
}
fs.writeFileSync('/fixture/readback-initial-http.json',JSON.stringify(baseline),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({actualHttpReadbackChecks:checks,privateReadbackPath:'/fixture/readback-initial-http.json',productionChanged:false,providerCalls:0,wholeCopAccepted:false}));
"""
    result = remote(["docker", "exec", NAMES["control"], "node", "--input-type=module", "-e", code], timeout=40)
    return json.loads(result.stdout)


def serve(args):
    holder()
    for part in NAMES:
        assert inspect(NAMES[part]) is None, "Refuse existing fixture; use read/restart"
    assert re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}", args.input_container)
    assert args.input_container == INPUT_CARRIER and args.input_owner == INPUT_OWNER
    assert args.input_path == PROFILE["input_path"]
    carrier = inspect(args.input_container)
    assert carrier and carrier["State"]["Running"]
    assert (carrier["Config"].get("Labels") or {}).get("cop.test.owner") == args.input_owner
    if "input_sha256" in PROFILE:
        metadata = remote(["docker", "exec", args.input_container, "stat", "-c", "%a:%u:%F", args.input_path]).stdout.decode().strip()
        assert metadata == "600:1000:regular file"
    private = remote(["docker", "exec", args.input_container, "cat", args.input_path]).stdout
    assert 0 < len(private) <= 65536
    if "input_sha256" in PROFILE:
        assert hashlib.sha256(private).hexdigest() == PROFILE["input_sha256"]
    # Syntax only here; actual exact shape and supplied identity checks are in JS.
    assert json.loads(private)["contractVersion"] == "cop-sim-whole-erasure-fixture-v1"
    create("control"); install("control", private)
    run("control", "validate")
    provision = run("control", "provision")
    state = private_state()
    for part in ("driver", "router"):
        create(part); install(part, state)
        run(part, "seed", part)
        start_service(part)
    deadline = time.monotonic() + 25
    while True:
        try:
            health = ready()
            if all(row["status"] == 200 and row["ready"] for row in health.values()):
                break
        except (RuntimeError, json.JSONDecodeError):
            pass
        assert time.monotonic() < deadline, "Actual capability did not become ready"
        time.sleep(0.5)
    print(json.dumps({"status": "serving", "provision": provision, "health": health,
                     "privateRef": {"container": NAMES["control"], "path": "/fixture/private.json"},
                     "endpoints": {"driver": "http://127.0.0.1:4311", "router": "http://127.0.0.1:4312"},
                     "images": IMAGES, "runtimeSourceRevision": "ca1fd6b6046745e91cca6648e1e5bd3f93fc8422",
                     "bootstrapSha256": hashlib.sha256((ROOT / RUNTIME).read_bytes()).hexdigest(),
                     "productionChanged": False, "providerCalls": 0, "wholeCopAccepted": False}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["serve", "read", "ready", "verify-readback", "cleanup", "restart-driver", "restart-router"])
    parser.add_argument("--profile", choices=sorted(PROFILES), default="negative-v1")
    parser.add_argument("--input-container")
    parser.add_argument("--input-path")
    parser.add_argument("--input-owner")
    args = parser.parse_args()
    select_profile(args.profile)
    if args.action == "serve":
        assert args.input_container and args.input_path and args.input_owner
        serve(args)
    elif args.action == "read":
        components = {part: run(part, "read", part) for part in ("driver", "router")}
        owners = {}
        for part, owner, columns in [("driver", "sim_measurements", ["receipts", "intervals", "eta"]),
                                     ("router", "ai_router", ["keys", "key_audit", "requests", "billing"])]:
            actors = components[part]["actors"]
            owners[owner] = {"removableA": sum(actors["a"][key] for key in columns),
                             "removableB": sum(actors["b"][key] for key in columns),
                             "preservedBFingerprint": actors["b"]["storedRowsFingerprint"]}
        readback = {"contractVersion": "cop-whole-erasure-readback-v1", "owners": owners,
                    "simPreserved": components["router"]["actors"]["sim"], "components": components,
                    "productionChanged": False, "providerCalls": 0, "wholeCopAccepted": False}
        holder(); owned("control")
        remote(["docker", "exec", "-i", NAMES["control"], "node", "-e",
                "const fs=require('fs');let b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>fs.writeFileSync('/fixture/readback.json',Buffer.concat(b),{mode:0o600}));"],
               json.dumps(readback).encode())
        print(json.dumps({"privateReadbackRef": {"container": NAMES["control"], "path": "/fixture/readback.json"},
                          "ownerNames": sorted(owners), "wholeCopAccepted": False, "productionChanged": False}))
    elif args.action == "ready":
        print(json.dumps(ready()))
    elif args.action == "verify-readback":
        print(json.dumps(verify_readback()))
    elif args.action.startswith("restart-"):
        part = args.action.removeprefix("restart-")
        holder(); value = owned(part)
        remote(["docker", "restart", "--time", "10", NAMES[part]])
        # tmpfs state intentionally vanishes on container restart: reinstall the
        # original immutable fixture enrollment, never adopt a DB checkpoint.
        install(part, private_state()); start_service(part)
        print(json.dumps({"status": "restarted", "component": part, "productionChanged": False}))
    else:
        holder()
        for part in ("driver", "router", "control"):
            if owned(part, required=False):
                remote(["docker", "rm", "-f", NAMES[part]])
        print(json.dumps({"removedOwnServiceContainersOnly": True, "sharedHolderRemoved": False,
                          "databasesDropped": False, "productionChanged": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit("SIM_WHOLE_FIXTURE_FAILED; no private diagnostics were printed")
