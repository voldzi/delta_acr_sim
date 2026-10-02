#!/bin/sh
# No secrets in arguments, stdout or logs. Runs even when the SDA API is stopped.
set -eu
cd /srv/sim
docker compose run --rm --no-deps -T --entrypoint node -v /srv/sim/scripts/driver-measurements-maintenance.mjs:/maintenance.mjs:ro situation-data-api /maintenance.mjs
