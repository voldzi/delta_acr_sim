/** Controlled mechanical reuse of frozen TLS/PG bootstraps ONLY. Never import
 * or execute a frozen runner, alter its source/receipt, or claim its old cases
 * as new evidence. The new runner alone executes the generated five-case runs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const sha = value => createHash('sha256').update(value).digest('hex');
export const LAYOUT_SPECS = Object.freeze({
  driver: Object.freeze({
    frozenRunner: 'scripts/test-driver-read-keyring.mts', runnerPin: '7c8ef1a76407caebcee4ef1ed3503ea5f7805da3cad4044cd438ba96b67910ca',
    frozenFixture: 'scripts/fixtures/driver-read-keyring/harness.mjs', fixturePin: '8992fdd14310ed9fece233ba0a3a8eea7272c4740550f9a863bede8a1a5c0c85',
    frozenReceipt: 'docs/archive/2026-10-15_DRIVER_READ_KEYRING_FINAL.json', receiptPin: '04231a1fdbad9d5ea29d49d6c3470b7178551e277f64883b560cc45824035ce5',
    directory: 'deploy/driver-measurements', reader: 'root-read-admission.mjs', facts: 'read-admission-facts.mjs',
    readerPin: '3cab7320add0af3f6eac9a6b091ac21d0e222894b68710f7fbbb2a88dfc057c4',
    oldReaderPin: '259d53669e7f90d940a9c3c9eb8fffd964a3e2b6a364169af480631ba22fde56',
    factsPin: '756d25ae2ce00c9a02a6295a5d00812732a04b01ace82c347f68e58a902d0456',
    permitDirectory: 'read-permits', publishEnd: 'async function contents()', evidenceReplacements: 2,
    oldContract: 'sim-driver-read-keyring-isolated-linux-evidence-v1', oldDeadline: 'DRIVER_READ_KEYRING_FIXTURE_DEADLINE',
    sql: Object.freeze({
      'schema.sql': '6dd60a3acf28d63575198c8526c368df19bbd543f4063d4985fb55f308da02d0',
      '002_account_erasure.sql': 'f13db2106a1fe1a02d0d1a26afa8ad7d7c045172ba4419749719ed0f166e16ad',
      '003_guarded_operations.sql': 'e3513a983a3b6d1bd52d46851c734dd1c3b208e2e2f6430a6f9eddd38b10d3b5',
      '004_read_admission_facts.sql': '791545b9df91e65bb555c68a44dadd73a847ca64fde0c31a9036f9f555ba1d2d'
    })
  }),
  ai: Object.freeze({
    frozenRunner: 'scripts/test-ai-root-checkpoint.mts', runnerPin: '11e02ff4eb52ea85e3d1b2da9e0c93c573fc61ddb558a2072573baa9220e43fc',
    frozenFixture: 'scripts/fixtures/ai-checkpoint-root/harness.mjs', fixturePin: 'f6dd9f778444f7946bd73dd8c9ee31c0438463c1ef9dd2fe20da8a02b9eeda15',
    frozenReceipt: 'docs/archive/2026-10-15_AI_ROOT_CHECKPOINT.json', receiptPin: 'afb73435faaaa2129e8e270c1266a431099c54bb25681ec8ba10b903b10f16cc',
    directory: 'deploy/ai-router', reader: 'root-checkpoint-read.mjs', facts: 'checkpoint-facts.mjs',
    readerPin: 'ee65770eeec3403c9cf0fe5901c6241833c7015219d15c4b7a73b7162c582874',
    oldReaderPin: '91d4e064916d34780e3c42ead5e359437507bc0ecf2cef8d2c4f737027975a02',
    factsPin: 'bcc476814331e1bf4fc68e552f8f4ca28f3b61a1ca32ebf7d6fbdbc6ef8d183f',
    permitDirectory: 'ai-read-permits', publishEnd: 'async function verifiedRead(', evidenceReplacements: 1,
    oldContract: 'sim-ai-checkpoint-root-isolated-linux-evidence-v1', oldDeadline: 'AI_CHECKPOINT_ROOT_FIXTURE_DEADLINE',
    sql: Object.freeze({
      '001_schema.sql': 'b6e48ea50286f25a16262e4e8f7c2f57a9629ea09e163db473820618bcb1a92b',
      '002_separate_billing.sql': 'e016cfa95cf228c4781780d844e9bc0c784aade6c36a21fa9667923d9b0bfbcb',
      '003_account_erasure.sql': '921e19e1bae334bb3ae84dadfc9ab4b9cd333b4f515e77a3a286b68649426a56',
      '004_root_checkpoint_facts.sql': '29f8f8bf6b5091de86bb143c30fa61b5773973f0cfb81efbe8714ba6d1981617',
      '005_root_checkpoint.sql': '220ff12cf5fe3e78885139c3d1bf53a1d700769dbb53707a3d73e6682d2d05b4'
    })
  })
});

const layoutCode = owner => `
// NEW layout cases; the frozen original run() is deliberately not executed.
const LAYOUT_OWNER = ${JSON.stringify(owner)}, PRIVATE = '/run/cop-account-safety/private';
const PERMIT_DIRECTORY = ${JSON.stringify(LAYOUT_SPECS[owner].permitDirectory)};
async function layoutDirectories() {
  const info = await lstat(PRIVATE);
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === 0 && (info.mode & 0o077) === 0);
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\\n').map(line => line.split(' - '));
  const mount = mounts.find(parts => parts[0].split(' ')[4] === PRIVATE);
  assert.ok(mount && mount[1].split(' ')[0] === 'tmpfs', 'The fixed private root must be an actual independent tmpfs.');
  for (const name of ['read-permits', 'ai-read-permits', 'read-evidence']) {
    assert.equal(existsSync(join(PRIVATE, name)), false, 'Never adopt existing per-read state.');
    await mkdir(join(PRIVATE, name), { mode: 0o700 });
  }
  const expected = (await readFile('/fixture/harness.sha256', 'utf8')).trim();
  assert.match(expected, /^[0-9a-f]{64}$/); assert.equal(hash(await readFile('/fixture/harness.mjs')), expected);
}
function layoutReferences(f) {
  return [...Object.values(f.permit.evidence), ...(f.permit.reportInventoryRef ? [f.permit.reportInventoryRef] : [])];
}
async function layoutVerify(f) {
  const inspect = LAYOUT_OWNER === 'driver' ? inspectRootDriver : inspectRootAiCheckpoint;
  const kind = LAYOUT_OWNER === 'driver' ? 'driver-read-admission' : 'ai-router-read-admission';
  const out = await inspect(f.id, f.input, PEER), record = verifyRootRecord(Buffer.from(out.record), publicKeys, kind);
  assert.equal(hash(Buffer.from(out.record)), out.admission.reference.digest);
  assert.equal(record.payload.recordId, out.admission.reference.recordId);
  assert.equal(record.payload.readPermitId, f.id); assert.deepEqual(record.payload.request, f.input);
  assert.deepEqual(record.payload.peer, PEER); assert.ok(Date.parse(record.payload.expiresAt) > Date.now());
  return out;
}
async function run() {
  await bootstrap();
  const markerPath = join(STATE, 'evidence', '00000000-0000-4000-8000-000000000099.json');
  // Directory-separation sentinel only, NOT accepted mutation/ACK evidence.
  const marker = canonical({ fixtureOnly: 'durable mutation namespace sentinel; not a Root decision' }) + '\\n';
  await privateFile(markerPath, marker);
  await check('new private tmpfs permits/evidence succeed with actual signed Root/TLS/PG chain', async f => {
    assert.equal(f.path, join(PRIVATE, PERMIT_DIRECTORY, f.id + '.json'));
    assert.equal(existsSync(join(STATE, PERMIT_DIRECTORY, f.id + '.json')), false);
    for (const ref of layoutReferences(f)) {
      const path = join(PRIVATE, 'read-evidence', ref.recordId + '.json'), info = await lstat(path);
      assert.ok(info.isFile() && info.uid === 0 && info.nlink === 1 && (info.mode & 0o077) === 0);
      assert.equal(existsSync(join(STATE, 'evidence', ref.recordId + '.json')), false);
    }
    await layoutVerify(f);
  });
  await check('valid read evidence in the durable mutation directory alone is never a fallback', async f => {
    const moved = [];
    try {
      for (const ref of layoutReferences(f)) {
        const path = join(PRIVATE, 'read-evidence', ref.recordId + '.json'), old = join(STATE, 'evidence', ref.recordId + '.json');
        const bytes = await readFile(path); await privateFile(old, bytes); await unlink(path); moved.push({ path, old, bytes });
      }
      await denied(f);
    } finally { for (const row of moved) { await privateFile(row.path, row.bytes); await unlink(row.old); } }
  });
  await check('a valid durable copy cannot rescue forged evidence in the authoritative tmpfs path', async f => {
    const ref = layoutReferences(f)[0], path = join(PRIVATE, 'read-evidence', ref.recordId + '.json');
    const old = join(STATE, 'evidence', ref.recordId + '.json'), bytes = await readFile(path);
    await privateFile(old, bytes);
    try {
      const forged = JSON.parse(bytes); forged.signature = (forged.signature[0] === 'A' ? 'B' : 'A') + forged.signature.slice(1);
      await privateFile(path, canonical(forged) + '\\n'); await denied(f);
    } finally { await privateFile(path, bytes); await unlink(old); }
  });
  await check('read-evidence private file custody and symlinks are rejected by the actual reader', async f => {
    const ref = layoutReferences(f)[0], path = join(PRIVATE, 'read-evidence', ref.recordId + '.json');
    const old = join(STATE, 'evidence', ref.recordId + '.json'), bytes = await readFile(path);
    await chmod(path, 0o640);
    try { await denied(f); } finally { await chmod(path, 0o600); }
    await privateFile(old, bytes); await unlink(path); await symlink(old, path);
    try { await denied(f); } finally { await unlink(path); await privateFile(path, bytes); await unlink(old); }
    await layoutVerify(f);
  });
  await check('valid legacy STATE permit cannot substitute for a missing tmpfs permit', async f => {
    const old = join(STATE, PERMIT_DIRECTORY, f.id + '.json'), bytes = await readFile(f.path);
    await privateFile(old, bytes); await unlink(f.path);
    try { await denied(f); } finally { await privateFile(f.path, bytes); await unlink(old); }
  });
  assert.equal(events.length, 5);
  assert.equal(await readFile(markerPath, 'utf8'), marker);
  for (const [path, pin] of Object.entries(pins)) assert.equal(hash(await readFile(path)), pin);
  assert.equal(hash(await readFile('/fixture/harness.mjs')), (await readFile('/fixture/harness.sha256', 'utf8')).trim());
  if (LAYOUT_OWNER === 'ai') assert.equal(await compiledDigest(), appSourceDigest);
  return { contractVersion: 'sim-root-read-evidence-layout-linux-v1', owner: LAYOUT_OWNER,
    scope: 'five_new_read_layout_groups_only_not_prior_root_keyring_or_byok_reacceptance',
    passed: events.length, cases: events, startedAt, completedAt: new Date().toISOString(),
    node: process.version, postgres: '18.6', platform: process.platform, architecture: process.arch,
    nodeImageId: NODE_IMAGE, postgresImageId: PG_IMAGE, sourcePins: pins,
    privateTmpfs: PRIVATE, privateRootMode0700: true, perReadEvidenceInTmpfs: true,
    durableMutationDirectorySentinelUnchanged: true, actualMutationAckPathsRetested: false,
    realEd25519: true, realRootFileCustody: true, realLoopbackStrictTls: true, realPostgres: true,
    targetAndRegistryRowsUnchangedByReader: true, unconditionalPositiveCallbacks: 0, pgStubs: 0,
    originRpcCalls: 0, externalNetworkInterfaces: 0, providerCalls: typeof providerCalls === 'undefined' ? 0 : providerCalls,
    peerSource: 'frozen_synthetic_fixture_not_kernel_observation', productionEnrollment: false,
    nativePeerAcceptance: false, deployment: false, activation: false, wholeAccountComplete: false };
}
`;

export function deriveLayoutHarness(owner, frozenSource) {
  assert.ok(Object.hasOwn(LAYOUT_SPECS, owner));
  const spec = LAYOUT_SPECS[owner]; assert.equal(sha(frozenSource), spec.fixturePin, 'Frozen fixture input must be exact.');
  const edits = [];
  const replace = (source, from, to, count, name) => {
    assert.equal(source.split(from).length - 1, count, 'Mechanical replacement count: ' + name);
    edits.push({ name, count }); return source.split(from).join(to);
  };
  const runStart = frozenSource.indexOf('async function run() {'), tailStart = frozenSource.indexOf('\nlet output, failure;', runStart);
  assert.ok(runStart > 0 && tailStart > runStart);
  assert.equal(frozenSource.indexOf('async function run() {', runStart + 1), -1);
  let prefix = frozenSource.slice(0, runStart), tail = frozenSource.slice(tailStart);
  prefix = replace(prefix, spec.oldReaderPin, spec.readerPin, 1, 'new reviewed actual reader pin');
  prefix = replace(prefix, spec.oldDeadline, 'ROOT_READ_EVIDENCE_LAYOUT_FIXTURE_DEADLINE', 1, 'new fixture deadline label');
  prefix = replace(prefix, '  for (const [path, pin] of Object.entries(pins)) {',
    '  await layoutDirectories();\n  for (const [path, pin] of Object.entries(pins)) {', 1, 'new empty tmpfs precondition after isolated-container checks');
  const start = prefix.indexOf('async function publish('), end = prefix.indexOf(spec.publishEnd, start);
  assert.ok(start > 0 && end > start);
  let publish = prefix.slice(start, end);
  publish = replace(publish, "join(STATE, 'evidence',", "join(PRIVATE, 'read-evidence',", spec.evidenceReplacements, 'read evidence publishers only');
  publish = replace(publish, `join(STATE, '${spec.permitDirectory}', id + '.json')`,
    `join(PRIVATE, '${spec.permitDirectory}', id + '.json')`, 1, 'read permit publisher only');
  prefix = prefix.slice(0, start) + publish + prefix.slice(end);
  tail = replace(tail, spec.oldContract, 'sim-root-read-evidence-layout-linux-v1', 1, 'new failure receipt contract');
  const source = '/** NEW GENERATED layout-only harness: exact frozen bootstrap retained; old run() removed. */\n' + prefix + layoutCode(owner) + tail;
  return Object.freeze({ source, sha256: sha(source), frozenSha256: spec.fixturePin, edits: Object.freeze(edits.map(Object.freeze)) });
}
