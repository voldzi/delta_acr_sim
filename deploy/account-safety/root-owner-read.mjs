/**
 * Fixed Root-only owner read composition. Install only beside the actual COP
 * root-owner-authority implementation and the reviewed readers/pure modules in
 * /opt/cop-account-safety. An ABI declaration is not authority; missing common
 * code fails import. No callback, injected verifier, environment/path selector,
 * application-selected permit UUID, delivery issuer or historical actor journal.
 * Common owns current independent policy proofs, custody, ephemeral tmpfs paths
 * and the held lease. The existing final readers own actual SQL/crypto readback.
 */
import { randomUUID } from 'node:crypto';
import { requireCurrentOwner, issueOwnerEphemeralRecord } from './root-owner-authority.mjs';
import { canonical, exact, hex, uuid, sha256, requireGuard, requireRootCodeTree, verifyRootRecord } from './root-records.mjs';
import { parseDriverReadRequest, driverReadRequestDigest } from './read-admission-facts.mjs';
import { parseAiCheckpointRequest, aiCheckpointRequestDigest } from './checkpoint-facts.mjs';
import { inspectRootDriver } from './root-read-admission.mjs';
import { inspectRootAiCheckpoint } from './root-checkpoint-read.mjs';

const ROOT = '/opt/cop-account-safety', COST = 'aggregate-costs-current-month-v1';
const BASE = ['contractVersion', 'kind', 'recordId', 'issuedAt', 'expiresAt'];
const CONTEXT = ['contractVersion', 'owner', 'scope', 'purpose', 'registration', 'peer', 'guardStoreId', 'continuityEpoch',
  'protectedConfigId', 'datasetBindingId', 'runtimeBindingId', 'sourceProofId', 'policyGeneration', 'frontierSequence',
  'frontierDigest', 'storeIncarnation', 'expiresAtUTC', 'reference', 'rootPolicy', 'keys', 'assertCurrent', 'close'];
const POLICY = ['contractVersion', 'reference', 'identityEvidenceRef', 'retentionEvidenceRef', 'schemaEvidenceRef',
  'privilegeEvidenceRef', 'schemaFingerprint', 'privilegeFingerprint', 'owner', 'scope'];
const BINDING = ['readPermitId', 'requestDigest', 'owner', 'scope', 'guardStoreId', 'continuityEpoch',
  'datasetBindingId', 'runtimeBindingId', 'sourceProofId', 'storeIncarnation', 'policyGeneration', 'frontierSequence', 'frontierDigest'];
const LIVE_BINDING = ['guardStoreId', 'continuityEpoch', 'datasetBindingId', 'runtimeBindingId', 'sourceProofId',
  'policyGeneration', 'frontierSequence', 'frontierDigest', 'storeIncarnation'];
const ADMISSION_FIELDS = ['readPermitId', 'readPermitDigest', 'request', 'requestDigest', ...LIVE_BINDING,
  'schemaFingerprint', 'privilegeFingerprint', 'factsDigest', 'peer', 'clientRegistrationRef'];
const DRIVER_DECISIONS = Object.freeze({ 'driver-read-identity': 'cop-jizda-owned-sim-preserved',
  'driver-read-retention': 'bounded-read-permitted', 'driver-read-report': 'verified-report-inventory',
  'driver-read-schema': 'exact-read-facts-policy-verified' });
const AI_DECISIONS = Object.freeze({ 'ai-router-read-identity': 'sim-preserved-cop-owned',
  'ai-router-read-retention': COST, 'ai-router-read-cost': 'financial-caps-preserved',
  'ai-router-read-schema': 'exact-checkpoint-policy-verified' });
const ref = value => exact(value, ['recordId', 'digest']) && uuid(value.recordId) && hex(value.digest);
const timestamp = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value); return Number.isFinite(time) && new Date(time).toISOString() === value;
};
const peerValid = value => exact(value, ['device', 'inode', 'uid', 'gid']) &&
  typeof value.device === 'string' && /^[0-9]{1,20}$/.test(value.device) &&
  typeof value.inode === 'string' && /^[0-9]{1,20}$/.test(value.inode) && value.inode !== '0' &&
  Number.isSafeInteger(value.uid) && value.uid >= 0 && Number.isSafeInteger(value.gid) && value.gid >= 0;
