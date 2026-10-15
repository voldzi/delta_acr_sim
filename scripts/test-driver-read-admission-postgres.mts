/**
 * SOURCE-ONLY, read-admission SQL facts in a NEW owned PostgreSQL 18.3 cluster.
 * Unix socket only; no external target, credential, provider, production role,
 * Root record/signature, accepted delivery or positive admission is supplied.
 * The frozen eighteen-case guarded SQL evidence is read/pinned, never rerun or
 * overwritten. Main must review this whole source and final 004 pin before run.
 */
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {existsSync,realpathSync,statSync} from "node:fs";
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

if(process.argv.length!==3||process.argv[2]!=="--run"){
  console.error("Only --run is accepted; target is a new owned synthetic Unix-only PostgreSQL 18.3 cluster.");process.exit(2);
}
const repo=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const selfPath=fileURLToPath(import.meta.url);
const hash=(text:string|Buffer)=>createHash("sha256").update(text).digest("hex");
const initialSelfHash=hash(await readFile(selfPath));
const reportPath=join(repo,"docs/archive/2026-10-15_DRIVER_READ_ADMISSION_SQL.json");
assert.ok(!existsSync(reportPath),"A source evidence receipt must not be overwritten.");
const inputs:Record<string,string>={
  "deploy/driver-measurements/schema.sql":"6dd60a3acf28d63575198c8526c368df19bbd543f4063d4985fb55f308da02d0",
  "deploy/driver-measurements/002_account_erasure.sql":"f13db2106a1fe1a02d0d1a26afa8ad7d7c045172ba4419749719ed0f166e16ad",
  "deploy/driver-measurements/003_guarded_operations.sql":"e3513a983a3b6d1bd52d46851c734dd1c3b208e2e2f6430a6f9eddd38b10d3b5",
  "deploy/driver-measurements/004_read_admission_facts.sql":"791545b9df91e65bb555c68a44dadd73a847ca64fde0c31a9036f9f555ba1d2d",
};
const frozenInputs:Record<string,string>={
  "scripts/test-driver-guarded-operations-postgres.mts":"547c0486f7a902c6bd4b920139b50178de392f2b3f91f27f3b1d177becf80e97",
  "docs/archive/2026-10-15_DRIVER_GUARDED_OPERATIONS_SQL.json":"80ea5fb1a4e914a5439dba901bfee528c1136c1ed812aee9c7bfb82ebe869c42",
  "scripts/test-driver-expiry-real-schema.mts":"61ff2bfe5b3510fa0c8d4a2be61bc8cea83fb798695d35713b0681634f5e2b6f",
  "scripts/fixtures/driver-retention-real-schema/expiry-source.sql":"1561825849c8990526af26eae3866ee2100072db72bed638997a2eec7a8afb7a",
  "docs/archive/2026-10-14_DRIVER_EXPIRY_REAL_SCHEMA.json":"8dac0d99b4add01446b05e8fdc6cd752f5d754328754fc46fe5848b954841396",
};
const sourceText:Record<string,string>={};
for(const [path,pin] of Object.entries({...inputs,...frozenInputs})){
  assert.match(pin,/^[a-f0-9]{64}$/u,`Source is not reviewed/pinned: ${path}`);
  const bytes=await readFile(join(repo,path));assert.equal(hash(bytes),pin,`Unreviewed source: ${path}`);sourceText[path]=bytes.toString("utf8");
}
const pgBin="/opt/homebrew/opt/postgresql@18/bin",execute=promisify(execFile);
const cleanEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>["PATH","HOME","USER","LOGNAME","LANG","LC_ALL","TMPDIR"].includes(key)));
for(const key of Object.keys(process.env))if(/^PG|DATABASE_URL$|OPENAI|API_KEY|SECRET|TOKEN/u.test(key))delete process.env[key];
assert.match((await execute(join(pgBin,"postgres"),["--version"],{env:cleanEnv})).stdout,/^postgres \(PostgreSQL\) 18\.3(?:\s|$)/u);
const require=createRequire(join(repo,"apps/situation-data-api/package.json"));
const {Pool}=require("pg");
const tmp=realpathSync("/private/tmp");assert.equal(tmp,"/private/tmp");
const previousUmask=process.umask(0o077),root=await mkdtemp(join(tmp,"sim-driver-read-facts-pg-"));
await chmod(root,0o700);await mkdir(join(root,"socket"),{mode:0o700});
const owned=()=>{
  assert.equal(dirname(realpathSync(root)),tmp);assert.ok(realpathSync(root).startsWith(join(tmp,"sim-driver-read-facts-pg-")));
  for(const path of [root,join(root,"socket")]){assert.equal(statSync(path).uid,process.getuid!());assert.equal(statSync(path).mode&0o777,0o700);}
};
owned();
const pools:any[]=[],activeClients=new Set<any>();
const pool=(user:string,database="sim_driver_measurements")=>{
  const p=new Pool({host:join(root,"socket"),database,user,port:5432,max:4,connectionTimeoutMillis:2000,statement_timeout:5000});pools.push(p);return p;
};
const events:Array<{case:string;passed:boolean}>=[],startedAt=new Date().toISOString();
let started=false,success=false,providerCalls=0;
let admin:any,control:any,runtime:any,executor:any;
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{providerCalls++;throw new Error("Provider/network access is forbidden in this source test.");};
const store="00000000-0000-4000-8000-000000000021",origin="10000000-0000-4000-8000-000000000021";
const operationHash=hash("read-facts synthetic operation"),actorHash=hash("read-facts synthetic actor"),requestHash=hash("read-facts synthetic request");
const checkpointHash=hash("read-facts synthetic checkpoint, NOT Root proof"),contributorHash=hash("read-facts synthetic daily contributor");
const otherOperationHash=hash("read-facts unrelated operation"),otherActorHash=hash("read-facts unrelated actor");
const privateCanary="synthetic-private-receipt-canary-must-not-be-returned";
const createdAt="2026-10-10T12:00:00.000Z",updatedAt="2026-10-11T12:00:00.000Z";
const value=async(p:any,sql:string,parameters:unknown[]=[])=> (await p.query(sql,parameters)).rows[0].value;
const acquire=async(p:any)=>{const c=await p.connect();activeClients.add(c);return c;};
const release=async(c:any)=>{await c.query("ROLLBACK").catch(()=>undefined);c.release();activeClients.delete(c);};
const denied=async(fn:()=>Promise<unknown>,code:string)=>{
  try{await fn();assert.fail("Expected fixed SQL rejection");}catch(error:any){if(error.code==="ERR_ASSERTION")throw error;assert.equal(error.code,code);}
};
type Purpose="capability"|"intake"|"preflight"|"status"|"receipt";
const purposes:Purpose[]=["capability","intake","preflight","status","receipt"];
const request=(purpose:Purpose)=>({owner:"sim_driver_measurements",scope:"online_driver_scope",purpose,
  ...(["preflight","status","receipt"].includes(purpose)?{operationHash,actorHash}:{})});
