#!/usr/bin/env bash
# The single reviewed, disabled-only SIM maintenance entrypoint.
set -euo pipefail
set +x
umask 077
[[ ${EUID} == 0 ]] || { printf 'Root is required.\n' >&2; exit 2; }
[[ $# -le 1 ]] || exit 2
case ${1:---apply} in --apply|--verify|--rollback-disabled) ;; *) exit 2 ;; esac
source_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$source_root"
printf '%s  %s\n' 897f9d6327992a2112eb85b4ee3cd14451b6bde91a04deee80e778fe325ff201 deploy/account-safety/disabled-install.sha256 | /usr/bin/sha256sum --check --status
/usr/bin/sha256sum --check --status deploy/account-safety/disabled-install.sha256
# Serialize the fixed maintenance, without storing any credential in /run.
lockdir=/run/sim-erasure-maintenance
if [[ ! -e $lockdir ]]; then /usr/bin/install -d -m 0700 -o root -g root "$lockdir"; fi
[[ ! -L $lockdir && $(stat -c '%u:%a' "$lockdir") == 0:700 ]] || exit 2
exec 9>"$lockdir/install.lock"
/usr/bin/flock -n 9 || { printf 'SIM maintenance is already running.\n' >&2; exit 2; }
if [[ ${1:---apply} == --apply && -z ${PGPASSWORD:-} ]]; then
  printf 'PostgreSQL administrator password (not echoed): ' >/dev/tty
  IFS= read -r -s PGPASSWORD </dev/tty
  printf '\n' >/dev/tty
  export PGPASSWORD
fi
export PGUSER=${PGUSER:-postgres}
unset NODE_OPTIONS NODE_PATH
exec /usr/bin/node "$source_root/scripts/install-sim-erasure-disabled.mjs" "${1:---apply}"
