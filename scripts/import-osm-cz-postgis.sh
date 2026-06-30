#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

env_value() {
  local key="$1"
  if [[ -f .env ]]; then
    awk -v key="$key" '
      $0 !~ /^[[:space:]]*#/ && index($0, key "=") == 1 {
        sub("^[^=]*=", "")
        print
        exit
      }
    ' .env
  fi
}

database_host() {
  python3 - "$1" <<'PY'
from urllib.parse import urlparse
import sys
print(urlparse(sys.argv[1]).hostname or "")
PY
}

redact_database_url() {
  python3 - "$1" <<'PY'
from urllib.parse import urlparse, urlunparse
import sys
url = urlparse(sys.argv[1])
netloc = url.hostname or ""
if url.port:
    netloc += f":{url.port}"
print(urlunparse((url.scheme, netloc, url.path, "", "", "")))
PY
}

OSM_IMPORT_DIR="${OSM_IMPORT_DIR:-$(env_value OSM_IMPORT_DIR)}"
OSM_IMPORT_DIR="${OSM_IMPORT_DIR:-data/osm-import}"
OSM_IMPORT_DIR="${OSM_IMPORT_DIR%/}"
OSM_IMPORT_URL="${OSM_IMPORT_URL:-$(env_value OSM_IMPORT_URL)}"
OSM_IMPORT_URL="${OSM_IMPORT_URL:-https://download.geofabrik.de/europe/czech-republic-latest.osm.pbf}"
OSM_IMPORT_FILE="${OSM_IMPORT_FILE:-$(env_value OSM_IMPORT_FILE)}"
OSM_IMPORT_FILE="${OSM_IMPORT_FILE:-$OSM_IMPORT_DIR/czech-republic-latest.osm.pbf}"
OSM_POSTGIS_DB="${OSM_POSTGIS_DB:-$(env_value OSM_POSTGIS_DB)}"
OSM_POSTGIS_DB="${OSM_POSTGIS_DB:-sim_osm}"
OSM_POSTGIS_USER="${OSM_POSTGIS_USER:-$(env_value OSM_POSTGIS_USER)}"
OSM_POSTGIS_USER="${OSM_POSTGIS_USER:-sim_osm}"
OSM_POSTGIS_PASSWORD="${OSM_POSTGIS_PASSWORD:-$(env_value OSM_POSTGIS_PASSWORD)}"
OSM_POSTGIS_DATABASE_URL="${OSM_POSTGIS_DATABASE_URL:-$(env_value OSM_POSTGIS_DATABASE_URL)}"
REQUESTED_OSM_POSTGIS_BACKEND="${OSM_POSTGIS_BACKEND:-$(env_value OSM_POSTGIS_BACKEND)}"
OSM2PGSQL_PROCESSES="${OSM2PGSQL_PROCESSES:-$(env_value OSM2PGSQL_PROCESSES)}"
OSM2PGSQL_PROCESSES="${OSM2PGSQL_PROCESSES:-4}"
OSM2PGSQL_CACHE_MB="${OSM2PGSQL_CACHE_MB:-$(env_value OSM2PGSQL_CACHE_MB)}"
OSM2PGSQL_CACHE_MB="${OSM2PGSQL_CACHE_MB:-2048}"

if [[ -z "${OSM_POSTGIS_DATABASE_URL:-}" ]]; then
  if [[ -z "${OSM_POSTGIS_PASSWORD:-}" ]]; then
    cat >&2 <<'EOF'
Set OSM_POSTGIS_DATABASE_URL for Patroni/PostGIS, for example:
  OSM_POSTGIS_DATABASE_URL=postgresql://sim_osm:<strong-password>@haproxy.home.cz:5000/sim_osm

For the local rebuildable Docker cache, set OSM_POSTGIS_PASSWORD and the script will build:
  postgresql://sim_osm:<password>@osm-postgis:5432/sim_osm
