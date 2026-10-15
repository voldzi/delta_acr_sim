/** SOURCE ONLY: eight new checkpoint SQL groups in a fresh owned Unix-only
 * PG18.3 cluster. No TCP, external target, secret, provider, Root signature or
 * accepted enrollment. Frozen 11/14/15/18 evidence is pinned, never rerun.
 * Main must read this entire new source and be the sole authorized runner. */
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {existsSync,realpathSync,statSync} from "node:fs";
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {matchDriverReadPolicy} from "../deploy/driver-measurements/read-admission-facts.mjs";

assert.equal(process.argv.length,3);assert.equal(process.argv[2],"--run");
const repo=resolve(dirname(fileURLToPath(import.meta.url)),".."),self=fileURLToPath(import.meta.url);
const hash=(v:string|Buffer)=>createHash("sha256").update(v).digest("hex"),selfPin=hash(await readFile(self));
const receiptPath=join(repo,"docs/archive/2026-10-15_DRIVER_ROOT_CHECKPOINT_SQL.json");
assert.ok(!existsSync(receiptPath),"Existing source evidence must never be overwritten.");
const inputs:Record<string,string>={
 "deploy/driver-measurements/schema.sql":"6dd60a3acf28d63575198c8526c368df19bbd543f4063d4985fb55f308da02d0",
 "deploy/driver-measurements/002_account_erasure.sql":"f13db2106a1fe1a02d0d1a26afa8ad7d7c045172ba4419749719ed0f166e16ad",
 "deploy/driver-measurements/003_guarded_operations.sql":"e3513a983a3b6d1bd52d46851c734dd1c3b208e2e2f6430a6f9eddd38b10d3b5",
 "deploy/driver-measurements/004_read_admission_facts.sql":"791545b9df91e65bb555c68a44dadd73a847ca64fde0c31a9036f9f555ba1d2d",
 "deploy/driver-measurements/005_root_checkpoint.sql":"77faac125f6133a774e6d9e900c2dcbfc3b86419d3179bfb4d5bcf64eb3bb3cb",
};
const frozen:Record<string,string>={
 "scripts/test-driver-expiry-real-schema.mts":"61ff2bfe5b3510fa0c8d4a2be61bc8cea83fb798695d35713b0681634f5e2b6f",
 "scripts/fixtures/driver-retention-real-schema/expiry-source.sql":"1561825849c8990526af26eae3866ee2100072db72bed638997a2eec7a8afb7a",
 "docs/archive/2026-10-14_DRIVER_EXPIRY_REAL_SCHEMA.json":"8dac0d99b4add01446b05e8fdc6cd752f5d754328754fc46fe5848b954841396",
 "scripts/test-driver-guarded-operations-postgres.mts":"547c0486f7a902c6bd4b920139b50178de392f2b3f91f27f3b1d177becf80e97",
 "docs/archive/2026-10-15_DRIVER_GUARDED_OPERATIONS_SQL.json":"80ea5fb1a4e914a5439dba901bfee528c1136c1ed812aee9c7bfb82ebe869c42",
 "deploy/driver-measurements/guarded-runtime-verification.sql":"3ef5ad53b2e4f94d143636e7bf2e26108fd10d3d34c2a0521ca4760d95ca88a2",
 "scripts/test-driver-read-admission-postgres.mts":"a84618b475c1f3707941e2290982a6069a4888461eea3f0a10fc5e6305e98e5f",
 "docs/archive/2026-10-15_DRIVER_READ_ADMISSION_SQL.json":"656e141ca0469693917e7268000a390952326647ffc6f475666d26b5a7f9b755",
 "scripts/test-driver-read-root.mts":"d478ca2597e38f95a93325614f3d90360665bc712169b180c3ab3483f431319c",
 "scripts/fixtures/driver-read-root/harness.mjs":"fe4eca9f99f4082c86fc1229554a78bac7187f017ee5b141952d7491d81dce02",
 "docs/archive/2026-10-15_DRIVER_READ_ROOT.json":"4d50470cc6398b8108fef3aad622a3fa747f749d8d8d0414854d36a7ee14c249",
 "deploy/driver-measurements/root-read-admission.mjs":"cbd1b4c4fa6d8c75ff06a9f5ea9aef0948477a530e73bc7e8c85cfe464197192",
 "deploy/driver-measurements/read-admission-facts.mjs":"756d25ae2ce00c9a02a6295a5d00812732a04b01ace82c347f68e58a902d0456",
};
const source:Record<string,string>={};
for(const [path,pin] of Object.entries({...inputs,...frozen})){const bytes=await readFile(join(repo,path));assert.equal(hash(bytes),pin,path);source[path]=bytes.toString("utf8");}
const execute=promisify(execFile),pgBin="/opt/homebrew/opt/postgresql@18/bin";
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>["PATH","HOME","USER","LOGNAME","LANG","LC_ALL","TMPDIR"].includes(k)));
for(const k of Object.keys(process.env))if(/^PG|DATABASE_URL$|OPENAI|API_KEY|SECRET|TOKEN/u.test(k))delete process.env[k];
assert.match((await execute(join(pgBin,"postgres"),["--version"],{env})).stdout,/^postgres \(PostgreSQL\) 18\.3(?:\s|$)/u);
const require=createRequire(join(repo,"apps/situation-data-api/package.json")),{Pool}=require("pg");
const tmp=realpathSync("/private/tmp");assert.equal(tmp,"/private/tmp");
const oldUmask=process.umask(0o077),root=await mkdtemp(join(tmp,"sim-driver-root-checkpoint-pg-"));
await chmod(root,0o700);await mkdir(join(root,"socket"),{mode:0o700});
const owned=()=>{assert.equal(dirname(realpathSync(root)),tmp);assert.ok(root.startsWith(join(tmp,"sim-driver-root-checkpoint-pg-")));
 for(const p of [root,join(root,"socket")]){assert.equal(statSync(p).uid,process.getuid!());assert.equal(statSync(p).mode&0o777,0o700);}};
