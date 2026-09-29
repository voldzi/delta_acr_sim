#!/usr/bin/env bash
set -Eeuo pipefail

mode="${1:---check}"
if [[ "${mode}" != '--check' && "${mode}" != '--start' ]]; then
  echo 'Usage: start-valhalla-traffic-cohort-monitor.sh [--check|--start]' >&2
  exit 64
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
expected_release='/srv/valhalla/releases/20260929T081714Z/custom_files'
current_release="$(ssh valhalla.home.cz 'readlink -f /srv/valhalla/current')"
if [[ "${current_release}" != "${expected_release}" ]]; then
  echo "Refusing cohort monitor: active graph is ${current_release}." >&2
  exit 1
fi
ssh valhalla.home.cz '
  test "$(systemctl show valhalla-weekly-update.service -p ActiveState --value)" = inactive &&
  test "$(docker inspect --format "{{.State.Running}}" valhalla)" = true &&
  test ! -e /run/valhalla-traffic-canary/active &&
  test "$(systemctl show valhalla-traffic-cohort-monitor-20260929.service -p ActiveState --value)" != active
'
echo "Preflight OK: ${current_release}; ordinary Valhalla is running; no canary or monitor is active."
if [[ "${mode}" == '--check' ]]; then
  exit 0
fi

source="${root}/deploy/valhalla/traffic-cohort-monitor.py"
remote='/home/voldzi/valhalla-owned-deploy/traffic-cohort-monitor.py'
scp "${source}" "valhalla.home.cz:${remote}"
local_hash="$(shasum -a 256 "${source}" | awk '{print $1}')"
# The fixed remote filename is deliberately expanded by this client script.
# shellcheck disable=SC2029
remote_hash="$(ssh valhalla.home.cz sha256sum "${remote}" | awk '{print $1}')"
if [[ "${local_hash}" != "${remote_hash}" ]]; then
  echo 'Refusing cohort monitor: uploaded checksum differs.' >&2
  exit 1
fi

# One car route opens SIM's normal 15-minute traffic lease; no provider token
# enters this script or the shell command line.
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
  sudo install -o root -g root -m 0755 /home/voldzi/valhalla-owned-deploy/traffic-cohort-monitor.py /srv/valhalla/update-tools/traffic-cohort-monitor.py &&
  sudo systemd-run --unit=valhalla-traffic-cohort-monitor-20260929 --collect \
    --property=RuntimeMaxSec=900 --property=Nice=10 \
    --property=CPUWeight=20 --property=IOWeight=20 \
    /usr/bin/python3 /srv/valhalla/update-tools/traffic-cohort-monitor.py
'
echo 'Aggregate-only 13-minute cohort observation dispatched; normal routing and traffic timer remain untouched.'
echo 'Inspect: ssh valhalla.home.cz "journalctl -u valhalla-traffic-cohort-monitor-20260929.service -n 30 --no-pager"'
