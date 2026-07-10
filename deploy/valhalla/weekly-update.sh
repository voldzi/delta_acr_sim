#!/usr/bin/env bash
set -Eeuo pipefail

DEFAULT_VALHALLA_IMAGE="ghcr.io/valhalla/valhalla-scripted:3.8.2@sha256:3d7a08f7e78b356ee873b61711b743ad81bcc114b0ca5731217da8bba6ba39d1"

BASE_DIR=${BASE_DIR:-/srv/valhalla}
RELEASE_ROOT=${RELEASE_ROOT:-${BASE_DIR}/releases}
WORK_ROOT=${WORK_ROOT:-${BASE_DIR}/update-work}
STATE_DIR=${STATE_DIR:-${BASE_DIR}/state}
TOOLS_DIR=${TOOLS_DIR:-${BASE_DIR}/update-tools}
CURRENT_LINK=${CURRENT_LINK:-${BASE_DIR}/current}
COMPOSE_FILE=${COMPOSE_FILE:-${BASE_DIR}/docker-compose.yml}
VALHALLA_IMAGE=${VALHALLA_IMAGE:-${DEFAULT_VALHALLA_IMAGE}}
OSM_TOOLS_IMAGE=${OSM_TOOLS_IMAGE:-local/valhalla-osm-tools:bookworm}
BUFFER_METERS=${BUFFER_METERS:-75000}
MIN_FREE_GB=${MIN_FREE_GB:-35}
BUILD_MEMORY=${BUILD_MEMORY:-6g}
BUILD_MEMORY_SWAP=${BUILD_MEMORY_SWAP:-8g}
BUILD_CPUS=${BUILD_CPUS:-3}
DOWNLOAD_CPUS=${DOWNLOAD_CPUS:-2}
CANDIDATE_PORT=${CANDIDATE_PORT:-18002}
VALIDATION_TIMEOUT_SECONDS=${VALIDATION_TIMEOUT_SECONDS:-8}
VALIDATION_SNAP_METERS=${VALIDATION_SNAP_METERS:-2500}
RETAIN_RELEASES=${RETAIN_RELEASES:-3}
PRESERVE_FAILED_BUILD=${PRESERVE_FAILED_BUILD:-false}
SOURCE_DOWNLOAD_ATTEMPTS=${SOURCE_DOWNLOAD_ATTEMPTS:-6}
SOURCE_RETRY_DELAY_SECONDS=${SOURCE_RETRY_DELAY_SECONDS:-120}
MIN_GRAPH_TILE_FILES=${MIN_GRAPH_TILE_FILES:-200}

MODE=${1:-run}
case "${MODE}" in
  run | build | activate | recover | status) ;;
  *)
    echo "usage: $0 [run|build|activate RELEASE_ID|recover|status]" >&2
    exit 2
    ;;
esac

if [[ "${MODE}" == "activate" ]]; then
  [[ -n "${2:-}" ]] || {
    echo "activate requires a release ID" >&2
    exit 2
  }
  RELEASE_ID=$2
else
  RELEASE_ID=${RELEASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}
fi

WORK_DIR=${WORK_ROOT}/${RELEASE_ID}
SOURCE_DIR=${WORK_DIR}/sources
RELEASE_DIR=${RELEASE_ROOT}/${RELEASE_ID}
STAGE_DIR=${RELEASE_DIR}/custom_files
LOCK_FILE=${BASE_DIR}/weekly-update.lock
STATE_FILE=${STATE_DIR}/last-attempt.env
TRANSACTION_FILE=${STATE_DIR}/transaction.env
VALIDATOR=${TOOLS_DIR}/validate-response.py
ADMIN_VALIDATOR=${TOOLS_DIR}/validate-admins.py
STARTED_AT=$(date -u +%FT%TZ)
CURRENT_PHASE=initializing
FAILURE_HANDLED=0
ACTIVATION_SWITCHED=0
ACTIVATION_PREVIOUS_TARGET=
ACTIVATION_BASE_URL=

readonly -a SOURCE_SPECS=(
  "CZ|https://download.geofabrik.de/europe/czech-republic-latest.osm.pbf"
  "DE|https://download.geofabrik.de/europe/germany-latest.osm.pbf"
  "PL|https://download.geofabrik.de/europe/poland-latest.osm.pbf"
  "SK|https://download.geofabrik.de/europe/slovakia-latest.osm.pbf"
  "AT|https://download.geofabrik.de/europe/austria-latest.osm.pbf"
  "HU|https://download.geofabrik.de/europe/hungary-latest.osm.pbf"
)

readonly -a ROUTE_TESTS=(
  "prague|50.08804|14.42076|50.07550|14.43780|CZ|10"
  "germany|50.07963|12.37392|50.00059|12.08553|CZ,DE|70"
  "poland|49.82090|18.26250|50.26490|19.02380|CZ,PL|140"
  "slovakia|48.75897|16.88203|48.14860|17.10770|CZ,SK|120"
  "austria|49.19114|16.61158|48.20849|16.37208|CZ,AT|180"
  "hungary|48.75897|16.88203|47.99650|17.19830|CZ,HU|160"
)

