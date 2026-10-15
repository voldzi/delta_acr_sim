/** Installed beside COP's pinned Root helpers in /opt/cop-account-safety.
 * Only the native Root broker calls this with its kernel-observed peer and a
 * permit selected from protected ai-read-deliveries. No application-selected
 * permit UUID, HTTP identity, callback, DSN, path or environment flag is trusted.
 * No actor lookup, SQL writer, checkpoint adoption, origin probe or durable
 * per-read journal is supplied here. This is an owner-wide checkpoint reader. */
import { createRequire } from 'node:module';
import { createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkServerIdentity } from 'node:tls';
import { join } from 'node:path';
import { canonical, canonicalJson, exact, hex, uuid, sha256, requireGuard, readRootFile,
  requireRootCodeTree, verifyRootRecord } from './root-records.mjs';
import { parseAiCheckpointRequest, aiCheckpointRequestDigest, matchAiCheckpointPolicy } from './checkpoint-facts.mjs';

const ETC = '/etc/cop-account-safety', STATE = '/var/lib/cop-account-safety';
const BASE = ['contractVersion', 'kind', 'recordId', 'issuedAt', 'expiresAt'];
const COST_POLICY = 'aggregate-costs-current-month-v1';
const EVIDENCE = ['ai-router-read-identity', 'ai-router-read-retention', 'ai-router-read-cost', 'ai-router-read-schema'];
const BINDING = ['readPermitId', 'requestDigest', 'owner', 'scope', 'guardStoreId', 'continuityEpoch',
  'datasetBindingId', 'runtimeBindingId', 'sourceProofId', 'storeIncarnation', 'policyGeneration', 'frontierSequence', 'frontierDigest'];
const SQL = `SELECT row_to_json(i) AS identity,row_to_json(p) AS policy,row_to_json(d) AS dataset,
 row_to_json(b) AS runtime,row_to_json(a) AS proof,
 coalesce((SELECT sequence::text FROM cop_guard.fence_journal ORDER BY sequence DESC LIMIT 1),'0') AS frontier_sequence,
 coalesce((SELECT entry_digest FROM cop_guard.fence_journal ORDER BY sequence DESC LIMIT 1),i.initial_prefix_digest) AS frontier_digest,
 (SELECT system_identifier::text FROM pg_control_system()) AS cluster_id,
 (SELECT timeline_id FROM pg_control_checkpoint()) AS timeline_id,
 (a.observed_at<=clock_timestamp() AND a.issued_at<=clock_timestamp() AND a.valid_until>clock_timestamp()) AS proof_current
 FROM cop_guard.guard_identity i
 JOIN cop_guard.policies p ON p.guard_store_id=i.guard_store_id AND
 p.policy_generation=(SELECT max(policy_generation) FROM cop_guard.policies)
 JOIN cop_guard.dataset_bindings d ON d.dataset_binding_id=$1::uuid AND d.guard_store_id=i.guard_store_id
 JOIN cop_guard.runtime_bindings b ON b.binding_id=$2::uuid AND b.dataset_binding_id=d.dataset_binding_id
 JOIN cop_guard.accepted_runtime_proofs a ON a.proof_id=$3::uuid AND a.binding_id=b.binding_id
 WHERE i.singleton AND d.owner_id='sim_ai_router' AND b.owner_id=d.owner_id`;
const ref = value => exact(value, ['recordId', 'digest']) && uuid(value.recordId) && hex(value.digest);
const boot = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

