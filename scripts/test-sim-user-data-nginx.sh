#!/usr/bin/env bash
# Isolated existing-image Nginx; no network creation, host port or production.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image='sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de'
docker image inspect "$image" >/dev/null
docker run --rm --network none --entrypoint sh \
  -v "$root/apps/simulator-web/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro" \
  -v "$root/apps/simulator-web/nginx:/etc/nginx/includes:ro" "$image" -eu -c '
nginx -t
nginx
for path in \
 /api/v1/internal/sim-user-data/v1/capabilities \
 /api/v1/internal/sim-user-data/v1/deletions \
 /situation-data/api/v1/internal/sim-user-data/v1/capabilities \
 /api/v1/ai-router/internal/sim-user-history/v1/capabilities; do
 result=$(wget -S -O /dev/null "http://127.0.0.1$path" 2>&1 || true)
 echo "$result" | head -n 2 | grep -q "404 Not Found"
done
printf "%s\n" "{\"actualNginxDenyChecks\":4,\"network\":\"none\",\"publicPorts\":0,\"productionWrites\":0}"
'
