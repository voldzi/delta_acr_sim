/** Synthetic pure wire-mechanics only. NOT Root verification, accepted
 * transition/enrollment, a lease, SQL application, signing or activation.
 * No database, network, secrets, environment or external targets are used.
 * The main agent alone owns execution of this test source.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AiOwnerDomainError, buildAiRootCheckpointBody} from './ai-owner-domain.mjs';

const hex = value => value.repeat(64);
const id = '10000000-0000-4000-8000-000000000031';
const nextId = '10000000-0000-4000-8000-000000000032';
const store = '20000000-0000-4000-8000-000000000031';
const recordId = '30000000-0000-4000-8000-000000000031';
const now = Date.parse('2026-10-15T12:00:00.000Z');
const snapshot = () => ({checkpointId: id, generation: '42', operationDigest: hex('a'), schemaDigest: hex('b')});
const transition = () => ({
  contractVersion: 'sim-ai-owner-transition-v1', owner: 'sim_ai_router', scope: 'cop_router_primary_database',
  storeIncarnation: store, expectedSnapshot: snapshot(), expectedSchemaFingerprint: hex('c'),
  expectedPrivilegeFingerprint: hex('d'), checkpointId: nextId, generation: '43',
  identityReviewed: true, replayReady: true, costPolicy: 'aggregate-costs-current-month-v1',
  proofValidUntilUTC: new Date(now + 30000).toISOString(), rootRecordRef: {recordId, digest: hex('e')},
});
const facts = () => ({
  contractVersion: 'sim-ai-checkpoint-facts-v1',
  request: {owner: 'sim_ai_router', scope: 'cop_router_primary_database', purpose: 'checkpoint', expectedSnapshot: snapshot()},
  observedAtUTC: new Date(now).toISOString(), storeIncarnation: store,
  checkpoint: {identity_reviewed: true, replay_ready: true, cost_policy: 'aggregate-costs-current-month-v1',
    checkpoint_id: id, checkpoint_generation: '42', operation_digest: hex('a'), schema_digest: hex('b')},
  snapshotMatches: true, schema: {ready: true, fingerprint: hex('c')},
  permissions: {runtimeProfileMatches: true, fingerprint: hex('d')},
  invariants: {rlsEnabled: true, fencesReady: true, financialViewsReady: true, costRetentionReady: true},
});
const quarantineTransition = () => ({...transition(), identityReviewed: false, replayReady: false, costPolicy: 'pending_requires_review'});
const quarantineFacts = () => {
  const value = facts();
  value.checkpoint.identity_reviewed = false; value.checkpoint.replay_ready = false;
  value.checkpoint.cost_policy = 'pending_requires_review'; value.invariants.costRetentionReady = false;
  return value;
};
const reject = fn => assert.throws(fn, error => error instanceof AiOwnerDomainError &&
  error.message === 'AI_ROUTER_OWNER_TRANSITION_INVALID' && error.cause === undefined);

test('active transition produces only the exact 13 SQL005 keys with all identifiers supplied', () => {
  const value = buildAiRootCheckpointBody(transition(), facts(), now);
  assert.deepEqual(value, {
    contractVersion: 'sim-ai-root-checkpoint-v1', owner: 'sim_ai_router', scope: 'cop_router_primary_database',
    storeIncarnation: store, expectedCheckpointId: id, expectedGeneration: '42', checkpointId: nextId, generation: '43',
    proofValidUntilUTC: new Date(now + 30000).toISOString(), rootRecordRef: {recordId, digest: hex('e')},
    identityReviewed: true, replayReady: true, costPolicy: 'aggregate-costs-current-month-v1',
  });
  assert.equal(Object.keys(value).length, 13);
  for (const forbidden of ['authority', 'admission', 'ready', 'permit', 'schemaFingerprint', 'privilegeFingerprint'])
    assert.equal(Object.hasOwn(value, forbidden), false);
});

test('active to quarantine and quarantined to active/pending are wire mechanics, not approval', () => {
  assert.equal(buildAiRootCheckpointBody(quarantineTransition(), facts(), now).costPolicy, 'pending_requires_review');
  assert.equal(buildAiRootCheckpointBody(transition(), quarantineFacts(), now).identityReviewed, true);
  assert.equal(buildAiRootCheckpointBody(quarantineTransition(), quarantineFacts(), now).identityReviewed, false);
});

test('body and nested reference are copied and frozen without changing either input', () => {
  const input = transition(), observation = facts(), before = structuredClone({input, observation});
  const value = buildAiRootCheckpointBody(input, observation, now);
  assert.deepEqual({input, observation}, before);
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.rootRecordRef));
  assert.notEqual(value.rootRecordRef, input.rootRecordRef);
  input.rootRecordRef.digest = hex('f'); input.expectedSnapshot.generation = '44';
  observation.checkpoint.checkpoint_generation = '45';
  assert.equal(value.rootRecordRef.digest, hex('e')); assert.equal(value.expectedGeneration, '42');
  assert.throws(() => { value.rootRecordRef.recordId = nextId; }, TypeError);
});

test('transition requires exactly the fixed identity and 14 data keys, no application selectors', () => {
  for (const value of [null, [], {}, {...transition(), owner: 'cop'}, {...transition(), scope: 'all'},
    {...transition(), contractVersion: 'sim-ai-root-checkpoint-v1'}, {...transition(), sql: 'forbidden'},
    {...transition(), authority: true}, {...transition(), credential: 'secret-value'}]) reject(() => buildAiRootCheckpointBody(value, facts(), now));
  for (const key of Object.keys(transition())) {
    const value = transition(); delete value[key]; reject(() => buildAiRootCheckpointBody(value, facts(), now));
  }
});

test('accessors, proxies, symbols and inherited shapes reject without invoking hostile getters', () => {
  let calls = 0;
  const accessor = Object.defineProperty(transition(), 'scope', {enumerable: true, get() { calls++; throw new Error('secret-value'); }});
  const nestedAccessor = transition();
  Object.defineProperty(nestedAccessor.rootRecordRef, 'digest', {enumerable: true, get() { calls++; return hex('e'); }});
  const snapshotAccessor = transition();
  Object.defineProperty(snapshotAccessor.expectedSnapshot, 'generation', {enumerable: true, get() { calls++; return '42'; }});
  for (const value of [accessor, nestedAccessor, snapshotAccessor, new Proxy(transition(), {}),
    {...transition(), rootRecordRef: new Proxy(transition().rootRecordRef, {})},
    {...transition(), expectedSnapshot: new Proxy(snapshot(), {})},
    Object.assign(Object.create({}), transition()), {...transition(), [Symbol('extra')]: true}])
    reject(() => buildAiRootCheckpointBody(value, facts(), now));
  assert.equal(calls, 0);
});

test('reference, snapshot and nested facts reject extra hidden or executable structure', () => {
  for (const value of [
    {...transition(), rootRecordRef: {...transition().rootRecordRef, authority: true}},
    {...transition(), expectedSnapshot: {...snapshot(), accountId: 'forbidden'}},
    {...transition(), rootRecordRef: Object.assign(Object.create({}), transition().rootRecordRef)},
  ]) reject(() => buildAiRootCheckpointBody(value, facts(), now));
  const hidden = transition(); Object.defineProperty(hidden, 'hidden', {value: 'forbidden'});
  reject(() => buildAiRootCheckpointBody(hidden, facts(), now));
  const input = facts(); input.invariants = new Proxy(input.invariants, {});
  reject(() => buildAiRootCheckpointBody(transition(), input, now));
});

test('UUIDs and lowercase hex64 references/pins remain strict and are never generated', () => {
  for (const [key, value] of [['storeIncarnation', 'invalid'], ['checkpointId', 'ABCDEF00-0000-4000-8000-000000000031'],
    ['expectedSchemaFingerprint', hex('C')], ['expectedPrivilegeFingerprint', 'a'.repeat(63)]])
    reject(() => buildAiRootCheckpointBody({...transition(), [key]: value}, facts(), now));
  for (const rootRecordRef of [null, {}, {recordId: '00000000-0000-0000-0000-000000000000', digest: hex('e')},
    {recordId, digest: hex('E')}, {recordId, digest: 12}])
    reject(() => buildAiRootCheckpointBody({...transition(), rootRecordRef}, facts(), now));
  for (const key of ['checkpointId', 'operationDigest', 'schemaDigest']) {
    const input = transition(); input.expectedSnapshot[key] = 'invalid'; reject(() => buildAiRootCheckpointBody(input, facts(), now));
  }
});

test('generation is an exact plus-one PostgreSQL bigint string, including beyond JS safe integers', () => {
  for (const old of ['0', '9007199254740992', '9223372036854775806']) {
    const input = transition(), observation = facts();
    input.expectedSnapshot.generation = old; input.generation = String(BigInt(old) + 1n);
    observation.request.expectedSnapshot.generation = old; observation.checkpoint.checkpoint_generation = old;
    assert.equal(buildAiRootCheckpointBody(input, observation, now).generation, input.generation);
  }
  for (const generation of [43, 43n, '042', '-1', '1.0', '1e3', '44', '9223372036854775808', '9'.repeat(100)])
    reject(() => buildAiRootCheckpointBody({...transition(), generation}, facts(), now));
  const exhausted = transition(), observed = facts();
  exhausted.expectedSnapshot.generation = '9223372036854775807'; exhausted.generation = '9223372036854775807';
  observed.request.expectedSnapshot.generation = '9223372036854775807'; observed.checkpoint.checkpoint_generation = '9223372036854775807';
  reject(() => buildAiRootCheckpointBody(exhausted, observed, now));
});

test('next mode must be exactly active or quarantine, never mixed or nonboolean', () => {
  for (const mode of [
    {identityReviewed: true, replayReady: false, costPolicy: 'aggregate-costs-current-month-v1'},
    {identityReviewed: false, replayReady: true, costPolicy: 'pending_requires_review'},
    {identityReviewed: true, replayReady: true, costPolicy: 'pending_requires_review'},
    {identityReviewed: false, replayReady: false, costPolicy: 'aggregate-costs-current-month-v1'},
    {identityReviewed: 'true'}, {replayReady: 1}, {costPolicy: 'custom'},
  ]) reject(() => buildAiRootCheckpointBody({...transition(), ...mode}, facts(), now));
});

test('prior mode must be consistently active or quarantine and facts are never repaired', () => {
  for (const mode of [
    {identity_reviewed: true, replay_ready: false, cost_policy: 'aggregate-costs-current-month-v1'},
    {identity_reviewed: false, replay_ready: true, cost_policy: 'pending_requires_review'},
    {identity_reviewed: true, replay_ready: true, cost_policy: 'pending_requires_review'},
    {identity_reviewed: false, replay_ready: false, cost_policy: 'aggregate-costs-current-month-v1'},
  ]) {
    const observation = facts(); Object.assign(observation.checkpoint, mode);
    const before = structuredClone(observation); reject(() => buildAiRootCheckpointBody(transition(), observation, now));
    assert.deepEqual(observation, before);
  }
  const falseActive = facts(); falseActive.invariants.costRetentionReady = false;
  reject(() => buildAiRootCheckpointBody(quarantineTransition(), falseActive, now));
  const truePending = quarantineFacts(); truePending.invariants.costRetentionReady = true;
  reject(() => buildAiRootCheckpointBody(transition(), truePending, now));
});

test('every actual schema, runtime privilege and protection invariant is required in both modes', () => {
  for (const base of [facts, quarantineFacts]) {
    for (const key of ['rlsEnabled', 'fencesReady', 'financialViewsReady']) {
      const observation = base(); observation.invariants[key] = false;
      reject(() => buildAiRootCheckpointBody(transition(), observation, now));
    }
    const schema = base(); schema.schema.ready = false;
    const privileges = base(); privileges.permissions.runtimeProfileMatches = false;
    for (const observation of [schema, privileges]) reject(() => buildAiRootCheckpointBody(transition(), observation, now));
  }
});

test('independent transition store/schema/privilege pins cannot be populated from target facts', () => {
  for (const [key, value] of [['storeIncarnation', '20000000-0000-4000-8000-000000000032'],
    ['expectedSchemaFingerprint', hex('f')], ['expectedPrivilegeFingerprint', hex('f')]])
    reject(() => buildAiRootCheckpointBody({...transition(), [key]: value}, facts(), now));
  for (const base of [facts, quarantineFacts]) {
    const unbound = base(); unbound.storeIncarnation = null;
    const schema = base(); schema.schema.fingerprint = hex('f');
    const privileges = base(); privileges.permissions.fingerprint = hex('f');
    for (const observation of [unbound, schema, privileges]) reject(() => buildAiRootCheckpointBody(transition(), observation, now));
  }
});

test('actual prior checkpoint and all four snapshot fields must match the independently expected snapshot', () => {
  const absent = facts(); absent.checkpoint = null; absent.snapshotMatches = false;
  reject(() => buildAiRootCheckpointBody(transition(), absent, now));
  for (const [key, value] of [['checkpoint_id', nextId], ['checkpoint_generation', '41'],
    ['operation_digest', hex('f')], ['schema_digest', hex('f')]]) {
    const observation = facts(); observation.checkpoint[key] = value; observation.snapshotMatches = false;
    reject(() => buildAiRootCheckpointBody(transition(), observation, now));
    observation.snapshotMatches = true; reject(() => buildAiRootCheckpointBody(transition(), observation, now));
  }
  const differentRequest = facts(); differentRequest.request.expectedSnapshot.generation = '41';
  reject(() => buildAiRootCheckpointBody(transition(), differentRequest, now));
});

test('five-second actual observation freshness and positive-to-thirty-second proof boundaries are strict', () => {
  const boundary = facts(); boundary.observedAtUTC = new Date(now - 5000).toISOString();
  assert.equal(buildAiRootCheckpointBody(transition(), boundary, now).proofValidUntilUTC, transition().proofValidUntilUTC);
  assert.equal(buildAiRootCheckpointBody({...transition(), proofValidUntilUTC: new Date(now + 1).toISOString()}, facts(), now).generation, '43');
  for (const observedAtUTC of [new Date(now - 5001).toISOString(), new Date(now + 1).toISOString()])
    reject(() => buildAiRootCheckpointBody(transition(), {...facts(), observedAtUTC}, now));
  for (const proofValidUntilUTC of [new Date(now - 1).toISOString(), new Date(now).toISOString(), new Date(now + 30001).toISOString()])
    reject(() => buildAiRootCheckpointBody({...transition(), proofValidUntilUTC}, facts(), now));
});

test('canonical finite UTC milliseconds and valid integer clock are required without time normalization', () => {
  for (const stamp of ['invalid', '2026-10-15T12:00:30Z', '2026-10-15T12:00:30.000+00:00',
    '2026-02-31T12:00:00.000Z', '2026-10-15T12:00:30.0000Z', 'infinity']) {
    reject(() => buildAiRootCheckpointBody({...transition(), proofValidUntilUTC: stamp}, facts(), now));
    reject(() => buildAiRootCheckpointBody(transition(), {...facts(), observedAtUTC: stamp}, now));
  }
  for (const clock of [NaN, Infinity, -Infinity, '2026-10-15', now + 0.5, Number.MAX_SAFE_INTEGER])
    reject(() => buildAiRootCheckpointBody(transition(), facts(), clock));
});

test('invalid and hostile observations produce only a fixed sanitized domain error', () => {
  for (const observation of [null, [], {}, {...facts(), rawContext: 'secret-value'}, new Proxy(facts(), {})])
    reject(() => buildAiRootCheckpointBody(transition(), observation, now));
  let calls = 0;
  const observation = facts();
  Object.defineProperty(observation, 'checkpoint', {enumerable: true, get() { calls++; throw new Error('secret-value'); }});
  reject(() => buildAiRootCheckpointBody(transition(), observation, now));
  assert.equal(calls, 0);
});
