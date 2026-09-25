#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

# Run from any directory. This script never prints passwords or connection URLs.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
migration_sql="$script_dir/../deploy/ai-router/001_schema.sql"
host=haproxy.home.cz
port=5000
database=sim_ai_router
migrator=ai_router_migrator
runtime=ai_router_runtime
output_file=${AI_ROUTER_DB_CREDENTIALS_FILE:-"$HOME/.config/csm-sim/ai-router-db-credentials.env"}

usage() {
  printf 'Usage: PGUSER=<postgres-admin> %s --check|--apply|--recover\n' "$0"
  printf 'Target: %s:%s/%s (fixed HAProxy endpoint)\n' "$host" "$port" "$database"
}

if [[ $# -ne 1 || ( $1 != --check && $1 != --apply && $1 != --recover ) ]]; then
  usage >&2
  exit 2
fi
mode=$1
for required in psql openssl; do
  command -v "$required" >/dev/null || { printf 'Missing required command: %s\n' "$required" >&2; exit 2; }
done
[[ -f $migration_sql ]] || { printf 'Migration SQL is missing.\n' >&2; exit 2; }
[[ -n ${PGUSER:-} ]] || { printf 'Set PGUSER to an authorized PostgreSQL administrator.\n' >&2; exit 2; }
[[ ${PGHOST:-$host} == "$host" && ${PGPORT:-$port} == "$port" ]] || {
  printf 'Refusing a target other than %s:%s.\n' "$host" "$port" >&2
  exit 2
}
if [[ $mode != --check && -e $output_file ]]; then
  printf 'Credentials file already exists; refusing to overwrite: %s\n' "$output_file" >&2
  exit 2
fi

if [[ -z ${PGPASSWORD:-} ]]; then
  [[ -r /dev/tty ]] || { printf 'Administrator password requires an interactive terminal.\n' >&2; exit 2; }
  printf 'PostgreSQL administrator password (not echoed): ' >/dev/tty
  IFS= read -r -s PGPASSWORD </dev/tty
  printf '\n' >/dev/tty
  export PGPASSWORD
fi

admin_psql() {
  psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$PGUSER" -d postgres "$@"
}

is_superuser=$(admin_psql -A -t -c 'SELECT rolsuper FROM pg_roles WHERE rolname = current_user')
[[ $is_superuser == t ]] || {
  printf 'The supplied account is not a PostgreSQL superuser; no changes made.\n' >&2
  exit 1
}
existing=$(admin_psql -A -t -c "SELECT (SELECT count(*) FROM pg_roles WHERE rolname IN ('$migrator','$runtime')) + (SELECT count(*) FROM pg_database WHERE datname = '$database')")
if [[ $mode == --check ]]; then
  printf 'HAProxy connection and administrator rights verified. Existing AI Router objects: %s.\n' "$existing"
  exit 0
fi
if [[ $mode == --apply ]]; then
  [[ $existing == 0 ]] || {
    printf 'AI Router objects already exist. Use --recover only after verifying a partial setup. No changes made.\n' >&2
    exit 1
  }
else
  recovery_state=$(admin_psql -A -t -c "SELECT (SELECT count(*) FROM pg_roles WHERE rolname IN ('$migrator','$runtime') AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole) = 2 AND (SELECT count(*) FROM pg_database WHERE datname = '$database' AND pg_get_userbyid(datdba) = '$migrator') = 1")
  [[ $existing == 3 && $recovery_state == t ]] || {
    printf 'Unexpected partial state; refusing recovery. No changes made.\n' >&2
    exit 1
  }
fi
printf 'Type %s to confirm %s: ' "$database" "$mode" >/dev/tty
IFS= read -r confirmation </dev/tty
[[ $confirmation == "$database" ]] || { printf 'Cancelled; no changes made.\n'; exit 1; }

migration_password=$(openssl rand -hex 32)
runtime_password=$(openssl rand -hex 32)
if [[ $mode == --apply ]]; then
  printf 'Creating isolated roles and database through HAProxy...\n'
  admin_psql <<SQL
CREATE ROLE $migrator LOGIN PASSWORD '$migration_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE $runtime LOGIN PASSWORD '$runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE DATABASE $database OWNER $migrator;
REVOKE ALL ON DATABASE $database FROM PUBLIC;
GRANT CONNECT ON DATABASE $database TO $runtime;
SQL
else
  printf 'Resetting passwords for the verified partial setup and completing grants...\n'
  admin_psql <<SQL
ALTER ROLE $migrator PASSWORD '$migration_password';
ALTER ROLE $runtime PASSWORD '$runtime_password';
REVOKE ALL ON DATABASE $database FROM PUBLIC;
GRANT CONNECT ON DATABASE $database TO $runtime;
SQL
fi

# Preserve recovery credentials even if a later migration or grant fails.
mkdir -p "$(dirname "$output_file")"
chmod 700 "$(dirname "$output_file")"
temp_file=$(mktemp "${output_file}.tmp.XXXXXX")
trap 'rm -f "$temp_file"' EXIT
printf 'AI_ROUTER_MIGRATION_DATABASE_URL=postgresql://%s:%s@%s:%s/%s\n' "$migrator" "$migration_password" "$host" "$port" "$database" >"$temp_file"
printf 'AI_ROUTER_DATABASE_URL=postgresql://%s:%s@%s:%s/%s\n' "$runtime" "$runtime_password" "$host" "$port" "$database" >>"$temp_file"
chmod 600 "$temp_file"
mv "$temp_file" "$output_file"

printf 'Applying schema and least-privilege grants...\n'
PGPASSWORD=$migration_password psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$migrator" -d "$database" -f "$migration_sql"
PGPASSWORD=$migration_password psql -X -q -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$migrator" -d "$database" <<SQL
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO $runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE ai_router_request, ai_router_policy, ai_router_policy_audit TO $runtime;
GRANT USAGE, SELECT ON SEQUENCE ai_router_policy_audit_id_seq TO $runtime;
SQL

check=$(PGPASSWORD=$runtime_password psql -X -q -A -t -v ON_ERROR_STOP=1 -h "$host" -p "$port" -U "$runtime" -d "$database" -c "SELECT count(*) = 3 AND NOT has_schema_privilege(current_user, 'public', 'CREATE') AND has_table_privilege(current_user, 'ai_router_request', 'SELECT,INSERT,UPDATE') FROM pg_tables WHERE schemaname='public' AND tablename IN ('ai_router_request','ai_router_policy','ai_router_policy_audit')")
[[ $check == t ]] || {
  printf 'Runtime privilege check failed. Credentials retained for recovery: %s\n' "$output_file" >&2
  exit 1
}
printf 'Database, schema and runtime rights verified. Credentials saved (mode 600): %s\n' "$output_file"
printf 'Only AI_ROUTER_DATABASE_URL belongs in /srv/sim/.env; keep the migration URL with the database administrator.\n'
