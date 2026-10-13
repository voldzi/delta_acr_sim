#!/usr/bin/env bash
# Entirely local, disposable PostgreSQL proof; never uses a production DSN.
set -euo pipefail
cd "$(dirname "$0")/.."
for binary in initdb pg_ctl createdb pnpm; do
  command -v "$binary" >/dev/null || { printf '%s\n' "Missing local test dependency: $binary" >&2; exit 1; }
done
port=${SIM_DRIVER_TEST_PORT:-55439}
[[ "$port" =~ ^[0-9]+$ ]] && ((port >= 1024 && port <= 65535)) || exit 1
directory=$(mktemp -d "${TMPDIR:-/tmp}/sim-driver-pg-test.XXXXXX")
cleanup() {
  pg_ctl -D "$directory/database" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf -- "$directory"
}
trap cleanup EXIT
initdb -D "$directory/database" -U postgres --auth-local=trust --auth-host=trust >"$directory/init.log" 2>&1
# Trust applies only to this synthetic, loopback-bound temporary server.
pg_ctl -D "$directory/database" -l "$directory/server.log" -o "-h 127.0.0.1 -p $port -k $directory" -w start >/dev/null
createdb -h 127.0.0.1 -p "$port" -U postgres sim_driver_measurements_test
DRIVER_MEASUREMENTS_TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:$port/sim_driver_measurements_test" \
  pnpm --filter @csm-sim/situation-data-api exec vitest run test/driver-measurement-store.test.ts