readonly -a LOCATE_TESTS=(
  "prague|50.07550|14.43780"
  "germany|50.00059|12.08553"
  "poland|50.26490|19.02380"
  "slovakia|48.14860|17.10770"
  "austria|48.20849|16.37208"
  "hungary|47.99650|17.19830"
)

log() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"
}

sanitize_state_value() {
  tr '\n\r=' '   ' <<<"$1" | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}

write_state() {
  local status=$1
  local detail=${2:-}
  local tmp
  mkdir -p "${STATE_DIR}"
  tmp="${STATE_FILE}.tmp.$$"
  {
    printf 'RELEASE_ID=%s\n' "${RELEASE_ID}"
    printf 'STATUS=%s\n' "${status}"
    printf 'PHASE=%s\n' "${CURRENT_PHASE}"
    printf 'STARTED_AT=%s\n' "${STARTED_AT}"
    printf 'UPDATED_AT=%s\n' "$(date -u +%FT%TZ)"
    printf 'MODE=%s\n' "${MODE}"
    printf 'DETAIL=%s\n' "$(sanitize_state_value "${detail}")"
  } >"${tmp}"
  mv -f "${tmp}" "${STATE_FILE}"
}

cleanup_containers() {
  docker rm -f valhalla-update-candidate valhalla-update-build >/dev/null 2>&1 || true
}

remove_tree() {
  local target=$1
  local parent
  local name
  [[ -e "${target}" || -L "${target}" ]] || return 0
  parent=$(dirname "${target}")
  name=$(basename "${target}")
  docker run --rm -v "${parent}:/cleanup" debian:bookworm-slim rm -rf "/cleanup/${name}" >/dev/null
}

cleanup_failed_build() {
  remove_tree "${WORK_DIR}" || true
  if [[ "${PRESERVE_FAILED_BUILD}" != "true" ]]; then
    remove_tree "${RELEASE_DIR}" || true
  fi
}

fail() {
  local message=$*
  FAILURE_HANDLED=1
  set +e
  log "ERROR: ${message}"
  write_state failed "${message}"
  cleanup_containers
  if [[ "${MODE}" == "run" || "${MODE}" == "build" ]]; then
    cleanup_failed_build
  fi
  exit 1
}

unexpected_failure() {
  local status=$?
  local line=${1:-unknown}
  (( FAILURE_HANDLED == 1 )) && exit "${status}"
  if (( ACTIVATION_SWITCHED == 1 )) && [[ -n "${ACTIVATION_PREVIOUS_TARGET}" && -n "${ACTIVATION_BASE_URL}" ]]; then
    FAILURE_HANDLED=1
    set +e
    log "Unhandled activation failure; restoring ${ACTIVATION_PREVIOUS_TARGET}."
    docker compose -f "${COMPOSE_FILE}" stop valhalla >/dev/null 2>&1
    switch_current "${ACTIVATION_PREVIOUS_TARGET}"
    local switch_status=$?
    local restart_status=1
    local validation_status=1
    if (( switch_status == 0 )); then
      recreate_production
      restart_status=$?
    fi
    if (( restart_status == 0 )); then
      validate_release_profile "${ACTIVATION_PREVIOUS_TARGET}" "${ACTIVATION_BASE_URL}"
      validation_status=$?
    fi
    if (( switch_status == 0 && restart_status == 0 && validation_status == 0 )); then
      rm -f "${TRANSACTION_FILE}"
      write_state failed "Unhandled activation failure at line ${line}; previous release restored and validated."
    else
      write_state failed "Unhandled activation failure at line ${line}; automatic rollback failed and manual recovery is required."
    fi
    cleanup_containers
    exit "${status}"
  fi
  fail "Unhandled command failure at line ${line} (exit ${status})."
}

require_commands() {
  local command
  for command in cmp curl docker flock python3 sha256sum; do
    command -v "${command}" >/dev/null || fail "Required command is missing: ${command}"
  done
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is unavailable."
  [[ -x "${VALIDATOR}" ]] || fail "Response validator is missing or not executable: ${VALIDATOR}"
  [[ -x "${ADMIN_VALIDATOR}" ]] || fail "Admin validator is missing or not executable: ${ADMIN_VALIDATOR}"
  [[ -f "${COMPOSE_FILE}" ]] || fail "Compose file is missing: ${COMPOSE_FILE}"
}

current_release_dir() {
  [[ -L "${CURRENT_LINK}" ]] || fail "Current release link is missing: ${CURRENT_LINK}"
  readlink -f "${CURRENT_LINK}"
}

