/** SOURCE ONLY: private, fixed Root checkpoint metadata publication.
 * Actual COP common code, current independent evidence and an exclusive
 * checkpoint-publish lease are mandatory; an ABI declaration is not authority.
 * Install this complete reviewed dependency closure at /opt/cop-account-safety.
 * No application-selected IDs/profiles/paths, callback, environment selector,
 * enrollment, binding creation, key/billing/ledger/fence mutation or DDL exists.
 *
 * A durable signed dispatch claim precedes the first mutating SQL. Once that
 * file exists, this operation is permanently probe-only: no new setter, UUID,
 * body, generation or deadline is substituted, even after expiry or no effects.
 * SQL005 has no origin/TX marker. A fresh exact desired-state observation is
 * therefore named checkpoint-readback-known, NEVER original-TX-committed or
 * Root-ready. common owns immutable intent retention and uncertain lease HOLD;
 * this module does not auto-accept the target's new policy/checkpoint.
 */
import {createRequire} from 'node:module';
import {lstatSync} from 'node:fs';
import {requireCurrentOwner, beginOwnerPublicationIntent, holdOwnerLease} from './root-owner-authority.mjs';
import {connectionProfile} from './root-driver-runtime.mjs';
import {issueRootRecord, storeRootRecord} from './root-record-issuer.mjs';
import {canonical, canonicalJson, exact, hex, uuid, sha256, requireGuard, readRootFile,
  requireRootDirectory, requireRootCodeTree, verifyRootRecord} from './root-records.mjs';
import {parseDriverReadRequest, validateDriverReadFacts} from './read-admission-facts.mjs';
import {parseAiCheckpointRequest, validateAiCheckpointFacts} from './checkpoint-facts.mjs';
import {buildAiRootCheckpointBody} from './ai-owner-domain.mjs';

const ROOT = '/opt/cop-account-safety';
const DISPATCHES = '/var/lib/cop-account-safety/checkpoint-dispatches';
const KEYRING = '/etc/cop-account-safety/public/verification-keys.json';
const COST = 'aggregate-costs-current-month-v1';
const BASE = ['contractVersion', 'kind', 'recordId', 'issuedAt', 'expiresAt'];
const CONTEXT = ['contractVersion', 'owner', 'scope', 'purpose', 'registration', 'peer', 'guardStoreId', 'continuityEpoch',
  'protectedConfigId', 'datasetBindingId', 'runtimeBindingId', 'sourceProofId', 'policyGeneration', 'frontierSequence',
  'frontierDigest', 'storeIncarnation', 'expiresAtUTC', 'reference', 'rootPolicy', 'keys', 'assertCurrent', 'close'];
const POLICY = ['contractVersion', 'reference', 'identityEvidenceRef', 'retentionEvidenceRef', 'schemaEvidenceRef',
  'privilegeEvidenceRef', 'schemaFingerprint', 'privilegeFingerprint', 'owner', 'scope'];
const DRIVER_TRANSITION = ['contractVersion', 'intentRef', 'operationId', 'expectedPreviousCheckpointHash',
  'checkpointHash', 'proofValidUntilUTC', 'replayReady', 'retentionReviewed', 'reportProtection', 'publicationFenceVerified'];
const AI_TRANSITION = ['contractVersion', 'intentRef', 'operationId', 'expectedCheckpointId', 'expectedGeneration',
  'checkpointId', 'generation', 'operationDigest', 'schemaDigest', 'identityReviewed', 'replayReady', 'costPolicy', 'proofValidUntilUTC'];
const CLAIM = ['owner', 'scope', 'operationId', 'storeIncarnation', 'guardStoreId', 'continuityEpoch',
  'protectedConfigId', 'datasetBindingId', 'runtimeBindingId', 'transitionIntentRef', 'intentRef', 'bodyDigest'];