owned();
const pools:any[]=[],clients=new Set<any>(),events:Array<{case:string;passed:boolean}>=[];
const pool=(user:string,database="sim_driver_measurements")=>{const p=new Pool({host:join(root,"socket"),port:5432,user,database,
 max:4,connectionTimeoutMillis:2000,statement_timeout:5000,query_timeout:6000});pools.push(p);return p;};
const acquire=async(p:any)=>{const c=await p.connect();clients.add(c);return c;};
const release=async(c:any)=>{await c.query("ROLLBACK").catch(()=>{});c.release();clients.delete(c);};
const value=async(p:any,sql:string,args:unknown[]=[])=> (await p.query(sql,args)).rows[0].value;
const denied=async(fn:()=>Promise<unknown>,code:string)=>{try{await fn();assert.fail("Expected SQL rejection");}
 catch(e:any){if(e.code==="ERR_ASSERTION")throw e;assert.equal(e.code,code);}};
const exact=(v:any,keys:string[])=>assert.deepEqual(Object.keys(v).sort(),[...keys].sort());
const stamp=(v:string)=>{assert.match(v,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);assert.equal(new Date(v).toISOString(),v);};
const startedAt=new Date().toISOString(),store="00000000-0000-4000-8000-000000000031";
const baseCheckpoint=hash("synthetic checkpoint, not signed Root authority"),rootRecordRef={recordId:randomUUID(),digest:hash("synthetic transient Root reference")};
const request=(overrides:Record<string,unknown>={})=>({contractVersion:"sim-driver-root-checkpoint-v1",owner:"sim_driver_measurements",scope:"online_driver_scope",
 storeIncarnation:store,expectedPreviousCheckpointHash:null,checkpointHash:baseCheckpoint,proofValidUntilUTC:new Date(Date.now()+20_000).toISOString(),
 replayReady:true,retentionReviewed:true,reportProtection:"no_report",publicationFenceVerified:true,rootRecordRef,...overrides});
let admin:any,control:any,runtime:any,executor:any,started=false,success=false,providerCalls=0,beforeFacts:any,invariantRows:any,cleanupFailure:unknown;
const savedFetch=globalThis.fetch;globalThis.fetch=async()=>{providerCalls++;throw new Error("No provider/network is permitted.");};
const apply=(body:unknown,p:any=control)=>value(p,"SELECT sim_driver_guard_source.apply_root_checkpoint($1::jsonb) AS value",[JSON.stringify(body)]);
const facts=async()=>{const c=await acquire(control);try{await c.query("BEGIN READ ONLY");return await value(c,
 "SELECT sim_driver_guard_source.read_admission_facts($1::jsonb) AS value",[JSON.stringify({owner:"sim_driver_measurements",scope:"online_driver_scope",purpose:"capability"})]);}finally{await release(c);}};
