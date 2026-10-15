/** Main stages this file/module alongside the ACTUAL compiled pure siblings.
 * Synthetic pure preparation tests only: no Root authority, service identity,
 * accountMAC provenance, native transport, DB, permit or publication evidence. */
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  parseDriverErasureRequest, verifyDriverErasureActor, prepareDriverErasureInput,
  validateDriverErasureCoverage, driverErasureHash, driverErasureRequiredDays
} from './driver-account-erasure.js';
import { verifyDriverRevocationActor } from './driver-revocation-actor.js';
import {
  DriverOwnerDomainError, prepareDriverRevokeBody, prepareDriverEraseBody,
  prepareDriverAckBody, prepareDriverExpireBody
} from './driver-owner-domain.mjs';

const PURE_SHA = 'd184e31dda5484d4d8d2382208834197247ff47a1a37437f4f0550fdd95ea999';
const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const ID = '10000000-0000-4000-8000-000000000071';
const HASH_SECRET = 'synthetic-driver-hash-secret-only-000000000000';
const ACTOR_SECRET = 'synthetic-driver-actor-secret-only-00000000000';
const ISSUER = 'https://synthetic-cop.invalid';
const DAY_ID = 'synthetic_daily_identity_00000000000000000000';
const h = char => char.repeat(64);
const mac = text => createHmac('sha256', ACTOR_SECRET).update(text).digest('hex');
function signed(payload) {
  const actor = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { actor, actorSignature: mac(actor) };
}
function actorPayload(overrides = {}) {
  return { iss: ISSUER, sub: 'synthetic-account-subject', aud: 'sim-account-erasure',
    iat: Math.floor(NOW / 1000) - 1, exp: Math.floor(NOW / 1000) + 30,
    operationId: ID, routerUserId: `cop_${'A'.repeat(43)}`, ...overrides };
}
function eraseInput(acceptedAtUTC = new Date(NOW).toISOString()) {
  return {
    request: { contractVersion: 'sim-account-erasure-v1', operationId: ID,
      contributors: driverErasureRequiredDays(Date.parse(acceptedAtUTC)).map((contributorDay, index) => ({ contributorDay, contributorIdDay: `${DAY_ID}${index}` })),
      attestation: 'cop-account-erasure-contributors-reviewed-v1' },
    ...signed(actorPayload()), hashSecret: HASH_SECRET, actorSecret: ACTOR_SECRET, issuer: ISSUER,
    now: NOW, acceptedAtUTC, checkpointHash: h('a')
  };
}
function revocationPayload(overrides = {}) {
  return { iss: ISSUER, sub: 'synthetic-account-subject', aud: 'sim-driver-revocation',
    iat: Math.floor(NOW / 1000) - 1, exp: Math.floor(NOW / 1000) + 30,
    contributorDay: '2026-10-15', contributorIdDay: DAY_ID, actorSource: 'verified_session', ...overrides };
}
function revokeInput(overrides = {}) {
  return { request: { contractVersion: 'sim-driver-measurements-v1', contributorIdDay: DAY_ID },
    ...signed(revocationPayload()), hashSecret: HASH_SECRET, actorSecret: ACTOR_SECRET, issuer: ISSUER, now: NOW, ...overrides };
}
function context(overrides = {}) {
  return { contractVersion: 'cop-driver-publication-context-v1', recordId: '20000000-0000-4000-8000-000000000071',
    recordDigest: h('b'), storeIncarnation: '30000000-0000-4000-8000-000000000071', operationDigest: h('c'), readbackDigest: h('d'),
    reportProtection: 'shared_generation_fence', observedAtUTC: '2026-10-15T11:59:59.999Z', ...overrides };
}
function invalid(work) {
  assert.throws(work, error => error instanceof DriverOwnerDomainError && error.message === 'DRIVER_OWNER_DOMAIN_INVALID');
}
function actualEraseBody(value) {
  const request = parseDriverErasureRequest(value.request);
  const actor = verifyDriverErasureActor(value.actor, value.actorSignature, value.actorSecret, value.issuer, request.operationId, value.now);
  const prepared = prepareDriverErasureInput(request, actor, value.hashSecret);
  validateDriverErasureCoverage(prepared, Date.parse(value.acceptedAtUTC));
  return { contractVersion: 'sim-driver-guarded-db-v1', operationHash: driverErasureHash(value.hashSecret, 'cop:account-erasure-operation', request.operationId),
    actorHash: prepared.actorHash, requestHash: prepared.requestHash, contributors: prepared.contributors, checkpointHash: value.checkpointHash };
}