const SPEC = Object.freeze({
  sim_driver_measurements: Object.freeze({scope: 'online_driver_scope', database: 'sim_driver_measurements', profile: 'driver-control',
    user: 'sim_driver_guard_control', facts: 'SELECT sim_driver_guard_source.read_admission_facts($1::jsonb) AS value',
    apply: 'SELECT sim_driver_guard_source.apply_root_checkpoint($1::jsonb) AS value'}),
  sim_ai_router: Object.freeze({scope: 'cop_router_primary_database', database: 'sim_ai_router', profile: 'ai-router-control',
    user: 'sim_ai_guard_control', facts: 'SELECT sim_ai_guard_source.read_checkpoint_facts($1::jsonb) AS value',
    apply: 'SELECT sim_ai_guard_source.apply_root_checkpoint($1::jsonb) AS value'}),
});
const ref = value => exact(value, ['recordId', 'digest']) && uuid(value.recordId) && hex(value.digest);
const stamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value); return Number.isFinite(time) && new Date(time).toISOString() === value;
};
const generation = value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
const peerValid = value => exact(value, ['device', 'inode', 'uid', 'gid']) &&
  typeof value.device === 'string' && /^[0-9]{1,20}$/.test(value.device) &&
  typeof value.inode === 'string' && /^[0-9]{1,20}$/.test(value.inode) && value.inode !== '0' &&
  Number.isSafeInteger(value.uid) && value.uid >= 0 && Number.isSafeInteger(value.gid) && value.gid >= 0;
