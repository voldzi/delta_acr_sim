#!/usr/bin/env node
// Synthetic integration harness only. Never deploy or import in an application.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (!process.argv.includes('--isolated-child')) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--isolated-child',
    ...(process.argv.includes('--warning401') ? ['--warning401'] : [])], {
    env: { PATH: process.env.PATH ?? '', LANG: 'C.UTF-8' }, stdio: 'inherit'
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
  child.on('exit', code => process.exit(code ?? 1));
} else {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createServer } = await import('node:http');
  const { randomUUID } = await import('node:crypto');
  const root = new URL('../', import.meta.url);
  const directory = await mkdtemp(join(tmpdir(), 'sim-arrival-candidate-'));
  process.env.SITUATION_DATA_DIR = directory;
  process.env.SITUATION_DATA_ENABLED_SOURCES = '';
  const { loadConfig } = await import(new URL('apps/situation-data-api/dist/config.js', root));
  const { RoutingService, encodeValhallaPolyline6 } = await import(new URL('apps/situation-data-api/dist/routing-service.js', root));
  const { canonicalRoutingHash } = await import(new URL('apps/situation-data-api/dist/routing-safety.js', root));
  const timestamp = Math.floor(Date.now() / 1000) - 3600;
  const dataset = { version: `sim-routing-${new Date(timestamp * 1000).toISOString().slice(0, 10)}-${timestamp}`,
    builtAt: new Date(timestamp * 1000).toISOString() };
  const observedAt = new Date().toISOString(), validUntil = new Date(Date.now() + 300000).toISOString();
  const closure = { id: 'synthetic-bridge-not-real', polygon: [[14.49,50.09],[14.51,50.09],[14.51,50.11],[14.49,50.11],[14.49,50.09]],
    validFrom: observedAt, validUntil, sourceDirection: 'both', enforcedDirection: 'both', enforcementReason: 'source_both_direction' };
  const snapshot = { revision: canonicalRoutingHash({ fixture: 'synthetic_contract_not_live_route', dataset, closure }),
    observedAt, validUntil, routingDataset: dataset, closures: [closure] };
  let engineRequests = 0;
  globalThis.fetch = async (url, options) => {
    const u = new URL(url);
    if (u.origin !== 'http://synthetic.valhalla') throw Error('HARNESS_EXTERNAL_NETWORK_BLOCKED');
    if (u.pathname === '/status') return Response.json({ version: '3.8.3', tileset_last_modified: timestamp });
    if (u.pathname === '/trace_attributes') return Response.json({ edges: [], matched_points: [], shape: JSON.parse(options.body).encoded_polyline });
    if (u.pathname !== '/route') throw Error('HARNESS_UNKNOWN_ENGINE_OPERATION');
    engineRequests++;
    const p = JSON.parse(options.body);
    if (p.locations.length !== 2 || p.costing !== 'auto') throw Error('HARNESS_UNSUPPORTED_ENGINE_REQUEST');
    const from = p.locations[0], to = p.locations[1];
    const trip = delta => ({ status: 0, summary: { length: .177, time: 49 },
      ...(process.argv.includes('--warning401') ? { warnings: [{ code: 401 }] } : {}),
      legs: [{ summary: { length: .177, time: 49 }, shape: encodeValhallaPolyline6([
        [from.lon, from.lat], [(from.lon+to.lon)/2+delta, (from.lat+to.lat)/2], [to.lon,to.lat]]),
        maneuvers: [{ type: 1, instruction: 'Synthetic start', begin_shape_index: 0, end_shape_index: 1, length: .1, time: 25 },
          { type: 4, instruction: 'Synthetic road endpoint, not POI arrival', begin_shape_index: 1, end_shape_index: 2, length: .077, time: 24 }] }] });
    return Response.json({ trip: trip(0), alternates: p.alternates > 0 ? [{ trip: trip(.0001) }] : [] });
  };
  const config = { ...await loadConfig(), enabledSources: [], valhallaBaseUrl: 'http://synthetic.valhalla',
    routingEngine: 'valhalla', valhallaTrafficEnabled: false, osmPostgisConnectionString: undefined };
  const service = new RoutingService(config, undefined, undefined, { enabled: true,
    acceptedEngineVersions: ['3.8.3'], loadSnapshot: async current => {
      if (canonicalRoutingHash(current) !== canonicalRoutingHash(dataset) || Date.now() >= Date.parse(validUntil)) throw Error('HARNESS_SNAPSHOT_EXPIRED');
      return structuredClone(snapshot);
    } });
  let calls = 0;
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-SIM-Fixture', 'synthetic_contract_not_live_route');
    if (req.method !== 'POST' || req.url !== '/api/v1/routing/alternatives') { res.writeHead(404).end('{}'); return; }
    if (++calls > 64) { res.writeHead(429).end('{}'); return; }
    try {
      let text = '';
      for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 65536) throw Error('BODY_LIMIT'); }
      let raw; try { raw = JSON.parse(text); } catch { res.writeHead(400).end(JSON.stringify({ error: { code: 'VALIDATION_ERROR', correlationId: randomUUID() } })); return; }
      const result = await service.alternatives(raw);
      res.writeHead(200).end(JSON.stringify(result));
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      res.writeHead(status).end(JSON.stringify({ error: { code: error.code ?? 'HARNESS_FAILURE', correlationId: randomUUID(),
        message: 'Synthetic candidate request rejected; no production data.' } }));
    }
  });
  server.requestTimeout = 15000;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  console.log(JSON.stringify({ fixtureKind: 'synthetic_contract_not_live_route',
    endpoint: `http://127.0.0.1:${server.address().port}/api/v1/routing/alternatives`,
    implementation: 'RoutingService.alternatives', engine: 'mock_valhalla', closures: 'synthetic',
    productionConfigLoaded: false, authentication: 'provided_by_COP_test_guard_not_this_loopback', validUntil }));
  const close = () => server.close(async () => { await rm(directory, { recursive: true, force: true }); process.exit(0); });
  process.on('SIGTERM', close); process.on('SIGINT', close);
  setTimeout(close, 300000).unref();
}