EOF
    exit 1
  fi
  OSM_POSTGIS_DATABASE_URL="postgresql://$OSM_POSTGIS_USER:$OSM_POSTGIS_PASSWORD@osm-postgis:5432/$OSM_POSTGIS_DB"
fi

OSM_POSTGIS_HOST="$(database_host "$OSM_POSTGIS_DATABASE_URL")"
OSM_POSTGIS_BACKEND="external-postgis"
if [[ "$REQUESTED_OSM_POSTGIS_BACKEND" == "local-postgis" || "$REQUESTED_OSM_POSTGIS_BACKEND" == "patroni-postgis" || "$REQUESTED_OSM_POSTGIS_BACKEND" == "external-postgis" ]]; then
  OSM_POSTGIS_BACKEND="$REQUESTED_OSM_POSTGIS_BACKEND"
elif [[ "$OSM_POSTGIS_HOST" == "osm-postgis" || "$OSM_POSTGIS_HOST" == "localhost" || "$OSM_POSTGIS_HOST" == "127.0.0.1" ]]; then
  OSM_POSTGIS_BACKEND="local-postgis"
elif [[ "$OSM_POSTGIS_HOST" == "haproxy.home.cz" || "$OSM_POSTGIS_HOST" == *"patroni"* ]]; then
  OSM_POSTGIS_BACKEND="patroni-postgis"
fi

if [[ "$OSM_POSTGIS_BACKEND" == "local-postgis" && "$OSM_POSTGIS_HOST" != "osm-postgis" && "$OSM_POSTGIS_HOST" != "localhost" && "$OSM_POSTGIS_HOST" != "127.0.0.1" ]]; then
  echo "OSM_POSTGIS_BACKEND=local-postgis does not match database host '$OSM_POSTGIS_HOST'." >&2
  exit 1
fi

mkdir -p "$OSM_IMPORT_DIR"

if [[ ! "$OSM_IMPORT_FILE" = "$OSM_IMPORT_DIR/"* ]]; then
  echo "OSM_IMPORT_FILE must be inside OSM_IMPORT_DIR because the importer mounts only that directory." >&2
  exit 1
fi

if [[ ! -s "$OSM_IMPORT_FILE" ]]; then
  echo "Downloading OSM extract: $OSM_IMPORT_URL"
  curl -fL --retry 3 --retry-delay 5 -o "$OSM_IMPORT_FILE.tmp" "$OSM_IMPORT_URL"
  mv "$OSM_IMPORT_FILE.tmp" "$OSM_IMPORT_FILE"
else
  echo "Using existing OSM extract: $OSM_IMPORT_FILE"
fi

echo "Using OSM PostGIS backend: $OSM_POSTGIS_BACKEND ($(redact_database_url "$OSM_POSTGIS_DATABASE_URL"))"

if [[ "$OSM_POSTGIS_BACKEND" == "local-postgis" ]]; then
  if [[ -z "${OSM_POSTGIS_PASSWORD:-}" ]]; then
    echo "Set OSM_POSTGIS_PASSWORD before starting the local osm-postgis service." >&2
    exit 1
  fi
  echo "Starting local rebuildable PostGIS cache container."
  docker compose --profile osm up -d osm-postgis
fi

run_psql() {
  if [[ "$OSM_POSTGIS_BACKEND" == "local-postgis" ]]; then
    docker compose --profile osm exec -T osm-postgis psql "$OSM_POSTGIS_DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
  else
    docker run --rm -i postgis/postgis:16-3.5 psql "$OSM_POSTGIS_DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
  fi
}

run_pg_isready() {
  if [[ "$OSM_POSTGIS_BACKEND" == "local-postgis" ]]; then
    docker compose --profile osm exec -T osm-postgis pg_isready -d "$OSM_POSTGIS_DATABASE_URL" >/dev/null 2>&1
  else
    docker run --rm postgis/postgis:16-3.5 pg_isready -d "$OSM_POSTGIS_DATABASE_URL" >/dev/null 2>&1
  fi
}

