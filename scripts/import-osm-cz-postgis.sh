#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

OSM_IMPORT_DIR="${OSM_IMPORT_DIR:-data/osm-import}"
OSM_IMPORT_DIR="${OSM_IMPORT_DIR%/}"
OSM_IMPORT_URL="${OSM_IMPORT_URL:-https://download.geofabrik.de/europe/czech-republic-latest.osm.pbf}"
OSM_IMPORT_FILE="${OSM_IMPORT_FILE:-$OSM_IMPORT_DIR/czech-republic-latest.osm.pbf}"
OSM_POSTGIS_DB="${OSM_POSTGIS_DB:-sim_osm}"
OSM_POSTGIS_USER="${OSM_POSTGIS_USER:-sim_osm}"
OSM_POSTGIS_PASSWORD="${OSM_POSTGIS_PASSWORD:-sim_osm_dev}"
OSM_POSTGIS_DATABASE_URL="${OSM_POSTGIS_DATABASE_URL:-postgresql://$OSM_POSTGIS_USER:$OSM_POSTGIS_PASSWORD@osm-postgis:5432/$OSM_POSTGIS_DB}"
OSM2PGSQL_PROCESSES="${OSM2PGSQL_PROCESSES:-4}"
OSM2PGSQL_CACHE_MB="${OSM2PGSQL_CACHE_MB:-2048}"

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

echo "Starting local PostGIS container."
docker compose --profile osm up -d osm-postgis

echo "Waiting for PostGIS readiness."
for _ in $(seq 1 60); do
  if docker compose --profile osm exec -T osm-postgis pg_isready -U "$OSM_POSTGIS_USER" -d "$OSM_POSTGIS_DB" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

docker compose --profile osm exec -T osm-postgis pg_isready -U "$OSM_POSTGIS_USER" -d "$OSM_POSTGIS_DB" >/dev/null

echo "Preparing PostGIS extensions and cleaning previous partial OSM imports."
docker compose --profile osm exec -T -e PGPASSWORD="$OSM_POSTGIS_PASSWORD" osm-postgis \
  psql -U "$OSM_POSTGIS_USER" -d "$OSM_POSTGIS_DB" -v ON_ERROR_STOP=1 <<'SQL'
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

echo "Building materialized COP POI view."
docker compose --profile osm exec -T -e PGPASSWORD="$OSM_POSTGIS_PASSWORD" osm-postgis \
  psql -U "$OSM_POSTGIS_USER" -d "$OSM_POSTGIS_DB" -v ON_ERROR_STOP=1 < deploy/osm/osm-poi-view.sql

echo "OSM POI rows:"
docker compose --profile osm exec -T -e PGPASSWORD="$OSM_POSTGIS_PASSWORD" osm-postgis \
  psql -U "$OSM_POSTGIS_USER" -d "$OSM_POSTGIS_DB" -tAc "select count(*) from public.osm_poi;"

echo "To enable in SIM:"
echo "SITUATION_DATA_ENABLED_SOURCES=open_meteo,aviation_weather,osm_postgis,ctu_nettest,pid_gtfs_rt,safety_data"
echo "OSM_POSTGIS_DATABASE_URL=$OSM_POSTGIS_DATABASE_URL"
