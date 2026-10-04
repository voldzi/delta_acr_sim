#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=${1:?Usage: bash scripts/test-mapped-profile-engine.sh IMAGE-with-Valhalla-3.8.3}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sim-profile-test.XXXXXXXX")
NAME="sim-profile-test-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf -- "$WORK"; }
trap cleanup EXIT
python3 "$ROOT/scripts/generate-mapped-profile-test-pbf.py" "$WORK"
docker run --rm --platform linux/amd64 --network none --memory 768m --cpus 1 \
  -v "$WORK:/probe" --entrypoint /bin/sh "$IMAGE" -c '
valhalla_build_config --mjolnir-tile-dir /probe/tiles --mjolnir-concurrency 1 --mjolnir-admin /probe/missing-admin.sqlite --mjolnir-timezone /probe/missing-tz.sqlite |
python3 -c '\''import sys,json,pathlib;v=json.load(sys.stdin);v["mjolnir"]["tile_extract"]="";pathlib.Path("/probe/config.json").write_text(json.dumps(v))'\''
valhalla_build_tiles -c /probe/config.json /probe/synthetic.osm.pbf' >/dev/null
docker run -d --name "$NAME" --platform linux/amd64 --network none --memory 768m --cpus 1 \
  -v "$WORK:/probe:ro" -v "$ROOT/scripts/assert-mapped-profile-engine.py:/assert-profiles.py:ro" \
  --entrypoint valhalla_service "$IMAGE" /probe/config.json 1 >/dev/null
READY=false
for attempt in {1..30}; do
  if docker exec "$NAME" python3 -c 'import urllib.request;urllib.request.urlopen("http://127.0.0.1:8002/status",timeout=1)' >/dev/null 2>&1; then READY=true; break; fi
  sleep 1
done
if [[ "$READY" != true ]]; then echo 'Synthetic engine did not become ready.' >&2; exit 1; fi
node "$ROOT/scripts/mapped-profile-engine-plan.mjs" "$WORK/cases.json" | docker exec -i "$NAME" python3 /assert-profiles.py
docker image inspect "$IMAGE" --format 'Test image: {{.Id}}'