function profile(name, database, user) {
  const p = canonicalJson(readRootFile(join(ETC, 'root', name + '.json'), { secret: true }));
  requireGuard(exact(p, ['contractVersion', 'host', 'port', 'database', 'user', 'password', 'serverName', 'caFile']) &&
    p.contractVersion === 'cop-root-postgres-profile-v1' && p.database === database &&
    typeof p.host === 'string' && /^[A-Za-z0-9.-]{1,253}$/.test(p.host) && Number.isSafeInteger(p.port) && p.port > 0 && p.port <= 65535 &&
    typeof p.user === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(p.user) && (!user || p.user === user) &&
    typeof p.password === 'string' && p.password.length >= 32 && typeof p.serverName === 'string' &&
    /^[A-Za-z0-9.-]{1,253}$/.test(p.serverName) && p.caFile === join(ETC, 'public', 'postgres-ca.crt'), 'GUARD_DATABASE_PROFILE');
  const ca = readRootFile(p.caFile).toString('utf8');
  return { host: p.host, port: p.port, database: p.database, user: p.user, password: p.password,
    ssl: { ca, rejectUnauthorized: true, servername: p.serverName,
      checkServerIdentity: (_host, certificate) => checkServerIdentity(p.serverName, certificate) },
    connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000, application_name: 'cop-root-ai-checkpoint-read-v1' };
}
function peerRegistration(peer, keys) {
  requireGuard(exact(peer, ['device', 'inode', 'uid', 'gid']) && /^[0-9]{1,20}$/.test(peer.device) &&
    /^[0-9]{1,20}$/.test(peer.inode) && peer.inode !== '0' && Number.isSafeInteger(peer.uid) && peer.uid >= 0 &&
    Number.isSafeInteger(peer.gid) && peer.gid >= 0, 'GUARD_CLIENT_PEER');
  const r = verifyRootRecord(readRootFile(join(STATE, 'ai-clients', peer.device + '-' + peer.inode + '.json'), { secret: true }), keys,
    'ai-router-client-registration');
  const p = r.payload;
  requireGuard(exact(p, [...BASE, 'peer', 'runtimeBindingId', 'datasetBindingId', 'guardStoreId', 'continuityEpoch',
    'imageId', 'sourceRevision', 'machineBootId']) && canonical(p.peer) === canonical(peer) && uuid(p.runtimeBindingId) &&
    uuid(p.datasetBindingId) && uuid(p.guardStoreId) && uuid(p.continuityEpoch) && /^sha256:[0-9a-f]{64}$/.test(p.imageId) &&
    /^[0-9a-f]{40}$/.test(p.sourceRevision) && p.machineBootId === boot(), 'GUARD_CLIENT_REGISTRATION');
  return r;
}
function readPermit(id, request, keys) {
  const r = verifyRootRecord(readRootFile(join(STATE, 'ai-read-permits', id + '.json'), { secret: true }), keys, 'ai-router-read-permit');
  const p = r.payload;
  requireGuard(exact(p, [...BASE, 'request', 'requestDigest', 'guardStoreId', 'continuityEpoch', 'datasetBindingId', 'runtimeBindingId',
    'sourceProofId', 'policyGeneration', 'frontierSequence', 'frontierDigest', 'storeIncarnation',
    'expectedSchemaFingerprint', 'expectedPrivilegeFingerprint', 'costPolicy', 'evidence']) &&
    p.recordId === id && canonical(parseAiCheckpointRequest(p.request)) === canonical(request) && p.requestDigest === aiCheckpointRequestDigest(request) &&
    [p.guardStoreId, p.continuityEpoch, p.datasetBindingId, p.runtimeBindingId, p.sourceProofId, p.storeIncarnation].every(uuid) &&
    Number.isSafeInteger(p.policyGeneration) && p.policyGeneration > 0 && Number.isSafeInteger(p.frontierSequence) && p.frontierSequence >= 0 &&
    [p.frontierDigest, p.expectedSchemaFingerprint, p.expectedPrivilegeFingerprint].every(hex) &&
    p.costPolicy === COST_POLICY && exact(p.evidence, EVIDENCE), 'GUARD_AI_READ_PERMIT');
  return r;
}
function signedEvidence(p, keys) {
  const binding = { readPermitId: p.recordId, requestDigest: p.requestDigest, owner: p.request.owner, scope: p.request.scope,
    ...Object.fromEntries(BINDING.slice(4).map(k => [k, p[k]])) };
  let expiresAt = Date.parse(p.expiresAt);
  for (const kind of EVIDENCE) {
    const link = p.evidence[kind]; requireGuard(ref(link), 'GUARD_AI_READ_EVIDENCE_REFERENCE');
    const r = verifyRootRecord(readRootFile(join(STATE, 'evidence', link.recordId + '.json'), { secret: true }), keys, kind);
    requireGuard(r.digest === link.digest && r.payload.recordId === link.recordId &&
      exact(r.payload, [...BASE, ...BINDING, 'costPolicy', 'decision']) && BINDING.every(k => r.payload[k] === binding[k]) &&
      r.payload.costPolicy === p.costPolicy && r.payload.decision === ({
        'ai-router-read-identity': 'sim-preserved-cop-owned',
        'ai-router-read-retention': 'aggregate-costs-current-month-v1',
        'ai-router-read-cost': 'financial-caps-preserved',
        'ai-router-read-schema': 'exact-checkpoint-policy-verified',
      })[kind], 'GUARD_AI_READ_EVIDENCE_BINDING');
    expiresAt = Math.min(expiresAt, Date.parse(r.payload.expiresAt));
  }
  return expiresAt;
}
async function current(metadata, permitRecord, request, peer, keys) {
  const reread = readPermit(permitRecord.payload.recordId, request, keys), p = reread.payload;
  requireGuard(reread.digest === permitRecord.digest, 'GUARD_AI_READ_PERMIT_CHANGED');
  const registration = peerRegistration(peer, keys), c = registration.payload;
  requireGuard(c.runtimeBindingId === p.runtimeBindingId && c.datasetBindingId === p.datasetBindingId &&
    c.guardStoreId === p.guardStoreId && c.continuityEpoch === p.continuityEpoch, 'GUARD_CLIENT_BINDING');
  const anchor = verifyRootRecord(readRootFile(join(STATE, 'authority', 'current-frontier.json'), { secret: true }), keys, 'current-frontier');
  const a = anchor.payload;
  requireGuard(exact(a, [...BASE, 'guardStoreId', 'continuityEpoch', 'sequence', 'digest', 'machineBootId', 'clusterId', 'timelineId']) &&
    a.guardStoreId === p.guardStoreId && a.continuityEpoch === p.continuityEpoch && a.sequence === p.frontierSequence && a.digest === p.frontierDigest &&
    uuid(a.machineBootId) && a.machineBootId === boot() && typeof a.clusterId === 'string' && /^[0-9]{1,20}$/.test(a.clusterId) &&
    Number.isSafeInteger(a.timelineId) && a.timelineId > 0 && Date.parse(a.expiresAt) - Date.parse(a.issuedAt) <= 30_000, 'GUARD_FRONTIER_BINDING');
  const evidenceExpiry = signedEvidence(p, keys);
  const result = await metadata.query(SQL, [p.datasetBindingId, p.runtimeBindingId, p.sourceProofId]);
  requireGuard(result.rows.length === 1, 'GUARD_REGISTRY_UNAVAILABLE');
  const r = result.rows[0];
  // COP-confirmed registry policy and AI projection contracts.
  requireGuard(r.identity?.application_id === 'cop' && r.identity.guard_contract_version === 'cop-account-safety-runtime-v1' &&
    r.identity.stream_scope_id === 'cop-global-fences-v1' && r.identity.guard_store_id === p.guardStoreId &&
    r.policy?.policy_id === 'cop-jizda-only-sim-preserved-v1' && r.policy.continuity_epoch === p.continuityEpoch &&
    String(r.policy.policy_generation) === String(p.policyGeneration) && r.dataset?.projection_contract_id === 'cop-sim-ai-projection-v1' &&
    r.dataset.continuity_epoch === p.continuityEpoch && r.dataset.target_incarnation_id === p.storeIncarnation &&
    r.runtime?.dataset_binding_id === p.datasetBindingId && r.runtime.binding_id === p.runtimeBindingId &&
    String(r.runtime.policy_generation) === String(p.policyGeneration) && r.runtime.image_id === c.imageId && r.runtime.source_revision === c.sourceRevision &&
    r.proof?.binding_id === p.runtimeBindingId && r.proof.proof_id === p.sourceProofId && r.proof_current === true &&
    String(r.proof.frontier_sequence) === String(p.frontierSequence) && r.proof.frontier_digest === p.frontierDigest &&
    r.frontier_sequence === String(p.frontierSequence) && r.frontier_digest === p.frontierDigest && r.cluster_id === a.clusterId &&
    r.timeline_id === a.timelineId, 'GUARD_AI_READ_REGISTRY_MISMATCH');
  const proofExpiry = Date.parse(r.proof.valid_until);
  requireGuard(Number.isFinite(proofExpiry) && proofExpiry > Date.now(), 'GUARD_AI_READ_PROOF_EXPIRED');
  return { registration, expiresAt: Math.min(evidenceExpiry, Date.parse(c.expiresAt), Date.parse(a.expiresAt), proofExpiry) };
}
function issue(permit, request, facts, peer, authority, keys, keysBytes) {
  // Use the SAME trust set that verified the permit/evidence/registry. Never
  // sign a new-key admission over evidence accepted by an already revoked set.
  requireGuard(sha256(readRootFile(join(ETC, 'public', 'verification-keys.json'))) === sha256(keysBytes), 'GUARD_KEYRING_CHANGED');
  const signingPath = join(STATE, 'authority', 'signing-key.pkcs8');
  const signingBytes = readRootFile(signingPath, { secret: true });
  const key = createPrivateKey(signingBytes);
  requireGuard(key.asymmetricKeyType === 'ed25519', 'GUARD_SIGNING_KEY');
  const pub = createPublicKey(key).export({ format: 'jwk' });
  const matches = keys.keys?.filter(k => k.kty === 'OKP' && k.crv === 'Ed25519' && k.x === pub.x);
  requireGuard(matches?.length === 1, 'GUARD_SIGNING_KEY');
  const now = Date.now(), expires = Math.min(now + 5000, authority.expiresAt, Date.parse(facts.observedAtUTC) + 5000);
  requireGuard(expires > now, 'GUARD_AI_READ_EXPIRED');
  const recordId = randomUUID(), p = permit.payload;
  const payload = { contractVersion: 'cop-root-record-v1', kind: 'ai-router-read-admission', recordId,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(expires).toISOString(), readPermitId: p.recordId, readPermitDigest: permit.digest,
    request, requestDigest: p.requestDigest, guardStoreId: p.guardStoreId, continuityEpoch: p.continuityEpoch,
    datasetBindingId: p.datasetBindingId, runtimeBindingId: p.runtimeBindingId, sourceProofId: p.sourceProofId,
    policyGeneration: p.policyGeneration, frontierSequence: p.frontierSequence, frontierDigest: p.frontierDigest,
    storeIncarnation: p.storeIncarnation, schemaFingerprint: facts.schema.fingerprint, privilegeFingerprint: facts.permissions.fingerprint,
    costPolicy: p.costPolicy, factsDigest: sha256(canonical(facts)), peer,
    clientRegistrationRef: { recordId: authority.registration.payload.recordId, digest: authority.registration.digest } };
  const bytes = Buffer.from(canonical({ keyId: matches[0].kid, payload,
    signature: sign(null, Buffer.from(canonical(payload)), key).toString('base64url') }) + '\n');
  verifyRootRecord(bytes, keys, 'ai-router-read-admission');
  requireGuard(sha256(readRootFile(join(ETC, 'public', 'verification-keys.json'))) === sha256(keysBytes) &&
    sha256(readRootFile(signingPath, { secret: true })) === sha256(signingBytes), 'GUARD_SIGNING_CONFIGURATION_CHANGED');
  // Inline and short-lived. No application actor/contributor identities or
  // durable per-read delivery/permit/admission files are created by this reader.
  return Object.freeze({ admission: Object.freeze({ contractVersion: 'sim-ai-router-checkpoint-admission-v1', request,
    reference: Object.freeze({ recordId, digest: sha256(bytes) }) }), record: bytes.toString('utf8') });
}

