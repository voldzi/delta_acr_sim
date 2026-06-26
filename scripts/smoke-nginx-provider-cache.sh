#!/usr/bin/env bash
# Verifies nginx stale-cache behavior for internal provider gateway routes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NET="sim-provider-cache-smoke-net-$$"
GW="sim-provider-cache-smoke-gateway-$$"
BE="sim-provider-cache-smoke-backend-$$"
BAD="sim-provider-cache-smoke-bad-backend-$$"
PORT="${SIM_PROVIDER_CACHE_SMOKE_PORT:-18093}"
FIRST_HEADERS="$(mktemp)"
SECOND_HEADERS="$(mktemp)"
STALE_HEADERS="$(mktemp)"
BODY="$(mktemp)"

cleanup() {
  rm -f "$FIRST_HEADERS" "$SECOND_HEADERS" "$STALE_HEADERS" "$BODY"
  docker rm -f "$GW" "$BE" "$BAD" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

require_header() {
  local file="$1"
  local pattern="$2"
  if ! grep -Eiq "$pattern" "$file"; then
    echo "Missing expected header pattern: $pattern" >&2
    echo "--- headers ---" >&2
    cat "$file" >&2
    exit 1
  fi
}

docker network create "$NET" >/dev/null

docker run -d \
  --name "$BE" \
  --network "$NET" \
  --network-alias flight-data-api \
  nginx:1.29-alpine \
  sh -c 'printf "%s\n" "server { listen 4010; location /api/ { default_type application/json; add_header Cache-Control \"public, max-age=86400\" always; return 200 \"{\\\"ok\\\":true,\\\"seq\\\":1}\"; } }" > /etc/nginx/conf.d/default.conf && nginx -g "daemon off;"' \
  >/dev/null

docker run -d \
  --name "$GW" \
  --network "$NET" \
  -p "127.0.0.1:$PORT:80" \
  --entrypoint sh \
  nginx:1.29-alpine \
  -c 'sleep 1000' \
  >/dev/null

docker exec "$GW" mkdir -p /etc/nginx/includes /var/cache/nginx
docker cp "$ROOT/apps/simulator-web/nginx/default.conf" "$GW":/etc/nginx/conf.d/default.conf
docker cp "$ROOT/apps/simulator-web/nginx/internal-provider-access.conf" "$GW":/etc/nginx/includes/internal-provider-access.conf
docker cp "$ROOT/apps/simulator-web/nginx/security-headers.conf" "$GW":/etc/nginx/includes/security-headers.conf
docker cp "$ROOT/apps/simulator-web/nginx/provider-cache.conf" "$GW":/etc/nginx/includes/provider-cache.conf
docker exec "$GW" nginx -t >/dev/null
docker exec -d "$GW" nginx -g 'daemon off;'

sleep 1

curl -fsS -D "$FIRST_HEADERS" -o "$BODY" "http://127.0.0.1:$PORT/flight-data/api/v1/cache-smoke"
require_header "$FIRST_HEADERS" '^X-SIM-Gateway-Cache: MISS[[:space:]]*$'
require_header "$FIRST_HEADERS" '^Cache-Control: private, max-age=10[[:space:]]*$'
require_header "$FIRST_HEADERS" '^X-Content-Type-Options: nosniff[[:space:]]*$'

curl -fsS -D "$SECOND_HEADERS" -o "$BODY" "http://127.0.0.1:$PORT/flight-data/api/v1/cache-smoke"
require_header "$SECOND_HEADERS" '^X-SIM-Gateway-Cache: HIT[[:space:]]*$'

docker rm -f "$BE" >/dev/null
docker run -d \
  --name "$BAD" \
  --network "$NET" \
  --network-alias flight-data-api \
  nginx:1.29-alpine \
  sh -c 'printf "%s\n" "server { listen 4999; }" > /etc/nginx/conf.d/default.conf && nginx -g "daemon off;"' \
  >/dev/null

sleep 11

curl -fsS -D "$STALE_HEADERS" -o "$BODY" "http://127.0.0.1:$PORT/flight-data/api/v1/cache-smoke"
require_header "$STALE_HEADERS" '^X-SIM-Gateway-Cache: STALE[[:space:]]*$'

echo "Provider gateway cache smoke passed."