wait_for_status() {
  local base_url=$1
  local attempts=${2:-90}
  local response="${WORK_DIR}/status-response.json"
  local attempt
  mkdir -p "${WORK_DIR}"
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl -fsS --connect-timeout 2 --max-time 5 "${base_url}/status" -o "${response}" && \
      python3 "${VALIDATOR}" status "${response}"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

request_json() {
  local base_url=$1
  local action=$2
  local payload=$3
  local response=$4
  curl -fsS --connect-timeout 3 --max-time "${VALIDATION_TIMEOUT_SECONDS}" \
    --get --data-urlencode "json=${payload}" "${base_url}/${action}" -o "${response}"
}

check_locate() {
  local base_url=$1
  local label=$2
  local lat=$3
  local lon=$4
  local response="${WORK_DIR}/locate-${label}.json"
  local payload
  payload=$(printf '{"locations":[{"lat":%s,"lon":%s,"radius":%s,"search_cutoff":%s}],"verbose":true,"costing":"auto"}' \
    "${lat}" "${lon}" "${VALIDATION_SNAP_METERS}" "${VALIDATION_SNAP_METERS}")
  request_json "${base_url}" locate "${payload}" "${response}" && \
    python3 "${VALIDATOR}" locate "${response}" --max-snap-m "${VALIDATION_SNAP_METERS}"
}

check_route() {
  local base_url=$1
  local label=$2
  local from_lat=$3
  local from_lon=$4
  local to_lat=$5
  local to_lon=$6
  local expected_admins=$7
  local max_km=$8
  local response="${WORK_DIR}/route-${label}.json"
  local payload
  payload=$(printf '{"locations":[{"lat":%s,"lon":%s,"radius":%s,"search_cutoff":%s},{"lat":%s,"lon":%s,"radius":%s,"search_cutoff":%s}],"costing":"auto","units":"kilometers","language":"cs-CZ","admin_crossings":true,"linear_references":true,"elevation_interval":100}' \
    "${from_lat}" "${from_lon}" "${VALIDATION_SNAP_METERS}" "${VALIDATION_SNAP_METERS}" \
    "${to_lat}" "${to_lon}" "${VALIDATION_SNAP_METERS}" "${VALIDATION_SNAP_METERS}")
  request_json "${base_url}" route "${payload}" "${response}" && \
    python3 "${VALIDATOR}" route "${response}" --max-km "${max_km}" \
      --max-snap-m "${VALIDATION_SNAP_METERS}" --expected-admins "${expected_admins}" \
      --from-lat "${from_lat}" --from-lon "${from_lon}" --to-lat "${to_lat}" --to-lon "${to_lon}" \
      --require-elevation
}

check_isochrone() {
  local base_url=$1
  local label=$2
  local lat=$3
  local lon=$4
  local response="${WORK_DIR}/isochrone-${label}.json"
  local payload
  payload=$(printf '{"locations":[{"lat":%s,"lon":%s,"radius":%s,"search_cutoff":%s}],"costing":"auto","contours":[{"time":10}],"polygons":true,"denoise":1,"generalize":80}' \
    "${lat}" "${lon}" "${VALIDATION_SNAP_METERS}" "${VALIDATION_SNAP_METERS}")
  request_json "${base_url}" isochrone "${payload}" "${response}" && \
    python3 "${VALIDATOR}" isochrone "${response}"
}

check_height() {
  local base_url=$1
  local response="${WORK_DIR}/height.json"
  local payload='{"shape":[{"lat":50.07550,"lon":14.43780},{"lat":50.00059,"lon":12.08553},{"lat":50.26490,"lon":19.02380},{"lat":48.14860,"lon":17.10770},{"lat":48.20849,"lon":16.37208},{"lat":47.99650,"lon":17.19830}],"range":true}'
  request_json "${base_url}" height "${payload}" "${response}" && \
    python3 "${VALIDATOR}" height "${response}" --min-samples 6
}

validate_basic() {
  local base_url=$1
  wait_for_status "${base_url}" || return 1
  check_locate "${base_url}" prague 50.07550 14.43780 || return 1
  check_route "${base_url}" prague 50.08804 14.42076 50.07550 14.43780 CZ 10 || return 1
  check_isochrone "${base_url}" prague 50.07550 14.43780 || return 1
  return 0
}

validate_full() {
  local base_url=$1
  local spec
  local label
  local from_lat
  local from_lon
  local to_lat
  local to_lon
  local expected_admins
  local max_km
  local lat
  local lon
  wait_for_status "${base_url}" || return 1
  for spec in "${LOCATE_TESTS[@]}"; do
    IFS='|' read -r label lat lon <<<"${spec}"
    log "Validating locate coverage: ${label}."
    check_locate "${base_url}" "${label}" "${lat}" "${lon}" || return 1
    log "Validating isochrone coverage: ${label}."
    check_isochrone "${base_url}" "${label}" "${lat}" "${lon}" || return 1
  done
  for spec in "${ROUTE_TESTS[@]}"; do
    IFS='|' read -r label from_lat from_lon to_lat to_lon expected_admins max_km <<<"${spec}"
    log "Validating route coverage: ${label}."
    check_route "${base_url}" "${label}" "${from_lat}" "${from_lon}" "${to_lat}" "${to_lon}" "${expected_admins}" "${max_km}" || return 1
  done
  log "Validating elevation action."
  check_height "${base_url}" || return 1
}

verify_source_checksum() {
  local file=$1
  local checksum_file=$2
  python3 - "${file}" "${checksum_file}" <<'PY'
import hashlib
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
checksum = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8").split()[0].lower()
hasher = hashlib.md5()
with source.open("rb") as stream:
    for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
        hasher.update(chunk)
digest = hasher.hexdigest()
if digest != checksum:
    raise SystemExit(f"MD5 mismatch for {source.name}: expected {checksum}, got {digest}")
PY
}

download_source_consistently() {
  local country=$1
  local source_url=$2
  local source_file=$3
  local checksum_file=$4
  local partial_file="${source_file}.part"
  local checksum_before="${checksum_file}.before"
  local checksum_after="${checksum_file}.after"
  local expected_checksum
  local download_url
  local resolved_url
  local attempt

  for ((attempt = 1; attempt <= SOURCE_DOWNLOAD_ATTEMPTS; attempt++)); do
    rm -f "${source_file}" "${partial_file}" "${checksum_file}" "${checksum_before}" "${checksum_after}"
    log "Downloading ${country} source generation (attempt ${attempt}/${SOURCE_DOWNLOAD_ATTEMPTS})."
    if ! resolved_url=$(curl -fLsSI --retry 5 --retry-delay 10 --no-progress-meter \
      -o /dev/null -w '%{url_effective}' "${source_url}"); then
      log "WARNING: Could not resolve a ${country} Geofabrik mirror."
      (( attempt == SOURCE_DOWNLOAD_ATTEMPTS )) || sleep "${SOURCE_RETRY_DELAY_SECONDS}"
      continue
    fi
    [[ "${resolved_url}" == https://* ]] || fail "Resolved ${country} source URL is not HTTPS: ${resolved_url}"
    download_url=${resolved_url}
    log "Using one mirror for ${country} PBF and checksum: ${resolved_url}"
    if ! curl -fL --retry 5 --retry-delay 10 --no-progress-meter \
      -o "${checksum_before}" "${resolved_url}.md5"; then
      log "WARNING: Could not fetch the initial ${country} checksum."
      (( attempt == SOURCE_DOWNLOAD_ATTEMPTS )) || sleep "${SOURCE_RETRY_DELAY_SECONDS}"
      continue
    fi
    expected_checksum=$(awk 'NR == 1 {print $1}' "${checksum_before}")
    if ! curl -fL --retry 5 --retry-delay 15 --no-progress-meter \
      -o "${partial_file}" "${download_url}"; then
      log "WARNING: Could not download the complete ${country} source."
      (( attempt == SOURCE_DOWNLOAD_ATTEMPTS )) || sleep "${SOURCE_RETRY_DELAY_SECONDS}"
      continue
    fi
    if ! curl -fL --retry 5 --retry-delay 10 --no-progress-meter \
      -o "${checksum_after}" "${resolved_url}.md5"; then
      log "WARNING: Could not fetch the final ${country} checksum."
      (( attempt == SOURCE_DOWNLOAD_ATTEMPTS )) || sleep "${SOURCE_RETRY_DELAY_SECONDS}"
      continue
    fi
    if ! verify_source_checksum "${partial_file}" "${checksum_before}"; then
      log "WARNING: Downloaded ${country} source did not match the checksum-keyed generation; retrying from byte zero."
      (( attempt == SOURCE_DOWNLOAD_ATTEMPTS )) || sleep "${SOURCE_RETRY_DELAY_SECONDS}"
      continue
    fi
    if ! cmp -s "${checksum_before}" "${checksum_after}"; then
      log "WARNING: Geofabrik checksum nodes disagree after the ${country} download; accepting content verified against requested generation ${expected_checksum}."
    fi
    mv "${partial_file}" "${source_file}"
    mv "${checksum_before}" "${checksum_file}"
    rm -f "${checksum_after}"
    DOWNLOADED_SOURCE_URL=${resolved_url}
    return 0
  done

  fail "Could not obtain a checksum-valid generation of the ${country} source after ${SOURCE_DOWNLOAD_ATTEMPTS} attempts."
}

download_sources() {
  local spec
  local country
  local source_url
  local source_name
  local source_file
  local checksum_file
  local timestamp
  local sha256
  mkdir -p "${SOURCE_DIR}"
  : >"${WORK_DIR}/sources.manifest"
  for spec in "${SOURCE_SPECS[@]}"; do
    IFS='|' read -r country source_url <<<"${spec}"
    source_name=$(basename "${source_url}")
    source_file="${SOURCE_DIR}/${source_name}"
    checksum_file="${source_file}.md5"
    download_source_consistently "${country}" "${source_url}" "${source_file}" "${checksum_file}"
    timestamp=$(docker run --rm -v "${SOURCE_DIR}:/sources:ro" "${OSM_TOOLS_IMAGE}" \
      osmium fileinfo -g header.option.osmosis_replication_timestamp "/sources/${source_name}")
    sha256=$(sha256sum "${source_file}" | awk '{print $1}')
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${country}" "${source_url}" "${DOWNLOADED_SOURCE_URL}" "${timestamp}" "${sha256}" "$(stat -c %s "${source_file}")" \
      >>"${WORK_DIR}/sources.manifest"
  done
}

prepare_tools_image() {
  if ! docker image inspect "${OSM_TOOLS_IMAGE}" >/dev/null 2>&1; then
    log "Building local OSM utility image."
    docker build -t "${OSM_TOOLS_IMAGE}" -f "${TOOLS_DIR}/Dockerfile.osm-tools" "${TOOLS_DIR}"
  fi
}

prepare_release_layout() {
  local current
  current=$(current_release_dir)
  [[ -f "${current}/valhalla.json" ]] || fail "Current release has no valhalla.json."
  [[ -f "${current}/timezones.sqlite" ]] || fail "Current release has no timezones.sqlite."
  [[ -d "${current}/elevation_data" ]] || fail "Current release has no elevation_data."
  [[ ! -e "${RELEASE_DIR}" ]] || fail "Release already exists: ${RELEASE_ID}"
  mkdir -p "${WORK_DIR}" "${STAGE_DIR}"
  cp "${current}/valhalla.json" "${STAGE_DIR}/valhalla.json"
  cp "${current}/timezones.sqlite" "${STAGE_DIR}/timezones.sqlite"
  [[ ! -f "${current}/default_speeds.json" ]] || cp "${current}/default_speeds.json" "${STAGE_DIR}/default_speeds.json"
  cp -al "${current}/elevation_data" "${STAGE_DIR}/elevation_data"
}

check_capacity() {
  local free_gb
  free_gb=$(df -Pk "${BASE_DIR}" | awk 'NR == 2 {print int($4 / 1024 / 1024)}')
  (( free_gb >= MIN_FREE_GB )) || fail "Only ${free_gb} GB is free; at least ${MIN_FREE_GB} GB is required."
}

merge_and_deduplicate_sources() {
  log "Merging source extracts as history to retain overlapping versions."
  docker run --rm --cpus "${BUILD_CPUS}" --memory "${BUILD_MEMORY}" --memory-swap "${BUILD_MEMORY_SWAP}" \
    -v "${WORK_DIR}:/work" "${OSM_TOOLS_IMAGE}" \
    sh -lc 'osmium merge --with-history --overwrite /work/sources/*.osm.pbf -o /work/neighbours-history.osm.pbf'
  log "Selecting the newest version of every overlapping OSM object."
  docker run --rm --cpus "${BUILD_CPUS}" --memory "${BUILD_MEMORY}" --memory-swap "${BUILD_MEMORY_SWAP}" \
    -v "${WORK_DIR}:/work" "${OSM_TOOLS_IMAGE}" \
    osmium time-filter --overwrite /work/neighbours-history.osm.pbf 2100-01-01T00:00:00Z -o /work/neighbours-latest.osm.pbf
  docker run --rm -v "${WORK_DIR}:/work:ro" "${OSM_TOOLS_IMAGE}" \
    osmium fileinfo -e /work/neighbours-latest.osm.pbf >"${WORK_DIR}/merged-fileinfo.txt"
  grep -Eq 'Multiple versions of same object:[[:space:]]+no' "${WORK_DIR}/merged-fileinfo.txt" \
    || fail "Merged OSM file still contains multiple object versions."
  remove_tree "${WORK_DIR}/neighbours-history.osm.pbf"
}

build_admin_database() {
  log "Building administrative database from deduplicated full-country sources."
  docker run --rm --cpus "${BUILD_CPUS}" --memory "${BUILD_MEMORY}" --memory-swap "${BUILD_MEMORY_SWAP}" \
    -v "${WORK_DIR}:/work:ro" -v "${STAGE_DIR}:/custom_files" \
    --entrypoint valhalla_build_admins "${VALHALLA_IMAGE}" \
    -c /custom_files/valhalla.json /work/neighbours-latest.osm.pbf
  docker run --rm -v "${STAGE_DIR}:/custom_files:ro" -v "${TOOLS_DIR}:/tools:ro" "${OSM_TOOLS_IMAGE}" \
    python3 /tools/validate-admins.py /custom_files/admins.sqlite --min-areas 60
}

build_buffer_extract() {
  log "Downloading Czech boundary and creating ${BUFFER_METERS} m buffer."
  curl -fL --retry 5 --retry-delay 10 --no-progress-meter \
    -o "${WORK_DIR}/czech-republic.poly" "https://download.geofabrik.de/europe/czech-republic.poly"
  docker run --rm -v "${WORK_DIR}:/work" -v "${TOOLS_DIR}:/tools:ro" "${OSM_TOOLS_IMAGE}" \
    python3 /tools/make-buffer.py /work/czech-republic.poly /work/czech-75km.geojson "${BUFFER_METERS}"
  log "Extracting the exact buffered routing area."
  docker run --rm --cpus "${BUILD_CPUS}" --memory "${BUILD_MEMORY}" --memory-swap "${BUILD_MEMORY_SWAP}" \
    -v "${WORK_DIR}:/work" "${OSM_TOOLS_IMAGE}" \
    osmium extract --overwrite --strategy=complete_ways --polygon=/work/czech-75km.geojson \
    /work/neighbours-latest.osm.pbf -o /work/czech-75km.osm.pbf
  docker run --rm -v "${WORK_DIR}:/work:ro" "${OSM_TOOLS_IMAGE}" \
    osmium fileinfo -e /work/czech-75km.osm.pbf >"${WORK_DIR}/extract-fileinfo.txt"
  grep -Eq 'Multiple versions of same object:[[:space:]]+no' "${WORK_DIR}/extract-fileinfo.txt" \
    || fail "Buffered OSM extract contains multiple object versions."
  mv "${WORK_DIR}/czech-75km.osm.pbf" "${STAGE_DIR}/czech-75km.osm.pbf"
}

prepare_elevation() {
  local bbox
  bbox=$(python3 "${TOOLS_DIR}/geojson-bbox.py" "${WORK_DIR}/czech-75km.geojson")
  log "Ensuring elevation tiles cover buffered bbox ${bbox}."
  docker run --rm --cpus "${DOWNLOAD_CPUS}" --memory 1g --memory-swap 2g \
    -v "${STAGE_DIR}:/custom_files" --entrypoint valhalla_build_elevation "${VALHALLA_IMAGE}" \
    --from-bbox "${bbox}" --outdir /custom_files/elevation_data --parallelism "${DOWNLOAD_CPUS}" --verbosity
}

build_tiles() {
  local graph_tile_count
  log "Building complete Valhalla tile pipeline."
  docker run --rm --name valhalla-update-build --cpus "${BUILD_CPUS}" \
    --memory "${BUILD_MEMORY}" --memory-swap "${BUILD_MEMORY_SWAP}" \
    -v "${STAGE_DIR}:/custom_files" --entrypoint valhalla_build_tiles "${VALHALLA_IMAGE}" \
    -c /custom_files/valhalla.json -j "${BUILD_CPUS}" /custom_files/czech-75km.osm.pbf
  graph_tile_count=$(find "${STAGE_DIR}/valhalla_tiles" -type f -name '*.gph' | wc -l)
  (( graph_tile_count >= MIN_GRAPH_TILE_FILES )) \
    || fail "Only ${graph_tile_count} graph tile files were created; at least ${MIN_GRAPH_TILE_FILES} required."
  log "Built ${graph_tile_count} graph tile files."
  log "Building Valhalla tile archive."
  docker run --rm --cpus "${BUILD_CPUS}" --memory "${BUILD_MEMORY}" --memory-swap "${BUILD_MEMORY_SWAP}" \
    -v "${STAGE_DIR}:/custom_files" --entrypoint valhalla_build_extract "${VALHALLA_IMAGE}" \
    -c /custom_files/valhalla.json -O -v
  [[ -s "${STAGE_DIR}/valhalla_tiles.tar" ]] || fail "Tile archive was not created."
}

write_release_manifest() {
  local buffer_bbox
  buffer_bbox=$(python3 "${TOOLS_DIR}/geojson-bbox.py" "${WORK_DIR}/czech-75km.geojson")
  cp "${WORK_DIR}/sources.manifest" "${STAGE_DIR}/sources.manifest"
  {
    printf 'RELEASE_ID=%s\n' "${RELEASE_ID}"
    printf 'BUILT_AT=%s\n' "$(date -u +%FT%TZ)"
    printf 'BUFFER_METERS=%s\n' "${BUFFER_METERS}"
    printf 'BUFFER_BBOX=%s\n' "${buffer_bbox}"
    printf 'SOURCE_COUNTRIES=CZ,DE,PL,SK,AT,HU\n'
    printf 'VALHALLA_IMAGE=%s\n' "${VALHALLA_IMAGE}"
    printf 'VALIDATION_PROFILE=full\n'
    printf 'CONFIG_SHA256=%s\n' "$(sha256sum "${STAGE_DIR}/valhalla.json" | awk '{print $1}')"
    printf 'ADMINS_SHA256=%s\n' "$(sha256sum "${STAGE_DIR}/admins.sqlite" | awk '{print $1}')"
    printf 'TILE_ARCHIVE_SHA256=%s\n' "$(sha256sum "${STAGE_DIR}/valhalla_tiles.tar" | awk '{print $1}')"
  } >"${STAGE_DIR}/release.env"
}

validate_candidate() {
  local base_url="http://127.0.0.1:${CANDIDATE_PORT}"
  log "Starting isolated candidate release ${RELEASE_ID}."
  docker run -d --name valhalla-update-candidate --cpus 2 --memory 2g --memory-swap 3g \
    -p "127.0.0.1:${CANDIDATE_PORT}:8002" \
    -v "${STAGE_DIR}:/custom_files:ro" --entrypoint valhalla_service "${VALHALLA_IMAGE}" \
    /custom_files/valhalla.json 2 >/dev/null
  validate_full "${base_url}" || fail "Candidate release failed the full validation matrix."
  docker rm -f valhalla-update-candidate >/dev/null
  touch "${RELEASE_DIR}/.complete"
  printf 'VALIDATED_AT=%s\n' "$(date -u +%FT%TZ)" >"${RELEASE_DIR}/validation.env"
  remove_tree "${STAGE_DIR}/czech-75km.osm.pbf"
}

switch_current() {
  local target=$1
  local next_link="${CURRENT_LINK}.next.$$"
  ln -s "${target}" "${next_link}"
  mv -Tf "${next_link}" "${CURRENT_LINK}"
}

write_transaction() {
  local previous=$1
  local next=$2
  local tmp="${TRANSACTION_FILE}.tmp.$$"
  {
    printf 'RELEASE_ID=%s\n' "${RELEASE_ID}"
    printf 'PREVIOUS_TARGET=%s\n' "${previous}"
    printf 'NEW_TARGET=%s\n' "${next}"
    printf 'CREATED_AT=%s\n' "$(date -u +%FT%TZ)"
  } >"${tmp}"
  mv -f "${tmp}" "${TRANSACTION_FILE}"
  sync "${TRANSACTION_FILE}" 2>/dev/null || true
}

load_transaction() {
  PREVIOUS_TARGET=
  NEW_TARGET=
  while IFS='=' read -r key value; do
    case "${key}" in
      PREVIOUS_TARGET) PREVIOUS_TARGET=${value} ;;
      NEW_TARGET) NEW_TARGET=${value} ;;
    esac
  done <"${TRANSACTION_FILE}"
  [[ -n "${PREVIOUS_TARGET}" && -n "${NEW_TARGET}" ]]
}

recreate_production() {
  docker compose -f "${COMPOSE_FILE}" up -d --force-recreate --no-deps valhalla >/dev/null
}

validate_release_profile() {
  local target=$1
  local base_url=$2
  if grep -qx 'VALIDATION_PROFILE=full' "${target}/release.env" 2>/dev/null; then
    validate_full "${base_url}"
  else
    validate_basic "${base_url}"
  fi
}

rollback_to() {
  local previous=$1
  local base_url=$2
  log "Rolling production back to ${previous}."
  set +e
  docker compose -f "${COMPOSE_FILE}" stop valhalla >/dev/null 2>&1
  switch_current "${previous}"
  local switch_status=$?
  local restart_status=1
  if (( switch_status == 0 )); then
    recreate_production
    restart_status=$?
  fi
  set -e
  (( switch_status == 0 )) || fail "Rollback could not restore the previous release link. Manual recovery is required."
  (( restart_status == 0 )) || fail "Rollback could not restart Valhalla. Manual recovery is required."
  validate_release_profile "${previous}" "${base_url}" || fail "Rollback target restarted but failed validation. Manual recovery is required."
  rm -f "${TRANSACTION_FILE}"
}

activate_release() {
  local previous
  local base_url
  local bind_address
  local port
  [[ -f "${RELEASE_DIR}/.complete" ]] || fail "Release is not sealed as complete: ${RELEASE_ID}"
  previous=$(current_release_dir)
  bind_address=$(sed -n 's/^VALHALLA_BIND_ADDRESS=//p' "${BASE_DIR}/.env")
  port=$(sed -n 's/^VALHALLA_PORT=//p' "${BASE_DIR}/.env")
  base_url="http://${bind_address:-127.0.0.1}:${port:-8002}"
  write_transaction "${previous}" "${STAGE_DIR}"
  ACTIVATION_PREVIOUS_TARGET=${previous}
  ACTIVATION_BASE_URL=${base_url}
  CURRENT_PHASE=activating
  write_state running "Switching current release."
  docker compose -f "${COMPOSE_FILE}" stop valhalla >/dev/null || fail "Could not stop production Valhalla before activation."
  switch_current "${STAGE_DIR}" || {
    recreate_production >/dev/null 2>&1 || true
    fail "Could not atomically switch the current release link."
  }
  ACTIVATION_SWITCHED=1
  if ! recreate_production; then
    rollback_to "${previous}" "${base_url}"
    fail "New production release could not start; previous release restored."
  fi
  if ! validate_full "${base_url}"; then
    rollback_to "${previous}" "${base_url}"
    fail "New production release failed validation; previous release restored."
  fi
  rm -f "${TRANSACTION_FILE}"
  ACTIVATION_SWITCHED=0
  {
    printf 'RELEASE_ID=%s\n' "${RELEASE_ID}"
    printf 'TARGET=%s\n' "${STAGE_DIR}"
    printf 'PREVIOUS_TARGET=%s\n' "${previous}"
    printf 'ACTIVATED_AT=%s\n' "$(date -u +%FT%TZ)"
  } >"${STATE_DIR}/active.env.tmp"
  mv -f "${STATE_DIR}/active.env.tmp" "${STATE_DIR}/active.env"
  cp "${STATE_DIR}/active.env" "${STATE_DIR}/last-success.env"
  log "Release ${RELEASE_ID} is active and fully validated."
}

recover_transaction() {
  local bind_address
  local port
  local base_url
  [[ -f "${TRANSACTION_FILE}" ]] || {
    log "No incomplete activation transaction exists."
    return 0
  }
  load_transaction || fail "Activation transaction is unreadable."
  bind_address=$(sed -n 's/^VALHALLA_BIND_ADDRESS=//p' "${BASE_DIR}/.env")
  port=$(sed -n 's/^VALHALLA_PORT=//p' "${BASE_DIR}/.env")
  base_url="http://${bind_address:-127.0.0.1}:${port:-8002}"
  log "Recovering interrupted activation by restoring ${PREVIOUS_TARGET}."
  rollback_to "${PREVIOUS_TARGET}" "${base_url}"
}

prune_releases() {
  local active
  local -a releases
  local index
  active=$(current_release_dir)
  mapfile -t releases < <(find "${RELEASE_ROOT}" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk '{print $2}')
  for ((index = RETAIN_RELEASES; index < ${#releases[@]}; index++)); do
    [[ "${releases[index]}/custom_files" == "${active}" ]] && continue
    log "Pruning old release ${releases[index]}."
    remove_tree "${releases[index]}" || log "WARNING: Could not prune ${releases[index]}."
  done
}

build_release() {
  CURRENT_PHASE=preparing
  write_state running "Preparing build."
  check_capacity
  prepare_tools_image
  prepare_release_layout
  CURRENT_PHASE=downloading
  write_state running "Downloading sources."
  download_sources
  CURRENT_PHASE=merging
  write_state running "Merging and deduplicating sources."
  merge_and_deduplicate_sources
  CURRENT_PHASE=admins
  write_state running "Building administrative database."
  build_admin_database
  CURRENT_PHASE=extracting
  write_state running "Building buffered extract."
  build_buffer_extract
  CURRENT_PHASE=elevation
  write_state running "Completing elevation coverage."
  prepare_elevation
  CURRENT_PHASE=tiles
  write_state running "Building graph tiles."
  build_tiles
  write_release_manifest
  CURRENT_PHASE=validating_candidate
  write_state running "Validating isolated candidate."
  validate_candidate
  remove_tree "${WORK_DIR}"
  CURRENT_PHASE=candidate_ready
  write_state candidate_ready "Candidate is sealed and ready for activation."
}

show_status() {
  echo "current=$(readlink -f "${CURRENT_LINK}" 2>/dev/null || true)"
  [[ ! -f "${STATE_FILE}" ]] || cat "${STATE_FILE}"
  [[ ! -f "${STATE_DIR}/active.env" ]] || cat "${STATE_DIR}/active.env"
  docker compose -f "${COMPOSE_FILE}" ps valhalla
}

mkdir -p "${BASE_DIR}" "${RELEASE_ROOT}" "${WORK_ROOT}" "${STATE_DIR}"
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  log "Another Valhalla update process holds ${LOCK_FILE}; leaving it untouched."
  exit 75
fi

trap cleanup_containers EXIT
trap 'unexpected_failure ${LINENO}' ERR
require_commands
if [[ "${MODE}" != "status" ]]; then
  recover_transaction
fi

case "${MODE}" in
  recover)
    CURRENT_PHASE=recovered
    write_state recovered "No incomplete activation remains."
    ;;
  status)
    show_status
    ;;
  build)
    build_release
    log "Candidate ${RELEASE_ID} is ready at ${STAGE_DIR}; run '$0 activate ${RELEASE_ID}' after review."
    ;;
  activate)
    activate_release
    CURRENT_PHASE=complete
    write_state success "Release activated and validated."
    prune_releases
    ;;
  run)
    build_release
    activate_release
    CURRENT_PHASE=complete
    write_state success "Weekly build, activation, and validation completed."
    prune_releases
    ;;
esac