const readOn=(c:any,body:unknown)=>value(c,"SELECT sim_driver_guard_source.read_admission_facts($1::jsonb) AS value",[JSON.stringify(body)]);
const facts=async(body:unknown=request("capability"),p:any=control)=>{
  const c=await acquire(p);try{await c.query("BEGIN READ ONLY");return await readOn(c,body);}finally{await release(c);}
};
const exact=(object:any,keys:string[])=>{assert.ok(object!==null&&typeof object==="object"&&!Array.isArray(object));assert.deepEqual(Object.keys(object).sort(),[...keys].sort());};
const timestamp=(text:any)=>{assert.equal(typeof text,"string");assert.match(text,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);assert.equal(new Date(text).toISOString(),text);};
const assertFacts=(f:any,body:unknown)=>{
  exact(f,["contractVersion","request","observedAtUTC","storeIncarnation","state","schema","privileges","operation"]);
  assert.equal(f.contractVersion,"sim-driver-read-facts-v1");assert.deepEqual(f.request,body);timestamp(f.observedAtUTC);
  assert.ok(f.storeIncarnation===null||/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(f.storeIncarnation));
  exact(f.state,["checkpointHash","replayReady","proofValidUntilUTC","proofCurrent","retentionReviewed","reportProtection","publicationFenceVerified"]);
  assert.ok(f.state.checkpointHash===null||/^[a-f0-9]{64}$/u.test(f.state.checkpointHash));
  if(f.state.proofValidUntilUTC!==null)timestamp(f.state.proofValidUntilUTC);
  for(const key of ["replayReady","proofCurrent","retentionReviewed","publicationFenceVerified"])assert.equal(typeof f.state[key],"boolean");
  assert.ok(["unverified","no_report","enforced_single_writer","shared_generation_fence"].includes(f.state.reportProtection));
  exact(f.schema,["ready","fingerprint"]);assert.equal(typeof f.schema.ready,"boolean");assert.match(f.schema.fingerprint,/^[a-f0-9]{64}$/u);
  exact(f.privileges,["runtimeProfileMatches","fingerprint"]);assert.equal(typeof f.privileges.runtimeProfileMatches,"boolean");assert.match(f.privileges.fingerprint,/^[a-f0-9]{64}$/u);
  if(f.operation!==null){
    exact(f.operation,["operationHash","actorHash","requestHash","contributorCount","status","createdAtUTC","updatedAtUTC","deletedBatchCount","remainingBatchCount",
      "databaseZeroVerified","derivedReportAcknowledged","replayCheckpointHash","ledgerDigest"]);
    for(const key of ["operationHash","actorHash","requestHash","ledgerDigest"])assert.match(f.operation[key],/^[a-f0-9]{64}$/u);
    for(const key of ["contributorCount","deletedBatchCount","remainingBatchCount"])assert.ok(Number.isInteger(f.operation[key])&&f.operation[key]>=0);
    assert.ok(["pending","completed"].includes(f.operation.status));timestamp(f.operation.createdAtUTC);timestamp(f.operation.updatedAtUTC);
    assert.equal(typeof f.operation.databaseZeroVerified,"boolean");assert.equal(typeof f.operation.derivedReportAcknowledged,"boolean");
    assert.ok(f.operation.replayCheckpointHash===null||/^[a-f0-9]{64}$/u.test(f.operation.replayCheckpointHash));
  }
  const serialized=JSON.stringify(f);assert.ok(!serialized.includes(privateCanary));
  for(const key of ["contributorHash","contributorDay","contributors","manifest","latitude","longitude","receipt","intervals","sql","query"])
    assert.ok(!new RegExp(`"${key}"\\s*:`,"u").test(serialized),`Forbidden data/projection key: ${key}`);
};
const effects=()=>value(admin,`SELECT jsonb_build_object(
  'receipts',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,batch_id),'[]') FROM driver_measurement_receipts t),
  'intervals',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,measurement_key),'[]') FROM driver_measurement_intervals t),
  'eta',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,batch_id),'[]') FROM driver_measurement_eta t),
  'temporaryFences',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,contributor_hash),'[]') FROM driver_measurement_revocations t),
  'state',(SELECT to_jsonb(t) FROM driver_account_erasure_state t WHERE singleton),
  'operations',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY operation_hash),'[]') FROM driver_account_erasure_operations t),
  'permanentFences',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY owner,contributor_hash),'[]') FROM driver_account_erasure_revocations t),
  'origins',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY operation_id),'[]') FROM sim_driver_guard_source.origins t),
  'store',(SELECT to_jsonb(t) FROM sim_driver_guard_source.store_binding t WHERE singleton)) AS value`);
