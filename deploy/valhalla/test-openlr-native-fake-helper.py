#!/usr/bin/env python3
"""Test-only protocol peer. Contains no provider data and is never deployed."""
import json
import os
import signal
import subprocess
import sys
import time

mode, graph_hash = sys.argv[1:3]
for line in sys.stdin:
    request = json.loads(line)
    if mode == "child_timeout":
        child = subprocess.Popen([sys.executable, "-c",
            "import os,time; from pathlib import Path; "
            "Path(os.environ['SIM_NATIVE_TEST_CHILD_PID_PATH']).write_text(str(os.getpid())); time.sleep(30)"])
        def reap_child(_signal, _frame):
            child.wait(timeout=2)
            sys.exit(0)
        signal.signal(signal.SIGTERM, reap_child)
        time.sleep(30)
        continue
    if mode == "ignore_timeout":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        time.sleep(30)
        continue
    if mode in {"timeout", "partial_timeout"}:
        if mode == "partial_timeout":
            sys.stdout.write('{"requestId":'); sys.stdout.flush()
        time.sleep(5)
        continue
    if mode == "stop":
        sys.exit(1)
    result = {"requestId": request["requestId"], "decoderVersion": "openlr-native-v1",
              "routingDataset": mode, "graphSha256": graph_hash, "corridorRevision": request.get("corridor", {}).get("revision", ""),
              "status": "unmatched", "expansions": 1}
    if mode == "wrong_identity":
        result["graphSha256"] = "f" * 64
    if mode in {"matched", "overlapping_partial"}:
        result.update(status="matched", lengthMeters=100,
            intervals=[{"edgeId": 1, "beginFraction": 0, "endFraction": 1, "edgeLengthMeters": 100}],
            fullEdgeIds=[1])
        if mode == "overlapping_partial" and request["requestId"] == 1:
            result.update(lengthMeters=50, intervals=[{"edgeId": 1, "beginFraction": .25,
                           "endFraction": .75, "edgeLengthMeters": 100}], fullEdgeIds=[])
    print(json.dumps(result), flush=True)
if mode == "final_verification_failure":
    sys.exit(1)
