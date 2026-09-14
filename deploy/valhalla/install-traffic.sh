#!/usr/bin/env bash
set -Eeuo pipefail

BASE_DIR=${BASE_DIR:-/srv/valhalla}
SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SIM_TRAFFIC_FEED_BASE_URL=${SIM_TRAFFIC_FEED_BASE_URL:-http://docker.home.cz:5020/situation-data/api/v1/internal/valhalla-traffic}
SIM_TRAFFIC_CONTROL_TOKEN=${SIM_TRAFFIC_CONTROL_TOKEN:-}

if (( EUID != 0 )); then
  echo "Run this installer through sudo." >&2
  exit 1
fi
[[ -n "${SIM_TRAFFIC_CONTROL_TOKEN}" ]] || {
  echo "SIM_TRAFFIC_CONTROL_TOKEN must be supplied without printing it." >&2
  exit 1
}

current=$(readlink -f "${BASE_DIR}/current")
[[ -d "${current}" && -s "${current}/valhalla_tiles.tar" && -f "${current}/valhalla.json" ]] || {
  echo "The active Valhalla release is incomplete." >&2
  exit 1
}
bind_address=$(sed -n 's/^VALHALLA_BIND_ADDRESS=//p' "${BASE_DIR}/.env" | tail -1)
port=$(sed -n 's/^VALHALLA_PORT=//p' "${BASE_DIR}/.env" | tail -1)
VALHALLA_RUNTIME_URL=${VALHALLA_RUNTIME_URL:-http://${bind_address:-127.0.0.1}:${port:-8002}}

install -d -m 0755 "${BASE_DIR}/update-tools" "${BASE_DIR}/traffic-cache" /run/valhalla-traffic
compose_backup=$(mktemp)
config_backup=$(mktemp)
cp -a "${BASE_DIR}/docker-compose.yml" "${compose_backup}"
cp -a "${current}/valhalla.json" "${config_backup}"

restore_install() {
  cp -a "${compose_backup}" "${BASE_DIR}/docker-compose.yml"
  cp -a "${config_backup}" "${current}/valhalla.json"
  rm -f /run/valhalla-traffic/traffic.tar /run/valhalla-traffic/applied-edges.json /run/valhalla-traffic/last-applied.json
  docker compose -f "${BASE_DIR}/docker-compose.yml" up -d --force-recreate --no-deps valhalla >/dev/null 2>&1 || true
}
capture_container_failure() {
  docker logs --tail 250 valhalla >"${BASE_DIR}/state/traffic-install-failure.log" 2>&1 || true
  chmod 0640 "${BASE_DIR}/state/traffic-install-failure.log" 2>/dev/null || true
}
rollback_armed=true
on_error() {
  local status=$?
  trap - ERR
  if [[ "${rollback_armed}" == true ]]; then
    restore_install
  fi
  exit "${status}"
}
trap on_error ERR
install -m 0755 "${SOURCE_DIR}/traffic-update.py" "${BASE_DIR}/update-tools/traffic-update.py"
install -m 0755 "${SOURCE_DIR}/runtime-entrypoint.sh" "${BASE_DIR}/update-tools/runtime-entrypoint.sh"
install -m 0755 "${SOURCE_DIR}/weekly-update.sh" "${BASE_DIR}/update-tools/weekly-update.sh"
install -m 0644 "${SOURCE_DIR}/docker-compose.yml" "${BASE_DIR}/docker-compose.yml"
install -m 0644 "${SOURCE_DIR}/valhalla-traffic-update.service" /etc/systemd/system/valhalla-traffic-update.service
install -m 0644 "${SOURCE_DIR}/valhalla-traffic-update.timer" /etc/systemd/system/valhalla-traffic-update.timer

traffic_env=$(mktemp)
trap 'rm -f -- "${traffic_env}" "${build_config:-}" "${compose_backup}" "${config_backup}"' EXIT
{
  printf 'SIM_TRAFFIC_FEED_BASE_URL=%s\n' "${SIM_TRAFFIC_FEED_BASE_URL}"
  printf 'SIM_TRAFFIC_CONTROL_TOKEN=%s\n' "${SIM_TRAFFIC_CONTROL_TOKEN}"
  printf 'VALHALLA_URL=%s\n' "${VALHALLA_RUNTIME_URL}"
  printf 'TRAFFIC_MAPPING_CACHE_DIR=%s/traffic-cache\n' "${BASE_DIR}"
  printf 'TRAFFIC_RUNTIME_DIR=/run/valhalla-traffic\n'
  printf 'TRAFFIC_SKELETON=%s/current/traffic-skeleton.tar\n' "${BASE_DIR}"
  printf 'TRAFFIC_MAPPING_WORKERS=2\n'
  printf 'TRAFFIC_MAX_AGE_SECONDS=1800\n'
} >"${traffic_env}"
install -m 0600 "${traffic_env}" "${BASE_DIR}/.traffic.env"

if [[ ! -s "${current}/traffic-skeleton.tar" ]]; then
  build_config=$(mktemp --tmpdir="${current}" valhalla-traffic-build.XXXXXX.json)
  python3 - "${current}/valhalla.json" "${build_config}" <<'PY'
import json
from pathlib import Path
import sys
source, target = map(Path, sys.argv[1:])
config = json.loads(source.read_text(encoding="utf-8"))
config.setdefault("mjolnir", {})["traffic_extract"] = "/custom_files/traffic.tar"
target.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
PY
  image=$(sed -n 's/^VALHALLA_IMAGE=//p' "${BASE_DIR}/.env" | tail -1)
  [[ -n "${image}" ]] || image=$(sed -n 's/^VALHALLA_IMAGE=//p' "${BASE_DIR}/.update.env" | tail -1)
  [[ -n "${image}" ]] || { echo "Pinned Valhalla image is missing." >&2; exit 1; }
  docker run --rm -v "${current}:/custom_files" --entrypoint valhalla_build_extract "${image}" \
    -c "/custom_files/$(basename "${build_config}")" \
    -e /custom_files/valhalla_tiles.traffic-build.tar -O -t -v
  rm -f "${current}/valhalla_tiles.traffic-build.tar" "${build_config}"
  build_config=
  mv "${current}/traffic.tar" "${current}/traffic-skeleton.tar"
fi

if [[ ! -f "${current}/valhalla.json.pre-live-traffic" ]]; then
  cp -a "${current}/valhalla.json" "${current}/valhalla.json.pre-live-traffic"
fi
python3 - "${current}/valhalla.json" <<'PY'
import json
from pathlib import Path
import sys
path = Path(sys.argv[1])
config = json.loads(path.read_text(encoding="utf-8"))
config.setdefault("mjolnir", {})["traffic_extract"] = "/traffic/traffic.tar"
path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
PY

systemctl stop valhalla-traffic-update.timer valhalla-traffic-update.service 2>/dev/null || true
docker compose -f "${BASE_DIR}/docker-compose.yml" stop valhalla >/dev/null
install -m 0644 "${current}/traffic-skeleton.tar" /run/valhalla-traffic/traffic.tar
rm -f /run/valhalla-traffic/applied-edges.json /run/valhalla-traffic/last-applied.json
if ! docker compose -f "${BASE_DIR}/docker-compose.yml" up -d --force-recreate --no-deps valhalla >/dev/null; then
  capture_container_failure
  restore_install
  echo "Valhalla traffic compose failed; the previous runtime was restored." >&2
  exit 1
fi

ready=false
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "${VALHALLA_RUNTIME_URL}/status" >/dev/null; then
    ready=true
    break
  fi
  sleep 2
done
if [[ "${ready}" != true ]]; then
  capture_container_failure
  restore_install
  echo "Valhalla did not become ready with the traffic overlay; the previous runtime was restored." >&2
  exit 1
fi

curl -fsS --max-time 15 --get --data-urlencode \
  'json={"locations":[{"lat":50.08804,"lon":14.42076},{"lat":50.07550,"lon":14.43780}],"costing":"auto","date_time":{"type":0},"admin_crossings":true}' \
  "${VALHALLA_RUNTIME_URL}/route" -o "${BASE_DIR}/state/traffic-install-route.json"
python3 "${BASE_DIR}/update-tools/validate-response.py" route "${BASE_DIR}/state/traffic-install-route.json" \
  --max-km 10 --max-snap-m 2500 --expected-admins CZ \
  --from-lat 50.08804 --from-lon 14.42076 --to-lat 50.07550 --to-lon 14.43780

systemctl daemon-reload
systemctl enable --now valhalla-traffic-update.timer
systemctl reset-failed valhalla-traffic-update.service || true
rollback_armed=false
rm -f "${BASE_DIR}/state/traffic-install-failure.log"
echo "Adaptive Valhalla traffic updater installed; the first road request will activate it."
