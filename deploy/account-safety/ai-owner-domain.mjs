/** Pure, bounded SQL005 wire-body construction only. This is NOT a Root
 * verifier, signer, owner-registration check, admission, generation lease,
 * publisher, SQL connector or authority factory. No IDs, references, pins or
 * positive evidence are manufactured here. The Root common boundary MUST
 * independently verify the complete transition, including its reference,
 * current policy/enrollment, custody, continuity and exclusive maintenance
 * lease, before invoking this helper. Database flags/facts are not authority.
 *
 * The previous observation must be fresh, match the independently supplied
 * snapshot and pins, and be consistently active or quarantined. Accepting a
 * quarantined observation does not approve an active transition. Only the
 * verified Root transition can request that mode. SQL005 repeats CAS, store,
 * generation and expiry checks under its actual database locks. A known
 * commit then requires a new independent read/verification before admission.
 */
import {types} from 'node:util';
// Root's flat, custody-checked installation (and the isolated test staging)
// supplies the actual deploy/ai-router module at this fixed sibling name.
import {
  parseAiCheckpointRequest,
  validateAiCheckpointFacts,
  matchAiCheckpointPolicy,
} from './checkpoint-facts.mjs';

export class AiOwnerDomainError extends Error {
  constructor() {
    super('AI_ROUTER_OWNER_TRANSITION_INVALID');
    this.name = 'AiOwnerDomainError';
  }
}

const need = value => { if (!value) throw new AiOwnerDomainError(); };
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const generation = value => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
const transitionKeys = [
  'contractVersion', 'owner', 'scope', 'storeIncarnation', 'expectedSnapshot',
  'expectedSchemaFingerprint', 'expectedPrivilegeFingerprint', 'checkpointId',
  'generation', 'identityReviewed', 'replayReady', 'costPolicy',
  'proofValidUntilUTC', 'rootRecordRef',
];

function exact(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === names.length && names.every(name => keys.includes(name)) && keys.every(name => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return typeof name === 'string' && descriptor?.enumerable && 'value' in descriptor;
  });
}

