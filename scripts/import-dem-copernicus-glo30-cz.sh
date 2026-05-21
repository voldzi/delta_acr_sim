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

DEM_BBOX="${DEM_BBOX:-$(env_value DEM_BBOX)}"
DEM_BBOX="${DEM_BBOX:-11.8,48.5,19.2,51.2}"
DEM_DATASET_ID="${DEM_DATASET_ID:-$(env_value DEM_DATASET_ID)}"
DEM_DATASET_ID="${DEM_DATASET_ID:-copernicus-glo30-cz}"
DEM_SOURCE="${DEM_SOURCE:-copernicus-dem-glo30}"
DEM_VERSION="${DEM_VERSION:-2021}"
DEM_RESOLUTION_M="${DEM_RESOLUTION_M:-30}"
DEM_SOURCE_BASE_URL="${DEM_SOURCE_BASE_URL:-https://copernicus-dem-30m.s3.amazonaws.com}"
DEM_LOCAL_CACHE_HOST_DIR="${DEM_LOCAL_CACHE_HOST_DIR:-$(env_value DEM_LOCAL_CACHE_HOST_DIR)}"
DEM_LOCAL_CACHE_HOST_DIR="${DEM_LOCAL_CACHE_HOST_DIR:-data/dem-cache/copernicus-glo30}"
DEM_LOCAL_CACHE_DIR="${DEM_LOCAL_CACHE_DIR:-$(env_value DEM_LOCAL_CACHE_DIR)}"
DEM_LOCAL_CACHE_DIR="${DEM_LOCAL_CACHE_DIR:-/dem-cache/copernicus-glo30}"
DEM_SEAWEEDFS_ENABLED="${DEM_SEAWEEDFS_ENABLED:-$(env_value DEM_SEAWEEDFS_ENABLED)}"
DEM_SEAWEEDFS_ENABLED="${DEM_SEAWEEDFS_ENABLED:-false}"
DEM_SEAWEEDFS_S3_ENDPOINT="${DEM_SEAWEEDFS_S3_ENDPOINT:-$(env_value DEM_SEAWEEDFS_S3_ENDPOINT)}"
DEM_SEAWEEDFS_S3_ENDPOINT="${DEM_SEAWEEDFS_S3_ENDPOINT:-}"
DEM_SEAWEEDFS_BUCKET="${DEM_SEAWEEDFS_BUCKET:-$(env_value DEM_SEAWEEDFS_BUCKET)}"
DEM_SEAWEEDFS_BUCKET="${DEM_SEAWEEDFS_BUCKET:-sim-dem}"
DEM_SEAWEEDFS_PREFIX="${DEM_SEAWEEDFS_PREFIX:-$(env_value DEM_SEAWEEDFS_PREFIX)}"
DEM_SEAWEEDFS_PREFIX="${DEM_SEAWEEDFS_PREFIX:-copernicus-glo30/2021}"
DEM_SEAWEEDFS_ACCESS_KEY_ID="${DEM_SEAWEEDFS_ACCESS_KEY_ID:-$(env_value DEM_SEAWEEDFS_ACCESS_KEY_ID)}"
DEM_SEAWEEDFS_SECRET_ACCESS_KEY="${DEM_SEAWEEDFS_SECRET_ACCESS_KEY:-$(env_value DEM_SEAWEEDFS_SECRET_ACCESS_KEY)}"
DEM_POSTGIS_DATABASE_URL="${DEM_POSTGIS_DATABASE_URL:-$(env_value DEM_POSTGIS_DATABASE_URL)}"
DEM_POSTGIS_DATABASE_URL="${DEM_POSTGIS_DATABASE_URL:-${OSM_POSTGIS_DATABASE_URL:-$(env_value OSM_POSTGIS_DATABASE_URL)}}"
DEM_IMPORT_LIMIT="${DEM_IMPORT_LIMIT:-$(env_value DEM_IMPORT_LIMIT)}"
DEM_IMPORT_LIMIT="${DEM_IMPORT_LIMIT:-0}"

if [[ -z "${DEM_POSTGIS_DATABASE_URL:-}" ]]; then
  echo "Set DEM_POSTGIS_DATABASE_URL or OSM_POSTGIS_DATABASE_URL." >&2
  exit 1
fi

mkdir -p "$DEM_LOCAL_CACHE_HOST_DIR"
DEM_LOCAL_CACHE_HOST_ABS="$(cd "$DEM_LOCAL_CACHE_HOST_DIR" && pwd)"
manifest="$(mktemp)"
trap 'rm -f "$manifest" "$manifest.sql" "$manifest.plan"' EXIT

python3 - "$DEM_BBOX" <<'PY' > "$manifest.plan"
import math
import sys