const copy = value => JSON.parse(canonical(value));
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const unavailable = () => new Error('ROOT_CHECKPOINT_UNAVAILABLE');
function rootOnly(peer) {
  requireGuard(process.getuid?.() === 0 && process.geteuid?.() === 0, 'ROOT_EXECUTION_REQUIRED');
  requireRootCodeTree(ROOT); requireRootDirectory(DISPATCHES, {secret: true});
  requireGuard(peerValid(peer), 'GUARD_CHECKPOINT_PEER');
}
function activeDriver(value) {
  return value.replayReady && value.retentionReviewed && value.publicationFenceVerified &&
    ['no_report', 'enforced_single_writer', 'shared_generation_fence'].includes(value.reportProtection);
}
function quarantineDriver(value) {
  return !value.replayReady && !value.retentionReviewed && !value.publicationFenceVerified && value.reportProtection === 'unverified';
}
function stateOf(ctx, owner, peer) {
  requireGuard(exact(ctx, CONTEXT) && ctx.contractVersion === 'cop-root-owner-authority-v1' && ctx.owner === owner &&
    ctx.scope === SPEC[owner].scope && ctx.purpose === 'checkpoint-publish' && peerValid(ctx.peer) && canonical(ctx.peer) === canonical(peer) &&
    typeof ctx.assertCurrent === 'function' && typeof ctx.close === 'function' && ref(ctx.reference) &&
    [ctx.guardStoreId, ctx.continuityEpoch, ctx.protectedConfigId, ctx.datasetBindingId, ctx.runtimeBindingId, ctx.sourceProofId, ctx.storeIncarnation].every(uuid) &&
    Number.isSafeInteger(ctx.policyGeneration) && ctx.policyGeneration > 0 && Number.isSafeInteger(ctx.frontierSequence) && ctx.frontierSequence >= 0 &&
    hex(ctx.frontierDigest) && stamp(ctx.expiresAtUTC) && Date.parse(ctx.expiresAtUTC) > Date.now() &&
    ctx.registration && Object.getPrototypeOf(ctx.registration) === Object.prototype, 'GUARD_CHECKPOINT_AUTHORITY');
  const p = ctx.rootPolicy, driver = owner === 'sim_driver_measurements';
  requireGuard(exact(p, driver ? [...POLICY, 'expectedCheckpointHash', 'reportProtection', 'reportPolicyRef', 'transition'] :
    [...POLICY, 'costPolicy', 'costEvidenceRef', 'expectedSnapshot', 'transition']) &&
    p.contractVersion === 'cop-root-owner-policy-v1' && p.owner === owner && p.scope === ctx.scope &&
    hex(p.schemaFingerprint) && hex(p.privilegeFingerprint) &&
    ['reference', 'identityEvidenceRef', 'retentionEvidenceRef', 'schemaEvidenceRef', 'privilegeEvidenceRef'].every(k => ref(p[k])), 'GUARD_CHECKPOINT_POLICY');
  const t = p.transition;
  requireGuard(exact(t, driver ? DRIVER_TRANSITION : AI_TRANSITION) && uuid(t.operationId) && ref(t.intentRef) &&
    stamp(t.proofValidUntilUTC), 'GUARD_CHECKPOINT_TRANSITION');
  if (driver) {
    requireGuard(t.contractVersion === 'cop-root-driver-checkpoint-transition-v1' && hex(p.expectedCheckpointHash) &&
      ['no_report', 'enforced_single_writer', 'shared_generation_fence'].includes(p.reportProtection) && ref(p.reportPolicyRef) &&
      (t.expectedPreviousCheckpointHash === null || hex(t.expectedPreviousCheckpointHash) && t.expectedPreviousCheckpointHash === p.expectedCheckpointHash) &&
      hex(t.checkpointHash) && ['replayReady', 'retentionReviewed', 'publicationFenceVerified'].every(k => typeof t[k] === 'boolean') &&
      (activeDriver(t) || quarantineDriver(t)), 'GUARD_CHECKPOINT_DRIVER_TRANSITION');
  } else {
    const request = parseAiCheckpointRequest({owner, scope: ctx.scope, purpose: 'checkpoint', expectedSnapshot: p.expectedSnapshot});
    requireGuard(t.contractVersion === 'cop-root-ai-checkpoint-transition-v1' && p.costPolicy === COST && ref(p.costEvidenceRef) &&
      uuid(t.expectedCheckpointId) && uuid(t.checkpointId) && generation(t.expectedGeneration) && generation(t.generation) &&
      BigInt(t.expectedGeneration) < 9223372036854775807n && BigInt(t.generation) === BigInt(t.expectedGeneration) + 1n &&
      hex(t.operationDigest) && hex(t.schemaDigest) && typeof t.identityReviewed === 'boolean' && typeof t.replayReady === 'boolean' &&
      (t.identityReviewed && t.replayReady && t.costPolicy === COST || !t.identityReviewed && !t.replayReady && t.costPolicy === 'pending_requires_review') &&
      canonical(request.expectedSnapshot) === canonical({checkpointId: t.expectedCheckpointId, generation: t.expectedGeneration,
        operationDigest: t.operationDigest, schemaDigest: t.schemaDigest}), 'GUARD_CHECKPOINT_AI_TRANSITION');
  }
  return freeze(copy(Object.fromEntries(CONTEXT.filter(k => !['assertCurrent', 'close'].includes(k)).map(k => [k, ctx[k]]))));
}
async function current(ctx, state, peer, expired) {
  requireGuard(!expired(), 'GUARD_CHECKPOINT_DEADLINE');
  await ctx.assertCurrent();
  requireGuard(!expired() && canonical(stateOf(ctx, state.owner, peer)) === canonical(state), 'GUARD_CHECKPOINT_CONTEXT_CHANGED');
  requireGuard(canonical(canonicalJson(readRootFile(KEYRING))) === canonical(state.keys), 'GUARD_CHECKPOINT_KEYRING_CHANGED');
}
function baseBody(state) {
  const t = state.rootPolicy.transition;
  const common = {owner: state.owner, scope: state.scope, storeIncarnation: state.storeIncarnation};
  return freeze(state.owner === 'sim_driver_measurements' ? {
    contractVersion: 'sim-driver-root-checkpoint-v1', ...common, expectedPreviousCheckpointHash: t.expectedPreviousCheckpointHash,
    checkpointHash: t.checkpointHash, proofValidUntilUTC: t.proofValidUntilUTC, replayReady: t.replayReady,
    retentionReviewed: t.retentionReviewed, reportProtection: t.reportProtection, publicationFenceVerified: t.publicationFenceVerified,
  } : {
    contractVersion: 'sim-ai-root-checkpoint-v1', ...common, expectedCheckpointId: t.expectedCheckpointId,
    expectedGeneration: t.expectedGeneration, checkpointId: t.checkpointId, generation: t.generation,
    proofValidUntilUTC: t.proofValidUntilUTC, identityReviewed: t.identityReviewed, replayReady: t.replayReady, costPolicy: t.costPolicy,
  });
}
function requestFor(state, desired) {
  const t = state.rootPolicy.transition;
  return state.owner === 'sim_driver_measurements' ? parseDriverReadRequest({owner: state.owner, scope: state.scope, purpose: 'capability'}) :
    parseAiCheckpointRequest({owner: state.owner, scope: state.scope, purpose: 'checkpoint', expectedSnapshot: {
      checkpointId: desired ? t.checkpointId : t.expectedCheckpointId, generation: desired ? t.generation : t.expectedGeneration,
      operationDigest: t.operationDigest, schemaDigest: t.schemaDigest,
    }});
}
function checkedFacts(raw, state, request) {
  const driver = state.owner === 'sim_driver_measurements', p = state.rootPolicy;
  const facts = driver ? validateDriverReadFacts(raw, request) : validateAiCheckpointFacts(raw, request);
  const observed = Date.parse(facts.observedAtUTC), now = Date.now(), permissions = driver ? facts.privileges : facts.permissions;
  requireGuard(observed <= now && now - observed <= 5000 && facts.storeIncarnation === state.storeIncarnation &&
    facts.schema.ready && facts.schema.fingerprint === p.schemaFingerprint && permissions.runtimeProfileMatches &&
    permissions.fingerprint === p.privilegeFingerprint, 'GUARD_CHECKPOINT_TARGET_FACTS');
  if (!driver) requireGuard(facts.checkpoint !== null && facts.snapshotMatches && facts.invariants.rlsEnabled &&
    facts.invariants.fencesReady && facts.invariants.financialViewsReady, 'GUARD_CHECKPOINT_AI_FACTS');
  return facts;
}
function firstBody(state, facts, intentRef) {
  const t = state.rootPolicy.transition, now = Date.now(), deadline = Date.parse(t.proofValidUntilUTC);
  // Signing/current checks may consume time after the RO transaction. Recheck
  // the actual unchanged observation for Driver too, not only the AI builder.
  checkedFacts(facts, state, requestFor(state, false));
  requireGuard(deadline > now && deadline - now <= 30000 && deadline <= Date.parse(state.expiresAtUTC), 'GUARD_CHECKPOINT_PROOF_DEADLINE');
  if (state.owner === 'sim_ai_router') return buildAiRootCheckpointBody({
    contractVersion: 'sim-ai-owner-transition-v1', owner: state.owner, scope: state.scope, storeIncarnation: state.storeIncarnation,
    expectedSnapshot: state.rootPolicy.expectedSnapshot, expectedSchemaFingerprint: state.rootPolicy.schemaFingerprint,
    expectedPrivilegeFingerprint: state.rootPolicy.privilegeFingerprint, checkpointId: t.checkpointId, generation: t.generation,
    identityReviewed: t.identityReviewed, replayReady: t.replayReady, costPolicy: t.costPolicy,
    proofValidUntilUTC: t.proofValidUntilUTC, rootRecordRef: intentRef,
  }, facts, now);
  requireGuard(facts.state.checkpointHash === t.expectedPreviousCheckpointHash &&
    (activeDriver(facts.state) || quarantineDriver(facts.state)) &&
    (!activeDriver(facts.state) || facts.state.reportProtection === state.rootPolicy.reportProtection), 'GUARD_CHECKPOINT_DRIVER_PREVIOUS');
  return freeze({...baseBody(state), rootRecordRef: copy(intentRef)});
}
function desiredFacts(raw, state, request, body) {
  const facts = checkedFacts(raw, state, request);
  if (state.owner === 'sim_driver_measurements') {
    requireGuard(['checkpointHash', 'proofValidUntilUTC', 'replayReady', 'retentionReviewed', 'reportProtection', 'publicationFenceVerified']
      .every(k => facts.state[k] === body[k]), 'GUARD_CHECKPOINT_READBACK_MISMATCH');
  } else {
    const c = facts.checkpoint;
    requireGuard(c.checkpoint_id === body.checkpointId && c.checkpoint_generation === body.generation &&
      c.identity_reviewed === body.identityReviewed && c.replay_ready === body.replayReady && c.cost_policy === body.costPolicy &&
      facts.invariants.costRetentionReady === (body.costPolicy === COST), 'GUARD_CHECKPOINT_READBACK_MISMATCH');
  }
  return facts;
}
function claimFacts(state, intent) {
  return freeze({owner: state.owner, scope: state.scope, operationId: intent.operationId, storeIncarnation: state.storeIncarnation,
    guardStoreId: state.guardStoreId, continuityEpoch: state.continuityEpoch, protectedConfigId: state.protectedConfigId,
    datasetBindingId: state.datasetBindingId, runtimeBindingId: state.runtimeBindingId,
    transitionIntentRef: copy(state.rootPolicy.transition.intentRef), intentRef: {recordId: intent.recordId, digest: intent.digest}, bodyDigest: intent.bodyDigest});
}
function readClaim(path, state, wanted) {
  try { lstatSync(path); } catch (error) { if (error?.code === 'ENOENT') return undefined; throw error; }
  // Historical verification never renews this immutable dispatch. Expiry alone
  // cannot prove rollback/no effects or authorize a second SQL application.
  const r = verifyRootRecord(readRootFile(path, {secret: true}), state.keys, 'checkpoint-dispatch', {historical: true});
  requireGuard(exact(r.payload, [...BASE, ...CLAIM]) && r.payload.recordId === wanted.operationId &&
    CLAIM.every(k => canonical(r.payload[k]) === canonical(wanted[k])), 'GUARD_CHECKPOINT_DISPATCH_BINDING');
  return r;
}
function claimPresent(path) {
  try { lstatSync(path); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}
async function withClient(spec, clients, expired, ctx, session, task) {
  requireGuard(!expired(), 'GUARD_CHECKPOINT_DEADLINE');
  const require = createRequire(ROOT + '/package.json'), {Client} = require('pg');
  const client = new Client({...connectionProfile(spec.profile, spec.database, spec.user),
    connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 3000,
    application_name: 'cop-root-owner-checkpoint-v1'});
  client.on('error', () => {}); clients.add(client);
  try { await client.connect(); requireGuard(!expired(), 'GUARD_CHECKPOINT_DEADLINE'); return await task(client); }
  finally {
    // A rollback error proves neither quiescence nor no effects. Only an
    // actually settled pg end or an observed closed stream permits removal
    // from the watchdog. A destroy request/timeout alone is not that proof.
    await client.query('ROLLBACK').catch(() => {});
    let ended = false;
    try { await client.end(); ended = true; } catch { /* Actual closure checked below. */ }
    if (ended || client.connection?.stream?.closed === true) clients.delete(client);
    else {
      session.unknown = true;
      holdOwnerLease(ctx);
      // Retain watchdog visibility; common close must retain the actual held
      // exclusive lease, even if a subsequent socket event finally arrives.
      throw unavailable();
    }
  }
}
async function readFacts(spec, state, request, clients, expired, ctx, session) {
  return withClient(spec, clients, expired, ctx, session, async client => {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='3000ms'");
    await client.query("SET LOCAL lock_timeout='1000ms'");
    const result = await client.query(spec.facts, [JSON.stringify(request)]);
    requireGuard(result.rows.length === 1, 'GUARD_CHECKPOINT_FACTS_UNAVAILABLE');
    const facts = checkedFacts(result.rows[0].value, state, request);
    await client.query('COMMIT'); return facts;
  });
}
function validateApplied(value, state, body, intentRef) {
  const driver = state.owner === 'sim_driver_measurements';
  requireGuard(exact(value, driver ? ['contractVersion', 'storeIncarnation', 'rootRecordRef', 'appliedAtUTC', 'state'] :
    ['contractVersion', 'storeIncarnation', 'rootRecordRef', 'appliedAtUTC', 'proofValidUntilUTC', 'checkpoint']) &&
    value.contractVersion === (driver ? 'sim-driver-root-checkpoint-result-v1' : 'sim-ai-root-checkpoint-result-v1') &&
    value.storeIncarnation === body.storeIncarnation && canonical(value.rootRecordRef) === canonical(intentRef) &&
    stamp(value.appliedAtUTC) && Date.parse(value.appliedAtUTC) <= Date.now() && Date.parse(value.appliedAtUTC) < Date.parse(body.proofValidUntilUTC),
  'GUARD_CHECKPOINT_APPLY_RESULT');
  if (driver) requireGuard(exact(value.state, ['checkpointHash', 'replayReady', 'proofValidUntilUTC', 'proofCurrent',
    'retentionReviewed', 'reportProtection', 'publicationFenceVerified']) && value.state.proofCurrent === true &&
    ['checkpointHash', 'replayReady', 'proofValidUntilUTC', 'retentionReviewed', 'reportProtection', 'publicationFenceVerified']
      .every(k => value.state[k] === body[k]), 'GUARD_CHECKPOINT_APPLY_RESULT');
  else requireGuard(value.proofValidUntilUTC === body.proofValidUntilUTC &&
    exact(value.checkpoint, ['checkpointId', 'generation', 'identityReviewed', 'replayReady', 'costPolicy']) &&
    Object.keys(value.checkpoint).every(k => value.checkpoint[k] === body[k]), 'GUARD_CHECKPOINT_APPLY_RESULT');
}
function pending(state, intent, commitAcknowledged) {
  return freeze({contractVersion: 'sim-root-checkpoint-publication-result-v1', owner: state.owner, scope: state.scope,
    status: 'pending', reason: 'checkpoint_readback_unresolved', operationId: intent.operationId,
    intentRef: {recordId: intent.recordId, digest: intent.digest}, commitAcknowledged});
}
async function publish(peer, owner) {
  rootOnly(peer); peer = freeze(copy(peer));
  const ctx = await requireCurrentOwner(owner, peer, 'checkpoint-publish');
  const clients = new Set(), session = {unknown: false}, started = Date.now(); let timedOut = false;
  const expired = () => timedOut || session.unknown || Date.now() - started >= 15000;
  const watchdog = setTimeout(() => {
    timedOut = true;
    if (clients.size) { session.unknown = true; holdOwnerLease(ctx); }
    for (const client of clients) client.connection?.stream?.destroy();
  }, 15000);
  let state, intent, claimed = false, commitAcknowledged = false, output;
  try {
    state = stateOf(ctx, owner, peer); await current(ctx, state, peer, expired);
    const spec = SPEC[owner], base = baseBody(state), operationId = state.rootPolicy.transition.operationId;
    // Original canonical Root JSON, without rootRecordRef. Never the distinct
    // PostgreSQL JSONB-text digest used by guarded erasure origin mechanics.
    intent = await beginOwnerPublicationIntent(ctx, base);
    requireGuard(exact(intent, ['recordId', 'digest', 'operationId', 'bodyDigest', 'originalBody']) && ref({recordId: intent.recordId, digest: intent.digest}) &&
      intent.operationId === operationId && hex(intent.bodyDigest) && intent.bodyDigest === sha256(canonical(intent.originalBody)) &&
      canonical(intent.originalBody) === canonical(base), 'GUARD_CHECKPOINT_IMMUTABLE_INTENT');
    intent = freeze(copy(intent)); await current(ctx, state, peer, expired);
    const intentRef = freeze({recordId: intent.recordId, digest: intent.digest}), wanted = claimFacts(state, intent);
    const path = DISPATCHES + '/' + operationId + '.json';
    // Mark presence before decoding. A corrupt or presently untrusted existing
    // record is unresolved work too, never permission to send the setter.
    claimed = claimPresent(path);
    let existing = readClaim(path, state, wanted);
    requireGuard(!claimed || existing !== undefined, 'GUARD_CHECKPOINT_DISPATCH_DISAPPEARED');
    let body = freeze({...intent.originalBody, rootRecordRef: intentRef});
    if (!existing) {
      const facts = await readFacts(spec, state, requestFor(state, false), clients, expired, ctx, session);
      body = firstBody(state, facts, intentRef);
      requireGuard(canonical(Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'rootRecordRef'))) === canonical(intent.originalBody),
        'GUARD_CHECKPOINT_IMMUTABLE_BODY');
      await current(ctx, state, peer, expired);
      const keyBytes = readRootFile(KEYRING);
      requireGuard(canonical(canonicalJson(keyBytes)) === canonical(state.keys), 'GUARD_CHECKPOINT_KEYRING_CHANGED');
      const record = issueRootRecord('checkpoint-dispatch', wanted, {recordId: operationId, lifetimeMs: 300000, expectedKeyringDigest: sha256(keyBytes)});
      verifyRootRecord(record.bytes, state.keys, 'checkpoint-dispatch');
      try { storeRootRecord(path, record.bytes); claimed = true; }
      catch (error) {
        // Even a partial/invalid existing claim may have preceded work in a
        // crashed process. It is never overwritten, removed or called no-op.
        claimed = true;
        if (error?.code !== 'EEXIST') throw error;
        existing = readClaim(path, state, wanted); requireGuard(existing !== undefined, 'GUARD_CHECKPOINT_DISPATCH_UNRESOLVED');
      }
      if (!existing) {
        await current(ctx, state, peer, expired);
        // Revalidate the original unchanged deadline/facts immediately before
        // dispatch. Once claimed, failure here also stays permanently pending.
        firstBody(state, facts, intentRef);
        try {
          await withClient(spec, clients, expired, ctx, session, async client => {
            await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='3000ms'");
            await client.query("SET LOCAL lock_timeout='1000ms'");
            const result = await client.query(spec.apply, [JSON.stringify(body)]);
            requireGuard(result.rows.length === 1, 'GUARD_CHECKPOINT_APPLY_RESULT');
            validateApplied(result.rows[0].value, state, body, intentRef);
            await current(ctx, state, peer, expired);
            await client.query('COMMIT'); commitAcknowledged = true;
          });
        } catch { /* Dispatch is consumed. Only actual fresh readback may settle metadata. */ }
      }
    }
    await current(ctx, state, peer, expired);
    const request = requestFor(state, true), facts = await readFacts(spec, state, request, clients, expired, ctx, session);
    desiredFacts(facts, state, request, body);
    await current(ctx, state, peer, expired);
    output = freeze({contractVersion: 'sim-root-checkpoint-publication-result-v1', owner, scope: state.scope,
      status: 'checkpoint-readback-known', operationId: intent.operationId, intentRef, commitAcknowledged,
      observedAtUTC: facts.observedAtUTC, checkpoint: owner === 'sim_driver_measurements' ?
        {checkpointHash: body.checkpointHash, proofValidUntilUTC: body.proofValidUntilUTC, replayReady: body.replayReady,
          retentionReviewed: body.retentionReviewed, reportProtection: body.reportProtection, publicationFenceVerified: body.publicationFenceVerified} :
        {checkpointId: body.checkpointId, generation: body.generation, identityReviewed: body.identityReviewed, replayReady: body.replayReady, costPolicy: body.costPolicy}});
  } catch {
    if ((claimed || session.unknown) && state && intent) output = pending(state, intent, commitAcknowledged);
    else throw unavailable();
  } finally {
    // Common must settle the real held exclusive lease, or retain its HOLD.
    // No local timer/TTL or failed rollback is substituted for that settlement.
    try { await ctx.close(); }
    catch { if ((claimed || session.unknown) && state && intent) output = pending(state, intent, commitAcknowledged); else throw unavailable(); }
    finally {
      // An unverified client remains visible until the bounded watchdog fires.
      // Clearing its timer or the client's set entry must not invent drainage.
      if (!clients.size) clearTimeout(watchdog);
    }
  }
  if (!output || expired()) {
    if (state && intent && (claimed || session.unknown)) return pending(state, intent, commitAcknowledged);
    throw unavailable();
  }
  return output;
}

export async function publishRootDriverCheckpoint(kernelPeer) {
  try { return await publish(kernelPeer, 'sim_driver_measurements'); } catch { throw unavailable(); }
}
export async function publishRootAiCheckpoint(kernelPeer) {
  try { return await publish(kernelPeer, 'sim_ai_router'); } catch { throw unavailable(); }
}
