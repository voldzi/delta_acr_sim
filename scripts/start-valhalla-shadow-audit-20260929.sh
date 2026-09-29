#!/usr/bin/env bash
set -Eeuo pipefail

# Starts an audit-only OpenLR route-candidate run on the 2026-09-29 pilot graph.
# No live updater, traffic archive, service, or timer is changed.

mode="${1:---check}"
if [[ "${mode}" != "--check" && "${mode}" != "--start" ]]; then
  echo 'Usage: start-valhalla-shadow-audit-20260929.sh [--check|--start]' >&2
  exit 64
fi

expected_release='/srv/valhalla/releases/20260929T081714Z/custom_files'
shadow_source='/home/voldzi/valhalla-owned-deploy/traffic-update-shadow-v3-20260929.py'
shadow_target='/srv/valhalla/update-tools/traffic-shadow-audit-v3-20260929.py'
expected_hash='51ce64bfe9bc8d45f0fb0f82318a84da3b068093412be692c99dae3c84e40592'

current_release="$(ssh valhalla.home.cz 'readlink -f /srv/valhalla/current')"
if [[ "${current_release}" != "${expected_release}" ]]; then
  echo "Refusing audit: active graph is ${current_release}, expected ${expected_release}." >&2
  exit 1
fi

weekly_state="$(ssh valhalla.home.cz 'systemctl show valhalla-weekly-update.service -p ActiveState --value')"
if [[ "${weekly_state}" != 'inactive' ]]; then
  echo "Refusing audit: weekly map update is ${weekly_state}." >&2
  exit 1
fi

staged_hash="$(ssh valhalla.home.cz 'sha256sum /home/voldzi/valhalla-owned-deploy/traffic-update-shadow-v3-20260929.py' | awk '{print $1}')"
if [[ "${staged_hash}" != "${expected_hash}" ]]; then
  echo 'Refusing audit: staged shadow script hash does not match the tested version.' >&2
  exit 1
fi

echo "Preflight OK: ${current_release}; shadow script SHA-256 ${staged_hash}."
if [[ "${mode}" == '--check' ]]; then
  exit 0
fi

# The authenticated SIM feed is available only during an active vehicle lease.
# A synthetic, internal car route opens that lease without changing any service.
ssh docker.home.cz 'bash -s' <<'REMOTE' | python3 -c '
import json, sys
reply = json.load(sys.stdin)
routes = reply.get("routes") or []
traffic = reply.get("traffic") or {}
speeds = traffic.get("liveSpeeds") or {}
if reply.get("source", {}).get("backend") != "valhalla" or not routes or routes[0].get("status") != "ok" or not speeds.get("enabled"):
    raise SystemExit("SIM synthetic vehicle route did not establish the required traffic lease")
print("SIM vehicle lease active; traffic state:", speeds.get("state", "unknown"))
'
set -Eeuo pipefail
curl -fsS --max-time 35 \
  -H 'Content-Type: application/json' \
  --data '{"profileId":"car","from":{"lon":14.42076,"lat":50.08804},"to":{"lon":14.4461,"lat":50.0755},"includeTraffic":true,"alternatives":1}' \
  http://127.0.0.1:5020/situation-data/api/v1/routing/route
REMOTE

# Only this root-owned copy is run. The --audit flag writes an isolated audit
# cache artifact; it does not run the live-speed update path.
ssh -t valhalla.home.cz "sudo install -m 0755 '${shadow_source}' '${shadow_target}' && sudo sha256sum '${shadow_target}' && sudo systemd-run --unit=valhalla-openlr-route-audit-v3-20260929 --collect --setenv=TRAFFIC_MAPPING_WORKERS=1 --property=Nice=10 --property=CPUWeight=20 --property=IOWeight=20 --property=MemoryMax=1G --property=RuntimeMaxSec=10800 /usr/bin/python3 '${shadow_target}' --audit-route-fallback"

echo 'Audit dispatched. Inspect: ssh valhalla.home.cz "journalctl -u valhalla-openlr-route-audit-v3-20260929.service -n 30 --no-pager"'
