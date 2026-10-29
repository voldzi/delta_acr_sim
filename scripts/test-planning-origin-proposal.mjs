// Contract-shape tests ONLY: no engine, provider, HTTP, secrets or production.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(new URL('../apps/situation-data-api/package.json', import.meta.url));
const Ajv = require('ajv/dist/2020').default;
const formats = require('ajv-formats');
const ajv = new Ajv({ strict: false, coerceTypes: false, removeAdditional: false, useDefaults: false });
formats(ajv);
const proposal = JSON.parse(readFileSync(new URL('../docs/integration/26_PLANNING_ORIGIN_OPENAPI_PROPOSAL.json', import.meta.url)));
const production = JSON.parse(readFileSync(new URL('../openapi/openapi.json', import.meta.url)));
const base = 'https://sim.invalid/docs/integration/26_PLANNING_ORIGIN_OPENAPI_PROPOSAL.json';
ajv.addSchema(production, 'https://sim.invalid/openapi/openapi.json');
ajv.addSchema(proposal, base);
const validators = Object.fromEntries(Object.keys(proposal.components.schemas).map(name => [name, ajv.compile({ $ref: `${base}#/components/schemas/${name}` })]));
const context = { version: 'sim-planning-origin-v1', purpose: 'planning_preview', contextId: '11111111-1111-4111-8111-111111111111',
  originContext: { kind: 'phone_measured', coordinate: { lon: 14, lat: 50 }, horizontalAccuracyM: 3,
    observedAt: '2026-10-29T12:00:00Z', accuracyAuthorization: 'reduced' }, destination: { lon: 14.01, lat: 50.01 },
  vehicleProfile: { version: 'sim-mapped-road-profile-v1', intent: 'car', coverageAcknowledged: 'mapped_restrictions_incomplete',
    vehicle: { heightM: 2, widthM: 2, lengthM: 5, loadedWeightKg: 3000 } } };
let checks = 0;
const valid = (name, value) => { assert.equal(validators[name](value), true, JSON.stringify(validators[name].errors)); checks++; };
const invalid = (name, value) => { assert.equal(validators[name](value), false, name); checks++; };
valid('CandidatesRequest', { context });
const manual = structuredClone(context);
manual.originContext = { kind: 'manual_point', coordinate: { lon: 14, lat: 50 }, source: 'user_selected_last_known' };
valid('CandidatesRequest', { context: manual });
for (const mutate of [
  c => c.purpose = 'navigation', c => c.userId = 'spoofed', c => c.originContext.horizontalAccuracyM = 0,
  c => c.originContext.horizontalAccuracyM = 5001, c => c.originContext.coordinate.lon = 181,
  c => c.originContext.observedAt = 'yesterday', c => c.vehicleProfile.vehicle.heightM = 6,
  c => c.vehicleProfile.ignore_access = true, c => c.originContext.accuracyAuthorization = 'unknown',
  c => c.originContext.horizontalAccuracyM = '3', c => delete c.originContext.observedAt
]) { const c = structuredClone(context); mutate(c); invalid('CandidatesRequest', { context: c }); }
const fakeManual = structuredClone(manual); fakeManual.originContext.observedAt = '2026-10-29T12:00:00Z';
invalid('CandidatesRequest', { context: fakeManual });
const preview = { context, expectedDataset: { version: 'synthetic-test-only', builtAt: '2026-10-29T00:00:00Z' },
  selection: { coordinate: { lon: 14.0006, lat: 50 }, source: 'user_map_selection', confirmed: true } };
valid('PreviewRequest', preview);
invalid('PreviewRequest', { ...preview, selection: { ...preview.selection, confirmed: false } });
invalid('PreviewRequest', { ...preview, userId: 'spoofed' });
invalid('PreviewRequest', { ...preview, selection: { ...preview.selection, ignore_closures: true } });
const candidate = { candidateId: `candidate:${'a'.repeat(64)}`, coordinate: { lon: 14, lat: 50 }, offsetDistanceM: 60,
  profileValidation: 'not_checked', legalAccess: 'not_verified', directionValidation: 'graph_candidate_only',
  directions: [{ directionId: `direction:${'c'.repeat(64)}`, headingDeg: 90, validation: 'graph_candidate_only' },
    { directionId: `direction:${'d'.repeat(64)}`, headingDeg: 270, validation: 'graph_candidate_only' }], directionsTruncated: false };
valid('Candidate', candidate); // 60m offset is independent of 3m accuracy.
invalid('Candidate', { ...candidate, legalAccess: 'verified' });
invalid('Candidate', { ...candidate, offsetDistanceM: 501 });
invalid('Candidate', { ...candidate, rawEdge: { name: 'must not escape' } });
valid('PreviewPath', { previewPathId: `preview:${'b'.repeat(64)}`, geometry: { type: 'LineString', coordinates: [[14, 50], [14.01, 50.01]] }, distanceM: 100, durationSeconds: 30, warnings: [] });
invalid('PreviewPath', { previewPathId: `preview:${'b'.repeat(64)}`, geometry: { type: 'LineString', coordinates: [[14, 50], [14.01, 50.01]] }, distanceM: 100, durationSeconds: 30, warnings: [], mappedProfileAssessment: {} });
assert.equal(Object.keys(proposal.paths).length, 2);
for (const path of Object.keys(proposal.paths)) assert.equal(production.paths[path], undefined);
console.log(JSON.stringify({ schemaChecks: checks, compiledSchemas: Object.keys(validators).length, productionOpenApiUnchanged: true, engineRequests: 0,
  freshnessOrAuthOrRouteGuardsTested: false, proposalOnly: true }));
