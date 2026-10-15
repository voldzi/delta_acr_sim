/** Six NEW actual SQL007 groups; only synthetic data in a fresh private cluster.
 * No Root, signatures, consent/identity authority, service or production claim.
 * The parent runner supplies pinned SQL001-schema/002..007 + real pg ordinary
 * files, and starts only a fixed local PG18.6 image with --network none.
 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {chmod, chown, lstat, mkdir, readFile, statfs, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {networkInterfaces} from 'node:os';
import {promisify} from 'node:util';

const ROOT = '/var/lib/postgresql/driver-eta-binding', DATABASE = 'sim_driver_measurements', PORT = 6543;
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), execute = promisify(execFile);
const env = {PATH: '/usr/local/bin:/usr/bin:/bin', HOME: ROOT, LANG: 'C', LC_ALL: 'C', TZ: 'UTC'};
const SQL_PINS = Object.freeze({
  'schema.sql': '6dd60a3acf28d63575198c8526c368df19bbd543f4063d4985fb55f308da02d0',
  '002_account_erasure.sql': 'f13db2106a1fe1a02d0d1a26afa8ad7d7c045172ba4419749719ed0f166e16ad',
  '003_guarded_operations.sql': 'e3513a983a3b6d1bd52d46851c734dd1c3b208e2e2f6430a6f9eddd38b10d3b5',
  '004_read_admission_facts.sql': '791545b9df91e65bb555c68a44dadd73a847ca64fde0c31a9036f9f555ba1d2d',
  '005_root_checkpoint.sql': '77faac125f6133a774e6d9e900c2dcbfc3b86419d3179bfb4d5bcf64eb3bb3cb',
  '006_inventory_candidates.sql': 'bd69ca4e58746c852b49bf0ad1f59465a64fc781a59c4c9fe88073199080efe0',
  '007_eta_contributor_binding.sql': '135acb29c58734e232891aa9b61fac3e6520b6dd7209a57dbd5dc8240fbc5942',
});
const GROUPS = Object.freeze(['legacy-mismatch-rolls-back-without-changes', 'clean-forward-migration-preserves-data-and-authority',
  'wrong-hash-insert-update-denied-same-hash-allowed', 'parent-cascade-preserves-other-contributor',
  'concurrent-insert-delete-is-serialized-by-real-fk', 'reader-ready-new-schema-pin-old-policy-rejected']);
const IDS = Object.freeze({store: randomUUID(), a: randomUUID(), b: randomUUID(), aObservation: randomUUID(), bObservation: randomUUID(), badObservation: randomUUID()});
const H = Object.freeze({a: hash('synthetic ETA contributor A'), b: hash('synthetic ETA contributor B'), request: hash('synthetic receipt request'),
  checkpoint: hash('synthetic fixture checkpoint, NOT Root evidence'), unrelated: hash('synthetic unrelated retained fence'), operation: hash('synthetic unrelated erasure operation')});
const request = Object.freeze({owner: 'sim_driver_measurements', scope: 'online_driver_scope', purpose: 'capability'});
const events = [], clients = new Set(), startedAt = new Date().toISOString();
let stage = 'preconditions', started = false, pgUser, admin, control, runtime, inputPins, oldFacts, newFacts, matchDriverReadPolicy, DriverReadFactsError;
let cleanupComplete = true, providerCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {providerCalls++; throw new Error('Provider/network access is forbidden.');};
const deadline = setTimeout(() => {process.stderr.write('DRIVER_ETA_BINDING_FIXTURE_DEADLINE\n'); process.exit(2);}, 120000);
async function pgCommand(command, args, timeout = 15000) {
  return execute('/usr/local/bin/' + command, args, {env, uid: pgUser.uid, gid: pgUser.gid, timeout, maxBuffer: 65536});
}
async function connect(user, database = DATABASE) {
  const {Client} = createRequire('/sql-test/package.json')('pg');
  const client = new Client({host: ROOT + '/socket', port: PORT, database, user, password: '', ssl: false, options: '',
    application_name: 'sim-driver-eta-binding-source-test', connectionTimeoutMillis: 2000, query_timeout: 20000, statement_timeout: 5000});
  client.on('error', () => {}); clients.add(client); await client.connect(); return client;
}
const value = async (client, sql, args = []) => (await client.query(sql, args)).rows[0].value;
async function denied(work, code, message) {
  try {await work(); assert.fail('Expected fixed SQL rejection.');}
  catch (error) {if (error.code === 'ERR_ASSERTION') throw error; assert.equal(error.code, code); if (message) assert.equal(error.message, message);}
}
async function end(client) {
  await client.query('ROLLBACK'); await client.end(); clients.delete(client);
}
async function facts() {
  await control.query('BEGIN READ ONLY');
  try {return await value(control, 'SELECT sim_driver_guard_source.read_admission_facts($1::jsonb) AS value', [JSON.stringify(request)]);}
  finally {await control.query('ROLLBACK');}
}
const data = () => value(admin, `SELECT jsonb_build_object(
 'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,batch_id),'[]') FROM public.driver_measurement_receipts t),
 'intervals',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,measurement_key),'[]') FROM public.driver_measurement_intervals t),
 'eta',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,batch_id),'[]') FROM public.driver_measurement_eta t),
 'temporary',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,contributor_hash),'[]') FROM public.driver_measurement_revocations t),
 'state',(SELECT to_jsonb(t) FROM public.driver_account_erasure_state t WHERE singleton),
 'ledger',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY operation_hash),'[]') FROM public.driver_account_erasure_operations t),
 'permanent',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,contributor_hash),'[]') FROM public.driver_account_erasure_revocations t),
 'origins',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY operation_id),'[]') FROM sim_driver_guard_source.origins t),
 'store',(SELECT to_jsonb(t) FROM sim_driver_guard_source.store_binding t WHERE singleton)) AS value`);
const authority = () => value(admin, `SELECT jsonb_build_object(
 'roles',(SELECT jsonb_agg(jsonb_build_object('name',rolname,'login',rolcanlogin,'super',rolsuper,'createDb',rolcreatedb,
   'createRole',rolcreaterole,'replication',rolreplication,'bypass',rolbypassrls,'inherit',rolinherit) ORDER BY rolname) FROM pg_roles),
 'memberships',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY roleid,member,grantor),'[]') FROM pg_auth_members m),
 'database',(SELECT jsonb_build_object('owner',datdba,'acl',to_jsonb(datacl)) FROM pg_database WHERE datname=current_database()),
 'schemas',(SELECT jsonb_agg(jsonb_build_object('name',nspname,'owner',nspowner,'acl',to_jsonb(nspacl)) ORDER BY nspname)
   FROM pg_namespace WHERE nspname IN ('public','sim_driver_guard_source')),
 'tables',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'owner',c.relowner,'acl',to_jsonb(c.relacl),
   'columns',(SELECT jsonb_agg(jsonb_build_object('name',attname,'acl',to_jsonb(attacl)) ORDER BY attnum)
     FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped)) ORDER BY n.nspname,c.relname)
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','sim_driver_guard_source') AND c.relkind='r'),
 'functions',(SELECT jsonb_agg(jsonb_build_object('name',n.nspname||'.'||p.proname,'arguments',pg_get_function_identity_arguments(p.oid),
   'owner',p.proowner,'acl',to_jsonb(p.proacl),'definition',pg_get_functiondef(p.oid)) ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','sim_driver_guard_source'))) AS value`);
const schema = () => value(admin, `SELECT jsonb_build_object(
 'columns',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
   'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum)
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
   LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('table',conrelid::regclass::text,'name',conname,'definition',pg_get_constraintdef(oid),
   'validated',convalidated,'deferrable',condeferrable,'deferred',condeferred) ORDER BY conrelid::regclass::text,conname)
   FROM pg_constraint WHERE connamespace='public'::regnamespace),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'definition',pg_get_indexdef(i.indexrelid),
   'valid',i.indisvalid,'ready',i.indisready) ORDER BY c.relname) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
   JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
 'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid)||':'||t.tgenabled::text ORDER BY c.relname,t.tgname)
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public')) AS value`);
const insertReceipt = (batch, contributor) => admin.query(`INSERT INTO public.driver_measurement_receipts
 (owner,batch_id,contributor_hash,request_hash,received_at,expires_at,receipt) VALUES('cop',$1,$2,$3,now(),now()+interval '1 day',$4::jsonb)`,
 [batch, contributor, H.request, JSON.stringify({synthetic: true, acceptedIntervalCount: 1})]);
const insertEta = (client, batch, contributor, observation = randomUUID()) => client.query(`INSERT INTO public.driver_measurement_eta
 (owner,batch_id,observation_id,contributor_hash,dataset,window_start,predicted_seconds,actual_seconds)
 VALUES('cop',$1,$2,$3,'synthetic-graph',date_trunc('hour',now()),100,120)`, [batch, observation, contributor]);
async function blocked(waiter, blocker) {
  const until = Date.now() + 2000;
  while (Date.now() < until) {
    const row = (await admin.query('SELECT wait_event_type,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=$1', [waiter])).rows[0];
    if (row?.wait_event_type === 'Lock' && row.blockers.includes(blocker)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('The actual FK lock wait was not observed.');
}
async function bootstrap() {
  stage = 'bootstrap.platform-isolation';
  assert.deepEqual(process.argv.slice(2), ['--run']); assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'arm64');
  assert.equal(process.version, 'v24.20.0'); assert.equal(process.getuid(), 0); assert.ok(existsSync('/.dockerenv'));
  for (const [name, entries] of Object.entries(networkInterfaces())) {assert.equal(name, 'lo'); assert.ok(entries.every(entry => entry.internal));}
  assert.equal((await statfs('/var/lib/postgresql')).type, 0x01021994, 'Fresh PostgreSQL data must be on the explicit tmpfs.');
  stage = 'bootstrap.pinned-source';
  inputPins = JSON.parse(await readFile('/fixture/source-pins.json', 'utf8'));
  assert.equal(Object.keys(inputPins).length, 9);
  for (const [name, pin] of Object.entries(SQL_PINS)) assert.equal(inputPins['/fixture/sql/' + name], pin);
  assert.equal(inputPins['/sql-test/read-admission-facts.mjs'], '756d25ae2ce00c9a02a6295a5d00812732a04b01ace82c347f68e58a902d0456');
  assert.match(inputPins['/fixture/harness.mjs'], /^[0-9a-f]{64}$/);
  for (const [path, pin] of Object.entries(inputPins)) {
    const info = await lstat(path); assert.ok(info.isFile() && info.uid === 0 && info.nlink === 1 && !(info.mode & 0o022)); assert.equal(hash(await readFile(path)), pin);
  }
  ({matchDriverReadPolicy, DriverReadFactsError} = await import('/sql-test/read-admission-facts.mjs'));
  const user = (await readFile('/etc/passwd', 'utf8')).split('\n').find(line => line.startsWith('postgres:'))?.split(':'); assert.ok(user);
  pgUser = {uid: Number(user[2]), gid: Number(user[3])}; assert.ok(pgUser.uid > 0 && pgUser.gid > 0);
  stage = 'bootstrap.fresh-cluster';
  assert.equal(existsSync(ROOT), false); await mkdir(ROOT, {mode: 0o700}); await chown(ROOT, pgUser.uid, pgUser.gid);
  await mkdir(ROOT + '/socket', {mode: 0o700}); await chown(ROOT + '/socket', pgUser.uid, pgUser.gid);
  assert.match((await pgCommand('postgres', ['--version'])).stdout, /^postgres \(PostgreSQL\) 18\.6(?:\s|$)/u);
  await pgCommand('initdb', ['-D', ROOT + '/data', '--username=synthetic_admin', '--auth-local=trust', '--auth-host=reject', '--encoding=UTF8', '--locale=C'], 30000);
  await writeFile(ROOT + '/data/pg_hba.conf', 'local all all trust\nhost all all 0.0.0.0/0 reject\nhost all all ::0/0 reject\n', {mode: 0o600});
  await chown(ROOT + '/data/pg_hba.conf', pgUser.uid, pgUser.gid); await chmod(ROOT + '/data/pg_hba.conf', 0o600);
  await pgCommand('pg_ctl', ['-D', ROOT + '/data', '-l', ROOT + '/server.log', '-o', '-k ' + ROOT + '/socket -p ' + PORT +
    " -c listen_addresses='' -c unix_socket_permissions=0700 -c timezone=UTC -c log_statement=none -c log_min_error_statement=panic -c max_prepared_transactions=0", '-w', 'start']); started = true;
  const bootstrapAdmin = await connect('synthetic_admin', 'postgres');
  await bootstrapAdmin.query(`CREATE ROLE driver_measurements_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE driver_measurements_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_driver_guard_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_driver_guard_control LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_driver_guard_exec LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await bootstrapAdmin.query('CREATE DATABASE sim_driver_measurements OWNER driver_measurements_migrator'); await end(bootstrapAdmin);
  admin = await connect('synthetic_admin'); control = await connect('sim_driver_guard_control'); runtime = await connect('driver_measurements_runtime');
  const actual = (await admin.query("SELECT current_setting('data_directory') AS directory,current_setting('listen_addresses') AS listen,inet_server_addr() AS address")).rows[0];
  assert.equal(actual.directory, ROOT + '/data'); assert.equal(actual.listen, ''); assert.equal(actual.address, null);
  stage = 'bootstrap.actual-001-through-006';
  await admin.query('SET ROLE driver_measurements_migrator');
  for (const name of ['schema.sql', '002_account_erasure.sql']) await admin.query(await readFile('/fixture/sql/' + name, 'utf8'));
  await admin.query('RESET ROLE; CREATE SCHEMA sim_driver_guard_source AUTHORIZATION sim_driver_guard_owner; GRANT sim_driver_guard_exec TO sim_driver_guard_owner');
  for (const name of ['003_guarded_operations.sql', '004_read_admission_facts.sql']) await admin.query(await readFile('/fixture/sql/' + name, 'utf8'));
  await admin.query('INSERT INTO sim_driver_guard_source.store_binding VALUES(true,$1)', [IDS.store]);
  for (const name of ['005_root_checkpoint.sql', '006_inventory_candidates.sql']) await admin.query(await readFile('/fixture/sql/' + name, 'utf8'));
  // Explicit synthetic DBA seed, NOT a Root-signed checkpoint or admission.
  await admin.query("UPDATE public.driver_account_erasure_state SET replay_ready=true,replay_checkpoint_hash=$1,proof_valid_until=clock_timestamp()+interval '10 minutes',retention_reviewed=true,report_protection='no_report',publication_fence_verified=true WHERE singleton", [H.checkpoint]);
  await insertReceipt(IDS.a, H.a); await insertReceipt(IDS.b, H.b);
  await insertEta(admin, IDS.a, H.a, IDS.aObservation); await insertEta(admin, IDS.b, H.a, IDS.badObservation);
  for (const [batch, label] of [[IDS.a, 'A'], [IDS.b, 'B']]) await admin.query(`INSERT INTO public.driver_measurement_intervals
    (owner,batch_id,measurement_key,dataset,edge_id,window_start,speed_kph,distance_m,elapsed_seconds)
    VALUES('cop',$1,$2,'synthetic-graph','8',date_trunc('hour',now()),36,50,5)`, [batch, hash('synthetic interval ' + label)]);
  await admin.query("INSERT INTO public.driver_measurement_revocations VALUES('cop',$1,now()+interval '1 day')", [H.unrelated]);
  await admin.query("INSERT INTO public.driver_account_erasure_revocations(owner,contributor_hash) VALUES('cop',$1)", [H.unrelated]);
  await admin.query('INSERT INTO public.driver_account_erasure_operations(operation_hash,actor_hash,request_hash,contributor_count) VALUES($1,$2,$3,9)', [H.operation, hash('synthetic actor'), H.request]);
  // Later fixture-only parent seeds must still honor the unchanged SQL receipt
  // guard. These GUCs are NOT treated as Root authority by this SQL-only suite.
  await admin.query("SELECT set_config('sim.driver_erasure_context','driver-account-erasure-v1',false),set_config('sim.driver_erasure_checkpoint',$1,false)", [H.checkpoint]);
  oldFacts = await facts(); assert.equal(oldFacts.schema.ready, true); assert.equal(oldFacts.privileges.runtimeProfileMatches, true);
}
async function check(name, work) {stage = 'case.' + name; await work(); events.push({name, passed: true});}
async function cases() {
  const migration = await readFile('/fixture/sql/007_eta_contributor_binding.sql', 'utf8');
  await check(GROUPS[0], async () => {
    const before = {schema: await schema(), data: await data(), authority: await authority()};
    assert.equal(before.data.receipts.length, 2); assert.equal(before.data.eta.length, 2);
    assert.equal(before.data.eta.find(row => row.batch_id === IDS.b).contributor_hash, H.a);
    await denied(() => admin.query(migration), '23514', 'eta_parent_contributor_mismatch');
    await admin.query('ROLLBACK');
    assert.deepEqual(await schema(), before.schema); assert.deepEqual(await data(), before.data); assert.deepEqual(await authority(), before.authority);
    assert.equal((await facts()).schema.fingerprint, oldFacts.schema.fingerprint);
  });
  await check(GROUPS[1], async () => {
    // The ONLY synthetic remediation: fixture admin removes precisely its bad
    // ETA. This is test setup, not migration repair or a production procedure.
    const removed = await admin.query('DELETE FROM public.driver_measurement_eta WHERE owner=\'cop\' AND batch_id=$1 AND observation_id=$2 AND contributor_hash=$3', [IDS.b, IDS.badObservation, H.a]);
    assert.equal(removed.rowCount, 1);
    const beforeData = await data(), beforeAuthority = await authority();
    await admin.query(migration);
    assert.deepEqual(await data(), beforeData); assert.deepEqual(await authority(), beforeAuthority);
    assert.equal(await value(admin, "SELECT count(*)::int AS value FROM pg_constraint WHERE contype='f' AND convalidated AND NOT condeferrable AND NOT condeferred AND confdeltype='c' AND confrelid='public.driver_measurement_receipts'::regclass AND conrelid IN ('public.driver_measurement_intervals'::regclass,'public.driver_measurement_eta'::regclass)"), 2);
    const constraints = (await admin.query("SELECT conname,contype,conkey,confkey,convalidated,condeferrable,condeferred FROM pg_constraint WHERE conname IN ('driver_receipt_contributor_binding_key','driver_eta_contributor_binding_fkey') ORDER BY conname")).rows;
    assert.equal(constraints.length, 2);
    assert.deepEqual(constraints[0].conkey, [1,2,4]); assert.deepEqual(constraints[0].confkey, [1,2,3]);
    assert.deepEqual(constraints[1].conkey, [1,2,3]);
    assert.ok(constraints.every(row => row.convalidated && !row.condeferrable && !row.condeferred));
    newFacts = await facts();
  });
  await check(GROUPS[2], async () => {
    const before = await data();
    await denied(() => insertEta(runtime, IDS.b, H.a), '23503');
    // Runtime intentionally has no ETA UPDATE grant. Exercise the actual FK's
    // UPDATE path as the existing migration owner, without granting new rights.
    await admin.query('SET ROLE driver_measurements_migrator');
    try {await denied(() => admin.query('UPDATE public.driver_measurement_eta SET contributor_hash=$1 WHERE owner=\'cop\' AND batch_id=$2', [H.b, IDS.a]), '23503');}
    finally {await admin.query('RESET ROLE');}
    assert.deepEqual(await data(), before);
    await insertEta(runtime, IDS.b, H.b, IDS.bObservation);
    assert.equal(await value(admin, 'SELECT contributor_hash::text AS value FROM public.driver_measurement_eta WHERE batch_id=$1', [IDS.b]), H.b);
    await denied(() => runtime.query('UPDATE public.driver_measurement_eta SET contributor_hash=$1 WHERE batch_id=$2', [H.a, IDS.b]), '42501');
  });
  await check(GROUPS[3], async () => {
    const before = await data(), bReceipt = before.receipts.find(row => row.batch_id === IDS.b), bEta = before.eta.find(row => row.batch_id === IDS.b);
    const result = await admin.query('DELETE FROM public.driver_measurement_receipts WHERE owner=\'cop\' AND batch_id=$1', [IDS.a]); assert.equal(result.rowCount, 1);
    const after = await data();
    assert.equal(after.eta.some(row => row.batch_id === IDS.a), false); assert.equal(after.intervals.some(row => row.batch_id === IDS.a), false);
    assert.deepEqual(after.receipts.find(row => row.batch_id === IDS.b), bReceipt); assert.deepEqual(after.eta.find(row => row.batch_id === IDS.b), bEta);
    for (const key of ['temporary','state','ledger','permanent','origins','store']) assert.deepEqual(after[key], before[key]);
  });
  await check(GROUPS[4], async () => {
    // Delete first: a late FK lookup waits on the actual deleting transaction;
    // after COMMIT it rejects 23503, leaving no ETA under the removed parent.
    const first = randomUUID(); await insertReceipt(first, H.a);
    const deleter = await connect('synthetic_admin'), late = await connect('driver_measurements_runtime'); let pending;
    try {
      const deletePid = await value(deleter, 'SELECT pg_backend_pid() AS value'), latePid = await value(late, 'SELECT pg_backend_pid() AS value');
      await deleter.query('BEGIN'); await deleter.query('DELETE FROM public.driver_measurement_receipts WHERE batch_id=$1', [first]);
      pending = insertEta(late, first, H.a).then(() => ({ok: true}), error => ({ok: false, code: error.code}));
      await blocked(latePid, deletePid); await deleter.query('COMMIT'); assert.deepEqual(await pending, {ok: false, code: '23503'});
    } finally {await deleter.query('ROLLBACK'); if (pending) await pending; await end(late); await end(deleter);}
    assert.equal(await value(admin, 'SELECT count(*)::int AS value FROM public.driver_measurement_eta WHERE batch_id=$1', [first]), 0);
    // Insert first: FK KEY SHARE holds the parent; DELETE waits, then cascades
    // the actually committed ETA before its own COMMIT can complete.
    const second = randomUUID(); await insertReceipt(second, H.a);
    const inserter = await connect('driver_measurements_runtime'), remover = await connect('synthetic_admin'); let deleting;
    try {
      const insertPid = await value(inserter, 'SELECT pg_backend_pid() AS value'), removePid = await value(remover, 'SELECT pg_backend_pid() AS value');
      await inserter.query('BEGIN'); await insertEta(inserter, second, H.a); await remover.query('BEGIN');
      deleting = remover.query('DELETE FROM public.driver_measurement_receipts WHERE batch_id=$1', [second]).then(row => ({ok: true, count: row.rowCount}), error => ({ok: false, code: error.code}));
      await blocked(removePid, insertPid); await inserter.query('COMMIT'); assert.deepEqual(await deleting, {ok: true, count: 1}); await remover.query('COMMIT');
    } finally {await inserter.query('ROLLBACK'); if (deleting) await deleting; await end(remover); await end(inserter);}
    assert.equal(await value(admin, 'SELECT count(*)::int AS value FROM public.driver_measurement_eta WHERE batch_id=$1', [second]), 0);
    assert.equal(await value(admin, 'SELECT count(*)::int AS value FROM public.driver_measurement_receipts WHERE batch_id=$1', [second]), 0);
    assert.equal(await value(admin, 'SELECT count(*)::int AS value FROM public.driver_measurement_eta WHERE batch_id=$1 AND contributor_hash=$2', [IDS.b, H.b]), 1);
  });
  await check(GROUPS[5], async () => {
    const fresh = await facts();
    assert.equal(fresh.schema.ready, true); assert.equal(fresh.privileges.runtimeProfileMatches, true);
    assert.notEqual(fresh.schema.fingerprint, oldFacts.schema.fingerprint); assert.equal(fresh.schema.fingerprint, newFacts.schema.fingerprint);
    assert.equal(fresh.privileges.fingerprint, oldFacts.privileges.fingerprint);
    assert.equal(fresh.storeIncarnation, IDS.store); assert.equal(fresh.state.checkpointHash, H.checkpoint);
    for (const key of ['replayReady','proofCurrent','retentionReviewed','publicationFenceVerified']) assert.equal(fresh.state[key], true);
    assert.equal(fresh.state.reportProtection, 'no_report');
    const now = Date.now(); assert.ok(Date.parse(fresh.observedAtUTC) <= now && now - Date.parse(fresh.observedAtUTC) <= 5000);
    assert.ok(Date.parse(fresh.state.proofValidUntilUTC) > now);
    const oldPins = Object.freeze({storeIncarnation: IDS.store, checkpointHash: H.checkpoint, schemaFingerprint: oldFacts.schema.fingerprint,
      privilegeFingerprint: oldFacts.privileges.fingerprint, reportProtection: 'no_report'});
    assert.throws(() => matchDriverReadPolicy(fresh, request, oldPins, now), error => error instanceof DriverReadFactsError);
    // No positive call with DB-derived replacement pins: independent Root policy
    // approval is outside this fixture and remains explicitly required.
  });
}
let result, failure;
try {
  await bootstrap(); await cases(); assert.deepEqual(events.map(row => row.name), GROUPS); assert.equal(events.length, 6); assert.equal(providerCalls, 0);
  for (const [path, pin] of Object.entries(inputPins)) assert.equal(hash(await readFile(path)), pin);
  result = {contractVersion: 'sim-driver-eta-binding-sql-test-v1', passed: events.length, cases: events, startedAt, completedAt: new Date().toISOString(),
    postgres: '18.6', actualSql: true, syntheticDataOnly: true, transport: 'fresh-private-unix-socket-no-tcp',
    schemaChange: {beforeFingerprint: oldFacts.schema.fingerprint, afterFingerprint: newFacts.schema.fingerprint,
      privilegeFingerprintUnchanged: oldFacts.privileges.fingerprint === newFacts.privileges.fingerprint, requiresIndependentRootPolicyReview: true},
    concurrency: {actualFkBlockingObserved: true, deleteFirstAndInsertFirst: true, noEtaAfterParentCommit: true},
    rootAuthorityVerified: false, rootSignaturesVerified: false, nativeTransport: false, realAccounts: false,
    providerCalls, productionChanged: false, restoreAccepted: false, deploymentAccepted: false, wholeAccountComplete: false};
} catch (error) {failure = error;}
finally {
  for (const client of [...clients]) {try {await end(client);} catch {cleanupComplete = false; await client.end().catch(() => {});}}
  if (started) await pgCommand('pg_ctl', ['-D', ROOT + '/data', '-m', 'immediate', '-w', 'stop']).catch(() => {cleanupComplete = false;});
  clearTimeout(deadline); globalThis.fetch = originalFetch;
}
if (!cleanupComplete && !failure) failure = new Error('FIXTURE_CLEANUP_INCOMPLETE');
if (failure) {
  const site = typeof failure.stack === 'string' ? /\/fixture\/harness\.mjs:([0-9]{1,6}):([0-9]{1,4})\b/.exec(failure.stack) : null;
  const code = typeof failure.code === 'string' && /^(?:[0-9A-Z]{5}|ERR_[A-Z0-9_]+)$/.test(failure.code) ? failure.code : null;
  console.log(JSON.stringify({contractVersion: 'sim-driver-eta-binding-sql-test-v1', passed: false, stage, failure: 'FIXTURE_ASSERTION_FAILED',
    failureSite: site ? 'harness.mjs:' + site[1] + ':' + site[2] : null, failureCode: code, cleanupComplete}));
} else {result.cleanup = {clusterStopped: true, connectionsClosed: true}; console.log(JSON.stringify(result));}
process.exit(failure ? 1 : 0);
