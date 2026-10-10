#!/usr/bin/env bash
# One-module main API overlay. Run only on docker.home.cz, without sudo.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPTS="$DIR/scripts"
ARTIFACTS="$DIR/report-guard"
EXPECTED_IMAGE=sha256:e2b61d0d0aace9168ab0b0410dc129e8e78963fe48cf6f17b03b469de1607a7f
EXPECTED_SOURCE=eef5f673ddadb7e5bd0cc96bbcaa6c637fd64ba2111f5ff3252840e312615f38
EXPECTED_MODULE=e70b93ffaf661ddc3cce0844e7dfbeece7cece2d8844c956fd9b833ca2e15895
BASE=sim-api-monitor-base:20261010
CANDIDATE=sim-api-monitor-guard:20261010
MANIFEST="$DIR/report-guard-rollback.json"
test "$(findmnt -n -o UUID --mountpoint /srv/x5-production)" = '2f93f595-b61b-4eea-9054-7afa9b275b5b'
test "$(docker inspect -f '{{.Image}}' csm-sim-api)" = "$EXPECTED_IMAGE"
test "$(docker exec csm-sim-api sha256sum /app/apps/simulator-api/src/operations-summary.ts | awk '{print $1}')" = "$EXPECTED_SOURCE"
test "$(docker exec csm-sim-api sha256sum /app/apps/simulator-api/dist/operations-summary.js | awk '{print $1}')" = "$EXPECTED_MODULE"
test "$(docker inspect -f '{{.Config.Image}}' csm-sim-api)" = 'sim-sim-api'
test -s "$ARTIFACTS/operations-summary.ts" && test -s "$ARTIFACTS/operations-summary.js"
test -s "$ARTIFACTS/source-revision.txt"
python3 "$SCRIPTS/verify-operational-report-deployment.py" snapshot "$MANIFEST"
docker tag "$EXPECTED_IMAGE" "$BASE"
docker build --pull=false --network=none \
  --build-arg "BASE_IMAGE=$BASE" \
  --build-arg "SOURCE_REVISION=$(< "$ARTIFACTS/source-revision.txt")" \
  -f "$SCRIPTS/operational-report-guard.Dockerfile" -t "$CANDIDATE" "$ARTIFACTS"
docker run --rm --network=none --read-only --tmpfs /tmp \
  -v "$SCRIPTS/test-operational-report-runtime.mjs:/guard-test.mjs:ro" \
  --entrypoint node "$CANDIDATE" /guard-test.mjs

activated=false
rollback() {
  local result=$?
  if [ "$activated" = true ] && [ "$result" -ne 0 ]; then
    local live
    live="$(docker inspect -f '{{.Image}}' csm-sim-api 2>/dev/null || true)"
    if [ "$live" = "$candidate_id" ] || [ "$live" = "$EXPECTED_IMAGE" ]; then
      docker tag "$EXPECTED_IMAGE" sim-sim-api
      if (cd /srv/sim && docker compose up -d --no-deps --no-build sim-api); then
        for attempt in {1..30}; do
          if [ "$(docker inspect -f '{{.State.Health.Status}}' csm-sim-api 2>/dev/null || true)" = healthy ]; then break; fi
          sleep 2
        done
        if [ "$(docker inspect -f '{{.Image}}' csm-sim-api)" = "$EXPECTED_IMAGE" ] &&
           [ "$(docker inspect -f '{{.State.Health.Status}}' csm-sim-api)" = healthy ]; then
          echo 'Main API restored to recorded original image and healthy after failed acceptance.' >&2
        else
          echo 'Rollback attempted, but original image/health acceptance failed; operator action required.' >&2
        fi
      else
        echo 'Rollback failed to recreate the main API; operator action required.' >&2
      fi
    else
      echo 'Unexpected concurrent main API change; refusing to overwrite it during rollback.' >&2
    fi
  fi
  exit "$result"
}
trap rollback EXIT
candidate_id="$(docker image inspect -f '{{.Id}}' "$CANDIDATE")"
# Re-check immediately before changing the one service; protect concurrent deploys.
test "$(docker inspect -f '{{.Image}}' csm-sim-api)" = "$EXPECTED_IMAGE"
python3 "$SCRIPTS/verify-operational-report-deployment.py" snapshot "$MANIFEST"
docker tag "$candidate_id" sim-sim-api
activated=true
(cd /srv/sim && docker compose up -d --no-deps --no-build sim-api)
for attempt in {1..30}; do
  test "$(docker inspect -f '{{.Image}}' csm-sim-api)" = "$candidate_id"
  if [ "$(docker inspect -f '{{.State.Health.Status}}' csm-sim-api)" = healthy ]; then break; fi
  sleep 2
done
test "$(docker inspect -f '{{.State.Health.Status}}' csm-sim-api)" = healthy
python3 "$SCRIPTS/verify-operational-report-deployment.py" accept "$MANIFEST"
echo "Main API report freshness guard deployed: $candidate_id"
