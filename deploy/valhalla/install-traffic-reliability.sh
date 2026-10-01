#!/usr/bin/env bash
# Narrow patch installer: no container recreation, token transfer or graph switch.
set -Eeuo pipefail
[[ "$(id -u)" == 0 ]] || { echo 'Run this installer with sudo.' >&2; exit 1; }
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
expected_release="${1:?expected release path required}"
expected_hash="${2:?expected updater SHA-256 required}"
[[ "$expected_release" =~ ^/srv/valhalla/releases/[A-Za-z0-9_-]+/custom_files$ ]] || exit 64
[[ "$expected_hash" =~ ^[0-9a-f]{64}$ ]] || exit 64
[[ "$(readlink -f /srv/valhalla/current)" == "$expected_release" ]] || { echo 'Graph changed; refusing patch.' >&2; exit 1; }
[[ "$(sha256sum "$source_dir/traffic-update.py" | awk '{print $1}')" == "$expected_hash" ]] || exit 1
[[ "$(docker inspect --format '{{.State.Running}}' valhalla)" == true ]] || exit 1
[[ ! -e /run/valhalla-traffic-canary/active ]] || exit 1
[[ "$(systemctl show valhalla-weekly-update.service -p ActiveState --value)" == inactive ]] || exit 1
python3 -m py_compile "$source_dir/traffic-update.py"
bash -n "$source_dir/weekly-update.sh"
systemd-analyze verify "$source_dir/valhalla-traffic-expiry.service" "$source_dir/valhalla-traffic-update.timer"
backup="/srv/valhalla/update-tools/reliability-backup-$(date -u +%Y%m%dT%H%M%SZ)-$$"
install -d -m 0700 "$backup"
timer_was_active="$(systemctl is-active valhalla-traffic-update.timer || true)"
guard_was_active="$(systemctl is-active valhalla-traffic-expiry.service || true)"
guard_was_enabled="$(systemctl is-enabled valhalla-traffic-expiry.service 2>/dev/null || true)"
printf '%s\n' "$timer_was_active" "$guard_was_active" "$guard_was_enabled" > "$backup/service-states.txt"
chmod 0600 "$backup/service-states.txt"
cp -p /srv/valhalla/update-tools/traffic-update.py "$backup/traffic-update.py"
cp -p /srv/valhalla/update-tools/weekly-update.sh "$backup/weekly-update.sh"
cp -p /etc/systemd/system/valhalla-traffic-update.timer "$backup/valhalla-traffic-update.timer"
if [[ -f /etc/systemd/system/valhalla-traffic-expiry.service ]]; then
  cp -p /etc/systemd/system/valhalla-traffic-expiry.service "$backup/valhalla-traffic-expiry.service"
fi
changed=false
completed=false
finish() {
  if [[ "$completed" != true && "$changed" == true ]]; then
    systemctl stop valhalla-traffic-update.timer valhalla-traffic-expiry.service || true
    install -m 0755 "$backup/traffic-update.py" /srv/valhalla/update-tools/traffic-update.py
    install -m 0755 "$backup/weekly-update.sh" /srv/valhalla/update-tools/weekly-update.sh
    install -m 0644 "$backup/valhalla-traffic-update.timer" /etc/systemd/system/valhalla-traffic-update.timer
    if [[ -f "$backup/valhalla-traffic-expiry.service" ]]; then
      install -m 0644 "$backup/valhalla-traffic-expiry.service" /etc/systemd/system/valhalla-traffic-expiry.service
    else
      systemctl disable valhalla-traffic-expiry.service || true
      rm -f /etc/systemd/system/valhalla-traffic-expiry.service
    fi
    systemctl daemon-reload
    [[ "$guard_was_enabled" != enabled ]] || systemctl enable valhalla-traffic-expiry.service
    [[ "$guard_was_active" != active ]] || systemctl start valhalla-traffic-expiry.service
    echo "Patch failed; maintenance files restored from $backup." >&2
  fi
  [[ "$timer_was_active" != active ]] || systemctl start valhalla-traffic-update.timer
}
trap finish EXIT
systemctl stop valhalla-traffic-update.timer
# Never terminate an ongoing graph mapping just to install this patch.
for _ in $(seq 1 45); do
  state="$(systemctl show valhalla-traffic-update.service -p ActiveState --value)"
  [[ "$state" != activating && "$state" != active ]] && break
  sleep 1
done
[[ "$state" != activating && "$state" != active ]] || { echo 'Updater still running; original retained.' >&2; exit 1; }
systemctl stop valhalla-traffic-expiry.service 2>/dev/null || true
changed=true
install -m 0755 "$source_dir/traffic-update.py" /srv/valhalla/update-tools/traffic-update.py
install -m 0755 "$source_dir/weekly-update.sh" /srv/valhalla/update-tools/weekly-update.sh
install -m 0755 "$source_dir/rollback-traffic-reliability.sh" /srv/valhalla/update-tools/rollback-traffic-reliability.sh
install -m 0644 "$source_dir/valhalla-traffic-expiry.service" /etc/systemd/system/valhalla-traffic-expiry.service
install -m 0644 "$source_dir/valhalla-traffic-update.timer" /etc/systemd/system/valhalla-traffic-update.timer
systemctl daemon-reload
systemctl enable --now valhalla-traffic-expiry.service
systemctl reset-failed valhalla-traffic-update.service || true
systemctl start valhalla-traffic-update.service
systemctl is-active --quiet valhalla-traffic-expiry.service
[[ "$(docker inspect --format '{{.State.Running}} {{.State.Health.Status}}' valhalla)" == 'true healthy' ]] || exit 1
sha256sum /srv/valhalla/update-tools/traffic-update.py
echo "Reliability patch installed without restarting Valhalla. Backup: $backup"
completed=true
