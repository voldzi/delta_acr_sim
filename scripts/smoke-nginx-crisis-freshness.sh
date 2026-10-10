#!/usr/bin/env bash
# Exercises the real gateway, without published ports or real provider data.
# A remote Docker daemon must use an explicitly supplied existing test network.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUFFIX="$(date -u +%Y%m%dT%H%M%SZ)-$$"
GW="sim-crisis-smoke-gateway-$SUFFIX"
BE="sim-crisis-smoke-backend-$SUFFIX"
NET="${SIM_CRISIS_SMOKE_EXISTING_NETWORK:-sim-crisis-smoke-net-$SUFFIX}"
NGINX_IMAGE="${SIM_CRISIS_SMOKE_NGINX_IMAGE:-nginx:1.29-alpine}"
NODE_IMAGE="${SIM_CRISIS_SMOKE_NODE_IMAGE:-node:24.20.0-alpine}"
WORK="$(mktemp -d)"
CREATED_NETWORK=false
CREATED_GATEWAY=false
CREATED_BACKEND=false

cleanup() {
  if [ "$CREATED_GATEWAY" = true ]; then docker rm -f "$GW" >/dev/null 2>&1 || true; fi
  if [ "$CREATED_BACKEND" = true ]; then docker rm -f "$BE" >/dev/null 2>&1 || true; fi
  if [ "$CREATED_NETWORK" = true ]; then docker network rm "$NET" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

DOCKER_ENDPOINT="${DOCKER_HOST:-$(docker context inspect --format '{{ .Endpoints.docker.Host }}')}"
if [ -z "${SIM_CRISIS_SMOKE_EXISTING_NETWORK:-}" ]; then
  case "$DOCKER_ENDPOINT" in
    unix://*) ;;
    *) echo "Remote Docker requires SIM_CRISIS_SMOKE_EXISTING_NETWORK; no changes made." >&2; exit 1 ;;
  esac
else
  docker network inspect "$NET" >/dev/null
fi
docker version --format 'Docker server: {{.Server.Version}}'
docker image inspect "$NGINX_IMAGE" >/dev/null
docker image inspect "$NODE_IMAGE" >/dev/null

# Unique container DNS names replace only the two upstream names in the fixture.
# This never creates aliases that could collide with live Compose services.
sed -e "s/flight-data-api:4010/$BE:4010/g" \
    -e "s/safety-data-api:4030/$BE:4030/g" \
    "$ROOT/apps/simulator-web/nginx/default.conf" > "$WORK/default.conf"

cat > "$WORK/backend.mjs" <<'JS'
import http from 'node:http';
let sequence = 0;
let unavailable = false;
const handler = (request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid');
  if (url.pathname === '/__smoke/fail') {
    unavailable = true;
    response.end('disabled');
    return;
  }
  response.writeHead(unavailable ? 503 : 200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=86400',
    Expires: new Date(Date.now() + 86400000).toUTCString(),
  });
  response.end(JSON.stringify({
    sequence: ++sequence,
    generatedAt: new Date().toISOString(),
    path: url.pathname,
    query: url.search.slice(1),
    status: unavailable ? 'unavailable' : 'ready',
  }));
};
http.createServer(handler).listen(4030, '0.0.0.0');
http.createServer(handler).listen(4010, '0.0.0.0');
JS

if [ -z "${SIM_CRISIS_SMOKE_EXISTING_NETWORK:-}" ]; then
  docker network create "$NET" >/dev/null
  CREATED_NETWORK=true
fi
docker run -d --name "$BE" --network "$NET" --memory 96m --cpus 0.5 \
  --entrypoint sh "$NODE_IMAGE" -c 'sleep 600' >/dev/null
CREATED_BACKEND=true
docker cp "$WORK/backend.mjs" "$BE":/tmp/backend.mjs
docker exec -d "$BE" node /tmp/backend.mjs

docker run -d --name "$GW" --network "$NET" --memory 96m --cpus 0.5 \
  --entrypoint sh "$NGINX_IMAGE" -c 'sleep 600' >/dev/null