test('uses the actual unchanged pinned compiled erasure helper, not a duplicate implementation', () => {
  assert.equal(createHash('sha256').update(readFileSync(new URL('./driver-account-erasure.js', import.meta.url))).digest('hex'), PURE_SHA);
});

test('erase bytes and all HMAC purposes match the actual compiled pure helper', () => {
  const value = eraseInput(), result = prepareDriverEraseBody(value);
  assert.equal(JSON.stringify(result), JSON.stringify(actualEraseBody(value)));
  assert.equal(result.operationHash, createHmac('sha256', HASH_SECRET).update(`cop:account-erasure-operation:${ID}`).digest('hex'));
  assert.equal(result.actorHash, createHmac('sha256', HASH_SECRET).update(`cop:account-erasure-actor:${JSON.stringify([ISSUER, 'synthetic-account-subject'])}`).digest('hex'));
  assert.notEqual(result.operationHash, ID);
  assert.deepEqual(Object.keys(result), ['contractVersion', 'operationHash', 'actorHash', 'requestHash', 'contributors', 'checkpointHash']);
  for (const forbidden of ['origin', 'permit', 'accountMAC', 'ready', 'reportProtection', 'publicationContext']) assert.equal(Object.hasOwn(result, forbidden), false);
});

test('normalization, contributor order and immutable copied result preserve actual helper parity', () => {
  const value = eraseInput(); value.request.contributors.reverse();
  const result = prepareDriverEraseBody(value);
  assert.equal(JSON.stringify(result), JSON.stringify(actualEraseBody(value)));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.contributors) && result.contributors.every(Object.isFrozen));
  const before = JSON.stringify(result);
  value.request.contributors[0].contributorIdDay = 'changed_synthetic_identity_000000000000000000'; value.request.contributors.length = 0;
  assert.equal(JSON.stringify(result), before);
  for (const secret of [HASH_SECRET, ACTOR_SECRET, ISSUER, DAY_ID, 'synthetic-account-subject']) assert.equal(before.includes(secret), false);
});

test('revoke verifies the actual new actor helper and preserves the original cop HMAC purpose', () => {
  for (const actorSource of ['verified_session', 'consent_ledger']) {
    const value = revokeInput(signed(revocationPayload({ actorSource })));
    const checked = verifyDriverRevocationActor(value.actor, value.actorSignature, value.actorSecret, value.issuer, DAY_ID, NOW);
    assert.equal(checked.actorSource, actorSource);
    const result = prepareDriverRevokeBody(value);
    assert.deepEqual(result, { contractVersion: 'sim-driver-guarded-db-v1', contributorHash: driverErasureHash(HASH_SECRET, 'cop', DAY_ID) });
    assert.equal(result.contributorHash, createHmac('sha256', HASH_SECRET).update(`cop:${DAY_ID}`).digest('hex'));
    assert.ok(Object.isFrozen(result));
  }
});

test('blank, expired, wrong-audience/day/source/contributor or malformed revocation actors are rejected', () => {
  invalid(() => prepareDriverRevokeBody(revokeInput({ actor: '', actorSignature: '' })));
  for (const payload of [revocationPayload({ exp: Math.floor(NOW / 1000) }), revocationPayload({ aud: 'sim-account-erasure' }),
    revocationPayload({ contributorDay: '2026-10-16' }), revocationPayload({ contributorIdDay: `${DAY_ID}other` }),
    revocationPayload({ actorSource: 'application_claim' })]) invalid(() => prepareDriverRevokeBody(revokeInput(signed(payload))));
  invalid(() => prepareDriverRevokeBody(revokeInput({ actorSignature: '0'.repeat(64) })));
  invalid(() => prepareDriverRevokeBody(revokeInput({ request: { contractVersion: 'sim-driver-measurements-v1', contributorIdDay: DAY_ID, accountMAC: h('e') } })));
});

