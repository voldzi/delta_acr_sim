#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${SIM_OPERATIONAL_ROOT:-/srv/sim}"
SCHEDULE="${SIM_OPERATIONAL_CRON_SCHEDULE:-*/5 * * * *}"
LOG_DIR="${SIM_OPERATIONAL_LOG_DIR:-${ROOT_DIR}/data/operational-checks}"
PYTHON_BIN="${SIM_OPERATIONAL_PYTHON_BIN:-python3}"
MARKER_BEGIN="# CSM SIM operational checks BEGIN"
MARKER_END="# CSM SIM operational checks END"

if [ "${1:-}" = "--uninstall" ]; then
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  crontab -l 2>/dev/null | awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" '
    $0 == begin {skip=1; next}
    $0 == end {skip=0; next}
    skip != 1 {print}
  ' > "$tmp"
  crontab "$tmp"
  echo "Removed CSM SIM operational checks from crontab."
  exit 0
fi

if [ ! -d "$ROOT_DIR" ]; then
  echo "SIM root does not exist: $ROOT_DIR" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

entry="$SCHEDULE cd $ROOT_DIR && $PYTHON_BIN scripts/production-operational-check.py --env-file .env --quiet >> $LOG_DIR/cron.log 2>&1"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

{
  crontab -l 2>/dev/null | awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" '
    $0 == begin {skip=1; next}
    $0 == end {skip=0; next}
    skip != 1 {print}
  '
  echo "$MARKER_BEGIN"
  echo "$entry"
  echo "$MARKER_END"
} > "$tmp"

crontab "$tmp"

echo "Installed CSM SIM operational checks:"
echo "  schedule: $SCHEDULE"
echo "  root: $ROOT_DIR"
echo "  report: $ROOT_DIR/data/operational-checks/latest.json"
echo "  state: $ROOT_DIR/data/operational-checks/state.json"
echo "  log: $LOG_DIR/cron.log"
