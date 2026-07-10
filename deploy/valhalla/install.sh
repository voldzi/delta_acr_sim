#!/usr/bin/env bash
set -Eeuo pipefail

BASE_DIR=${BASE_DIR:-/srv/valhalla}
SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PINNED_IMAGE="ghcr.io/valhalla/valhalla-scripted:3.8.2@sha256:3d7a08f7e78b356ee873b61711b743ad81bcc114b0ca5731217da8bba6ba39d1"
START_INITIAL_UPDATE=${START_INITIAL_UPDATE:-false}

if (( EUID != 0 )); then
  echo "Run this installer through sudo." >&2
  exit 1
fi

for command in curl docker install python3; do
  command -v "${command}" >/dev/null || {
    echo "Required command is missing: ${command}" >&2
    exit 1
  }
done
docker compose version >/dev/null

install -d -m 0755 \
  "${BASE_DIR}" \
  "${BASE_DIR}/releases" \
  "${BASE_DIR}/state" \
  "${BASE_DIR}/update-work" \
  "${BASE_DIR}/update-tools"

for file in \
  weekly-update.sh \
  make-buffer.py \
  geojson-bbox.py \
  validate-response.py \
  validate-admins.py \
  healthcheck.sh; do
  install -m 0755 "${SOURCE_DIR}/${file}" "${BASE_DIR}/update-tools/${file}"
done
for file in Dockerfile.osm-tools README.md .env.example update.env.example; do
  install -m 0644 "${SOURCE_DIR}/${file}" "${BASE_DIR}/update-tools/${file}"
done

if [[ ! -f "${BASE_DIR}/.env" ]]; then
  install -m 0644 "${SOURCE_DIR}/.env.example" "${BASE_DIR}/.env"
fi
if [[ ! -f "${BASE_DIR}/.update.env" ]]; then
  install -m 0644 "${SOURCE_DIR}/update.env.example" "${BASE_DIR}/.update.env"
fi

python3 - "${BASE_DIR}/.env" "${PINNED_IMAGE}" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
image = sys.argv[2]
lines = path.read_text(encoding="utf-8").splitlines()
updates = {
    "VALHALLA_IMAGE": image,
    "VALHALLA_USE_TILES_IGNORE_PBF": "True",
    "VALHALLA_FORCE_REBUILD": "False",
    "VALHALLA_BUILD_ADMINS": "False",
    "VALHALLA_BUILD_TIME_ZONES": "False",
    "VALHALLA_BUILD_ELEVATION": "False",
}
seen = set()
output = []
for line in lines:
    key = line.split("=", 1)[0] if "=" in line else ""
    if key in updates:
        output.append(f"{key}={updates[key]}")
        seen.add(key)
    else:
        output.append(line)
for key, value in updates.items():
    if key not in seen:
        output.append(f"{key}={value}")
path.write_text("\n".join(output) + "\n", encoding="utf-8")
PY

if [[ ! -L "${BASE_DIR}/current" ]]; then
  legacy="${BASE_DIR}/custom_files"
  [[ -d "${legacy}/valhalla_tiles" && -s "${legacy}/valhalla_tiles.tar" && -s "${legacy}/admins.sqlite" ]] || {
    echo "Cannot adopt current production data from ${legacy}." >&2
    exit 1
  }
  baseline_id="baseline-$(date -u +%Y%m%dT%H%M%SZ)"
  baseline="${BASE_DIR}/releases/${baseline_id}"
  install -d -m 0755 "${baseline}"
  cp -al "${legacy}" "${baseline}/custom_files"
  {
    printf 'RELEASE_ID=%s\n' "${baseline_id}"
    printf 'BUILT_AT=unknown\n'
    printf 'SOURCE_COUNTRIES=CZ\n'
    printf 'VALIDATION_PROFILE=basic\n'
    printf 'VALHALLA_IMAGE=%s\n' "${PINNED_IMAGE}"
  } >"${baseline}/custom_files/release.env"
  touch "${baseline}/.complete"
  ln -s "${baseline}/custom_files" "${BASE_DIR}/current"
  {
    printf 'RELEASE_ID=%s\n' "${baseline_id}"
    printf 'TARGET=%s\n' "${baseline}/custom_files"
    printf 'PREVIOUS_TARGET=\n'
    printf 'ACTIVATED_AT=%s\n' "$(date -u +%FT%TZ)"
  } >"${BASE_DIR}/state/active.env"
fi

if [[ -f "${BASE_DIR}/docker-compose.yml" ]]; then
  cp -a "${BASE_DIR}/docker-compose.yml" "${BASE_DIR}/docker-compose.yml.pre-owned-valhalla"