west, south, east, north = [float(item) for item in sys.argv[1].split(",")]
lon_start = math.floor(west)
lon_end = math.ceil(east) - 1
lat_start = math.floor(south)
lat_end = math.ceil(north) - 1

def hem(value: int, positive: str, negative: str, width: int) -> str:
    return f"{positive if value >= 0 else negative}{abs(value):0{width}d}_00"

for lat in range(lat_start, lat_end + 1):
    for lon in range(lon_start, lon_end + 1):
        northing = hem(lat, "N", "S", 2)
        easting = hem(lon, "E", "W", 3)
        tile = f"Copernicus_DSM_COG_10_{northing}_{easting}_DEM"
        print(f"{tile}\t{lon}\t{lat}\t{lon + 1}\t{lat + 1}")
PY

echo "Importing Copernicus DEM GLO-30 tiles for bbox $DEM_BBOX."
echo "Dataset: $DEM_DATASET_ID"
echo "Local cache: $DEM_LOCAL_CACHE_HOST_DIR"
echo "PostGIS: $(redact_database_url "$DEM_POSTGIS_DATABASE_URL")"

count=0
while IFS=$'\t' read -r tile west south east north; do
  count=$((count + 1))
  if [[ "$DEM_IMPORT_LIMIT" != "0" && "$count" -gt "$DEM_IMPORT_LIMIT" ]]; then
    break
  fi

  filename="$tile.tif"
  url="$DEM_SOURCE_BASE_URL/$tile/$filename"
  local_file="$DEM_LOCAL_CACHE_HOST_DIR/$filename"

  if [[ ! -s "$local_file" ]]; then
    echo "Downloading $tile"
    if ! curl -fL --retry 3 --retry-delay 5 -o "$local_file.tmp" "$url"; then
      echo "Skipping missing tile $tile" >&2
      rm -f "$local_file.tmp"
      continue
    fi
    mv "$local_file.tmp" "$local_file"
  else
    echo "Using cached $tile"
  fi

  size="$(wc -c < "$local_file" | tr -d ' ')"
  sha="$(sha256sum "$local_file" | awk '{print $1}')"
  object_key="$DEM_SEAWEEDFS_PREFIX/$tile/$filename"
  container_path="${DEM_LOCAL_CACHE_DIR%/}/$filename"
  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$tile" "$url" "$object_key" "$container_path" "$sha" "$size" "$west" "$south" "$east" "$north" >> "$manifest"
done < "$manifest.plan"

rm -f "$manifest.plan"

if [[ ! -s "$manifest" ]]; then
  echo "No DEM tiles were downloaded or found." >&2
  exit 1
fi

if [[ "$DEM_SEAWEEDFS_ENABLED" == "true" || "$DEM_SEAWEEDFS_ENABLED" == "1" || "$DEM_SEAWEEDFS_ENABLED" == "yes" ]]; then
  if [[ -z "${DEM_SEAWEEDFS_S3_ENDPOINT:-}" ]]; then
    echo "DEM SeaweedFS upload requested but DEM_SEAWEEDFS_S3_ENDPOINT is not configured." >&2
    exit 1
  fi
  if [[ "$DEM_SEAWEEDFS_S3_ENDPOINT" == *"looloo.zeleznalady.cz"* ]]; then
    echo "Refusing to use Looloo SeaweedFS endpoint for SIM DEM. Configure a dedicated SIM SeaweedFS S3 gateway." >&2
    exit 1
  fi
  if [[ -z "${DEM_SEAWEEDFS_ACCESS_KEY_ID:-}" || -z "${DEM_SEAWEEDFS_SECRET_ACCESS_KEY:-}" ]]; then
    echo "DEM SeaweedFS upload requested but DEM_SEAWEEDFS_ACCESS_KEY_ID/DEM_SEAWEEDFS_SECRET_ACCESS_KEY is not configured." >&2
    exit 1
  fi
  echo "Ensuring SeaweedFS bucket $DEM_SEAWEEDFS_BUCKET exists."
  docker run --rm \
    -e AWS_ACCESS_KEY_ID="$DEM_SEAWEEDFS_ACCESS_KEY_ID" \
    -e AWS_SECRET_ACCESS_KEY="$DEM_SEAWEEDFS_SECRET_ACCESS_KEY" \
    -e AWS_DEFAULT_REGION=us-east-1 \
    -e AWS_EC2_METADATA_DISABLED=true \
    amazon/aws-cli:latest \
    --endpoint-url "$DEM_SEAWEEDFS_S3_ENDPOINT" \
    s3 mb "s3://$DEM_SEAWEEDFS_BUCKET" >/dev/null 2>&1 || true

  echo "Uploading DEM tiles to SeaweedFS."
  while IFS=$'\t' read -r _tile _url object_key _container_path _sha _size _west _south _east _north; do
    local_name="$(basename "$object_key")"
    docker run --rm \
      -e AWS_ACCESS_KEY_ID="$DEM_SEAWEEDFS_ACCESS_KEY_ID" \
      -e AWS_SECRET_ACCESS_KEY="$DEM_SEAWEEDFS_SECRET_ACCESS_KEY" \
      -e AWS_DEFAULT_REGION=us-east-1 \
      -e AWS_EC2_METADATA_DISABLED=true \
      -v "$DEM_LOCAL_CACHE_HOST_ABS:/dem:ro" \
      amazon/aws-cli:latest \
      --endpoint-url "$DEM_SEAWEEDFS_S3_ENDPOINT" \
      s3 cp "/dem/$local_name" "s3://$DEM_SEAWEEDFS_BUCKET/$object_key" >/dev/null
  done < "$manifest"
  object_store_available=true