test('expire creates only the fixed body and accepts no cutoff, origin, checkpoint or extra argument', () => {
  const result = prepareDriverExpireBody(); assert.deepEqual(result, { contractVersion: 'sim-driver-guarded-db-v1' }); assert.ok(Object.isFrozen(result));
  for (const value of [undefined, {}, { cutoff: '2026-10-15T12:00:00.000Z' }, { operationId: ID }, { ready: true }]) invalid(() => prepareDriverExpireBody(value));
});

test('ACK preserves the exact erase bytes and supplied eight-field context without manufacturing authority', () => {
  const base = eraseInput(), supplied = context(), result = prepareDriverAckBody({ ...base, publicationContext: supplied });
  const { publicationContext, ...body } = result;
  assert.equal(JSON.stringify(body), JSON.stringify(prepareDriverEraseBody(base)));
  assert.deepEqual(publicationContext, supplied); assert.notEqual(publicationContext, supplied);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(publicationContext) && Object.isFrozen(result.contributors));
  supplied.recordDigest = h('f'); assert.equal(publicationContext.recordDigest, h('b'));
  for (const forbidden of ['ready', 'verified', 'wholeAccountComplete', 'permit', 'rootOriginId']) assert.equal(Object.hasOwn(result, forbidden), false);
});

test('ACK requires explicit exact context; unknown fields, invalid values and future observations fail closed', () => {
  const base = eraseInput(); invalid(() => prepareDriverAckBody(base));
  for (const publicationContext of [undefined, null, { ...context(), extra: true }, context({ contractVersion: 'other' }),
    context({ recordId: ID.toUpperCase().replace('10000000', 'A0000000') }), context({ recordDigest: 'x'.repeat(64) }),
    context({ storeIncarnation: 'not-a-store' }), context({ operationDigest: 4 }), context({ readbackDigest: null }),
    context({ reportProtection: 'unverified' }), context({ observedAtUTC: '2026-10-15T12:00:00Z' }),
    context({ observedAtUTC: '2026-10-15T12:00:00.001Z' })]) invalid(() => prepareDriverAckBody({ ...base, publicationContext }));
});

test('ACK performs syntax only: an explicit protection/old timestamp is never a verified inventory or freshness proof', () => {
  for (const reportProtection of ['no_report', 'enforced_single_writer', 'shared_generation_fence']) {
    const supplied = context({ reportProtection, observedAtUTC: '2025-01-01T00:00:00.000Z' });
    const result = prepareDriverAckBody({ ...eraseInput(), publicationContext: supplied });
    assert.equal(result.publicationContext.reportProtection, reportProtection);
    assert.equal(Object.hasOwn(result.publicationContext, 'verified'), false);
  }
});

test('unknown input/request/manifest keys and injected origin/body/account selectors are rejected', () => {
  for (const extra of [{ rootOriginId: ID }, { operationHash: h('e') }, { accountMAC: h('e') }, { no_report: true }]) invalid(() => prepareDriverEraseBody({ ...eraseInput(), ...extra }));
  const value = eraseInput();
  invalid(() => prepareDriverEraseBody({ ...value, request: { ...value.request, sql: 'forbidden' } }));
  invalid(() => prepareDriverEraseBody({ ...value, request: { ...value.request, contributors: value.request.contributors.map((row, index) => index ? row : { ...row, contributorHash: h('e') }) } }));
  invalid(() => prepareDriverRevokeBody({ ...revokeInput(), checkpointHash: h('a') }));
});

