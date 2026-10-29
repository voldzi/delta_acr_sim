/** Output own synthetic wire/hash fixtures only. No HTTP, engine or host I/O. */
import { PlanningOriginService } from '../apps/situation-data-api/dist/planning-origin.js';
import { planningOrdinaryQuery } from '../apps/situation-data-api/dist/planning-origin-query.js';
import { canonicalRoutingHash as H } from '../apps/situation-data-api/dist/routing-safety.js';
import { mappedAssessment } from '../apps/situation-data-api/dist/mapped-road-profile.js';
const now = Date.parse('2026-10-29T12:00:00Z');
const actor = { serviceActor: 'cop', opaquePlanningActor: 'a'.repeat(64) };
const dataset = { version: 'synthetic-graph', builtAt: '2026-10-29T00:00:00Z' };
const context = { version: 'sim-planning-origin-v1', purpose: 'planning_preview', contextId: '11111111-1111-4111-8111-111111111111',
  originContext: { kind: 'phone_measured', coordinate: { lat: 50, lon: 14 }, horizontalAccuracyM: 3, observedAt: '2026-10-29T12:00:00Z', accuracyAuthorization: 'reduced' },
  destination: { lat: 50, lon: 14.01 }, vehicleProfile: { version: 'sim-mapped-road-profile-v1', intent: 'car', coverageAcknowledged: 'mapped_restrictions_incomplete', vehicle: { heightM: 2, widthM: 2, lengthM: 5, loadedWeightKg: 3000 } } };
const port = {
  async planningDataset() { return structuredClone(dataset); },
  async planningLocate() { return [{ edges: [
    { edge_id: { value: '101' }, edge_info: { way_id: 1001 }, correlated_lat: 50, correlated_lon: 14.0005, heading: 90 },
    { edge_id: { value: '102' }, edge_info: { way_id: 1001 }, correlated_lat: 50, correlated_lon: 14.0005, heading: 270 }
  ] }]; },
  async planningPreview(c, coordinate) {
    const query = planningOrdinaryQuery(c, coordinate), geometry = { type: 'LineString', coordinates: [[coordinate.lon, coordinate.lat], [c.destination.lon, c.destination.lat]] };
    const expiry = new Date(now + 60_000).toISOString();
    const route = { profileId: 'car', status: 'ok', geometry, distanceM: 1000, durationSeconds: 100, warnings: [] };
    route.mappedProfileAssessment = mappedAssessment(query, query, route, dataset, '3.8.3', expiry);
    route.knownClosures = { version: 'sim-known-road-closures-v1', state: 'applied', coverage: 'incomplete', revision: 'b'.repeat(64),
      observedAt: new Date(now).toISOString(), validUntil: expiry, appliedClosureCount: 0, geometryHash: H(geometry), requestHash: H(query), exclusions: [],
      routingDataset: structuredClone(dataset), engine: { provider: 'valhalla', version: '3.8.3', fallbackUsed: false }, limitations: ['SYNTHETIC reviewed closure fixture, not live evidence.'] };
    return { query, routes: [route] };
  }
};
const service = new PlanningOriginService(port, () => now);
const candidatesRequest = { context }, candidatesResponse = await service.candidates(candidatesRequest, actor);
const first = candidatesResponse.candidates[0];
const selection = { coordinate: first.coordinate, source: 'candidate_selection', confirmed: true,
  candidateId: first.candidateId, directions: first.directions, directionsTruncated: first.directionsTruncated };
const previewRequest = { context, expectedDataset: dataset, discoveryBinding: candidatesResponse.binding, selection };
const previewResponse = await service.preview(previewRequest, actor);
const ordinaryQuery = planningOrdinaryQuery(context, selection.coordinate);
console.log(JSON.stringify({ syntheticOnly: true, notLiveCoordinateEvidence: true, notNativeEngineAcceptance: true, engineRequests: 0,
  nowUtc: new Date(now).toISOString(), nowUnixMs: now, actorIsSyntheticNotCredential: true, actor,
  candidatesRequest, candidatesResponse, previewRequest, previewResponse, ordinaryQuery,
  canonicalPublicVectors: { contextHash: candidatesResponse.binding.contextHash, profileHash: candidatesResponse.binding.profileHash,
    destinationHash: candidatesResponse.binding.destinationHash, selectionHash: H(selection), geometryHash: H(previewResponse.route.geometry),
    ordinaryQueryHash: H(ordinaryQuery), candidateId: first.candidateId },
  actorBoundVectorsCopOnly: { discoveryRequestHash: candidatesResponse.binding.requestHash, previewRequestHash: previewResponse.assessment.requestHash }
}, null, 2));
