import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const fixture = JSON.parse(await readFile(new URL('../apps/situation-data-api/test/user-selected-arrival-v1.fixture.json', import.meta.url)));
for (const warning of [false, true]) test(`actual loopback RoutingService (${warning ? 'warning401' : 'accepted'})`, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./arrival-candidate-loopback.mjs', import.meta.url)), ...(warning ? ['--warning401'] : [])],
    { env: { PATH: process.env.PATH ?? '', SIM_SENTINEL_NOT_FOR_CHILD: 'not-a-secret' }, stdio: ['ignore','pipe','pipe'] });
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(Error('STARTUP_DEADLINE')), 10000);
      child.on('exit', () => { clearTimeout(timer); reject(Error('CHILD_EXITED')); });
      child.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) {
        clearTimeout(timer); const result = JSON.parse(text.split('\n')[0]);
        assert.equal(result.productionConfigLoaded, false); assert.equal(result.implementation, 'RoutingService.alternatives');
        assert.match(result.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/routing\/alternatives$/);
        resolve(result.endpoint);
      } });
    });
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fixture.request) });
    const data = await response.json();
    if (warning) { assert.equal(response.status, 422); assert.equal(data.error.code, 'ROUTING_RESTRICTIONS_RELAXATION_REQUIRED'); assert.equal(data.routes, undefined); }
    else {
      assert.equal(response.status, 200); assert.equal(data.routes.length, 2);
      for (const route of data.routes) {
        assert.equal(route.steps.length, 2); assert.equal(route.arrival.remainingAccess, 'unverified');
        assert.deepEqual(data.features.find(f => f.id === route.routeId).properties.arrival, route.arrival);
      }
      const missing = await fetch(endpoint.replace('/alternatives','/route'), { method: 'POST' }); assert.equal(missing.status, 404);
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
});
