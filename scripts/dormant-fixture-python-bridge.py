"""Opt-in, bounded STDIN-to-EOF codec test bridge; NOT a native transport.

Only pinned V5 pure decoder/canonical/digest/result/error helpers are called.
No registry, core load, SQLite fixture, native callback, .env or provider use.
The parent captures synthetic DTO bytes privately and reports only test results.
"""
import array
import base64
import dataclasses
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import sqlite3
import stat
import struct
import sys
import types
import uuid

MAX_INPUT = 1048576
MAX_OUTPUT = 1048576
MAX_CASES = 128
PINNED = {
    "boundary.py": "f0bffe6f0f6d3b26570050c2a0bcb59d27923e3a347f8967b9aba76240a859dd",
    "request.schema.json": "9cc8241cb5218ce0128d6ebe3fa66ead972b4eaf474145a4458d96879dcd1a50",
    "result.schema.json": "1f3153bc01ff1c9099a96ee1685655147320c0b7aaf2bf4f7e7fdf944511fcd6",
    "SOURCE-PINS.json": "90814725db2f78232d401fbdf83f6f5d99a16a146b67e648adfb76d4d018523f",
    "SCHEMA-FIXTURE-FRAMES.json": "c8163064b00f3f5f25a639dd7646938dff41538622092fd505b0f53a886023eb",
    "../dormant-core-v3/core.py": "b180c23d68cab41d966bca52d08a28fc71ca7fc162c500017f439c91a9401256",
    "../isolated-continuity/isolated-linux-wrapper/peer_wrapper.py": "64e26614bf4512157f09281e0fed7452bdd0c327a6e3f807059a062f027bd69b",
    "../isolated-continuity/isolated-linux-wrapper-v2/linux_fixture.py": "77d47471ba1939b3aa649a8d1973d901849e604db5dd6d27ccc7df29020c25c3",
}
GUARDS = dict(socketCalls=0, sqliteCalls=0, subprocessCalls=0, dataWriteCalls=0,
              lateFileOpenCalls=0, forbiddenCallbackCalls=0)
FLAGS = dict(productionAuthorization=False, actualProducer=False, actualAdmission=False,
             actualIdentity=False, actualOwnerEvidence=False, actualIndependentAnchor=False,
             actualProvider=False, actualSimPreservation=False, actualRestore=False,
             ownerWideReplayComplete=False, kernelDatabaseAtomicityClaim=False)


class BridgeRejected(Exception):
    """No payload/path/exception text may cross this boundary."""


def require(condition):
    if not condition:
        raise BridgeRejected()


def exact(value, names):
    require(type(value) is dict and set(value) == set(names))


def duplicate_free(items):
    require(len(dict(items)) == len(items))
    return dict(items)


def read_pinned(path, pin):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(fd)
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1 and metadata.st_size <= 1048576)
        data = os.read(fd, metadata.st_size + 1)
        require(len(data) == metadata.st_size and hashlib.sha256(data).hexdigest() == pin)
        return data
    finally:
        os.close(fd)


def audit(event, _args):
    category = None
    if event.startswith("socket."):
        category = "socketCalls"
    elif event.startswith("sqlite3."):
        category = "sqliteCalls"
    elif event.startswith("subprocess.") or event in ("os.system", "os.posix_spawn", "os.fork", "os.forkpty", "pty.spawn"):
        category = "subprocessCalls"
    elif event == "open":
        category = "lateFileOpenCalls"
    elif event in ("os.remove", "os.rename", "os.rmdir", "os.mkdir", "os.chmod", "os.chown", "os.truncate", "os.link", "os.symlink", "os.utime", "os.chdir", "os.listdir", "os.scandir"):
        category = "dataWriteCalls"
    if category:
        GUARDS[category] += 1
        raise BridgeRejected()


def forbidden_callback(*_args, **_kwargs):
    GUARDS["forbiddenCallbackCalls"] += 1
    raise BridgeRejected()


def safe_print(value):
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii")
    require(len(encoded) <= MAX_OUTPUT)
    sys.stdout.buffer.write(encoded + b"\n")
    sys.stdout.buffer.flush()


