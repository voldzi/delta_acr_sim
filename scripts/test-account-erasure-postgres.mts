/**
 * Isolated, synthetic account-erasure PostgreSQL evidence.
 *
 * Requires PostgreSQL 18.3 binaries and installed workspace dependencies.
 * Run from repository root:
 *   PG_BIN=/path/to/postgresql-18/bin node --import ./apps/ai-router-api/node_modules/tsx/dist/loader.mjs scripts/test-account-erasure-postgres.mts --run
 *
 * No database URL, host, password or production secret is accepted. The runner
 * creates a NEW private temporary cluster, listens only on its Unix socket,
 * verifies data_directory and server identity before writes, and stops its own
 * server in finally. Successful runs remove only their generated directory;
 * failed runs retain a private synthetic fixture for inspection.
 *
 * Positive owner checkpoints below are synthetic test fixtures, NOT authority
 * to activate production, claim physical-backup erasure, or call a provider.
 */
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BudgetStore } from "../apps/ai-router-api/src/budget.js";
import { PgSeparateBilling } from "../apps/ai-router-api/src/separate-billing.js";
import { PgAccountErasure, erasureIdentity, verifyErasureActor } from "../apps/ai-router-api/src/account-erasure.js";
import { PostgresDriverMeasurementStore } from "../apps/situation-data-api/src/driver-measurement-store.js";
import { PostgresDriverAccountErasureStore } from "../apps/situation-data-api/src/driver-account-erasure-store.js";
import { driverErasureHash, driverErasureRequiredDays, parseDriverErasureRequest, prepareDriverErasureInput, validateDriverErasureCoverage } from "../apps/situation-data-api/src/driver-account-erasure.js";

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log("Synthetic Unix-only PostgreSQL 18.3 tests. Use --run; optionally set PG_BIN to a binary directory. Never pass a database URL or production credentials.");
  process.exit(0);
}
if (args.length !== 1 || args[0] !== "--run") {
  console.error("Only --run or --help is accepted; no external database target is supported.");
  process.exit(2);
}
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(source, "apps/ai-router-api/package.json"));
const { Pool } = require("pg");
const execute = promisify(execFile);
const pgBinOverride = process.env.PG_BIN;
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"].includes(key)));
for (const key of Object.keys(process.env)) if (/^PG|DATABASE_URL$|OPENAI|API_KEY|SECRET|TOKEN/u.test(key)) delete process.env[key];
const pgBin = pgBinOverride ?? (await execute("pg_config", ["--bindir"], { env: cleanEnv })).stdout.trim();
assert.ok(isAbsolute(pgBin) && statSync(pgBin).isDirectory(), "PostgreSQL binary directory must be absolute.");
assert.match((await execute(join(pgBin, "postgres"), ["--version"], { env: cleanEnv })).stdout, /^postgres \(PostgreSQL\) 18\.3(?:\s|$)/u);
const migrationPins: Record<string, string> = {
  "deploy/ai-router/001_schema.sql": "b6e48ea50286f25a16262e4e8f7c2f57a9629ea09e163db473820618bcb1a92b",
  "deploy/ai-router/002_separate_billing.sql": "e016cfa95cf228c4781780d844e9bc0c784aade6c36a21fa9667923d9b0bfbcb",
  "deploy/ai-router/003_account_erasure.sql": "921e19e1bae334bb3ae84dadfc9ab4b9cd333b4f515e77a3a286b68649426a56",
  "deploy/driver-measurements/schema.sql": "6dd60a3acf28d63575198c8526c368df19bbd543f4063d4985fb55f308da02d0",
  "deploy/driver-measurements/002_account_erasure.sql": "f13db2106a1fe1a02d0d1a26afa8ad7d7c045172ba4419749719ed0f166e16ad"
};
for (const [path, expected] of Object.entries(migrationPins)) assert.equal(createHash("sha256").update(await readFile(join(source, path))).digest("hex"), expected, `Unreviewed migration change: ${path}`);
// Keep the Unix socket short enough on macOS; TMPDIR can exceed sun_path.
const trustedTemporary = realpathSync(existsSync("/private/tmp") ? "/private/tmp" : "/tmp");
assert.ok(trustedTemporary === "/private/tmp" || trustedTemporary === "/tmp", "Use the native local temporary filesystem.");
const previousUmask = process.umask(0o077);
const root = await mkdtemp(join(trustedTemporary, "csm-sim-account-erasure-pg-"));
await chmod(root, 0o700);
await mkdir(join(root, "socket"), { mode: 0o700 });
const assertOwned = () => {
  assert.equal(dirname(realpathSync(root)), trustedTemporary);
  assert.ok(realpathSync(root).startsWith(join(trustedTemporary, "csm-sim-account-erasure-pg-")));
  assert.equal(statSync(root).uid, process.getuid!());
  assert.equal(statSync(root).mode & 0o777, 0o700);
  assert.equal(statSync(join(root, "socket")).uid, process.getuid!());
  assert.equal(statSync(join(root, "socket")).mode & 0o777, 0o700);
};
assertOwned();
let started = false, successful = false, providerCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { providerCalls++; throw new Error("Provider calls are forbidden in this synthetic test."); };
const pools: any[] = [];
const disposables: Array<() => Promise<void>> = [];
const connection = (database: string, user: string) => ({ host: join(root, "socket"), database, user, port: 5432, connectionTimeoutMillis: 2000, statement_timeout: 5000 });
const makePool = (database: string, user: string) => { const pool = new Pool(connection(database, user)); pools.push(pool); return pool; };
async function makeContext(database: "sim_ai_router" | "sim_driver_measurements") {
  assertOwned();
  const admin = makePool(database, "synthetic_admin");
  const owner = makePool(database, database === "sim_ai_router" ? "ai_router_migrator" : "driver_measurements_migrator");
  const runtime = makePool(database, database === "sim_ai_router" ? "ai_router_runtime" : "driver_measurements_runtime");
  const verified = await admin.query("SELECT current_setting('data_directory') AS directory,current_setting('listen_addresses') AS listen,pg_postmaster_start_time() AS started");
  assert.equal(verified.rows[0].directory, join(root, "data")); assert.equal(verified.rows[0].listen, "");
  for (const pool of [owner, runtime]) {
    const row = (await pool.query("SELECT current_database() AS database,inet_server_addr() AS tcp,pg_postmaster_start_time() AS started")).rows[0];
    assert.equal(row.database, database); assert.equal(row.tcp, null); assert.equal(row.started.toISOString(), verified.rows[0].started.toISOString());
  }
  return { admin, owner, runtime };
}
async function shutdown() {
  for (const close of disposables) await close().catch(() => undefined);
  for (const pool of pools) if (!pool.ending && !pool.ended) await pool.end().catch(() => undefined);
  if (started || existsSync(join(root, "data/postmaster.pid"))) {
    assertOwned();
    const pid = (await readFile(join(root, "data/postmaster.pid"), "utf8")).split("\n");
    assert.equal(pid[1], join(root, "data"));
    await execute(join(pgBin, "pg_ctl"), ["-D", join(root, "data"), "-m", "fast", "-w", "stop"], { env: cleanEnv, timeout: 15000 });
    started = false;
  }
  globalThis.fetch = originalFetch;
  process.umask(previousUmask);
  if (successful) { assertOwned(); assert.ok(!existsSync(join(root, "data/postmaster.pid"))); await rm(root, { recursive: true }); }
  else console.error(`Private synthetic fixture retained after failure: ${root}`);
}
let stopping: Promise<void> | undefined;
const shutdownOnce = () => stopping ??= shutdown();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void shutdownOnce().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)); });
async function baseline() {
  const admin = makePool("postgres", "synthetic_admin");
  const identity = (await admin.query("SELECT current_setting('data_directory') AS directory,current_setting('listen_addresses') AS listen")).rows[0];
  assert.equal(identity.directory, join(root, "data")); assert.equal(identity.listen, "");
  const roles = ["ai_router_migrator", "ai_router_runtime", "driver_measurements_migrator", "driver_measurements_runtime"];
  for (const role of roles) await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await admin.query("CREATE DATABASE sim_ai_router OWNER ai_router_migrator");
  await admin.query("CREATE DATABASE sim_driver_measurements OWNER driver_measurements_migrator");
  const ai = await makeContext("sim_ai_router"), driver = await makeContext("sim_driver_measurements");
  await ai.admin.query("REVOKE ALL ON DATABASE sim_ai_router FROM PUBLIC; GRANT CONNECT ON DATABASE sim_ai_router TO ai_router_runtime; REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ai_router_runtime");
  await driver.admin.query("REVOKE ALL ON DATABASE sim_driver_measurements FROM PUBLIC; GRANT CONNECT ON DATABASE sim_driver_measurements TO driver_measurements_runtime; REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO driver_measurements_runtime");
  for (let i = 0; i < 2; i++) await ai.owner.query(await readFile(join(source, "deploy/ai-router/001_schema.sql"), "utf8"));
  await ai.owner.query("GRANT SELECT,INSERT,UPDATE ON ai_router_request,ai_router_policy,ai_router_policy_audit TO ai_router_runtime; GRANT USAGE,SELECT ON SEQUENCE ai_router_policy_audit_id_seq TO ai_router_runtime");
  for (let i = 0; i < 2; i++) await ai.owner.query(await readFile(join(source, "deploy/ai-router/002_separate_billing.sql"), "utf8"));
  for (let i = 0; i < 2; i++) await driver.owner.query(await readFile(join(source, "deploy/driver-measurements/schema.sql"), "utf8"));
  await driver.owner.query("GRANT SELECT,INSERT,UPDATE,DELETE ON driver_measurement_receipts,driver_measurement_intervals,driver_measurement_eta,driver_measurement_revocations TO driver_measurements_runtime");
  let passed = 0;
  const check = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`PASS ${name}`); };
  const rejects = async (fn: () => Promise<unknown>, code: string) => { try { await fn(); assert.fail("Expected denial"); } catch (error: any) { if (error.code === "ERR_ASSERTION") throw error; assert.equal(error.code, code); } };
  await check("baseline migrations are idempotent and migration-owned", async () => {
    for (const [ctx, expected] of [[ai, "ai_router_migrator"], [driver, "driver_measurements_migrator"]] as const) assert.ok((await ctx.runtime.query("SELECT tableowner FROM pg_tables WHERE schemaname='public'")).rows.every((r: any) => r.tableowner === expected));
  });
  await check("runtime has no broad privileges, DDL or SECURITY DEFINER", async () => {
    for (const ctx of [ai, driver]) {
      assert.deepEqual(Object.values((await ctx.runtime.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0]), [false, false, false, false, false]);
      await rejects(() => ctx.runtime.query("CREATE TABLE forbidden_test(id int)"), "42501");
      assert.equal((await ctx.runtime.query("SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef")).rows[0].n, 0);
    }
  });
  await check("before migration the runtime cannot delete financial history", async () => {
    for (const table of ["ai_router_request", "ai_router_billing_request", "ai_router_user_key_audit"]) await rejects(() => ai.runtime.query(`DELETE FROM ${table}`), "42501");
  });
  await check("COP alias and target hash are separate from raw subject", async () => {
    const secret = randomBytes(32), budgetSecret = randomBytes(32), subject = "synthetic-raw-subject";
    const alias = "cop_" + createHmac("sha256", secret).update("cop-router-chat-v1\0" + subject).digest("base64url");
    assert.match(alias, /^cop_[A-Za-z0-9_-]{43}$/u);
    assert.notEqual(createHash("sha256").update(budgetSecret).update("\0cop\0").update(alias).digest("hex"), createHash("sha256").update(budgetSecret).update("\0cop\0").update(subject).digest("hex"));
  });
  return passed;
}