fi
install -m 0644 "${SOURCE_DIR}/docker-compose.yml" "${BASE_DIR}/docker-compose.yml"
docker compose -f "${BASE_DIR}/docker-compose.yml" config --quiet

docker rm -f valhalla-install-candidate >/dev/null 2>&1 || true
docker run -d --name valhalla-install-candidate --cpus 2 --memory 2g \
  -p 127.0.0.1:18003:8002 \
  -v "${BASE_DIR}/current:/custom_files:ro" --entrypoint valhalla_service "${PINNED_IMAGE}" \
  /custom_files/valhalla.json 2 >/dev/null
candidate_ready=false
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 http://127.0.0.1:18003/status >/dev/null; then
    candidate_ready=true
    break
  fi
  sleep 2
done
docker rm -f valhalla-install-candidate >/dev/null 2>&1 || true
[[ "${candidate_ready}" == "true" ]] || {
  echo "Pinned image could not serve the adopted release read-only; production compose was not changed." >&2
  cp -a "${BASE_DIR}/docker-compose.yml.pre-owned-valhalla" "${BASE_DIR}/docker-compose.yml"
  exit 1
}

install -m 0644 "${SOURCE_DIR}/valhalla-weekly-update.service" /etc/systemd/system/valhalla-weekly-update.service
install -m 0644 "${SOURCE_DIR}/valhalla-weekly-update.timer" /etc/systemd/system/valhalla-weekly-update.timer
install -m 0644 "${SOURCE_DIR}/valhalla-update-recovery.service" /etc/systemd/system/valhalla-update-recovery.service
install -m 0644 "${SOURCE_DIR}/valhalla-healthcheck.service" /etc/systemd/system/valhalla-healthcheck.service
install -m 0644 "${SOURCE_DIR}/valhalla-healthcheck.timer" /etc/systemd/system/valhalla-healthcheck.timer

if ! docker compose -f "${BASE_DIR}/docker-compose.yml" up -d --force-recreate --no-deps valhalla; then
  cp -a "${BASE_DIR}/docker-compose.yml.pre-owned-valhalla" "${BASE_DIR}/docker-compose.yml"
  docker compose -f "${BASE_DIR}/docker-compose.yml" up -d --force-recreate --no-deps valhalla || true
  echo "New production compose failed; previous compose was restored." >&2
  exit 1
fi
bind_address=$(sed -n 's/^VALHALLA_BIND_ADDRESS=//p' "${BASE_DIR}/.env")
port=$(sed -n 's/^VALHALLA_PORT=//p' "${BASE_DIR}/.env")
[[ "${bind_address}" != "0.0.0.0" ]] || bind_address=127.0.0.1
base_url="http://${bind_address:-127.0.0.1}:${port:-8002}"
for _ in $(seq 1 60); do
  if curl -fsS --max-time 5 "${base_url}/status" >/dev/null; then
    break
  fi
  sleep 2
done
curl -fsS --max-time 5 "${base_url}/status" -o "${BASE_DIR}/state/install-status.json"
python3 "${BASE_DIR}/update-tools/validate-response.py" status "${BASE_DIR}/state/install-status.json"
curl -fsS --max-time 8 --get --data-urlencode \
  'json={"locations":[{"lat":50.08804,"lon":14.42076,"radius":2500,"search_cutoff":2500},{"lat":50.07550,"lon":14.43780,"radius":2500,"search_cutoff":2500}],"costing":"auto","units":"kilometers","admin_crossings":true}' \
  "${base_url}/route" -o "${BASE_DIR}/state/install-route.json"
python3 "${BASE_DIR}/update-tools/validate-response.py" route "${BASE_DIR}/state/install-route.json" \
  --max-km 10 --max-snap-m 2500 --expected-admins CZ \
  --from-lat 50.08804 --from-lon 14.42076 --to-lat 50.07550 --to-lon 14.43780

cp "${BASE_DIR}/state/active.env" "${BASE_DIR}/state/last-success.env"

systemctl daemon-reload
systemctl enable valhalla-update-recovery.service valhalla-weekly-update.timer valhalla-healthcheck.timer
systemctl restart valhalla-update-recovery.service
systemctl start valhalla-weekly-update.timer
systemctl start valhalla-healthcheck.timer
systemctl start valhalla-healthcheck.service
systemctl reset-failed valhalla-weekly-update.service || true

if [[ "${START_INITIAL_UPDATE}" == "true" ]]; then
  systemctl start --no-block valhalla-weekly-update.service
  echo "Initial validated build and activation started in valhalla-weekly-update.service."
fi

echo "Valhalla updater installed. Current release: $(readlink -f "${BASE_DIR}/current")"
