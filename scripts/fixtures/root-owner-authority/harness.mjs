/** NEW isolated actual Root common/crypto/TLS/PostgreSQL integration fixture.
 * Host observations/app peer tuples are explicitly SYNTHETIC Root-signed
 * inputs. The actual host watcher/native transport is NOT accepted here.
 * No positive verifier callback, pg stub, provider, production account or
 * external network access is supplied. All cases use ONE actual Root process; its own
 * pidfd/start/executable/boot broker facts are real, app peers remain synthetic.
 * Only the final forced metadata disconnect creates irreversible process HOLD.
 * Fixture teardown is NOT production quiescence or recovery acceptance.
 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash, generateKeyPairSync, randomBytes, randomUUID} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {chmod, chown, lstat, mkdir, readFile, readdir, unlink, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {networkInterfaces} from 'node:os';
import {join} from 'node:path';
import {checkServerIdentity} from 'node:tls';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {certificates} from './certificates.mjs';

const OPT = '/opt/cop-account-safety', ETC = '/etc/cop-account-safety', STATE = '/var/lib/cop-account-safety';
const PRIVATE = '/run/cop-account-safety/private', PGROOT = '/var/lib/postgresql/root-owner-fixture', PORT = 6543;
const COST = 'aggregate-costs-current-month-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const execute = promisify(execFile), delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const clients = new Set(), events = [], specs = {
  sim_driver_measurements: {scope: 'online_driver_scope', profile: 'driver-control', user: 'sim_driver_guard_control', directory: 'clients', registration: 'driver-client-registration',
    request: () => ({owner: 'sim_driver_measurements', scope: 'online_driver_scope', purpose: 'capability'})},
  sim_ai_router: {scope: 'cop_router_primary_database', profile: 'ai-router-control', user: 'sim_ai_guard_control', directory: 'ai-clients', registration: 'ai-router-client-registration'},
};
const startedAt = new Date().toISOString(), deadline = setTimeout(() => {process.stderr.write('ROOT_OWNER_FIXTURE_DEADLINE\n'); process.exit(2);}, 260000);
const env = {PATH: '/usr/local/bin:/usr/bin:/bin', HOME: PGROOT, LANG: 'C', LC_ALL: 'C', TZ: 'UTC'};
let canonical, canonicalJson, verifyRootRecord, issueRootRecord, issueRootJws, storeRootRecord;
let pgUser, tls, started = false, admin, registry, driver, ai, driverAdmin, aiAdmin, hostTimer, brokerSelf, stage = 'preconditions';
const pausedHost = new Set(), ids = {guard: randomUUID(), epoch: randomUUID(), config: randomUUID(), policy: hash('synthetic independent Root policy'),
  frontier: hash('synthetic independent initial prefix'), owners: Object.fromEntries(Object.keys(specs).map((owner, i) => [owner, {
    store: randomUUID(), dataset: randomUUID(), runtime: randomUUID(), target: randomUUID(), runtimeProfile: randomUUID(),
    peer: {device: String(101 + i), inode: String(201 + i), uid: 1000, gid: 1000}, container: hash('synthetic container ' + owner),
    checkpoint: hash('synthetic accepted checkpoint ' + owner), policy: undefined, policyRef: undefined, observation: undefined,
  }]))};
const pendingHostWrites = new Map(Object.keys(specs).map(owner => [owner, new Set()]));
const passwords = Object.fromEntries(['admin', 'registry', 'driver', 'ai', 'runtime'].map(k => [k, randomBytes(32).toString('hex')]));
const boot = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
async function privateFile(path, value, mode = 0o600) {await writeFile(path, value, {mode}); await chmod(path, mode);}
async function pgCommand(command, args, timeout = 15000) {
  return execute('/usr/local/bin/' + command, args, {env, uid: pgUser.uid, gid: pgUser.gid, timeout, maxBuffer: 65536});
}
function db(database, user = 'synthetic_admin', password) {
  const {Client} = createRequire(OPT + '/package.json')('pg');
  const value = new Client(user === 'synthetic_admin' ? {host: PGROOT + '/socket', port: PORT, database, user} : {
    host: '127.0.0.1', port: PORT, database, user, password,
    ssl: {ca: tls.ca, rejectUnauthorized: true, servername: 'localhost', checkServerIdentity: (_host, certificate) => checkServerIdentity('localhost', certificate)},
  });
  value.on('error', () => {}); clients.add(value); return value;
}
async function open(database, user, password) {const value = db(database, user, password); await value.connect(); return value;}
async function signFile(path, kind, facts, ttl = 300000, recordId = randomUUID()) {
  const record = issueRootRecord(kind, facts, {recordId, lifetimeMs: ttl, expectedKeyringDigest: hash(await readFile(ETC + '/public/verification-keys.json'))});
  await privateFile(path, record.bytes); return {recordId, digest: record.digest};
}
function binding(owner) {
  const o = ids.owners[owner]; return {guardStoreId: ids.guard, continuityEpoch: ids.epoch, protectedConfigId: ids.config,
    datasetBindingId: o.dataset, runtimeBindingId: o.runtime, policyGeneration: 1, policyDigest: ids.policy, storeIncarnation: o.store};
}
function syntheticObservation(owner) {
  const o = ids.owners[owner]; return {contractVersion: 'cop-root-host-observation-v1', owner, observedAtUTC: new Date().toISOString(),
    machineBootId: boot(), dockerContainerId: o.container, imageId: 'sha256:' + hash('synthetic reviewed image'),
    sourceRevision: 'f3c05e3ae1ca3081d2f5551bc03da233c0c3a473', configurationDigest: hash('synthetic immutable configuration ' + owner),
    readOnlyRootfs: true, peer: o.peer, startTicks: String(BigInt(brokerSelf.startTicks) + 1n), executableDigest: hash('synthetic declared app executable'),
    broker: {dockerContainerId: hash('synthetic broker'), imageId: 'sha256:' + hash('synthetic reviewed broker image'),
      configurationDigest: hash('synthetic immutable broker configuration'), peer: brokerSelf.peer,
      startTicks: brokerSelf.startTicks, executableDigest: brokerSelf.executableDigest}};
}
async function hostFact(owner) {
  const o = ids.owners[owner]; o.observation = syntheticObservation(owner);
  const record = issueRootRecord('host-runtime-observation', {observation: o.observation}, {lifetimeMs: 5000,
    expectedKeyringDigest: hash(await readFile(ETC + '/public/verification-keys.json'))});
  storeRootRecord(PRIVATE + '/runtime-observations/' + owner + '.json', record.bytes, {replace: true});
}
async function targetFacts(owner) {
  const o = ids.owners[owner], client = owner === 'sim_driver_measurements' ? driver : ai;
  let request = specs[owner].request?.();
  if (!request) {
    const cp = (await aiAdmin.query("SELECT checkpoint_id,checkpoint_generation::text AS generation FROM ai_router_erasure_checkpoint WHERE id=1")).rows[0];
    request = {owner, scope: specs[owner].scope, purpose: 'checkpoint', expectedSnapshot: {checkpointId: cp.checkpoint_id, generation: cp.generation, operationDigest: '0'.repeat(64), schemaDigest: '0'.repeat(64)}};
  }
  await client.query('BEGIN READ ONLY');
  try {
    const functionName = owner === 'sim_driver_measurements' ? 'sim_driver_guard_source.read_admission_facts' : 'sim_ai_guard_source.read_checkpoint_facts';
    const facts = (await client.query('SELECT ' + functionName + '($1::jsonb) AS value', [JSON.stringify(request)])).rows[0].value;
    if (owner === 'sim_ai_router') request.expectedSnapshot = {checkpointId: facts.checkpoint.checkpoint_id, generation: facts.checkpoint.checkpoint_generation,
      operationDigest: facts.checkpoint.operation_digest, schemaDigest: facts.checkpoint.schema_digest};
    return {facts, request};
  } finally {await client.query('ROLLBACK');}
}
async function seedPolicy(owner, transition) {
  const o = ids.owners[owner], b = binding(owner), scope = specs[owner].scope, {facts, request} = await targetFacts(owner);
  const evidence = {};
  for (const [field, kind, decision, fingerprint] of [
    ['identityEvidenceRef', 'owner-identity', 'cop-jizda-owned-sim-preserved'], ['retentionEvidenceRef', 'owner-retention', 'bounded-owner-retention'],
    ['schemaEvidenceRef', 'owner-schema', 'exact-schema-reviewed', facts.schema.fingerprint],
    ['privilegeEvidenceRef', 'owner-privileges', 'least-privilege-reviewed', (facts.privileges ?? facts.permissions).fingerprint],
    owner === 'sim_driver_measurements' ? ['reportPolicyRef', 'driver-report-policy', 'verified-report-inventory'] : ['costEvidenceRef', 'ai-cost-policy', 'financial-caps-preserved'],
  ]) {
    const id = randomUUID(); evidence[field] = await signFile(STATE + '/evidence/' + id + '.json', kind,
      {...b, owner, scope, decision, ...(fingerprint ? {fingerprint} : {})}, 300000, id);
  }
  const policy = {contractVersion: 'cop-root-owner-policy-v1', owner, scope,
    identityEvidenceRef: evidence.identityEvidenceRef, retentionEvidenceRef: evidence.retentionEvidenceRef,
    schemaEvidenceRef: evidence.schemaEvidenceRef, privilegeEvidenceRef: evidence.privilegeEvidenceRef,
    schemaFingerprint: facts.schema.fingerprint, privilegeFingerprint: (facts.privileges ?? facts.permissions).fingerprint,
    ...(owner === 'sim_driver_measurements' ? {expectedCheckpointHash: facts.state.checkpointHash, reportProtection: 'no_report', reportPolicyRef: evidence.reportPolicyRef} :
      {costPolicy: COST, costEvidenceRef: evidence.costEvidenceRef, expectedSnapshot: request.expectedSnapshot})};
  if (transition) {
    const id = transition.operationId;
    const intentRef = await signFile(STATE + '/owner-transitions/' + id + '.json', 'owner-checkpoint-transition', {...b, owner, scope, transition}, 300000, id);
    policy.transition = {...transition, intentRef};
  }
  o.policy = policy; o.policyRef = await signFile(STATE + '/owner-policies/' + owner + '.json', 'owner-policy', {binding: b, policy});
}
async function frontier() {
  const value = (await registry.query('SELECT system_identifier::text AS cluster,(SELECT timeline_id FROM pg_control_checkpoint()) AS timeline FROM pg_control_system()')).rows[0];
  await signFile(STATE + '/authority/current-frontier.json', 'current-frontier', {guardStoreId: ids.guard, continuityEpoch: ids.epoch,
    sequence: 0, digest: ids.frontier, machineBootId: boot(), clusterId: value.cluster, timelineId: value.timeline}, 25000);
  return value;
}
async function refresh(owner, {kind = 'refresh', acceptanceRef = ids.owners[owner].acceptanceRef ?? null, ttl = 20000} = {}) {
  const o = ids.owners[owner]; await hostFact(owner); const identity = await frontier();
  const observation = o.observation, proofId = randomUUID(), operationId = randomUUID();
  const record = issueRootJws('runtime-proof', {owner, binding: binding(owner), operationId, operationKind: kind, trustProfileId: 'synthetic-fixture-v1',
    ownerPolicyRef: o.policyRef, checkpointAcceptanceRef: acceptanceRef, frontierSequence: 0, frontierDigest: ids.frontier,
    clusterId: identity.cluster, timelineId: identity.timeline, observation},
  {recordId: proofId, lifetimeMs: ttl, expectedKeyringDigest: hash(await readFile(ETC + '/public/verification-keys.json'))});
  await privateFile(STATE + '/runtime-proofs/' + proofId + '.jws', record.bytes);
  await registry.query(`INSERT INTO cop_guard.accepted_runtime_proofs(proof_id,operation_id,operation_kind,binding_id,proof_jws_digest,accepted_jws_ref,
    trust_profile_id,frontier_sequence,frontier_digest,observed_at,issued_at,valid_until,root_evidence_ref)
    VALUES($1,$2,$3,$4,$5,$6,'synthetic-fixture-v1',0,$7,$8,$9,$10,'synthetic-source-proof')`,
  [proofId, operationId, kind, o.runtime, record.digest, proofId + ':' + record.digest, ids.frontier, observation.observedAtUTC, record.payload.issuedAt, record.payload.expiresAt]);
  return {proofId, operationId, record};
}
async function seedAcceptance(owner) {
  // Non-circular protocol: historical enrollment P0 -> immutable receipt /
  // replay / acceptance -> signed acceptance artifact -> fresh current P1.
  // P1 intentionally does NOT have to be P0. All seeds are synthetic and are
  // administered here, never auto-adopted by the actual common under test.
  const o = ids.owners[owner], original = await refresh(owner, {kind: 'enrollment', acceptanceRef: null});
  const receiptId = randomUUID(), acceptanceId = randomUUID();
  await registry.query("INSERT INTO cop_guard.replay_operations(operation_id,operation_kind,source_proof_id,binding_id,root_evidence_ref) VALUES($1,'enrollment',$2,$3,'synthetic-fixture-replay')",
    [original.operationId, original.proofId, o.runtime]);
  await registry.query(`INSERT INTO cop_guard.owner_receipts(receipt_id,replay_operation_id,source_proof_id,source_proof_jws_digest,binding_id,owner_id,
    expected_checkpoint_generation,expected_fence_sequence,expected_fence_digest,expected_cleanup_sequence,expected_cleanup_digest,expected_cleanup_status,
    fence_sequence,fence_digest,cleanup_sequence,cleanup_digest,cleanup_status,coverage_evidence_ref,readback_evidence_ref,attempt,observed_at)
    VALUES($1,$2,$3,$4,$5,$6,0,0,$7,0,$7,'unknown',0,$7,0,$7,'complete','synthetic-covered','synthetic-readback',1,clock_timestamp())`,
  [receiptId, original.operationId, original.proofId, original.record.digest, o.runtime, owner, ids.frontier]);
  await registry.query(`INSERT INTO cop_guard.checkpoint_acceptances(acceptance_id,dataset_binding_id,generation,receipt_id,policy_generation,policy_digest,
    protected_config_id,admission_policy_id,continuity_epoch,accepted_frontier_sequence,accepted_frontier_digest,fence_sequence,fence_digest,
    cleanup_sequence,cleanup_digest,cleanup_status,root_evidence_ref)
    VALUES($1::uuid,$2,1,$3,1,$4,$5,'synthetic-fixture-v1',$6,0,$7,0,$7,0,$7,'complete',($1::uuid)::text)`,
  [acceptanceId, o.dataset, receiptId, ids.policy, ids.config, ids.epoch, ids.frontier]);
  await registry.query("SET TimeZone='UTC'");
  const digest = async (table, key, value) => (await registry.query('SELECT encode(sha256(convert_to(to_jsonb(t)::text,\'UTF8\')),\'hex\') AS digest FROM cop_guard.' + table + ' t WHERE ' + key + '=$1', [value])).rows[0].digest;
  o.acceptanceRef = await signFile(STATE + '/checkpoint-acceptances/' + acceptanceId + '.json', 'checkpoint-acceptance', {
    acceptanceId, datasetBindingId: o.dataset, receiptId, replayOperationId: original.operationId, sourceProofId: original.proofId,
    acceptanceDigest: await digest('checkpoint_acceptances', 'acceptance_id', acceptanceId),
    receiptDigest: await digest('owner_receipts', 'receipt_id', receiptId), replayDigest: await digest('replay_operations', 'operation_id', original.operationId),
  }, 300000, acceptanceId);
  o.receiptId = receiptId; o.acceptanceId = acceptanceId;
  o.original = original; await refresh(owner);
}
async function nextAcceptance(owner) {
  const o = ids.owners[owner], previous = (await registry.query('SELECT * FROM cop_guard.checkpoint_acceptances WHERE dataset_binding_id=$1 ORDER BY generation DESC LIMIT 1', [o.dataset])).rows[0];
  const original = o.original, receiptId = randomUUID(), acceptanceId = randomUUID();
  await registry.query(`INSERT INTO cop_guard.owner_receipts(receipt_id,replay_operation_id,source_proof_id,source_proof_jws_digest,binding_id,owner_id,
    expected_checkpoint_id,expected_checkpoint_generation,expected_fence_sequence,expected_fence_digest,expected_cleanup_sequence,expected_cleanup_digest,expected_cleanup_status,
    fence_sequence,fence_digest,cleanup_sequence,cleanup_digest,cleanup_status,coverage_evidence_ref,readback_evidence_ref,attempt,observed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,0,$9,'complete',0,$9,0,$9,'complete','synthetic-covered','synthetic-readback',2,clock_timestamp())`,
  [receiptId, original.operationId, original.proofId, original.record.digest, o.runtime, owner, previous.acceptance_id, previous.generation, ids.frontier]);
  await registry.query(`INSERT INTO cop_guard.checkpoint_acceptances(acceptance_id,dataset_binding_id,generation,previous_acceptance_id,receipt_id,policy_generation,policy_digest,
    protected_config_id,admission_policy_id,continuity_epoch,accepted_frontier_sequence,accepted_frontier_digest,fence_sequence,fence_digest,cleanup_sequence,cleanup_digest,cleanup_status,root_evidence_ref)
    VALUES($1::uuid,$2,$3,$4,$5,1,$6,$7,'synthetic-fixture-v1',$8,0,$9,0,$9,0,$9,'complete',($1::uuid)::text)`,
  [acceptanceId, o.dataset, String(BigInt(previous.generation) + 1n), previous.acceptance_id, receiptId, ids.policy, ids.config, ids.epoch, ids.frontier]);
  const digest = async (table, key, value) => (await registry.query('SELECT encode(sha256(convert_to(to_jsonb(t)::text,\'UTF8\')),\'hex\') AS digest FROM cop_guard.' + table + ' t WHERE ' + key + '=$1', [value])).rows[0].digest;
  const next = await signFile(STATE + '/checkpoint-acceptances/' + acceptanceId + '.json', 'checkpoint-acceptance', {
    acceptanceId, datasetBindingId: o.dataset, receiptId, replayOperationId: original.operationId, sourceProofId: original.proofId,
    acceptanceDigest: await digest('checkpoint_acceptances', 'acceptance_id', acceptanceId), receiptDigest: await digest('owner_receipts', 'receipt_id', receiptId),
    replayDigest: await digest('replay_operations', 'operation_id', original.operationId),
  }, 300000, acceptanceId);
  return {next, receiptId, acceptanceId};
}
async function bootstrap() {
  stage = 'bootstrap.platform-node';
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'arm64'); assert.equal(process.version, 'v24.20.0');
  stage = 'bootstrap.root-container';
  assert.equal(process.getuid(), 0); assert.equal(process.geteuid(), 0); assert.ok(existsSync('/.dockerenv'));
  stage = 'bootstrap.network-isolation';
  for (const [name, addresses] of Object.entries(networkInterfaces())) {assert.equal(name, 'lo'); assert.ok(addresses.every(a => a.internal));}
  stage = 'bootstrap.staged-source-pins';
  const pins = JSON.parse(await readFile('/fixture/source-pins.json', 'utf8'));
  for (const [path, pin] of Object.entries(pins)) {const s = await lstat(path); assert.ok(s.isFile() && s.uid === 0 && s.nlink === 1 && !(s.mode & 0o022)); assert.equal(hash(await readFile(path)), pin);}
  stage = 'bootstrap.root-records-import';
  ({canonical, canonicalJson, verifyRootRecord} = await import(OPT + '/root-records.mjs'));
  stage = 'bootstrap.root-issuer-import';
  ({issueRootRecord, issueRootJws, storeRootRecord} = await import(OPT + '/root-record-issuer.mjs'));
  stage = 'bootstrap.native-module-import';
  const {nativeModule} = await import(OPT + '/root-native.mjs');
  stage = 'bootstrap.native-self-identity';
  const peer = nativeModule().selfIdentity();
  assert.deepEqual(Object.keys(peer).sort(), ['device', 'inode']);
  stage = 'bootstrap.actual-proc-self';
  const stat = readFileSync('/proc/self/stat', 'utf8');
  brokerSelf = {peer: {...peer, uid: process.getuid(), gid: process.getgid()},
    startTicks: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], executableDigest: hash(await readFile('/proc/self/exe'))};
  assert.match(brokerSelf.startTicks, /^[0-9]+$/); assert.match(peer.device, /^[0-9]+$/); assert.match(peer.inode, /^[1-9][0-9]*$/);
  stage = 'bootstrap.postgres-unix-identity';
  const pg = readFileSync('/etc/passwd', 'utf8').split('\n').find(row => row.startsWith('postgres:')).split(':'); pgUser = {uid: Number(pg[2]), gid: Number(pg[3])};
  stage = 'bootstrap.fresh-private-directories';
  for (const path of [ETC, STATE, PGROOT]) {assert.equal(existsSync(path), false); await mkdir(path, {mode: 0o700});}
  for (const name of ['root', 'public']) await mkdir(ETC + '/' + name, {mode: 0o700});
  for (const name of ['authority', 'clients', 'ai-clients', 'evidence', 'owner-policies', 'owner-transitions', 'runtime-proofs', 'checkpoint-acceptances', 'checkpoint-intents', 'checkpoint-dispatches'])
    await mkdir(STATE + '/' + name, {mode: 0o700});
  stage = 'bootstrap.private-tmpfs';
  const mounts = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map(row => row.split(' - '));
  assert.ok(mounts.some(row => row[0].split(' ')[4] === PRIVATE && row[1]?.split(' ')[0] === 'tmpfs'));
  for (const name of ['owner-authority', 'runtime-observations', 'read-evidence', 'read-permits', 'ai-read-permits']) await mkdir(PRIVATE + '/' + name, {mode: 0o700});
  stage = 'bootstrap.postgres-directory-custody';
  await chown(PGROOT, pgUser.uid, pgUser.gid); await mkdir(PGROOT + '/socket', {mode: 0o700}); await chown(PGROOT + '/socket', pgUser.uid, pgUser.gid);
  stage = 'bootstrap.synthetic-tls-certificates';
  tls = certificates(); await privateFile(ETC + '/public/postgres-ca.crt', tls.ca, 0o644);
  for (const [name, data] of [['server.crt', tls.cert], ['server.key', tls.key], ['bootstrap-password', passwords.admin]]) {
    await privateFile(PGROOT + '/' + name, data); await chown(PGROOT + '/' + name, pgUser.uid, pgUser.gid);
  }
  stage = 'bootstrap.postgres-initdb';
  await pgCommand('initdb', ['-D', PGROOT + '/data', '--username=synthetic_admin', '--pwfile=' + PGROOT + '/bootstrap-password', '--auth-local=trust', '--auth-host=scram-sha-256', '--encoding=UTF8', '--locale=C'], 30000);
  await unlink(PGROOT + '/bootstrap-password');
  await privateFile(PGROOT + '/data/pg_hba.conf', 'local all all trust\nhostssl all all 127.0.0.1/32 scram-sha-256\nhostnossl all all 127.0.0.1/32 reject\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n');
  await chown(PGROOT + '/data/pg_hba.conf', pgUser.uid, pgUser.gid);
  stage = 'bootstrap.postgres-start';
  await pgCommand('pg_ctl', ['-D', PGROOT + '/data', '-l', PGROOT + '/server.log', '-o', `-k ${PGROOT}/socket -p ${PORT} -c listen_addresses=127.0.0.1 -c unix_socket_permissions=0700 -c ssl=on -c ssl_cert_file=${PGROOT}/server.crt -c ssl_key_file=${PGROOT}/server.key -c timezone=UTC -c log_statement=none -c log_min_error_statement=panic`, '-w', 'start']); started = true;
  stage = 'bootstrap.postgres-admin-connect';
  admin = await open('postgres');
  stage = 'bootstrap.empty-target-databases';
  assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_database WHERE datname IN ('cop_account_safety_guard','sim_ai_router','sim_driver_measurements')")).rows[0].n, 0);
  stage = 'bootstrap.synthetic-target-roles';
  await admin.query(`CREATE ROLE driver_measurements_migrator NOLOGIN; CREATE ROLE driver_measurements_runtime LOGIN;
    CREATE ROLE sim_driver_guard_owner NOLOGIN; CREATE ROLE sim_driver_guard_control LOGIN PASSWORD '${passwords.driver}'; CREATE ROLE sim_driver_guard_exec LOGIN;
    CREATE ROLE ai_router_migrator NOLOGIN; CREATE ROLE ai_router_runtime LOGIN;
    CREATE ROLE sim_ai_guard_owner NOLOGIN; CREATE ROLE sim_ai_guard_control LOGIN PASSWORD '${passwords.ai}'`);
  stage = 'bootstrap.synthetic-target-databases';
  for (const [database, owner] of [['sim_driver_measurements', 'driver_measurements_migrator'], ['sim_ai_router', 'ai_router_migrator'], ['cop_account_safety_guard', 'synthetic_admin']])
    await admin.query('CREATE DATABASE ' + database + ' OWNER ' + owner);
  stage = 'bootstrap.target-admin-connections';
  registry = await open('cop_account_safety_guard'); driver = await open('sim_driver_measurements'); ai = await open('sim_ai_router');
  driverAdmin = driver; aiAdmin = ai;
  stage = 'bootstrap.metadata-001';
  await registry.query(await readFile('/fixture/sql/metadata/001-guard-metadata.sql', 'utf8'));
  stage = 'bootstrap.metadata-public-revoke';
  await registry.query('REVOKE ALL ON DATABASE cop_account_safety_guard FROM PUBLIC');
  // This MUST be the separately reviewed actual narrow metadata-reader source.
  // No fixture-only RLS bypass, allow-all policy or checkpoint-writer role
  // membership may substitute for that deployment prerequisite.
  stage = 'bootstrap.metadata-002-root-reader';
  await registry.query(await readFile('/fixture/sql/metadata/002-root-reader.sql', 'utf8'));
  // Separate fixture-only credential/LOGIN activation; 002 itself starts the
  // real narrow reader NOLOGIN/connection-limit zero, without any password.
  stage = 'bootstrap.metadata-synthetic-login';
  await registry.query("ALTER ROLE cop_guard_root_reader LOGIN CONNECTION LIMIT 8 PASSWORD '" + passwords.registry + "'");
  stage = 'bootstrap.driver-migrator-role';
  await driver.query('SET ROLE driver_measurements_migrator');
  for (const name of ['schema.sql', '002_account_erasure.sql']) {
    stage = 'bootstrap.driver.' + name; await driver.query(await readFile('/fixture/sql/driver/' + name, 'utf8'));
  }
  stage = 'bootstrap.driver-guard-namespace';
  await driver.query('RESET ROLE; CREATE SCHEMA sim_driver_guard_source AUTHORIZATION sim_driver_guard_owner; GRANT sim_driver_guard_exec TO sim_driver_guard_owner');
  for (const name of ['003_guarded_operations.sql', '004_read_admission_facts.sql']) {
    stage = 'bootstrap.driver.' + name; await driver.query(await readFile('/fixture/sql/driver/' + name, 'utf8'));
  }
  stage = 'bootstrap.driver-prebound-store';
  await driver.query('INSERT INTO sim_driver_guard_source.store_binding VALUES(true,$1)', [ids.owners.sim_driver_measurements.store]);
  stage = 'bootstrap.driver-synthetic-checkpoint';
  await driver.query("UPDATE driver_account_erasure_state SET replay_ready=true,replay_checkpoint_hash=$1,proof_valid_until=clock_timestamp()+interval '10 minutes',retention_reviewed=true,report_protection='no_report',publication_fence_verified=true WHERE singleton", [ids.owners.sim_driver_measurements.checkpoint]);
  for (const name of ['005_root_checkpoint.sql', '006_inventory_candidates.sql']) {
    stage = 'bootstrap.driver.' + name; await driver.query(await readFile('/fixture/sql/driver/' + name, 'utf8'));
  }
  stage = 'bootstrap.ai-migrator-role';
  await ai.query('SET ROLE ai_router_migrator');
  for (const name of ['001_schema.sql', '002_separate_billing.sql', '003_account_erasure.sql']) {
    stage = 'bootstrap.ai.' + name; await ai.query(await readFile('/fixture/sql/ai/' + name, 'utf8'));
  }
  stage = 'bootstrap.ai-runtime-profile-and-namespace';
  await ai.query(`RESET ROLE; REVOKE CREATE ON SCHEMA public FROM PUBLIC; REVOKE TEMP ON DATABASE sim_ai_router FROM PUBLIC;
    GRANT SELECT,INSERT,UPDATE ON ai_router_request,ai_router_policy,ai_router_policy_audit TO ai_router_runtime; GRANT USAGE,SELECT ON SEQUENCE ai_router_policy_audit_id_seq TO ai_router_runtime;
    CREATE SCHEMA sim_ai_guard_source AUTHORIZATION sim_ai_guard_owner`);
  stage = 'bootstrap.ai.004_root_checkpoint_facts.sql';
  await ai.query(await readFile('/fixture/sql/ai/004_root_checkpoint_facts.sql', 'utf8'));
  stage = 'bootstrap.ai-prebound-store';
  await ai.query('INSERT INTO sim_ai_guard_source.store_binding VALUES(true,$1)', [ids.owners.sim_ai_router.store]);
  stage = 'bootstrap.ai.005_root_checkpoint.sql';
  await ai.query(await readFile('/fixture/sql/ai/005_root_checkpoint.sql', 'utf8'));
  stage = 'bootstrap.ai-synthetic-checkpoint';
  await ai.query("UPDATE ai_router_erasure_checkpoint SET identity_reviewed=true,replay_ready=true,cost_policy=$1 WHERE id=1", [COST]);
  stage = 'bootstrap.target-tls-control-connect';
  driver = await open('sim_driver_measurements', 'sim_driver_guard_control', passwords.driver);
  ai = await open('sim_ai_router', 'sim_ai_guard_control', passwords.ai);
  stage = 'bootstrap.target-strict-tls-assert';
  for (const client of [driver, ai]) assert.equal((await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0].ssl, true);
  stage = 'bootstrap.synthetic-root-keyring';
  const rootKey = generateKeyPairSync('ed25519'), pub = rootKey.publicKey.export({format: 'jwk'});
  await privateFile(ETC + '/public/verification-keys.json', canonical({contractVersion: 'cop-root-verification-keys-v1', keys: [{kid: 'synthetic-common-root', kty: 'OKP', crv: 'Ed25519', x: pub.x}]}) + '\n', 0o644);
  await privateFile(STATE + '/authority/signing-key.pkcs8', rootKey.privateKey.export({type: 'pkcs8', format: 'pem'}));
  stage = 'bootstrap.fixed-tls-profiles';
  for (const [file, database, user, password] of [['registry-probe', 'cop_account_safety_guard', 'cop_guard_root_reader', passwords.registry],
    ['driver-control', 'sim_driver_measurements', 'sim_driver_guard_control', passwords.driver], ['ai-router-control', 'sim_ai_router', 'sim_ai_guard_control', passwords.ai]])
    await privateFile(ETC + '/root/' + file + '.json', canonical({contractVersion: 'cop-root-postgres-profile-v1', host: '127.0.0.1', port: PORT, database, user, password,
      serverName: 'localhost', caFile: ETC + '/public/postgres-ca.crt'}) + '\n');
  stage = 'bootstrap.metadata-identity-seed';
  await registry.query("INSERT INTO cop_guard.guard_identity(guard_store_id,application_id,guard_contract_version,stream_scope_id,initial_prefix_digest,enrollment_evidence_ref) VALUES($1,'cop','cop-account-safety-runtime-v1','cop-global-fences-v1',$2,'synthetic-fixture-only')", [ids.guard, ids.frontier]);
  stage = 'bootstrap.metadata-policy-seed';
  await registry.query("INSERT INTO cop_guard.policies(policy_generation,guard_store_id,policy_id,policy_digest,protected_config_id,admission_policy_id,continuity_epoch,root_evidence_ref) VALUES(1,$1,'cop-jizda-only-sim-preserved-v1',$2,$3,'synthetic-fixture-v1',$4,'synthetic-fixture-only')", [ids.guard, ids.policy, ids.config, ids.epoch]);
  for (const owner of Object.keys(specs)) {
    const o = ids.owners[owner];
    stage = 'bootstrap.' + owner + '.dataset-binding-seed';
    await registry.query(`INSERT INTO cop_guard.dataset_bindings(dataset_binding_id,guard_store_id,owner_id,projection_contract_id,continuity_epoch,target_store_id,target_dataset_id,target_incarnation_id,target_restore_generation,root_evidence_ref)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,'synthetic-fixture-only')`, [o.dataset, ids.guard, owner, owner === 'sim_ai_router' ? 'cop-sim-ai-projection-v1' : 'cop-sim-driver-projection-v1', ids.epoch, randomUUID(), o.target, o.store]);
    const observation = syntheticObservation(owner);
    stage = 'bootstrap.' + owner + '.runtime-binding-seed';
    await registry.query(`INSERT INTO cop_guard.runtime_bindings(binding_id,dataset_binding_id,owner_id,policy_generation,image_id,source_revision,runtime_instance_id,runtime_profile_id,root_evidence_ref)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,'synthetic-fixture-only')`, [o.runtime, o.dataset, owner, observation.imageId, observation.sourceRevision, o.container, o.runtimeProfile]);
    stage = 'bootstrap.' + owner + '.client-registration';
    await signFile(STATE + '/' + specs[owner].directory + '/' + o.peer.device + '-' + o.peer.inode + '.json', specs[owner].registration,
      {peer: o.peer, runtimeBindingId: o.runtime, datasetBindingId: o.dataset, guardStoreId: ids.guard, continuityEpoch: ids.epoch,
        imageId: observation.imageId, sourceRevision: observation.sourceRevision, machineBootId: boot()});
    let initialTransition;
    if (owner === 'sim_driver_measurements') initialTransition = {
      contractVersion: 'cop-root-driver-checkpoint-transition-v1', operationId: randomUUID(),
      expectedPreviousCheckpointHash: o.checkpoint, checkpointHash: hash('synthetic initial explicitly accepted transition'),
      proofValidUntilUTC: new Date(Date.now() + 12000).toISOString(), replayReady: true, retentionReviewed: true,
      reportProtection: 'no_report', publicationFenceVerified: true,
    };
    stage = 'bootstrap.' + owner + '.root-policy-seed';
    await seedPolicy(owner, initialTransition);
    stage = 'bootstrap.' + owner + '.p0-receipt-acceptance-p1-seed';
    await seedAcceptance(owner);
    o.fixedSchemaFingerprint = o.policy.schemaFingerprint; o.fixedPrivilegeFingerprint = o.policy.privilegeFingerprint;
  }
  stage = 'bootstrap.fresh-host-observation-timer';
  hostTimer = setInterval(() => {for (const owner of Object.keys(specs)) if (!pausedHost.has(owner)) {
    const jobs = pendingHostWrites.get(owner), job = hostFact(owner); jobs.add(job);
    void job.catch(() => {}).finally(() => jobs.delete(job));
  }}, 750);
  return pins;
}

async function lockProbe(client, shared = false) {
  const fn = shared ? 'pg_try_advisory_lock_shared' : 'pg_try_advisory_lock';
  const held = (await client.query('SELECT pg_catalog.' + fn + '(pg_catalog.hashtext(current_database()),904214) AS held')).rows[0].held;
  if (held) await client.query('SELECT pg_catalog.' + (shared ? 'pg_advisory_unlock_shared' : 'pg_advisory_unlock') + '(pg_catalog.hashtext(current_database()),904214)');
  return held;
}
async function exercise(input) {
  const {requireCurrentOwner, beginOwnerPublicationIntent} = await import(OPT + '/root-owner-authority.mjs');
  const {transitionBody} = await import(OPT + '/root-owner-authority-protocol.mjs');
  const owners = Object.keys(specs), owner = input.owner ?? owners[0], peer = ids.owners[owner].peer;
  const purpose = owner === 'sim_driver_measurements' ? 'read' : 'checkpoint-read';
  if (input.scenario === 'valid') {
    for (const currentOwner of owners) {
      const ctx = await requireCurrentOwner(currentOwner, ids.owners[currentOwner].peer, currentOwner === 'sim_driver_measurements' ? 'read' : 'checkpoint-read');
      assert.equal(ctx.owner, currentOwner); assert.equal(ctx.storeIncarnation, ids.owners[currentOwner].store);
      assert.equal(ctx.rootPolicy.reference.digest, ids.owners[currentOwner].policyRef.digest); await ctx.assertCurrent(); await ctx.close();
    }
  } else if (input.scenario === 'shared') {
    const first = await requireCurrentOwner(owners[0], ids.owners[owners[0]].peer, 'read');
    const second = await requireCurrentOwner(owners[1], ids.owners[owners[1]].peer, 'checkpoint-read');
    assert.equal(await lockProbe(registry), false); await first.close(); assert.equal(await lockProbe(registry), false);
    await second.close(); assert.equal(await lockProbe(registry), true);
  } else if (input.scenario === 'exclusive') {
    const ctx = await requireCurrentOwner(owner, peer, 'checkpoint-publish');
    assert.equal(await lockProbe(registry), false); assert.equal(await lockProbe(registry, true), false);
    await assert.rejects(requireCurrentOwner(owners[1], ids.owners[owners[1]].peer, 'checkpoint-read'));
    await ctx.close(); assert.equal(await lockProbe(registry), true);
  } else if (input.scenario === 'expiry-close') {
    const ctx = await requireCurrentOwner(owner, peer, purpose);
    await delay(Math.max(1, Date.parse(ctx.expiresAtUTC) - Date.now() + 80));
    await assert.rejects(ctx.assertCurrent()); assert.equal(await lockProbe(registry), false, 'Expiry alone must not unlock.');
    await ctx.close(); assert.equal(await lockProbe(registry), true);
    const before = (await registry.query('SELECT count(*)::int AS n FROM cop_guard.accepted_runtime_proofs')).rows[0].n;
    await refresh(owner);
    assert.equal((await registry.query('SELECT count(*)::int AS n FROM cop_guard.accepted_runtime_proofs')).rows[0].n, before + 1);
    const next = await requireCurrentOwner(owner, peer, 'checkpoint-publish'); await next.close();
  } else if (input.scenario === 'intent') {
    const ctx = await requireCurrentOwner(owner, peer, 'checkpoint-publish'), body = transitionBody(ctx.rootPolicy, owner, ctx.storeIncarnation);
    const first = await beginOwnerPublicationIntent(ctx, body), path = STATE + '/checkpoint-intents/' + first.operationId + '.json';
    const bytes = await readFile(path), info = await lstat(path);
    await delay(Math.max(1, Date.parse(body.proofValidUntilUTC) - Date.now() + 80));
    const again = await beginOwnerPublicationIntent(ctx, body); assert.deepEqual(again, first);
    assert.deepEqual(await readFile(path), bytes); assert.equal((await lstat(path)).mtimeMs, info.mtimeMs);
    assert.equal(first.bodyDigest, hash(canonical(body))); await ctx.close();
  } else if (input.scenario === 'read-plugin') {
    const {inspectRootDriverOwner, inspectRootAiOwner} = await import(OPT + '/root-owner-read.mjs');
    const {inspectRootDriver} = await import(OPT + '/root-read-admission.mjs');
    const {inspectRootAiCheckpoint} = await import(OPT + '/root-checkpoint-read.mjs');
    const request = owner === 'sim_driver_measurements' ? specs[owner].request() :
      {owner, scope: specs[owner].scope, purpose: 'checkpoint', expectedSnapshot: ids.owners[owner].policy.expectedSnapshot};
    const before = new Set(await readdir(PRIVATE + '/read-evidence'));
    const out = await (owner === 'sim_driver_measurements' ? inspectRootDriverOwner : inspectRootAiOwner)(peer, request);
    const fresh = (await readdir(PRIVATE + '/read-evidence')).filter(name => !before.has(name));
    assert.equal(fresh.length, owner === 'sim_driver_measurements' ? 5 : 4);
    const permitDirectory = owner === 'sim_driver_measurements' ? 'read-permits' : 'ai-read-permits';
    const permitBytes = await readFile(PRIVATE + '/' + permitDirectory + '/' + out.readPermitId + '.json');
    const keys = canonicalJson(await readFile(ETC + '/public/verification-keys.json'));
    const permit = verifyRootRecord(permitBytes, keys, owner === 'sim_driver_measurements' ? 'driver-read-permit' : 'ai-router-read-permit').payload;
    const admission = verifyRootRecord(Buffer.from(out.record), keys, owner === 'sim_driver_measurements' ? 'driver-read-admission' : 'ai-router-read-admission').payload;
    assert.equal(admission.readPermitDigest, hash(permitBytes)); assert.deepEqual(admission.request, request);
    const ref = Object.values(permit.evidence)[0], path = PRIVATE + '/read-evidence/' + ref.recordId + '.json';
    const bytes = await readFile(path); await privateFile(STATE + '/evidence/' + ref.recordId + '.json', bytes); await unlink(path);
    try {await assert.rejects((owner === 'sim_driver_measurements' ? inspectRootDriver : inspectRootAiCheckpoint)(out.readPermitId, request, peer));}
    finally {await privateFile(path, bytes); await unlink(STATE + '/evidence/' + ref.recordId + '.json');}
  } else if (input.scenario === 'hold-disconnect') {
    const ctx = await requireCurrentOwner(owner, peer, purpose);
    const sessions = (await registry.query("SELECT pid FROM pg_stat_activity WHERE datname='cop_account_safety_guard' AND usename='cop_guard_root_reader' AND application_name='cop-root-owner-authority-v1'")).rows;
    assert.equal(sessions.length, 1); assert.equal((await registry.query('SELECT pg_terminate_backend($1) AS stopped', [sessions[0].pid])).rows[0].stopped, true);
    await delay(120); assert.equal(await lockProbe(registry), true, 'PG can release its lock while common retains process-global HOLD.');
    await assert.rejects(ctx.close()); await assert.rejects(requireCurrentOwner(owners[1], ids.owners[owners[1]].peer, 'checkpoint-publish'));
  } else if (input.scenario === 'deny') {
    if (input.expectedCode) await assert.rejects(requireCurrentOwner(owner, input.wrongPeer ?? peer, purpose), {message: input.expectedCode});
    else await assert.rejects(requireCurrentOwner(owner, input.wrongPeer ?? peer, purpose));
  } else throw new Error('UNKNOWN_FIXTURE_SCENARIO');
  return {passed: true, scenario: input.scenario};
}
async function rowsSnapshot() {
  const result = {};
  for (const [name, client, schema] of [['registry', registry, 'cop_guard'], ['driver', driverAdmin, 'public'], ['ai', aiAdmin, 'public']]) {
    const tables = (await client.query('SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename', [schema])).rows;
    for (const row of tables) {
      assert.match(row.tablename, /^[a-z_]+$/);
      result[name + '.' + row.tablename] = (await client.query('SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),\'[]\'::jsonb)::text,\'UTF8\')),\'hex\') AS digest FROM ' + schema + '.' + row.tablename + ' t')).rows[0].digest;
    }
  }
  return result;
}
async function group(name, scenario, {owner = 'sim_driver_measurements', arrange = async () => {}, restore = async () => {}, readOnly = true, mutableTables = [], ttl = 20000} = {}) {
  stage = name;
  for (const key of Object.keys(specs)) await refresh(key, {ttl: key === owner ? ttl : 20000});
  let extra;
  try {
    extra = await arrange(); const before = await rowsSnapshot();
    const result = await exercise({scenario, owner, ...extra}); assert.equal(result.passed, true);
    const after = await rowsSnapshot();
    if (readOnly) assert.deepEqual(after, before, 'Actual read/denial must not mutate target or registry rows.');
    else {
      for (const table of mutableTables) {delete before[table]; delete after[table];}
      assert.deepEqual(after, before, 'Only explicitly requested checkpoint metadata may change.');
    }
    events.push({name, passed: true, readOnly, hostObservationSynthetic: true});
  } finally {
    await restore(extra);
    for (const key of Object.keys(specs)) {
      const {facts} = await targetFacts(key), accepted = ids.owners[key];
      assert.equal(facts.schema.ready, true); assert.equal((facts.privileges ?? facts.permissions).runtimeProfileMatches, true);
      assert.equal(facts.schema.fingerprint, accepted.fixedSchemaFingerprint);
      assert.equal((facts.privileges ?? facts.permissions).fingerprint, accepted.fixedPrivilegeFingerprint);
    }
  }
}
async function run() {
  const pins = await bootstrap();
  // Same original policyRef in P0 and P1. No unapproved policy-history advance
  // is manufactured just to make publication integration appear accepted.
  await group('existing original intent survives its real deadline without resigning or changing body', 'intent');
  await group('actual Root Ed25519/JWS/TLS/full metadata001 and both target SQL chains', 'valid');
  await group('shared leases block real PG904214 exclusive until both actual closes', 'shared');
  await group('exclusive lease blocks actual shared/exclusive and competing common acquire', 'exclusive');
  await group('ordinary proof expiry rejects authority but never unlocks before known explicit close', 'expiry-close',
    {ttl: 3500, readOnly: false, mutableTables: ['registry.accepted_runtime_proofs']});
  for (const owner of Object.keys(specs)) await group('actual fresh per-inspect typed records/permit and no durable fallback: ' + owner, 'read-plugin', {owner});
  const owner = 'sim_driver_measurements', o = ids.owners[owner];
  let saved;
  await group('wrong kernel peer tuple cannot select an owner registration', 'deny', {arrange: async () => ({wrongPeer: {...o.peer, inode: '999'}})});
  await group('forged current source JWS is rejected by actual cryptographic verifier', 'deny', {arrange: async () => {
    const row = (await registry.query('SELECT proof_id FROM cop_guard.accepted_runtime_proofs WHERE binding_id=$1 ORDER BY accepted_at DESC LIMIT 1', [o.runtime])).rows[0];
    const path = STATE + '/runtime-proofs/' + row.proof_id + '.jws'; saved = {path, bytes: await readFile(path)};
    const bytes = Buffer.from(saved.bytes); bytes[bytes.length - 3] = bytes[bytes.length - 3] === 65 ? 66 : 65; await privateFile(path, bytes);
  }, restore: async () => privateFile(saved.path, saved.bytes)});
  await group('frontier signed mismatch is not repaired from target state', 'deny', {arrange: async () => {
    const path = STATE + '/authority/current-frontier.json'; saved = {path, bytes: await readFile(path)};
    const record = canonicalJson(saved.bytes); await signFile(path, 'current-frontier', {...Object.fromEntries(Object.entries(record.payload).filter(([k]) => !['contractVersion','kind','recordId','issuedAt','expiresAt'].includes(k))), sequence: 1}, 20000);
  }, restore: async () => privateFile(saved.path, saved.bytes)});
  await group('boot registration mismatch is rejected', 'deny', {arrange: async () => {
    const path = STATE + '/clients/' + o.peer.device + '-' + o.peer.inode + '.json'; saved = {path, bytes: await readFile(path)};
    const record = canonicalJson(saved.bytes); await signFile(path, 'driver-client-registration', {...Object.fromEntries(Object.entries(record.payload).filter(([k]) => !['contractVersion','kind','recordId','issuedAt','expiresAt'].includes(k))), machineBootId: randomUUID()});
  }, restore: async () => privateFile(saved.path, saved.bytes)});
  await group('actual schema drift rejects independently accepted catalog pin', 'deny', {arrange: async () => driverAdmin.query('ALTER TABLE driver_measurement_receipts DISABLE TRIGGER ALL'),
    restore: async () => driverAdmin.query('ALTER TABLE driver_measurement_receipts ENABLE TRIGGER ALL')});
  await group('actual runtime privilege drift rejects least-privilege profile/pin', 'deny', {arrange: async () => driverAdmin.query('GRANT UPDATE ON driver_account_erasure_operations TO driver_measurements_runtime'),
    restore: async () => driverAdmin.query('REVOKE UPDATE ON driver_account_erasure_operations FROM driver_measurements_runtime')});
  await group('owner policy record substitution cannot satisfy signed source reference', 'deny', {arrange: async () => {
    const path = STATE + '/owner-policies/' + owner + '.json'; saved = {path, bytes: await readFile(path)};
    const r = canonicalJson(saved.bytes); await signFile(path, 'owner-policy', {binding: r.payload.binding, policy: r.payload.policy});
  }, restore: async () => privateFile(saved.path, saved.bytes)});
  await group('changed verification keyring cannot authenticate existing signed authority inputs', 'deny', {arrange: async () => {
    for (const key of Object.keys(specs)) pausedHost.add(key);
    const path = ETC + '/public/verification-keys.json'; saved = {path, bytes: await readFile(path)};
    const key = generateKeyPairSync('ed25519').publicKey.export({format: 'jwk'});
    await privateFile(path, canonical({contractVersion: 'cop-root-verification-keys-v1', keys: [{kid: 'synthetic-other-key', kty: 'OKP', crv: 'Ed25519', x: key.x}]}) + '\n', 0o644);
  }, restore: async () => {await privateFile(saved.path, saved.bytes, 0o644); for (const key of Object.keys(specs)) pausedHost.delete(key);}});
  await group('expired signed host observation cannot be relabeled current', 'deny', {arrange: async () => {
    pausedHost.add(owner); await delay(5200);
  }, restore: async () => {pausedHost.delete(owner); await hostFact(owner);}});
  let changedHost;
  await group('fresh correctly signed observation of another broker instance fails exact actual SELF gate', 'deny', {arrange: async () => {
    pausedHost.add(owner); await Promise.all([...pendingHostWrites.get(owner)]);
    const path = PRIVATE + '/runtime-observations/' + owner + '.json', bytes = await readFile(path);
    changedHost = {path, bytes};
    const record = canonicalJson(bytes), observed = record.payload.observation;
    // Keep brokerSelf (actual native/proc identity) untouched. Only this signed
    // synthetic observation names a different, otherwise shape-valid instance.
    const other = {...observed, observedAtUTC: new Date().toISOString(), broker: {...observed.broker,
      peer: {...observed.broker.peer, inode: String(BigInt(observed.broker.peer.inode) + 1n)},
      startTicks: String(BigInt(observed.broker.startTicks) - 1n)}};
    const forged = issueRootRecord('host-runtime-observation', {observation: other}, {lifetimeMs: 5000,
      expectedKeyringDigest: hash(await readFile(ETC + '/public/verification-keys.json'))});
    storeRootRecord(path, forged.bytes, {replace: true});
    return {expectedCode: 'GUARD_OWNER_BROKER_RESTARTED'};
  }, restore: async () => {
    try {if (changedHost) storeRootRecord(changedHost.path, changedHost.bytes, {replace: true});}
    finally {pausedHost.delete(owner); await hostFact(owner);}
  }});
  await group('fresh signed acceptance artifact must match actual immutable PG row digests', 'deny', {arrange: async () => {
    const path = STATE + '/checkpoint-acceptances/' + o.acceptanceRef.recordId + '.json'; saved = {path, bytes: await readFile(path), ref: o.acceptanceRef};
    const r = canonicalJson(saved.bytes), facts = Object.fromEntries(Object.entries(r.payload).filter(([k]) => !['contractVersion','kind','recordId','issuedAt','expiresAt'].includes(k)));
    o.acceptanceRef = await signFile(path, 'checkpoint-acceptance', {...facts, acceptanceDigest: 'f'.repeat(64)}, 300000, r.payload.recordId); await refresh(owner);
  }, restore: async () => {await privateFile(saved.path, saved.bytes); o.acceptanceRef = saved.ref;}});
  await group('cross-owner receipt reference in a signed acceptance artifact is rejected', 'deny', {arrange: async () => {
    const path = STATE + '/checkpoint-acceptances/' + o.acceptanceRef.recordId + '.json'; saved = {path, bytes: await readFile(path), ref: o.acceptanceRef};
    const r = canonicalJson(saved.bytes), facts = Object.fromEntries(Object.entries(r.payload).filter(([k]) => !['contractVersion','kind','recordId','issuedAt','expiresAt'].includes(k)));
    o.acceptanceRef = await signFile(path, 'checkpoint-acceptance', {...facts, receiptId: ids.owners.sim_ai_router.receiptId}, 300000, r.payload.recordId); await refresh(owner);
  }, restore: async () => {await privateFile(saved.path, saved.bytes); o.acceptanceRef = saved.ref;}});
  await group('fresh current source proof cannot point to an older metadata acceptance generation', 'deny', {arrange: async () => {
    const next = await nextAcceptance(owner); return {next};
  }, restore: async extra => {o.acceptanceRef = extra.next.next; o.receiptId = extra.next.receiptId; o.acceptanceId = extra.next.acceptanceId;}});
  await group('different policyRef without the separately approved historical-policy seam remains denied', 'deny', {arrange: async () => {
    const path = STATE + '/owner-policies/' + owner + '.json'; saved = {path, bytes: await readFile(path), policy: o.policy, ref: o.policyRef};
    await seedPolicy(owner); await refresh(owner);
  }, restore: async () => {await privateFile(saved.path, saved.bytes); o.policy = saved.policy; o.policyRef = saved.ref;}});
  // These are source-only scope declarations, not invented positive cases:
  // natural lost-COMMIT / unknown target-END and actual host/native recovery
  // need separate fixtures and are deliberately not counted as passing here.
  await group('forced metadata disconnect retains process-global HOLD despite free PG lock', 'hold-disconnect');
  for (const [path, pin] of Object.entries(pins)) assert.equal(hash(await readFile(path)), pin);
  return {contractVersion: 'sim-root-owner-authority-isolated-linux-v1', passed: events.length, cases: events,
    startedAt, completedAt: new Date().toISOString(), postgres: '18.6', node: process.version,
    hostObservationSynthetic: true, appPeerSynthetic: true, actualHostObserverExecuted: false, actualPidfdProcObserver: false,
    actualPidfdSelf: true, actualBrokerStartTicks: true, actualBrokerExecutableDigest: true, singleRootProcess: true,
    syntheticAcceptedMetadata: true, realRootCustody: true, realEd25519: true, realJws: true, realStrictTls: true,
    realMetadata001: true, realTargetSql: true, realPg904214Leases: true, pgStubs: 0, authorityCallbacks: 0, providerCalls: 0,
    checkpointWriterIntegrationExercised: false, differentPolicyAdvanceAccepted: false,
    unknownTargetEndExercised: false, lostCommitExercised: false, nativeTransport: false, hostDeploymentAccepted: false,
    productionEnrollment: false, productionChanged: false, wholeAccountComplete: false};
}

let result, failure;
try {
  assert.deepEqual(process.argv.slice(2), ['--run']); result = await run();
} catch (error) {failure = error;}
finally {
  if (hostTimer) clearInterval(hostTimer);
  for (const client of clients) await client.end().catch(() => {});
  if (started) await pgCommand('pg_ctl', ['-D', PGROOT + '/data', '-m', 'immediate', '-w', 'stop']).catch(() => {});
  clearTimeout(deadline);
}
if (failure) {
  const message = typeof failure.message === 'string' && /^GUARD_[A-Z0-9_]+$/.test(failure.message) ? failure.message : 'FIXTURE_ASSERTION_FAILED';
  // Only the fixed fixture basename and numeric source site leave the fixture.
  // Never serialize error.message/stack, assertion values, SQL, body or secrets.
  const site = typeof failure.stack === 'string' ? /\/fixture\/harness\.mjs:([0-9]{1,6}):([0-9]{1,4})\b/.exec(failure.stack) : null;
  const failureSite = site ? 'harness.mjs:' + site[1] + ':' + site[2] : null;
  const failureCode = typeof failure.code === 'string' && /^(?:ERR_ASSERTION|ERR_DLOPEN_FAILED|ERR_MODULE_NOT_FOUND|ENOENT|EACCES|[0-9A-Z]{5})$/.test(failure.code) ? failure.code : null;
  console.log(JSON.stringify({contractVersion: 'sim-root-owner-authority-isolated-linux-v1', passed: false, stage, failure: message, failureSite, failureCode}));
} else console.log(JSON.stringify(result));
// The irreversible final HOLD deliberately remains held in this disposable
// process. Exiting after PG/container teardown is not a Root recovery claim.
process.exit(failure ? 1 : 0);
