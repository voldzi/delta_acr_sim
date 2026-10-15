/**
 * SOURCE-ONLY guarded SQL mechanics over the unchanged actual Driver schema.
 * The sole --run target is a freshly created, privately owned PostgreSQL 18.3
 * cluster on a Unix socket. No external URL, credentials, TCP, provider, native
 * producer, production role or accepted Root/publication authority is supplied.
 *
 * This is new evidence. It neither reruns nor overwrites the frozen earlier
 * eleven-case expiry harness/SQL/receipt or any COP acceptance evidence.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== "--run") {
  console.error("Only --run is accepted; target is a new owned synthetic Unix-only PostgreSQL 18.3 cluster.");
  process.exit(2);
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const selfPath = resolve(fileURLToPath(import.meta.url));
const initialSelfHash = createHash("sha256").update(await readFile(selfPath)).digest("hex");
const reportPath = join(repo, "docs/archive/2026-10-15_DRIVER_GUARDED_OPERATIONS_SQL.json");
assert.ok(!existsSync(reportPath), "A source evidence receipt must not be overwritten.");
const inputs: Record<string, string> = {
  "deploy/driver-measurements/schema.sql": "6dd60a3acf28d63575198c8526c368df19bbd543f4063d4985fb55f308da02d0",
  "deploy/driver-measurements/002_account_erasure.sql": "f13db2106a1fe1a02d0d1a26afa8ad7d7c045172ba4419749719ed0f166e16ad",
  // Fully read new sources; the main agent independently reviews before --run.
  "deploy/driver-measurements/003_guarded_operations.sql": "e3513a983a3b6d1bd52d46851c734dd1c3b208e2e2f6430a6f9eddd38b10d3b5",
  "deploy/driver-measurements/guarded-runtime-verification.sql": "3ef5ad53b2e4f94d143636e7bf2e26108fd10d3d34c2a0521ca4760d95ca88a2",
};
const frozenInputs: Record<string, string> = {
  "scripts/test-driver-expiry-real-schema.mts": "61ff2bfe5b3510fa0c8d4a2be61bc8cea83fb798695d35713b0681634f5e2b6f",
  "scripts/fixtures/driver-retention-real-schema/expiry-source.sql": "1561825849c8990526af26eae3866ee2100072db72bed638997a2eec7a8afb7a",
  "docs/archive/2026-10-14_DRIVER_EXPIRY_REAL_SCHEMA.json": "8dac0d99b4add01446b05e8fdc6cd752f5d754328754fc46fe5848b954841396",
};
const sourceText: Record<string, string> = {};
for (const [path, pin] of Object.entries({ ...inputs, ...frozenInputs })) {
  assert.match(pin, /^[a-f0-9]{64}$/u, `Source is not reviewed/pinned: ${path}`);
  const bytes = await readFile(join(repo, path));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin, `Unreviewed source: ${path}`);
  sourceText[path] = bytes.toString("utf8");
}
const pgBin = "/opt/homebrew/opt/postgresql@18/bin";
const execute = promisify(execFile);
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"].includes(key)));
for (const key of Object.keys(process.env)) if (/^PG|DATABASE_URL$|OPENAI|API_KEY|SECRET|TOKEN/u.test(key)) delete process.env[key];
assert.match((await execute(join(pgBin, "postgres"), ["--version"], { env: cleanEnv })).stdout,
  /^postgres \(PostgreSQL\) 18\.3(?:\s|$)/u);
const require = createRequire(join(repo, "apps/situation-data-api/package.json"));
const { Pool } = require("pg");
const tmp = realpathSync("/private/tmp");
assert.equal(tmp, "/private/tmp");
const previousUmask = process.umask(0o077);
const root = await mkdtemp(join(tmp, "sim-driver-guarded-pg-"));
await chmod(root, 0o700);
await mkdir(join(root, "socket"), { mode: 0o700 });
const owned = () => {
  assert.equal(dirname(realpathSync(root)), tmp);
  assert.ok(realpathSync(root).startsWith(join(tmp, "sim-driver-guarded-pg-")));
  for (const path of [root, join(root, "socket")]) {
    assert.equal(statSync(path).uid, process.getuid!());
    assert.equal(statSync(path).mode & 0o777, 0o700);
  }
};
owned();
const pools: any[] = [], activeClients = new Set<any>();
const pool = (user: string, database = "sim_driver_measurements") => {
  const p = new Pool({ host: join(root, "socket"), database, user, port: 5432,
    max: 4, connectionTimeoutMillis: 2000, statement_timeout: 6000 });
  pools.push(p); return p;
};
const events: Array<{ case: string; passed: boolean }> = [];
const startedAt = new Date().toISOString();
let started = false, success = false, providerCalls = 0;
let admin: any, control: any, executor: any, runtime: any;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { providerCalls++; throw new Error("Provider/network access is forbidden in this source test."); };
const store = "00000000-0000-4000-8000-000000000011";
const permit = "20000000-0000-4000-8000-000000000011";
const schemaDigest = inputs["deploy/driver-measurements/003_guarded_operations.sql"]!;
const contractVersion = "sim-driver-guarded-db-v1";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const actorHash = hash("synthetic guarded actor"), requestHash = hash("synthetic immutable erasure request");
const operationHash = hash("synthetic immutable erasure operation"), checkpointHash = hash("synthetic fixture checkpoint, not Root proof");
const other = hash("unrelated synthetic contributor");
const batches = ["30000000-0000-4000-8000-000000000011", "30000000-0000-4000-8000-000000000012",
  "30000000-0000-4000-8000-000000000013", "30000000-0000-4000-8000-000000000014"];
type Body = Record<string, unknown>;
type Origin = { client: any; descriptor: { xid: string; pid: number; start: string } };
let cutoff: string, contributors: Array<{ contributorDay: string; contributorHash: string }>, contributor: string;
const value = async (p: any, sql: string, parameters: unknown[] = []) => (await p.query(sql, parameters)).rows[0].value;
const bodyDigest = (body: Body) => value(admin,
  "SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') AS value", [JSON.stringify(body)]);
// Only this owned test controller/admin computes the PostgreSQL jsonb digest.
// JSON.stringify is transport here, never the digest canonicalization rule.
const register = async (kind: string, body: Body, op = randomUUID(), incarnation = store,
  at: string | null = kind === "expire" ? cutoff : null) => {
  const digest = await bodyDigest(body);
  const result = await value(control, "SELECT sim_driver_guard_source.register_origin($1,$2,$3,$4,$5,$6,$7) AS value",
    [op, incarnation, permit, kind, digest, schemaDigest, at]);
  assert.equal(result.operationId, op);
  assert.equal(result.provisionalInCallerTransaction, true);
  assert.equal(result.requiresControlCommitAndFreshReadback, true);
  return op;
};
const origin = async (): Promise<Origin> => {
  const client = await executor.connect(); activeClients.add(client); await client.query("BEGIN");
  const descriptor = (await client.query(`SELECT pg_current_xact_id()::text AS xid,pg_backend_pid() AS pid,
    backend_start::text AS start FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
  return { client, descriptor };
};
const claim = (op: string, o: Origin) => value(control,
  "SELECT sim_driver_guard_source.claim_origin($1,$2,$3::xid8,$4,$5) AS value",
  [op, store, o.descriptor.xid, o.descriptor.pid, o.descriptor.start]);
const executeOrigin = (client: any, op: string, body: Body) => value(client,
  "SELECT sim_driver_guard_source.execute_origin($1,$2::jsonb) AS value", [op, JSON.stringify(body)]);
const resolveOrigin = (op: string, p: any = control) => value(p,
  "SELECT sim_driver_guard_source.resolve_or_seal($1) AS value", [op]);
const readPublicationContext = (op: string, body: Body, p: any = control) => value(p,
  "SELECT sim_driver_guard_source.read_publication_context($1,$2::jsonb) AS value", [op, JSON.stringify(body)]);
const fixturePublicationContext = async (eraseOrigin: string, body: Body): Promise<Body> => {
  const readback = await readPublicationContext(eraseOrigin, body);
  assert.deepEqual(Object.keys(readback).sort(), ["storeIncarnation", "payloadDigest", "erasureOperationDigest",
    "databaseZeroVerified", "remainingBatchCount", "exactFenceCount", "readbackAt"].sort());
  assert.equal(readback.storeIncarnation, store);
  assert.equal(readback.payloadDigest, await bodyDigest(body));
  assert.equal(readback.databaseZeroVerified, true); assert.equal(readback.remainingBatchCount, 0);
  assert.equal(readback.exactFenceCount, new Set(contributors.map(row => row.contributorHash)).size);
  return { contractVersion: "cop-driver-publication-context-v1", recordId: randomUUID(),
    recordDigest: hash("synthetic publication record, NOT a signed Root record"), storeIncarnation: readback.storeIncarnation,
    operationDigest: readback.erasureOperationDigest, readbackDigest: await bodyDigest(readback),
    reportProtection: "no_report", observedAtUTC: readback.readbackAt };
};
const release = async (client: any) => {
  await client.query("ROLLBACK").catch(() => undefined); client.release(); activeClients.delete(client);
};
const beginRuntime = async () => {
  const client = await runtime.connect(); activeClients.add(client); await client.query("BEGIN");
  return client;
};
const denied = async (fn: () => Promise<unknown>, expected: string) => {
  try { await fn(); assert.fail("Expected fixed SQL rejection"); }
  catch (error: any) { if (error.code === "ERR_ASSERTION") throw error; assert.equal(error.code, expected); }
};
const rejectedSource = (fn: () => Promise<unknown>, expected = "P0001") => denied(fn, expected);
const erasureBody = (changes: Body = {}): Body => ({ contractVersion, operationHash, actorHash, requestHash,
  contributors, checkpointHash, ...changes });
// Expiry has no caller-supplied cutoff in its transient body: the separately
// registered immutable origin is the sole cutoff selector.
const expireBody = (): Body => ({ contractVersion });
const revokeBody = (): Body => ({ contractVersion, contributorHash: contributor });
const effectCounts = () => value(admin, `SELECT jsonb_build_object(
  'receipts',(SELECT count(*) FROM driver_measurement_receipts),
  'intervals',(SELECT count(*) FROM driver_measurement_intervals),
  'eta',(SELECT count(*) FROM driver_measurement_eta),
  'temporaryRevocations',(SELECT count(*) FROM driver_measurement_revocations),
  'operations',(SELECT count(*) FROM driver_account_erasure_operations),
  'permanentRevocations',(SELECT count(*) FROM driver_account_erasure_revocations)) AS value`);
const ledger = () => value(admin,
  "SELECT to_jsonb(t) AS value FROM driver_account_erasure_operations t WHERE operation_hash=$1", [operationHash]);
const immutableSnapshot = () => value(admin, `SELECT jsonb_build_object(
  'tables',(SELECT jsonb_agg(jsonb_build_object('name',tablename,'owner',tableowner) ORDER BY tablename)
    FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'driver_%'),
  'guard',(SELECT pg_get_functiondef('public.driver_account_erasure_receipt_guard()'::regprocedure)),
  'trigger',(SELECT pg_get_triggerdef(oid)||':'||tgenabled::text FROM pg_trigger
    WHERE tgname='driver_account_erasure_receipt_guard' AND NOT tgisinternal),
  'cascades',(SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY conrelid::regclass::text) FROM pg_constraint
    WHERE contype='f' AND confrelid='public.driver_measurement_receipts'::regclass)) AS value`);
let schemaBefore: unknown;
const verifyCatalog = async (expected = true) => {
  const result = await admin.query(sourceText["deploy/driver-measurements/guarded-runtime-verification.sql"]);
  const statements = Array.isArray(result) ? result : [result];
  const rows = statements.flatMap((statement: any) => statement.rows ?? []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].guarded_runtime_privileges_match, expected);
};
const verifyCatalogInsideFixtureTransaction = async (client: any, expected: boolean) => {
  // The exact pinned catalog SELECT also runs inside this owned rollback-only
  // ACL fixture. Its normal BEGIN READ ONLY/ROLLBACK wrapper cannot nest here;
  // keep the pinned SET LOCAL and catalog body unchanged, then caller ROLLBACK.
  const source = sourceText["deploy/driver-measurements/guarded-runtime-verification.sql"]!;
  const begin = "BEGIN READ ONLY;", end = "ROLLBACK;";
  assert.equal(source.split(begin).length, 2); assert.equal(source.split(end).length, 2);
  assert.ok(source.trimEnd().endsWith(end));
  const body = source.slice(source.indexOf(begin) + begin.length, source.lastIndexOf(end));
  const result = await client.query(body), statements = Array.isArray(result) ? result : [result];
  const rows = statements.flatMap((statement: any) => statement.rows ?? []);
  assert.equal(rows.length, 1); assert.equal(rows[0].guarded_runtime_privileges_match, expected);
};
const assertNoUnrelatedLoss = async () => {
  const rows = (await admin.query("SELECT batch_id::text FROM driver_measurement_receipts WHERE contributor_hash=$1 ORDER BY batch_id", [other])).rows;
  assert.deepEqual(rows.map((row: any) => row.batch_id), batches.slice(2));
};
const insertRuntimeReceipt = (client: any, batch: string, target: string) => client.query(`
  INSERT INTO driver_measurement_receipts(owner,batch_id,contributor_hash,request_hash,received_at,expires_at,receipt)
  VALUES('cop',$1,$2,$3,now(),now()+interval '7 days','{}')`, [batch, target, hash("synthetic new intake")]);
const waitForDatabaseLock = async (pid: number, allowedEvents = ["advisory"]) => {
  const until = Date.now() + 2500;
  while (Date.now() < until) {
    const row = (await admin.query("SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
    if (row?.wait_event_type === "Lock" && allowedEvents.includes(row.wait_event)) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
  }
  assert.fail("Expected an actual PostgreSQL lock wait, not a timeout-derived outcome.");
};
const seed = async () => {
  cutoff = await value(admin, "SELECT date_trunc('second',clock_timestamp())::text AS value");
  const anchor = new Date(cutoff), day = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  const toleratedDay = new Date(anchor.getTime() + 30_000).toISOString().slice(0, 10);
  contributors = Array.from({ length: 9 }, (_, index) => {
    const contributorDay = new Date(day + (index - 8) * 86_400_000).toISOString().slice(0, 10);
    return { contributorDay, contributorHash: hash(`synthetic guarded day ${contributorDay}`) };
  });
  if (toleratedDay !== contributors[8]!.contributorDay)
    contributors.push({ contributorDay: toleratedDay, contributorHash: hash(`synthetic guarded day ${toleratedDay}`) });
  contributor = contributors[8]!.contributorHash;
  await admin.query(`TRUNCATE driver_measurement_receipts,driver_measurement_intervals,driver_measurement_eta,
    driver_measurement_revocations,driver_account_erasure_operations,driver_account_erasure_revocations`);
  // Positive DB metadata is owned synthetic fixture input only. It neither
  // supplies a Root publication context nor makes the actual authority ready.
  await admin.query(`UPDATE driver_account_erasure_state SET replay_ready=true,replay_checkpoint_hash=$1,
    proof_valid_until=now()+interval '1 hour',retention_reviewed=true,
    report_protection='no_report',publication_fence_verified=true WHERE singleton`, [checkpointHash]);
  await admin.query("INSERT INTO sim_driver_guard_source.store_binding VALUES(true,$1) ON CONFLICT(singleton) DO NOTHING", [store]);
  await admin.query(`INSERT INTO driver_measurement_receipts(owner,batch_id,contributor_hash,request_hash,received_at,expires_at,receipt)
    VALUES('cop',$1,$5,$7,$8::timestamptz-interval '2 days',$8::timestamptz-interval '1 second','{}'),
    ('cop',$2,$5,$7,$8::timestamptz-interval '2 days',$8::timestamptz+interval '1 day','{}'),
    ('cop',$3,$6,$7,$8::timestamptz-interval '2 days',$8::timestamptz,'{}'),
    ('cop',$4,$6,$7,$8::timestamptz-interval '2 days',$8::timestamptz+interval '1 day','{}')`,
    [...batches, contributor, other, hash("synthetic receipt request"), cutoff]);
  await admin.query(`INSERT INTO driver_measurement_intervals(owner,batch_id,measurement_key,dataset,edge_id,window_start,speed_kph,distance_m,elapsed_seconds)
    SELECT owner,batch_id,md5(batch_id::text)||md5(batch_id::text),
      CASE WHEN batch_id::text IN ($1,$2) THEN 'historical-graph' ELSE 'current-graph' END,
      '8',received_at,36,50,5 FROM driver_measurement_receipts`, batches.slice(0, 2));
  await admin.query(`INSERT INTO driver_measurement_eta(owner,batch_id,observation_id,contributor_hash,dataset,window_start,predicted_seconds,actual_seconds)
    SELECT owner,batch_id,batch_id,contributor_hash,'historical-graph',received_at,100,120 FROM driver_measurement_receipts`);
  await admin.query("INSERT INTO driver_measurement_revocations VALUES('cop',$1,$3::timestamptz-interval '1 second'),('cop',$2,$3::timestamptz+interval '1 day')", [contributor, other, cutoff]);
};
const check = async (name: string, fn: () => Promise<void>) => {
  await seed();
  try { await fn(); events.push({ case: name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { events.push({ case: name, passed: false }); throw error; }
  finally { for (const client of [...activeClients]) await release(client); }
  assert.deepEqual(await immutableSnapshot(), schemaBefore);
  await verifyCatalog();
};
try {
  await execute(join(pgBin, "initdb"), ["-D", join(root, "data"), "--username=synthetic_admin",
    "--auth-local=trust", "--auth-host=reject", "--encoding=UTF8", "--locale=C"], { env: cleanEnv, timeout: 30000 });
  await execute(join(pgBin, "pg_ctl"), ["-D", join(root, "data"), "-l", join(root, "server.log"), "-o",
    `-k ${join(root, "socket")} -c listen_addresses='' -c unix_socket_permissions=0700 -c log_statement=none -c log_min_error_statement=panic -c max_prepared_transactions=0`,
    "-w", "start"], { env: cleanEnv, timeout: 15000 }); started = true;
  const bootstrap = pool("synthetic_admin", "postgres");
  const identity = (await bootstrap.query("SELECT current_setting('data_directory') AS directory,current_setting('listen_addresses') AS listen")).rows[0];
  assert.equal(identity.directory, join(root, "data")); assert.equal(identity.listen, "");
  await bootstrap.query(`CREATE ROLE driver_measurements_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE driver_measurements_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_driver_guard_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_driver_guard_control LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_driver_guard_exec LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await bootstrap.query("CREATE DATABASE sim_driver_measurements OWNER driver_measurements_migrator");
  admin = pool("synthetic_admin"); control = pool("sim_driver_guard_control");
  executor = pool("sim_driver_guard_exec"); runtime = pool("driver_measurements_runtime");
  await admin.query("SET ROLE driver_measurements_migrator");
  await admin.query(sourceText["deploy/driver-measurements/schema.sql"]);
  await admin.query(sourceText["deploy/driver-measurements/002_account_erasure.sql"]);
  await admin.query("RESET ROLE"); schemaBefore = await immutableSnapshot();
  await admin.query(`CREATE SCHEMA sim_driver_guard_source AUTHORIZATION sim_driver_guard_owner;
    GRANT sim_driver_guard_exec TO sim_driver_guard_owner`);
  await admin.query(sourceText["deploy/driver-measurements/003_guarded_operations.sql"]);
  assert.equal(await value(admin, "SELECT count(*)::int AS value FROM sim_driver_guard_source.store_binding"), 0);
  assert.deepEqual(await immutableSnapshot(), schemaBefore);
  await verifyCatalog();
  for (const p of [control, executor, runtime]) {
    const connection = (await p.query("SELECT current_database() AS db,inet_server_addr() AS tcp")).rows[0];
    assert.equal(connection.db, "sim_driver_measurements"); assert.equal(connection.tcp, null);
  }
  await check("exact scoped runtime roles and independent catalog verification", async () => {
    assert.equal(await value(admin, "SELECT sim_driver_guard_source.runtime_privileges_match() AS value"), true);
    await verifyCatalog();
    for (const p of [runtime, executor]) {
      await denied(() => p.query("SET ROLE sim_driver_guard_owner"), "42501");
      await denied(() => p.query("SET ROLE sim_driver_guard_control"), "42501");
      await denied(() => p.query("UPDATE sim_driver_guard_source.origins SET committed_marker=true"), "42501");
      for (const suffix of ["receipts", "intervals", "eta", "revocations"])
        await denied(() => p.query(`DELETE FROM public.driver_measurement_${suffix}`), "42501");
    }
    for (const table of ["driver_account_erasure_operations", "driver_account_erasure_revocations", "driver_account_erasure_state"])
      await denied(() => runtime.query(`DELETE FROM public.${table}`), "42501");
    await denied(() => runtime.query("CREATE TEMP TABLE forbidden_runtime_temp(id int)"), "42501");
    await denied(() => runtime.query("UPDATE driver_measurement_receipts SET expires_at=now()"), "42501");
    await denied(() => runtime.query("UPDATE driver_measurement_intervals SET speed_kph=40"), "42501");
    await runtime.query("UPDATE driver_measurement_receipts SET receipt=receipt WHERE batch_id=$1", [batches[0]]);
    assert.equal(await value(admin, "SELECT count(*)::int AS value FROM driver_measurement_receipts"), 4);
  });
  await check("unbound store and denied or absent guarded functions are unavailable, not consent revocation", async () => {
    await admin.query("DELETE FROM sim_driver_guard_source.store_binding");
    await rejectedSource(() => register("expire", expireBody()));
    await admin.query("INSERT INTO sim_driver_guard_source.store_binding VALUES(true,$1)", [store]);
    await denied(() => runtime.query("SELECT sim_driver_guard_source.execute_origin($1,$2::jsonb)", [randomUUID(), JSON.stringify(expireBody())]), "42501");
    await admin.query("REVOKE EXECUTE ON FUNCTION sim_driver_guard_source.execute_origin(uuid,jsonb) FROM sim_driver_guard_exec");
    try { await denied(() => executor.query("SELECT sim_driver_guard_source.execute_origin($1,$2::jsonb)", [randomUUID(), JSON.stringify(expireBody())]), "42501"); }
    finally { await admin.query("GRANT EXECUTE ON FUNCTION sim_driver_guard_source.execute_origin(uuid,jsonb) TO sim_driver_guard_exec"); }
    await admin.query("ALTER FUNCTION sim_driver_guard_source.execute_origin(uuid,jsonb) RENAME TO temporarily_unavailable_execute_origin");
    try { await denied(() => executor.query("SELECT sim_driver_guard_source.execute_origin($1,$2::jsonb)", [randomUUID(), JSON.stringify(expireBody())]), "42883"); }
    finally { await admin.query("ALTER FUNCTION sim_driver_guard_source.temporarily_unavailable_execute_origin(uuid,jsonb) RENAME TO execute_origin"); }
    assert.equal((await effectCounts()).receipts, 4);
  });
  await check("diagnostics detect table-level, PUBLIC column and CREATE TEMP privilege drift", async () => {
    await admin.query("GRANT UPDATE ON driver_measurement_receipts TO driver_measurements_runtime");
    try {
      assert.equal(await value(admin, "SELECT sim_driver_guard_source.runtime_privileges_match() AS value"), false);
      await verifyCatalog(false);
    } finally {
      await admin.query("REVOKE UPDATE ON driver_measurement_receipts FROM driver_measurements_runtime; GRANT UPDATE(receipt) ON driver_measurement_receipts TO driver_measurements_runtime");
    }
    await admin.query("GRANT TEMP ON DATABASE sim_driver_measurements TO driver_measurements_runtime");
    try { await verifyCatalog(false); }
    finally { await admin.query("REVOKE TEMP ON DATABASE sim_driver_measurements FROM driver_measurements_runtime"); }
    for (const grant of ["GRANT INSERT(contributor_hash) ON driver_account_erasure_revocations TO PUBLIC",
      "GRANT REFERENCES(batch_id) ON driver_measurement_receipts TO PUBLIC"]) {
      const fixture = await admin.connect(); activeClients.add(fixture); await fixture.query("BEGIN");
      try {
        await fixture.query(grant);
        assert.equal(await value(fixture, "SELECT sim_driver_guard_source.runtime_privileges_match() AS value"), false);
        await verifyCatalogInsideFixtureTransaction(fixture, false);
      } finally { await fixture.query("ROLLBACK"); fixture.release(); activeClients.delete(fixture); }
      await verifyCatalog();
      assert.equal(await value(admin, "SELECT sim_driver_guard_source.runtime_privileges_match() AS value"), true);
    }
  });
  await check("expiry effects and committed marker share the actual original transaction", async () => {
    await admin.query("INSERT INTO driver_account_erasure_revocations(owner,contributor_hash) VALUES('cop',$1)", [hash("unrelated permanent fixture fence")]);
    await admin.query(`INSERT INTO driver_account_erasure_operations(operation_hash,actor_hash,request_hash,contributor_count)
      VALUES($1,$2,$3,9)`, [hash("unrelated retained operation"), hash("unrelated retained actor"), hash("unrelated retained request")]);
    const permanentBefore = await value(admin, `SELECT jsonb_build_object(
      'operations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY operation_hash) FROM driver_account_erasure_operations t),
      'fences',(SELECT jsonb_agg(to_jsonb(t) ORDER BY owner,contributor_hash) FROM driver_account_erasure_revocations t)) AS value`);
    const body = expireBody(), op = await register("expire", body), o = await origin(); await claim(op, o);
    const result = await executeOrigin(o.client, op, body);
    assert.equal(result.kind, "expire"); assert.equal(result.requiresOriginCommitAndFreshReadback, true);
    assert.equal((await resolveOrigin(op)).state, "pending");
    assert.equal((await effectCounts()).receipts, 4);
    await o.client.query("COMMIT");
    assert.equal((await resolveOrigin(op)).state, "origin_commit_known");
    assert.deepEqual(await effectCounts(), { receipts: 2, intervals: 2, eta: 2, temporaryRevocations: 1, operations: 1, permanentRevocations: 1 });
    assert.deepEqual(await value(admin, `SELECT jsonb_build_object(
      'operations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY operation_hash) FROM driver_account_erasure_operations t),
      'fences',(SELECT jsonb_agg(to_jsonb(t) ORDER BY owner,contributor_hash) FROM driver_account_erasure_revocations t)) AS value`), permanentBefore);
  });
  await check("claim cannot be reused after rollback and durable seal rejects late execution", async () => {
    const body = expireBody(), op = await register("expire", body), o = await origin(); await claim(op, o);
    await executeOrigin(o.client, op, body); await o.client.query("ROLLBACK");
    assert.equal((await effectCounts()).receipts, 4);
    await o.client.query("BEGIN");
    await rejectedSource(() => executeOrigin(o.client, op, body)); await o.client.query("ROLLBACK");
    assert.equal((await resolveOrigin(op)).state, "origin_no_effect_closed");
    const op2 = await register("expire", body), o2 = await origin(); await claim(op2, o2);
    const c = await control.connect(); activeClients.add(c); await c.query("BEGIN");
    assert.equal((await resolveOrigin(op2, c)).state, "origin_no_effect_closed");
    await c.query("ROLLBACK");
    await executeOrigin(o2.client, op2, body); await o2.client.query("ROLLBACK");
    assert.equal((await resolveOrigin(op2)).state, "origin_no_effect_closed");
    await o2.client.query("BEGIN"); await rejectedSource(() => executeOrigin(o2.client, op2, body));
  });
  await check("body and origin binding reject free text, unknown keys and digest changes before effects", async () => {
    const good = expireBody();
    for (const bad of [{ ...good, sql: "DELETE FROM anything" }, { contractVersion, cutoff, contributorHash: contributor },
      { ...good, contractVersion: "unreviewed" }, { ...good, cutoff: "invalid" }]) {
      // Distinguish the bound digest mismatch from fixed-function validation:
      // even when the controller registered these exact bytes, extra keys and
      // unsupported contract shapes must remain impossible to execute.
      for (const registeredBody of [good, bad]) {
        const op = await register("expire", registeredBody), o = await origin(); await claim(op, o);
        await rejectedSource(() => executeOrigin(o.client, op, bad), registeredBody === good ? "23505" : "22023"); await release(o.client);
      }
    }
    assert.equal(await bodyDigest(revokeBody()), await bodyDigest({ contributorHash: contributor, contractVersion }));
    const op = await register("expire", good);
    await rejectedSource(() => register("expire", good, op, store, new Date(Date.parse(cutoff) - 1000).toISOString()), "23505");
    await rejectedSource(() => register("revoke", revokeBody(), op), "23505");
    await rejectedSource(() => register("expire", good, randomUUID(), randomUUID()));
    assert.equal((await effectCounts()).receipts, 4);
  });
  await check("revoke waits for real batch and contributor intake locks then removes the just-committed target only", async () => {
    const lateBatch = randomUUID(), writer = await beginRuntime();
    await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`cop:batch:${lateBatch}`]);
    await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`cop:${contributor}`]);
    const body = revokeBody(), op = await register("revoke", body), o = await origin(); await claim(op, o);
    const work = executeOrigin(o.client, op, body); void work.catch(() => undefined);
    await waitForDatabaseLock(o.descriptor.pid);
    await insertRuntimeReceipt(writer, lateBatch, contributor);
    const beforeRelease = await value(admin, "SELECT clock_timestamp()::text AS value");
    await writer.query("COMMIT");
    await work; assert.equal((await resolveOrigin(op)).state, "pending"); await o.client.query("COMMIT");
    assert.equal((await resolveOrigin(op)).state, "origin_commit_known");
    assert.equal(await value(admin, "SELECT count(*)::int AS value FROM driver_measurement_receipts WHERE contributor_hash=$1", [contributor]), 0);
    assert.equal(await value(admin, "SELECT count(*)::int AS value FROM driver_measurement_revocations WHERE contributor_hash=$1 AND expires_at>now()", [contributor]), 1);
    assert.equal(await value(admin, "SELECT expires_at >= $2::timestamptz+interval '7 days' AS value FROM driver_measurement_revocations WHERE owner='cop' AND contributor_hash=$1", [contributor, beforeRelease]), true);
    await assertNoUnrelatedLoss();
  });
  await check("erase preserves acceptedAt and deleted counts on a genuine second origin", async () => {
    const body = erasureBody(), op = await register("erase", body), o = await origin(); await claim(op, o);
    const firstResult = await executeOrigin(o.client, op, body); await o.client.query("COMMIT");
    const first = await ledger();
    assert.equal(Date.parse(firstResult.acceptedAt), Date.parse(first.created_at));
    assert.equal(first.actor_hash.trim(), actorHash); assert.equal(first.request_hash.trim(), requestHash);
    assert.equal(first.contributor_count, contributors.length); assert.equal(first.deleted_batch_count, 2);
    assert.equal(first.remaining_batch_count, 0); assert.equal(first.database_zero_verified, true);
    assert.equal(first.status, "pending"); assert.equal(first.derived_report_acknowledged, false);
    const op2 = await register("erase", body), o2 = await origin(); await claim(op2, o2);
    const repeatResult = await executeOrigin(o2.client, op2, body); await o2.client.query("COMMIT");
    const second = await ledger();
    assert.equal(repeatResult.acceptedAt, firstResult.acceptedAt);
    assert.equal(second.created_at, first.created_at); assert.equal(second.deleted_batch_count, first.deleted_batch_count);
    assert.equal(second.contributor_count, first.contributor_count);
    assert.equal((await effectCounts()).permanentRevocations, contributors.length); await assertNoUnrelatedLoss();
  });
  await check("erase rejects actor/request changes and incomplete coverage without altering the accepted ledger", async () => {
    const body = erasureBody(), op = await register("erase", body), o = await origin(); await claim(op, o);
    await executeOrigin(o.client, op, body); await o.client.query("COMMIT"); const accepted = await ledger();
    const missingRequiredDay = contributors.map((row, index) => index === 0 ? { ...row,
      contributorDay: new Date(Date.parse(`${row.contributorDay}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) } : row);
    for (const [bad, expected] of [
      [erasureBody({ actorHash: hash("other actor") }), "P0002"],
      [erasureBody({ requestHash: hash("altered request") }), "23505"],
      [erasureBody({ contributors: contributors.slice(1) }), "22023"],
      [erasureBody({ contributors: missingRequiredDay }), "22023"],
      [erasureBody({ contributors: [...contributors.slice(0, 8), contributors[0]] }), "22023"],
    ] as Array<[Body, string]>) {
      const changedOp = await register("erase", bad), attempt = await origin(); await claim(changedOp, attempt);
      await rejectedSource(() => executeOrigin(attempt.client, changedOp, bad), expected); await release(attempt.client);
      assert.deepEqual(await ledger(), accepted);
    }
    await assertNoUnrelatedLoss();
  });
  await check("erase rechecks metadata after waiting for contributor locks", async () => {
    const writer = await beginRuntime();
    await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`cop:${contributor}`]);
    const body = erasureBody(), op = await register("erase", body), o = await origin(); await claim(op, o);
    const work = executeOrigin(o.client, op, body); void work.catch(() => undefined);
    await waitForDatabaseLock(o.descriptor.pid);
    await admin.query("UPDATE driver_account_erasure_state SET proof_valid_until=clock_timestamp()-interval '1 second' WHERE singleton");
    await writer.query("ROLLBACK");
    await rejectedSource(() => work); await o.client.query("ROLLBACK");
    assert.equal((await effectCounts()).receipts, 4);
    assert.equal((await effectCounts()).operations, 0);
    assert.equal((await effectCounts()).permanentRevocations, 0);
    assert.equal((await resolveOrigin(op)).state, "origin_no_effect_closed");
  });
  await check("metadata row is share-locked through the same effects and marker transaction", async () => {
    const body = erasureBody(), op = await register("erase", body), o = await origin(); await claim(op, o);
    await executeOrigin(o.client, op, body);
    const metadataWriter = await admin.connect(); activeClients.add(metadataWriter); await metadataWriter.query("BEGIN");
    const pid = (await metadataWriter.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    let settled = false;
    const changing = metadataWriter.query("UPDATE driver_account_erasure_state SET proof_valid_until=clock_timestamp()-interval '1 second' WHERE singleton");
    void changing.then(() => { settled = true; }, () => { settled = true; });
    await waitForDatabaseLock(pid, ["transactionid", "tuple"]);
    assert.equal(settled, false);
    assert.equal((await effectCounts()).receipts, 4, "origin effects must still be uncommitted");
    await o.client.query("COMMIT"); await changing; await metadataWriter.query("COMMIT");
    assert.equal((await resolveOrigin(op)).state, "origin_commit_known");
    assert.equal((await ledger()).deleted_batch_count, 2);
    assert.equal(await value(admin, "SELECT proof_valid_until<clock_timestamp() AS value FROM driver_account_erasure_state WHERE singleton"), true);
    await assertNoUnrelatedLoss();
  });
  await check("permanent erasure fence rejects actual concurrent late intake after origin COMMIT", async () => {
    const body = erasureBody(), op = await register("erase", body), o = await origin(); await claim(op, o);
    await executeOrigin(o.client, op, body);
    const writer = await beginRuntime(), lateBatch = randomUUID();
    const pid = (await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await writer.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`cop:batch:${lateBatch}`]);
    const late = insertRuntimeReceipt(writer, lateBatch, contributor); void late.catch(() => undefined);
    await waitForDatabaseLock(pid); await o.client.query("COMMIT");
    await denied(() => late, "23514"); await writer.query("ROLLBACK");
    assert.equal(await value(admin, "SELECT count(*)::int AS value FROM driver_measurement_receipts WHERE contributor_hash=$1", [contributor]), 0);
    assert.equal((await ledger()).deleted_batch_count, 2); await assertNoUnrelatedLoss();
  });
  await check("separate ACK origin cannot complete from database flags or kind alone", async () => {
    const body = erasureBody(), op = await register("erase", body), o = await origin(); await claim(op, o);
    await executeOrigin(o.client, op, body); await o.client.query("COMMIT");
    // These are deliberately synthetic owner-controlled fixture metadata, NOT a
    // real Root publication context, restore acceptance or positive verifier.
    await admin.query(`UPDATE driver_account_erasure_state SET replay_ready=true,replay_checkpoint_hash=$1,
      proof_valid_until=now()+interval '1 hour',retention_reviewed=true,report_protection='no_report',publication_fence_verified=true WHERE singleton`, [checkpointHash]);
    const ackOp = await register("ack", body), ack = await origin(); await claim(ackOp, ack);
    const result = await executeOrigin(ack.client, ackOp, body); await ack.client.query("COMMIT");
    assert.equal(result.kind, "ack"); assert.equal(result.reason, "root_publication_context_required");
    const receipt = await ledger();
    assert.equal(receipt.status, "pending"); assert.equal(receipt.derived_report_acknowledged, false);
    assert.equal(receipt.deleted_batch_count, 2); await assertNoUnrelatedLoss();
  });
  await check("publication read is control-only, read-only and requires a committed exact ERASE origin", async () => {
    const body = erasureBody(), op = await register("erase", body);
    await rejectedSource(() => readPublicationContext(op, body));
    const o = await origin(); await claim(op, o); await executeOrigin(o.client, op, body);
    await rejectedSource(() => readPublicationContext(op, body));
    await o.client.query("COMMIT");
    await denied(() => readPublicationContext(op, body, runtime), "42501");
    await denied(() => readPublicationContext(op, body, executor), "42501");
    await rejectedSource(() => readPublicationContext(op, erasureBody({ requestHash: hash("wrong readback body") })));
    const before = await ledger(), beforeEffects = await effectCounts();
    const readback = await readPublicationContext(op, body);
    assert.deepEqual(Object.keys(readback).sort(), ["storeIncarnation", "payloadDigest", "erasureOperationDigest",
      "databaseZeroVerified", "remainingBatchCount", "exactFenceCount", "readbackAt"].sort());
    assert.equal(readback.storeIncarnation, store); assert.equal(readback.payloadDigest, await bodyDigest(body));
    assert.match(readback.erasureOperationDigest, /^[a-f0-9]{64}$/u);
    assert.equal(readback.databaseZeroVerified, true); assert.equal(readback.remainingBatchCount, 0);
    assert.equal(readback.exactFenceCount, contributors.length);
    assert.match(readback.readbackAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    assert.deepEqual(await ledger(), before); assert.deepEqual(await effectCounts(), beforeEffects);
    const expire = expireBody(), otherOp = await register("expire", expire), otherOrigin = await origin();
    await claim(otherOp, otherOrigin); await executeOrigin(otherOrigin.client, otherOp, expire); await otherOrigin.client.query("COMMIT");
    await rejectedSource(() => readPublicationContext(otherOp, body));
  });
  await check("synthetic typed publication context completes only in the original ACK transaction", async () => {
    const body = erasureBody(), op = await register("erase", body), o = await origin(); await claim(op, o);
    await executeOrigin(o.client, op, body); await o.client.query("COMMIT");
    const publicationContext = await fixturePublicationContext(op, body);
    // This private test control is the only registrar. Its made-up record UUID
    // and digest model SQL mechanics, not a real signed Root record/delivery.
    const ackBody = { ...body, publicationContext }, ackOp = await register("ack", ackBody), ack = await origin();
    await claim(ackOp, ack); const result = await executeOrigin(ack.client, ackOp, ackBody);
    assert.equal(result.kind, "ack"); assert.equal(result.derivedReportAcknowledged, true);
    assert.equal(result.wholeAccountComplete, false);
    assert.equal((await ledger()).status, "pending", "ACK effects before original COMMIT are provisional");
    assert.equal((await resolveOrigin(ackOp)).state, "pending");
    await ack.client.query("COMMIT");
    const complete = await ledger();
    assert.equal(complete.status, "completed"); assert.equal(complete.derived_report_acknowledged, true);
    assert.equal(complete.database_zero_verified, true); assert.equal(complete.remaining_batch_count, 0);
    assert.equal(complete.deleted_batch_count, 2); assert.equal((await effectCounts()).permanentRevocations, contributors.length);
    assert.equal((await resolveOrigin(ackOp)).state, "origin_commit_known");
    // Registering a changed context on the same origin must not rewrite its
    // immutable body binding. A context-free retry must not downgrade completion.
    await rejectedSource(() => register("ack", { ...ackBody, publicationContext: { ...publicationContext,
      recordDigest: hash("changed synthetic publication record") } }, ackOp), "23505");
    const noContextOp = await register("ack", body), noContext = await origin(); await claim(noContextOp, noContext);
    await executeOrigin(noContext.client, noContextOp, body); await noContext.client.query("COMMIT");
    const repeated = await ledger();
    assert.equal(repeated.status, "completed"); assert.equal(repeated.derived_report_acknowledged, true);
    assert.equal(repeated.created_at, complete.created_at); assert.equal(repeated.deleted_batch_count, complete.deleted_batch_count);
    await assertNoUnrelatedLoss();
  });
  await check("malformed publication fields and database mismatches cannot manufacture acknowledgment", async () => {
    const body = erasureBody(), op = await register("erase", body), o = await origin(); await claim(op, o);
    await executeOrigin(o.client, op, body); await o.client.query("COMMIT");
    const context = await fixturePublicationContext(op, body), accepted = await ledger();
    const missingDigest = { ...context }; delete missingDigest.recordDigest;
    const variants: unknown[] = [
      { ...context, freeText: "not part of this contract" }, { ...context, contractVersion: "unreviewed" },
      { ...context, recordId: "not-a-uuid" }, { ...context, recordDigest: "invalid" },
      { ...context, storeIncarnation: randomUUID() }, { ...context, operationDigest: hash("different operation") },
      { ...context, readbackDigest: hash("different readback") }, { ...context, reportProtection: "unverified" },
      { ...context, observedAtUTC: new Date(Date.now() + 86_400_000).toISOString() },
      { ...context, observedAtUTC: String(context.observedAtUTC).replace(/Z$/u, "+00:00") }, missingDigest, [],
    ];
    for (const publicationContext of variants) {
      const invalidBody = { ...body, publicationContext }, invalidOp = await register("ack", invalidBody), attempt = await origin();
      await claim(invalidOp, attempt); await rejectedSource(() => executeOrigin(attempt.client, invalidOp, invalidBody));
      await release(attempt.client); assert.deepEqual(await ledger(), accepted);
    }
    await assertNoUnrelatedLoss();
  });
  await check("changed ledger, report protection or exact fences invalidates a prior publication readback", async () => {
    const body = erasureBody(), op = await register("erase", body), o = await origin(); await claim(op, o);
    await executeOrigin(o.client, op, body); await o.client.query("COMMIT");
    const attemptAck = async (context: Body) => {
      const ackBody = { ...body, publicationContext: context }, ackOp = await register("ack", ackBody), attempt = await origin();
      await claim(ackOp, attempt); await rejectedSource(() => executeOrigin(attempt.client, ackOp, ackBody));
      await release(attempt.client); assert.equal((await ledger()).derived_report_acknowledged, false);
    };
    const staleLedger = await fixturePublicationContext(op, body);
    await admin.query("UPDATE driver_account_erasure_operations SET updated_at=updated_at+interval '1 microsecond' WHERE operation_hash=$1", [operationHash]);
    await attemptAck(staleLedger);
    const staleProtection = await fixturePublicationContext(op, body);
    await admin.query("UPDATE driver_account_erasure_state SET report_protection='enforced_single_writer' WHERE singleton");
    await attemptAck(staleProtection);
    await admin.query("UPDATE driver_account_erasure_state SET report_protection='no_report' WHERE singleton");
    const staleFences = await fixturePublicationContext(op, body);
    await admin.query("DELETE FROM driver_account_erasure_revocations WHERE owner='cop' AND contributor_hash=$1", [contributors[0]!.contributorHash]);
    await rejectedSource(() => readPublicationContext(op, body)); await attemptAck(staleFences);
    assert.equal((await ledger()).status, "pending"); await assertNoUnrelatedLoss();
  });
  await check("origin journal and operation ledger contain no new contributor/account/day join", async () => {
    const body = erasureBody(), op = await register("erase", body), o = await origin(); await claim(op, o);
    await executeOrigin(o.client, op, body); await o.client.query("COMMIT");
    const columns = (await admin.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='sim_driver_guard_source' AND table_name='origins' ORDER BY ordinal_position`)).rows.map((row: any) => row.column_name);
    assert.deepEqual(columns, ["operation_id", "store_incarnation", "permit_id", "body_digest", "schema_digest", "kind", "cutoff",
      "state", "claimed_xid8", "backend_pid", "backend_start", "committed_marker"]);
    assert.deepEqual((await admin.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='sim_driver_guard_source' ORDER BY table_name`)).rows.map((row: any) => row.table_name), ["origins", "store_binding"]);
    // Cutoff and observed backend_start legitimately contain UTC dates. They
    // are operation/connection metadata, not an account/day association.
    const origins = (await admin.query("SELECT (to_jsonb(t)-ARRAY['cutoff','backend_start'])::text AS json FROM sim_driver_guard_source.origins t")).rows.map((row: any) => row.json).join("\n");
    for (const raw of [actorHash, requestHash, operationHash, checkpointHash, other, ...contributors.flatMap(row => [row.contributorDay, row.contributorHash])])
      assert.ok(!origins.includes(raw), "Transient manifest/identity escaped into the origin journal");
    const operationColumns = (await admin.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='driver_account_erasure_operations'`)).rows.map((row: any) => row.column_name);
    for (const column of operationColumns) assert.ok(!/contributor_(?:hash|day)|manifest|gps|latitude|longitude/u.test(column));
    assert.equal(await value(admin, `SELECT count(*)::int AS value FROM pg_constraint WHERE contype='f'
      AND (conrelid='public.driver_account_erasure_operations'::regclass OR confrelid='public.driver_account_erasure_operations'::regclass)`), 0);
  });
  assert.equal(providerCalls, 0); assert.equal(events.length, 18); success = true;
} finally {
  for (const client of [...activeClients]) await release(client).catch(() => undefined);
  for (const p of pools) await p.end().catch(() => undefined);
  if (started || existsSync(join(root, "data/postmaster.pid"))) {
    owned(); const lines = (await readFile(join(root, "data/postmaster.pid"), "utf8")).split("\n");
    assert.equal(lines[1], join(root, "data"));
    await execute(join(pgBin, "pg_ctl"), ["-D", join(root, "data"), "-m", "fast", "-w", "stop"], { env: cleanEnv, timeout: 15000 });
  }
  globalThis.fetch = originalFetch; process.umask(previousUmask);
  if (success) { owned(); assert.ok(!existsSync(join(root, "data/postmaster.pid"))); await rm(root, { recursive: true }); }
  else console.error(`Private synthetic failed fixture retained: ${root}`);
}
if (success) {
  const pins: Record<string, string> = {};
  for (const path of [...Object.keys(inputs), ...Object.keys(frozenInputs), "scripts/test-driver-guarded-operations-postgres.mts"])
    pins[path] = createHash("sha256").update(await readFile(join(repo, path))).digest("hex");
  for (const [path, pin] of Object.entries({ ...inputs, ...frozenInputs })) assert.equal(pins[path], pin);
  assert.equal(pins["scripts/test-driver-guarded-operations-postgres.mts"], initialSelfHash,
    "The exact executing harness changed after its initial pre-bootstrap hash.");
  const proof = { status: "SOURCE_GUARDED_DRIVER_SQL_MECHANICS_ONLY", startedAt, completedAt: new Date().toISOString(),
    postgresVersion: "18.3", cases: events, passed: events.length, providerCalls,
    isolation: { newOwnedCluster: true, tcpListener: false, externalTargetsAccepted: false, dataRemoved: true },
    sourcePins: pins, initialHarnessSha256: initialSelfHash, harnessUnchangedDuringRun: true,
    sourceUnchangedDuringRun: true, priorFrozenEvidenceUnchanged: true,
    coverage: { realSchema: true, originalGuardAndCascades: true, independentCatalogDiagnostic: true,
      expirationTransactionAndSeal: true, revokeLockRace: true, erasureLockRace: true,
      immutableAcceptedAtAndCounts: true, pendingWithoutRootPublicationContext: true,
      typedPublicationReadAndAckSqlMechanics: true, stalePublicationReadbackRejected: true },
    actual: { productionChanged: false, nativeAuthority: false, rootConnectionCustody: false,
      rootMetadataAccepted: false, rootSignaturesVerified: false, acceptedRootRecords: false,
      rootPublicationDeliveryAccepted: false, nativeTransport: false, actualWriterIntegration: false,
      restoreAccepted: false, deploymentAccepted: false, realAccountDeleted: false, providerCalls: false },
    interpretation: "18 NEW owned PostgreSQL SQL cases only; synthetic private publication context is not a real signed Root record or delivery. Prior eleven expiry/COP cases are not counted." };
  await writeFile(reportPath, JSON.stringify(proof, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ reportPath, passed: events.length, sourceUnchangedDuringRun: true,
    priorFrozenEvidenceUnchanged: true, productionChanged: false, actualAuthority: false }));
}