const originalSchema=()=>value(admin,`SELECT jsonb_build_object(
  'tables',(SELECT jsonb_agg(jsonb_build_object('name',tablename,'owner',tableowner) ORDER BY tablename) FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'driver_%'),
  'guard',(SELECT pg_get_functiondef('public.driver_account_erasure_receipt_guard()'::regprocedure)),
  'trigger',(SELECT pg_get_triggerdef(oid)||':'||tgenabled::text FROM pg_trigger WHERE tgname='driver_account_erasure_receipt_guard' AND NOT tgisinternal),
  'constraints',(SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY conrelid::regclass::text,conname) FROM pg_constraint
    WHERE conrelid IN ('driver_measurement_receipts'::regclass,'driver_measurement_intervals'::regclass,'driver_measurement_eta'::regclass,
      'driver_measurement_revocations'::regclass,'driver_account_erasure_state'::regclass,'driver_account_erasure_operations'::regclass,'driver_account_erasure_revocations'::regclass))) AS value`);
let schemaBefore:unknown;
const seed=async()=>{
  await admin.query(`TRUNCATE driver_measurement_receipts,driver_measurement_intervals,driver_measurement_eta,driver_measurement_revocations,
    driver_account_erasure_operations,driver_account_erasure_revocations,sim_driver_guard_source.origins,sim_driver_guard_source.store_binding`);
  await admin.query(`INSERT INTO driver_account_erasure_state(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING;
    UPDATE driver_account_erasure_state SET replay_ready=true,proof_valid_until=clock_timestamp()+interval '1 hour',retention_reviewed=true,
      report_protection='no_report',publication_fence_verified=true,replay_checkpoint_hash='${checkpointHash}' WHERE singleton`);
  await admin.query("INSERT INTO sim_driver_guard_source.store_binding VALUES(true,$1)",[store]);
  await admin.query(`INSERT INTO driver_measurement_receipts(owner,batch_id,contributor_hash,request_hash,received_at,expires_at,receipt)
    VALUES('cop','30000000-0000-4000-8000-000000000021',$1,$2,now(),now()+interval '1 day',$3),
      ('cop','30000000-0000-4000-8000-000000000022',$4,$2,now(),now()+interval '1 day','{}')`,
    [contributorHash,requestHash,JSON.stringify({privateProbe:privateCanary}),hash("unrelated synthetic contributor")]);
  await admin.query(`INSERT INTO driver_measurement_intervals(owner,batch_id,measurement_key,dataset,edge_id,window_start,speed_kph,distance_m,elapsed_seconds)
    SELECT owner,batch_id,md5(batch_id::text)||md5(batch_id::text),'synthetic-graph','8',received_at,36,50,5 FROM driver_measurement_receipts;
    INSERT INTO driver_measurement_eta(owner,batch_id,observation_id,contributor_hash,dataset,window_start,predicted_seconds,actual_seconds)
    SELECT owner,batch_id,batch_id,contributor_hash,'synthetic-graph',received_at,100,120 FROM driver_measurement_receipts`);
  await admin.query("INSERT INTO driver_measurement_revocations VALUES('cop',$1,now()+interval '1 day')",[hash("unrelated temporary fence")]);
  await admin.query("INSERT INTO driver_account_erasure_revocations(owner,contributor_hash) VALUES('cop',$1)",[hash("unrelated permanent fence")]);
  await admin.query(`INSERT INTO driver_account_erasure_operations(operation_hash,actor_hash,request_hash,created_at,updated_at,contributor_count,
    deleted_batch_count,remaining_batch_count,replay_checkpoint_hash) VALUES($1,$2,$3,$4,$5,9,3,1,$6),($7,$8,$3,$4,$5,10,0,2,$6)`,
    [operationHash,actorHash,requestHash,createdAt,updatedAt,checkpointHash,otherOperationHash,otherActorHash]);
  await admin.query(`INSERT INTO sim_driver_guard_source.origins(operation_id,store_incarnation,permit_id,body_digest,schema_digest,kind,cutoff)
    VALUES($1,$2,'20000000-0000-4000-8000-000000000021',$3,$4,'expire',now())`,[origin,store,hash("synthetic immutable body"),inputs["deploy/driver-measurements/003_guarded_operations.sql"]]);
};
const check=async(name:string,fn:()=>Promise<void>)=>{
  await seed();try{await fn();events.push({case:name,passed:true});console.log(`PASS ${name}`);}
  catch(error){events.push({case:name,passed:false});throw error;}
  finally{for(const c of [...activeClients])await release(c);}
  assert.deepEqual(await originalSchema(),schemaBefore);
};