async function aiSqlSecurity() {
  const { admin, owner, runtime } = await makeContext("sim_ai_router");
const sql=await readFile(`${source}/deploy/ai-router/003_account_erasure.sql`,'utf8');
console.log(JSON.stringify({migrationSha256:createHash('sha256').update(sql).digest('hex'),scope:'isolated_synthetic_only'}));
assert.equal(createHash('sha256').update(sql).digest('hex'),migrationPins['deploy/ai-router/003_account_erasure.sql']);await owner.query(sql);await owner.query(sql);
let passed=0;
const check=async(name:string,fn:()=>Promise<void>)=>{await fn();passed++;console.log(`PASS ${name}`);};
const denies=async(fn:()=>Promise<any>,code='42501')=>{try{await fn();assert.fail('Expected database rejection');}catch(e:any){if(e.code==='ERR_ASSERTION')throw e;assert.equal(e.code,code);}};
const a='1'.repeat(64),b='2'.repeat(64),sim='3'.repeat(64),izs='4'.repeat(64),ownerHash='5'.repeat(64),operation=randomUUID();
const ids={copA:randomUUID(),copB:randomUUID(),sim:randomUUID(),izs:randomUUID(),byokA:randomUUID(),byokB:randomUUID(),project:randomUUID()};
await admin.query('BEGIN');await admin.query("SELECT set_config('sim.router_erasure_code_version','1',true)");
for(const [id,client,target]of [[ids.copA,'cop',a],[ids.copB,'cop',b],[ids.sim,'sim',sim],[ids.izs,'izs',izs]])await admin.query("INSERT INTO ai_router_request(id,client_id,user_hash,task_type,model,routing_reason,difficulty,status,reserved_microusd,charged_microusd,input_tokens,output_tokens) VALUES($1,$2,$3,'synthetic_test','no_provider','synthetic_test','low','success',10,8,2,3)",[id,client,target]);
for(const [id,lane,payer,actor,task]of [[ids.byokA,'user_openai_key',a,a,'cop_chat'],[ids.byokB,'user_openai_key',b,b,'cop_chat'],[ids.project,'sim_project','sim_izs_project',izs,'sim_izs_summary']])await admin.query("INSERT INTO ai_router_billing_request(id,billing_source,payer_hash,actor_hash,credential_fingerprint,task_type,model,status,reserved_microusd,estimated_microusd) VALUES($1,$2,$3,$4,'synthetic_fingerprint',$5,'no_provider','success',10,8)",[id,lane,payer,actor,task]);
for(const target of [a,b,sim]){await admin.query("INSERT INTO ai_router_user_key(user_hash,ciphertext,nonce,auth_tag,fingerprint) VALUES($1,$2,$3,$4,'synthetic_fingerprint')",[target,Buffer.from('synthetic'),Buffer.alloc(12),Buffer.alloc(16)]);await admin.query("INSERT INTO ai_router_user_key_audit(user_hash,action,fingerprint) VALUES($1,'created','synthetic_fingerprint')",[target]);}
await admin.query('COMMIT');
await check('migration repeat and SQL objects have no SECURITY DEFINER',async()=>{assert.equal((await runtime.query("SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef")).rows[0].n,0);});
await check('runtime cannot DDL, change review checkpoint, truncate or remove permanent fence',async()=>{
  await denies(()=>runtime.query('CREATE TABLE forbidden_test(id int)'));
  await denies(()=>runtime.query('ALTER TABLE ai_router_request DISABLE TRIGGER ALL'));
  await denies(()=>runtime.query('TRUNCATE ai_router_request'));
  await denies(()=>runtime.query('UPDATE ai_router_erasure_checkpoint SET identity_reviewed=true'));
  await denies(()=>runtime.query('DELETE FROM ai_router_account_erasure'));
  await denies(()=>runtime.query('SET ROLE ai_router_migrator'));
});
await check('financial delete without operation context touches no rows',async()=>{
  assert.equal((await runtime.query('DELETE FROM ai_router_request')).rowCount,0);
  assert.equal((await runtime.query('DELETE FROM ai_router_billing_request')).rowCount,0);
  assert.equal((await runtime.query('DELETE FROM ai_router_user_key_audit')).rowCount,0);
});
await runtime.query("INSERT INTO ai_router_account_erasure(operation_id,owner_hash,target_hash,body_digest) VALUES($1,$2,$3,$4)",[operation,ownerHash,a,'6'.repeat(64)]);
await check('correct COP operation context cannot delete another COP account or SIM/IZS',async()=>{
  const c=await runtime.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('sim.erasure_target',$1,true),set_config('sim.erasure_operation',$2,true),set_config('sim.erasure_owner',$3,true)",[a,operation,ownerHash]);
    assert.equal((await c.query('DELETE FROM ai_router_request WHERE user_hash=$1',[b])).rowCount,0);
    assert.equal((await c.query("DELETE FROM ai_router_request WHERE client_id<>'cop'")).rowCount,0);
    assert.equal((await c.query('DELETE FROM ai_router_billing_request WHERE actor_hash=$1',[b])).rowCount,0);
    assert.equal((await c.query("DELETE FROM ai_router_billing_request WHERE billing_source='sim_project'")).rowCount,0);
    assert.equal((await c.query('DELETE FROM ai_router_user_key_audit WHERE user_hash=$1',[sim])).rowCount,0);
    assert.equal((await c.query('DELETE FROM ai_router_request WHERE user_hash=$1',[a])).rowCount,1);
    assert.equal((await c.query('DELETE FROM ai_router_billing_request WHERE actor_hash=$1',[a])).rowCount,1);
    assert.equal((await c.query('DELETE FROM ai_router_user_key_audit WHERE user_hash=$1',[a])).rowCount,1);
    await c.query('ROLLBACK');
  }finally{c.release();}
});
await check('wrong operation owner cannot authorize a delete',async()=>{
  const c=await runtime.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('sim.erasure_target',$1,true),set_config('sim.erasure_operation',$2,true),set_config('sim.erasure_owner',$3,true)",[a,operation,b]);assert.equal((await c.query('DELETE FROM ai_router_request WHERE user_hash=$1',[a])).rowCount,0);await c.query('ROLLBACK');}finally{c.release();}
});
await check('database rejects old runtime reservations and fenced key writes',async()=>{
  await denies(()=>runtime.query("INSERT INTO ai_router_request(id,client_id,user_hash,task_type,model,routing_reason,difficulty,status,reserved_microusd) VALUES($1,'cop',$2,'cop_chat','no_provider','synthetic','low','reserved',1)",[randomUUID(),b]),'P0001');
  await denies(()=>runtime.query("UPDATE ai_router_user_key SET fingerprint='late_synthetic' WHERE user_hash=$1",[a]),'P0001');
});
await check('current marker still permits SIM/IZS history and no preserved rows changed',async()=>{
  const legacy=await runtime.connect();try{await legacy.query('BEGIN');await legacy.query("INSERT INTO ai_router_request(id,client_id,user_hash,task_type,model,routing_reason,difficulty,status,reserved_microusd) VALUES($1,'sim',$2,'synthetic','no_provider','synthetic','low','success',1)",[randomUUID(),sim]);await legacy.query('ROLLBACK');}finally{legacy.release();}const c=await runtime.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('sim.router_erasure_code_version','1',true)");await c.query("INSERT INTO ai_router_request(id,client_id,user_hash,task_type,model,routing_reason,difficulty,status,reserved_microusd) VALUES($1,'sim',$2,'synthetic','no_provider','synthetic','low','success',1)",[randomUUID(),sim]);await c.query('ROLLBACK');}finally{c.release();}
  assert.equal((await runtime.query("SELECT count(*)::int AS n FROM ai_router_request WHERE client_id IN ('sim','izs')")).rows[0].n,2);
  assert.equal((await runtime.query("SELECT count(*)::int AS n FROM ai_router_billing_request WHERE billing_source='sim_project'")).rows[0].n,1);
  assert.equal((await runtime.query('SELECT count(*)::int AS n FROM ai_router_user_key WHERE user_hash=$1',[sim])).rows[0].n,1);
});

  return passed;
}
async function driverBehavior() {
  const { admin, owner, runtime } = await makeContext("sim_driver_measurements");
const sql=await readFile(`${source}/deploy/driver-measurements/002_account_erasure.sql`,'utf8');console.log(JSON.stringify({migrationSha256:createHash('sha256').update(sql).digest('hex'),scope:'isolated_synthetic_only'}));assert.equal(createHash('sha256').update(sql).digest('hex'),migrationPins['deploy/driver-measurements/002_account_erasure.sql']);await owner.query(sql);await owner.query(sql);
let passed=0;const check=async(name:string,fn:()=>Promise<void>)=>{await fn();passed++;console.log(`PASS ${name}`);};
const reject=async(fn:()=>Promise<any>,code:string)=>{try{await fn();assert.fail('Expected rejection');}catch(e:any){if(e.code==='ERR_ASSERTION')throw e;assert.equal(e.code,code);}};
const secret=randomBytes(32).toString('hex'),checkpoint=randomUUID();
let proofCurrent=true;const options={enabled:true,expectedCheckpoint:checkpoint,identityConfigured:true,protectedProof:async()=>({checkpoint,restoreCheckpointCurrent:proofCurrent,identityReviewed:true,retentionReviewed:true,publicationFenceVerified:true,reportProtection:'no_report' as const})};
const url=new URL('postgresql://driver_measurements_runtime@localhost/sim_driver_measurements');url.searchParams.set('host',`${root}/socket`);
let store=new PostgresDriverMeasurementStore(url.toString(),secret,options);disposables.push(async()=>{if(!(store as any).pool.ended)await store.close();});
const absentProof=new PostgresDriverAccountErasureStore(runtime,secret,{enabled:true,expectedCheckpoint:checkpoint,identityConfigured:true});
const hash=(value:string)=>driverErasureHash(secret,'cop',value);
const manifest=(label:string)=>{
 const operationId=randomUUID();const contributors=driverErasureRequiredDays(Date.now()).flatMap(day=>[1,2].map(version=>({contributorDay:day,contributorIdDay:`synthetic_${label}_v${version}_${day.replaceAll('-','')}`.padEnd(48,'x')})));
 const body=parseDriverErasureRequest({contractVersion:'sim-account-erasure-v1',operationId,contributors,attestation:'cop-account-erasure-contributors-reviewed-v1'});
 const actor={iss:'https://synthetic.invalid/realm',sub:`synthetic_raw_subject_${label}`,aud:'sim-account-erasure' as const,iat:0,exp:1,operationId,routerUserId:'cop_'+'a'.repeat(43)};
 return {body,actor,input:prepareDriverErasureInput(body,actor,secret)};
};
const a=manifest('a'),b=manifest('b');
const dataset='sim-routing-2026-10-14-1';const bucket=new Date(Math.floor(Date.now()/300000)*300000).toISOString();
const payload=(id:string)=>({contractVersion:'sim-driver-measurements-v1' as const,batchId:id,contributorIdDay:'transient_synthetic_id'.padEnd(40,'x'),contributorDay:bucket.slice(0,10),consent:{version:'traffic-quality-v1' as const,grantedAt:new Date().toISOString(),attestation:'cop-driver-consent-v1' as const},vehicleClass:'passenger_car' as const,points:[],eta:{observationId:randomUUID(),routingDataset:dataset,predictedDurationSeconds:100,actualDurationSeconds:120,plannedDistanceM:1000,actualDistanceM:1000,personalStopSeconds:0,estimatedSeconds:0,offRoute:false,completedAt:new Date().toISOString()}});
const receipt=(id:string)=>({contractVersion:'sim-driver-measurements-v1' as const,batchId:id,receivedAt:new Date().toISOString(),acceptedIntervalCount:2,deduplicatedIntervalCount:0,rejectionCounts:{},etaAccepted:true,applicationMode:'shadow_only' as const,rawPositionsStored:false as const});
const intervals=()=>[0,1].map(()=>({key:randomUUID(),dataset,edgeId:'8',windowStart:bucket,speedKph:36,distanceM:50,elapsedSeconds:5}));
const commit=async(contributor:string)=>{const id=randomUUID();const batch=payload(id);await store.commit('cop',contributor,'a'.repeat(64),batch,intervals(),receipt(id));return {id,batch};};
await check('driver schema repeat and runtime cannot change owner state, permanent fences or DDL',async()=>{
 for(const query of ['CREATE TABLE forbidden_test(id int)','UPDATE driver_account_erasure_state SET replay_ready=true','DELETE FROM driver_account_erasure_operations','DELETE FROM driver_account_erasure_revocations','TRUNCATE driver_measurement_receipts','ALTER TABLE driver_measurement_receipts DISABLE TRIGGER ALL','SET ROLE driver_measurements_migrator'])await reject(()=>runtime.query(query),'42501');
 assert.equal((await runtime.query("SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef")).rows[0].n,0);
});
await check('unreviewed new erase cannot create fence while initially empty ledger allows existing intake',async()=>{
 const cap=await absentProof.capability();assert.equal(cap.ready,false);await reject(()=>absentProof.erase(a.input),'DRIVER_ACCOUNT_ERASURE_NOT_READY');
 assert.equal((await runtime.query('SELECT count(*)::int AS n FROM driver_account_erasure_operations')).rows[0].n,0);
 await commit(a.input.contributors.at(-1)!.contributorHash);await commit(a.input.contributors.at(-2)!.contributorHash);await commit(hash('synthetic_other_author'));
});
await owner.query("UPDATE driver_account_erasure_state SET replay_ready=true,replay_checkpoint_hash=$1,proof_valid_until=now()+interval '1 hour',retention_reviewed=true,report_protection='no_report',publication_fence_verified=true",[driverErasureHash(secret,'cop:account-erasure-checkpoint',checkpoint)]);
await check('historical booleans alone are not readiness; current protected checkpoint plus exact rights is ready',async()=>{
 assert.equal((await absentProof.capability()).ready,false);const cap=await store.accountErasureCapability();assert.equal(cap.ready,true);assert.deepEqual(cap.blockers,[]);assert.ok(Object.values(cap.checks).every(Boolean));
 const ownerStore=new PostgresDriverAccountErasureStore(owner,secret,options);assert.equal((await ownerStore.capability()).checks.permissionsReady,false);
});
await check('read-only preflight accepts all versions and exact coverage without durable operation',async()=>{
 const before=(await runtime.query('SELECT count(*)::int AS n FROM driver_account_erasure_operations')).rows[0].n;const pre=await store.accountErasurePreflight(a.input);assert.equal(pre.ready,true);assert.equal(pre.mutates,false);assert.equal(pre.contributorCount,a.body.contributors.length);assert.equal(pre.coverageAnchor.kind,'checked_at');assert.equal(pre.coverageAnchor.at,pre.checkedAt);
 assert.equal((await runtime.query('SELECT count(*)::int AS n FROM driver_account_erasure_operations')).rows[0].n,before);
 await reject(()=>store.accountErasurePreflight({...b.input,contributors:b.input.contributors.slice(2)}),'DRIVER_ACCOUNT_ERASURE_INCOMPLETE_MANIFEST');
});
await check('erase cascades only target author, waits for acknowledgement and is idempotent',async()=>{
 const pending=await store.accountErasure(a.input);assert.equal(pending.status,'pending');assert.equal(pending.deletedBatchCount,2);assert.equal(pending.pendingReason,'derived_report_pending');const done=await store.acknowledgeAccountErasure(a.input);assert.equal(done.status,'completed');assert.equal(done.wholeAccountComplete,false);
 const repeated=await store.accountErasure(a.input);const done2=await store.acknowledgeAccountErasure(a.input);assert.equal(repeated.deletedBatchCount,2);assert.equal(done2.acceptedAt,done.acceptedAt);
 assert.equal((await runtime.query('SELECT count(*)::int AS n FROM driver_measurement_receipts')).rows[0].n,1);assert.equal((await runtime.query('SELECT count(*)::int AS n FROM driver_measurement_intervals')).rows[0].n,2);assert.equal((await runtime.query('SELECT count(*)::int AS n FROM driver_measurement_eta')).rows[0].n,1);
});
await check('cross actor is invisible and same actor body digest conflict does not advance',async()=>{
 assert.equal(await store.accountErasureStatus(a.input.operationId,b.input.actorHash),undefined);assert.equal(await store.accountErasureStatus(randomUUID(),a.input.actorHash),undefined);
 await reject(()=>store.accountErasure({...a.input,actorHash:b.input.actorHash}),'DRIVER_ACCOUNT_ERASURE_NOT_FOUND');await reject(()=>store.accountErasure({...a.input,requestHash:'b'.repeat(64)}),'DRIVER_ACCOUNT_ERASURE_CONFLICT');
});
await check('completed erasure rejects late writes and raw legacy writer',async()=>{
 await reject(()=>commit(a.input.contributors.at(-1)!.contributorHash),'DRIVER_CONSENT_REVOKED');
 await reject(()=>runtime.query("INSERT INTO driver_measurement_receipts(owner,batch_id,contributor_hash,request_hash,received_at,expires_at,receipt) VALUES('cop',$1,$2,$3,now(),now()+interval '7 days','{}')",[randomUUID(),hash('synthetic_unfenced_legacy'),'a'.repeat(64)]),'23514');
});
await check('concurrent commit and erase share contributor locks and final rows are zero',async()=>{
 const contributor=b.input.contributors.at(-1)!.contributorHash;await commit(contributor);const guard=await admin.connect();await guard.query('BEGIN');await guard.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`cop:${contributor}`]);
 const outcomes=Promise.allSettled([commit(contributor),store.accountErasure(b.input)]);await new Promise(resolve=>setTimeout(resolve,100));await guard.query('COMMIT');guard.release();const settled=await outcomes;assert.equal(settled[1].status,'fulfilled');assert.equal((await runtime.query('SELECT count(*)::int AS n FROM driver_measurement_receipts WHERE contributor_hash=$1',[contributor])).rows[0].n,0);assert.equal((await store.acknowledgeAccountErasure(b.input)).status,'completed');
});
await check('disabled endpoint allows accepted cleanup but cannot create a new operation',async()=>{
 const off=new PostgresDriverAccountErasureStore(runtime,secret,{...options,enabled:false});assert.equal((await off.capability()).ready,false);await reject(()=>off.erase(manifest('c').input),'DRIVER_ACCOUNT_ERASURE_NOT_READY');await off.erase(a.input);assert.equal((await off.acknowledge(a.input)).status,'completed');
});
await check('restart and restored historical readiness do not bypass current checkpoint',async()=>{
 await store.close();proofCurrent=false;store=new PostgresDriverMeasurementStore(url.toString(),secret,options);const status=await store.accountErasureStatus(a.input.operationId,a.input.actorHash);assert.equal(status?.status,'pending');assert.equal(status?.pendingReason,'replay_review_required');await reject(()=>commit(hash('synthetic_other_author')),'DRIVER_ACCOUNT_ERASURE_REPLAY_REQUIRED');
 proofCurrent=true;assert.equal((await store.accountErasureStatus(a.input.operationId,a.input.actorHash))?.status,'completed');
 await owner.query("UPDATE driver_account_erasure_state SET proof_valid_until=now()-interval '1 minute'");assert.equal((await store.accountErasureStatus(a.input.operationId,a.input.actorHash))?.status,'pending');await reject(()=>commit(hash('synthetic_other_author')),'DRIVER_ACCOUNT_ERASURE_REPLAY_REQUIRED');
 await owner.query("UPDATE driver_account_erasure_state SET proof_valid_until=now()+interval '1 hour'");
});
await check('database stores no raw manifest, subject, batch identity or account-to-day join',async()=>{
 const rows=await admin.query("SELECT row_to_json(t)::text AS json FROM driver_account_erasure_operations t UNION ALL SELECT row_to_json(t)::text FROM driver_account_erasure_revocations t UNION ALL SELECT row_to_json(t)::text FROM driver_measurement_receipts t");const value=rows.rows.map((r:any)=>r.json).join('\n');for(const raw of [a.actor.sub,a.actor.routerUserId,a.body.operationId,...a.body.contributors.map(c=>c.contributorIdDay)])assert.ok(!value.includes(raw));
 const cols=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_name IN ('driver_account_erasure_operations','driver_account_erasure_revocations')");assert.ok(cols.rows.every((r:any)=>!['sub','router_user_id','contributor_day','manifest','contributors'].includes(r.column_name)));
});
await check('UTC expiry window requires next-day tolerance and does not reuse stale preflight authorization',async()=>{
 const at=Date.parse('2026-10-14T23:59:45Z');assert.equal(driverErasureRequiredDays(at).length,10);assert.equal(driverErasureRequiredDays(at-60000).length,9);const synthetic={...a.input,contributors:driverErasureRequiredDays(at-60000).map(day=>({contributorDay:day,contributorHash:hash(day)}))};await reject(async()=>validateDriverErasureCoverage(synthetic,at),'DRIVER_ACCOUNT_ERASURE_INCOMPLETE_MANIFEST');
});

  return passed;
}
async function aiBehavior() {
  const { admin, owner, runtime } = await makeContext("sim_ai_router");
// Teardown only the operation installed by our prior SQL/RLS rollback fixture.
await owner.query("DELETE FROM ai_router_account_erasure WHERE owner_hash=$1 AND target_hash=$2",['5'.repeat(64),'1'.repeat(64)]);
const checkpointId=randomUUID();await owner.query("UPDATE ai_router_erasure_checkpoint SET identity_reviewed=true,replay_ready=true,cost_policy='aggregate-costs-current-month-v1',checkpoint_id=$1,checkpoint_generation=42",[checkpointId]);
let currentProof=true;
const pinnedSchema=(await admin.query(`SELECT encode(sha256(convert_to(COALESCE(string_agg(definition,E'\n' ORDER BY definition),''),'UTF8')),'hex') AS digest FROM (
 SELECT pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('ai_router_cop_erasure_fence','ai_router_erasure_delete_scope','ai_router_erasure_operation_immutable')
 UNION ALL SELECT pg_get_triggerdef(oid) || ':' || tgenabled::text FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'ai_router_%erasure%'
 UNION ALL SELECT tablename || ':' || policyname || ':' || cmd || ':' || COALESCE(qual,'') || ':' || COALESCE(with_check,'') FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'router_%'
 ) definitions`)).rows[0].digest;
// Synthetic isolated owner readback, NOT a production backup/restore proof.
const verifier=async(cp:any)=>{
 if(!currentProof||cp.checkpoint_id!==checkpointId||cp.checkpoint_generation!=='42'||cp.schema_digest!==pinnedSchema)return false;
 const rows=await admin.query('SELECT operation_id,owner_hash,target_hash,body_digest,status FROM ai_router_account_erasure ORDER BY operation_id');
 const expected=createHash('sha256').update(rows.rows.map((r:any)=>[r.operation_id,r.owner_hash,r.target_hash,r.body_digest,r.status].join(':')).join('\n')).digest('hex');return cp.operation_digest===expected;
};
let eraser=new PgAccountErasure(runtime,'aggregate-costs-current-month-v1',true,verifier);
const absentProof=new PgAccountErasure(runtime,'aggregate-costs-current-month-v1',true);
const url=new URL('postgresql://ai_router_runtime@localhost/sim_ai_router');url.searchParams.set('host',`${root}/socket`);
const budgetSecret=randomBytes(32).toString('hex'),copSecret=randomBytes(32).toString('hex');
const budget=new BudgetStore(url.toString(),budgetSecret,{dailyMicrousd:1000000,monthlyMicrousd:1000000,perUserDailyRequests:3});budget.accountErasure=eraser;disposables.push(async()=>{if(!budget.pool.ended)await budget.close();});await budget.init();
const separate=new PgSeparateBilling(runtime,Buffer.alloc(32,7).toString('base64'),eraser);
const user=(label:string)=>{const sub=`raw synthetic subject ${label}`,alias='cop_'+createHmac('sha256',copSecret).update('cop-router-chat-v1\0'+sub).digest('base64url'),op=randomUUID(),actor={iss:'https://synthetic.invalid/realm',sub,aud:'sim-account-erasure' as const,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+60,operationId:op,routerUserId:alias};return {sub,alias,op,actor,identity:erasureIdentity(actor,budgetSecret,budget.hashUser.bind(budget))};};
const a=user('finance-a'),b=user('key-race-b'),c=user('orphan-c'),d=user('reserve-race-d'),e=user('limits-e');
const lim={dailyMicrousd:1000000,monthlyMicrousd:1000000,dailyRequests:3};
let passed=0;const check=async(name:string,fn:()=>Promise<void>)=>{await fn();passed++;console.log(`PASS ${name}`);};
const reject=async(fn:()=>Promise<any>,code?:string)=>{try{await fn();assert.fail('Expected rejection');}catch(e:any){if(e.code==='ERR_ASSERTION')throw e;if(code)assert.equal(e.code,code);}};
const snapshots=async()=>({legacy:await budget.usage(),billing:await separate.usage()});
const reserveLegacy=(u:any,cost=100)=>budget.reserve('cop',u.alias,'cop_chat','no_provider','synthetic','low','local_fast',cost);
const reserveByok=(u:any,cost=100)=>separate.reserve('user_openai_key',u.identity.targetHash,u.identity.targetHash,'synthetic_fingerprint',null,'cop_chat','no_provider',cost,lim);
await check('default owner verifier is fail closed, no new fence; explicit synthetic current proof can pass',async()=>{
 assert.equal((await absentProof.capability(true)).ready,false);assert.equal((await eraser.capability(true)).ready,true);await reject(()=>absentProof.request(a.identity,a.op),'erasure_review_required');assert.equal(await eraser.status(a.identity,a.op),null);
});
await check('exact raw subject identity targets existing ordinary COP opaque alias, never raw subject or IZS hash',async()=>{
 assert.equal(a.identity.targetHash,budget.hashUser('cop',a.alias));assert.notEqual(a.identity.targetHash,budget.hashUser('cop',a.sub));assert.notEqual(a.identity.targetHash,budget.hashUser('izs',a.alias));
 const encoded=Buffer.from(JSON.stringify(a.actor)).toString('base64url'),secret=randomBytes(32).toString('hex'),signature=createHmac('sha256',secret).update(encoded).digest('hex');const req={header:(name:string)=>name==='x-cop-actor'?encoded:signature};assert.deepEqual(verifyErasureActor(req as any,secret,a.actor.iss,a.op),a.actor);
 const bad={...a.actor,sub:'control\u0085subject'},badEncoded=Buffer.from(JSON.stringify(bad)).toString('base64url'),badSig=createHmac('sha256',secret).update(badEncoded).digest('hex');assert.equal(verifyErasureActor({header:(name:string)=>name==='x-cop-actor'?badEncoded:badSig} as any,secret,a.actor.iss,a.op),null);
});
await check('each required grant is checked; a missing INSERT is not hidden by SELECT',async()=>{
 await owner.query('REVOKE INSERT ON ai_router_account_erasure FROM ai_router_runtime');try{const cap=await eraser.capability(true);assert.equal(cap.checks.permissionsReady,false);assert.equal(cap.ready,false);await reject(()=>eraser.request(a.identity,a.op),'erasure_review_required');assert.equal(await eraser.status(a.identity,a.op),null);}finally{await owner.query('GRANT INSERT ON ai_router_account_erasure TO ai_router_runtime');}
});
await check('a missing history DELETE makes capability and first acceptance fail closed',async()=>{
 await owner.query('REVOKE DELETE ON ai_router_request FROM ai_router_runtime');try{const cap=await eraser.capability(true);assert.equal(cap.checks.permissionsReady,false);assert.equal(cap.ready,false);await reject(()=>eraser.request(a.identity,a.op),'erasure_review_required');assert.equal(await eraser.status(a.identity,a.op),null);}finally{await owner.query('GRANT DELETE ON ai_router_request TO ai_router_runtime');}
});
await check('disabled required trigger invalidates schema proof before any new fence',async()=>{
 await owner.query('ALTER TABLE ai_router_request DISABLE TRIGGER ai_router_request_erasure_fence');try{const cap=await eraser.capability(true);assert.equal(cap.checks.schemaReady,false);assert.equal(cap.ready,false);await reject(()=>eraser.request(a.identity,a.op),'erasure_review_required');assert.equal(await eraser.status(a.identity,a.op),null);}finally{await owner.query('ALTER TABLE ai_router_request ENABLE TRIGGER ai_router_request_erasure_fence');}
});
await separate.putKey(a.identity.targetHash,'synthetic-key-a-never-called');await separate.putKey(b.identity.targetHash,'synthetic-key-b-never-called');
await check('preflight is read only and one chat account can replace/remove only its own key',async()=>{
 const count=(await runtime.query('SELECT count(*)::int AS n FROM ai_router_account_erasure')).rows[0].n;const pre=await eraser.preflight(a.identity,a.op,true);assert.equal(pre?.ready,true);assert.equal(pre?.mutates,false);assert.equal(pre?.checks.providerRequestsSettled,true);assert.equal((await runtime.query('SELECT count(*)::int AS n FROM ai_router_account_erasure')).rows[0].n,count);
 await separate.putKey(a.identity.targetHash,'synthetic-key-a-replaced-never-called');assert.equal((await separate.getKey(b.identity.targetHash))?.apiKey,'synthetic-key-b-never-called');
});
for(let i=0;i<2;i++){const id=await reserveLegacy(a);await budget.finish(id,'success',5,7,80);const bid=await reserveByok(a);await separate.finish(bid,'success',5,7,80);}
const preservedBefore=(await runtime.query("SELECT (SELECT count(*) FROM ai_router_request WHERE client_id IN ('sim','izs')) AS legacy,(SELECT count(*) FROM ai_router_billing_request WHERE billing_source='sim_project') AS project,(SELECT count(*) FROM ai_router_user_key WHERE user_hash=$1) AS key",['3'.repeat(64)])).rows[0];
await check('erasure atomically carries costs/tokens/counts forward without resetting limits and preserves SIM/IZS',async()=>{
 const before=await snapshots();const done=await eraser.request(a.identity,a.op);assert.equal(done.status,'online_complete');assert.equal(done.wholeAccountComplete,false);assert.equal(done.aliasScope,'sim_izs_preserved_out_of_scope');assert.deepEqual(await snapshots(),before);
 const after=(await runtime.query("SELECT (SELECT count(*) FROM ai_router_request WHERE client_id IN ('sim','izs')) AS legacy,(SELECT count(*) FROM ai_router_billing_request WHERE billing_source='sim_project') AS project,(SELECT count(*) FROM ai_router_user_key WHERE user_hash=$1) AS key",['3'.repeat(64)])).rows[0];assert.deepEqual(after,preservedBefore);assert.equal((await separate.getKey(b.identity.targetHash))?.apiKey,'synthetic-key-b-never-called');
});
await check('retries do not duplicate carry-forward; foreign actor has no receipt or preflight disclosure',async()=>{
 const before=await snapshots();await eraser.request(a.identity,a.op);await eraser.processPending();assert.deepEqual(await snapshots(),before);assert.equal(await eraser.status(b.identity,a.op),null);assert.equal(await eraser.preflight(b.identity,a.op,true),null);await reject(()=>eraser.request({...a.identity,ownerHash:b.identity.ownerHash},a.op),'erasure_operation_not_found');
});
await check('erased BYOK lane totals never charge another payer or reset that payer limits',async()=>{
 const id=await separate.reserve('user_openai_key',b.identity.targetHash,b.identity.targetHash,'synthetic_fingerprint',null,'cop_chat','no_provider',100,{dailyMicrousd:100,monthlyMicrousd:100,dailyRequests:3});await separate.finish(id,'success',5,7,80);
 await reject(()=>separate.reserve('user_openai_key',b.identity.targetHash,b.identity.targetHash,'synthetic_fingerprint',null,'cop_chat','no_provider',21,{dailyMicrousd:100,monthlyMicrousd:100,dailyRequests:3}),'daily_budget_exceeded');
});
await check('permanent fence blocks key PUT, GET and both new reservation paths',async()=>{
 await reject(()=>separate.putKey(a.identity.targetHash,'late-synthetic-key'),'account_erased');await reject(()=>separate.getKey(a.identity.targetHash),'account_erased');await reject(()=>reserveLegacy(a),'account_erased');await reject(()=>reserveByok(a),'account_erased');
});
await check('actual concurrent PUT and erasure cannot restore an erased key',async()=>{
 const lock=await admin.connect();await lock.query('BEGIN');await lock.query('SELECT pg_advisory_xact_lock(634020,hashtext($1))',[b.identity.targetHash]);const outcomes=Promise.allSettled([separate.putKey(b.identity.targetHash,'racing-synthetic-key'),eraser.request(b.identity,b.op)]);await new Promise(r=>setTimeout(r,100));await lock.query('COMMIT');lock.release();const settled=await outcomes;assert.equal(settled[1].status,'fulfilled');assert.equal((await runtime.query('SELECT count(*)::int AS n FROM ai_router_user_key WHERE user_hash=$1',[b.identity.targetHash])).rows[0].n,0);
});
await check('reserved and uncertain work remains pending; only actual settlement can complete',async()=>{
 const id=await reserveByok(c);const pending=await eraser.request(c.identity,c.op);assert.equal(pending.status,'pending');assert.equal(pending.onlineScopeComplete,false);assert.equal(pending.pendingRequestCount,1);assert.ok(pending.pendingReasons.includes('provider_requests_pending'));const pre=await eraser.preflight(c.identity,c.op,true);assert.equal(pre?.ready,false);assert.equal(pre?.checks.providerRequestsSettled,false);await separate.finish(id,'uncertain',undefined,undefined,undefined,'synthetic_uncertain');await eraser.processPending();assert.equal((await eraser.status(c.identity,c.op))?.status,'pending');
 // Explicit synthetic owner settlement. A time-based cleanup never performs this.
 await owner.query("UPDATE ai_router_billing_request SET status='success',estimated_microusd=80,input_tokens=5,output_tokens=7,completed_at=now() WHERE id=$1 AND status='uncertain'",[id]);const before=await snapshots();await eraser.processPending();assert.equal((await eraser.status(c.identity,c.op))?.status,'online_complete');assert.deepEqual(await snapshots(),before);
});
await check('actual reservation/erase race has no deadlock and late settlement keeps costs',async()=>{
 const lock=await admin.connect();await lock.query('BEGIN');await lock.query('SELECT pg_advisory_xact_lock(634020,hashtext($1))',[d.identity.targetHash]);const outcomes=Promise.allSettled([reserveLegacy(d,100),eraser.request(d.identity,d.op)]);await new Promise(r=>setTimeout(r,100));await lock.query('COMMIT');lock.release();const settled=await outcomes;assert.equal(settled[1].status,'fulfilled');if(settled[0].status==='fulfilled'){await budget.finish(settled[0].value,'success',5,7,80);const before=await snapshots();await eraser.processPending();assert.deepEqual(await snapshots(),before);}assert.equal((await eraser.status(d.identity,d.op))?.status,'online_complete');
});
await check('daily per-user, daily-money and monthly-money limits still reject',async()=>{
 for(let i=0;i<3;i++){const id=await reserveLegacy(e,1);await budget.finish(id,'success',0,0,1);}await reject(()=>reserveLegacy(e,1),'user_daily_limit_exceeded');
 const usage=await budget.usage();const preservedSimReserve=()=>budget.reserve('sim','synthetic-preserved-SIM-user','source_health','no_provider','synthetic','low','local_fast',1);await owner.query('UPDATE ai_router_policy SET daily_microusd=$1,monthly_microusd=1000000,per_user_daily_requests=3 WHERE id=1',[usage.dailyMicrousd]);await reject(preservedSimReserve,'daily_budget_exceeded');await owner.query('UPDATE ai_router_policy SET daily_microusd=1000000,monthly_microusd=$1 WHERE id=1',[usage.monthlyMicrousd]);await reject(preservedSimReserve,'monthly_budget_exceeded');await owner.query('UPDATE ai_router_policy SET daily_microusd=1000000,monthly_microusd=1000000 WHERE id=1');
});
await check('restart with stale owner proof cannot expose a completed receipt or start a new fence',async()=>{
 currentProof=false;eraser=new PgAccountErasure(runtime,'aggregate-costs-current-month-v1',true,verifier);assert.equal((await eraser.capability(true)).ready,false);await reject(()=>eraser.status(a.identity,a.op));const f=user('stale-proof');await reject(()=>eraser.request(f.identity,f.op),'erasure_review_required');assert.equal(await eraser.status(f.identity,f.op),null);currentProof=true;assert.equal((await eraser.status(a.identity,a.op))?.onlineScopeComplete,true);
});
await check('expired prior-month rollup cannot disappear until all relevant reservations settle',async()=>{
 const row=(await admin.query("SELECT (date_trunc('month',now() AT TIME ZONE 'UTC')-interval '1 day')::date::text AS day,date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS expiry")).rows[0];const pendingId=randomUUID();await owner.query("INSERT INTO ai_router_erased_cost_daily(billing_lane,usage_day,cost_microusd,request_count,input_tokens,output_tokens,expires_at) VALUES('legacy',$1,80,1,5,7,$2)",[row.day,row.expiry]);const tx=await admin.connect();await tx.query('BEGIN');await tx.query("SELECT set_config('sim.router_erasure_code_version','1',true)");await tx.query("INSERT INTO ai_router_request(id,client_id,user_hash,task_type,model,routing_reason,difficulty,status,reserved_microusd,created_at) VALUES($1,'cop',$2,'cop_chat','no_provider','synthetic','low','reserved',100,$3::date::timestamp AT TIME ZONE 'UTC')",[pendingId,'7'.repeat(64),row.day]);await tx.query('COMMIT');tx.release();assert.equal((await runtime.query("DELETE FROM ai_router_erased_cost_daily WHERE billing_lane='legacy' AND usage_day=$1",[row.day])).rowCount,0);await budget.finish(pendingId,'success',5,7,80);assert.equal((await runtime.query("DELETE FROM ai_router_erased_cost_daily WHERE billing_lane='legacy' AND usage_day=$1",[row.day])).rowCount,1);
});
await check('cost carry-forward stores only day/lane totals and no account joins, while replay fence is explicit',async()=>{
 const cols=(await admin.query("SELECT column_name FROM information_schema.columns WHERE table_name='ai_router_erased_cost_daily'")).rows.map((r:any)=>r.column_name).sort();assert.deepEqual(cols,['billing_lane','cost_microusd','expires_at','input_tokens','output_tokens','request_count','usage_day']);const rows=(await admin.query('SELECT row_to_json(t)::text AS json FROM ai_router_erased_cost_daily t')).rows.map((r:any)=>r.json).join('\n');for(const raw of [a.sub,a.alias,a.op,a.identity.targetHash,a.identity.ownerHash])assert.ok(!rows.includes(raw));
});

  return passed;
}

