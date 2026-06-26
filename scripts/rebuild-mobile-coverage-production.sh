#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SIM_BASE_URL="${SIM_BASE_URL:-http://localhost:5020}"
MOBILE_COVERAGE_REBUILD_BBOX="${MOBILE_COVERAGE_REBUILD_BBOX:-11.8,48.5,19.2,51.2}"
MOBILE_COVERAGE_REBUILD_TECHNOLOGIES="${MOBILE_COVERAGE_REBUILD_TECHNOLOGIES:-4G}"
MOBILE_COVERAGE_REBUILD_TILE_DEGREES="${MOBILE_COVERAGE_REBUILD_TILE_DEGREES:-0.25}"
RESTART_SITUATION_DATA_API="${RESTART_SITUATION_DATA_API:-true}"
RUN_SMOKE="${RUN_SMOKE:-true}"

wait_for_situation_data() {
  local attempts="${1:-60}"
  local delay_seconds="${2:-1}"

  for attempt in $(seq 1 "$attempts"); do
    if curl -fsS "${SIM_BASE_URL}/situation-data/health/ready" >/dev/null 2>&1; then
      return 0
    fi
    echo "Waiting for situation-data readiness (${attempt}/${attempts})..."
    sleep "$delay_seconds"
  done

  curl -fsS "${SIM_BASE_URL}/situation-data/health/ready" >/dev/null
}

echo "Rebuilding mobile coverage read-model"
echo "  bbox=${MOBILE_COVERAGE_REBUILD_BBOX}"
echo "  technologies=${MOBILE_COVERAGE_REBUILD_TECHNOLOGIES}"
echo "  tileDegrees=${MOBILE_COVERAGE_REBUILD_TILE_DEGREES}"

wait_for_situation_data 30 1

docker compose run --rm \
  -e MOBILE_COVERAGE_REBUILD_BBOX="${MOBILE_COVERAGE_REBUILD_BBOX}" \
  -e MOBILE_COVERAGE_REBUILD_TECHNOLOGIES="${MOBILE_COVERAGE_REBUILD_TECHNOLOGIES}" \
  -e MOBILE_COVERAGE_REBUILD_TILE_DEGREES="${MOBILE_COVERAGE_REBUILD_TILE_DEGREES}" \
  situation-data-api pnpm --filter @csm-sim/situation-data-api rebuild:mobile-coverage

if [ "$RESTART_SITUATION_DATA_API" = "true" ]; then
  docker compose up -d --force-recreate situation-data-api
  wait_for_situation_data 60 1
fi

if [ "$RUN_SMOKE" = "true" ]; then
  python3 scripts/smoke-production-data-plane.py \
    --base-url "$SIM_BASE_URL" \
    --bbox "$MOBILE_COVERAGE_REBUILD_BBOX" \
    --require-mobile-coverage-read-model \
    --quiet
fi

echo "Mobile coverage read-model rebuild completed."