const state=()=>value(admin,"SELECT to_jsonb(t) AS value FROM driver_account_erasure_state t WHERE singleton");
const invariant=()=>value(admin,"SELECT jsonb_build_object("+
 "'receipts',(SELECT jsonb_agg(to_jsonb(t) ORDER BY owner,batch_id) FROM driver_measurement_receipts t),"+
 "'intervals',(SELECT jsonb_agg(to_jsonb(t) ORDER BY owner,measurement_key) FROM driver_measurement_intervals t),"+
 "'eta',(SELECT jsonb_agg(to_jsonb(t) ORDER BY owner,batch_id) FROM driver_measurement_eta t),"+
 "'temporaryFences',(SELECT jsonb_agg(to_jsonb(t) ORDER BY owner,contributor_hash) FROM driver_measurement_revocations t),"+
 "'operations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY operation_hash) FROM driver_account_erasure_operations t),"+
 "'permanentFences',(SELECT jsonb_agg(to_jsonb(t) ORDER BY owner,contributor_hash) FROM driver_account_erasure_revocations t),"+
 "'origins',(SELECT jsonb_agg(to_jsonb(t) ORDER BY operation_id) FROM sim_driver_guard_source.origins t),"+
 "'store',(SELECT to_jsonb(t) FROM sim_driver_guard_source.store_binding t WHERE singleton)) AS value");
const check=async(name:string,fn:()=>Promise<void>)=>{await admin.query("UPDATE driver_account_erasure_state SET replay_ready=false,replay_checkpoint_hash=NULL,"+
 "proof_valid_until=NULL,retention_reviewed=false,report_protection='unverified',publication_fence_verified=false WHERE singleton");
 try{await fn();events.push({case:name,passed:true});console.log("PASS "+name);}catch(e){events.push({case:name,passed:false});throw e;}
 finally{for(const c of [...clients])await release(c);}assert.deepEqual(await invariant(),invariantRows);};
