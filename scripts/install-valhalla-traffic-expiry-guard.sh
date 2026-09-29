#!/usr/bin/env bash
set -Eeuo pipefail

mode="${1:---check}"
if [[ "${mode}" != '--check' && "${mode}" != '--install' ]]; then
  echo 'Usage: install-valhalla-traffic-expiry-guard.sh [--check|--install]' >&2
  exit 64
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 "${root}/deploy/valhalla/test-traffic-update.py" >/dev/null
expected_release='/srv/valhalla/releases/20260929T081714Z/custom_files'
current_release="$(ssh valhalla.home.cz 'readlink -f /srv/valhalla/current')"
if [[ "${current_release}" != "${expected_release}" ]]; then
  echo "Refusing updater install: active graph is ${current_release}." >&2
  exit 1
fi
ssh valhalla.home.cz '
  test "$(systemctl show valhalla-weekly-update.service -p ActiveState --value)" = inactive &&
  test "$(systemctl show valhalla-traffic-update.timer -p ActiveState --value)" = active &&
  test "$(systemctl show valhalla-traffic-cohort-monitor-20260929.service -p ActiveState --value)" != active &&
  test ! -e /run/valhalla-traffic-canary/active &&
  test "$(docker inspect --format "{{.State.Running}}" valhalla)" = true
'
echo 'Preflight OK: exact graph, normal Valhalla and traffic timer are active; no audit is running.'
if [[ "${mode}" == '--check' ]]; then
  exit 0
fi

source="${root}/deploy/valhalla/traffic-update.py"
remote='/home/voldzi/valhalla-owned-deploy/traffic-update.py.expiry-next'
scp "${source}" "valhalla.home.cz:${remote}"
local_hash="$(shasum -a 256 "${source}" | awk '{print $1}')"
# Fixed remote filename is deliberately expanded on the client.
# shellcheck disable=SC2029
remote_hash="$(ssh valhalla.home.cz sha256sum "${remote}" | awk '{print $1}')"
if [[ "${local_hash}" != "${remote_hash}" ]]; then
  echo 'Refusing updater install: uploaded checksum differs.' >&2
  exit 1
fi

# Ensure the one-minute service has an active SIM vehicle lease for the
# post-install probe. This does not carry a provider token or private route.
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
  set -Eeuo pipefail
  active=/srv/valhalla/update-tools/traffic-update.py
  backup=/srv/valhalla/update-tools/traffic-update.py.before-expiry-20260929
  candidate=/home/voldzi/valhalla-owned-deploy/traffic-update.py.expiry-next
  restore_timer() { sudo systemctl start valhalla-traffic-update.timer || true; }
  trap restore_timer EXIT
  sudo systemctl stop valhalla-traffic-update.timer
  for attempt in $(seq 1 45); do
    if [ "$(systemctl show valhalla-traffic-update.service -p ActiveState --value)" != activating ]; then break; fi
    sleep 1
  done
  if [ "$(systemctl show valhalla-traffic-update.service -p ActiveState --value)" = activating ]; then
    echo "Updater did not become idle; old script retained." >&2
    exit 1
  fi
  sudo test ! -e "$backup"
  sudo cp -p "$active" "$backup"
  sudo install -o root -g root -m 0755 "$candidate" "$active"
  if ! sudo systemctl start valhalla-traffic-update.service; then
    echo "New updater failed; restoring previous script." >&2
    sudo install -o root -g root -m 0755 "$backup" "$active"
    sudo systemctl start valhalla-traffic-update.service || true
    exit 1
  fi
  sudo systemctl start valhalla-traffic-update.timer
  sudo sha256sum "$active"
  docker inspect -f "{{.State.Running}} {{.State.Health.Status}}" valhalla
'
echo 'Expiry-aware updater installed; ordinary Valhalla was not restarted.'
echo 'Inspect: ssh valhalla.home.cz "journalctl -u valhalla-traffic-update.service -n 30 --no-pager"'
