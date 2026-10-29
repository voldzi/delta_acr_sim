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
const dataset = { version: 'synthetic-test-only', builtAt: '2026-10-29T00:00:00Z' };
const binding = { contextId: context.contextId, requestHash: 'a'.repeat(64), contextHash: 'b'.repeat(64),
  profileHash: 'c'.repeat(64), destinationHash: 'd'.repeat(64), routingDataset: dataset };
const preview = { context, expectedDataset: dataset, discoveryBinding: binding,
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
const candidateSelection = { coordinate: candidate.coordinate, source: 'candidate_selection', confirmed: true,
  candidateId: candidate.candidateId, directions: candidate.directions, directionsTruncated: false };
valid('Selection', candidateSelection);
valid('Selection', { ...candidateSelection, candidateId: `candidate:${'f'.repeat(64)}` }); // Shape is NOT issuance proof.
invalid('Selection', { ...candidateSelection, edge_id: 12345 });
invalid('Selection', { ...candidateSelection, costing_options: { auto: { ignore_access: true } } });
const missingId = structuredClone(candidateSelection); delete missingId.candidateId;
invalid('Selection', missingId);
invalid('Selection', { ...preview.selection, candidateId: candidate.candidateId });
const discovery = { version: 'sim-planning-origin-candidates-v1', purpose: 'planning_preview', state: 'choices_available',
  binding, observedAt: '2026-10-29T12:00:00Z', validUntil: '2026-10-29T12:02:00Z',
  candidates: [candidate], navigationEligible: false, measurementEligible: false };
valid('CandidatesResponse', discovery);
valid('CandidatesResponse', { ...discovery, state: 'no_candidates', candidates: [] });
invalid('CandidatesResponse', { ...discovery, candidates: [] });
invalid('CandidatesResponse', { ...discovery, state: 'no_candidates' });
invalid('CandidatesResponse', { ...discovery, candidates: [candidate, candidate, candidate, candidate] });
invalid('PreviewRequest', { context, expectedDataset: dataset, selection: preview.selection });
const assessment = { version: 'sim-planning-origin-assessment-v1', purpose: 'planning_preview', binding,
  selectionHash: 'e'.repeat(64), geometryHash: 'f'.repeat(64), validUntil: '2026-10-29T12:02:00Z',
  navigationEligible: false, measurementEligible: false, state: 'applied', coverage: 'mapped_restrictions_incomplete',
  appliedProfile: context.vehicleProfile, profileHash: binding.profileHash, requestHash: binding.requestHash,
  engine: { provider: 'valhalla', version: '3.8.3', costing: 'auto', fallbackUsed: false }, routingDataset: dataset,
  appliedFields: ['heightM', 'widthM', 'lengthM', 'loadedWeightKg'], lastMile: { state: 'mapped_target', target: context.destination, mappedEndpoint: context.destination, distanceM: 0 },
  limitations: ['Mapped restrictions are incomplete.'], guards: { mappedProfile: 'applied_incomplete_coverage', knownClosures: 'applied_reviewed_snapshot', closureRevision: 'synthetic-only', snapToleranceM: 25, nativeWarningCount: 0, allVariantsValidated: true, fallbackUsed: false } };
valid('PreviewAssessment', assessment);
for (const field of ['appliedProfile', 'engine', 'appliedFields', 'coverage', 'limitations', 'lastMile']) {
  const broken = structuredClone(assessment); delete broken[field]; invalid('PreviewAssessment', broken);
}
invalid('PreviewAssessment', { ...assessment, version: 'sim-mapped-road-profile-assessment-v1' });
invalid('PreviewAssessment', { ...assessment, navigationEligible: true });
valid('PreviewPath', { previewPathId: `preview:${'b'.repeat(64)}`, geometry: { type: 'LineString', coordinates: [[14, 50], [14.01, 50.01]] }, distanceM: 100, durationSeconds: 30, warnings: [] });
invalid('PreviewPath', { previewPathId: `preview:${'b'.repeat(64)}`, geometry: { type: 'LineString', coordinates: [[14, 50], [14.01, 50.01]] }, distanceM: 100, durationSeconds: 30, warnings: [], mappedProfileAssessment: {} });
assert.equal(Object.keys(proposal.paths).length, 2);
for (const path of Object.keys(proposal.paths)) assert.equal(production.paths[path], undefined);
console.log(JSON.stringify({ schemaChecks: checks, compiledSchemas: Object.keys(validators).length, historicalProposalShapeOnly: true, engineRequests: 0,
  freshnessOrAuthOrRouteGuardsTested: false, proposalOnly: true }));
