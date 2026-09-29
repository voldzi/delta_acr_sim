#!/usr/bin/env bash
set -Eeuo pipefail

mode="${1:---check}"
if [[ "${mode}" != '--check' && "${mode}" != '--start' ]]; then
  echo 'Usage: start-valhalla-traffic-canary-ab.sh [--check|--start]' >&2
  exit 64
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
expected_release='/srv/valhalla/releases/20260929T081714Z/custom_files'
current_release="$(ssh valhalla.home.cz 'readlink -f /srv/valhalla/current')"
if [[ "${current_release}" != "${expected_release}" ]]; then
  echo "Refusing canary: active graph is ${current_release}." >&2
  exit 1
fi

weekly_state="$(ssh valhalla.home.cz 'systemctl show valhalla-weekly-update.service -p ActiveState --value')"
if [[ "${weekly_state}" != 'inactive' ]]; then
  echo "Refusing canary: weekly update is ${weekly_state}." >&2
  exit 1
fi

ssh valhalla.home.cz 'test ! -e /run/valhalla-traffic-canary/active && test "$(docker inspect --format "{{.State.Running}}" valhalla)" = true'
echo "Preflight OK: ${current_release}; ordinary Valhalla is running."
if [[ "${mode}" == '--check' ]]; then
  exit 0
fi

for file in traffic-canary-ab.py traffic-canary-rollback.sh valhalla-traffic-canary-ab.service; do
  scp "${root}/deploy/valhalla/${file}" "valhalla.home.cz:/home/voldzi/valhalla-owned-deploy/${file}"
  local_hash="$(shasum -a 256 "${root}/deploy/valhalla/${file}" | awk '{print $1}')"
  # The filename is from the fixed list above; client-side expansion is intended.
  # shellcheck disable=SC2029
  remote_hash="$(ssh valhalla.home.cz sha256sum "/home/voldzi/valhalla-owned-deploy/${file}" | awk '{print $1}')"
  if [[ "${local_hash}" != "${remote_hash}" ]]; then
    echo "Refusing canary: upload checksum mismatch for ${file}." >&2
    exit 1
  fi
done

# Refresh the 15-minute SIM vehicle lease before the sudo-protected job starts.
ssh docker.home.cz 'bash -s' <<'REMOTE' | python3 -c '
import json, sys
reply = json.load(sys.stdin)
routes = reply.get("routes") or []
if reply.get("source", {}).get("backend") != "valhalla" or not routes or routes[0].get("status") != "ok":
    raise SystemExit("SIM vehicle lease could not be established")
print("SIM vehicle lease refreshed.")
'
set -Eeuo pipefail
curl -fsS --max-time 35 \
  -H 'Content-Type: application/json' \
  --data '{"profileId":"car","from":{"lon":14.42076,"lat":50.08804},"to":{"lon":14.4461,"lat":50.0755},"includeTraffic":true,"alternatives":1}' \
  http://127.0.0.1:5020/situation-data/api/v1/routing/route
REMOTE

ssh -t valhalla.home.cz '
  sudo install -o root -g root -m 0755 /home/voldzi/valhalla-owned-deploy/traffic-canary-ab.py /srv/valhalla/update-tools/traffic-canary-ab.py &&
  sudo install -o root -g root -m 0755 /home/voldzi/valhalla-owned-deploy/traffic-canary-rollback.sh /srv/valhalla/update-tools/traffic-canary-rollback.sh &&
  sudo install -o root -g root -m 0644 /home/voldzi/valhalla-owned-deploy/valhalla-traffic-canary-ab.service /etc/systemd/system/valhalla-traffic-canary-ab.service &&
  sudo systemctl daemon-reload &&
  sudo systemctl start valhalla-traffic-update.service &&
  sudo systemctl start --no-block valhalla-traffic-canary-ab.service
'

echo 'Canary dispatched; ordinary Valhalla will be restored automatically.'
echo 'Inspect: ssh valhalla.home.cz "systemctl status valhalla-traffic-canary-ab.service --no-pager -l"'