const copy = value => JSON.parse(canonical(value));
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function rootOnly(peer) {
  requireGuard(process.getuid?.() === 0 && process.geteuid?.() === 0, 'ROOT_EXECUTION_REQUIRED');
  requireRootCodeTree(ROOT); requireGuard(peerValid(peer), 'GUARD_OWNER_READ_PEER');
}
function contextState(ctx, owner, purpose, peer) {
  const scope = owner === 'sim_driver_measurements' ? 'online_driver_scope' : 'cop_router_primary_database';
  requireGuard(exact(ctx, CONTEXT) && ctx.contractVersion === 'cop-root-owner-authority-v1' &&
    ctx.owner === owner && ctx.scope === scope && ctx.purpose === purpose && peerValid(ctx.peer) && canonical(ctx.peer) === canonical(peer) &&
    typeof ctx.assertCurrent === 'function' && typeof ctx.close === 'function' && ref(ctx.reference) &&
    [ctx.guardStoreId, ctx.continuityEpoch, ctx.protectedConfigId, ctx.datasetBindingId, ctx.runtimeBindingId, ctx.sourceProofId, ctx.storeIncarnation].every(uuid) &&
    Number.isSafeInteger(ctx.policyGeneration) && ctx.policyGeneration > 0 && Number.isSafeInteger(ctx.frontierSequence) && ctx.frontierSequence >= 0 &&
    hex(ctx.frontierDigest) && timestamp(ctx.expiresAtUTC) && Date.parse(ctx.expiresAtUTC) > Date.now() &&
    ctx.registration && Object.getPrototypeOf(ctx.registration) === Object.prototype, 'GUARD_OWNER_READ_AUTHORITY');
  const p = ctx.rootPolicy;
  const names = owner === 'sim_driver_measurements' ? [...POLICY, 'expectedCheckpointHash', 'reportProtection', 'reportPolicyRef'] :
    [...POLICY, 'costPolicy', 'costEvidenceRef', 'expectedSnapshot'];
  requireGuard((exact(p, names) || exact(p, [...names, 'transition'])) && p.contractVersion === 'cop-root-owner-policy-v1' &&
    p.owner === owner && p.scope === scope && hex(p.schemaFingerprint) && hex(p.privilegeFingerprint) &&
    ['reference', 'identityEvidenceRef', 'retentionEvidenceRef', 'schemaEvidenceRef', 'privilegeEvidenceRef'].every(k => ref(p[k])),
  'GUARD_OWNER_READ_POLICY');
  if (owner === 'sim_driver_measurements') requireGuard(hex(p.expectedCheckpointHash) &&
    ['no_report', 'enforced_single_writer', 'shared_generation_fence'].includes(p.reportProtection) && ref(p.reportPolicyRef), 'GUARD_OWNER_READ_DRIVER_POLICY');
  else {
    requireGuard(p.costPolicy === COST && ref(p.costEvidenceRef), 'GUARD_OWNER_READ_AI_POLICY');
    parseAiCheckpointRequest({ owner, scope, purpose: 'checkpoint', expectedSnapshot: p.expectedSnapshot });
  }
  // Immutable local comparison only. The actual common implementation, never
  // this copied object, is the authority passed back to signing/current checks.
  return copy(Object.fromEntries(CONTEXT.filter(k => k !== 'assertCurrent' && k !== 'close').map(k => [k, ctx[k]])));
}
async function current(ctx, state, purpose, peer) {
  await ctx.assertCurrent();
  requireGuard(canonical(contextState(ctx, state.owner, purpose, peer)) === canonical(state), 'GUARD_OWNER_READ_CONTEXT_CHANGED');
}
function checkedRecord(bytes, keys, kind, state) {
  const r = verifyRootRecord(bytes, keys, kind), p = r.payload;
  requireGuard(Date.parse(p.expiresAt) - Date.parse(p.issuedAt) <= 5000 &&
    Date.parse(p.expiresAt) <= Date.parse(state.expiresAtUTC), 'GUARD_OWNER_READ_RECORD_LIFETIME');
  return r;
}
async function issue(ctx, state, purpose, peer, kind, facts, recordId = randomUUID()) {
  await current(ctx, state, purpose, peer);
  requireGuard(uuid(recordId) && !BASE.some(k => Object.hasOwn(facts, k)), 'GUARD_OWNER_READ_ISSUE_INPUT');
  // Common chooses the fixed private ephemeral directory and <=5s lifetime;
  // this wrapper never writes files or repairs/clamps a nonconforming record.
  const issued = await issueOwnerEphemeralRecord(ctx, kind, freeze(copy(facts)), recordId);
  requireGuard(exact(issued, ['recordId', 'digest', 'bytes']) && ref({ recordId: issued.recordId, digest: issued.digest }) &&
    issued.bytes instanceof Uint8Array && issued.bytes.byteLength > 0 && issued.bytes.byteLength <= 65_536, 'GUARD_OWNER_READ_ISSUED_REFERENCE');
  const bytes = Buffer.from(issued.bytes), checked = checkedRecord(bytes, state.keys, kind, state), p = checked.payload;
  requireGuard(issued.recordId === recordId && p.recordId === recordId && issued.digest === sha256(bytes) && issued.digest === checked.digest &&
    exact(p, [...BASE, ...Object.keys(facts)]) && Object.keys(facts).every(k => canonical(p[k]) === canonical(facts[k])), 'GUARD_OWNER_READ_ISSUED_PAYLOAD');
  await current(ctx, state, purpose, peer);
  return Object.freeze({ recordId, digest: checked.digest });
}
function binding(state, request, readPermitId, requestDigest) {
  const result = { readPermitId, requestDigest, owner: request.owner, scope: request.scope,
    ...Object.fromEntries(BINDING.slice(4).map(k => [k, state[k]])) };
  requireGuard(exact(result, BINDING), 'GUARD_OWNER_READ_BINDING'); return freeze(result);
}
async function evidence(ctx, state, purpose, peer, bound, decisions, extra = {}) {
  const refs = {};
  for (const [kind, decision] of Object.entries(decisions)) refs[kind] = await issue(ctx, state, purpose, peer, kind, { ...bound, ...extra, decision });
  return freeze(refs);
}
function checkAdmission(out, state, request, readPermitId, permitRef, inventoryRef) {
  requireGuard(exact(out, ['admission', 'record']) && typeof out.record === 'string', 'GUARD_OWNER_READ_RESULT');
  const driver = state.owner === 'sim_driver_measurements', bytes = Buffer.from(out.record, 'utf8');
  const r = checkedRecord(bytes, state.keys, driver ? 'driver-read-admission' : 'ai-router-read-admission', state), p = r.payload;
  const fields = driver ? [...ADMISSION_FIELDS, 'checkpointHash', 'reportProtection', 'reportInventoryRef', 'operationDigest'] : [...ADMISSION_FIELDS, 'costPolicy'];
  requireGuard(exact(p, [...BASE, ...fields]) && p.readPermitId === readPermitId && p.readPermitDigest === permitRef.digest &&
    p.requestDigest === (driver ? driverReadRequestDigest(request) : aiCheckpointRequestDigest(request)) && canonical(p.request) === canonical(request) &&
    LIVE_BINDING.every(k => p[k] === state[k]) && p.schemaFingerprint === state.rootPolicy.schemaFingerprint &&
    p.privilegeFingerprint === state.rootPolicy.privilegeFingerprint && hex(p.factsDigest) && canonical(p.peer) === canonical(state.peer) && ref(p.clientRegistrationRef),
  'GUARD_OWNER_READ_ADMISSION_BINDING');
  const admission = out.admission;
  requireGuard(admission && ref(admission.reference) && admission.reference.recordId === p.recordId && admission.reference.digest === r.digest,
    'GUARD_OWNER_READ_ADMISSION_REFERENCE');
  if (driver) requireGuard(exact(admission, ['contractVersion', ...Object.keys(request), 'checkpointHash', 'reportProtection', 'reference']) &&
    admission.contractVersion === 'sim-driver-guarded-read-admission-v1' && Object.keys(request).every(k => canonical(admission[k]) === canonical(request[k])) &&
    p.checkpointHash === state.rootPolicy.expectedCheckpointHash && p.reportProtection === state.rootPolicy.reportProtection &&
    admission.checkpointHash === p.checkpointHash && admission.reportProtection === p.reportProtection &&
    canonical(p.reportInventoryRef) === canonical(inventoryRef) && (p.operationDigest === null || hex(p.operationDigest)) &&
    (request.purpose !== 'receipt' || hex(p.operationDigest)), 'GUARD_OWNER_READ_DRIVER_ADMISSION');
  else requireGuard(exact(admission, ['contractVersion', 'request', 'reference']) && admission.contractVersion === 'sim-ai-router-checkpoint-admission-v1' &&
    canonical(admission.request) === canonical(request) && p.costPolicy === state.rootPolicy.costPolicy, 'GUARD_OWNER_READ_AI_ADMISSION');
  return freeze({ admission: copy(admission), record: out.record, readPermitId });
}
async function inspect(peer, request, owner, purpose) {
  const ctx = await requireCurrentOwner(owner, peer, purpose);
  let output, state, permitRef, inventoryRef, readPermitId;
  try {
    readPermitId = randomUUID();
    state = freeze(contextState(ctx, owner, purpose, peer));
    await current(ctx, state, purpose, peer);
    if (owner === 'sim_ai_router') requireGuard(canonical(request.expectedSnapshot) === canonical(state.rootPolicy.expectedSnapshot), 'GUARD_OWNER_READ_AI_SNAPSHOT');
    const driver = owner === 'sim_driver_measurements', requestDigest = driver ? driverReadRequestDigest(request) : aiCheckpointRequestDigest(request);
    const bound = binding(state, request, readPermitId, requestDigest), p = state.rootPolicy;
    const refs = await evidence(ctx, state, purpose, peer, bound, driver ? DRIVER_DECISIONS : AI_DECISIONS, driver ? {} : { costPolicy: p.costPolicy });
    if (driver) inventoryRef = await issue(ctx, state, purpose, peer, 'driver-report-inventory', { ...bound,
      reportProtection: p.reportProtection, checkpointHash: p.expectedCheckpointHash, schemaFingerprint: p.schemaFingerprint,
      privilegeFingerprint: p.privilegeFingerprint, decision: p.reportProtection === 'no_report' ? 'verified-no-derived-publication' : 'verified-derived-barrier' });
    permitRef = await issue(ctx, state, purpose, peer, driver ? 'driver-read-permit' : 'ai-router-read-permit', {
      request, requestDigest, ...Object.fromEntries(LIVE_BINDING.map(k => [k, state[k]])),
      expectedSchemaFingerprint: p.schemaFingerprint, expectedPrivilegeFingerprint: p.privilegeFingerprint,
      ...(driver ? { expectedCheckpointHash: p.expectedCheckpointHash, reportProtection: p.reportProtection, reportInventoryRef: inventoryRef } : { costPolicy: p.costPolicy }),
      evidence: refs
    }, readPermitId);
    await current(ctx, state, purpose, peer);
    output = driver ? await inspectRootDriver(readPermitId, request, peer) : await inspectRootAiCheckpoint(readPermitId, request, peer);
    await current(ctx, state, purpose, peer);
    checkAdmission(output, state, request, readPermitId, permitRef, inventoryRef);
  } finally {
    // No TTL/error swallow can substitute for actual common lease settlement.
    await ctx.close();
  }
  // close() may itself take time. Recheck the original signed result's expiry
  // after settlement; never extend/re-sign an admission that expired meanwhile.
  return checkAdmission(output, state, request, readPermitId, permitRef, inventoryRef);
}

export async function inspectRootDriverOwner(kernelPeer, input) {
  rootOnly(kernelPeer); const peer = freeze(copy(kernelPeer));
  return inspect(peer, parseDriverReadRequest(input), 'sim_driver_measurements', 'read');
}
export async function inspectRootAiOwner(kernelPeer, input) {
  rootOnly(kernelPeer); const peer = freeze(copy(kernelPeer));
  return inspect(peer, parseAiCheckpointRequest(input), 'sim_ai_router', 'checkpoint-read');
}
