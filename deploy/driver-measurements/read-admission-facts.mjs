/** Pure bounded observation checks. This module is NOT a Root verifier,
 * admission producer, database connector or positive authority callback. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';

export class DriverReadFactsError extends Error {
  constructor() { super('DRIVER_READ_ADMISSION_UNAVAILABLE'); this.name = 'DriverReadFactsError'; }
}
const need = value => { if (!value) throw new DriverReadFactsError(); };
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const protections = ['unverified', 'no_report', 'enforced_single_writer', 'shared_generation_fence'];
const purposes = ['capability', 'intake', 'preflight', 'status', 'receipt'];
function exact(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === names.length && names.every(name => keys.includes(name)) && keys.every(name => {
    const d = Object.getOwnPropertyDescriptor(value, name);
    return typeof name === 'string' && d?.enumerable && 'value' in d;
  });
}
function stamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
const snapshot = value => Object.freeze(structuredClone(value));
export function parseDriverReadRequest(value) {
  need(value && purposes.includes(value.purpose));
  const actorBound = ['preflight', 'status', 'receipt'].includes(value.purpose);
  need(exact(value, actorBound ? ['owner', 'scope', 'purpose', 'operationHash', 'actorHash'] : ['owner', 'scope', 'purpose']));
  need(value.owner === 'sim_driver_measurements' && value.scope === 'online_driver_scope');
  if (actorBound) need(hex(value.operationHash) && hex(value.actorHash));
  return snapshot(value);
}
/** A deterministic request hash only. The SQL fingerprint remains PG JSONB-text.
 * The real Root permit separately signs the canonical request and this hash. */
export function driverReadRequestDigest(value) {
  const request = parseDriverReadRequest(value);
  return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(request).sort().map(k => [k, request[k]])))).digest('hex');
}
export function validateDriverReadFacts(value, expectedRequest) {
  const request = parseDriverReadRequest(expectedRequest);
  need(exact(value, ['contractVersion', 'request', 'observedAtUTC', 'storeIncarnation', 'state', 'schema', 'privileges', 'operation']));
  need(value.contractVersion === 'sim-driver-read-facts-v1' && stamp(value.observedAtUTC));
  const echo = parseDriverReadRequest(value.request);
  need(driverReadRequestDigest(echo) === driverReadRequestDigest(request));
  need(value.storeIncarnation === null || uuid(value.storeIncarnation));
  const state = value.state;
  need(exact(state, ['checkpointHash', 'replayReady', 'proofValidUntilUTC', 'proofCurrent', 'retentionReviewed', 'reportProtection', 'publicationFenceVerified']));
  need((state.checkpointHash === null || hex(state.checkpointHash)) && (state.proofValidUntilUTC === null || stamp(state.proofValidUntilUTC)) &&
    protections.includes(state.reportProtection));
  for (const key of ['replayReady', 'proofCurrent', 'retentionReviewed', 'publicationFenceVerified']) need(typeof state[key] === 'boolean');
  need(exact(value.schema, ['ready', 'fingerprint']) && typeof value.schema.ready === 'boolean' && hex(value.schema.fingerprint));
  need(exact(value.privileges, ['runtimeProfileMatches', 'fingerprint']) && typeof value.privileges.runtimeProfileMatches === 'boolean' && hex(value.privileges.fingerprint));
  const operation = value.operation;
  if (operation !== null) {
    need(['preflight', 'status', 'receipt'].includes(request.purpose));
    need(exact(operation, ['operationHash', 'actorHash', 'requestHash', 'contributorCount', 'status', 'createdAtUTC', 'updatedAtUTC',
      'deletedBatchCount', 'remainingBatchCount', 'databaseZeroVerified', 'derivedReportAcknowledged', 'replayCheckpointHash', 'ledgerDigest']));
    need(operation.operationHash === request.operationHash && operation.actorHash === request.actorHash && hex(operation.requestHash) &&
      count(operation.contributorCount) && operation.contributorCount >= 9 && operation.contributorCount <= 40 &&
      ['pending', 'completed'].includes(operation.status) && stamp(operation.createdAtUTC) && stamp(operation.updatedAtUTC) &&
      Date.parse(operation.updatedAtUTC) >= Date.parse(operation.createdAtUTC) && count(operation.deletedBatchCount) && count(operation.remainingBatchCount) &&
      typeof operation.databaseZeroVerified === 'boolean' && typeof operation.derivedReportAcknowledged === 'boolean' &&
      (operation.replayCheckpointHash === null || hex(operation.replayCheckpointHash)) && hex(operation.ledgerDigest));
  }
  return snapshot(value);
}
/** Necessary target facts, never sufficient Root authority. Expected values must
 * come from an independently verified current Root policy/enrollment, not app
 * fields, target DB booleans, environment flags or a fixture callback. */
export function matchDriverReadPolicy(facts, request, expected, now = Date.now()) {
  const checked = validateDriverReadFacts(facts, request);
  need(exact(expected, ['storeIncarnation', 'checkpointHash', 'schemaFingerprint', 'privilegeFingerprint', 'reportProtection']));
  need(uuid(expected.storeIncarnation) && hex(expected.checkpointHash) && hex(expected.schemaFingerprint) &&
    hex(expected.privilegeFingerprint) && protections.slice(1).includes(expected.reportProtection));
  need(Number.isFinite(now) && Date.parse(checked.observedAtUTC) <= now && now - Date.parse(checked.observedAtUTC) <= 5000);
  need(checked.storeIncarnation === expected.storeIncarnation && checked.state.checkpointHash === expected.checkpointHash &&
    checked.schema.ready && checked.schema.fingerprint === expected.schemaFingerprint && checked.privileges.runtimeProfileMatches &&
    checked.privileges.fingerprint === expected.privilegeFingerprint && checked.state.replayReady && checked.state.proofCurrent &&
    checked.state.proofValidUntilUTC !== null && Date.parse(checked.state.proofValidUntilUTC) > now &&
    checked.state.retentionReviewed && checked.state.publicationFenceVerified && checked.state.reportProtection === expected.reportProtection);
  if (request.purpose === 'receipt') need(checked.operation !== null);
  return checked;
}