CREATED_GATEWAY=true
docker exec "$GW" mkdir -p /etc/nginx/includes /var/cache/nginx
docker cp "$WORK/default.conf" "$GW":/etc/nginx/conf.d/default.conf
for name in internal-provider-access security-headers provider-cache; do
  docker cp "$ROOT/apps/simulator-web/nginx/$name.conf" "$GW":/etc/nginx/includes/"$name.conf"
done
docker exec "$GW" nginx -t
docker exec -d "$GW" nginx -g 'daemon off;'

docker exec -i -e SMOKE_GATEWAY="$GW" "$BE" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
const gateway = `http://${process.env.SMOKE_GATEWAY}`;
const urls = [
  '/safety-data/api/v1/notifications/candidates?source=hzs_incidents&bbox=15.05,49.45,16.95,50.85&limit=100',
  '/safety-data/api/v1/context/news?feeds=ct24-main&limit=3',
];
const call = async (path, options) => {
  const response = await fetch(`${gateway}${path}`, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  return { response, text, body };
};
for (let attempt = 0; ; attempt++) {
  try { await fetch(`${gateway}/favicon.svg`); break; }
  catch (error) { if (attempt >= 29) throw error; await delay(200); }
}
const requireFreshHeaders = ({ response }) => {
  assert.match(response.headers.get('cache-control') ?? '', /(?:^|,\s*)no-store(?:,|$)/i);
  assert.doesNotMatch(response.headers.get('cache-control') ?? '', /max-age=(?:10|86400)(?:,|$)/i);
  assert.match(response.headers.get('x-sim-gateway-cache') ?? '', /^(?:BYPASS|DISABLED)$/);
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('expires'), null);
};
for (const path of urls) {
  const first = await call(path);
  await delay(30);
  const second = await call(path);
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  requireFreshHeaders(first);
  requireFreshHeaders(second);
  assert.ok(second.body.sequence > first.body.sequence, 'second request must reach the backend');
  assert.notEqual(second.body.generatedAt, first.body.generatedAt);
  const original = new URL(path, gateway);
  assert.equal(second.body.path, original.pathname.replace(/^\/safety-data/, ''));
  assert.equal(second.body.query, original.search.slice(1), 'query must survive the exact location rewrite');
  const denied = await call(path, { headers: { 'X-Forwarded-For': '203.0.113.81' } });
  assert.equal(denied.response.status, 403, 'public forwarded IP must remain forbidden');
  assert.equal(denied.body, null, 'forbidden response must not contain provider JSON');
}
const flightPath = '/flight-data/api/v1/cache-smoke';
const miss = await call(flightPath);
const hit = await call(flightPath);
assert.equal(miss.response.status, 200);
assert.equal(miss.response.headers.get('x-sim-gateway-cache'), 'MISS');
assert.equal(hit.response.headers.get('x-sim-gateway-cache'), 'HIT');
assert.equal(hit.body.sequence, miss.body.sequence);
assert.equal(hit.response.headers.get('cache-control'), 'private, max-age=10');
await fetch('http://127.0.0.1:4030/__smoke/fail');
for (const path of urls) {
  const unavailable = await call(path);
  assert.equal(unavailable.response.status, 503, 'backend failure must not reuse an earlier ready response');
  assert.equal(unavailable.body.status, 'unavailable');
  requireFreshHeaders(unavailable);
}
await delay(11000);
const stale = await call(flightPath);
assert.equal(stale.response.status, 200);
assert.equal(stale.response.headers.get('x-sim-gateway-cache'), 'STALE');
assert.equal(stale.body.sequence, miss.body.sequence, 'ordinary provider stale fallback must remain unchanged');
console.log(JSON.stringify({
  crisisRoutes: urls.length,
  noStore: true,
  pragmaNoCache: true,
  generatedAtRecomputed: true,
  queryForwarding: true,
  publicForwardedRequests: '403',
  upstreamFailure: '503, no prior 200 replay',
  flightProviderCache: ['MISS', 'HIT', 'STALE'],
  hostPortsPublished: false,
  fixtureDataOnly: true,
}));
JS

echo "Crisis gateway freshness smoke passed; isolated fixtures removed on exit."
