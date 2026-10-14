/**
 * SOURCE-only SQL compatibility test over the unchanged actual SIM schema.
 * --run creates a brand-new Unix-only local PostgreSQL18.3 cluster. No external
 * target, credentials, production role/migration, native producer or provider.
 * The test controller owns both original and control connections. Local JSON
 * observations are not accepted Root references or a production adapter.
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
  console.error("Only --run is accepted. The target is a new local synthetic Unix-only cluster.");
  process.exit(2);
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = join(repo, "docs/archive/2026-10-14_DRIVER_EXPIRY_REAL_SCHEMA.json");
assert.ok(!existsSync(reportPath), "A frozen evidence receipt must not be overwritten.");
const pgBin = "/opt/homebrew/opt/postgresql@18/bin";
const execute = promisify(execFile);
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"].includes(key)));
for (const key of Object.keys(process.env)) if (/^PG|DATABASE_URL$|OPENAI|API_KEY|SECRET|TOKEN/u.test(key)) delete process.env[key];
assert.match((await execute(join(pgBin, "postgres"), ["--version"], { env: cleanEnv })).stdout,
  /^postgres \(PostgreSQL\) 18\.3(?:\s|$)/u);
const require = createRequire(join(repo, "apps/situation-data-api/package.json"));
const { Pool } = require("pg");
const inputs = {
  "deploy/driver-measurements/schema.sql": "6dd60a3acf28d63575198c8526c368df19bbd543f4063d4985fb55f308da02d0",
  "deploy/driver-measurements/002_account_erasure.sql": "f13db2106a1fe1a02d0d1a26afa8ad7d7c045172ba4419749719ed0f166e16ad",
  "scripts/fixtures/driver-retention-real-schema/expiry-source.sql": "1561825849c8990526af26eae3866ee2100072db72bed638997a2eec7a8afb7a",
};
const sourceText: Record<string, string> = {};
for (const [path, pin] of Object.entries(inputs)) {
  const bytes = await readFile(join(repo, path));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pin, `Unreviewed source: ${path}`);
  sourceText[path] = bytes.toString("utf8");
}
const tmp = realpathSync("/private/tmp");
assert.equal(tmp, "/private/tmp");
const previousUmask = process.umask(0o077);
const root = await mkdtemp(join(tmp, "sim-driver-expiry-pg-"));
await chmod(root, 0o700);
await mkdir(join(root, "socket"), { mode: 0o700 });
const owned = () => {
  assert.equal(dirname(realpathSync(root)), tmp);
  assert.ok(realpathSync(root).startsWith(join(tmp, "sim-driver-expiry-pg-")));
  for (const path of [root, join(root, "socket")]) {
    assert.equal(statSync(path).uid, process.getuid!());
    assert.equal(statSync(path).mode & 0o777, 0o700);
  }
};
owned();
const pools: any[] = [];
const pool = (user: string, database = "sim_driver_measurements") => {
  const p = new Pool({ host: join(root, "socket"), database, user, port: 5432,
    max: 3, connectionTimeoutMillis: 2000, statement_timeout: 5000 });
  pools.push(p); return p;
};
const events: Array<Record<string, unknown>> = [];
const startedAt = new Date().toISOString();
let started = false, success = false, providerCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { providerCalls++; throw new Error("No provider calls in this test."); };
let admin: any, control: any, executor: any, runtime: any;
const activeClients = new Set<any>();
const store = "00000000-0000-4000-8000-000000000001";
const cutoff = "2026-10-14T12:00:00.000Z";
const contributor = "1".repeat(64), other = "2".repeat(64), permanent = "3".repeat(64);
const value = async (p: any, sql: string, parameters: unknown[] = []) => (await p.query(sql, parameters)).rows[0].value;
const register = (operation: string, at = cutoff, body = "a".repeat(64), incarnation = store) =>
  value(control, "SELECT sim_driver_expiry_source.register_origin($1,$2,$3,$4,$5,$6) AS value",
    [operation, incarnation, "20000000-0000-4000-8000-000000000001", body, "b".repeat(64), at]);
const origin = async () => {
  const client = await executor.connect(); activeClients.add(client);
  await client.query("BEGIN");
  const descriptor = (await client.query(`SELECT pg_current_xact_id()::text AS xid,
    pg_backend_pid() AS pid,backend_start::text AS start FROM pg_stat_activity WHERE pid=pg_backend_pid()`)).rows[0];
  return { client, descriptor };
};
const claim = (op: string, descriptor: any) => value(control,
  "SELECT sim_driver_expiry_source.claim_origin($1,$2,$3::xid8,$4,$5) AS value",
  [op, store, descriptor.xid, descriptor.pid, descriptor.start]);
const expire = (client: any, op: string) => value(client,
  "SELECT sim_driver_expiry_source.expire_origin($1) AS value", [op]);
const resolveOrigin = (op: string, p: any = control) => value(p,
  "SELECT sim_driver_expiry_source.resolve_or_seal($1) AS value", [op]);
const release = async (client: any) => {
  await client.query("ROLLBACK").catch(() => undefined); client.release(); activeClients.delete(client);
};
const denied = async (fn: () => Promise<unknown>, code: string) => {
  try { await fn(); assert.fail("Expected rejection"); }
  catch (error: any) { if (error.code === "ERR_ASSERTION") throw error; assert.equal(error.code, code); }
};
const counts = () => value(admin, `SELECT jsonb_build_object(
  'receipts',(SELECT count(*) FROM driver_measurement_receipts),
  'intervals',(SELECT count(*) FROM driver_measurement_intervals),
  'eta',(SELECT count(*) FROM driver_measurement_eta),
  'temporaryRevocations',(SELECT count(*) FROM driver_measurement_revocations),
  'operations',(SELECT count(*) FROM driver_account_erasure_operations),
  'permanentRevocations',(SELECT count(*) FROM driver_account_erasure_revocations)) AS value`);
const beforeEffects = { receipts: 3, intervals: 3, eta: 3, temporaryRevocations: 2, operations: 1, permanentRevocations: 1 };
const afterEffects = { receipts: 1, intervals: 1, eta: 1, temporaryRevocations: 1, operations: 1, permanentRevocations: 1 };
const seed = async () => {
  await admin.query(`TRUNCATE driver_measurement_receipts,driver_measurement_intervals,driver_measurement_eta,
    driver_measurement_revocations,driver_account_erasure_operations,driver_account_erasure_revocations`);
  await admin.query(`INSERT INTO driver_measurement_receipts(owner,batch_id,contributor_hash,request_hash,received_at,expires_at,receipt)
    VALUES('cop','30000000-0000-4000-8000-000000000001',$1,$3,'2026-10-09T00:00:00Z','2026-10-10T00:00:00Z','{}'),
    ('cop','30000000-0000-4000-8000-000000000002',$2,$3,'2026-10-09T00:00:00Z','2026-10-14T12:00:00Z','{}'),
    ('cop','30000000-0000-4000-8000-000000000003',$1,$3,'2026-10-09T00:00:00Z','2026-10-15T00:00:00Z','{}')`,
    [contributor, other, "4".repeat(64)]);
  await admin.query(`INSERT INTO driver_measurement_intervals(owner,batch_id,measurement_key,dataset,edge_id,window_start,speed_kph,distance_m,elapsed_seconds)
    SELECT owner,batch_id,md5(batch_id::text)||md5(batch_id::text),
      CASE WHEN batch_id::text LIKE '%1' THEN 'historical-graph' ELSE 'current-graph' END,
      '8','2026-10-09T00:00:00Z',36,50,5 FROM driver_measurement_receipts`);
  await admin.query(`INSERT INTO driver_measurement_eta(owner,batch_id,observation_id,contributor_hash,dataset,window_start,predicted_seconds,actual_seconds)
    SELECT owner,batch_id,batch_id,contributor_hash,'historical-graph','2026-10-09T00:00:00Z',100,120 FROM driver_measurement_receipts`);
  await admin.query("INSERT INTO driver_measurement_revocations VALUES('cop',$1,'2026-10-10T00:00:00Z'),('cop',$2,'2026-10-15T00:00:00Z')", [contributor, other]);
  await admin.query("INSERT INTO driver_account_erasure_revocations(owner,contributor_hash) VALUES('cop',$1)", [permanent]);
  await admin.query(`INSERT INTO driver_account_erasure_operations(operation_hash,actor_hash,request_hash,contributor_count)
    VALUES(repeat('5',64),repeat('6',64),repeat('7',64),9)`);
};
const check = async (name: string, fn: () => Promise<void>) => {
  await seed();
  try { await fn(); events.push({ case: name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { events.push({ case: name, passed: false }); throw error; }
  finally { for (const client of [...activeClients]) await release(client); }
};
let schemaBefore: unknown;
const schemaSnapshot = () => value(admin, `SELECT jsonb_build_object('tables',(
  SELECT jsonb_agg(jsonb_build_object('name',tablename,'owner',tableowner) ORDER BY tablename)
  FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'driver_%'),
  'guard',(SELECT pg_get_functiondef('public.driver_account_erasure_receipt_guard()'::regprocedure)),
  'trigger',(SELECT pg_get_triggerdef(oid)||':'||tgenabled::text FROM pg_trigger
    WHERE tgname='driver_account_erasure_receipt_guard' AND NOT tgisinternal)) AS value`);
const erasureEvidence = () => value(admin, `SELECT jsonb_build_object(
  'state',(SELECT jsonb_agg(to_jsonb(t)) FROM driver_account_erasure_state t),
  'operations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY operation_hash) FROM driver_account_erasure_operations t),
  'permanent',(SELECT jsonb_agg(to_jsonb(t) ORDER BY owner,contributor_hash) FROM driver_account_erasure_revocations t)) AS value`);
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
    CREATE ROLE sim_driver_expiry_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_driver_expiry_control LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_driver_expiry_exec LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await bootstrap.query("CREATE DATABASE sim_driver_measurements OWNER driver_measurements_migrator");
  admin = pool("synthetic_admin"); control = pool("sim_driver_expiry_control");
  executor = pool("sim_driver_expiry_exec"); runtime = pool("driver_measurements_runtime");
  await admin.query("SET ROLE driver_measurements_migrator");
  await admin.query(sourceText["deploy/driver-measurements/schema.sql"]);
  await admin.query(sourceText["deploy/driver-measurements/002_account_erasure.sql"]);
  await admin.query("RESET ROLE"); schemaBefore = await schemaSnapshot();
  await admin.query("REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO driver_measurements_runtime,sim_driver_expiry_owner");
  await admin.query(`CREATE SCHEMA sim_driver_expiry_source AUTHORIZATION sim_driver_expiry_owner;
    GRANT sim_driver_expiry_exec TO sim_driver_expiry_owner;
    GRANT SELECT,DELETE ON driver_measurement_receipts,driver_measurement_revocations TO sim_driver_expiry_owner`);
  await admin.query(sourceText["scripts/fixtures/driver-retention-real-schema/expiry-source.sql"]);
  await admin.query("INSERT INTO sim_driver_expiry_source.store_binding VALUES(true,$1)", [store]);
  // Fixture-only future grant profile: never change live revoke/erase permissions.
  await admin.query(`GRANT SELECT,INSERT ON driver_measurement_receipts,driver_measurement_intervals,driver_measurement_eta TO driver_measurements_runtime;
    GRANT SELECT ON driver_measurement_revocations TO driver_measurements_runtime;
    GRANT UPDATE(receipt) ON driver_measurement_receipts TO driver_measurements_runtime;
    REVOKE DELETE,TRUNCATE ON driver_measurement_receipts,driver_measurement_intervals,driver_measurement_eta,driver_measurement_revocations FROM driver_measurements_runtime`);
  assert.deepEqual(await schemaSnapshot(), schemaBefore);
  for (const p of [control, executor, runtime]) {
    const connection = (await p.query("SELECT current_database() AS db,inet_server_addr() AS tcp,current_setting('data_directory') AS directory").catch(async () => p.query("SELECT current_database() AS db,inet_server_addr() AS tcp"))).rows[0];
    assert.equal(connection.db, "sim_driver_measurements"); assert.equal(connection.tcp, null);
  }
  await check("restricted roles cannot bypass fixed expiration or mutate expiry selection", async () => {
    for (const p of [runtime, executor]) {
      for (const suffix of ["receipts", "intervals", "eta", "revocations"])
        await denied(() => p.query(`DELETE FROM public.driver_measurement_${suffix}`), "42501");
      await denied(() => p.query("UPDATE sim_driver_expiry_source.origins SET committed_marker=true"), "42501");
      await denied(() => p.query("SET ROLE sim_driver_expiry_owner"), "42501");
      await denied(() => p.query("SET ROLE sim_driver_expiry_control"), "42501");
    }
    await denied(() => runtime.query("UPDATE driver_measurement_receipts SET expires_at=now()"), "42501");
    await denied(() => expire(runtime, randomUUID()), "42501");
    assert.deepEqual(await counts(), beforeEffects);
  });
  await check("same original transaction contains actual cascades and marker, preserving erasure evidence", async () => {
    const permanentBefore = await erasureEvidence();
    const op = randomUUID(); await register(op); const o = await origin(); await claim(op, o.descriptor); await expire(o.client, op);
    assert.equal((await resolveOrigin(op)).state, "pending"); assert.deepEqual(await counts(), beforeEffects);
    await o.client.query("COMMIT"); assert.equal((await resolveOrigin(op)).state, "origin_commit_known");
    assert.deepEqual(await counts(), afterEffects); assert.deepEqual(await schemaSnapshot(), schemaBefore);
    assert.deepEqual(await erasureEvidence(), permanentBefore);
  });
  await check("immutable registration and single claim reject altered body/store and duplicate claim", async () => {
    const op = randomUUID(); await register(op); const o = await origin(); await claim(op, o.descriptor);
    await denied(() => claim(op, o.descriptor), "P0001");
    await denied(() => register(op, cutoff, "c".repeat(64)), "P0001");
    await denied(() => register(randomUUID(), cutoff, "a".repeat(64), randomUUID()), "P0001");
    assert.deepEqual(await counts(), beforeEffects);
  });
  await check("rollback restores four effects and a new XID cannot reuse original claim", async () => {
    const op = randomUUID(); await register(op); const o = await origin(); await claim(op, o.descriptor); await expire(o.client, op);
    await o.client.query("ROLLBACK"); assert.deepEqual(await counts(), beforeEffects);
    await o.client.query("BEGIN"); const xid = (await o.client.query("SELECT pg_current_xact_id()::text AS xid")).rows[0].xid;
    assert.notEqual(xid, o.descriptor.xid); await denied(() => expire(o.client, op), "P0001");
    await o.client.query("ROLLBACK"); assert.equal((await resolveOrigin(op)).state, "origin_no_effect_closed");
  });
  await check("durable seal prevents late original entry while original backend is still alive", async () => {
    const op = randomUUID(); await register(op); const o = await origin(); await claim(op, o.descriptor);
    assert.equal((await resolveOrigin(op)).state, "origin_no_effect_closed");
    assert.equal((await resolveOrigin(op)).state, "origin_no_effect_closed");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid=$1 AND xact_start IS NOT NULL", [o.descriptor.pid])).rows[0].n, 1);
    await denied(() => expire(o.client, op), "P0001"); assert.deepEqual(await counts(), beforeEffects);
  });
  await check("busy executor never becomes timeout-derived no-effect outcome", async () => {
    const op = randomUUID(); await register(op); const o = await origin(); await claim(op, o.descriptor); await expire(o.client, op);
    const result = await resolveOrigin(op); assert.equal(result.state, "pending"); assert.equal(result.reason, "origin_busy");
    await o.client.query("ROLLBACK"); assert.equal((await resolveOrigin(op)).state, "origin_no_effect_closed");
  });
  await check("inner seal JSON followed by control rollback is not durable closure", async () => {
    const op = randomUUID(); await register(op); const o = await origin(); await claim(op, o.descriptor);
    const c = await control.connect(); activeClients.add(c); await c.query("BEGIN");
    assert.equal((await resolveOrigin(op, c)).state, "origin_no_effect_closed");
    assert.equal((await value(admin, "SELECT to_jsonb(state) AS value FROM sim_driver_expiry_source.origins WHERE operation_id=$1", [op])), "claimed");
    await c.query("ROLLBACK"); await expire(o.client, op); await o.client.query("COMMIT");
    assert.equal((await resolveOrigin(op)).state, "origin_commit_known"); assert.deepEqual(await counts(), afterEffects);
  });
  await check("control COMMIT and fresh readback precede terminal seal publication", async () => {
    const op = randomUUID(); await register(op); const o = await origin(); await claim(op, o.descriptor);
    const c = await control.connect(); activeClients.add(c); await c.query("BEGIN"); await resolveOrigin(op, c); await c.query("COMMIT");
    assert.equal((await resolveOrigin(op)).state, "origin_no_effect_closed");
    await denied(() => expire(o.client, op), "P0001"); assert.deepEqual(await counts(), beforeEffects);
  });
  await check("missing origin remains unknown and fixed cutoff retains later rows across graph versions", async () => {
    const missing = await resolveOrigin(randomUUID()); assert.equal(missing.state, "pending"); assert.equal(missing.reason, "origin_missing");
    const op = randomUUID(); await register(op, "2026-10-09T00:00:00.000Z"); const o = await origin(); await claim(op, o.descriptor);
    await expire(o.client, op); await o.client.query("COMMIT"); assert.deepEqual(await counts(), beforeEffects);
  });
  await check("real permanent fence still rejects intake and real interval quality constraint is unchanged", async () => {
    await denied(() => runtime.query(`INSERT INTO driver_measurement_receipts(owner,batch_id,contributor_hash,request_hash,received_at,expires_at,receipt)
      VALUES('cop',$1,$2,repeat('8',64),now(),now()+interval '7 days','{}')`, [randomUUID(), permanent]), "23514");
    await denied(() => runtime.query(`INSERT INTO driver_measurement_intervals(owner,batch_id,measurement_key,dataset,edge_id,window_start,speed_kph,distance_m,elapsed_seconds)
      VALUES('cop','30000000-0000-4000-8000-000000000001',repeat('9',64),'synthetic','8',now(),999,50,5)`), "23514");
    assert.deepEqual(await counts(), beforeEffects); assert.deepEqual(await schemaSnapshot(), schemaBefore);
  });
  await check("origin journal has no contributor, manifest, GPS or account/day linkage", async () => {
    const cols = (await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='sim_driver_expiry_source' AND table_name='origins'")).rows.map((r: any) => r.column_name);
    for (const c of cols) assert.ok(!/contributor|manifest|account|gps|latitude|longitude|day/u.test(c));
    const rows = (await admin.query("SELECT row_to_json(t)::text AS json FROM sim_driver_expiry_source.origins t")).rows.map((r: any) => r.json).join("\n");
    for (const raw of [contributor, other, permanent]) assert.ok(!rows.includes(raw));
    assert.deepEqual(await schemaSnapshot(), schemaBefore);
  });
  assert.equal(providerCalls, 0); assert.equal(events.length, 11); success = true;
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
  for (const path of [...Object.keys(inputs), "scripts/test-driver-expiry-real-schema.mts"])
    pins[path] = createHash("sha256").update(await readFile(join(repo, path))).digest("hex");
  for (const [path, pin] of Object.entries(inputs)) assert.equal(pins[path], pin);
  const proof = { status: "SOURCE_REAL_SCHEMA_SQL_MECHANICS_ONLY", startedAt, completedAt: new Date().toISOString(),
    postgresVersion: "18.3", cases: events, passed: events.length, providerCalls,
    isolation: { newOwnedCluster: true, tcpListener: false, externalTargetsAccepted: false, dataRemoved: true },
    sourcePins: pins, sourceUnchangedDuringRun: true, actual: {
      productionChanged: false, nativeAuthority: false, rootConnectionCustody: false, nativeTransport: false,
      wholeScopePolicyAccepted: false, actualWriterIntegration: false, restoreAccepted: false, deploymentAccepted: false },
    interpretation: "11 real-schema SQL cases, not native delivery/Root/physical restore acceptance; no contributor executor or changed live grants." };
  await writeFile(reportPath, JSON.stringify(proof, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ reportPath, passed: events.length, sourceUnchangedDuringRun: true, productionChanged: false }));
}