try {
  assertOwned();
  await execute(join(pgBin, "initdb"), ["-D", join(root, "data"), "--username=synthetic_admin", "--auth-local=trust", "--auth-host=reject", "--encoding=UTF8", "--locale=C"], { env: cleanEnv, timeout: 30000 });
  await execute(join(pgBin, "pg_ctl"), ["-D", join(root, "data"), "-l", join(root, "server.log"), "-o", `-k ${join(root, "socket")} -c listen_addresses='' -c unix_socket_permissions=0700 -c log_statement=none -c log_min_error_statement=panic`, "-w", "start"], { env: cleanEnv, timeout: 15000 });
  started = true;
  const beforeMigration = await baseline();
  const sqlPrivileges = await aiSqlSecurity();
  const driver = await driverBehavior();
  const ai = await aiBehavior();
  assert.equal(providerCalls, 0);
  successful = true;
  console.log(JSON.stringify({ scope: "isolated_synthetic_postgresql_18_3", beforeMigration, sqlPrivileges, driver, ai, passed: beforeMigration + sqlPrivileges + driver + ai, providerCalls, productionChanged: false, ownerProof: "synthetic_local_fixture_only", physicalRestoreAcceptance: false, migrations: migrationPins }));
} finally {
  await shutdownOnce();
}
