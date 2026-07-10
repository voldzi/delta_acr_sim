#!/usr/bin/env bash
set -Eeuo pipefail

BASE_DIR=${BASE_DIR:-/srv/valhalla}
STATE_DIR=${STATE_DIR:-${BASE_DIR}/state}
CURRENT_LINK=${CURRENT_LINK:-${BASE_DIR}/current}
VALIDATOR=${BASE_DIR}/update-tools/validate-response.py
MAX_RELEASE_AGE_SECONDS=${MAX_RELEASE_AGE_SECONDS:-691200}
MIN_RUNTIME_FREE_GB=${MIN_RUNTIME_FREE_GB:-10}

bind_address=$(sed -n 's/^VALHALLA_BIND_ADDRESS=//p' "${BASE_DIR}/.env")
port=$(sed -n 's/^VALHALLA_PORT=//p' "${BASE_DIR}/.env")
[[ "${bind_address}" != "0.0.0.0" ]] || bind_address=127.0.0.1
base_url="http://${bind_address:-127.0.0.1}:${port:-8002}"
current=$(readlink -f "${CURRENT_LINK}")

status_response=$(mktemp)
route_response=$(mktemp)
trap 'rm -f "${status_response}" "${route_response}"' EXIT

curl -fsS --connect-timeout 3 --max-time 8 "${base_url}/status" -o "${status_response}"
python3 "${VALIDATOR}" status "${status_response}"

if grep -qx 'VALIDATION_PROFILE=full' "${current}/release.env"; then
  curl -fsS --connect-timeout 3 --max-time 8 --get --data-urlencode \
    'json={"locations":[{"lat":49.19114,"lon":16.61158,"radius":2500,"search_cutoff":2500},{"lat":48.20849,"lon":16.37208,"radius":2500,"search_cutoff":2500}],"costing":"auto","units":"kilometers","admin_crossings":true,"elevation_interval":100}' \
    "${base_url}/route" -o "${route_response}"
  python3 "${VALIDATOR}" route "${route_response}" --max-km 180 --max-snap-m 2500 \
    --expected-admins CZ,AT --from-lat 49.19114 --from-lon 16.61158 \
    --to-lat 48.20849 --to-lon 16.37208 --require-elevation
fi

python3 - "${STATE_DIR}/last-success.env" "${MAX_RELEASE_AGE_SECONDS}" <<'PY'
from datetime import datetime, timezone
from pathlib import Path
import sys

state = Path(sys.argv[1])
maximum = int(sys.argv[2])
values = dict(line.split("=", 1) for line in state.read_text(encoding="utf-8").splitlines() if "=" in line)
stamp = values.get("ACTIVATED_AT")
if not stamp:
    raise SystemExit("last-success.env has no ACTIVATED_AT")
age = (datetime.now(timezone.utc) - datetime.fromisoformat(stamp.replace("Z", "+00:00"))).total_seconds()
if age > maximum:
    raise SystemExit(f"active Valhalla release is stale: {int(age)} seconds")
PY

free_gb=$(df -Pk "${BASE_DIR}" | awk 'NR == 2 {print int($4 / 1024 / 1024)}')
(( free_gb >= MIN_RUNTIME_FREE_GB )) || {
  echo "Valhalla runtime has only ${free_gb} GB free; ${MIN_RUNTIME_FREE_GB} GB required." >&2
  exit 1
}

systemctl is-enabled --quiet valhalla-weekly-update.timer
echo "Valhalla healthcheck passed for $(basename "$(dirname "${current}")")."
