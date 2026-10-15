/** NEW source-refresh SQL CAS fixture. No Root/crypto/native claim.
 * Uses the actual pinned 001/002/004 SQL, roles, RLS and immutable triggers.
 * Synthetic metadata/reference strings are NOT signed/accepted Root evidence.
 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import {chown, chmod, lstat, mkdir, readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {networkInterfaces} from 'node:os';
import {performance} from 'node:perf_hooks';
import {promisify} from 'node:util';

const ROOT = '/var/lib/postgresql/source-refresh-cas', DATABASE = 'cop_account_safety_guard', PORT = 6543;
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), execute = promisify(execFile);
const env = {PATH: '/usr/local/bin:/usr/bin:/bin', HOME: ROOT, LANG: 'C', LC_ALL: 'C', TZ: 'UTC'};
const events = [], clients = new Set(), startedAt = new Date().toISOString();
let stage = 'preconditions', started = false, pgUser, admin, source, reader, runtime, enroller;
const IDS = {guard: randomUUID(), epoch: randomUUID(), config: randomUUID(), policy: hash('synthetic CAS policy'), frontier: hash('synthetic initial prefix')};
const deadline = setTimeout(() => {process.stderr.write('SOURCE_REFRESH_SQL_FIXTURE_DEADLINE\n'); process.exit(2);}, 120000);
async function pgCommand(command, args, timeout = 15000) {return execute('/usr/local/bin/' + command, args, {env, uid: pgUser.uid, gid: pgUser.gid, timeout, maxBuffer: 65536});}
async function connect(user, database = DATABASE) {
  const {Client} = createRequire('/sql-test/package.json')('pg');
  const client = new Client({host: ROOT + '/socket', port: PORT, database, user, connectionTimeoutMillis: 2000, query_timeout: 6000, statement_timeout: 5000});
  client.on('error', () => {}); clients.add(client); await client.connect(); return client;
}
const GROUPS = Object.freeze(['valid-one-insert', 'reader-runtime-denied', 'duplicate-and-bad-shape', 'cas-drift', 'expiry',
  'other-rows-immutable', 'concurrent-cas-one-winner', 'direct-enroller-insert-obeys-904214']);
async function bootstrap() {
  stage = 'bootstrap.platform-isolation';
  assert.deepEqual(process.argv.slice(2), ['--run']); assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'arm64');
  assert.equal(process.version, 'v24.20.0'); assert.equal(process.getuid(), 0); assert.ok(existsSync('/.dockerenv'));
  for (const [name, entries] of Object.entries(networkInterfaces())) {assert.equal(name, 'lo'); assert.ok(entries.every(entry => entry.internal));}
  stage = 'bootstrap.source-pins';
  const pins = JSON.parse(await readFile('/fixture/source-pins.json', 'utf8'));
  for (const [path, pin] of Object.entries(pins)) {const item = await lstat(path); assert.ok(item.isFile() && item.uid === 0 && item.nlink === 1 && !(item.mode & 0o022)); assert.equal(hash(await readFile(path)), pin);}
  const user = readFileSync('/etc/passwd', 'utf8').split('\n').find(line => line.startsWith('postgres:'))?.split(':'); assert.ok(user);
  pgUser = {uid: Number(user[2]), gid: Number(user[3])}; assert.ok(pgUser.uid > 0 && pgUser.gid > 0);
  stage = 'bootstrap.fresh-unix-cluster';
  assert.equal(existsSync(ROOT), false); await mkdir(ROOT, {mode: 0o700}); await chown(ROOT, pgUser.uid, pgUser.gid);
  await mkdir(ROOT + '/socket', {mode: 0o700}); await chown(ROOT + '/socket', pgUser.uid, pgUser.gid);
  await pgCommand('initdb', ['-D', ROOT + '/data', '--username=synthetic_admin', '--auth-local=trust', '--auth-host=reject', '--encoding=UTF8', '--locale=C'], 30000);
  await writeFile(ROOT + '/data/pg_hba.conf', 'local all all trust\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n', {mode: 0o600});
  await chown(ROOT + '/data/pg_hba.conf', pgUser.uid, pgUser.gid); await chmod(ROOT + '/data/pg_hba.conf', 0o600);
  await pgCommand('pg_ctl', ['-D', ROOT + '/data', '-l', ROOT + '/server.log', '-o', '-k ' + ROOT + '/socket -p ' + PORT + " -c listen_addresses='' -c unix_socket_permissions=0700 -c timezone=UTC -c log_statement=none -c log_min_error_statement=panic -c max_prepared_transactions=0", '-w', 'start']); started = true;
  const system = await connect('synthetic_admin', 'postgres');
  await system.query('CREATE DATABASE ' + DATABASE); admin = await connect('synthetic_admin');
  assert.equal((await admin.query('SELECT inet_server_addr() AS address')).rows[0].address, null);
  stage = 'bootstrap.actual-metadata-001'; await admin.query(await readFile('/fixture/sql/001-guard-metadata.sql', 'utf8'));
  await admin.query('REVOKE ALL ON DATABASE ' + DATABASE + ' FROM PUBLIC');
  stage = 'bootstrap.actual-metadata-reader-002'; await admin.query(await readFile('/fixture/sql/002-root-reader.sql', 'utf8'));
  stage = 'bootstrap.actual-source-refresh-004'; await admin.query(await readFile('/fixture/sql/004_source_refresh_cas.sql', 'utf8'));
  const roles = (await admin.query("SELECT rolname,rolcanlogin,rolconnlimit FROM pg_roles WHERE rolname IN ('cop_guard_source_refresher','cop_guard_source_refresh_owner') ORDER BY rolname")).rows;
  assert.equal(roles.length, 2); for (const role of roles) {assert.equal(role.rolcanlogin, false); assert.equal(role.rolconnlimit, 0);}
  // Isolated fixture-only LOGIN activation. No passwords, production profile,
  // role membership or production grant is read or created by this test.
  await admin.query('ALTER ROLE cop_guard_source_refresher LOGIN CONNECTION LIMIT 4; ALTER ROLE cop_guard_root_reader LOGIN CONNECTION LIMIT 4; ALTER ROLE cop_guard_root_enroller LOGIN CONNECTION LIMIT 4; CREATE ROLE synthetic_app_runtime LOGIN NOINHERIT');
  await admin.query('GRANT CONNECT ON DATABASE ' + DATABASE + ' TO cop_guard_root_enroller,synthetic_app_runtime');
  source = await connect('cop_guard_source_refresher'); reader = await connect('cop_guard_root_reader'); runtime = await connect('synthetic_app_runtime'); enroller = await connect('cop_guard_root_enroller');
  await admin.query("SET TimeZone='UTC'");
  assert.match((await admin.query('SELECT version() AS version')).rows[0].version, /PostgreSQL 18\.6/);
  await admin.query("INSERT INTO cop_guard.guard_identity(guard_store_id,application_id,guard_contract_version,stream_scope_id,initial_prefix_digest,enrollment_evidence_ref) VALUES($1,'cop','cop-account-safety-runtime-v1','cop-global-fences-v1',$2,'synthetic-sql-gate')", [IDS.guard, IDS.frontier]);
  await admin.query("INSERT INTO cop_guard.policies(policy_generation,guard_store_id,policy_id,policy_digest,protected_config_id,admission_policy_id,continuity_epoch,root_evidence_ref) VALUES(1,$1,'cop-jizda-only-sim-preserved-v1',$2,$3,'synthetic-sql-gate-v1',$4,'synthetic-sql-gate')", [IDS.guard, IDS.policy, IDS.config, IDS.epoch]);
  return pins;
}
const clone = value => JSON.parse(JSON.stringify(value));
const stamp = value => {assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); assert.equal(new Date(value).toISOString(), value);};
async function nowMs() {return Date.parse((await admin.query("SELECT to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS value")).rows[0].value);}
async function rowDigest(table, column, id) {
  assert.match(table, /^[a-z_]+$/); assert.match(column, /^[a-z_]+$/);
  return (await admin.query("SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS value FROM cop_guard." + table + ' t WHERE ' + column + '=$1', [id])).rows[0].value;
}
async function tableState() {
  const out = {};
  const tables = (await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='cop_guard' ORDER BY tablename")).rows;
  assert.equal(tables.length, 9);
  for (const {tablename} of tables) {
    assert.match(tablename, /^[a-z_]+$/);
    if (tablename === 'accepted_runtime_proofs') out[tablename] = Object.fromEntries((await admin.query("SELECT proof_id,encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS digest FROM cop_guard.accepted_runtime_proofs t ORDER BY proof_id")).rows.map(row => [row.proof_id, row.digest]));
    else out[tablename] = (await admin.query("SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS value FROM cop_guard." + tablename + ' t')).rows[0].value;
  }
  return out;
}
async function denied(work, code) {
  try {await work(); assert.fail('Expected exact SQL rejection.');}
  catch (error) {if (error.code === 'ERR_ASSERTION') throw error; assert.equal(error.code, code);}
}
async function call(client, body, {readOnly = false, isolation = 'READ COMMITTED'} = {}) {
  assert.ok(['READ COMMITTED', 'REPEATABLE READ'].includes(isolation));
  await client.query('BEGIN ISOLATION LEVEL ' + isolation + (readOnly ? ' READ ONLY' : ' READ WRITE'));
  try {const result = (await client.query('SELECT cop_guard.refresh_runtime_proof($1::jsonb) AS value', [JSON.stringify(body)])).rows[0].value; await client.query('COMMIT'); return result;}
  catch (error) {await client.query('ROLLBACK'); throw error;}
}
async function lease(client, work) {
  await client.query('SELECT pg_advisory_lock(hashtext(current_database()),904214)');
  try {return await work();} finally {await client.query('ROLLBACK').catch(() => {}); assert.equal((await client.query('SELECT pg_advisory_unlock(hashtext(current_database()),904214) AS value')).rows[0].value, true);}
}
async function waitForAdvisoryWait(pid) {
  for (let i = 0; i < 40; i++) {
    const row = (await admin.query("SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
    if (row?.wait_event_type === 'Lock' && row.wait_event === 'advisory') return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Actual backend advisory-lock wait was not observed.');
}
async function directProof(client, seed, {offset = 0, kind = 'refresh'} = {}) {
  assert.ok(['refresh', 'enrollment'].includes(kind));
  const time = await nowMs(), id = randomUUID(), operation = randomUUID(), digest = hash('synthetic direct proof ' + id);
  await client.query(`INSERT INTO cop_guard.accepted_runtime_proofs(proof_id,operation_id,operation_kind,binding_id,proof_jws_digest,accepted_jws_ref,
    trust_profile_id,frontier_sequence,frontier_digest,observed_at,issued_at,valid_until,root_evidence_ref)
    VALUES($1,$2,$3,$4,$5,$6,'synthetic-sql-gate-v1',0,$7,$8,$8,$9,$6)`,
  [id, operation, kind, seed.runtime, digest, id + ':' + digest, IDS.frontier, new Date(time + offset).toISOString(), new Date(time + offset + 20000).toISOString()]);
  return {id, operation, digest};
}
async function seedDataset() {
  const seed = {dataset: randomUUID(), runtime: randomUUID(), incarnation: randomUUID(), proof: randomUUID(), operation: randomUUID(), receipt: randomUUID(), acceptance: randomUUID()};
  seed.jws = hash('synthetic enrollment ' + seed.proof); const time = await nowMs();
  await admin.query("INSERT INTO cop_guard.dataset_bindings(dataset_binding_id,guard_store_id,owner_id,projection_contract_id,continuity_epoch,target_store_id,target_dataset_id,target_incarnation_id,target_restore_generation,root_evidence_ref) VALUES($1,$2,'sim_driver_measurements','cop-sim-driver-projection-v1',$3,$4,$5,$6,1,'synthetic-sql-gate')", [seed.dataset, IDS.guard, IDS.epoch, randomUUID(), randomUUID(), seed.incarnation]);
  await admin.query("INSERT INTO cop_guard.runtime_bindings(binding_id,dataset_binding_id,owner_id,policy_generation,image_id,source_revision,runtime_instance_id,runtime_profile_id,root_evidence_ref) VALUES($1,$2,'sim_driver_measurements',1,$3,$4,$5,$6,'synthetic-sql-gate')", [seed.runtime, seed.dataset, 'sha256:' + hash('synthetic image'), 'f3c05e3ae1ca3081d2f5551bc03da233c0c3a473', hash('synthetic runtime ' + seed.runtime), randomUUID()]);
  await admin.query(`INSERT INTO cop_guard.accepted_runtime_proofs(proof_id,operation_id,operation_kind,binding_id,proof_jws_digest,accepted_jws_ref,trust_profile_id,
    frontier_sequence,frontier_digest,observed_at,issued_at,valid_until,root_evidence_ref,accepted_at)
    VALUES($1,$2,'enrollment',$3,$4,$5,'synthetic-sql-gate-v1',0,$6,$7,$7,$8,'synthetic-sql-gate',$9)`,
  [seed.proof, seed.operation, seed.runtime, seed.jws, seed.proof + ':' + seed.jws, IDS.frontier,
    new Date(time - 50).toISOString(), new Date(time + 20000).toISOString(), new Date(time - 5).toISOString()]);
  await admin.query("INSERT INTO cop_guard.replay_operations(operation_id,operation_kind,source_proof_id,binding_id,root_evidence_ref) VALUES($1,'enrollment',$2,$3,'synthetic-sql-gate')", [seed.operation, seed.proof, seed.runtime]);
  await admin.query(`INSERT INTO cop_guard.owner_receipts(receipt_id,replay_operation_id,source_proof_id,source_proof_jws_digest,binding_id,owner_id,expected_checkpoint_generation,
    expected_fence_sequence,expected_fence_digest,expected_cleanup_sequence,expected_cleanup_digest,expected_cleanup_status,fence_sequence,fence_digest,
    cleanup_sequence,cleanup_digest,cleanup_status,coverage_evidence_ref,readback_evidence_ref,attempt,observed_at)
    VALUES($1,$2,$3,$4,$5,'sim_driver_measurements',0,0,$6,0,$6,'unknown',0,$6,0,$6,'complete','synthetic-sql-gate','synthetic-sql-gate',1,clock_timestamp())`,
  [seed.receipt, seed.operation, seed.proof, seed.jws, seed.runtime, IDS.frontier]);
  await admin.query(`INSERT INTO cop_guard.checkpoint_acceptances(acceptance_id,dataset_binding_id,generation,receipt_id,policy_generation,policy_digest,protected_config_id,
    admission_policy_id,continuity_epoch,accepted_frontier_sequence,accepted_frontier_digest,fence_sequence,fence_digest,cleanup_sequence,cleanup_digest,cleanup_status,root_evidence_ref)
    VALUES($1::uuid,$2,1,$3,1,$4,$5,'synthetic-sql-gate-v1',$6,0,$7,0,$7,0,$7,'complete',($1::uuid)::text)`,
  [seed.acceptance, seed.dataset, seed.receipt, IDS.policy, IDS.config, IDS.epoch, IDS.frontier]);
  return seed;
}
async function bodyFor(seed) {
  const latest = (await admin.query('SELECT proof_id,proof_jws_digest FROM cop_guard.accepted_runtime_proofs WHERE binding_id=$1 ORDER BY accepted_at DESC,issued_at DESC,proof_id DESC LIMIT 1', [seed.runtime])).rows[0];
  const time = await nowMs();
  return {contractVersion: 'cop-root-source-refresh-cas-v1', owner: 'sim_driver_measurements', binding: {
    guardStoreId: IDS.guard, continuityEpoch: IDS.epoch, protectedConfigId: IDS.config, datasetBindingId: seed.dataset, runtimeBindingId: seed.runtime,
    policyGeneration: '1', policyDigest: IDS.policy, storeIncarnation: seed.incarnation}, expected: {
    identityRowDigest: await rowDigest('guard_identity', 'guard_store_id', IDS.guard), policyRowDigest: await rowDigest('policies', 'policy_generation', '1'),
    datasetRowDigest: await rowDigest('dataset_bindings', 'dataset_binding_id', seed.dataset), runtimeRowDigest: await rowDigest('runtime_bindings', 'binding_id', seed.runtime),
    latestProofId: latest.proof_id, latestProofJwsDigest: latest.proof_jws_digest, latestProofRowDigest: await rowDigest('accepted_runtime_proofs', 'proof_id', latest.proof_id),
    frontierSequence: '0', frontierDigest: IDS.frontier, acceptanceId: seed.acceptance, acceptanceGeneration: '1',
    acceptanceRowDigest: await rowDigest('checkpoint_acceptances', 'acceptance_id', seed.acceptance), receiptRowDigest: await rowDigest('owner_receipts', 'receipt_id', seed.receipt),
    replayRowDigest: await rowDigest('replay_operations', 'operation_id', seed.operation), receiptSourceProofRowDigest: await rowDigest('accepted_runtime_proofs', 'proof_id', seed.proof)},
    refresh: {proofId: randomUUID(), operationId: randomUUID(), proofJwsDigest: hash('synthetic refresh ' + randomUUID()), trustProfileId: 'synthetic-sql-gate-v1',
      observedAtUTC: new Date(time).toISOString(), issuedAtUTC: new Date(time).toISOString(), expiresAtUTC: new Date(time + 20000).toISOString()}};
}
async function group(name, inserts, work) {
  stage = name; const seed = await seedDataset(), before = await tableState(); await work(seed); const after = await tableState();
  for (const key of Object.keys(before)) if (key !== 'accepted_runtime_proofs') assert.equal(after[key], before[key], 'Unrelated immutable metadata changed.');
  for (const [id, digest] of Object.entries(before.accepted_runtime_proofs)) assert.equal(after.accepted_runtime_proofs[id], digest, 'Original proof row changed.');
  assert.equal(Object.keys(after.accepted_runtime_proofs).length - Object.keys(before.accepted_runtime_proofs).length, inserts);
  events.push({name, passed: true, proofRowsAddedDuringCase: inserts,
    directSyntheticProofAppendIncluded: [GROUPS[3], GROUPS[4], GROUPS[7]].includes(name)});
}
async function runSqlCases() {
  await group(GROUPS[0], 1, async seed => {
    const body = await bodyFor(seed), result = await lease(source, () => call(source, body));
    assert.deepEqual(Object.keys(result).sort(), ['contractVersion','proofId','proofJwsDigest','acceptedJwsRef','acceptedAtUTC','rowDigest'].sort());
    assert.equal(result.contractVersion, 'cop-root-source-refresh-cas-result-v1'); assert.equal(result.proofId, body.refresh.proofId); assert.equal(result.proofJwsDigest, body.refresh.proofJwsDigest); stamp(result.acceptedAtUTC);
    const stored = (await admin.query("SELECT *,to_char(accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS accepted_ms FROM cop_guard.accepted_runtime_proofs WHERE proof_id=$1", [result.proofId])).rows[0];
    assert.equal(stored.operation_kind, 'refresh'); assert.equal(stored.binding_id, seed.runtime); assert.equal(stored.operation_id, body.refresh.operationId);
    assert.equal(result.acceptedJwsRef, result.proofId + ':' + result.proofJwsDigest); assert.equal(stored.accepted_jws_ref, result.acceptedJwsRef); assert.equal(stored.root_evidence_ref, result.acceptedJwsRef);
    assert.equal(stored.accepted_ms, result.acceptedAtUTC); assert.equal(result.rowDigest, await rowDigest('accepted_runtime_proofs', 'proof_id', result.proofId));
  });
  await group(GROUPS[1], 0, async seed => {
    const body = await bodyFor(seed);
    const definition = (await admin.query("SELECT p.prosecdef,pg_get_userbyid(p.proowner) AS owner,p.proconfig FROM pg_proc p WHERE p.oid='cop_guard.refresh_runtime_proof(jsonb)'::regprocedure")).rows[0];
    assert.equal(definition.prosecdef, true); assert.equal(definition.owner, 'cop_guard_source_refresh_owner');
    for (const setting of ['search_path=pg_catalog', 'row_security=on', 'timezone=utc']) assert.ok(definition.proconfig.map(value => value.toLowerCase()).includes(setting));
    for (const client of [reader, source]) assert.equal((await client.query("SELECT current_setting('default_transaction_read_only') AS value")).rows[0].value, 'on');
    for (const client of [reader, runtime, admin]) await denied(() => call(client, body), '42501');
    for (const client of [reader, runtime, source]) {
      await denied(() => client.query('SET ROLE cop_guard_source_refresh_owner'), '42501');
      await client.query('BEGIN READ WRITE');
      try {await denied(() => directProof(client, seed), '42501');} finally {await client.query('ROLLBACK');}
    }
    await denied(() => call(source, body), '55000');
    await source.query('SELECT pg_advisory_lock_shared(hashtext(current_database()),904214)');
    try {await denied(() => call(source, body), '55000');} finally {assert.equal((await source.query('SELECT pg_advisory_unlock_shared(hashtext(current_database()),904214) AS value')).rows[0].value, true);}
    const other = await connect('cop_guard_source_refresher');
    await lease(other, () => denied(() => call(source, body), '55000'));
    await lease(source, async () => {await denied(() => call(source, body, {readOnly: true}), '55000'); await denied(() => call(source, body, {isolation: 'REPEATABLE READ'}), '55000');});
    const memberships = (await admin.query("SELECT count(*)::int AS n FROM pg_auth_members WHERE member IN ('cop_guard_source_refresher'::regrole,'cop_guard_source_refresh_owner'::regrole) OR roleid IN ('cop_guard_source_refresher'::regrole,'cop_guard_source_refresh_owner'::regrole)")).rows[0].n;
    assert.equal(memberships, 0);
    for (const role of ['cop_guard_root_reader', 'cop_guard_source_refresher']) assert.equal((await admin.query("SELECT has_any_column_privilege($1,'cop_guard.accepted_runtime_proofs','INSERT') AS value", [role])).rows[0].value, false);
  });
  await group(GROUPS[2], 1, async seed => {
    const body = await bodyFor(seed), missing = clone(body); delete missing.expected.receiptSourceProofRowDigest;
    const malformed = [null, [], {}, missing, {...body, extra: true}, {...body, owner: 'cop'}, {...body, contractVersion: 'wrong'},
      {...body, binding: {...body.binding, policyGeneration: 1}}, {...body, binding: {...body.binding, policyGeneration: '01'}},
      {...body, expected: {...body.expected, frontierSequence: 0}}, {...body, expected: {...body.expected, acceptanceGeneration: '9223372036854775808'}},
      {...body, refresh: {...body.refresh, extra: 'not-allowed'}}, {...body, refresh: {...body.refresh, proofId: 'bad'}},
      {...body, refresh: {...body.refresh, proofJwsDigest: 'A'.repeat(64)}}, {...body, refresh: {...body.refresh, observedAtUTC: '2026-02-30T00:00:00.000Z'}},
      {...body, refresh: {...body.refresh, issuedAtUTC: '2026-10-15T00:00:00Z'}}];
    await lease(source, async () => {for (const invalid of malformed) await denied(() => call(source, invalid), '22023');
      await call(source, body);
      const next = await bodyFor(seed); next.refresh.operationId = body.refresh.operationId;
      await denied(() => call(source, next), '23505');
      const sameProof = await bodyFor(seed); sameProof.refresh.proofId = body.refresh.proofId;
      await denied(() => call(source, sameProof), '23505');
    });
  });
  await group(GROUPS[3], 1, async seed => {
    const body = await bodyFor(seed);
    await lease(source, async () => {
      for (const key of ['identityRowDigest','policyRowDigest','datasetRowDigest','runtimeRowDigest','latestProofJwsDigest','latestProofRowDigest','acceptanceRowDigest','receiptRowDigest','replayRowDigest','receiptSourceProofRowDigest','frontierDigest']) {
        const altered = clone(body); altered.expected[key] = 'f'.repeat(64); await denied(() => call(source, altered), '40001');
      }
      const altered = clone(body); altered.binding.storeIncarnation = randomUUID(); await denied(() => call(source, altered), '40001');
      const wrongOwner = clone(body); wrongOwner.owner = 'sim_ai_router'; await denied(() => call(source, wrongOwner), '40001');
    });
    // Real append between snapshot construction and RPC, not just bad input.
    await directProof(admin, seed);
    await lease(source, () => denied(() => call(source, body), '40001'));
  });
  await group(GROUPS[4], 1, async seed => {
    const body = await bodyFor(seed), time = await nowMs();
    await lease(source, async () => {
      for (const patch of [{expiresAtUTC: new Date(time - 1).toISOString()}, {expiresAtUTC: new Date(time + 31000).toISOString()},
        {observedAtUTC: new Date(time - 6000).toISOString()}, {issuedAtUTC: new Date(time + 10000).toISOString()}]) {
        const altered = clone(body); Object.assign(altered.refresh, patch); await denied(() => call(source, altered), '55000');
      }
    });
    // A different original proof is intentionally ALREADY expired; never renew
    // it merely because the new proposed timestamps look fresh.
    await directProof(admin, seed, {offset: -21000});
    const expired = await bodyFor(seed); await lease(source, () => denied(() => call(source, expired), '55000'));
  });
  await group(GROUPS[5], 1, async seed => {
    const before = await tableState(), body = await bodyFor(seed); await lease(source, () => call(source, body));
    // checked below after one actual append; no table/row mutation bypass.
    for (const sql of ["UPDATE cop_guard.accepted_runtime_proofs SET root_evidence_ref=root_evidence_ref WHERE proof_id='" + seed.proof + "'",
      "DELETE FROM cop_guard.accepted_runtime_proofs WHERE proof_id='" + seed.proof + "'", 'TRUNCATE cop_guard.fence_journal CASCADE']) await denied(() => admin.query(sql), '55000');
    const after = await tableState(); for (const [id, digest] of Object.entries(before.accepted_runtime_proofs)) assert.equal(after.accepted_runtime_proofs[id], digest);
    for (const table of Object.keys(before)) if (table !== 'accepted_runtime_proofs') assert.equal(after[table], before[table]);
  });
  await group(GROUPS[6], 1, async seed => {
    const first = await bodyFor(seed), second = clone(first); second.refresh.proofId = randomUUID(); second.refresh.operationId = randomUUID(); second.refresh.proofJwsDigest = hash('synthetic concurrent second');
    const other = await connect('cop_guard_source_refresher'), pid = (await other.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let waiting;
    await lease(source, async () => {
      waiting = lease(other, () => call(other, second)).then(value => ({ok: true, value}), error => ({ok: false, error}));
      await waitForAdvisoryWait(pid); const winner = await call(source, first); assert.equal(winner.proofId, first.refresh.proofId);
    });
    const loser = await waiting; assert.equal(loser.ok, false); assert.equal(loser.error.code, '40001');
  });
  await group(GROUPS[7], 1, async seed => {
    const trigger = (await admin.query("SELECT t.tgenabled,p.prosecdef FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid='cop_guard.accepted_runtime_proofs'::regclass AND t.tgname='source_refresh_serialize_insert'")).rows[0];
    assert.equal(trigger.tgenabled, 'A'); assert.equal(trigger.prosecdef, false);
    assert.equal((await admin.query("SELECT has_function_privilege('cop_guard_root_enroller','cop_guard.serialize_runtime_proof_insert()','EXECUTE') AS value")).rows[0].value, false);
    const pid = (await enroller.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await lease(source, async () => {
      const at = performance.now(), blocked = directProof(enroller, seed, {kind: 'enrollment'}).then(() => ({ok: true}), error => ({ok: false, error}));
      await waitForAdvisoryWait(pid); const result = await blocked; assert.equal(result.ok, false); assert.equal(result.error.code, '55P03');
      const elapsed = performance.now() - at; assert.ok(elapsed >= 750 && elapsed < 3500, 'Actual ALL-insert lock wait must be bounded and observed.');
    });
    await directProof(enroller, seed, {kind: 'enrollment'});
  });
}
let result, failure;
try {
  const pins = await bootstrap(); stage = 'sql-cases'; await runSqlCases();
  assert.equal(events.length, GROUPS.length); assert.deepEqual(events.map(entry => entry.name), GROUPS); assert.ok(events.every(entry => entry.passed === true));
  for (const [path, pin] of Object.entries(pins)) assert.equal(hash(await readFile(path)), pin);
  result = {contractVersion: 'sim-source-refresh-cas-sql-test-v1', passed: events.length, cases: events, startedAt, completedAt: new Date().toISOString(),
    actualPostgres: true, syntheticMetadataOnly: true, rootAuthorityVerified: false, rootSignaturesVerified: false, nativeTransport: false,
    lostCommitExercised: false, realAccounts: false, providerCalls: 0, productionChanged: false, wholeAccountComplete: false};
} catch (error) {failure = error;}
finally {
  for (const client of clients) {await client.query('ROLLBACK').catch(() => {}); await client.end().catch(() => {});}
  if (started) await pgCommand('pg_ctl', ['-D', ROOT + '/data', '-m', 'immediate', '-w', 'stop']).catch(() => {});
  clearTimeout(deadline);
}
if (failure) {
  const site = typeof failure.stack === 'string' ? /\/fixture\/harness\.mjs:([0-9]{1,6}):([0-9]{1,4})\b/.exec(failure.stack) : null;
  const failureCode = typeof failure.code === 'string' && /^(?:[0-9A-Z]{5}|ERR_[A-Z0-9_]+)$/.test(failure.code) ? failure.code : null;
  const boundedPosition = value => typeof value === 'string' && /^[1-9][0-9]{0,7}$/.test(value) ? Number(value) : null;
  const keyword = typeof failure.message === 'string' ? /^syntax error at or near "([A-Za-z_]{1,32})"$/.exec(failure.message) : null;
  const allowedKeywords = ['CASE','WHEN','THEN','ELSE','END','IF','OR','AND','ARRAY','BEGIN','LOOP','BINDING','EXPECTED','REFRESH','REFERENCE','OWNER','CREATE','FUNCTION','SELECT','INSERT','RETURNING','SET','INTO'];
  const syntaxKeyword = keyword && allowedKeywords.includes(keyword[1].toUpperCase()) ? keyword[1].toUpperCase() :
    failure.message === 'syntax error at end of input' ? 'END_OF_INPUT' : null;
  console.log(JSON.stringify({contractVersion: 'sim-source-refresh-cas-sql-test-v1', passed: false, stage,
    failure: 'FIXTURE_ASSERTION_FAILED',
    failureSite: site ? 'harness.mjs:' + site[1] + ':' + site[2] : null, failureCode,
    sqlPosition: boundedPosition(failure.position), sqlInternalPosition: boundedPosition(failure.internalPosition), syntaxKeyword}));
} else console.log(JSON.stringify(result));
process.exit(failure ? 1 : 0);
