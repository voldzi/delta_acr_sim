/**
 * NEW isolated Linux/PG18.6 Root-reader integration, NOT the Mac PG18.3 facts
 * suite or production Root enrollment. Main reviews and is the sole runner.
 * No callback, mock pg, UID shim, verifier shim, network fetch or origin RPC.
 *
 * Standalone layout also supports the main runner's docker-create/cp fallback:
 * /opt/cop-account-safety: pinned reader/facts/COP helper/package.json/real pg
 * /fixture/sql: the four actual pinned target SQL sources
 * /fixture/harness.mjs: this file. Run as Root in a NEW --network none container.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, chown, lstat, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { checkServerIdentity } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const OPT = '/opt/cop-account-safety', ETC = '/etc/cop-account-safety';
const STATE = '/var/lib/cop-account-safety', PGROOT = '/var/lib/postgresql/driver-read-root-pg';
const PORT = 6543, PROXY_PORT = 6544;
const NODE_IMAGE = 'sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf';
const PG_IMAGE = 'sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';
const pins = Object.freeze({
  '/fixture/sql/schema.sql': '6dd60a3acf28d63575198c8526c368df19bbd543f4063d4985fb55f308da02d0',
  '/fixture/sql/002_account_erasure.sql': 'f13db2106a1fe1a02d0d1a26afa8ad7d7c045172ba4419749719ed0f166e16ad',
  '/fixture/sql/003_guarded_operations.sql': 'e3513a983a3b6d1bd52d46851c734dd1c3b208e2e2f6430a6f9eddd38b10d3b5',
  '/fixture/sql/004_read_admission_facts.sql': '791545b9df91e65bb555c68a44dadd73a847ca64fde0c31a9036f9f555ba1d2d',
  '/opt/cop-account-safety/root-records.mjs': 'ad203b1a1858bea7f8f799a6147720d1d0d6df790bfc1d4c866a12c45d6bb7fd',
  '/opt/cop-account-safety/root-read-admission.mjs': 'cbd1b4c4fa6d8c75ff06a9f5ea9aef0948477a530e73bc7e8c85cfe464197192',
  '/opt/cop-account-safety/read-admission-facts.mjs': '756d25ae2ce00c9a02a6295a5d00812732a04b01ace82c347f68e58a902d0456',
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const events = [], clients = new Set();
let stage = 'fixture preconditions', started = false, admin, registry, control, PG_USER;
let canonical, verifyRootRecord, inspectRootDriver, driverReadRequestDigest;
let tls, rootKey, publicKeys, baselineFacts;
const startedAt = new Date().toISOString();
const deadline = setTimeout(() => {
  process.stderr.write('DRIVER_READ_ROOT_FIXTURE_DEADLINE\n'); process.exit(2);
}, 150_000);
const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: PGROOT, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
const IDS = Object.freeze({ store: randomUUID(), guard: randomUUID(), epoch: randomUUID(), dataset: randomUUID(),
  runtime: randomUUID(), proof: randomUUID(), operation: hash('synthetic read-root business operation'),
  actor: hash('synthetic read-root actor'), request: hash('synthetic original erasure request'),
  checkpoint: hash('synthetic checkpoint, not production replay evidence'), frontier: hash('synthetic independent frontier') });
const FRONTIER = 7;
// Deliberately synthetic. This frozen tuple is NOT a kernel-observed peer or a
// native-channel acceptance claim. Native peer authentication belongs to COP.
const PEER = Object.freeze({ device: '101', inode: '202', uid: 1000, gid: 1000 });
const IMAGE_ID = NODE_IMAGE, SOURCE_REVISION = 'f3c05e3ae1ca3081d2f5551bc03da233c0c3a473';
const passwords = Object.freeze({ control: randomBytes(32).toString('hex'), registry: randomBytes(32).toString('hex'), admin: randomBytes(32).toString('hex') });
const request = purpose => ({ owner: 'sim_driver_measurements', scope: 'online_driver_scope', purpose,
  ...(['preflight', 'status', 'receipt'].includes(purpose) ? { operationHash: IDS.operation, actorHash: IDS.actor } : {}) });

// Minimal actual X.509 generation: RSA/SHA256 DER, no openssl CLI/package/network.
// X509Certificate below verifies both generated certificates before PG sees them.
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
  const ca = generateKeyPairSync('rsa', { modulusLength: 2048 }), server = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const caPem = certificate('Synthetic Driver Read Root CA', 'Synthetic Driver Read Root CA', ca, ca.privateKey, true);
  const serverPem = certificate('localhost', 'Synthetic Driver Read Root CA', server, ca.privateKey, false);
  const caX = new X509Certificate(caPem), serverX = new X509Certificate(serverPem);
  assert.equal(caX.ca, true); assert.equal(caX.verify(ca.publicKey), true);
  assert.equal(serverX.checkIssued(caX), true); assert.equal(serverX.verify(ca.publicKey), true);
  assert.equal(serverX.checkHost('localhost'), 'localhost'); assert.equal(serverX.checkIP('127.0.0.1'), '127.0.0.1');
  return { ca: caPem, cert: serverPem, key: server.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
async function privateFile(path, bytes, mode = 0o600) { await writeFile(path, bytes, { mode }); await chmod(path, mode); }
async function pgCommand(command, args, timeout = 15_000) {
  return execute(`/usr/local/bin/${command}`, args, { env, uid: PG_USER.uid, gid: PG_USER.gid, timeout, maxBuffer: 65_536 });
}
function client(database, user = 'synthetic_admin', password, port = PORT) {
  const { Client } = createRequire(join(OPT, 'package.json'))('pg');
  const c = new Client(user === 'synthetic_admin' ? { host: join(PGROOT, 'socket'), port: PORT, database, user } : {
    host: '127.0.0.1', port, database, user, password,
    ssl: { ca: tls.ca, rejectUnauthorized: true, servername: 'localhost', checkServerIdentity: (_host, cert) => checkServerIdentity('localhost', cert) },
  });
  c.on('error', () => {}); clients.add(c); return c;
}
async function profile(port = PORT) {
  for (const [file, database, user, password] of [
    ['registry-probe', 'cop_account_safety_guard', 'synthetic_registry_reader', passwords.registry],
    ['driver-control', 'sim_driver_measurements', 'sim_driver_guard_control', passwords.control],
  ]) await privateFile(join(ETC, 'root', file + '.json'), canonical({ contractVersion: 'cop-root-postgres-profile-v1',
    host: '127.0.0.1', port: file === 'driver-control' ? port : PORT, database, user, password, serverName: 'localhost',
    caFile: join(ETC, 'public', 'postgres-ca.crt') }) + '\n');
}
async function bootstrap() {
  assert.deepEqual(process.argv.slice(2), ['--run']); assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'arm64');
  assert.equal(process.getuid(), 0); assert.equal(process.geteuid(), 0); assert.equal(process.version, 'v24.20.0');
  assert.equal(existsSync('/.dockerenv'), true, 'This fixture requires a new Docker container, never a host Root shell.');
  for (const [iface, addresses] of Object.entries(networkInterfaces())) {
    assert.equal(iface, 'lo', 'Run with --network none.'); assert.ok(addresses.every(a => a.internal));
  }
  for (const [path, pin] of Object.entries(pins)) {
    const s = await lstat(path); assert.ok(s.isFile() && s.uid === 0 && s.nlink === 1 && !(s.mode & 0o022));
    assert.equal(hash(await readFile(path)), pin, `Unreviewed source: ${path}`);
  }
  ({ canonical, verifyRootRecord } = await import(pathToFileURL(join(OPT, 'root-records.mjs')).href));
  ({ inspectRootDriver } = await import(pathToFileURL(join(OPT, 'root-read-admission.mjs')).href));
  ({ driverReadRequestDigest } = await import(pathToFileURL(join(OPT, 'read-admission-facts.mjs')).href));
  const p = readFileSync('/etc/passwd', 'utf8').split('\n').find(row => row.startsWith('postgres:'))?.split(':');
  assert.ok(p); PG_USER = { uid: Number(p[2]), gid: Number(p[3]) }; assert.ok(PG_USER.uid > 0 && PG_USER.gid > 0);
  for (const path of [ETC, STATE, PGROOT]) { assert.equal(existsSync(path), false, 'Never adopt an existing installation or cluster.'); await mkdir(path, { mode: 0o700 }); }
  for (const path of ['root', 'public']) await mkdir(join(ETC, path), { mode: 0o700 });
  for (const path of ['authority', 'clients', 'read-permits', 'evidence']) await mkdir(join(STATE, path), { mode: 0o700 });
  await chown(PGROOT, PG_USER.uid, PG_USER.gid); await mkdir(join(PGROOT, 'socket'), { mode: 0o700 });
  await chown(join(PGROOT, 'socket'), PG_USER.uid, PG_USER.gid);
  tls = certificates();
  await privateFile(join(ETC, 'public', 'postgres-ca.crt'), tls.ca, 0o644);
  await privateFile(join(PGROOT, 'server.crt'), tls.cert); await privateFile(join(PGROOT, 'server.key'), tls.key);
  await chown(join(PGROOT, 'server.crt'), PG_USER.uid, PG_USER.gid); await chown(join(PGROOT, 'server.key'), PG_USER.uid, PG_USER.gid);
  const pw = join(PGROOT, 'bootstrap-password'); await privateFile(pw, passwords.admin); await chown(pw, PG_USER.uid, PG_USER.gid);
  assert.match((await pgCommand('postgres', ['--version'])).stdout, /^postgres \(PostgreSQL\) 18\.6(?:\s|$)/);
  await pgCommand('initdb', ['-D', join(PGROOT, 'data'), '--username=synthetic_admin', '--pwfile=' + pw,
    '--auth-local=trust', '--auth-host=scram-sha-256', '--encoding=UTF8', '--locale=C'], 30_000); await unlink(pw);
  await privateFile(join(PGROOT, 'data', 'pg_hba.conf'), 'local all all trust\nhostssl all all 127.0.0.1/32 scram-sha-256\nhostnossl all all 127.0.0.1/32 reject\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n');
  await chown(join(PGROOT, 'data', 'pg_hba.conf'), PG_USER.uid, PG_USER.gid);
  await pgCommand('pg_ctl', ['-D', join(PGROOT, 'data'), '-l', join(PGROOT, 'server.log'), '-o',
    `-k ${join(PGROOT, 'socket')} -p ${PORT} -c listen_addresses=127.0.0.1 -c unix_socket_permissions=0700 -c ssl=on -c ssl_cert_file=${join(PGROOT, 'server.crt')} -c ssl_key_file=${join(PGROOT, 'server.key')} -c timezone=UTC -c log_statement=none -c log_min_error_statement=panic -c max_prepared_transactions=0`, '-w', 'start']); started = true;
  const bootstrap = client('postgres'); await bootstrap.connect();
  await bootstrap.query(`CREATE ROLE driver_measurements_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE driver_measurements_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_driver_guard_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_driver_guard_control LOGIN PASSWORD '${passwords.control}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_driver_guard_exec LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE synthetic_registry_reader LOGIN PASSWORD '${passwords.registry}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    ALTER ROLE synthetic_registry_reader SET default_transaction_read_only=on`);
  await bootstrap.query('CREATE DATABASE sim_driver_measurements OWNER driver_measurements_migrator');
  await bootstrap.query('CREATE DATABASE cop_account_safety_guard');
  admin = client('sim_driver_measurements'); registry = client('cop_account_safety_guard');
  await admin.connect(); await registry.connect();
  const identity = (await admin.query("SELECT current_setting('data_directory') AS directory,current_setting('listen_addresses') AS listen,version() AS version")).rows[0];
  assert.equal(identity.directory, join(PGROOT, 'data')); assert.equal(identity.listen, '127.0.0.1'); assert.match(identity.version, /PostgreSQL 18\.6/);
  await admin.query('SET ROLE driver_measurements_migrator');
  for (const file of ['schema.sql', '002_account_erasure.sql']) await admin.query(await readFile(join('/fixture/sql', file), 'utf8'));
  await admin.query('RESET ROLE; CREATE SCHEMA sim_driver_guard_source AUTHORIZATION sim_driver_guard_owner; GRANT sim_driver_guard_exec TO sim_driver_guard_owner');
  for (const file of ['003_guarded_operations.sql', '004_read_admission_facts.sql']) await admin.query(await readFile(join('/fixture/sql', file), 'utf8'));
  await admin.query("INSERT INTO sim_driver_guard_source.store_binding VALUES(true,$1)", [IDS.store]);
  await admin.query("UPDATE driver_account_erasure_state SET replay_ready=true,replay_checkpoint_hash=$1,proof_valid_until=clock_timestamp()+interval '10 minutes',retention_reviewed=true,report_protection='no_report',publication_fence_verified=true WHERE singleton", [IDS.checkpoint]);
  await admin.query("INSERT INTO driver_measurement_receipts VALUES('cop',$1,$2,$3,now(),now()+interval '1 day',$4)",
    [randomUUID(), hash('unrelated synthetic daily contributor'), IDS.request, JSON.stringify({ privateCanary: 'never-return-this-synthetic-receipt' })]);
  await admin.query("INSERT INTO driver_measurement_revocations VALUES('cop',$1,now()+interval '1 day')", [hash('synthetic temporary fence')]);
  await admin.query("INSERT INTO driver_account_erasure_operations(operation_hash,actor_hash,request_hash,contributor_count,deleted_batch_count,remaining_batch_count,replay_checkpoint_hash) VALUES($1,$2,$3,9,3,1,$4)", [IDS.operation, IDS.actor, IDS.request, IDS.checkpoint]);
  await admin.query("INSERT INTO driver_account_erasure_revocations(owner,contributor_hash) VALUES('cop',$1)", [hash('synthetic permanent fence')]);
  // Only the columns read by COP's existing live SELECT are modeled. This is a
  // fresh synthetic metadata fixture, NOT a claim of production enrollment DDL.
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
  await registry.query("INSERT INTO cop_guard.guard_identity VALUES(true,$1,'cop','cop-account-safety-runtime-v1','cop-global-fences-v1',$2)", [IDS.guard, hash('synthetic empty prefix')]);
  await registry.query("INSERT INTO cop_guard.policies VALUES($1,1,'cop-jizda-only-sim-preserved-v1',$2)", [IDS.guard, IDS.epoch]);
  await registry.query("INSERT INTO cop_guard.dataset_bindings VALUES($1,$2,'sim_driver_measurements',$3,$4,'cop-sim-driver-projection-v1')", [IDS.dataset, IDS.guard, IDS.epoch, IDS.store]);
  await registry.query("INSERT INTO cop_guard.runtime_bindings VALUES($1,$2,'sim_driver_measurements',1,$3,$4)", [IDS.runtime, IDS.dataset, IMAGE_ID, SOURCE_REVISION]);
  await registry.query("INSERT INTO cop_guard.accepted_runtime_proofs VALUES($1,$2,clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '10 minutes',$3,$4)", [IDS.proof, IDS.runtime, FRONTIER, IDS.frontier]);
  await registry.query('INSERT INTO cop_guard.fence_journal VALUES($1,$2)', [FRONTIER, IDS.frontier]);
  control = client('sim_driver_measurements', 'sim_driver_guard_control', passwords.control); await control.connect();
  assert.equal((await control.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0].ssl, true);
  rootKey = generateKeyPairSync('ed25519'); const pub = rootKey.publicKey.export({ format: 'jwk' });
  publicKeys = { contractVersion: 'cop-root-verification-keys-v1', keys: [{ kid: 'synthetic-driver-read-root', kty: 'OKP', crv: 'Ed25519', x: pub.x }] };
  await privateFile(join(ETC, 'public', 'verification-keys.json'), canonical(publicKeys) + '\n', 0o644);
  await privateFile(join(STATE, 'authority', 'signing-key.pkcs8'), rootKey.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await profile(); baselineFacts = await facts(request('status'));
  assert.equal(baselineFacts.schema.ready, true); assert.equal(baselineFacts.privileges.runtimeProfileMatches, true);
}
async function facts(input) {
  await control.query('BEGIN READ ONLY');
  try { return (await control.query('SELECT sim_driver_guard_source.read_admission_facts($1::jsonb) AS value', [JSON.stringify(input)])).rows[0].value; }
  finally { await control.query('ROLLBACK'); }
}
const base = (kind, recordId = randomUUID(), ttl = 120_000) => ({ contractVersion: 'cop-root-record-v1', kind, recordId,
  issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + ttl).toISOString() });
async function signed(path, payload) {
  const bytes = Buffer.from(canonical({ keyId: publicKeys.keys[0].kid, payload,
    signature: sign(null, Buffer.from(canonical(payload)), rootKey.privateKey).toString('base64url') }) + '\n');
  await privateFile(path, bytes); return { recordId: payload.recordId, digest: hash(bytes) };
}
async function publish(input = request('status'), refreshProof = true) {
  await profile();
  if (refreshProof) await registry.query("UPDATE cop_guard.accepted_runtime_proofs SET observed_at=clock_timestamp(),issued_at=clock_timestamp(),valid_until=clock_timestamp()+interval '10 minutes'");
  const id = randomUUID(), reqDigest = driverReadRequestDigest(input), boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const binding = { readPermitId: id, requestDigest: reqDigest, owner: input.owner, scope: input.scope,
    guardStoreId: IDS.guard, continuityEpoch: IDS.epoch, datasetBindingId: IDS.dataset, runtimeBindingId: IDS.runtime,
    sourceProofId: IDS.proof, storeIncarnation: IDS.store, policyGeneration: 1, frontierSequence: FRONTIER, frontierDigest: IDS.frontier };
  const registration = { ...base('driver-client-registration'), peer: PEER, runtimeBindingId: IDS.runtime, datasetBindingId: IDS.dataset,
    guardStoreId: IDS.guard, continuityEpoch: IDS.epoch, imageId: IMAGE_ID, sourceRevision: SOURCE_REVISION, machineBootId: boot };
  await signed(join(STATE, 'clients', `${PEER.device}-${PEER.inode}.json`), registration);
  const evidence = {};
  for (const [kind, decision] of Object.entries({ 'driver-read-identity': 'cop-jizda-owned-sim-preserved',
    'driver-read-retention': 'bounded-read-permitted', 'driver-read-report': 'verified-report-inventory', 'driver-read-schema': 'exact-read-facts-policy-verified' })) {
    const payload = { ...base(kind), ...binding, decision }; evidence[kind] = await signed(join(STATE, 'evidence', payload.recordId + '.json'), payload);
  }
  const inventory = { ...base('driver-report-inventory'), ...binding, reportProtection: 'no_report', checkpointHash: IDS.checkpoint,
    schemaFingerprint: baselineFacts.schema.fingerprint, privilegeFingerprint: baselineFacts.privileges.fingerprint, decision: 'verified-no-derived-publication' };
  const inventoryPath = join(STATE, 'evidence', inventory.recordId + '.json'), inventoryRef = await signed(inventoryPath, inventory);
  const permit = { ...base('driver-read-permit', id), request: input, requestDigest: reqDigest, guardStoreId: IDS.guard,
    continuityEpoch: IDS.epoch, datasetBindingId: IDS.dataset, runtimeBindingId: IDS.runtime, sourceProofId: IDS.proof,
    policyGeneration: 1, frontierSequence: FRONTIER, frontierDigest: IDS.frontier, storeIncarnation: IDS.store,
    expectedCheckpointHash: IDS.checkpoint, expectedSchemaFingerprint: baselineFacts.schema.fingerprint,
    expectedPrivilegeFingerprint: baselineFacts.privileges.fingerprint, reportProtection: 'no_report', reportInventoryRef: inventoryRef, evidence };
  const path = join(STATE, 'read-permits', id + '.json'); await signed(path, permit);
  const identity = (await registry.query('SELECT system_identifier::text AS cluster,(SELECT timeline_id FROM pg_control_checkpoint()) AS timeline FROM pg_control_system()')).rows[0];
  const anchor = { ...base('current-frontier', randomUUID(), 20_000), guardStoreId: IDS.guard, continuityEpoch: IDS.epoch,
    sequence: FRONTIER, digest: IDS.frontier, machineBootId: boot, clusterId: identity.cluster, timelineId: identity.timeline };
  await signed(join(STATE, 'authority', 'current-frontier.json'), anchor);
  return { id, input, path, permit, inventory, inventoryPath, anchor };
}
async function contents() {
  const target = (await admin.query(`SELECT jsonb_build_object(
    'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,batch_id),'[]') FROM driver_measurement_receipts t),
    'intervals',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,measurement_key),'[]') FROM driver_measurement_intervals t),
    'eta',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,batch_id),'[]') FROM driver_measurement_eta t),
    'temporaryFences',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,contributor_hash),'[]') FROM driver_measurement_revocations t),
    'state',(SELECT to_jsonb(t) FROM driver_account_erasure_state t WHERE singleton),
    'ledger',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY operation_hash),'[]') FROM driver_account_erasure_operations t),
    'fences',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,contributor_hash),'[]') FROM driver_account_erasure_revocations t),
    'origins',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY operation_id),'[]') FROM sim_driver_guard_source.origins t),
    'store',(SELECT to_jsonb(t) FROM sim_driver_guard_source.store_binding t WHERE singleton)) AS value`)).rows[0].value;
  const metadata = (await registry.query(`SELECT jsonb_build_object(
    'identity',(SELECT jsonb_agg(to_jsonb(t)) FROM cop_guard.guard_identity t),
    'policies',(SELECT jsonb_agg(to_jsonb(t)) FROM cop_guard.policies t),
    'datasets',(SELECT jsonb_agg(to_jsonb(t)) FROM cop_guard.dataset_bindings t),
    'runtime',(SELECT jsonb_agg(to_jsonb(t)) FROM cop_guard.runtime_bindings t),
    'proof',(SELECT jsonb_agg(to_jsonb(t)) FROM cop_guard.accepted_runtime_proofs t),
    'journal',(SELECT jsonb_agg(to_jsonb(t) ORDER BY sequence) FROM cop_guard.fence_journal t)) AS value`)).rows[0].value;
  return { target: hash(canonical(target)), metadata: hash(canonical(metadata)) };
}
async function denied(fixture, input = fixture.input, peer = PEER) {
  await assert.rejects(inspectRootDriver(fixture.id, input, peer));
}
async function check(name, test, arrange = async () => {}, restore = async () => {}) {
  stage = name; const fixture = await publish();
  try {
    await arrange(fixture); const before = await contents();
    await test(fixture); assert.deepEqual(await contents(), before, 'Root read must not change target or registry rows.');
    events.push({ name, passed: true, targetAndRegistryRowsUnchanged: true });
  } finally { await restore(fixture); }
}
async function silentProxyCase(fixture) {
  const sockets = new Set(); let drop = false, blocker;
  const server = net.createServer(down => {
    const up = net.connect({ host: '127.0.0.1', port: PORT }); sockets.add(down); sockets.add(up);
    down.on('data', bytes => { if (!drop) up.write(bytes); }); up.on('data', bytes => { if (!drop) down.write(bytes); });
    for (const [a, b] of [[down, up], [up, down]]) { a.on('error', () => b.destroy()); a.on('close', () => { sockets.delete(a); b.destroy(); }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PROXY_PORT, '127.0.0.1', resolve); });
  let reading;
  try {
    await profile(PROXY_PORT); blocker = client('cop_account_safety_guard'); await blocker.connect();
    await blocker.query('BEGIN; LOCK TABLE cop_guard.guard_identity IN ACCESS EXCLUSIVE MODE');
    // Both real TLS/SCRAM connections finish startup, but metadata.current waits
    // on an actual table lock. Then blackhole target TCP before BEGIN is sent.
    const began = performance.now(); reading = inspectRootDriver(fixture.id, fixture.input, PEER);
    const observed = reading.then(value => ({ accepted: true, value }), () => ({ accepted: false }));
    let ready = false;
    for (let n = 0; n < 400; n++) {
      const r = (await registry.query(`SELECT
        EXISTS(SELECT 1 FROM pg_stat_activity a JOIN pg_stat_ssl s USING(pid) WHERE a.application_name='cop-root-driver-read-v1'
          AND a.usename='sim_driver_guard_control' AND a.state='idle' AND s.ssl) AS target_started,
        EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='cop-root-driver-read-v1'
          AND datname='cop_account_safety_guard' AND wait_event_type='Lock') AS metadata_waiting`)).rows[0];
      if (r.target_started && r.metadata_waiting) { ready = true; break; } await delay(5);
    }
    assert.equal(ready, true, 'Actual TLS startup must be observed before the blackhole.');
    drop = true; await blocker.query('ROLLBACK');
    let timeout; const outcome = await Promise.race([observed, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Reader exceeded its bounded cleanup ceiling')), 18_000); })]).finally(() => clearTimeout(timeout));
    assert.equal(outcome.accepted, false); const elapsedMs = performance.now() - began;
    assert.ok(elapsedMs < 18_000); assert.ok(elapsedMs >= 1000, 'This must exercise an actual stalled connection, not an early validation rejection.');
  } finally {
    drop = false; for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    if (blocker) await blocker.query('ROLLBACK').catch(() => {});
    if (reading) await reading.catch(() => {}); await profile();
  }
}
async function run() {
  await bootstrap();
  await check('valid signed Root chain and actual TLS/SQL facts for all five purposes', async () => {
    for (const purpose of ['capability', 'intake', 'preflight', 'status', 'receipt']) {
      const f = await publish(request(purpose), false), out = await inspectRootDriver(f.id, f.input, PEER);
      const record = verifyRootRecord(Buffer.from(out.record), publicKeys, 'driver-read-admission');
      assert.equal(hash(Buffer.from(out.record)), out.admission.reference.digest); assert.equal(record.payload.recordId, out.admission.reference.recordId);
      assert.equal(record.payload.readPermitId, f.id); assert.equal(record.payload.requestDigest, driverReadRequestDigest(f.input));
      assert.deepEqual(record.payload.request, f.input); assert.deepEqual(record.payload.peer, PEER);
      assert.equal(record.payload.checkpointHash, IDS.checkpoint); assert.equal(record.payload.schemaFingerprint, baselineFacts.schema.fingerprint);
      assert.equal(record.payload.privilegeFingerprint, baselineFacts.privileges.fingerprint);
      assert.ok(Date.parse(record.payload.expiresAt) - Date.parse(record.payload.issuedAt) <= 5000);
      assert.equal(out.record.includes('never-return-this-synthetic-receipt'), false);
    }
  });
  await check('validly signed permit cannot authorize a different request', f => denied(f, request('preflight')));
  await check('forged Ed25519 permit is rejected', f => denied(f), async f => {
    const p = JSON.parse(await readFile(f.path, 'utf8')); p.signature = (p.signature[0] === 'A' ? 'B' : 'A') + p.signature.slice(1);
    await privateFile(f.path, canonical(p) + '\n');
  });
  await check('expired but correctly signed permit is rejected', f => denied(f), f => signed(f.path, { ...f.permit,
    issuedAt: new Date(Date.now() - 10_000).toISOString(), expiresAt: new Date(Date.now() - 5000).toISOString() }));
  await check('Root record symlink is rejected by actual file custody', f => denied(f), async f => {
    const other = join(STATE, 'read-permits', randomUUID() + '.json'); await privateFile(other, await readFile(f.path)); await unlink(f.path); await symlink(other, f.path);
  });
  await check('group-readable private Root record is rejected', f => denied(f), f => chmod(f.path, 0o640));
  await check('actual target schema drift cannot reuse accepted fingerprints', f => denied(f),
    () => admin.query('ALTER TABLE driver_measurement_receipts ADD COLUMN synthetic_read_drift integer'),
    () => admin.query('ALTER TABLE driver_measurement_receipts DROP COLUMN synthetic_read_drift'));
  await check('actual effective column privilege drift is rejected', f => denied(f),
    () => admin.query('GRANT UPDATE(request_hash) ON driver_measurement_receipts TO driver_measurements_runtime'),
    async () => {
      await admin.query('REVOKE UPDATE(request_hash) ON driver_measurement_receipts FROM driver_measurements_runtime');
      // GRANT/REVOKE may preserve an empty ACL instead of the original NULL.
      // Explicit test-only reenrollment after restoration prevents a later
      // negative from passing because of this earlier fingerprint drift.
      const restored = await facts(request('status'));
      assert.equal(restored.schema.ready, true); assert.equal(restored.privileges.runtimeProfileMatches, true);
      baselineFacts = restored;
    });
  await check('actual target checkpoint drift is rejected', f => denied(f),
    () => admin.query('UPDATE driver_account_erasure_state SET replay_checkpoint_hash=$1', [hash('synthetic changed checkpoint')]),
    () => admin.query('UPDATE driver_account_erasure_state SET replay_checkpoint_hash=$1', [IDS.checkpoint]));
  await check('synthetic peer mismatch cannot borrow a signed client registration', f => denied(f, f.input, Object.freeze({ ...PEER, uid: PEER.uid + 1 })));
  await check('independent signed frontier mismatch is rejected', f => denied(f),
    f => signed(join(STATE, 'authority', 'current-frontier.json'), { ...f.anchor, sequence: FRONTIER + 1 }));
  await check('actual live registry frontier drift is rejected', f => denied(f),
    () => registry.query('INSERT INTO cop_guard.fence_journal VALUES($1,$2)', [FRONTIER + 1, hash('synthetic live frontier drift')]),
    () => registry.query('DELETE FROM cop_guard.fence_journal WHERE sequence=$1', [FRONTIER + 1]));
  await check('actual live accepted proof expiration is rejected', f => denied(f),
    () => registry.query("UPDATE cop_guard.accepted_runtime_proofs SET valid_until=clock_timestamp()-interval '1 second'"));
  await check('valid signatures cannot hide report-inventory checkpoint mismatch', f => denied(f), async f => {
    const inventoryRef = await signed(f.inventoryPath, { ...f.inventory, checkpointHash: hash('synthetic wrong signed inventory checkpoint') });
    await signed(f.path, { ...f.permit, reportInventoryRef: inventoryRef });
  });
  await check('actual post-TLS-startup silent TCP is bounded through query and cleanup', silentProxyCase);
  assert.equal(events.length, 15);
  for (const [path, pin] of Object.entries(pins)) assert.equal(hash(await readFile(path)), pin);
  return { contractVersion: 'sim-driver-read-root-isolated-linux-evidence-v1', scope: 'synthetic_signed_root_reader_and_actual_sql004_only',
    passed: events.length, cases: events, startedAt, completedAt: new Date().toISOString(), node: process.version, postgres: '18.6', platform: process.platform,
    architecture: process.arch, nodeImageId: NODE_IMAGE, postgresImageId: PG_IMAGE, sourcePins: pins,
    peerSource: 'frozen_synthetic_fixture_not_kernel_observation', realEd25519: true, realRootFileCustody: true,
    realLoopbackStrictTls: true, realPostgres: true, positiveVerificationCallbacks: 0, pgStubs: 0,
    originRpcCalls: 0, externalNetworkInterfaces: 0, targetAndRegistryRowsUnchangedByReader: true,
    productionEnrollment: false, nativePeerAcceptance: false, deployment: false, activation: false, wholeAccountComplete: false };
}
let output, failure;
try { output = await run(); }
catch (error) { failure = { contractVersion: 'sim-driver-read-root-isolated-linux-evidence-v1', passed: events.length, cases: events,
  failedStage: stage, errorClass: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : null,
  assertionDetail: error?.code === 'ERR_ASSERTION' ? String(error.message).slice(0, 1200) : null,
  productionEnrollment: false, deployment: false, activation: false }; process.exitCode = 1; }
finally {
  for (const c of clients) await c.end().catch(() => {});
  if (started) try { await pgCommand('pg_ctl', ['-D', join(PGROOT, 'data'), '-m', 'immediate', '-w', 'stop']); }
  catch { failure ??= { failedStage: 'isolated cluster cleanup', productionEnrollment: false, activation: false }; process.exitCode = 1; }
  clearTimeout(deadline);
}
process.stdout.write(JSON.stringify(failure ?? output) + '\n');