try{
  await execute(join(pgBin,"initdb"),["-D",join(root,"data"),"--username=synthetic_admin","--auth-local=trust","--auth-host=reject","--encoding=UTF8","--locale=C"],{env:cleanEnv,timeout:30000});
  await execute(join(pgBin,"pg_ctl"),["-D",join(root,"data"),"-l",join(root,"server.log"),"-o",
    `-k ${join(root,"socket")} -c listen_addresses='' -c unix_socket_permissions=0700 -c timezone=UTC -c log_statement=none -c log_min_error_statement=panic -c max_prepared_transactions=0`,"-w","start"],{env:cleanEnv,timeout:15000});started=true;
  const bootstrap=pool("synthetic_admin","postgres");
  const identity=(await bootstrap.query("SELECT current_setting('data_directory') AS directory,current_setting('listen_addresses') AS listen")).rows[0];
  assert.equal(identity.directory,join(root,"data"));assert.equal(identity.listen,"");
  await bootstrap.query(`CREATE ROLE driver_measurements_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE driver_measurements_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_driver_guard_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_driver_guard_control LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE sim_driver_guard_exec LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE synthetic_read_drift NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await bootstrap.query("CREATE DATABASE sim_driver_measurements OWNER driver_measurements_migrator");
  admin=pool("synthetic_admin");control=pool("sim_driver_guard_control");runtime=pool("driver_measurements_runtime");executor=pool("sim_driver_guard_exec");
  await admin.query("SET ROLE driver_measurements_migrator");await admin.query(sourceText["deploy/driver-measurements/schema.sql"]);await admin.query(sourceText["deploy/driver-measurements/002_account_erasure.sql"]);
  await admin.query("RESET ROLE");schemaBefore=await originalSchema();
  await admin.query("CREATE SCHEMA sim_driver_guard_source AUTHORIZATION sim_driver_guard_owner;GRANT sim_driver_guard_exec TO sim_driver_guard_owner");
  await admin.query(sourceText["deploy/driver-measurements/003_guarded_operations.sql"]);await admin.query(sourceText["deploy/driver-measurements/004_read_admission_facts.sql"]);
  assert.deepEqual(await originalSchema(),schemaBefore);
  for(const p of [admin,control,runtime,executor]){const r=(await p.query("SELECT current_database() AS db,inet_server_addr() AS tcp")).rows[0];assert.equal(r.db,"sim_driver_measurements");assert.equal(r.tcp,null);}

  await check("control-only STABLE fixed-policy facts function has no SQL writer, seal or RPC path",async()=>{
    const p=(await admin.query(`SELECT p.prosecdef,p.provolatile,p.proconfig,p.prosrc,pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p WHERE p.oid='sim_driver_guard_source.read_admission_facts(jsonb)'::regprocedure`)).rows[0];
    assert.equal(p.owner,"sim_driver_guard_owner");assert.equal(p.prosecdef,true);assert.equal(p.provolatile,"s");
    const config=p.proconfig.map((s:string)=>s.toLowerCase());
    for(const entry of ["search_path=pg_catalog","timezone=utc","row_security=off"])assert.ok(config.includes(entry));
    const code=p.prosrc.replace(/--[^\n]*/gu,"").replace(/\/\*[\s\S]*?\*\//gu,"").replace(/'(?:''|[^'])*'/gu,"''");
    assert.doesNotMatch(code,/\b(?:insert|update|delete|truncate|alter|create|drop|merge|call|execute)\b/iu);
    assert.doesNotMatch(code,/\b(?:resolve_or_seal|execute_origin|register_origin|claim_origin|pg_advisory_[a-z_]+|dblink|http[a-z_]*|lo_export|pg_write_file)\b/iu);
    assertFacts(await facts(),request("capability"));
    await denied(()=>readOn(control,request("capability")),"P0001");
  });
  await check("runtime and executor cannot invoke read facts, assume control or create TEMP",async()=>{
    for(const p of [runtime,executor]){
      await denied(()=>facts(request("capability"),p),"42501");await denied(()=>p.query("SET ROLE sim_driver_guard_control"),"42501");
      await denied(()=>p.query("CREATE TEMP TABLE forbidden_read_probe(id int)"),"42501");
    }
  });
  await check("all five purposes return exact bounded facts in an actual read-only transaction",async()=>{
    for(const purpose of purposes){const body=request(purpose),f=await facts(body);assertFacts(f,body);assert.equal(f.schema.ready,true);assert.equal(f.privileges.runtimeProfileMatches,true);
      assert.equal(f.operation===null,purpose==="capability"||purpose==="intake");}
  });
  await check("unknown keys, invalid purpose/hash and incomplete identity pairs are rejected",async()=>{
    const invalid:unknown[]=[null,[],{}, {...request("capability"),extra:true},{...request("capability"),owner:"cop"},
      {...request("capability"),scope:"all"},{...request("capability"),purpose:"all"},{...request("capability"),operationHash,actorHash},
      {...request("status"),actorHash:undefined},{...request("status"),operationHash:undefined},{...request("status"),operationHash:"invalid"},{...request("status"),actorHash:actorHash.toUpperCase()},
      {...request("status"),freeText:"forbidden"}];
    for(const body of invalid)await denied(()=>facts(body),"22023");
  });
  await check("wrong actor or operation returns null operation without exposing another ledger",async()=>{
    for(const body of [{...request("status"),actorHash:otherActorHash},{...request("status"),operationHash:otherOperationHash},
      {...request("receipt"),operationHash:hash("unknown operation")},{...request("preflight"),actorHash:hash("unknown actor")}]){
      const f=await facts(body);assertFacts(f,body);assert.equal(f.operation,null);assert.equal(f.storeIncarnation,store);
      assert.ok(!JSON.stringify(f).includes(requestHash));
    }
  });
  await check("store incarnation is the actual binding and an unbound store stays null",async()=>{
    assert.equal((await facts()).storeIncarnation,store);await admin.query("DELETE FROM sim_driver_guard_source.store_binding");
    const f=await facts();assertFacts(f,request("capability"));assert.equal(f.storeIncarnation,null);
    const next="00000000-0000-4000-8000-000000000022";await admin.query("INSERT INTO sim_driver_guard_source.store_binding VALUES(true,$1)",[next]);
    assert.equal((await facts()).storeIncarnation,next);
  });
  await check("state facts reflect actual checkpoint, current proof and report protection, not Root authority",async()=>{
    const f=await facts();assert.equal(f.state.checkpointHash,checkpointHash);assert.equal(f.state.replayReady,true);assert.equal(f.state.proofCurrent,true);
    assert.equal(f.state.retentionReviewed,true);assert.equal(f.state.publicationFenceVerified,true);assert.equal(f.state.reportProtection,"no_report");
    for(const protection of ["enforced_single_writer","shared_generation_fence"]){await admin.query("UPDATE driver_account_erasure_state SET report_protection=$1 WHERE singleton",[protection]);assert.equal((await facts()).state.reportProtection,protection);}
  });
  await check("expired proof, changed checkpoint and absent state remain explicit non-current facts",async()=>{
    await admin.query("UPDATE driver_account_erasure_state SET proof_valid_until=clock_timestamp()-interval '1 second',replay_checkpoint_hash=$1 WHERE singleton",[hash("changed checkpoint")]);
    const expired=await facts();assert.equal(expired.state.proofCurrent,false);assert.equal(expired.state.checkpointHash,hash("changed checkpoint"));
    await admin.query("DELETE FROM driver_account_erasure_state WHERE singleton");const absent=await facts();
    assert.deepEqual(absent.state,{checkpointHash:null,replayReady:false,proofValidUntilUTC:null,proofCurrent:false,retentionReviewed:false,reportProtection:"unverified",publicationFenceVerified:false});
  });
  await check("actual receipt-trigger drift makes schema not ready and changes its fingerprint",async()=>{
    const before=await facts();await admin.query("ALTER TABLE driver_measurement_receipts DISABLE TRIGGER driver_account_erasure_receipt_guard");
    try{const drift=await facts();assert.equal(drift.schema.ready,false);assert.notEqual(drift.schema.fingerprint,before.schema.fingerprint);}
    finally{await admin.query("ALTER TABLE driver_measurement_receipts ENABLE TRIGGER driver_account_erasure_receipt_guard");}
    assert.deepEqual((await facts()).schema,before.schema);
  });
  await check("effective PUBLIC column INSERT drift is detected with a changed privilege fingerprint",async()=>{
    const before=await facts();await admin.query("GRANT INSERT(contributor_hash) ON driver_account_erasure_revocations TO PUBLIC");
    try{const drift=await facts();assert.equal(drift.privileges.runtimeProfileMatches,false);assert.notEqual(drift.privileges.fingerprint,before.privileges.fingerprint);}
    finally{await admin.query("REVOKE INSERT(contributor_hash) ON driver_account_erasure_revocations FROM PUBLIC");}
    // Fingerprints bind actual ACL representation; NULL vs effective-empty ACL
    // after REVOKE need not reproduce the earlier catalog bytes.
    assert.equal((await facts()).privileges.runtimeProfileMatches,true);
  });
  await check("role inheritance and CREATE TEMP drift fail the actual runtime profile",async()=>{
    const before=await facts();
    for(const [grant,revoke] of [["GRANT synthetic_read_drift TO driver_measurements_runtime","REVOKE synthetic_read_drift FROM driver_measurements_runtime"],
      ["GRANT TEMP ON DATABASE sim_driver_measurements TO driver_measurements_runtime","REVOKE TEMP ON DATABASE sim_driver_measurements FROM driver_measurements_runtime"]]){
      await admin.query(grant);try{const drift=await facts();assert.equal(drift.privileges.runtimeProfileMatches,false);assert.notEqual(drift.privileges.fingerprint,before.privileges.fingerprint);}
      finally{await admin.query(revoke);}assert.equal((await facts()).privileges.runtimeProfileMatches,true);
    }
  });
  await check("ledger projection has immutable accepted time/counts and no manifest, GPS or collection data",async()=>{
    const before=await value(admin,"SELECT to_jsonb(t) AS value FROM driver_account_erasure_operations t WHERE operation_hash=$1",[operationHash]);
    const digest=await value(admin,"SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS value FROM driver_account_erasure_operations t WHERE operation_hash=$1",[operationHash]);
    for(const purpose of ["preflight","status","receipt"] as Purpose[]){const body=request(purpose),f=await facts(body);assertFacts(f,body);
      assert.deepEqual(f.operation,{operationHash,actorHash,requestHash,contributorCount:9,status:"pending",createdAtUTC:createdAt,updatedAtUTC:updatedAt,deletedBatchCount:3,
        remainingBatchCount:1,databaseZeroVerified:false,derivedReportAcknowledged:false,replayCheckpointHash:checkpointHash,ledgerDigest:digest});
      assert.ok(!JSON.stringify(f).includes(otherActorHash));assert.ok(!JSON.stringify(f).includes(contributorHash));}
    assert.deepEqual(await value(admin,"SELECT to_jsonb(t) AS value FROM driver_account_erasure_operations t WHERE operation_hash=$1",[operationHash]),before);
  });
  await check("read-only facts neither wait on contributor/state row locks nor acquire write/advisory locks",async()=>{
    const locker=await acquire(admin),reader=await acquire(control);
    try{
      await locker.query("BEGIN");await locker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`cop:${contributorHash}`]);
      await locker.query("SELECT 1 FROM driver_account_erasure_state WHERE singleton FOR UPDATE");
      await locker.query("SELECT 1 FROM driver_account_erasure_operations WHERE operation_hash=$1 FOR UPDATE",[operationHash]);
      await reader.query("BEGIN READ ONLY");await reader.query("SET LOCAL statement_timeout='1000ms'");const f=await readOn(reader,request("status"));assertFacts(f,request("status"));
      assert.equal(await value(reader,"SELECT pg_current_xact_id_if_assigned()::text AS value"),null);
      const pid=await value(reader,"SELECT pg_backend_pid() AS value");
      assert.equal(await value(admin,`SELECT count(*)::int AS value FROM pg_locks WHERE pid=$1 AND
        (locktype='advisory' OR locktype='tuple' OR (locktype='relation' AND mode<>'AccessShareLock'))`,[pid]),0);
    }finally{await release(reader);await release(locker);}
  });
  await check("all data/origin effects stay stable and missing or revoked read RPC is unavailable",async()=>{
    const before=await effects();for(const purpose of purposes)assertFacts(await facts(request(purpose)),request(purpose));assert.deepEqual(await effects(),before);
    assert.equal(await value(admin,"SELECT state AS value FROM sim_driver_guard_source.origins WHERE operation_id=$1",[origin]),"prepared");
    await admin.query("REVOKE EXECUTE ON FUNCTION sim_driver_guard_source.read_admission_facts(jsonb) FROM sim_driver_guard_control");
    try{await denied(()=>facts(),"42501");}finally{await admin.query("GRANT EXECUTE ON FUNCTION sim_driver_guard_source.read_admission_facts(jsonb) TO sim_driver_guard_control");}
    await admin.query("ALTER FUNCTION sim_driver_guard_source.read_admission_facts(jsonb) RENAME TO temporarily_absent_read_admission_facts");
    try{await denied(()=>facts(),"42883");}finally{await admin.query("ALTER FUNCTION sim_driver_guard_source.temporarily_absent_read_admission_facts(jsonb) RENAME TO read_admission_facts");}
    assert.deepEqual(await effects(),before);
  });
  assert.equal(events.length,14);assert.equal(providerCalls,0);success=true;
}finally{
  for(const c of [...activeClients])await release(c).catch(()=>undefined);for(const p of pools)await p.end().catch(()=>undefined);
  if(started||existsSync(join(root,"data/postmaster.pid"))){owned();const lines=(await readFile(join(root,"data/postmaster.pid"),"utf8")).split("\n");assert.equal(lines[1],join(root,"data"));
    await execute(join(pgBin,"pg_ctl"),["-D",join(root,"data"),"-m","fast","-w","stop"],{env:cleanEnv,timeout:15000});}
  globalThis.fetch=originalFetch;process.umask(previousUmask);
  if(success){owned();assert.ok(!existsSync(join(root,"data/postmaster.pid")));await rm(root,{recursive:true});}else console.error(`Private synthetic failed fixture retained: ${root}`);
}
if(success){
  const pins:Record<string,string>={};for(const path of [...Object.keys(inputs),...Object.keys(frozenInputs),"scripts/test-driver-read-admission-postgres.mts"])pins[path]=hash(await readFile(join(repo,path)));
  for(const [path,pin] of Object.entries({...inputs,...frozenInputs}))assert.equal(pins[path],pin);
  assert.equal(pins["scripts/test-driver-read-admission-postgres.mts"],initialSelfHash,"The exact executing harness changed after its initial pre-bootstrap hash.");
  const receipt={status:"SOURCE_DRIVER_READ_ADMISSION_SQL_FACTS_ONLY",startedAt,completedAt:new Date().toISOString(),postgresVersion:"18.3",cases:events,passed:events.length,providerCalls,
    isolation:{newOwnedCluster:true,tcpListener:false,externalTargetsAccepted:false,dataRemoved:true},sourcePins:pins,initialHarnessSha256:initialSelfHash,harnessUnchangedDuringRun:true,
    sourceUnchangedDuringRun:true,priorFrozenEvidenceUnchanged:true,coverage:{readOnlyTransaction:true,allFivePurposes:true,exactIdentityProjection:true,actualCatalogFingerprints:true,
      publicColumnGrantDrift:true,roleAndTempDrift:true,proofAndStoreFacts:true,noDataOrOriginMutation:true,noAdvisoryOrRowLocks:true},
    actual:{productionChanged:false,rootVerification:false,rootSignaturesVerified:false,acceptedRootRecords:false,rootReadAdmissionAccepted:false,nativeAuthority:false,
      nativeTransport:false,actualWriterIntegration:false,restoreAccepted:false,deploymentAccepted:false,realAccountDeleted:false,providerCalls:false},
    interpretation:"14 NEW owned PostgreSQL read-facts cases only. Database facts/fingerprints and synthetic fixtures are not signed Root admission, acceptance, or authority; prior 18/11 and COP cases are not counted."};
  await writeFile(reportPath,JSON.stringify(receipt,null,2)+"\n",{flag:"wx",mode:0o600});console.log(JSON.stringify({reportPath,passed:events.length,productionChanged:false,actualRootVerification:false}));
}