else
  echo "SeaweedFS upload disabled; registering local-only DEM tiles."
  object_store_available=false
fi

run_psql() {
  docker run --rm -i postgis/postgis:16-3.5 psql "$DEM_POSTGIS_DATABASE_URL" -v ON_ERROR_STOP=1 "$@"
}

echo "Creating DEM schema."
run_psql < deploy/dem/dem-schema.sql

manifest_sql="$manifest.sql"
python3 - "$manifest" "$DEM_DATASET_ID" "$DEM_SOURCE" "$DEM_VERSION" "$DEM_RESOLUTION_M" "$DEM_SOURCE_BASE_URL" "$DEM_SEAWEEDFS_S3_ENDPOINT" "$DEM_SEAWEEDFS_BUCKET" "$DEM_SEAWEEDFS_PREFIX" "$DEM_LOCAL_CACHE_DIR" "$object_store_available" <<'PY' > "$manifest_sql"
import sys

manifest, dataset_id, source, version, resolution_m, source_url, endpoint, bucket, prefix, local_cache_dir, object_store_available = sys.argv[1:]

def q(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"

print(
    "insert into public.dem_datasets "
    "(dataset_id, source, version, resolution_m, source_url, license_name, attribution, s3_endpoint, s3_bucket, s3_prefix, local_cache_dir, status, imported_at, updated_at) values "
    f"({q(dataset_id)}, {q(source)}, {q(version)}, {int(resolution_m)}, {q(source_url)}, "
    f"{q('Copernicus DEM License')}, {q('Copernicus DEM 2021 release via AWS Open Data')}, "
    f"{q(endpoint)}, {q(bucket)}, {q(prefix)}, {q(local_cache_dir)}, {q('ready')}, now(), now()) "
    "on conflict (dataset_id) do update set "
    "source=excluded.source, version=excluded.version, resolution_m=excluded.resolution_m, source_url=excluded.source_url, "
    "license_name=excluded.license_name, attribution=excluded.attribution, s3_endpoint=excluded.s3_endpoint, "
    "s3_bucket=excluded.s3_bucket, s3_prefix=excluded.s3_prefix, local_cache_dir=excluded.local_cache_dir, "
    "status=excluded.status, imported_at=excluded.imported_at, updated_at=now();"
)

with open(manifest, "r", encoding="utf-8") as handle:
    for line in handle:
        tile, url, object_key, container_path, sha, size, west, south, east, north = line.rstrip("\n").split("\t")
        print(
            "insert into public.dem_tiles "
            "(dataset_id, tile_id, source_url, object_key, local_path, checksum_sha256, content_length_bytes, west, south, east, north, resolution_m, available_locally, available_object_store, imported_at, updated_at) values "
            f"({q(dataset_id)}, {q(tile)}, {q(url)}, {q(object_key)}, {q(container_path)}, {q(sha)}, {int(size)}, "
            f"{float(west)}, {float(south)}, {float(east)}, {float(north)}, {int(resolution_m)}, true, {object_store_available}, now(), now()) "
            "on conflict (dataset_id, tile_id) do update set "
            "source_url=excluded.source_url, object_key=excluded.object_key, local_path=excluded.local_path, "
            "checksum_sha256=excluded.checksum_sha256, content_length_bytes=excluded.content_length_bytes, "
            "west=excluded.west, south=excluded.south, east=excluded.east, north=excluded.north, resolution_m=excluded.resolution_m, "
            "available_locally=excluded.available_locally, available_object_store=excluded.available_object_store, updated_at=now();"
        )
PY

echo "Registering DEM tiles in PostGIS."
run_psql < "$manifest_sql"

echo "DEM dataset summary:"
run_psql -tAc "select dataset_id || ' tiles=' || count(*) || ' local=' || count(*) filter (where available_locally) || ' object_store=' || count(*) filter (where available_object_store) from public.dem_tiles where dataset_id = '$DEM_DATASET_ID' group by dataset_id;"