test('accessors, proxies, inherited fields, symbols, sparse/custom arrays never execute getters', () => {
  let calls = 0; const value = eraseInput();
  const getter = Object.defineProperty({ ...value }, 'hashSecret', { enumerable: true, get() { calls++; throw new Error('raw getter'); } });
  const row = Object.defineProperty({ ...value.request.contributors[0] }, 'contributorIdDay', { enumerable: true, get() { calls++; return DAY_ID; } });
  const custom = [...value.request.contributors]; custom.extra = true;
  const sparse = [...value.request.contributors]; delete sparse[0];
  for (const input of [getter, new Proxy(value, {}), Object.assign(Object.create({}), value), { ...value, [Symbol('extra')]: true },
    { ...value, request: { ...value.request, contributors: [row, ...value.request.contributors.slice(1)] } },
    { ...value, request: { ...value.request, contributors: new Proxy(value.request.contributors, {}) } },
    { ...value, request: { ...value.request, contributors: custom } }, { ...value, request: { ...value.request, contributors: sparse } }]) invalid(() => prepareDriverEraseBody(input));
  const supplied = Object.defineProperty(context(), 'recordDigest', { enumerable: true, get() { calls++; return h('b'); } });
  invalid(() => prepareDriverAckBody({ ...value, publicationContext: supplied })); assert.equal(calls, 0);
});

test('erasure actor signature, identity scope, operation binding, exact encoding and 60s validity use the compiled helper', () => {
  for (const payload of [actorPayload({ aud: 'sim-driver-revocation' }), actorPayload({ operationId: '10000000-0000-4000-8000-000000000072' }),
    actorPayload({ iss: 'https://other.invalid' }), actorPayload({ exp: Math.floor(NOW / 1000) }),
    actorPayload({ exp: Math.floor(NOW / 1000) + 61 }), actorPayload({ routerUserId: 'not-an-opaque-id' })])
    invalid(() => prepareDriverEraseBody({ ...eraseInput(), ...signed(payload) }));
  invalid(() => prepareDriverEraseBody({ ...eraseInput(), actorSignature: '0'.repeat(64) }));
  const reordered = { sub: 'synthetic-account-subject', ...actorPayload() };
  invalid(() => prepareDriverEraseBody({ ...eraseInput(), ...signed(reordered) }));
});

test('original acceptedAt controls repeat coverage, including midnight tolerance and older retained identities', () => {
  const midnight = '2026-10-14T23:59:45.000Z', value = eraseInput(midnight);
  assert.equal(value.request.contributors.length, 10);
  assert.equal(JSON.stringify(prepareDriverEraseBody(value)), JSON.stringify(actualEraseBody(value)));
  const extra = { contributorDay: '2026-08-01', contributorIdDay: `${DAY_ID}old` };
  value.request.contributors.push(extra); assert.equal(prepareDriverEraseBody(value).contributors.length, 11);
  const missing = eraseInput(); missing.request.contributors[0].contributorDay = '2026-08-01';
  invalid(() => prepareDriverEraseBody(missing));
  const future = eraseInput(); future.request.contributors[0].contributorDay = '2026-10-16'; invalid(() => prepareDriverEraseBody(future));
});

test('invalid dates, duplicate identities, count overflow, secrets and clocks yield only the fixed domain error', () => {
  const value = eraseInput();
  for (const override of [{ acceptedAtUTC: '2026-02-31T00:00:00.000Z' }, { acceptedAtUTC: '2026-10-15T12:00:00Z' },
    { checkpointHash: 'INVALID' }, { hashSecret: 'short' }, { actorSecret: undefined }, { issuer: 7 }, { now: NaN }, { now: -1 }, { now: NOW + 0.5 }])
    invalid(() => prepareDriverEraseBody({ ...value, ...override }));
  const duplicate = eraseInput(); duplicate.request.contributors.push({ ...duplicate.request.contributors[0] }); invalid(() => prepareDriverEraseBody(duplicate));
  const tooMany = eraseInput(); while (tooMany.request.contributors.length <= 40) tooMany.request.contributors.push({ contributorDay: '2026-08-01', contributorIdDay: `${DAY_ID}old${tooMany.request.contributors.length}` });
  invalid(() => prepareDriverEraseBody(tooMany));
  const invalidDate = eraseInput(); invalidDate.request.contributors[0].contributorDay = '2026-02-31'; invalid(() => prepareDriverEraseBody(invalidDate));
});
