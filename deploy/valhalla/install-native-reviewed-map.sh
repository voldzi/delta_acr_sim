#!/usr/bin/env bash
# Operator-only install. Does not restart serving Valhalla or its expiry guard.
set -Eeuo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run with sudo after geographic review.' >&2; exit 77; }
[[ "${1:-}" == --geographic-review-confirmed || "${1:-}" == --rollback ]] || exit 64
work=/home/voldzi/valhalla-owned-deploy/native-canary-v2-20261001
active=/srv/valhalla/update-tools/traffic-update.py
env=/srv/valhalla/.traffic.env
stamp=$(date -u +%Y%m%dT%H%M%SZ)
test "$(systemctl show valhalla-weekly-update.service -p ActiveState --value)" = inactive
test "$(docker inspect --format '{{.State.Running}} {{.State.Health.Status}}' valhalla)" = 'true healthy'
test "$(systemctl show valhalla-traffic-expiry.service -p ActiveState --value)" = active
test ! -e /run/valhalla-traffic-canary/active
cp -p "$env" "$env.before-native-$stamp"
cp -p "$active" "$active.before-native-$stamp"
restore() {
  status=$?
  if ((status != 0)); then
    python3 "$work/traffic-update.py" --clear-live-speeds || true
    install -o root -g root -m 0600 "$env.before-native-$stamp" "$env"
    install -o root -g root -m 0755 "$active.before-native-$stamp" "$active"
  fi
  systemctl start valhalla-traffic-update.timer || true
}
trap restore EXIT
systemctl stop valhalla-traffic-update.timer
for attempt in $(seq 1 45); do
  test "$(systemctl show valhalla-traffic-update.service -p ActiveState --value)" != activating && break
  sleep 1
done
test "$(systemctl show valhalla-traffic-update.service -p ActiveState --value)" != activating
selection=''
if [[ "$1" == --geographic-review-confirmed ]]; then
  test "$(readlink -f /srv/valhalla/current)" = /srv/valhalla/releases/20260929T081714Z/custom_files
  selection=$(python3 "$work/prepare-native-live-selection.py" --geographic-review-confirmed)
  install -o root -g root -m 0755 "$work/traffic-update.py" "$active"
else
  python3 "$work/traffic-update.py" --clear-live-speeds
fi
python3 - "$env" "$selection" <<'PY'
import os,sys,tempfile
from pathlib import Path
path=Path(sys.argv[1]); selection=sys.argv[2]
lines=[s for s in path.read_text().splitlines() if not s.startswith('TRAFFIC_NATIVE_REVIEWED_MAP=')]
if selection: lines.append('TRAFFIC_NATIVE_REVIEWED_MAP='+selection)
fd,tmp=tempfile.mkstemp(prefix='.traffic.env.native-',dir=path.parent)
try:
    os.fchmod(fd,0o600)
    with os.fdopen(fd,'w') as stream: stream.write('\n'.join(lines)+'\n')
    os.replace(tmp,path)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
PY
systemctl reset-failed valhalla-traffic-update.service
systemctl start valhalla-traffic-update.service
systemctl start valhalla-traffic-update.timer
docker inspect --format '{{.State.Running}} {{.State.Health.Status}} {{.RestartCount}}' valhalla
sha256sum "$active"
echo 'Selection configuration installed. Fresh-flow application must be checked separately; idle is not positive acceptance.'