function canonicalUTC(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/**
 * @param {{contractVersion:'sim-ai-owner-transition-v1', owner:'sim_ai_router',
 * scope:'cop_router_primary_database', storeIncarnation:string,
 * expectedSnapshot:{checkpointId:string,generation:string,operationDigest:string,schemaDigest:string},
 * expectedSchemaFingerprint:string, expectedPrivilegeFingerprint:string,
 * checkpointId:string,generation:string,identityReviewed:boolean,replayReady:boolean,
 * costPolicy:'aggregate-costs-current-month-v1'|'pending_requires_review',
 * proofValidUntilUTC:string,rootRecordRef:{recordId:string,digest:string}}} transition
 * A structurally typed transition already independently verified by Root, not
 * an application-provided assertion. Expected pins MUST NOT be copied from
 * the target observation. This helper cannot establish their real provenance.
 * @param {unknown} previousFacts Actual SQL004 observation; never amended to
 * make its flags/snapshot/pins pass. It is validated through the fixed sibling
 * module, not through an injected parser or application callback.
 * @param {number} now One finite integer millisecond observation time. Root
 * supplies its fixed current clock, not an app-selected time or callback;
 * Date.now() is only the pure helper's default, not a clock trust decision.
 * @returns {Readonly<object>} Exact copied/frozen SQL005 JSON body, without
 * an admission, readiness claim or any other authority-bearing wrapper.
 */
export function buildAiRootCheckpointBody(transition, previousFacts, now = Date.now()) {
  try {
    need(Number.isSafeInteger(now) && Number.isFinite(new Date(now).getTime()));
    need(exact(transition, transitionKeys));
    need(transition.contractVersion === 'sim-ai-owner-transition-v1' &&
      transition.owner === 'sim_ai_router' && transition.scope === 'cop_router_primary_database');
    need(uuid(transition.storeIncarnation) && uuid(transition.checkpointId) &&
      hex(transition.expectedSchemaFingerprint) && hex(transition.expectedPrivilegeFingerprint) &&
      generation(transition.generation));
    need(exact(transition.rootRecordRef, ['recordId', 'digest']) &&
      uuid(transition.rootRecordRef.recordId) && hex(transition.rootRecordRef.digest));
    need(typeof transition.identityReviewed === 'boolean' && typeof transition.replayReady === 'boolean');
    const active = transition.identityReviewed && transition.replayReady &&
      transition.costPolicy === 'aggregate-costs-current-month-v1';
    const quarantine = !transition.identityReviewed && !transition.replayReady &&
      transition.costPolicy === 'pending_requires_review';
    need(active || quarantine);
    need(canonicalUTC(transition.proofValidUntilUTC));
    const expires = Date.parse(transition.proofValidUntilUTC);
    need(expires > now && expires - now <= 30000);

    const request = parseAiCheckpointRequest({
      owner: transition.owner,
      scope: transition.scope,
      purpose: 'checkpoint',
      expectedSnapshot: transition.expectedSnapshot,
    });
    const expectedGeneration = BigInt(request.expectedSnapshot.generation);
    need(expectedGeneration < 9223372036854775807n && BigInt(transition.generation) === expectedGeneration + 1n);
    const checked = validateAiCheckpointFacts(previousFacts, request);
    const observed = Date.parse(checked.observedAtUTC);
    need(observed <= now && now - observed <= 5000);
    need(checked.storeIncarnation === transition.storeIncarnation && checked.checkpoint !== null && checked.snapshotMatches);
    need(checked.schema.ready && checked.schema.fingerprint === transition.expectedSchemaFingerprint &&
      checked.permissions.runtimeProfileMatches && checked.permissions.fingerprint === transition.expectedPrivilegeFingerprint);
    const previous = checked.checkpoint;
    const previousActive = previous.identity_reviewed && previous.replay_ready &&
      previous.cost_policy === 'aggregate-costs-current-month-v1';
    const previousQuarantine = !previous.identity_reviewed && !previous.replay_ready &&
      previous.cost_policy === 'pending_requires_review';
    need(previousActive || previousQuarantine);
    if (previousActive) {
      matchAiCheckpointPolicy(checked, request, {
        storeIncarnation: transition.storeIncarnation,
        schemaFingerprint: transition.expectedSchemaFingerprint,
        privilegeFingerprint: transition.expectedPrivilegeFingerprint,
        costPolicy: 'aggregate-costs-current-month-v1',
      }, now);
    } else {
      // Actual SQL004 couples costRetentionReady to the active cost policy.
      // Do not rewrite quarantine facts or call them an approved activation.
      need(checked.invariants.rlsEnabled && checked.invariants.fencesReady &&
        checked.invariants.financialViewsReady && checked.invariants.costRetentionReady === false);
    }

    const rootRecordRef = Object.freeze({
      recordId: transition.rootRecordRef.recordId,
      digest: transition.rootRecordRef.digest,
    });
    return Object.freeze({
      contractVersion: 'sim-ai-root-checkpoint-v1',
      owner: transition.owner,
      scope: transition.scope,
      storeIncarnation: transition.storeIncarnation,
      expectedCheckpointId: request.expectedSnapshot.checkpointId,
      expectedGeneration: request.expectedSnapshot.generation,
      checkpointId: transition.checkpointId,
      generation: transition.generation,
      proofValidUntilUTC: transition.proofValidUntilUTC,
      rootRecordRef,
      identityReviewed: transition.identityReviewed,
      replayReady: transition.replayReady,
      costPolicy: transition.costPolicy,
    });
  } catch {
    // Imported validation and hostile inputs must not expose source values,
    // getters, references, credentials or raw provider/database diagnostics.
    throw new AiOwnerDomainError();
  }
}