export async function inspectRootAiCheckpoint(readPermitId, input, peer) {
  requireGuard(process.getuid?.() === 0 && process.geteuid?.() === 0 && uuid(readPermitId), 'ROOT_EXECUTION_REQUIRED');
  const request = parseAiCheckpointRequest(input);
  requireRootCodeTree('/opt/cop-account-safety');
  const keysBytes = readRootFile(join(ETC, 'public', 'verification-keys.json')), keys = canonicalJson(keysBytes);
  const permit = readPermit(readPermitId, request, keys);
  peerRegistration(peer, keys);
  const require = createRequire('/opt/cop-account-safety/package.json'), { Client } = require('pg');
  const metadata = new Client(profile('registry-probe', 'cop_account_safety_guard'));
  const target = new Client(profile('ai-router-control', 'sim_ai_router', 'sim_ai_guard_control'));
  const clients = [metadata, target]; for (const c of clients) c.on('error', () => {});
  // The 15-second ceiling remains active through failed-query ROLLBACK/end;
  // neither a silent socket nor cleanup can retain an unbounded positive path.
  const watchdog = setTimeout(() => { for (const c of clients) c.connection?.stream?.destroy(); }, 15_000);
  try {
    for (const c of clients) await c.connect();
    await current(metadata, permit, request, peer, keys);
    await target.query('BEGIN READ ONLY');
    await target.query("SET LOCAL statement_timeout='3000ms'");
    await target.query("SET LOCAL lock_timeout='1000ms'");
    const result = await target.query('SELECT sim_ai_guard_source.read_checkpoint_facts($1::jsonb) AS value', [JSON.stringify(request)]);
    requireGuard(result.rows.length === 1, 'GUARD_AI_READ_FACTS_UNAVAILABLE');
    const p = permit.payload, facts = matchAiCheckpointPolicy(result.rows[0].value, request, { storeIncarnation: p.storeIncarnation,
      schemaFingerprint: p.expectedSchemaFingerprint, privilegeFingerprint: p.expectedPrivilegeFingerprint, costPolicy: p.costPolicy });
    await target.query('COMMIT');
    const authority = await current(metadata, permit, request, peer, keys);
    requireGuard(sha256(readRootFile(join(ETC, 'public', 'verification-keys.json'))) === sha256(keysBytes), 'GUARD_KEYRING_CHANGED');
    return issue(permit, request, facts, peer, authority, keys, keysBytes);
  } finally {
    try {
      await target.query('ROLLBACK').catch(() => {});
      for (const c of clients) await c.end().catch(() => {});
    } finally { clearTimeout(watchdog); }
  }
}
