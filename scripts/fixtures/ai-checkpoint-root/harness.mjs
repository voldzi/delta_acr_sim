/**
 * Source-only isolated Linux PG18.6/Node24.20 fixture. The parent reviews and
 * alone runs it in a NEW --network none container; never execute on a host.
 * Layout: /opt/cop-account-safety/{Root modules,node_modules,router-app/*.js},
 * /fixture/sql/{001..005 actual sources}, /fixture/harness.mjs.
 * Real PostgreSQL, TLS, custody, Ed25519, compiled Router and encrypted BYOK.
 * Only the two external provider HTTP responses are synthetic. A frozen peer
 * fixture is NOT a kernel observation, enrollment or native acceptance claim.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, createHmac, generateKeyPairSync, randomBytes, randomUUID, sign, X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, chown, lstat, mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { checkServerIdentity } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const OPT = '/opt/cop-account-safety', ETC = '/etc/cop-account-safety', STATE = '/var/lib/cop-account-safety';
const PGROOT = '/var/lib/postgresql/ai-checkpoint-root-pg', PORT = 6543, COST = 'aggregate-costs-current-month-v1';
const NODE_IMAGE = 'sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf';
const PG_IMAGE = 'sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';
const pins = Object.freeze({
  '/fixture/sql/001_schema.sql': 'b6e48ea50286f25a16262e4e8f7c2f57a9629ea09e163db473820618bcb1a92b',
  '/fixture/sql/002_separate_billing.sql': 'e016cfa95cf228c4781780d844e9bc0c784aade6c36a21fa9667923d9b0bfbcb',
  '/fixture/sql/003_account_erasure.sql': '921e19e1bae334bb3ae84dadfc9ab4b9cd333b4f515e77a3a286b68649426a56',
  '/fixture/sql/004_root_checkpoint_facts.sql': '29f8f8bf6b5091de86bb143c30fa61b5773973f0cfb81efbe8714ba6d1981617',
  '/fixture/sql/005_root_checkpoint.sql': '220ff12cf5fe3e78885139c3d1bf53a1d700769dbb53707a3d73e6682d2d05b4',
  '/opt/cop-account-safety/root-records.mjs': 'ad203b1a1858bea7f8f799a6147720d1d0d6df790bfc1d4c866a12c45d6bb7fd',
  '/opt/cop-account-safety/root-checkpoint-read.mjs': '91d4e064916d34780e3c42ead5e359437507bc0ecf2cef8d2c4f737027975a02',
  '/opt/cop-account-safety/checkpoint-facts.mjs': 'bcc476814331e1bf4fc68e552f8f4ca28f3b61a1ca32ebf7d6fbdbc6ef8d183f',
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const execute = promisify(execFile), events = [], clients = new Set(), originalFetch = globalThis.fetch;
const startedAt = new Date().toISOString();
const IDS = Object.freeze({ store: randomUUID(), guard: randomUUID(), epoch: randomUUID(), dataset: randomUUID(),
  runtime: randomUUID(), proof: randomUUID(), frontier: hash('synthetic independent AI frontier'),
  operation: randomUUID(), canary: hash('synthetic unrelated permanently fenced AI account') });
const PEER = Object.freeze({ device: '303', inode: '404', uid: 1000, gid: 1000 });
const FRONTIER = 7, SOURCE_REVISION = 'f3c05e3ae1ca3081d2f5551bc03da233c0c3a473';
const passwords = Object.freeze(Object.fromEntries(['control', 'registry', 'runtime', 'admin'].map(k => [k, randomBytes(32).toString('hex')])));
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: PGROOT, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
let stage = 'fixture preconditions', started = false, PG_USER, admin, registry, control, tls, rootKey, publicKeys;
let canonical, verifyRootRecord, inspectRootAiCheckpoint, aiCheckpointRequestDigest, matchAiCheckpointPolicy;
let BudgetStore, PgSeparateBilling, PgAccountErasure, createApp, store, erasure, separate, server, baseUrl;
let baselineFacts, rootRequest, currentFixture, appSourceDigest, prePublisherPrivilegeFingerprint, verifiedCallbacks = 0, providerCalls = 0;
let config, syntheticKey;
const deadline = setTimeout(() => { process.stderr.write('AI_CHECKPOINT_ROOT_FIXTURE_DEADLINE\n'); process.exit(2); }, 150_000);

// Actual minimal X.509 RSA/SHA256 DER generation, no CLI/package/download.
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts), n = body.length;
  const length = n < 128 ? Buffer.from([n]) : (() => {
    const bytes = []; for (let v = n; v; v >>>= 8) bytes.unshift(v & 255);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  })();
  return Buffer.concat([Buffer.from([tag]), length, body]);
};
const seq = (...parts) => der(0x30, ...parts);
const oid = text => {
  const arcs = text.split('.').map(Number), bytes = [40 * arcs[0] + arcs[1]];
  for (const arc of arcs.slice(2)) {
    const encoded = [arc & 127]; for (let v = Math.floor(arc / 128); v; v = Math.floor(v / 128)) encoded.unshift((v & 127) | 128);
    bytes.push(...encoded);
  }
  return der(6, Buffer.from(bytes));
};
const integer = bytes => der(2, bytes[0] & 128 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const algorithm = seq(oid('1.2.840.113549.1.1.11'), der(5));
const name = cn => seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from(cn)))));
const extension = (id, value, critical = false) => seq(oid(id), ...(critical ? [der(1, Buffer.from([255]))] : []), der(4, value));
const pem = (label, bytes) => `-----BEGIN ${label}-----\n${bytes.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
function certificate(subject, issuer, key, issuerKey, ca) {
  const utc = time => der(0x17, Buffer.from(new Date(time).toISOString().slice(2, 19).replace(/[-:T]/g, '') + 'Z'));
  const now = Date.now(), serial = randomBytes(16); serial[0] &= 127; serial[0] ||= 1;
  const extensions = [extension('2.5.29.19', ca ? seq(der(1, Buffer.from([255]))) : seq(), true),
    extension('2.5.29.15', der(3, Buffer.from(ca ? [1, 6] : [5, 160])), true)];
  if (!ca) extensions.push(extension('2.5.29.37', seq(oid('1.3.6.1.5.5.7.3.1'))),
    extension('2.5.29.17', seq(der(0x82, Buffer.from('localhost')), der(0x87, Buffer.from([127, 0, 0, 1])))));
  const tbs = seq(der(0xa0, integer(Buffer.from([2]))), integer(serial), algorithm, name(issuer),
    seq(utc(now - 60_000), utc(now + 86_400_000)), name(subject),
    key.publicKey.export({ type: 'spki', format: 'der' }), der(0xa3, seq(...extensions)));
  return pem('CERTIFICATE', seq(tbs, algorithm, der(3, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, issuerKey)]))));
}
function certificates() {
  const ca = generateKeyPairSync('rsa', { modulusLength: 2048 }), key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const caPem = certificate('Synthetic AI Root CA', 'Synthetic AI Root CA', ca, ca.privateKey, true);
  const cert = certificate('localhost', 'Synthetic AI Root CA', key, ca.privateKey, false);
  const caX = new X509Certificate(caPem), serverX = new X509Certificate(cert);
  assert.ok(caX.ca && caX.verify(ca.publicKey) && serverX.checkIssued(caX) && serverX.verify(ca.publicKey));
  assert.equal(serverX.checkHost('localhost'), 'localhost'); assert.equal(serverX.checkIP('127.0.0.1'), '127.0.0.1');
  return { ca: caPem, cert, key: key.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
async function privateFile(path, bytes, mode = 0o600) { await writeFile(path, bytes, { mode }); await chmod(path, mode); }
async function pgCommand(command, args, timeout = 15_000) {
  return execute(`/usr/local/bin/${command}`, args, { env, uid: PG_USER.uid, gid: PG_USER.gid, timeout, maxBuffer: 65_536 });
}
function ssl() { return { ca: tls.ca, rejectUnauthorized: true, servername: 'localhost',
  checkServerIdentity: (_host, cert) => checkServerIdentity('localhost', cert) }; }
function client(database, user = 'synthetic_admin', password) {
  const { Client } = createRequire(join(OPT, 'package.json'))('pg');
  const c = new Client(user === 'synthetic_admin' ? { host: join(PGROOT, 'socket'), port: PORT, database, user } :
    { host: '127.0.0.1', port: PORT, database, user, password, ssl: ssl() });
  c.on('error', () => {}); clients.add(c); return c;
}
async function profile() {
  for (const [file, database, user, password] of [
    ['registry-probe', 'cop_account_safety_guard', 'synthetic_registry_reader', passwords.registry],
    ['ai-router-control', 'sim_ai_router', 'sim_ai_guard_control', passwords.control],
  ]) await privateFile(join(ETC, 'root', file + '.json'), canonical({ contractVersion: 'cop-root-postgres-profile-v1',
    host: '127.0.0.1', port: PORT, database, user, password, serverName: 'localhost', caFile: join(ETC, 'public', 'postgres-ca.crt') }) + '\n');
}
async function compiledDigest() {
  const items = [];
  async function walk(dir, relative = '') {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name), s = await lstat(path), rel = join(relative, name);
      assert.ok(s.uid === 0 && !(s.mode & 0o022) && (s.isDirectory() || (s.isFile() && s.nlink === 1)));
      if (s.isDirectory()) { if (name !== 'node_modules') await walk(path, rel); }
      else if (name.endsWith('.js') || name === 'package.json') items.push([rel, hash(await readFile(path))]);
    }
  }
  await walk(join(OPT, 'router-app')); assert.ok(items.length >= 10); return hash(JSON.stringify(items));
}
const requestFor = cp => ({ owner: 'sim_ai_router', scope: 'cop_router_primary_database', purpose: 'checkpoint',
  expectedSnapshot: { checkpointId: cp.checkpoint_id, generation: cp.checkpoint_generation,
    operationDigest: cp.operation_digest, schemaDigest: cp.schema_digest } });
const base = (kind, recordId = randomUUID(), ttl = 120_000) => ({ contractVersion: 'cop-root-record-v1', kind, recordId,
  issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + ttl).toISOString() });
async function signed(path, payload) {
  const bytes = Buffer.from(canonical({ keyId: publicKeys.keys[0].kid, payload,
    signature: sign(null, Buffer.from(canonical(payload)), rootKey.privateKey).toString('base64url') }) + '\n');
  await privateFile(path, bytes); return { recordId: payload.recordId, digest: hash(bytes) };
}
async function facts(input = rootRequest) {
  await control.query('BEGIN READ ONLY');
  try { return (await control.query('SELECT sim_ai_guard_source.read_checkpoint_facts($1::jsonb) AS value', [JSON.stringify(input)])).rows[0].value; }
  finally { await control.query('ROLLBACK'); }
}
function ready(f) {
  assert.equal(f.schema.ready, true); assert.equal(f.permissions.runtimeProfileMatches, true);
  assert.deepEqual(f.invariants, { rlsEnabled: true, fencesReady: true, financialViewsReady: true, costRetentionReady: true });
  assert.equal(f.snapshotMatches, true);
}
async function reenroll() {
  rootRequest = requestFor(await erasure.checkpoint()); baselineFacts = await facts(); ready(baselineFacts);
}
function checkpointBody(cp, active = true) {
  return { contractVersion: 'sim-ai-root-checkpoint-v1', owner: 'sim_ai_router', scope: 'cop_router_primary_database', storeIncarnation: IDS.store,
    expectedCheckpointId: cp.checkpoint_id, expectedGeneration: cp.checkpoint_generation, checkpointId: randomUUID(), generation: (BigInt(cp.checkpoint_generation) + 1n).toString(),
    proofValidUntilUTC: new Date(Date.now() + 20_000).toISOString(), rootRecordRef: { recordId: randomUUID(), digest: hash('synthetic external checkpoint publication reference') },
    identityReviewed: active, replayReady: active, costPolicy: active ? COST : 'pending_requires_review' };
}
async function applyCheckpoint(body) {
  return (await control.query('SELECT sim_ai_guard_source.apply_root_checkpoint($1::jsonb) AS value', [JSON.stringify(body)])).rows[0].value;
}
async function publish(input = rootRequest, refreshProof = true) {
  if (refreshProof) await registry.query("UPDATE cop_guard.accepted_runtime_proofs SET observed_at=clock_timestamp(),issued_at=clock_timestamp(),valid_until=clock_timestamp()+interval '10 minutes'");
  const id = randomUUID(), requestDigest = aiCheckpointRequestDigest(input), boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const binding = { readPermitId: id, requestDigest, owner: input.owner, scope: input.scope, guardStoreId: IDS.guard,
    continuityEpoch: IDS.epoch, datasetBindingId: IDS.dataset, runtimeBindingId: IDS.runtime, sourceProofId: IDS.proof,
    storeIncarnation: IDS.store, policyGeneration: 1, frontierSequence: FRONTIER, frontierDigest: IDS.frontier };
  const registration = { ...base('ai-router-client-registration'), peer: PEER, runtimeBindingId: IDS.runtime, datasetBindingId: IDS.dataset,
    guardStoreId: IDS.guard, continuityEpoch: IDS.epoch, imageId: NODE_IMAGE, sourceRevision: SOURCE_REVISION, machineBootId: boot };
  await signed(join(STATE, 'ai-clients', `${PEER.device}-${PEER.inode}.json`), registration);
  const evidence = {}, evidencePayloads = {};
  for (const [kind, decision] of Object.entries({ 'ai-router-read-identity': 'sim-preserved-cop-owned',
    'ai-router-read-retention': COST, 'ai-router-read-cost': 'financial-caps-preserved', 'ai-router-read-schema': 'exact-checkpoint-policy-verified' })) {
    const payload = { ...base(kind), ...binding, costPolicy: COST, decision }; evidencePayloads[kind] = payload;
    evidence[kind] = await signed(join(STATE, 'evidence', payload.recordId + '.json'), payload);
  }
  const permit = { ...base('ai-router-read-permit', id), request: input, requestDigest, guardStoreId: IDS.guard,
    continuityEpoch: IDS.epoch, datasetBindingId: IDS.dataset, runtimeBindingId: IDS.runtime, sourceProofId: IDS.proof,
    policyGeneration: 1, frontierSequence: FRONTIER, frontierDigest: IDS.frontier, storeIncarnation: IDS.store,
    expectedSchemaFingerprint: baselineFacts.schema.fingerprint, expectedPrivilegeFingerprint: baselineFacts.permissions.fingerprint, costPolicy: COST, evidence };
  const path = join(STATE, 'ai-read-permits', id + '.json'); await signed(path, permit);
  const identity = (await registry.query('SELECT system_identifier::text AS cluster,(SELECT timeline_id FROM pg_control_checkpoint()) AS timeline FROM pg_control_system()')).rows[0];
  const anchor = { ...base('current-frontier', randomUUID(), 20_000), guardStoreId: IDS.guard, continuityEpoch: IDS.epoch,
    sequence: FRONTIER, digest: IDS.frontier, machineBootId: boot, clusterId: identity.cluster, timelineId: identity.timeline };
  await signed(join(STATE, 'authority', 'current-frontier.json'), anchor);
  return { id, input, path, permit, anchor, evidencePayloads };
}
async function verifiedRead(f, input = f.input, peer = PEER) {
  const out = await inspectRootAiCheckpoint(f.id, input, peer);
  const record = verifyRootRecord(Buffer.from(out.record), publicKeys, 'ai-router-read-admission'), p = record.payload;
  assert.equal(out.admission.contractVersion, 'sim-ai-router-checkpoint-admission-v1'); assert.deepEqual(out.admission.request, input);
  assert.equal(hash(Buffer.from(out.record)), out.admission.reference.digest); assert.equal(p.recordId, out.admission.reference.recordId);
  assert.equal(p.readPermitId, f.id); assert.equal(p.readPermitDigest, hash(await readFile(f.path)));
  assert.equal(p.requestDigest, aiCheckpointRequestDigest(input)); assert.deepEqual(p.request, input); assert.deepEqual(p.peer, peer);
  for (const key of ['guardStoreId', 'continuityEpoch', 'datasetBindingId', 'runtimeBindingId', 'sourceProofId',
    'policyGeneration', 'frontierSequence', 'frontierDigest', 'storeIncarnation']) assert.equal(p[key], f.permit[key]);
  assert.equal(p.schemaFingerprint, baselineFacts.schema.fingerprint); assert.equal(p.privilegeFingerprint, baselineFacts.permissions.fingerprint);
  assert.equal(p.costPolicy, COST); assert.match(p.factsDigest, /^[a-f0-9]{64}$/);
  assert.ok(Date.parse(p.expiresAt) > Date.now() && Date.parse(p.expiresAt) - Date.parse(p.issuedAt) <= 5000);
  assert.equal(out.record.includes('never-return-this-synthetic-credential'), false);
  return out;
}
// This adapter is the actual existing app's verifier seam, NOT a positive
// callback: every successful invocation crosses real custody/TLS/SQL/live
// metadata and verifies the actual signed Root admission for this exact cp.
async function verifyCheckpoint(cp) {
  try { await verifiedRead(currentFixture, requestFor(cp)); verifiedCallbacks++; return true; }
  catch { return false; }
}
async function targetRows() {
  const names = ['ai_router_request', 'ai_router_billing_request', 'ai_router_user_key', 'ai_router_user_key_audit',
    'ai_router_account_erasure', 'ai_router_erased_cost_daily', 'ai_router_erasure_checkpoint', 'ai_router_policy', 'ai_router_policy_audit'];
  const result = {};
  for (const name of names) result[name] = hash(canonical((await admin.query(`SELECT coalesce(jsonb_agg(row ORDER BY row::text),'[]') AS value FROM (SELECT to_jsonb(t) AS row FROM public.${name} t) s`)).rows[0].value));
  result.binding = hash(canonical((await admin.query('SELECT to_jsonb(t) AS value FROM sim_ai_guard_source.store_binding t')).rows));
  return result;
}
async function contents() {
  const metadata = {};
  for (const name of ['guard_identity', 'policies', 'dataset_bindings', 'runtime_bindings', 'accepted_runtime_proofs', 'fence_journal'])
    metadata[name] = (await registry.query(`SELECT coalesce(jsonb_agg(row ORDER BY row::text),'[]') AS value FROM (SELECT to_jsonb(t) AS row FROM cop_guard.${name} t) s`)).rows[0].value;
  return { target: await targetRows(), metadata: hash(canonical(metadata)) };
}
async function denied(f, input = f.input, peer = PEER) { await assert.rejects(inspectRootAiCheckpoint(f.id, input, peer)); }
async function check(name, test, arrange = async () => {}, restore = async () => {}, readOnly = true) {
  stage = name; const f = await publish();
  try {
    await arrange(f); const before = await contents(); await test(f);
    if (readOnly) assert.deepEqual(await contents(), before, 'Reader/denial must not mutate target or registry rows.');
    events.push({ name, passed: true, targetAndRegistryRowsUnchanged: readOnly });
  } finally { await restore(f); }
}
async function bootstrap() {
  assert.deepEqual(process.argv.slice(2), ['--run']); assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'arm64');
  assert.equal(process.getuid(), 0); assert.equal(process.geteuid(), 0); assert.equal(process.version, 'v24.20.0');
  assert.ok(existsSync('/.dockerenv'), 'A new isolated container is mandatory.');
  for (const [iface, addresses] of Object.entries(networkInterfaces())) { assert.equal(iface, 'lo'); assert.ok(addresses.every(a => a.internal)); }
  for (const [path, pin] of Object.entries(pins)) {
    const s = await lstat(path); assert.ok(s.isFile() && s.uid === 0 && s.nlink === 1 && !(s.mode & 0o022)); assert.equal(hash(await readFile(path)), pin);
  }
  ({ canonical, verifyRootRecord } = await import(pathToFileURL(join(OPT, 'root-records.mjs')).href));
  ({ inspectRootAiCheckpoint } = await import(pathToFileURL(join(OPT, 'root-checkpoint-read.mjs')).href));
  ({ aiCheckpointRequestDigest, matchAiCheckpointPolicy } = await import(pathToFileURL(join(OPT, 'checkpoint-facts.mjs')).href));
  appSourceDigest = await compiledDigest();
  ({ BudgetStore } = await import(pathToFileURL(join(OPT, 'router-app', 'budget.js')).href));
  ({ PgAccountErasure } = await import(pathToFileURL(join(OPT, 'router-app', 'account-erasure.js')).href));
  ({ PgSeparateBilling } = await import(pathToFileURL(join(OPT, 'router-app', 'separate-billing.js')).href));
  ({ createApp } = await import(pathToFileURL(join(OPT, 'router-app', 'app.js')).href));
  const p = readFileSync('/etc/passwd', 'utf8').split('\n').find(row => row.startsWith('postgres:'))?.split(':');
  assert.ok(p); PG_USER = { uid: Number(p[2]), gid: Number(p[3]) }; assert.ok(PG_USER.uid > 0 && PG_USER.gid > 0);
  for (const path of [ETC, STATE, PGROOT]) { assert.equal(existsSync(path), false); await mkdir(path, { mode: 0o700 }); }
  for (const name of ['root', 'public']) await mkdir(join(ETC, name), { mode: 0o700 });
  for (const name of ['authority', 'ai-clients', 'ai-read-permits', 'evidence']) await mkdir(join(STATE, name), { mode: 0o700 });
  await chown(PGROOT, PG_USER.uid, PG_USER.gid); await mkdir(join(PGROOT, 'socket'), { mode: 0o700 }); await chown(join(PGROOT, 'socket'), PG_USER.uid, PG_USER.gid);
  tls = certificates(); await privateFile(join(ETC, 'public', 'postgres-ca.crt'), tls.ca, 0o644);
  for (const [name, bytes] of [['server.crt', tls.cert], ['server.key', tls.key], ['bootstrap-password', passwords.admin]]) {
    await privateFile(join(PGROOT, name), bytes); await chown(join(PGROOT, name), PG_USER.uid, PG_USER.gid);
  }
  assert.match((await pgCommand('postgres', ['--version'])).stdout, /^postgres \(PostgreSQL\) 18\.6(?:\s|$)/);
  await pgCommand('initdb', ['-D', join(PGROOT, 'data'), '--username=synthetic_admin', '--pwfile=' + join(PGROOT, 'bootstrap-password'),
    '--auth-local=trust', '--auth-host=scram-sha-256', '--encoding=UTF8', '--locale=C'], 30_000); await unlink(join(PGROOT, 'bootstrap-password'));
  await privateFile(join(PGROOT, 'data', 'pg_hba.conf'), 'local all all trust\nhostssl all all 127.0.0.1/32 scram-sha-256\nhostnossl all all 127.0.0.1/32 reject\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n');
  await chown(join(PGROOT, 'data', 'pg_hba.conf'), PG_USER.uid, PG_USER.gid);
  await pgCommand('pg_ctl', ['-D', join(PGROOT, 'data'), '-l', join(PGROOT, 'server.log'), '-o',
    `-k ${join(PGROOT, 'socket')} -p ${PORT} -c listen_addresses=127.0.0.1 -c unix_socket_permissions=0700 -c ssl=on -c ssl_cert_file=${join(PGROOT, 'server.crt')} -c ssl_key_file=${join(PGROOT, 'server.key')} -c timezone=UTC -c log_statement=none -c log_min_error_statement=panic -c max_prepared_transactions=0`, '-w', 'start']); started = true;
  const bootstrapClient = client('postgres'); await bootstrapClient.connect();
  await bootstrapClient.query(`CREATE ROLE ai_router_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE ai_router_runtime LOGIN PASSWORD '${passwords.runtime}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_ai_guard_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_ai_guard_control LOGIN PASSWORD '${passwords.control}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE synthetic_registry_reader LOGIN PASSWORD '${passwords.registry}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    ALTER ROLE synthetic_registry_reader SET default_transaction_read_only=on;
    ALTER ROLE ai_router_runtime SET search_path=pg_catalog,public`);
  await bootstrapClient.query('CREATE DATABASE sim_ai_router OWNER ai_router_migrator'); await bootstrapClient.query('CREATE DATABASE cop_account_safety_guard');
  admin = client('sim_ai_router'); registry = client('cop_account_safety_guard'); await admin.connect(); await registry.connect();
  assert.equal((await admin.query("SELECT current_setting('data_directory') AS value")).rows[0].value, join(PGROOT, 'data'));
  await admin.query('SET ROLE ai_router_migrator');
  for (const file of ['001_schema.sql', '002_separate_billing.sql', '003_account_erasure.sql']) await admin.query(await readFile(join('/fixture/sql', file), 'utf8'));
  await admin.query(`RESET ROLE; REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    REVOKE TEMP ON DATABASE sim_ai_router FROM PUBLIC;
    GRANT SELECT,INSERT,UPDATE ON ai_router_request,ai_router_policy,ai_router_policy_audit TO ai_router_runtime;
    GRANT USAGE,SELECT ON SEQUENCE ai_router_policy_audit_id_seq TO ai_router_runtime;
    CREATE SCHEMA sim_ai_guard_source AUTHORIZATION sim_ai_guard_owner`);
  await admin.query(await readFile('/fixture/sql/004_root_checkpoint_facts.sql', 'utf8'));
  await admin.query('INSERT INTO sim_ai_guard_source.store_binding VALUES(true,$1)', [IDS.store]);
  control = client('sim_ai_router', 'sim_ai_guard_control', passwords.control); await control.connect();
  const initial = (await admin.query('SELECT checkpoint_id,checkpoint_generation::text AS checkpoint_generation FROM ai_router_erasure_checkpoint WHERE id=1')).rows[0];
  prePublisherPrivilegeFingerprint = (await facts(requestFor({ ...initial, operation_digest: '0'.repeat(64), schema_digest: '0'.repeat(64) }))).permissions.fingerprint;
  await admin.query(await readFile('/fixture/sql/005_root_checkpoint.sql', 'utf8'));
  await admin.query('INSERT INTO ai_router_account_erasure(operation_id,owner_hash,target_hash,body_digest) VALUES($1,$2,$3,$4)',
    [IDS.operation, hash('synthetic original owner'), IDS.canary, hash('synthetic immutable original request')]);
  await admin.query(`INSERT INTO ai_router_erased_cost_daily VALUES
    ('legacy',current_date,123,1,3,4,(date_trunc('month',current_date::timestamp)+interval '1 month') AT TIME ZONE 'UTC'),
    ('user_openai_key',current_date,456,1,5,6,(date_trunc('month',current_date::timestamp)+interval '1 month') AT TIME ZONE 'UTC')`);
  await admin.query("INSERT INTO ai_router_user_key(user_hash,ciphertext,nonce,auth_tag,fingerprint) VALUES($1,$2,$3,$4,'synthetic-canary')",
    [hash('synthetic unrelated key holder'), Buffer.from('never-return-this-synthetic-credential'), randomBytes(12), randomBytes(16)]);
  await registry.query(`CREATE SCHEMA cop_guard;
    CREATE TABLE cop_guard.guard_identity(singleton boolean PRIMARY KEY,guard_store_id uuid,application_id text,guard_contract_version text,stream_scope_id text,initial_prefix_digest text);
    CREATE TABLE cop_guard.policies(guard_store_id uuid,policy_generation integer,policy_id text,continuity_epoch uuid);
    CREATE TABLE cop_guard.dataset_bindings(dataset_binding_id uuid,guard_store_id uuid,owner_id text,continuity_epoch uuid,target_incarnation_id uuid,projection_contract_id text);
    CREATE TABLE cop_guard.runtime_bindings(binding_id uuid,dataset_binding_id uuid,owner_id text,policy_generation integer,image_id text,source_revision text);
    CREATE TABLE cop_guard.accepted_runtime_proofs(proof_id uuid,binding_id uuid,observed_at timestamptz,issued_at timestamptz,valid_until timestamptz,frontier_sequence integer,frontier_digest text);
    CREATE TABLE cop_guard.fence_journal(sequence bigint PRIMARY KEY,entry_digest text);
    GRANT USAGE ON SCHEMA cop_guard TO synthetic_registry_reader;
    GRANT SELECT ON ALL TABLES IN SCHEMA cop_guard TO synthetic_registry_reader;
    GRANT EXECUTE ON FUNCTION pg_control_system(),pg_control_checkpoint() TO synthetic_registry_reader`);
  // Concrete columns from COP's actual SELECT, not production enrollment DDL.
  await registry.query("INSERT INTO cop_guard.guard_identity VALUES(true,$1,'cop','cop-account-safety-runtime-v1','cop-global-fences-v1',$2)", [IDS.guard, hash('synthetic empty prefix')]);
  await registry.query("INSERT INTO cop_guard.policies VALUES($1,1,'cop-jizda-only-sim-preserved-v1',$2)", [IDS.guard, IDS.epoch]);
  await registry.query("INSERT INTO cop_guard.dataset_bindings VALUES($1,$2,'sim_ai_router',$3,$4,'cop-sim-ai-projection-v1')", [IDS.dataset, IDS.guard, IDS.epoch, IDS.store]);
  await registry.query("INSERT INTO cop_guard.runtime_bindings VALUES($1,$2,'sim_ai_router',1,$3,$4)", [IDS.runtime, IDS.dataset, NODE_IMAGE, SOURCE_REVISION]);
  await registry.query("INSERT INTO cop_guard.accepted_runtime_proofs VALUES($1,$2,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '10 minutes',$3,$4)", [IDS.proof, IDS.runtime, FRONTIER, IDS.frontier]);
  await registry.query('INSERT INTO cop_guard.fence_journal VALUES($1,$2)', [FRONTIER, IDS.frontier]);
  assert.equal((await control.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0].ssl, true);
  rootKey = generateKeyPairSync('ed25519'); const pub = rootKey.publicKey.export({ format: 'jwk' });
  publicKeys = { contractVersion: 'cop-root-verification-keys-v1', keys: [{ kid: 'synthetic-ai-root', kty: 'OKP', crv: 'Ed25519', x: pub.x }] };
  await privateFile(join(ETC, 'public', 'verification-keys.json'), canonical(publicKeys) + '\n', 0o644);
  await privateFile(join(STATE, 'authority', 'signing-key.pkcs8'), rootKey.privateKey.export({ type: 'pkcs8', format: 'pem' })); await profile();
  const old = (await admin.query('SELECT checkpoint_id,checkpoint_generation::text AS generation FROM ai_router_erasure_checkpoint WHERE id=1')).rows[0];
  const policy = { ...base('ai-router-checkpoint-policy'), owner: 'sim_ai_router', storeIncarnation: IDS.store, costPolicy: COST };
  const policyPath = join(STATE, 'evidence', policy.recordId + '.json'), policyRef = await signed(policyPath, policy);
  verifyRootRecord(await readFile(policyPath), publicKeys, 'ai-router-checkpoint-policy');
  const applied = (await control.query('SELECT sim_ai_guard_source.apply_root_checkpoint($1::jsonb) AS value', [JSON.stringify({
    contractVersion: 'sim-ai-root-checkpoint-v1', owner: 'sim_ai_router', scope: 'cop_router_primary_database', storeIncarnation: IDS.store,
    expectedCheckpointId: old.checkpoint_id, expectedGeneration: old.generation, checkpointId: randomUUID(), generation: (BigInt(old.generation) + 1n).toString(),
    proofValidUntilUTC: new Date(Date.now() + 20_000).toISOString(), rootRecordRef: policyRef, identityReviewed: true, replayReady: true, costPolicy: COST })])).rows[0].value;
  assert.equal(applied.checkpoint.generation, '1'); assert.equal(applied.checkpoint.identityReviewed, true);
  // Synthetic test-only 005 publication is not actual COP owner enrollment.
  const url = `postgresql://ai_router_runtime:${passwords.runtime}@127.0.0.1:${PORT}/sim_ai_router`;
  const limits = { dailyMicrousd: 1_000_000, monthlyMicrousd: 10_000_000, perUserDailyRequests: 10 };
  store = new BudgetStore(url, randomBytes(32).toString('hex'), limits); store.pool.options.ssl = ssl();
  store.pool.on('error', () => {}); await store.init();
  await admin.query('UPDATE ai_router_policy SET external_allowed=true WHERE id=1');
  erasure = new PgAccountErasure(store.pool, COST, true, verifyCheckpoint); await erasure.checkSchema();
  await reenroll();
  config = { port: 0, databaseUrl: url, copToken: randomBytes(32).toString('hex'), simToken: randomBytes(32).toString('hex'),
    adminToken: randomBytes(32).toString('hex'), userHashSecret: randomBytes(32).toString('hex'), openaiKey: '', externalEnabled: true,
    copInternalMinimizedEnabled: false, advancedEnabled: false, localUrl: '', localModel: '', economyModel: 'gpt-6-luna', advancedModel: 'gpt-6-sol',
    ...limits, copActorSecret: randomBytes(32).toString('hex'), credentialEncryptionKey: randomBytes(32).toString('base64'),
    copByokEnabled: true, simIzsEnabled: false, byokDailyMicrousd: 1_000_000, byokMonthlyMicrousd: 10_000_000, byokDailyRequests: 10,
    accountErasureEnabled: false, accountErasureReplayReady: true, accountErasureCostPolicy: COST };
  separate = new PgSeparateBilling(store.pool, config.credentialEncryptionKey, erasure); await separate.checkSchema();
  server = await new Promise((resolve, reject) => { const s = createApp(config, store, separate, erasure).listen(0, '127.0.0.1', () => resolve(s)); s.once('error', reject); });
  baseUrl = `http://127.0.0.1:${server.address().port}`; syntheticKey = 'sk-synthetic-byok-' + randomBytes(24).toString('hex');
  globalThis.fetch = async (url, init) => {
    assert.ok(new Headers(init?.headers).get('authorization') === 'Bearer ' + syntheticKey, 'Synthetic provider credential mismatch'); providerCalls++;
    if (String(url) === 'https://api.openai.com/v1/models/gpt-6-luna') return new Response('{}', { status: 200 });
    assert.equal(String(url), 'https://api.openai.com/v1/responses'); assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init.body)); assert.equal(body.model, 'gpt-6-luna'); assert.equal(body.store, false);
    return new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: 'Synthetic advisory only.' }] }], usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200 });
  };
}
function headers() {
  const now = Math.floor(Date.now() / 1000), encoded = Buffer.from(JSON.stringify({ sub: 'opaque_synthetic_ai_user', aud: 'sim-ai-router', iat: now, exp: now + 40 })).toString('base64url');
  return { authorization: 'Bearer ' + config.copToken, 'content-type': 'application/json', 'x-cop-actor': encoded,
    'x-cop-actor-signature': createHmac('sha256', config.copActorSecret).update(encoded).digest('hex') };
}
async function http(path, method, body) {
  const response = await originalFetch(baseUrl + path, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  const text = await response.text(); assert.equal(text.includes(syntheticKey), false);
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const chat = { contractVersion: 'cop-chat-byok-v1', billingSource: 'user_openai_key', question: 'Describe this synthetic service check.', allowExternal: true };
async function run() {
  await bootstrap();
  await check('actual facts/checkpoint parity and 005 narrow ACL/CAS/quarantine/changed pin', async fixture => {
    const before = await contents();
    const cp = await erasure.checkpoint(), f = await facts(); ready(f); assert.deepEqual(f.checkpoint, cp);
    assert.equal(canonical(f.checkpoint), canonical(cp));
    assert.equal((await store.pool.query('SHOW search_path')).rows[0].search_path, 'pg_catalog, public');
    matchAiCheckpointPolicy(f, rootRequest, { storeIncarnation: IDS.store, schemaFingerprint: baselineFacts.schema.fingerprint, privilegeFingerprint: baselineFacts.permissions.fingerprint, costPolicy: COST });
    assert.notEqual(f.permissions.fingerprint, prePublisherPrivilegeFingerprint, 'Actual 005 ACL/function installation invalidates the old reviewed privilege pin.');
    assert.throws(() => matchAiCheckpointPolicy(f, rootRequest, { storeIncarnation: IDS.store, schemaFingerprint: baselineFacts.schema.fingerprint, privilegeFingerprint: prePublisherPrivilegeFingerprint, costPolicy: COST }));
    const rights = (await admin.query(`SELECT
      NOT has_table_privilege('sim_ai_guard_owner','ai_router_erasure_checkpoint','UPDATE') AS narrow,
      has_column_privilege('sim_ai_guard_owner','ai_router_erasure_checkpoint','identity_reviewed','UPDATE') AS reviewed,
      has_column_privilege('sim_ai_guard_owner','ai_router_erasure_checkpoint','updated_at','UPDATE') AS timestamp,
      NOT has_column_privilege('sim_ai_guard_owner','ai_router_erasure_checkpoint','schema_version','UPDATE') AS version_fixed,
      NOT has_column_privilege('sim_ai_guard_owner','ai_router_erasure_checkpoint','id','UPDATE') AS id_fixed,
      NOT has_any_column_privilege('sim_ai_guard_control','ai_router_erasure_checkpoint','UPDATE') AS no_direct_control_write,
      NOT has_any_column_privilege('ai_router_runtime','ai_router_erasure_checkpoint','UPDATE') AS no_runtime_write,
      has_function_privilege('sim_ai_guard_control','sim_ai_guard_source.apply_root_checkpoint(jsonb)','EXECUTE') AS control_exec,
      NOT has_function_privilege('ai_router_runtime','sim_ai_guard_source.apply_root_checkpoint(jsonb)','EXECUTE') AS no_runtime_exec`)).rows[0];
    assert.ok(Object.values(rights).every(value => value === true));
    await assert.rejects(control.query('SELECT sim_ai_guard_source.read_checkpoint_facts($1::jsonb)', [JSON.stringify(rootRequest)]));
    const casBody = { ...checkpointBody(cp), expectedCheckpointId: randomUUID() };
    await assert.rejects(applyCheckpoint(casBody), error => error.code === '23505');
    assert.deepEqual(await contents(), before);
    const quarantined = await applyCheckpoint(checkpointBody(cp, false));
    assert.equal(quarantined.checkpoint.generation, (BigInt(cp.checkpoint_generation) + 1n).toString());
    const quarantineCp = await erasure.checkpoint(), quarantineRequest = requestFor(quarantineCp), quarantineFacts = await facts(quarantineRequest);
    assert.equal(quarantineFacts.checkpoint.identity_reviewed, false); assert.equal(quarantineFacts.checkpoint.replay_ready, false);
    assert.equal(quarantineFacts.checkpoint.cost_policy, 'pending_requires_review');
    assert.throws(() => matchAiCheckpointPolicy(quarantineFacts, quarantineRequest, { storeIncarnation: IDS.store,
      schemaFingerprint: baselineFacts.schema.fingerprint, privilegeFingerprint: baselineFacts.permissions.fingerprint, costPolicy: COST }));
    await denied(fixture); await applyCheckpoint(checkpointBody(quarantineCp)); await reenroll();
    const after = await contents(); assert.equal(after.metadata, before.metadata);
    for (const name of Object.keys(before.target)) if (name !== 'ai_router_erasure_checkpoint') assert.equal(after.target[name], before.target[name]);
    assert.notEqual(after.target.ai_router_erasure_checkpoint, before.target.ai_router_erasure_checkpoint);
  }, undefined, undefined, false);
  await check('actual RLS drift is observed and rejected', async f => { assert.equal((await facts()).invariants.rlsEnabled, false); await denied(f); },
    () => admin.query('ALTER TABLE ai_router_request DISABLE ROW LEVEL SECURITY'),
    async () => { await admin.query('ALTER TABLE ai_router_request ENABLE ROW LEVEL SECURITY'); await reenroll(); });
  await check('actual disabled permanent fence trigger is observed and rejected', async f => { assert.equal((await facts()).invariants.fencesReady, false); await denied(f); },
    () => admin.query('ALTER TABLE ai_router_user_key DISABLE TRIGGER ai_router_key_erasure_fence'),
    async () => { await admin.query('ALTER TABLE ai_router_user_key ENABLE TRIGGER ai_router_key_erasure_fence'); await reenroll(); });
  await check('actual financial view security drift is observed and rejected', async f => { assert.equal((await facts()).invariants.financialViewsReady, false); await denied(f); },
    () => admin.query('ALTER VIEW ai_router_billing_usage SET (security_invoker=false)'),
    async () => { await admin.query('ALTER VIEW ai_router_billing_usage SET (security_invoker=true)'); await reenroll(); });
  await check('actual column-level checkpoint privilege drift is rejected', async f => { assert.equal((await facts()).permissions.runtimeProfileMatches, false); await denied(f); },
    () => admin.query('GRANT UPDATE(checkpoint_id) ON ai_router_erasure_checkpoint TO ai_router_runtime'),
    async () => { await admin.query('REVOKE UPDATE(checkpoint_id) ON ai_router_erasure_checkpoint FROM ai_router_runtime');
      // Explicit synthetic reenrollment: GRANT/REVOKE can leave empty ACLs.
      await reenroll(); });
  await check('actual owner/store and nullable/mismatched snapshot fail closed', async f => {
    const mismatched = { ...rootRequest, expectedSnapshot: { ...rootRequest.expectedSnapshot, checkpointId: randomUUID() } };
    assert.equal((await facts(mismatched)).snapshotMatches, false); await denied(f, mismatched);
    await assert.rejects(facts({ ...rootRequest, owner: 'sim_driver_measurements' }));
    await admin.query('UPDATE sim_ai_guard_source.store_binding SET incarnation=$1', [randomUUID()]);
    try { await denied(f); } finally { await admin.query('UPDATE sim_ai_guard_source.store_binding SET incarnation=$1', [IDS.store]); }
    // JSON preserves PostgreSQL timestamp microseconds across restoration;
    // node-postgres Date conversion would silently truncate the original row.
    const cp = (await admin.query('SELECT to_jsonb(t) AS value FROM ai_router_erasure_checkpoint t WHERE id=1')).rows[0].value;
    await admin.query('DELETE FROM ai_router_erasure_checkpoint WHERE id=1');
    try { assert.equal((await facts()).checkpoint, null); await denied(f); }
    finally { await admin.query('INSERT INTO ai_router_erasure_checkpoint SELECT * FROM jsonb_populate_record(NULL::ai_router_erasure_checkpoint,$1::jsonb)', [JSON.stringify(cp)]); }
  });
  await check('actual signed Root chain and frozen trust-set signer/keyring checks', async f => {
    await verifiedRead(f);
    const signerPath = join(STATE, 'authority', 'signing-key.pkcs8'), keysPath = join(ETC, 'public', 'verification-keys.json');
    const signerBytes = await readFile(signerPath), keysBytes = await readFile(keysPath);
    const unrelated = generateKeyPairSync('ed25519');
    await privateFile(signerPath, unrelated.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    try { await denied(f); } finally { await privateFile(signerPath, signerBytes); }
    const otherKeyring = { contractVersion: 'cop-root-verification-keys-v1', keys: [{ kid: 'unrelated-synthetic-key', kty: 'OKP', crv: 'Ed25519', x: unrelated.publicKey.export({ format: 'jwk' }).x }] };
    await privateFile(keysPath, canonical(otherKeyring) + '\n', 0o644);
    try { await denied(f); } finally { await privateFile(keysPath, keysBytes, 0o644); }
    // This is an ordinary changed-keyring negative, not a deterministic race
    // during issue(). The reader itself owns its before/after custody checks.
    await verifiedRead(f);
  });
  await check('forged and expired signed permits plus private custody violations reject', async f => {
    const bytes = await readFile(f.path), forged = JSON.parse(bytes); forged.signature = (forged.signature[0] === 'A' ? 'B' : 'A') + forged.signature.slice(1);
    await privateFile(f.path, canonical(forged) + '\n'); await denied(f);
    await signed(f.path, { ...f.permit, issuedAt: new Date(Date.now() - 10_000).toISOString(), expiresAt: new Date(Date.now() - 5000).toISOString() }); await denied(f);
    await privateFile(f.path, bytes, 0o640); await denied(f); await chmod(f.path, 0o600);
    const other = join(STATE, 'ai-read-permits', randomUUID() + '.json'); await privateFile(other, bytes); await unlink(f.path); await symlink(other, f.path); await denied(f);
  });
  await check('synthetic peer and exact signed request mismatch reject', async f => {
    await denied(f, f.input, Object.freeze({ ...PEER, uid: PEER.uid + 1 }));
    await denied(f, { ...f.input, expectedSnapshot: { ...f.input.expectedSnapshot, generation: (BigInt(f.input.expectedSnapshot.generation) + 1n).toString() } });
  });
  await check('valid signatures cannot hide incorrect cost-policy evidence', async f => {
    const kind = 'ai-router-read-cost', payload = f.evidencePayloads[kind];
    const badRef = await signed(join(STATE, 'evidence', payload.recordId + '.json'), { ...payload, costPolicy: 'pending_requires_review' });
    await signed(f.path, { ...f.permit, evidence: { ...f.permit.evidence, [kind]: badRef } }); await denied(f);
    await signed(f.path, { ...f.permit, costPolicy: 'pending_requires_review' }); await denied(f);
  });
  await check('independent frontier and actual live frontier/proof drift reject', async f => {
    await signed(join(STATE, 'authority', 'current-frontier.json'), { ...f.anchor, sequence: FRONTIER + 1 }); await denied(f);
    await signed(join(STATE, 'authority', 'current-frontier.json'), f.anchor);
    await registry.query('INSERT INTO cop_guard.fence_journal VALUES($1,$2)', [FRONTIER + 1, hash('synthetic divergent frontier')]);
    try { await denied(f); } finally { await registry.query('DELETE FROM cop_guard.fence_journal WHERE sequence=$1', [FRONTIER + 1]); }
    const proof = (await registry.query('SELECT valid_until::text AS valid_until FROM cop_guard.accepted_runtime_proofs')).rows[0];
    await registry.query("UPDATE cop_guard.accepted_runtime_proofs SET valid_until=clock_timestamp()-interval '1 second'");
    try { await denied(f); } finally { await registry.query('UPDATE cop_guard.accepted_runtime_proofs SET valid_until=$1', [proof.valid_until]); }
  });
  await check('reader does not mutate ledger/fence/credential/billing/rollup and omits raw data', async f => {
    const before = await contents(), out = await verifiedRead(f); assert.deepEqual(await contents(), before);
    const observation = JSON.stringify(await facts());
    for (const canary of ['never-return-this-synthetic-credential', IDS.canary, IDS.operation]) { assert.equal(observation.includes(canary), false); assert.equal(out.record.includes(canary), false); }
    assert.equal((await store.pool.query("SELECT has_schema_privilege(current_user,'sim_ai_guard_source','USAGE') AS value")).rows[0].value, false);
    await assert.rejects(store.pool.query('SELECT sim_ai_guard_source.read_checkpoint_facts($1::jsonb)', [JSON.stringify(rootRequest)]));
  });
  await check('real Router BYOK succeeds with erasure disabled and actual Root checkpoint verification', async f => {
    currentFixture = f; const callbacksBefore = verifiedCallbacks, providerBefore = providerCalls;
    const cap = await erasure.capability(false); assert.equal(cap.enabled, false); assert.equal(cap.ready, false); assert.equal(cap.checks.restoreCheckpointCurrent, true);
    assert.deepEqual(cap.blockers, ['erasure_disabled']);
    const before = await targetRows(), key = await http('/api/v1/ai-router/cop/users/me/openai-key', 'PUT', { apiKey: syntheticKey }); assert.equal(key.status, 200);
    const answer = await http('/api/v1/ai-router/cop/chat', 'POST', chat); assert.equal(answer.status, 200);
    assert.equal(answer.body.billingSource, 'user_openai_key'); assert.equal(answer.body.usage.actualProviderChargesVerified, false);
    assert.equal(answer.body.output, 'Synthetic advisory only.'); assert.equal(providerCalls - providerBefore, 2); assert.ok(verifiedCallbacks - callbacksBefore >= 6);
    const stored = (await admin.query('SELECT ciphertext,nonce,auth_tag FROM ai_router_user_key WHERE user_hash=$1', [store.hashUser('cop', 'opaque_synthetic_ai_user')])).rows[0];
    assert.ok(stored && !stored.ciphertext.equals(Buffer.from(syntheticKey)) && stored.nonce.length === 12 && stored.auth_tag.length === 16);
    const bill = (await admin.query('SELECT status,input_tokens,output_tokens,estimated_microusd FROM ai_router_billing_request WHERE id=$1', [answer.body.requestId])).rows[0];
    assert.equal(bill.status, 'success'); assert.equal(bill.input_tokens, 100); assert.equal(bill.output_tokens, 20); assert.ok(BigInt(bill.estimated_microusd) > 0n);
    const after = await targetRows();
    for (const name of ['ai_router_account_erasure', 'ai_router_erased_cost_daily', 'ai_router_erasure_checkpoint', 'ai_router_request', 'ai_router_policy', 'ai_router_policy_audit', 'binding']) assert.equal(after[name], before[name]);
    assert.notEqual(after.ai_router_user_key, before.ai_router_user_key); assert.notEqual(after.ai_router_user_key_audit, before.ai_router_user_key_audit); assert.notEqual(after.ai_router_billing_request, before.ai_router_billing_request);
  }, undefined, undefined, false);
  await check('real Router BYOK denies invalid/revoked Root before provider or database mutation', async f => {
    currentFixture = f; const before = await targetRows(), providerBefore = providerCalls, callbacksBefore = verifiedCallbacks;
    const intactRegistry = await contents();
    await signed(f.path, { ...f.permit, issuedAt: new Date(Date.now() - 10_000).toISOString(), expiresAt: new Date(Date.now() - 5000).toISOString() });
    for (const [path, method, body] of [['/api/v1/ai-router/cop/chat', 'POST', chat], ['/api/v1/ai-router/cop/users/me/openai-key', 'PUT', { apiKey: syntheticKey }]]) {
      const response = await http(path, method, body); assert.equal(response.status, 503); assert.equal(response.body.error, 'account_erasure_store_unavailable');
    }
    assert.deepEqual(await contents(), intactRegistry);
    await signed(f.path, f.permit); await registry.query('DELETE FROM cop_guard.accepted_runtime_proofs WHERE proof_id=$1', [IDS.proof]);
    const revokedRegistry = await contents();
    const response = await http('/api/v1/ai-router/cop/chat', 'POST', chat); assert.equal(response.status, 503); assert.equal(response.body.error, 'account_erasure_store_unavailable');
    assert.deepEqual(await contents(), revokedRegistry);
    assert.equal(providerCalls, providerBefore); assert.equal(verifiedCallbacks, callbacksBefore);
    assert.deepEqual(await targetRows(), before);
    // Metadata revocation is deliberate arrangement, not a reader mutation.
    await registry.query("INSERT INTO cop_guard.accepted_runtime_proofs VALUES($1,$2,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '10 minutes',$3,$4)", [IDS.proof, IDS.runtime, FRONTIER, IDS.frontier]);
  }, undefined, undefined, false);
  assert.equal(events.length, 14);
  for (const [path, pin] of Object.entries(pins)) assert.equal(hash(await readFile(path)), pin);
  assert.equal(await compiledDigest(), appSourceDigest);
  return { contractVersion: 'sim-ai-checkpoint-root-isolated-linux-evidence-v1', scope: 'synthetic_root_actual_sql001_to005_and_compiled_router_byok',
    passed: events.length, cases: events, startedAt, completedAt: new Date().toISOString(), node: process.version, postgres: '18.6', platform: process.platform,
    architecture: process.arch, nodeImageId: NODE_IMAGE, postgresImageId: PG_IMAGE, sourcePins: pins, compiledAppSourceDigest: appSourceDigest,
    realEd25519: true, realRootFileCustody: true, realLoopbackStrictTls: true, realPostgres: true, realCompiledRouter: true,
    actualRootVerifiedCallbackSuccesses: verifiedCallbacks, unconditionalPositiveCallbacks: 0, pgStubs: 0, providerResponseStubs: providerCalls,
    actualProviderAcceptance: false, peerSource: 'frozen_synthetic_fixture_not_kernel_observation', productionEnrollment: false,
    nativePeerAcceptance: false, deployment: false, activation: false, wholeAccountComplete: false };
}
let output, failure;
try { output = await run(); }
catch (error) { failure = { contractVersion: 'sim-ai-checkpoint-root-isolated-linux-evidence-v1', passed: events.length, cases: events,
  failedStage: stage, errorClass: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : null,
  assertionDetail: error?.code === 'ERR_ASSERTION' ? String(error.message).slice(0, 800) : null,
  productionEnrollment: false, deployment: false, activation: false }; process.exitCode = 1; }
finally {
  globalThis.fetch = originalFetch;
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (store) await store.pool.end().catch(() => {});
  for (const c of clients) await c.end().catch(() => {});
  if (started) try { await pgCommand('pg_ctl', ['-D', join(PGROOT, 'data'), '-m', 'immediate', '-w', 'stop']); }
  catch { failure ??= { failedStage: 'isolated cluster cleanup', productionEnrollment: false, activation: false }; process.exitCode = 1; }
  clearTimeout(deadline);
}
process.stdout.write(JSON.stringify(failure ?? output) + '\n');
