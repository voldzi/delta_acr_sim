/** Actual HTTP + PostgreSQL owner path. Only the explicitly owned loopback
 * cluster cop_erasure_owned_test is allowed. Never production credentials. */
import assert from "node:assert/strict";
import {createHash,createHmac,randomBytes,randomUUID} from "node:crypto";
import {createRequire} from "node:module";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {resolve,dirname} from "node:path";
import {DatabaseErasureGuard,configurationFingerprint,runtimeIdentityFingerprint} from "../deploy/account-safety/database-erasure-guard.mjs";
import {loadDatabaseDriverOwnerComposition} from "../apps/situation-data-api/src/database-erasure.js";
import {registerDriverMeasurementRoutes} from "../apps/situation-data-api/src/driver-measurements.js";
import {driverErasureRequiredDays} from "../apps/situation-data-api/src/driver-account-erasure.js";
import {BudgetStore} from "../apps/ai-router-api/src/budget.js";
import {PgSeparateBilling} from "../apps/ai-router-api/src/separate-billing.js";
import {PgAccountErasure,erasureIdentity} from "../apps/ai-router-api/src/account-erasure.js";
import {loadDatabaseRouterGuard} from "../apps/ai-router-api/src/database-erasure.js";
import {createApp as createRouterApp} from "../apps/ai-router-api/src/app.js";
const args=process.argv.slice(2);assert.ok(["--run","--serve","--serve-existing"].includes(args[0]!));assert.equal(args.length,2);
const reuse=args[0]==="--serve-existing";
const port=Number(args[1]);assert.ok(Number.isInteger(port)&&port>=1024&&port<=65535);
const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const require=createRequire(resolve(root,"apps/ai-router-api/package.json"));const {Pool}=require("pg");const express=require("express");
const config=(database:string,user:string)=>({host:"127.0.0.1",port,database,user,connectionTimeoutMillis:2000,statement_timeout:5000});
const pools:any[]=[];const pool=(db:string,user:string)=>{const p=new Pool(config(db,user));pools.push(p);return p;};
const admin=pool("postgres","cop_safety_test_admin");
const owned=(await admin.query("SELECT current_setting('cluster_name') AS name,current_setting('data_directory') AS directory,version() AS version")).rows[0];
assert.equal(owned.name,"cop_erasure_owned_test");assert.match(owned.directory,/^\/private\/tmp\/cop-erasure-owned-[0-9]+\/pg$/);assert.match(owned.version,/PostgreSQL 18\./);
const reportDirectory=dirname(owned.directory)+'/driver-report-files';await mkdir(reportDirectory,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
const guardAdmin=pool("cop_account_safety_guard","cop_safety_test_admin");
const source=async(path:string)=>readFile(resolve(root,path),"utf8");
let guardId=randomUUID();
const secret="synthetic-driver-HMAC-with-32-characters-minimum",actorSecret="synthetic-actor-HMAC-with-32-characters-minimum",copToken="synthetic-service-token-with-32-characters-minimum";
const issuer="https://issuer.example.invalid/realms/synthetic";
const driverFingerprint=runtimeIdentityFingerprint('sim_measurements',secret,actorSecret,issuer),routerFingerprint=runtimeIdentityFingerprint('ai_router',secret,actorSecret,issuer);
const fingerprint=configurationFingerprint(driverFingerprint,routerFingerprint);
const hash=(text:string)=>createHmac("sha256",secret).update(text).digest("hex");
const urls=(db:string,user:string)=>`postgresql://${user}@127.0.0.1:${port}/${db}`;
const servers:any[]=[],closers:Array<()=>Promise<unknown>>=[];
const checkpoints:Record<string,string>={};
try {
 if(!reuse){
 for(const name of ["driver_measurements_migrator","driver_measurements_runtime","ai_router_migrator","ai_router_runtime","sim_measurements_guard_runtime","ai_router_guard_runtime"]){
  if(!(await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1",[name])).rowCount)await admin.query(`CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
 }
 for(const [db,owner] of [["sim_driver_measurements","driver_measurements_migrator"],["sim_ai_router","ai_router_migrator"]]){
  assert.equal((await admin.query("SELECT 1 FROM pg_database WHERE datname=$1",[db])).rowCount,0,"Do not overwrite an existing target fixture");
  await admin.query(`CREATE DATABASE ${db} OWNER ${owner}`);
 }
 await guardAdmin.query(await source("deploy/account-safety/010_sim_database_safety_v2.sql"));
 assert.equal((await guardAdmin.query("SELECT count(*)::int n FROM sim_erasure_guard_v2.store")).rows[0].n,0,"Explicit enrollment only into fresh fixture");
 await guardAdmin.query("INSERT INTO sim_erasure_guard_v2.store(store_id,configuration_fingerprint) VALUES($1,$2)",[guardId,fingerprint]);
 }
 const dOwner=pool("sim_driver_measurements","driver_measurements_migrator"),aOwner=pool("sim_ai_router","ai_router_migrator");
 if(!reuse){
 for(const [db,runtime] of [["sim_driver_measurements","driver_measurements_runtime"],["sim_ai_router","ai_router_runtime"]]){
  const a=pool(db!,"cop_safety_test_admin");await a.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC; GRANT CONNECT ON DATABASE ${db} TO ${runtime}; REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${runtime}`);
 }
 await dOwner.query(await source("deploy/driver-measurements/schema.sql"));
 await dOwner.query("GRANT SELECT,INSERT,UPDATE,DELETE ON driver_measurement_receipts,driver_measurement_intervals,driver_measurement_eta,driver_measurement_revocations TO driver_measurements_runtime");
 for(const f of ["001_schema.sql","002_separate_billing.sql","003_account_erasure.sql"])await aOwner.query(await source("deploy/ai-router/"+f));
 await aOwner.query("GRANT SELECT,INSERT,UPDATE ON ai_router_request,ai_router_policy,ai_router_policy_audit TO ai_router_runtime; GRANT USAGE,SELECT ON SEQUENCE ai_router_policy_audit_id_seq TO ai_router_runtime");
 }
 const dRuntime=pool("sim_driver_measurements","driver_measurements_runtime");
 const dayIds=driverErasureRequiredDays(Date.now()).map((day,i)=>({contributorDay:day,contributorIdDay:createHash("sha256").update((reuse?"synthetic-joint-day-":"synthetic-A-day-")+i).digest("hex")}));
 const preservedHash=hash("cop:synthetic-B-day-contributor-not-erased");
 const seed=async(owner:any,contributor:string)=>{const batch=randomUUID();const c=await owner.connect();try{await c.query('BEGIN');if(checkpoints.sim_measurements)await c.query("SELECT set_config('sim.driver_erasure_context','driver-account-erasure-v1',true),set_config('sim.driver_erasure_checkpoint',$1,true)",[hash("cop:account-erasure-checkpoint:"+checkpoints.sim_measurements)]);await c.query("INSERT INTO driver_measurement_receipts VALUES('cop',$1,$2,$3,now(),now()+interval '7 days','{}')",[batch,contributor,"a".repeat(64)]);await c.query("INSERT INTO driver_measurement_intervals VALUES('cop',$1,$2,'synthetic-graph','1',now(),50,50,3)",[batch,createHash("sha256").update(batch).digest("hex")]);await c.query('COMMIT');return batch;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 if(!reuse){
 await seed(dOwner,hash("cop:"+dayIds.at(-1)!.contributorIdDay));await seed(dOwner,preservedHash);
 await dOwner.query(await source("deploy/driver-measurements/002_account_erasure.sql"));
 await dOwner.query(await source("deploy/driver-measurements/008_eta_contributor_binding_database_v2.sql"));
 for(const [name,owner] of [["sim_measurements",dOwner],["ai_router",aOwner]] as const){
  await owner.query(await source("deploy/account-safety/011_sim_target_binding.sql"));const store=randomUUID(),incarnation=randomUUID(),cp=randomUUID();checkpoints[name]=cp;
  await owner.query("INSERT INTO sim_erasure_dataset_binding VALUES(true,$1,$2,$3,$4,$5,1)",[guardId,store,incarnation,fingerprint,cp]);
  await guardAdmin.query("INSERT INTO sim_erasure_guard_v2.owner_binding(owner,guard_store_id,target_store_id,incarnation_id,configuration_fingerprint,checkpoint_id,restore_generation,state) VALUES($1,$2,$3,$4,$5,$6,1,'ready')",[name,guardId,store,incarnation,fingerprint,cp]);
 }
 await dOwner.query("UPDATE driver_account_erasure_state SET replay_ready=true,replay_checkpoint_hash=$1,proof_valid_until=now()+interval '1 day',retention_reviewed=true,report_protection='shared_generation_fence',publication_fence_verified=true",[hash("cop:account-erasure-checkpoint:"+checkpoints.sim_measurements)]);
 await aOwner.query("UPDATE ai_router_erasure_checkpoint SET identity_reviewed=true,replay_ready=true,cost_policy='aggregate-costs-current-month-v1',checkpoint_id=$1,checkpoint_generation=1",[checkpoints.ai_router]);
 }else{
  const enrolled=(await guardAdmin.query("SELECT * FROM sim_erasure_guard_v2.store WHERE singleton")).rows[0];assert.equal(enrolled.configuration_fingerprint,fingerprint);guardId=enrolled.store_id;
  await dOwner.query(await source("deploy/driver-measurements/008_eta_contributor_binding_database_v2.sql"));
  for(const [name,owner] of [["sim_measurements",dOwner],["ai_router",aOwner]] as const){const b=(await owner.query("SELECT * FROM sim_erasure_dataset_binding WHERE singleton")).rows[0];assert.equal(b.guard_store_id,guardId);assert.equal(b.configuration_fingerprint,fingerprint);checkpoints[name]=b.checkpoint_id;}
  await seed(dOwner,hash("cop:"+dayIds.at(-1)!.contributorIdDay));
 }
 Object.assign(process.env,{NODE_ENV:"test",DRIVER_MEASUREMENT_REPORTS_DIR:reportDirectory,SIM_ACCOUNT_ERASURE_AUTHORITY_MODE:"database_v2",SIM_ACCOUNT_ERASURE_GUARD_DATABASE_URL:urls("cop_account_safety_guard","sim_measurements_guard_runtime"),SIM_ACCOUNT_ERASURE_GUARD_STORE_ID:guardId,SIM_ACCOUNT_ERASURE_CONFIGURATION_FINGERPRINT:fingerprint,
  SIM_ACCOUNT_ERASURE_DRIVER_IDENTITY_FINGERPRINT:driverFingerprint,SIM_ACCOUNT_ERASURE_ROUTER_IDENTITY_FINGERPRINT:routerFingerprint,AI_ROUTER_USER_HASH_SECRET:secret,AI_ROUTER_COP_ACTOR_SECRET:actorSecret,AI_ROUTER_ACCOUNT_ERASURE_ISSUER:issuer,
  DRIVER_MEASUREMENTS_DATABASE_URL:urls("sim_driver_measurements","driver_measurements_runtime"),DRIVER_MEASUREMENTS_HASH_SECRET:secret,DRIVER_MEASUREMENTS_COP_TOKEN:copToken,DRIVER_MEASUREMENTS_ENABLED:"true",DRIVER_ACCOUNT_ERASURE_ENABLED:"true",DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET:actorSecret,DRIVER_ACCOUNT_ERASURE_ISSUER:issuer,DRIVER_ACCOUNT_ERASURE_REPLAY_CHECKPOINT:checkpoints.sim_measurements});
 const dBinding=await loadDatabaseDriverOwnerComposition();closers.push(dBinding.close);
 const dApp=express();dApp.use(express.json());const retention=registerDriverMeasurementRoutes(dApp,{} as any,undefined,dBinding.driverMeasurements);closers.push(()=>retention.close());
 const limits={dailyMicrousd:1000000,monthlyMicrousd:10000000,perUserDailyRequests:10};
 const budget=new BudgetStore(urls("sim_ai_router","ai_router_runtime"),secret,limits);closers.push(()=>budget.close());await budget.init();
 process.env.SIM_ACCOUNT_ERASURE_GUARD_DATABASE_URL=urls("cop_account_safety_guard","ai_router_guard_runtime");
 const aBinding=await loadDatabaseRouterGuard(budget.pool);closers.push(aBinding.close);
 const eraser=new PgAccountErasure(budget.pool,"aggregate-costs-current-month-v1",true,cp=>aBinding.safety.verifyRouterCheckpoint(cp),aBinding.safety);budget.accountErasure=eraser;
 const separate=new PgSeparateBilling(budget.pool,createHash("sha256").update("synthetic-fixture-encryption-key-no-production-use").digest("base64"),eraser);
 const aiConfig={copToken,simToken:"synthetic-sim-token-other-than-cop",adminToken:"synthetic-admin-token-other-than-cop",copActorSecret:actorSecret,userHashSecret:secret,accountErasureIssuer:issuer,accountErasureEnabled:true,copByokEnabled:true,simIzsEnabled:false,economyModel:"gpt-6-luna",advancedModel:"gpt-6-sol",externalEnabled:false,advancedEnabled:false,byokDailyMicrousd:1000000,byokMonthlyMicrousd:10000000,byokDailyRequests:10} as any;
 const aApp=createRouterApp(aiConfig,budget,separate,eraser);
 const listen=async(app:any)=>{const server=await new Promise<any>(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});servers.push(server);return `http://127.0.0.1:${server.address().port}`;};
 const driverUrl=await listen(dApp),routerUrl=await listen(aApp);
 const driverPath="/api/v1/internal/driver-measurements/v1/account-erasure-operations",routerPath="/api/v1/ai-router/cop/users/me/erasure-operations";
 const operationId=randomUUID(),alias="cop_"+(reuse?"C":"A").repeat(43),subject=reuse?"synthetic-joint-account-COP":"synthetic-account-A";
 const actor={iss:issuer,sub:subject,aud:"sim-account-erasure" as const,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+60,operationId,routerUserId:alias};
 const headers=(sub=subject)=>{const text=Buffer.from(JSON.stringify({...actor,sub})).toString("base64url");return {authorization:`Bearer ${copToken}`,"content-type":"application/json","x-cop-actor":text,"x-cop-actor-signature":createHmac("sha256",actorSecret).update(text).digest("hex")};};
 const identity=erasureIdentity(actor,secret,(client,user)=>budget.hashUser(client,user));
 const bTarget=budget.hashUser("cop","cop_"+"B".repeat(43)),simTarget=budget.hashUser("sim",alias);
 await separate.putKey(identity.targetHash,"synthetic-key-A-never-sent");await separate.putKey(bTarget,"synthetic-key-B-never-sent");await separate.putKey(simTarget,"synthetic-key-SIM-preserved");
 const body={contractVersion:"sim-account-erasure-v1",operationId,contributors:dayIds,attestation:"cop-account-erasure-contributors-reviewed-v1"};
 const call=async(url:string,path:string,method="GET",payload?:unknown,h:Record<string,string>={authorization:`Bearer ${copToken}`})=>{const r=await fetch(url+path,{method,headers:h,...(payload===undefined?{}:{body:JSON.stringify(payload)})});return {status:r.status,body:await r.json() as any};};
 let passed=0;const check=async(name:string,work:()=>Promise<void>)=>{await work();passed++;console.log(`PASS ${name}`);};
 if(args[0]!=="--run"){
  const file="/private/tmp/sim-erasure-http-fixture-20261015.json";await writeFile(file,JSON.stringify({cluster:owned.name,port,driverUrl,routerUrl,driverPath,routerPath,issuer,copToken,actorSecret,driverHashSecret:secret,guardId,fingerprint,driverCheckpoint:checkpoints.sim_measurements,driverBody:body,actor,routerAlias:alias},null,2),{mode:0o600,flag:"wx"});
  console.log(JSON.stringify({fixture:file,driverUrl,routerUrl,productionChanged:false}));
  await new Promise<void>(resolve=>{process.once("SIGINT",()=>resolve());process.once("SIGTERM",()=>resolve());});
 } else {
  await check("actual HTTP capabilities and actor-bound preflight",async()=>{for(const [url,path] of [[driverUrl,driverPath],[routerUrl,routerPath]])assert.equal((await call(url,path+"/capability")).body.ready,true);
   assert.equal((await call(driverUrl,driverPath+"/preflight","POST",body,headers())).body.ready,true);
   assert.equal((await call(routerUrl,routerPath+"/preflight","POST",{contractVersion:"sim-account-erasure-v1",operationId},headers())).body.ready,true);});
  await check("unauthorized and malformed HTTP input never creates a guard tombstone",async()=>{assert.equal((await call(driverUrl,driverPath,"POST",body,{})).status,401);assert.equal((await call(driverUrl,driverPath,"POST",{},headers())).status,400);assert.equal((await guardAdmin.query("SELECT count(*)::int n FROM sim_erasure_guard_v2.tombstone")).rows[0].n,0);});
  await check("driver actual POST deletes cascades, preserves B, completes under actual publication lock",async()=>{const r=await call(driverUrl,driverPath,"POST",body,headers());assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.databaseZeroVerified,true);assert.equal(r.body.derivedReportAcknowledged,true);assert.equal((await dRuntime.query("SELECT count(*)::int n FROM driver_measurement_receipts")).rows[0].n,1);assert.equal((await dRuntime.query("SELECT contributor_hash FROM driver_measurement_receipts")).rows[0].contributor_hash.trim(),preservedHash);});
  await check("driver HTTP retry is idempotent and foreign actor cannot read the receipt",async()=>{assert.equal((await call(driverUrl,driverPath,"POST",body,headers())).status,200);assert.equal((await call(driverUrl,driverPath+"/"+operationId,"GET",undefined,headers("synthetic-account-B"))).status,404);assert.equal((await guardAdmin.query("SELECT count(*)::int n FROM sim_erasure_guard_v2.tombstone WHERE owner='sim_measurements'")).rows[0].n,1);});
  await check("late batch cannot recreate the erased contribution",async()=>{await assert.rejects(()=>seed(dRuntime,hash("cop:"+dayIds.at(-1)!.contributorIdDay)),(e:any)=>e.code==="23514");});
  await check("cross-owner ETA cannot attach A to preserved B parent",async()=>{const parent=(await dRuntime.query("SELECT batch_id FROM driver_measurement_receipts WHERE contributor_hash=$1",[preservedHash])).rows[0].batch_id;await assert.rejects(()=>dRuntime.query("INSERT INTO driver_measurement_eta VALUES('cop',$1,$2,$3,'synthetic-graph',now(),100,110)",[parent,randomUUID(),hash("cop:"+dayIds.at(-1)!.contributorIdDay)]),(e:any)=>e.code==="23503");assert.equal((await dRuntime.query("SELECT count(*)::int n FROM driver_measurement_receipts WHERE batch_id=$1 AND contributor_hash=$2",[parent,preservedHash])).rows[0].n,1);});
  let reservation="";
  await check("router actual HTTP returns202 while a real reservation is pending",async()=>{reservation=await separate.reserve("user_openai_key",identity.targetHash,identity.targetHash,"synthetic-fingerprint",null,"cop_chat","no-provider",10,{dailyMicrousd:1000000,monthlyMicrousd:10000000,dailyRequests:10});const r=await call(routerUrl,routerPath,"POST",{contractVersion:"sim-account-erasure-v1",operationId},headers());assert.equal(r.status,202,JSON.stringify(r));assert.equal(r.body.onlineScopeComplete,false);assert.equal(r.body.pendingRequestCount,1);});
  await check("actual reservation settlement completes deletion without changing SIM or B",async()=>{await separate.finish(reservation,"success",3,4,8);await eraser.processPending();const r=await call(routerUrl,routerPath+"/"+operationId,"GET",undefined,headers());assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.aliasScope,"sim_izs_preserved_out_of_scope");assert.equal((await separate.getKey(bTarget))?.apiKey,"synthetic-key-B-never-sent");assert.equal((await separate.getKey(simTarget))?.apiKey,"synthetic-key-SIM-preserved");assert.equal((await budget.pool.query("SELECT count(*)::int n FROM ai_router_user_key WHERE user_hash=$1",[identity.targetHash])).rows[0].n,0);});
  await check("guard role isolation and immutable enrollment/tombstones",async()=>{const g=pool("cop_account_safety_guard","sim_measurements_guard_runtime");assert.equal((await g.query("SELECT count(*)::int n FROM sim_erasure_guard_v2.tombstone WHERE owner='ai_router'")).rows[0].n,0);await assert.rejects(()=>g.query("UPDATE sim_erasure_guard_v2.owner_binding SET state='quarantined'"),(e:any)=>e.code==="42501");await assert.rejects(()=>g.query("DELETE FROM sim_erasure_guard_v2.tombstone"),(e:any)=>e.code==="42501");});
  await check("restart actually replays a removed local driver projection before admission",async()=>{await dOwner.query("DELETE FROM driver_account_erasure_operations;DELETE FROM driver_account_erasure_revocations");const g=pool("cop_account_safety_guard","sim_measurements_guard_runtime");const restart=new DatabaseErasureGuard({guardPool:g,targetPool:dRuntime,owner:"sim_measurements",guardStoreId:guardId,configurationFingerprint:fingerprint,driverHashSecret:secret});await restart.init();assert.equal((await dRuntime.query("SELECT count(*)::int n FROM driver_account_erasure_operations")).rows[0].n,1);await assert.rejects(()=>seed(dRuntime,hash("cop:"+dayIds.at(-1)!.contributorIdDay)),(e:any)=>e.code==="23514");});
  await check("actual guard quarantine and target incarnation mismatch fail closed",async()=>{await guardAdmin.query("UPDATE sim_erasure_guard_v2.owner_binding SET state='quarantined' WHERE owner='ai_router'");assert.equal((await call(routerUrl,routerPath+"/"+operationId,"GET",undefined,headers())).status,503);await guardAdmin.query("UPDATE sim_erasure_guard_v2.owner_binding SET state='ready' WHERE owner='ai_router'");const saved=(await aOwner.query("SELECT incarnation_id FROM sim_erasure_dataset_binding")).rows[0].incarnation_id;await aOwner.query("UPDATE sim_erasure_dataset_binding SET incarnation_id=$1",[randomUUID()]);assert.equal((await call(routerUrl,routerPath+"/capability")).body.ready,false);await aOwner.query("UPDATE sim_erasure_dataset_binding SET incarnation_id=$1",[saved]);});
  console.log(JSON.stringify({passed,scope:"actual_sim_http_postgresql_database_v2",cluster:owned.name,providerCalls:0,productionChanged:false,wholeCopFlowAccepted:false}));
 }
} finally {
 for(const server of servers)await new Promise<void>(resolve=>server.close(()=>resolve()));
 for(const close of closers.reverse())await close().catch(()=>{});
 for(const p of pools)await p.end().catch(()=>{});
 // The cluster and databases belong to the coordinated COP fixture. Never stop,
 // drop or prune them here. In --serve they remain available until explicit stop.
}
