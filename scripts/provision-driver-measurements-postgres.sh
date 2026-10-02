#!/usr/bin/env bash
# Operator-only provisioning. No application activation and no secret output.
set -euo pipefail
set +x
umask 077
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
schema="$script_dir/../deploy/driver-measurements/schema.sql"
host=haproxy.home.cz
port=5000
database=sim_driver_measurements
owner=driver_measurements_migrator
runtime=driver_measurements_runtime
credentials=${DRIVER_MEASUREMENTS_CREDENTIALS_FILE:-"$HOME/.config/csm-sim/driver-measurements-db-credentials.env"}
if [[ $# != 1 || ( $1 != --check && $1 != --apply && $1 != --recover ) ]]; then
  printf 'Usage: PGUSER=postgres bash %s --check|--apply|--recover\n' "$0" >&2
  exit 2
fi
mode=$1
for tool in psql openssl; do command -v "$tool" >/dev/null || { printf 'Missing %s\n' "$tool" >&2; exit 2; }; done
[[ -f $schema && -n ${PGUSER:-} ]] || { printf 'Schema and PGUSER are required.\n' >&2; exit 2; }
[[ ${PGHOST:-$host} == "$host" && ${PGPORT:-$port} == "$port" ]] || { printf 'Only the fixed HAProxy endpoint is allowed.\n' >&2; exit 2; }
if [[ $mode != --check && -e $credentials ]]; then
  printf 'Credentials already exist; refusing password rotation or overwrite: %s\n' "$credentials" >&2
  exit 2
fi
if [[ -z ${PGPASSWORD:-} ]]; then
  printf 'PostgreSQL administrator password (not echoed): ' >/dev/tty
  IFS= read -r -s PGPASSWORD </dev/tty
  printf '\n' >/dev/tty
  export PGPASSWORD
fi
admin() { psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$PGUSER" -d postgres "$@"; }
[[ $(admin -Atc 'SELECT rolsuper FROM pg_roles WHERE rolname=current_user') == t ]] || { printf 'Administrator required; no changes made.\n' >&2; exit 1; }
count=$(admin -Atc "SELECT (SELECT count(*) FROM pg_roles WHERE rolname IN ('$owner','$runtime'))+(SELECT count(*) FROM pg_database WHERE datname='$database')")
if [[ $mode == --check ]]; then
  printf 'HAProxy administrator connection verified; isolated measurement objects: %s/3.\n' "$count"
  exit 0
fi
if [[ $mode == --apply ]]; then
  [[ $count == 0 ]] || { printf 'Objects already exist; no changes made.\n' >&2; exit 1; }
else
  state=$(admin -Atc "SELECT (SELECT count(*) FROM pg_roles WHERE rolname IN ('$owner','$runtime') AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)=2 AND (SELECT count(*) FROM pg_database WHERE datname='$database' AND pg_get_userbyid(datdba)='$owner')=1 AND NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN ('$owner','$runtime'))")
  [[ $count == 3 && $state == t ]] || { printf 'Unexpected partial state; refusing recovery.\n' >&2; exit 1; }
fi
printf 'Type %s to confirm %s: ' "$database" "$mode" >/dev/tty
IFS= read -r confirmation </dev/tty
[[ $confirmation == "$database" ]] || { printf 'Cancelled.\n'; exit 1; }
owner_password=$(openssl rand -hex 32)
runtime_password=$(openssl rand -hex 32)
# Verify writable private destination before modifying the cluster.
mkdir -p "$(dirname "$credentials")"
chmod 700 "$(dirname "$credentials")"
temporary=$(mktemp "${credentials}.tmp.XXXXXX")
trap 'rm -f "$temporary"' EXIT
printf 'DRIVER_MEASUREMENTS_MIGRATION_DATABASE_URL=postgresql://%s:%s@%s:%s/%s\n' "$owner" "$owner_password" "$host" "$port" "$database" >"$temporary"
printf 'DRIVER_MEASUREMENTS_DATABASE_URL=postgresql://%s:%s@%s:%s/%s\n' "$runtime" "$runtime_password" "$host" "$port" "$database" >>"$temporary"
chmod 600 "$temporary"
mv "$temporary" "$credentials"
if [[ $mode == --apply ]]; then
  admin <<SQL
CREATE ROLE $owner LOGIN PASSWORD '$owner_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE $runtime LOGIN PASSWORD '$runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE $database OWNER $owner;
SQL
else
  admin <<SQL
ALTER ROLE $owner PASSWORD '$owner_password';
ALTER ROLE $runtime PASSWORD '$runtime_password';
SQL
fi
admin <<SQL
REVOKE ALL ON DATABASE $database FROM PUBLIC;
GRANT CONNECT ON DATABASE $database TO $runtime;
SQL
PGPASSWORD=$owner_password psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$database" -f "$schema"
PGPASSWORD=$owner_password psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$owner" -d "$database" <<SQL
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO $runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON driver_measurement_receipts,driver_measurement_intervals,driver_measurement_eta,driver_measurement_revocations TO $runtime;
SQL
verified=$(PGPASSWORD=$runtime_password psql -X -q -At -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$runtime" -d "$database" -c "SELECT count(*)=4 AND bool_and(has_table_privilege(current_user,quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT,INSERT,UPDATE,DELETE')) AND NOT has_schema_privilege(current_user,'public','CREATE') AND NOT has_database_privilege(current_user,current_database(),'CREATE') FROM pg_tables WHERE schemaname='public' AND tablename IN ('driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta','driver_measurement_revocations')")
[[ $verified == t ]] || { printf 'Runtime verification failed; private credentials retained.\n' >&2; exit 1; }
printf 'Dedicated database and restricted runtime verified. Credentials saved mode 600: %s\n' "$credentials"
printf 'Only DRIVER_MEASUREMENTS_DATABASE_URL belongs in SIM server configuration. Keep migration credentials with the administrator. Intake remains disabled.\n'
