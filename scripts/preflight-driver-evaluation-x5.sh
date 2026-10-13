#!/usr/bin/env bash
# Run on docker.home.cz before EACH approved mutation. Read-only; no sudo.
set -euo pipefail
mount=/srv/x5-production
expected_uuid=2f93f595-b61b-4eea-9054-7afa9b275b5b
directory=/srv/x5-production/cache/csm-sim/driver-measurement-reports
fail() { printf '%s\n' 'Driver evaluation X5 preflight failed; no change made.' >&2; exit 1; }
[[ "${SIM_DRIVER_EVALUATION_HOST_DIR:-$directory}" == "$directory" ]] || fail
[[ "$(findmnt -n -o TARGET --mountpoint "$mount")" == "$mount" ]] || fail
[[ "$(findmnt -n -o UUID --mountpoint "$mount")" == "$expected_uuid" ]] || fail
[[ "$(stat -c %d "$mount")" != "$(stat -c %d /)" ]] || fail
options=$(findmnt -n -o OPTIONS --mountpoint "$mount")
[[ ",$options," == *,rw,* ]] || fail
available=$(df -Pk -- "$mount" | awk 'NR==2 {print $4}')
[[ "$available" =~ ^[0-9]+$ ]] && ((available >= 102400)) || fail
[[ -d "$directory" && ! -L "$directory" ]] || fail
[[ "$(realpath -e -- "$directory")" == "$directory" ]] || fail
mode=$(stat -c %a "$directory")
[[ "$mode" == 700 || "$mode" == 750 ]] || fail
printf '%s\n' 'Driver evaluation X5 preflight OK: separate expected device, private cache, >=100 MiB free.'
