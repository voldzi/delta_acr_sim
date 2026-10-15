import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driverReadRequestDigest, parseDriverReadRequest, validateDriverReadFacts, matchDriverReadPolicy } from './read-admission-facts.mjs';

// Pure synthetic observations/policies only. Not Root signatures or live auth.
const now = Date.parse('2026-10-15T08:00:00.000Z');
const request = { owner: 'sim_driver_measurements', scope: 'online_driver_scope', purpose: 'status', operationHash: 'a'.repeat(64), actorHash: 'b'.repeat(64) };
const expected = { storeIncarnation: '10000000-0000-4000-8000-000000000001', checkpointHash: 'c'.repeat(64),
  schemaFingerprint: 'd'.repeat(64), privilegeFingerprint: 'e'.repeat(64), reportProtection: 'no_report' };
const facts = () => ({ contractVersion: 'sim-driver-read-facts-v1', request, observedAtUTC: new Date(now).toISOString(), storeIncarnation: expected.storeIncarnation,
  state: { checkpointHash: expected.checkpointHash, replayReady: true, proofValidUntilUTC: new Date(now + 60_000).toISOString(), proofCurrent: true,
    retentionReviewed: true, reportProtection: expected.reportProtection, publicationFenceVerified: true },
  schema: { ready: true, fingerprint: expected.schemaFingerprint }, privileges: { runtimeProfileMatches: true, fingerprint: expected.privilegeFingerprint },
  operation: { operationHash: request.operationHash, actorHash: request.actorHash, requestHash: 'f'.repeat(64), contributorCount: 9, status: 'pending',
    createdAtUTC: new Date(now - 1000).toISOString(), updatedAtUTC: new Date(now).toISOString(), deletedBatchCount: 2, remainingBatchCount: 0,
    databaseZeroVerified: true, derivedReportAcknowledged: false, replayCheckpointHash: expected.checkpointHash, ledgerDigest: '1'.repeat(64) } });
test('all five exact requests have one deterministic key-order-independent digest', () => {
  for (const purpose of ['capability', 'intake', 'preflight', 'status', 'receipt']) {
    const r = ['capability', 'intake'].includes(purpose) ? { owner: request.owner, scope: request.scope, purpose } : { ...request, purpose };
    assert.deepEqual(parseDriverReadRequest(r), r);
    assert.equal(driverReadRequestDigest(r), driverReadRequestDigest(Object.fromEntries(Object.entries(r).reverse())));
  }
});
test('unknown keys, identities on owner-wide reads and missing identities fail closed', () => {
  for (const r of [{ ...request, sql: 'forbidden' }, { ...request, purpose: 'other' }, { ...request, purpose: 'capability' },
    { ...request, actorHash: 'raw-person-id' }, { owner: request.owner, scope: request.scope, purpose: 'status' }])
    assert.throws(() => parseDriverReadRequest(r), /UNAVAILABLE/);
});
test('valid actor-bound facts and necessary pinned policy match, without issuing admission', () => {
  assert.deepEqual(validateDriverReadFacts(facts(), request), facts());
  assert.deepEqual(matchDriverReadPolicy(facts(), request, expected, now), facts());
});
test('unknown or foreign operation output, invalid scalar and mismatched request are rejected', () => {
  for (const change of [f => { f.operation.actorHash = '2'.repeat(64); }, f => { f.operation.deletedBatchCount = -1; },
    f => { f.operation.manifest = []; }, f => { f.request = { ...request, operationHash: '2'.repeat(64) }; },
    f => { f.state.ready = true; }, f => { f.schema.fingerprint = 'invalid'; }]) {
    const f = facts(); change(f); assert.throws(() => validateDriverReadFacts(f, request), /UNAVAILABLE/);
  }
});
test('false or unbound facts remain observations but cannot satisfy policy', () => {
  for (const change of [f => { f.storeIncarnation = null; }, f => { f.schema.ready = false; },
    f => { f.privileges.runtimeProfileMatches = false; }, f => { f.state.replayReady = false; },
    f => { f.state.reportProtection = 'unverified'; }, f => { f.state.proofCurrent = false; }]) {
    const f = facts(); change(f); validateDriverReadFacts(f, request);
    assert.throws(() => matchDriverReadPolicy(f, request, expected, now), /UNAVAILABLE/);
  }
});
test('current flags cannot hide fingerprint/checkpoint/store drift or old/future observations', () => {
  for (const change of [f => { f.schema.fingerprint = '2'.repeat(64); }, f => { f.privileges.fingerprint = '2'.repeat(64); },
    f => { f.state.checkpointHash = '2'.repeat(64); }, f => { f.storeIncarnation = '10000000-0000-4000-8000-000000000002'; },
    f => { f.observedAtUTC = new Date(now - 5001).toISOString(); }, f => { f.observedAtUTC = new Date(now + 1).toISOString(); },
    f => { f.state.proofValidUntilUTC = new Date(now).toISOString(); }]) {
    const f = facts(); change(f); assert.throws(() => matchDriverReadPolicy(f, request, expected, now), /UNAVAILABLE/);
  }
});
test('missing operations are indistinguishable observations, never a completed receipt', () => {
  const f = facts(); f.operation = null; validateDriverReadFacts(f, request);
  assert.throws(() => matchDriverReadPolicy({ ...f, request: { ...request, purpose: 'receipt' } }, { ...request, purpose: 'receipt' }, expected, now), /UNAVAILABLE/);
});
