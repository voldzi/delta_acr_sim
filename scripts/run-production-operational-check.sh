#!/usr/bin/env bash
# Host cron entrypoint: guard the disk BEFORE redirecting output; serialize checks.
set -euo pipefail
ROOT_DIR="${SIM_OPERATIONAL_ROOT:-/srv/sim}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="${SIM_OPERATIONAL_LOG_DIR:-/srv/x5-production/cache/csm-sim/operational-checks}"
CONFIG="${SIM_OPERATIONAL_MONITOR_ENV_FILE:-$ROOT_DIR/data/operational-checks/monitor.env}"
if [[ "$LOG_DIR" == /srv/x5-production/* ]]; then
  if [ "$(findmnt -n -o UUID --mountpoint /srv/x5-production 2>/dev/null || true)" != "2f93f595-b61b-4eea-9054-7afa9b275b5b" ]; then
    logger -t csm-sim-operational-check 'X5_MOUNT_UNAVAILABLE: operational monitor cannot publish its report'
    exit 3
  fi
fi
mkdir -p "$LOG_DIR" "$ROOT_DIR/data/operational-checks"
config_args=()
if [ -f "$CONFIG" ]; then config_args=(--monitor-env-file "$CONFIG"); fi
export SIM_OPERATIONAL_ROOT="$ROOT_DIR"
cd "$ROOT_DIR"
exec flock -n "$ROOT_DIR/data/operational-checks/monitor.lock" \
  timeout 240 "${SIM_OPERATIONAL_PYTHON_BIN:-python3}" "$SCRIPT_DIR/production-operational-check.py" \
  --env-file "$ROOT_DIR/.env" "${config_args[@]}" --quiet >> "$LOG_DIR/cron.log" 2>&1
