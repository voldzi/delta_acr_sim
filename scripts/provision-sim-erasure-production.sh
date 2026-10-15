#!/usr/bin/env bash
# Called by the coordinated, reviewed Root maintenance procedure only.
set -euo pipefail
set +x
umask 077
[[ ${EUID} == 0 ]] || { printf 'Run this production installer as Root.\n' >&2; exit 2; }
command -v node >/dev/null
if [[ ${1:-} == --inventory-reports && $# == 1 ]]; then
  exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/driver-report-inventory.mjs"
fi
command -v psql >/dev/null
if [[ -z ${PGPASSWORD:-} ]]; then
  printf 'PostgreSQL administrator password (not echoed): ' >/dev/tty
  IFS= read -r -s PGPASSWORD </dev/tty
  printf '\n' >/dev/tty
  export PGPASSWORD
fi
export PGUSER=${PGUSER:-postgres}
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/provision-sim-erasure-production.mjs" "$@"