def main():
    require(sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode)
    require(len(sys.argv) == 4 and sys.argv[1:3] == ["--run", "--boundary-source"] and os.path.isabs(sys.argv[3]))
    source = Path(sys.argv[3])
    require(source.is_dir() and not source.is_symlink())
    source_bytes = {name: read_pinned(source / name, pin) for name, pin in PINNED.items()}
    manifest = json.loads(source_bytes["SOURCE-PINS.json"], object_pairs_hook=duplicate_free)
    require(manifest["protocol"] == "cop-dormant-boundary-fixture-v5" and manifest["mode"] == "own-fixture-only")
    require(manifest["productionAuthorization"] is False and manifest["acceptedWire"] is False)
    for name in ("boundary.py", "request.schema.json", "result.schema.json", "SCHEMA-FIXTURE-FRAMES.json"):
        require(manifest["sha256"][name] == PINNED[name])
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    require(0 < len(raw) <= MAX_INPUT)
    batch = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=duplicate_free)
    exact(batch, ("testProtocol", "cases"))
    require(batch["testProtocol"] == "sim-dormant-v5-codec-test-batch-v1" and type(batch["cases"]) is list and 0 < len(batch["cases"]) <= MAX_CASES)
    identifiers = set()
    for job in batch["cases"]:
        require(type(job) is dict and job.get("action") in ("decode", "encode_result", "encode_error"))
        exact(job, ("caseIndex", "action", "requestBase64", "result") if job["action"] == "encode_result" else ("caseIndex", "action", "requestBase64"))
        require(type(job["caseIndex"]) is int and 0 <= job["caseIndex"] < MAX_CASES and job["caseIndex"] not in identifiers)
        identifiers.add(job["caseIndex"])
        require(type(job["requestBase64"]) is str and len(job["requestBase64"]) <= 32768)

    # All stdlib imports and explicitly permitted pinned-file reads are complete.
    # From this point even a read-only late file open is refused.
    sys.addaudithook(audit)
    module = types.ModuleType("sim_owned_dormant_v5_pure_codec_test")
    module.__file__ = str(source / "boundary.py")
    sys.modules[module.__name__] = module
    exec(compile(source_bytes["boundary.py"], "pinned-dormant-v5-codec-source", "exec"), module.__dict__)
    require(module.PROTOCOL == "cop-dormant-boundary-fixture-v5" and module.FALSE == FLAGS and module._CORE_MODULES == [])
    for name in ("load_core", "load_pinned", "Registry", "Boundary", "LinuxFixtureAdapter", "close_received_rights", "binding_digest"):
        setattr(module, name, forbidden_callback)
    records = []
    for job in batch["cases"]:
        record = {"caseIndex": job["caseIndex"], "accepted": False}
        try:
            packet = base64.b64decode(job["requestBase64"], validate=True)
            require(base64.b64encode(packet).decode("ascii") == job["requestBase64"])
            if job["action"] == "decode":
                decoded = module.decode(packet)
                record.update(accepted=True, canonicalBase64=base64.b64encode(module.canonical_frame(decoded)).decode("ascii"),
                              frameDigest=module.frame_digest(decoded), correlationDigest=module.correlation_digest(decoded))
            elif job["action"] == "encode_result":
                decoded = module.decode(packet)
                record.update(accepted=True, responseBase64=base64.b64encode(module.encode_result(decoded, job["result"])).decode("ascii"))
            else:
                record.update(accepted=True, responseBase64=base64.b64encode(module.encode_error(packet)).decode("ascii"))
        except module.Denied:
            record["errorClass"] = "Denied"
        except (BridgeRejected, UnicodeError, ValueError, TypeError, KeyError, RecursionError):
            record["errorClass"] = "BridgeRejected"
        records.append(record)
    require(module._CORE_MODULES == [] and all(count == 0 for count in GUARDS.values()))
    safe_print({"testProtocol": "sim-dormant-v5-codec-test-batch-v1", "scope": "pure_pinned_python_helpers_only", "records": records,
                "guards": GUARDS, "actualNativeTransport": False, "actualDatabase": False, "actualCoreLoaded": False,
                "rootHistoricalTestsAdded": 0, "pythonVersion": list(sys.version_info[:3]), "flags": FLAGS})


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        safe_print({"testProtocol": "sim-dormant-v5-codec-test-batch-v1", "status": "bridge_setup_or_guard_failed",
                    "guards": GUARDS, "actualNativeTransport": False, "actualDatabase": False, "flags": FLAGS})
        raise SystemExit(1)
