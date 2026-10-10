#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${SIM_OPERATIONAL_ROOT:-/srv/sim}"
SCHEDULE="${SIM_OPERATIONAL_CRON_SCHEDULE:-*/5 * * * *}"
if [ -n "${SIM_OPERATIONAL_LOG_DIR:-}" ]; then
  LOG_DIR="$SIM_OPERATIONAL_LOG_DIR"
elif [ "$ROOT_DIR" = "/srv/sim" ]; then
  LOG_DIR="/srv/x5-production/cache/csm-sim/operational-checks"
else
  LOG_DIR="${ROOT_DIR}/data/operational-checks"
fi
PYTHON_BIN="${SIM_OPERATIONAL_PYTHON_BIN:-python3}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MARKER_BEGIN="# CSM SIM operational checks BEGIN"
MARKER_END="# CSM SIM operational checks END"

if [ "${1:-}" = "--uninstall" ]; then
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  (crontab -l 2>/dev/null || true) | awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" '
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

if [[ "$LOG_DIR" == /srv/x5-production/* ]]; then
  expected_uuid="2f93f595-b61b-4eea-9054-7afa9b275b5b"
  actual_uuid="$(findmnt -n -o UUID --mountpoint /srv/x5-production 2>/dev/null || true)"
  if [ "$actual_uuid" != "$expected_uuid" ]; then
    echo "Refusing to install operational checks: /srv/x5-production is not mounted with expected UUID $expected_uuid." >&2
    exit 1
  fi
fi

mkdir -p "$LOG_DIR"

printf -v runner '%q' "$SCRIPT_DIR/run-production-operational-check.sh"
printf -v root '%q' "$ROOT_DIR"
printf -v log '%q' "$LOG_DIR"
printf -v python '%q' "$PYTHON_BIN"
entry="$SCHEDULE SIM_OPERATIONAL_ROOT=$root SIM_OPERATIONAL_LOG_DIR=$log SIM_OPERATIONAL_PYTHON_BIN=$python bash $runner"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

{
  (crontab -l 2>/dev/null || true) | awk -v begin="$MARKER_BEGIN" -v end="$MARKER_END" '
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
echo "  report: configured by host monitor settings (production: X5 SIM data bind)"
echo "  state: $ROOT_DIR/data/operational-checks/state.json"
echo "  log: $LOG_DIR/cron.log"