echo "Waiting for PostGIS readiness."
for _ in $(seq 1 60); do
  if run_pg_isready; then
    break
  fi
  sleep 2
done
run_pg_isready

echo "Preparing PostGIS extensions and cleaning previous partial OSM imports."
run_psql <<'SQL'
create extension if not exists postgis;
create extension if not exists hstore;
drop materialized view if exists public.osm_poi cascade;
drop table if exists
  public.osm_point,
  public.osm_line,
  public.osm_polygon,
  public.osm_roads,
  public.osm_nodes,
  public.osm_ways,
  public.osm_rels,
  public.osm2pgsql_properties
cascade;
SQL

echo "Importing OSM PBF into PostGIS with osm2pgsql."
if [[ "$OSM_POSTGIS_BACKEND" == "local-postgis" ]]; then
  docker compose --profile osm --profile osm-import run --rm osm-importer \
    --create \
    --slim \
    --drop \
    --latlong \
    --hstore-all \
    --prefix osm \
    --number-processes "$OSM2PGSQL_PROCESSES" \
    --cache "$OSM2PGSQL_CACHE_MB" \
    --database "$OSM_POSTGIS_DATABASE_URL" \
    "/import/$(basename "$OSM_IMPORT_FILE")"
else
  docker run --rm \
    -v "$PWD/$OSM_IMPORT_DIR:/import:ro" \
    iboates/osm2pgsql:latest \
    --create \
    --slim \
    --drop \
    --latlong \
    --hstore-all \
    --prefix osm \
    --number-processes "$OSM2PGSQL_PROCESSES" \
    --cache "$OSM2PGSQL_CACHE_MB" \
    --database "$OSM_POSTGIS_DATABASE_URL" \
    "/import/$(basename "$OSM_IMPORT_FILE")"
fi

echo "Building materialized COP POI view."
run_psql < deploy/osm/osm-poi-view.sql

echo "Building materialized administrative boundary view."
run_psql < deploy/osm/osm-admin-boundary-view.sql

echo "OSM POI rows:"
run_psql -tAc "select count(*) from public.osm_poi;"
echo "OSM admin boundary rows:"
run_psql -tAc "select count(*) from public.osm_admin_boundary;"

cat <<EOF
To enable in SIM:
SITUATION_DATA_ENABLED_SOURCES=open_meteo,aviation_weather,chmi_weather_stations,chmi_air_quality,osm_postgis,mobile_coverage_model,mobile_network_model,ctu_nettest,ctu_stationary_mobile,pid_gtfs_rt,public_transit_static,spravazeleznic_trains,safety_data
SITUATION_DATA_OSM_POSTGIS_CACHE_TTL_SECONDS=21600
SITUATION_DATA_MOBILE_NETWORK_CACHE_TTL_SECONDS=3600
SITUATION_DATA_MOBILE_COVERAGE_CACHE_TTL_SECONDS=21600
MOBILE_COVERAGE_READ_MODEL_ENABLED=true
MOBILE_COVERAGE_READ_MODEL_TABLE=public.mobile_coverage_cells
MOBILE_COVERAGE_READ_MODEL_MAX_AGE_SECONDS=604800
OSM_POSTGIS_BACKEND=$OSM_POSTGIS_BACKEND
OSM_POSTGIS_DATABASE_URL=$(redact_database_url "$OSM_POSTGIS_DATABASE_URL")
OSM_POSTGIS_TABLE=public.osm_poi
OSM_POSTGIS_ADMIN_BOUNDARY_TABLE=public.osm_admin_boundary
SAFETY_DATA_ENABLED_SOURCES=chmi_alerts,chmi_hydro,admin_boundaries
SAFETY_DATA_ADMIN_BOUNDARY_DATABASE_URL=$(redact_database_url "$OSM_POSTGIS_DATABASE_URL")
SAFETY_DATA_ADMIN_BOUNDARY_TABLE=public.osm_admin_boundary
SAFETY_DATA_ADMIN_BOUNDARY_CACHE_TTL_SECONDS=86400
EOF
