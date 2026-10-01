#!/usr/bin/env bash
set -Eeuo pipefail
mode="${1:---check}"
[[ "$mode" == --check || "$mode" == --install ]] || { echo 'Use --check or --install.' >&2; exit 64; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 "$root/deploy/valhalla/test-traffic-update.py" >/dev/null
python3 "$root/deploy/valhalla/test-traffic-expiry.py"
release="$(ssh -o BatchMode=yes -o ConnectTimeout=10 valhalla.home.cz 'readlink -f /srv/valhalla/current')"
[[ "$release" =~ ^/srv/valhalla/releases/[A-Za-z0-9_-]+/custom_files$ ]] || exit 1
ssh -o BatchMode=yes -o ConnectTimeout=10 valhalla.home.cz '
  test "$(docker inspect --format "{{.State.Running}} {{.State.Health.Status}}" valhalla)" = "true healthy" &&
  test "$(systemctl show valhalla-weekly-update.service -p ActiveState --value)" = inactive &&
  test ! -e /run/valhalla-traffic-canary/active
'
echo "Preflight OK: $release; ordinary Valhalla healthy."
[[ "$mode" == --install ]] || exit 0
remote="/home/voldzi/valhalla-owned-deploy/reliability-$(date -u +%Y%m%dT%H%M%SZ)"
ssh valhalla.home.cz "mkdir -m 0700 '$remote'"
scp "$root/deploy/valhalla/traffic-update.py" \
  "$root/deploy/valhalla/weekly-update.sh" \
  "$root/deploy/valhalla/valhalla-traffic-expiry.service" \
  "$root/deploy/valhalla/valhalla-traffic-update.timer" \
  "$root/deploy/valhalla/rollback-traffic-reliability.sh" \
  "$root/deploy/valhalla/install-traffic-reliability.sh" "valhalla.home.cz:$remote/"
hash="$(shasum -a 256 "$root/deploy/valhalla/traffic-update.py" | awk '{print $1}')"
# Authentication happens on the server; no secrets are uploaded or printed.
ssh -t valhalla.home.cz "sudo bash '$remote/install-traffic-reliability.sh' '$release' '$hash'"
