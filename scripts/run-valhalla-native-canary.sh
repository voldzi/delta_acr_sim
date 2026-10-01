#!/usr/bin/env bash
# One bounded private A/B sidecar. Never installs/activates a live map.
set -Eeuo pipefail
main() {
[[ "${1:---check}" == --start || "${1:---check}" == --check ]] || exit 64
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 "$root/deploy/valhalla/test-native-canary-ab.py"
work=/home/voldzi/valhalla-owned-deploy/native-canary-v2-20261001
graph=/srv/valhalla/releases/20260929T081714Z/custom_files
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
ssh valhalla.home.cz '
  test "$(readlink -f /srv/valhalla/current)" = /srv/valhalla/releases/20260929T081714Z/custom_files &&
  test "$(systemctl show valhalla-weekly-update.service -p ActiveState --value)" = inactive &&
  test "$(docker inspect --format "{{.State.Running}} {{.State.Health.Status}}" valhalla)" = "true healthy" &&
  test ! -e /run/valhalla-traffic-canary/active &&
  test "$(awk '\''/MemAvailable:/ {print $2}'\'' /proc/meminfo)" -gt 1800000
'
echo 'Preflight OK: reviewed graph, healthy ordinary Valhalla, sufficient memory.'
[[ "${1:---check}" == --start ]] || exit 0
ssh valhalla.home.cz "umask 077; install -d -m 0700 '$work' '$work/results-$stamp'"
scp "$root/deploy/valhalla/native-canary-ab.py" "$root/deploy/valhalla/traffic-update.py" "valhalla.home.cz:$work/"
declare -a pairs=(
  'native-v2-isolated-candidates-20261001.json.gz:candidates.json.gz'
  'current-baseline-20261001.json.gz:baseline.json.gz'
  'native-v2-national-static-20261001.json.gz:static.json.gz'
)
for pair in "${pairs[@]}"; do
  source="$root/data/valhalla/tmc/${pair%%:*}"
  destination="$work/${pair#*:}"
  scp "$source" "valhalla.home.cz:$destination"
  [[ "$(shasum -a 256 "$source" | awk '{print $1}')" == "$(ssh valhalla.home.cz sha256sum "$destination" | awk '{print $1}')" ]] || exit 1
done
for file in native-canary-ab.py traffic-update.py; do
  [[ "$(shasum -a 256 "$root/deploy/valhalla/$file" | awk '{print $1}')" == "$(ssh valhalla.home.cz sha256sum "$work/$file" | awk '{print $1}')" ]] || exit 1
done
ssh valhalla.home.cz "chmod 0600 '$work/'*.py '$work/'*.gz"
scp "$root/scripts/capture-native-canary-feed.mjs" docker.home.cz:/home/voldzi/sim-native-canary-feed.mjs
ssh docker.home.cz 'docker cp /home/voldzi/sim-native-canary-feed.mjs csm-sim-situation-data-api:/tmp/sim-native-canary-feed.mjs'
# A synthetic vehicle route activates the ordinary finite lease. No quota gate is changed.
ssh docker.home.cz 'curl -fsS --max-time 35 -H "Content-Type: application/json" --data '\''{"profileId":"car","from":{"lon":14.42076,"lat":50.08804},"to":{"lon":14.4461,"lat":50.0755},"includeTraffic":true,"alternatives":1}'\'' http://127.0.0.1:5020/situation-data/api/v1/routing/route' |
  python3 -c 'import json,sys; v=json.load(sys.stdin); assert v.get("source",{}).get("backend")=="valhalla" and v["routes"][0]["status"]=="ok"; print("Finite SIM vehicle lease activated.")'
capture=/home/voldzi/sim-native-canary-feed.json.gz
cleanup_capture() {
  ssh docker.home.cz "rm -f -- '$capture' /home/voldzi/sim-native-canary-feed.mjs; docker exec csm-sim-situation-data-api rm -f /tmp/sim-native-canary-feed.mjs" >/dev/null 2>&1 || true
}
trap cleanup_capture EXIT
ready=false
for attempt in $(seq 1 24); do
  if ssh docker.home.cz "umask 077; docker exec csm-sim-situation-data-api node /tmp/sim-native-canary-feed.mjs > '$capture'" 2>/dev/null; then
    scp -q "docker.home.cz:$capture" "$root/data/valhalla/tmc/native-canary-feed-$stamp.json.gz"
    chmod 0600 "$root/data/valhalla/tmc/native-canary-feed-$stamp.json.gz"
    scp -q "$root/data/valhalla/tmc/native-canary-feed-$stamp.json.gz" "valhalla.home.cz:$work/feed.json.gz"
    if ssh valhalla.home.cz "python3 - '$work'" <<'PY'
import importlib.util,sys,time
from pathlib import Path
w=Path(sys.argv[1]); s=importlib.util.spec_from_file_location('pilot',w/'native-canary-ab.py'); p=importlib.util.module_from_spec(s); s.loader.exec_module(p)
s=importlib.util.spec_from_file_location('traffic',w/'traffic-update.py'); t=importlib.util.module_from_spec(s); s.loader.exec_module(t)
c,b,st,f=[p.load(w/n) for n in ('candidates.json.gz','baseline.json.gz','static.json.gz','feed.json.gz')]
p.validate(c,b,st,f,p.sha(w/'baseline.json.gz'))
try:
    p.select(st,c,f,t,time.time())
    assert t.next_flow_recompute_epoch(f,c,f['maxAgeSeconds'])-time.time()>120
except (ValueError, AssertionError):
    print('Waiting for a sufficiently fresh normalized snapshot; no live mapping changed.')
    raise SystemExit(2)
print('Fresh stratified cohort has more than 120 seconds of remaining validity.')
PY
    then ready=true; break; fi
  fi
  sleep 15
done
[[ "$ready" == true ]] || { echo 'No sufficiently fresh snapshot; no live map changed.' >&2; exit 1; }
ssh valhalla.home.cz "bash -s -- '$work' '$graph' '$stamp'" <<'REMOTE'
set -Eeuo pipefail
work="$1"; graph="$2"; stamp="$3"
test "$(readlink -f /srv/valhalla/current)" = "$graph"
umask 077
control=$(mktemp -d /tmp/sim-native-pilot-control.XXXXXX)
cleanup() {
  if test -s "$control/container-id"; then
    read -r owned < "$control/container-id" || true
    [[ "$owned" =~ ^[0-9a-f]{64}$ ]] && docker rm -f "$owned" >/dev/null 2>&1 || true
  fi
  rm -f -- "$control/container-id"; rmdir "$control" 2>/dev/null || true
}
trap cleanup EXIT
image=ghcr.io/valhalla/valhalla-scripted:3.8.3@sha256:24ef7955899dececb94e26c6dfb89d64fabfae875f980432694b0261eb6c251b
status=0
timeout --foreground --signal=TERM --kill-after=5s 180 docker run --rm --cidfile "$control/container-id" \
  --network none --read-only --user "$(id -u):$(id -g)" --cpus 1 --memory 1536m --pids-limit 64 \
  --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp:rw,noexec,nosuid,size=256m,mode=1777 \
  --mount "type=bind,src=$graph,dst=/custom_files,readonly" \
  --mount "type=bind,src=$work,dst=/work,readonly" \
  --mount "type=bind,src=$work/results-$stamp,dst=/results" \
  --entrypoint python3 "$image" /work/native-canary-ab.py > "$work/results-$stamp/runtime.log" 2>&1 || status=$?
test "$(readlink -f /srv/valhalla/current)" = "$graph"
test "$(docker inspect --format '{{.State.Running}} {{.State.Health.Status}}' valhalla)" = 'true healthy'
python3 - "$work/results-$stamp/report.json" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
print(json.dumps({k:v for k,v in r.items() if k!='pairs'},sort_keys=True))
PY
exit "$status"
REMOTE
scp -q "valhalla.home.cz:$work/results-$stamp/report.json" "$root/data/valhalla/tmc/native-canary-result-$stamp.json"
chmod 0600 "$root/data/valhalla/tmc/native-canary-result-$stamp.json"
echo 'Private A/B result saved. Automated success is not live-use approval.'
}
main "$@"
