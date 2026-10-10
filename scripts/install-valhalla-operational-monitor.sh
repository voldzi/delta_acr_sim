#!/usr/bin/env bash
# Install only monitoring from an isolated reviewed source directory on Docker.
set -euo pipefail
ROOT_DIR="${SIM_OPERATIONAL_ROOT:-/srv/sim}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
target=/srv/x5-production/data/csm-sim/sim-data/operational-checks
test "$(findmnt -n -o UUID --mountpoint /srv/x5-production)" = '2f93f595-b61b-4eea-9054-7afa9b275b5b'
test -d "$target" && test -w "$target" || { echo 'Administrator must create the writable operational-checks directory on the verified X5 disk.' >&2; exit 1; }
test -f "$HOME/.config/csm-sim/valhalla-monitor/id_ed25519"
python3 "$SCRIPT_DIR/test-valhalla-operational-monitor.py"
python3 "$SCRIPT_DIR/test-production-operational-check.py"
mkdir -p "$ROOT_DIR/data/operational-checks"
config="$ROOT_DIR/data/operational-checks/monitor.env"
if [ -f "$config" ]; then cp -p "$config" "$config.before-$(date -u +%Y%m%dT%H%M%SZ)"; fi
tmp="$(mktemp "$ROOT_DIR/data/operational-checks/monitor.env.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
printf '%s\n' \
  'SIM_OPERATIONAL_VALHALLA_MONITOR_ENABLED=true' \
  'SIM_OPERATIONAL_VALHALLA_MONITOR_KEY=~/.config/csm-sim/valhalla-monitor/id_ed25519' \
  "SIM_OPERATIONAL_REPORT_FILE=$target/latest.json" \
  "SIM_OPERATIONAL_STATE_FILE=$ROOT_DIR/data/operational-checks/state.json" \
  'SIM_OPERATIONAL_ALERT_REMINDER_SECONDS=86400' > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$config"
SIM_OPERATIONAL_ROOT="$ROOT_DIR" bash "$SCRIPT_DIR/install-production-operational-check-cron.sh"
echo 'Monitoring configured; API, routing, traffic updater and Jizda were not restarted or changed.'