try{
 await execute(join(pgBin,"initdb"),["-D",join(root,"data"),"--username=synthetic_admin","--auth-local=trust","--auth-host=reject","--encoding=UTF8","--locale=C"],{env,timeout:30000});
 await execute(join(pgBin,"pg_ctl"),["-D",join(root,"data"),"-l",join(root,"server.log"),"-o","-k "+join(root,"socket")+
  " -c listen_addresses='' -c unix_socket_permissions=0700 -c timezone=UTC -c log_statement=none -c log_min_error_statement=panic -c max_prepared_transactions=0","-w","start"],{env,timeout:15000});started=true;
 const bootstrap=pool("synthetic_admin","postgres"),identity=(await bootstrap.query("SELECT current_setting('data_directory') AS directory,current_setting('listen_addresses') AS listen")).rows[0];
 assert.equal(identity.directory,join(root,"data"));assert.equal(identity.listen,"");
 await bootstrap.query("CREATE ROLE driver_measurements_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;"+
  "CREATE ROLE driver_measurements_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;"+
  "CREATE ROLE sim_driver_guard_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;"+
  "CREATE ROLE sim_driver_guard_control LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;"+
  "CREATE ROLE sim_driver_guard_exec LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
 await bootstrap.query("CREATE DATABASE sim_driver_measurements OWNER driver_measurements_migrator");
 admin=pool("synthetic_admin");control=pool("sim_driver_guard_control");runtime=pool("driver_measurements_runtime");executor=pool("sim_driver_guard_exec");
 const migrator=await acquire(admin);try{await migrator.query("SET ROLE driver_measurements_migrator");await migrator.query(source["deploy/driver-measurements/schema.sql"]);
  await migrator.query(source["deploy/driver-measurements/002_account_erasure.sql"]);await migrator.query("RESET ROLE");}finally{await release(migrator);}
 await admin.query("CREATE SCHEMA sim_driver_guard_source AUTHORIZATION sim_driver_guard_owner;GRANT sim_driver_guard_exec TO sim_driver_guard_owner");
 for(const name of ["003_guarded_operations.sql","004_read_admission_facts.sql"])await admin.query(source["deploy/driver-measurements/"+name]);
 await admin.query("INSERT INTO sim_driver_guard_source.store_binding VALUES(true,$1)",[store]);
 await admin.query("UPDATE driver_account_erasure_state SET replay_ready=true,proof_valid_until=clock_timestamp()+interval '1 hour',"+
  "retention_reviewed=true,report_protection='no_report',publication_fence_verified=true,replay_checkpoint_hash=$1 WHERE singleton",[baseCheckpoint]);
 const batch="30000000-0000-4000-8000-000000000031",contributor=hash("synthetic daily contributor"),req=hash("synthetic request");
 await admin.query("INSERT INTO driver_measurement_receipts VALUES('cop',$1,$2,$3,now(),now()+interval '1 day','{}')",[batch,contributor,req]);
 await admin.query("INSERT INTO driver_measurement_intervals VALUES('cop',$1,$2,'synthetic-graph','8',now(),36,10,1)",[batch,hash("synthetic interval")]);
 await admin.query("INSERT INTO driver_measurement_eta VALUES('cop',$1,$1,$2,'synthetic-graph',now(),100,120)",[batch,contributor]);
 await admin.query("INSERT INTO driver_measurement_revocations VALUES('cop',$1,now()+interval '1 day');",[hash("synthetic temporary fence")]);
 await admin.query("INSERT INTO driver_account_erasure_revocations(owner,contributor_hash) VALUES('cop',$1)",[hash("synthetic permanent fence")]);
 await admin.query("INSERT INTO driver_account_erasure_operations(operation_hash,actor_hash,request_hash,contributor_count) VALUES($1,$2,$3,9)",[hash("synthetic operation"),hash("synthetic actor"),req]);
 await admin.query("INSERT INTO sim_driver_guard_source.origins(operation_id,store_incarnation,permit_id,body_digest,schema_digest,kind,cutoff) "+
  "VALUES($1,$2,$3,$4,$5,'expire',now())",[randomUUID(),store,randomUUID(),hash("synthetic origin body"),inputs["deploy/driver-measurements/003_guarded_operations.sql"]]);
 beforeFacts=await facts();assert.equal(beforeFacts.privileges.runtimeProfileMatches,true);invariantRows=await invariant();
 await admin.query(source["deploy/driver-measurements/005_root_checkpoint.sql"]);
 for(const p of [admin,control,runtime,executor])assert.equal(await value(p,"SELECT inet_server_addr() AS value"),null);

 await check("fixed Root control RPC and column grants do not grant application metadata DML",async()=>{
  const f=(await admin.query("SELECT p.prosecdef,p.proconfig,pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.oid='sim_driver_guard_source.apply_root_checkpoint(jsonb)'::regprocedure")).rows[0];
  assert.equal(f.owner,"sim_driver_guard_owner");assert.equal(f.prosecdef,true);
  for(const c of ["search_path=pg_catalog","timezone=utc","row_security=off","lock_timeout=1000ms"])assert.ok(f.proconfig.map((v:string)=>v.toLowerCase()).includes(c));
  const before=await state();for(const p of [runtime,executor]){await denied(()=>apply(request(),p),"42501");await denied(()=>p.query("SET ROLE sim_driver_guard_control"),"42501");}
  await denied(()=>apply(request(),admin),"P0001");
  for(const p of [runtime,executor,control])await denied(()=>p.query("UPDATE driver_account_erasure_state SET replay_ready=true WHERE singleton"),"42501");
  assert.equal(await value(admin,"SELECT has_table_privilege('sim_driver_guard_owner','driver_account_erasure_state','INSERT,UPDATE,DELETE') AS value"),false);
  for(const col of ["replay_ready","replay_checkpoint_hash","proof_valid_until","retention_reviewed","report_protection","publication_fence_verified"])
   assert.equal(await value(admin,"SELECT has_column_privilege('sim_driver_guard_owner','driver_account_erasure_state',$1,'UPDATE') AS value",[col]),true);
  const c=await acquire(control);try{await c.query("BEGIN READ ONLY");await denied(()=>apply(request(),c),"P0001");}finally{await release(c);}assert.deepEqual(await state(),before);
 });
 await check("strict twelve-key body, two modes, Root reference and canonical UTC reject malformed input",async()=>{
  const b=request(),without={...b} as any;delete without.expectedPreviousCheckpointHash;
  const invalid=[null,[],{},without,{...b,extra:true},{...b,contractVersion:"wrong"},{...b,owner:"cop"},{...b,scope:"all"},
   {...b,storeIncarnation:"not-uuid"},{...b,checkpointHash:"A".repeat(64)},{...b,expectedPreviousCheckpointHash:1},
   {...b,replayReady:"true"},{...b,retentionReviewed:false},{...b,publicationFenceVerified:false},
   {...b,reportProtection:"unverified"},{...b,rootRecordRef:null},{...b,rootRecordRef:{...rootRecordRef,extra:true}},
   {...b,rootRecordRef:{recordId:"invalid",digest:rootRecordRef.digest}},{...b,rootRecordRef:{...rootRecordRef,digest:"bad"}},
   ...["2026-02-30T00:00:00.000Z","2026-10-15T24:00:00.000Z","2026-10-15T00:00:00Z","2026-10-15T00:00:00.000+00:00"].map(proofValidUntilUTC=>({...b,proofValidUntilUTC}))];
  const before=await state();for(const body of invalid)await denied(()=>apply(body),"22023");assert.deepEqual(await state(),before);
 });
 await check("initial NULL CAS applies active metadata and returns exact actual five-key/seven-state readback",async()=>{
  const b=request(),r=await apply(b);exact(r,["contractVersion","storeIncarnation","rootRecordRef","appliedAtUTC","state"]);
  assert.equal(r.contractVersion,"sim-driver-root-checkpoint-result-v1");assert.equal(r.storeIncarnation,store);assert.deepEqual(r.rootRecordRef,rootRecordRef);stamp(r.appliedAtUTC);
  exact(r.state,["checkpointHash","replayReady","proofValidUntilUTC","proofCurrent","retentionReviewed","reportProtection","publicationFenceVerified"]);
  assert.deepEqual(r.state,(await facts()).state);assert.equal(r.state.checkpointHash,b.checkpointHash);assert.equal(r.state.proofValidUntilUTC,b.proofValidUntilUTC);
  for(const k of ["replayReady","proofCurrent","retentionReviewed","publicationFenceVerified"])assert.equal(r.state[k],true);
 });
 await check("stale previous checkpoint and wrong store are rejected without changing the singleton",async()=>{
  await apply(request());const before=await state();await denied(()=>apply(request({checkpointHash:hash("stale CAS candidate")})),"23505");
  await denied(()=>apply(request({expectedPreviousCheckpointHash:baseCheckpoint,storeIncarnation:randomUUID()})),"P0001");assert.deepEqual(await state(),before);
 });
 await check("explicit three-false unverified quarantine cannot satisfy even matching read-facts policy",async()=>{
  await apply(request());const cp=hash("synthetic quarantine"),r=await apply(request({expectedPreviousCheckpointHash:baseCheckpoint,checkpointHash:cp,
   replayReady:false,retentionReviewed:false,publicationFenceVerified:false,reportProtection:"unverified"}));
  for(const k of ["replayReady","retentionReviewed","publicationFenceVerified"])assert.equal(r.state[k],false);assert.equal(r.state.reportProtection,"unverified");
  const f=await facts();assert.throws(()=>matchDriverReadPolicy(f,f.request,{storeIncarnation:store,checkpointHash:cp,schemaFingerprint:f.schema.fingerprint,
   privilegeFingerprint:f.privileges.fingerprint,reportProtection:"no_report"}),/DRIVER_READ_ADMISSION_UNAVAILABLE/u);
 });
 await check("past or over-thirty-second proof and actual one-second row-lock timeout have no effect",async()=>{
  const before=await state();for(const offset of [-1000,31_000])await denied(()=>apply(request({proofValidUntilUTC:new Date(Date.now()+offset).toISOString()})),"P0001");
  const lock=await acquire(admin);try{await lock.query("BEGIN");await lock.query("SELECT 1 FROM driver_account_erasure_state WHERE singleton FOR UPDATE");
   const at=performance.now();await denied(()=>apply(request()),"55P03");assert.ok(performance.now()-at>=800&&performance.now()-at<3000);
  }finally{await release(lock);}assert.deepEqual(await state(),before);
  const wait=await acquire(admin);try{await wait.query("BEGIN");await wait.query("SELECT 1 FROM driver_account_erasure_state WHERE singleton FOR UPDATE");
   const expired=denied(()=>apply(request({proofValidUntilUTC:new Date(Date.now()+100).toISOString()})),"P0001");
   await new Promise(resolve=>setTimeout(resolve,250));await release(wait);await expired;
  }finally{if(clients.has(wait))await release(wait);}assert.deepEqual(await state(),before);
 });
 await check("two concurrent CAS requests with the same previous checkpoint have exactly one winner",async()=>{
  const results=await Promise.allSettled([apply(request({checkpointHash:hash("concurrent A")})),apply(request({checkpointHash:hash("concurrent B")}))]);
  const wins=results.filter((r):r is PromiseFulfilledResult<any>=>r.status==="fulfilled"),losses=results.filter((r):r is PromiseRejectedResult=>r.status==="rejected");
  assert.equal(wins.length,1);assert.equal(losses.length,1);assert.equal(losses[0].reason.code,"23505");assert.equal((await state()).replay_checkpoint_hash,wins[0].value.state.checkpointHash);
 });
 await check("metadata-only effects preserve rows and transient reference; old privilege pin fails while runtime profile remains narrow",async()=>{
  await apply(request());const f=await facts();assert.deepEqual(f.schema,beforeFacts.schema);assert.equal(f.privileges.runtimeProfileMatches,true);
  assert.notEqual(f.privileges.fingerprint,beforeFacts.privileges.fingerprint);assert.throws(()=>matchDriverReadPolicy(f,f.request,{storeIncarnation:store,
   checkpointHash:baseCheckpoint,schemaFingerprint:f.schema.fingerprint,privilegeFingerprint:beforeFacts.privileges.fingerprint,reportProtection:"no_report"}),/DRIVER_READ_ADMISSION_UNAVAILABLE/u);
  matchDriverReadPolicy(f,f.request,{storeIncarnation:store,checkpointHash:baseCheckpoint,schemaFingerprint:f.schema.fingerprint,privilegeFingerprint:f.privileges.fingerprint,reportProtection:"no_report"});
  const persisted=JSON.stringify({rows:await invariant(),state:await state()});assert.ok(!persisted.includes(rootRecordRef.recordId));assert.ok(!persisted.includes(rootRecordRef.digest));
 });
 assert.equal(events.length,8);assert.equal(providerCalls,0);success=true;
}finally{
 for(const c of [...clients])await release(c).catch(e=>{cleanupFailure??=e;});for(const p of pools)await p.end().catch((e:unknown)=>{cleanupFailure??=e;});
 if(started||existsSync(join(root,"data/postmaster.pid"))){owned();assert.equal((await readFile(join(root,"data/postmaster.pid"),"utf8")).split("\n")[1],join(root,"data"));
  await execute(join(pgBin,"pg_ctl"),["-D",join(root,"data"),"-m","fast","-w","stop"],{env,timeout:15000});}
 globalThis.fetch=savedFetch;process.umask(oldUmask);
 if(success&&cleanupFailure===undefined){owned();assert.ok(!existsSync(join(root,"data/postmaster.pid")));await rm(root,{recursive:true});}else console.error("Private failed fixture retained: "+root);
 if(cleanupFailure!==undefined)throw cleanupFailure;
}
for(const [path,pin] of Object.entries({...inputs,...frozen}))assert.equal(hash(await readFile(join(repo,path))),pin,"Pinned source/evidence changed: "+path);
assert.equal(hash(await readFile(self)),selfPin);
const receipt={status:"SOURCE_DRIVER_ROOT_CHECKPOINT_SQL_ONLY",startedAt,completedAt:new Date().toISOString(),postgresVersion:"18.3",passed:events.length,cases:events,
 sourcePins:{...inputs,...frozen,[ "scripts/test-driver-root-checkpoint-postgres.mts"]:selfPin},priorFrozenEvidenceUnchanged:true,providerCalls,
 isolation:{newOwnedCluster:true,tcpListener:false,externalTargetsAccepted:false,secrets:false,dataRemoved:true},
 actual:{productionChanged:false,rootVerification:false,rootSignaturesVerified:false,acceptedRootRecords:false,rootEnrollment:false,nativeAuthority:false,
  actualWriterIntegration:false,restoreAccepted:false,deploymentAccepted:false,realAccountDeleted:false,wholeAccountComplete:false},
 interpretation:"Eight NEW synthetic SQL checkpoint groups only; typed references and DB flags are not independently verified Root authority. Prior 11/14/15/18 cases are not rerun or counted."};
await writeFile(receiptPath,JSON.stringify(receipt,null,2)+"\n",{flag:"wx",mode:0o600});console.log(JSON.stringify({receiptPath,passed:events.length,productionChanged:false}));
