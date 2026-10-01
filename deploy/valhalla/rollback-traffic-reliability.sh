#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$(id -u)" == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
backup="${1:?root-owned reliability backup path required}"
[[ "$backup" =~ ^/srv/valhalla/update-tools/reliability-backup-[A-Za-z0-9-]+$ ]] || exit 64
[[ "$(stat -c '%U:%a' "$backup")" == root:700 ]] || exit 1
for file in traffic-update.py weekly-update.sh valhalla-traffic-update.timer service-states.txt; do
  [[ -f "$backup/$file" && ! -L "$backup/$file" ]] || exit 1
done
mapfile -t states < "$backup/service-states.txt"
[[ "${#states[@]}" == 3 ]] || exit 1
for value in "${states[@]}"; do [[ "$value" =~ ^[a-z-]*$ ]] || exit 1; done
completed=false
resume_new_guard_on_failure() {
  if [[ "$completed" != true ]]; then
    systemctl start valhalla-traffic-expiry.service || true
    [[ "${states[0]}" != active ]] || systemctl start valhalla-traffic-update.timer
    echo 'Rollback not completed; expiry protection retained. Inspect the failure before retry.' >&2
  fi
}
trap resume_new_guard_on_failure EXIT
systemctl stop valhalla-traffic-update.timer valhalla-traffic-update.service valhalla-traffic-expiry.service
# Clear and acknowledge the new generation before restoring older maintenance
# code. No provider token or normalized partner content is printed.
python3 - <<'PY'
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location('traffic_update', '/srv/valhalla/update-tools/traffic-update.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
config = module.load_env(Path('/srv/valhalla/.traffic.env'))
runtime = Path(config.get('TRAFFIC_RUNTIME_DIR', '/run/valhalla-traffic'))
module.clear_expired_runtime(runtime, int(config.get('TRAFFIC_MAX_AGE_SECONDS', '1800')), force=True)
module.deliver_pending_report(config, runtime, timeout=5)
PY
install -m 0755 "$backup/traffic-update.py" /srv/valhalla/update-tools/traffic-update.py
install -m 0755 "$backup/weekly-update.sh" /srv/valhalla/update-tools/weekly-update.sh
install -m 0644 "$backup/valhalla-traffic-update.timer" /etc/systemd/system/valhalla-traffic-update.timer
if [[ -f "$backup/valhalla-traffic-expiry.service" ]]; then
  install -m 0644 "$backup/valhalla-traffic-expiry.service" /etc/systemd/system/valhalla-traffic-expiry.service
else
  systemctl disable valhalla-traffic-expiry.service
  rm -f /etc/systemd/system/valhalla-traffic-expiry.service
fi
systemctl daemon-reload
[[ "${states[2]}" != enabled ]] || systemctl enable valhalla-traffic-expiry.service
[[ "${states[1]}" != active ]] || systemctl start valhalla-traffic-expiry.service
[[ "${states[0]}" != active ]] || systemctl start valhalla-traffic-update.timer
completed=true
echo 'Maintenance files restored; active graph and Valhalla container unchanged. Keep SIM deadline protection enabled.'
