/**
 * Pure, transient Driver domain preparation ONLY. This is not a Root verifier,
 * owner factory, service authenticator, permit issuer, accountMAC/consent-intent
 * verifier, publication inventory or positive readiness/completion proof.
 *
 * Fixed installation layout: these two siblings are independently built/pinned
 * pure application exports, installed in the reviewed Root-owned code closure.
 * The existing erasure sibling SHA256 is
 * d184e31dda5484d4d8d2382208834197247ff47a1a37437f4f0550fdd95ea999.
 * No environment/path selector, injected authority callback, file, DB, clock or
 * network read occurs here. All secrets/times/metadata below are explicit data;
 * the actual Root plugin must obtain and authorize them independently. A valid
 * HMAC/shape does not prove account ownership, manifest origin or report safety.
 * Returned daily inventory is ephemeral; never log or persist it as a join.
 */
import { types } from 'node:util';
import {
  parseDriverErasureRequest, verifyDriverErasureActor, prepareDriverErasureInput,
  validateDriverErasureCoverage, driverErasureHash
} from './driver-account-erasure.js';
import { verifyDriverRevocationActor } from './driver-revocation-actor.js';

const CONTRACT = 'sim-driver-guarded-db-v1';
const ERASE_KEYS = ['request', 'actor', 'actorSignature', 'hashSecret', 'actorSecret', 'issuer', 'now', 'acceptedAtUTC', 'checkpointHash'];
const CONTEXT_KEYS = ['contractVersion', 'recordId', 'recordDigest', 'storeIncarnation', 'operationDigest', 'readbackDigest', 'reportProtection', 'observedAtUTC'];
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export class DriverOwnerDomainError extends Error {
  constructor() { super('DRIVER_OWNER_DOMAIN_INVALID'); this.name = 'DriverOwnerDomainError'; }
}
const need = condition => { if (!condition) throw new DriverOwnerDomainError(); };
function own(value, names) {
  need(value !== null && typeof value === 'object' && !Array.isArray(value) && !types.isProxy(value));
  const prototype = Object.getPrototypeOf(value);
  need(prototype === null || prototype === Object.prototype);
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  need(keys.length === names.length && names.every(name => keys.includes(name)) && keys.every(name =>
    typeof name === 'string' && descriptors[name]?.enumerable && 'value' in descriptors[name]));
  return Object.fromEntries(names.map(name => [name, descriptors[name].value]));
}
function manifest(value) {
  need(Array.isArray(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype && value.length >= 9 && value.length <= 40);
  const keys = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  need(keys.length === value.length + 1 && keys.every(key => key === 'length' ||
    typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length &&
    descriptors[key]?.enumerable && 'value' in descriptors[key]));
  return Array.from({ length: value.length }, (_, index) => own(descriptors[index].value, ['contributorDay', 'contributorIdDay']));
}
function request(value) {
  const input = own(value, ['contractVersion', 'operationId', 'contributors', 'attestation']);
  return parseDriverErasureRequest({ ...input, contributors: manifest(input.contributors) });
}
function stamp(value) {
  need(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value));
  const time = Date.parse(value);
  need(Number.isFinite(time) && new Date(time).toISOString() === value);
  return time;
}
function clock(value) {
  need(Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime()));
  return value;
}
function credentials(value) {
  need(typeof value.hashSecret === 'string' && value.hashSecret.length >= 32 &&
    typeof value.actorSecret === 'string' && value.actorSecret.length >= 32 &&
    typeof value.issuer === 'string' && value.issuer.length >= 1 && value.issuer.length <= 2048 &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value.issuer));
  clock(value.now);
}
function safe(work) {
  try { return work(); }
  catch { throw new DriverOwnerDomainError(); }
}
function erase(value) {
  credentials(value);
  need(hex(value.checkpointHash));
  const parsed = request(value.request), acceptedAt = stamp(value.acceptedAtUTC);
  const actor = verifyDriverErasureActor(value.actor, value.actorSignature, value.actorSecret, value.issuer, parsed.operationId, value.now);
  const input = prepareDriverErasureInput(parsed, actor, value.hashSecret);
  validateDriverErasureCoverage(input, acceptedAt);
  return Object.freeze({
    contractVersion: CONTRACT,
    operationHash: driverErasureHash(value.hashSecret, 'cop:account-erasure-operation', parsed.operationId),
    actorHash: input.actorHash, requestHash: input.requestHash,
    contributors: Object.freeze(input.contributors.map(row => Object.freeze({ ...row }))),
    checkpointHash: value.checkpointHash
  });
}

/** Signed actor syntax/HMAC is necessary, not proof of Root journal ownership. */
export function prepareDriverRevokeBody(input) {
  return safe(() => {
    const value = own(input, ['request', 'actor', 'actorSignature', 'hashSecret', 'actorSecret', 'issuer', 'now']);
    credentials(value);
    const parsed = own(value.request, ['contractVersion', 'contributorIdDay']);
    need(parsed.contractVersion === 'sim-driver-measurements-v1' && typeof parsed.contributorIdDay === 'string' &&
      /^[A-Za-z0-9_-]{32,128}$/.test(parsed.contributorIdDay));
    verifyDriverRevocationActor(value.actor, value.actorSignature, value.actorSecret, value.issuer, parsed.contributorIdDay, value.now);
    return Object.freeze({ contractVersion: CONTRACT, contributorHash: driverErasureHash(value.hashSecret, 'cop', parsed.contributorIdDay) });
  });
}

/** acceptedAtUTC/checkpointHash must come from independently admitted Root/DB
 * facts. This helper only checks their shape and exact original coverage. */
export function prepareDriverEraseBody(input) {
  return safe(() => erase(own(input, ERASE_KEYS)));
}

/** Context syntax/binding data only; no signature, store, actual DB digest,
 * freshness, inventory, no_report decision or publication barrier is verified. */
export function prepareDriverAckBody(input) {
  return safe(() => {
    const value = own(input, [...ERASE_KEYS, 'publicationContext']);
    const body = erase(Object.fromEntries(ERASE_KEYS.map(key => [key, value[key]])));
    const context = own(value.publicationContext, CONTEXT_KEYS);
    need(context.contractVersion === 'cop-driver-publication-context-v1' && uuid(context.recordId) && uuid(context.storeIncarnation) &&
      hex(context.recordDigest) && hex(context.operationDigest) && hex(context.readbackDigest) &&
      ['no_report', 'enforced_single_writer', 'shared_generation_fence'].includes(context.reportProtection) &&
      stamp(context.observedAtUTC) <= value.now);
    return Object.freeze({ ...body, publicationContext: Object.freeze(context) });
  });
}

/** No cutoff is accepted/generated here: it belongs to the immutable Root
 * origin registry. There is no clock read, permit, origin or readiness flag. */
export function prepareDriverExpireBody(...args) {
  return safe(() => { need(args.length === 0); return Object.freeze({ contractVersion: CONTRACT }); });
}
