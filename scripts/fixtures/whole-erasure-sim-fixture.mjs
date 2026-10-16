/** Isolated whole-COP acceptance fixture, never a production entry point.
 * Uses the actual immutable-image runtime, real restricted PostgreSQL roles,
 * and identities supplied by COP. No provider/model/GPS calls are enabled. */
import assert from "node:assert/strict";
import {createHash,createHmac,randomUUID,timingSafeEqual} from "node:crypto";
import {createServer} from "node:http";
import {readFile,writeFile,mkdir,stat} from "node:fs/promises";
import {createRequire} from "node:module";
import {pathToFileURL} from "node:url";

const HOME="/fixture", PRIVATE=`${HOME}/private.json`;
const CONTRACT="cop-sim-whole-erasure-fixture-v1";
const FIXTURE_OWNERS=new Set(["cop-messaging-joint-d2630fa78b21","cop-messaging-joint-7fb1c640a2de"]);
const OWNER=process.env.SIM_FIXTURE_OWNER;
assert.ok(FIXTURE_OWNERS.has(OWNER),"Unreviewed fixture owner");
const ADMIN="owned_fixture_admin";
const GUARD_DB="cop_account_safety_guard";
const REPORTS="/private/tmp/cop-erasure-owned-whole-sim/driver-report-files";
const POLICY="aggregate-costs-current-month-v1";
let phase="entry";
const SQL={
 "deploy/driver-measurements/schema.sql":"6dd60a3acf28d63575198c8526c368df19bbd543f4063d4985fb55f308da02d0",
 "deploy/driver-measurements/002_account_erasure.sql":"f13db2106a1fe1a02d0d1a26afa8ad7d7c045172ba4419749719ed0f166e16ad",
 "deploy/driver-measurements/008_eta_contributor_binding_database_v2.sql":"4a156baee81ded14d01b9ce261cca82a4f835905d32f91418fc8f67038b3f185",
 "deploy/ai-router/001_schema.sql":"b6e48ea50286f25a16262e4e8f7c2f57a9629ea09e163db473820618bcb1a92b",
 "deploy/ai-router/002_separate_billing.sql":"e016cfa95cf228c4781780d844e9bc0c784aade6c36a21fa9667923d9b0bfbcb",
 "deploy/ai-router/003_account_erasure.sql":"921e19e1bae334bb3ae84dadfc9ab4b9cd333b4f515e77a3a286b68649426a56",
 "deploy/account-safety/010_sim_database_safety_v2.sql":"c7865609b4ccb88b220026f5a5844cfcdd9e492a6dbdf1da50471f062b95c3fa",
 "deploy/account-safety/011_sim_target_binding.sql":"fbd9e8230e8b2ef3bcbbc20bf023e3828fd004dd57f3042d6a210b286f5244ac"
};
const sha=x=>createHash("sha256").update(x).digest("hex");
const exact=(v,keys)=>{assert.ok(v&&typeof v==="object"&&!Array.isArray(v));assert.deepEqual(Object.keys(v).sort(),[...keys].sort());return v;};
export function validateWholeErasureFixture(v){
 exact(v,["contractVersion","issuer","actors","environment"]);
 assert.equal(v.contractVersion,CONTRACT);assert.match(v.issuer,/^https:\/\/[^\s]+$/);
 exact(v.actors,["a","b"]);
 for(const actor of Object.values(v.actors)){
  exact(actor,["subjectId","routerUserId","contributors"]);
  assert.match(actor.subjectId,/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.match(actor.routerUserId,/^cop_[A-Za-z0-9_-]{43}$/);
  assert.ok(Array.isArray(actor.contributors)&&actor.contributors.length>=9&&actor.contributors.length<=40);
  const pairs=new Set();
  for(const c of actor.contributors){exact(c,["contributorIdDay","contributorDay"]);assert.match(c.contributorIdDay,/^[A-Za-z0-9_-]{32,128}$/);assert.match(c.contributorDay,/^\d{4}-\d{2}-\d{2}$/);assert.equal(new Date(c.contributorDay+"T00:00:00Z").toISOString().slice(0,10),c.contributorDay);pairs.add(c.contributorDay+":"+c.contributorIdDay);}
  assert.equal(pairs.size,actor.contributors.length);
 }
 assert.notEqual(v.actors.a.subjectId,v.actors.b.subjectId);assert.notEqual(v.actors.a.routerUserId,v.actors.b.routerUserId);
 assert.ok(!v.actors.a.contributors.some(a=>v.actors.b.contributors.some(b=>a.contributorIdDay===b.contributorIdDay)));
 const env=exact(v.environment,["copServiceToken","driverHashSecret","driverActorSecret","routerHashSecret","routerActorSecret","routerEncryptionKey","routerSimToken","routerAdminToken"]);
 for(const [key,value] of Object.entries(env)){assert.equal(typeof value,"string");assert.ok(value.length>=32,key);assert.ok(!/[\u0000-\u001f\u007f]/.test(value));}
 assert.equal(Buffer.from(env.routerEncryptionKey,"base64").length,32);
 assert.equal(new Set([env.copServiceToken,env.routerSimToken,env.routerAdminToken]).size,3);
 return v;
}
const component=process.argv[3]==="driver"?"driver":"router";
const require=createRequire(`/app/apps/${component==="driver"?"situation-data-api":"ai-router-api"}/package.json`);
const {Pool}=require("pg");
const pools=[];
const pool=(database,user)=>{const p=new Pool({host:"127.0.0.1",port:5432,database,user,max:2,connectionTimeoutMillis:2000,statement_timeout:5000});pools.push(p);return p;};
const url=(db,user)=>`postgresql://${user}@127.0.0.1:5432/${db}`;
const load=async(component,name)=>import(pathToFileURL(`/app/apps/${component==="driver"?"situation-data-api":"ai-router-api"}/dist/${name}.js`).href);
const guardModule=()=>import("/app/deploy/account-safety/database-erasure-guard.mjs");
async function privateInput(){const s=await stat(PRIVATE);assert.equal(s.mode&0o777,0o600);assert.equal(s.uid,process.getuid());return JSON.parse(await readFile(PRIVATE,"utf8"));}
async function fixedSql(path){assert.ok(Object.hasOwn(SQL,path));const text=await readFile(`${HOME}/${path}`,"utf8");assert.equal(sha(text),SQL[path]);return text;}
async function ownedAdmin(){assert.equal(process.env.SIM_FIXTURE_OWNER,OWNER);assert.equal(process.env.NODE_ENV,"test");const p=pool("postgres",ADMIN);const row=(await p.query("SELECT current_setting('cluster_name') name,current_setting('data_directory') directory,version() version")).rows[0];assert.equal(row.name,"messaging_approved_joint_fixture");assert.equal(row.directory,"/var/lib/postgresql/approved-joint");assert.match(row.version,/PostgreSQL 18\./);return p;}
async function provision(input){
 phase="provision_preflight";validateWholeErasureFixture(input);for(const path of Object.keys(SQL))await fixedSql(path);const admin=await ownedAdmin();
 for(const db of ["sim_driver_measurements","sim_ai_router"])assert.equal((await admin.query("SELECT 1 FROM pg_database WHERE datname=$1",[db])).rowCount,0,"Refuse existing SIM target database");
 const roles=["driver_measurements_migrator","driver_measurements_runtime","ai_router_migrator","ai_router_runtime","sim_measurements_guard_runtime","ai_router_guard_runtime","sim_erasure_guard_owner"];
 for(const role of roles)assert.equal((await admin.query("SELECT 1 FROM pg_roles WHERE rolname=$1",[role])).rowCount,0,"Refuse pre-existing SIM role");
 phase="provision_roles";for(const role of roles)await admin.query(`CREATE ROLE ${role} ${role==="sim_erasure_guard_owner"?"NOLOGIN":"LOGIN"} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
 if(!(await admin.query("SELECT 1 FROM pg_database WHERE datname=$1",[GUARD_DB])).rowCount)await admin.query(`CREATE DATABASE ${GUARD_DB} OWNER ${ADMIN}`);
 const g=pool(GUARD_DB,ADMIN);assert.equal((await g.query("SELECT 1 FROM pg_namespace WHERE nspname='sim_erasure_guard_v2'")).rowCount,0);
 await g.query("GRANT CONNECT ON DATABASE cop_account_safety_guard TO sim_measurements_guard_runtime,ai_router_guard_runtime");
 for(const [db,owner,runtime] of [["sim_driver_measurements","driver_measurements_migrator","driver_measurements_runtime"],["sim_ai_router","ai_router_migrator","ai_router_runtime"]]){
  await admin.query(`CREATE DATABASE ${db} OWNER ${owner}`);const d=pool(db,ADMIN);await d.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC;GRANT CONNECT ON DATABASE ${db} TO ${owner},${runtime};REVOKE ALL ON SCHEMA public FROM PUBLIC;GRANT USAGE ON SCHEMA public TO ${runtime}`);
 }
 phase="provision_driver_schema";const d=pool("sim_driver_measurements","driver_measurements_migrator"),r=pool("sim_ai_router","ai_router_migrator");
 await d.query(await fixedSql("deploy/driver-measurements/schema.sql"));
 await d.query("GRANT SELECT,INSERT,UPDATE,DELETE ON driver_measurement_receipts,driver_measurement_intervals,driver_measurement_eta,driver_measurement_revocations TO driver_measurements_runtime");
 await d.query(await fixedSql("deploy/driver-measurements/002_account_erasure.sql"));await d.query(await fixedSql("deploy/driver-measurements/008_eta_contributor_binding_database_v2.sql"));
 phase="provision_router_schema";for(const f of ["001_schema.sql","002_separate_billing.sql","003_account_erasure.sql"])await r.query(await fixedSql(`deploy/ai-router/${f}`));
 await r.query("GRANT SELECT,INSERT,UPDATE ON ai_router_request,ai_router_policy,ai_router_policy_audit TO ai_router_runtime;GRANT USAGE,SELECT ON SEQUENCE ai_router_policy_audit_id_seq TO ai_router_runtime");
 phase="provision_guard_schema";await g.query(await fixedSql("deploy/account-safety/010_sim_database_safety_v2.sql"));
 await g.query("ALTER SCHEMA sim_erasure_guard_v2 OWNER TO sim_erasure_guard_owner;ALTER TABLE sim_erasure_guard_v2.store OWNER TO sim_erasure_guard_owner;ALTER TABLE sim_erasure_guard_v2.owner_binding OWNER TO sim_erasure_guard_owner;ALTER TABLE sim_erasure_guard_v2.tombstone OWNER TO sim_erasure_guard_owner;ALTER FUNCTION sim_erasure_guard_v2.immutable_tombstone() OWNER TO sim_erasure_guard_owner");
 phase="provision_enrollment";const m=await guardModule(),e=input.environment;
 const driverFp=m.runtimeIdentityFingerprint("sim_measurements",e.driverHashSecret,e.driverActorSecret,input.issuer),routerFp=m.runtimeIdentityFingerprint("ai_router",e.routerHashSecret,e.routerActorSecret,input.issuer);
 const fp=m.configurationFingerprint(driverFp,routerFp),guardId=randomUUID(),bindings={};
 await g.query("INSERT INTO sim_erasure_guard_v2.store(store_id,configuration_fingerprint) VALUES($1,$2)",[guardId,fp]);
 for(const [owner,p] of [["sim_measurements",d],["ai_router",r]]){
  const b={storeId:randomUUID(),incarnationId:randomUUID(),checkpointId:randomUUID(),restoreGeneration:1};bindings[owner]=b;
  await p.query(await fixedSql("deploy/account-safety/011_sim_target_binding.sql"));
  await p.query("INSERT INTO sim_erasure_dataset_binding VALUES(true,$1,$2,$3,$4,$5,1)",[guardId,b.storeId,b.incarnationId,fp,b.checkpointId]);
  await g.query("INSERT INTO sim_erasure_guard_v2.owner_binding(owner,guard_store_id,target_store_id,incarnation_id,configuration_fingerprint,checkpoint_id,restore_generation,state) VALUES($1,$2,$3,$4,$5,$6,1,'ready')",[owner,guardId,b.storeId,b.incarnationId,fp,b.checkpointId]);
 }
 const checkpoint=createHmac("sha256",e.driverHashSecret).update("cop:account-erasure-checkpoint:"+bindings.sim_measurements.checkpointId).digest("hex");
 await d.query("UPDATE driver_account_erasure_state SET replay_ready=true,replay_checkpoint_hash=$1,proof_valid_until=now()+interval '1 day',retention_reviewed=true,report_protection='shared_generation_fence',publication_fence_verified=true",[checkpoint]);
 await r.query("UPDATE ai_router_erasure_checkpoint SET identity_reviewed=true,replay_ready=true,cost_policy=$1,checkpoint_id=$2,checkpoint_generation=1",[POLICY,bindings.ai_router.checkpointId]);
 const state={contractVersion:CONTRACT,input,enrollment:{guardId,configurationFingerprint:fp,driverFingerprint:driverFp,routerFingerprint:routerFp,bindings},seed:{a:{batchId:randomUUID(),observationId:randomUUID()},b:{batchId:randomUUID(),observationId:randomUUID()}}};
 await writeFile(PRIVATE,JSON.stringify(state),{mode:0o600});
 console.log(JSON.stringify({status:"provisioned",databases:2,guardSchema:"sim_erasure_guard_v2",productionChanged:false,providerCalls:0}));
}
/** One exact failed, empty fixture installation only. Not a partial-state
 * adopter, production reset, or general database deletion operation. */
async function cleanupFailedOwnerTransfer(input,inspectOnly=false){
 assert.equal(OWNER,"cop-messaging-joint-d2630fa78b21","Historical repair is not authorized for the new case");
 phase="cleanup_failed_owner_transfer_preflight";validateWholeErasureFixture(input);
 const failure=JSON.parse(await readFile(`${HOME}/failure-router.json`,"utf8"));
 if(!inspectOnly)assert.deepEqual(failure,{code:"SIM_WHOLE_FIXTURE_FAILED",phase:"cleanup_failed_owner_transfer_preflight",sqlState:null});
 for(const path of Object.keys(SQL))await fixedSql(path);
 const admin=await ownedAdmin(),g=pool(GUARD_DB,ADMIN),d=pool("sim_driver_measurements",ADMIN),r=pool("sim_ai_router",ADMIN);
 const roles=["driver_measurements_migrator","driver_measurements_runtime","ai_router_migrator","ai_router_runtime","sim_measurements_guard_runtime","ai_router_guard_runtime","sim_erasure_guard_owner"];
 phase="inspect_roles";const actualRoles=(await admin.query("SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=ANY($1) ORDER BY rolname",[roles])).rows;
 assert.deepEqual(actualRoles.map(x=>x.rolname),[...roles].sort());
 for(const x of actualRoles){assert.ok(!x.rolsuper&&!x.rolcreatedb&&!x.rolcreaterole&&!x.rolreplication&&!x.rolbypassrls);assert.equal(x.rolcanlogin,x.rolname!=="sim_erasure_guard_owner");}
 assert.equal((await admin.query("SELECT count(*)::int n FROM pg_auth_members WHERE roleid IN(SELECT oid FROM pg_roles WHERE rolname=ANY($1)) OR member IN(SELECT oid FROM pg_roles WHERE rolname=ANY($1))",[roles])).rows[0].n,0);
 const databases=(await admin.query("SELECT datname,pg_get_userbyid(datdba) owner,oid FROM pg_database WHERE datname IN('sim_driver_measurements','sim_ai_router') ORDER BY datname")).rows;
 assert.deepEqual(databases.map(x=>[x.datname,x.owner]),[["sim_ai_router","ai_router_migrator"],["sim_driver_measurements","driver_measurements_migrator"]]);
 const inventories=[
  [d,"public","driver_measurements_migrator",["driver_measurement_receipts","driver_measurement_intervals","driver_measurement_eta","driver_measurement_revocations","driver_account_erasure_state","driver_account_erasure_operations","driver_account_erasure_revocations"],["driver_account_erasure_receipt_guard"],["deploy/driver-measurements/schema.sql","deploy/driver-measurements/002_account_erasure.sql","deploy/driver-measurements/008_eta_contributor_binding_database_v2.sql"]],
  [r,"public","ai_router_migrator",["ai_router_request","ai_router_policy","ai_router_policy_audit","ai_router_user_key","ai_router_user_key_audit","ai_router_billing_request","ai_router_erasure_checkpoint","ai_router_account_erasure","ai_router_erased_cost_daily"],["ai_router_cop_erasure_fence","ai_router_erasure_delete_scope","ai_router_erasure_operation_immutable"],["deploy/ai-router/001_schema.sql","deploy/ai-router/002_separate_billing.sql","deploy/ai-router/003_account_erasure.sql"]],
  [g,"sim_erasure_guard_v2",ADMIN,["store","owner_binding","tombstone"],["immutable_tombstone"],["deploy/account-safety/010_sim_database_safety_v2.sql"]]
 ];
 for(const [p,namespace,owner,tables,functions,files] of inventories){
  phase=`inspect_catalog_${owner}`;
  const rows=(await p.query("SELECT c.relname,pg_get_userbyid(c.relowner) owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN('r','p') ORDER BY c.relname",[namespace])).rows;
  assert.deepEqual(rows.map(x=>x.relname),[...tables].sort());assert.ok(rows.every(x=>x.owner===owner));
  const bodies=(await p.query("SELECT proname,prosrc FROM pg_proc WHERE pronamespace=$1::regnamespace ORDER BY proname",[namespace])).rows;
  assert.deepEqual(bodies.map(x=>x.proname),[...functions].sort());
  for(const f of bodies){let matches=[];for(const path of files){const text=await fixedSql(path);const pattern=new RegExp("CREATE OR REPLACE FUNCTION (?:sim_erasure_guard_v2\\.)?"+f.proname+"\\([\\s\\S]*?AS (\\$[a-zA-Z_]*\\$)([\\s\\S]*?)\\1","g");matches.push(...[...text.matchAll(pattern)].map(x=>x[2]));}assert.equal(matches.length,1);assert.equal(f.prosrc,matches[0]);}
  for(const table of tables){const n=(await p.query(`SELECT count(*)::int n FROM ${namespace}.${table}`)).rows[0].n;assert.equal(n,table==="driver_account_erasure_state"||table==="ai_router_erasure_checkpoint"?1:0);}
 }
 phase="inspect_initial_checkpoints";assert.equal((await d.query("SELECT count(*)::int n FROM driver_account_erasure_state WHERE NOT replay_ready AND replay_checkpoint_hash IS NULL AND proof_valid_until IS NULL AND NOT retention_reviewed AND report_protection='unverified' AND NOT publication_fence_verified")).rows[0].n,1);
 assert.equal((await r.query("SELECT count(*)::int n FROM ai_router_erasure_checkpoint WHERE NOT identity_reviewed AND NOT replay_ready AND cost_policy='pending_requires_review' AND checkpoint_id IS NOT NULL AND checkpoint_generation=0")).rows[0].n,1);
 for(const p of [d,r])assert.equal((await p.query("SELECT count(*)::int n FROM pg_class WHERE relname='sim_erasure_dataset_binding'")).rows[0].n,0);
 phase="inspect_fk_policies";const fk=(await d.query("SELECT array_agg(a.attname::text ORDER BY u.n) cols FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY u(num,n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=u.num WHERE c.conrelid='driver_measurement_eta'::regclass AND c.contype='f' GROUP BY c.oid")).rows;
 assert.deepEqual(fk.map(x=>x.cols),[["owner","batch_id","contributor_hash"]]);
 assert.equal((await r.query("SELECT count(*)::int n FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'router_%'")).rows[0].n,15);
 assert.equal((await g.query("SELECT count(*)::int n FROM pg_policies WHERE schemaname='sim_erasure_guard_v2'")).rows[0].n,4);
 phase="inspect_foreign_dependencies";const foreignDeps=(await g.query(`WITH own_rel AS(SELECT oid FROM pg_class WHERE relnamespace='sim_erasure_guard_v2'::regnamespace),own_proc AS(SELECT oid FROM pg_proc WHERE pronamespace='sim_erasure_guard_v2'::regnamespace),own_type AS(SELECT oid FROM pg_type WHERE typnamespace='sim_erasure_guard_v2'::regnamespace)
 SELECT count(*)::int n FROM pg_depend x WHERE ((x.refclassid='pg_namespace'::regclass AND x.refobjid='sim_erasure_guard_v2'::regnamespace) OR(x.refclassid='pg_class'::regclass AND x.refobjid IN(SELECT oid FROM own_rel)) OR(x.refclassid='pg_proc'::regclass AND x.refobjid IN(SELECT oid FROM own_proc)) OR(x.refclassid='pg_type'::regclass AND x.refobjid IN(SELECT oid FROM own_type))) AND NOT(
 (x.classid='pg_class'::regclass AND x.objid IN(SELECT oid FROM own_rel)) OR(x.classid='pg_class'::regclass AND x.deptype='i' AND x.objid IN(SELECT reltoastrelid FROM pg_class WHERE oid IN(SELECT oid FROM own_rel))) OR(x.classid='pg_proc'::regclass AND x.objid IN(SELECT oid FROM own_proc)) OR(x.classid='pg_type'::regclass AND x.objid IN(SELECT oid FROM own_type)) OR(x.classid='pg_constraint'::regclass AND x.objid IN(SELECT oid FROM pg_constraint WHERE connamespace='sim_erasure_guard_v2'::regnamespace)) OR(x.classid='pg_trigger'::regclass AND x.objid IN(SELECT oid FROM pg_trigger WHERE tgrelid IN(SELECT oid FROM own_rel))) OR(x.classid='pg_policy'::regclass AND x.objid IN(SELECT oid FROM pg_policy WHERE polrelid IN(SELECT oid FROM own_rel))) OR(x.classid='pg_attrdef'::regclass AND x.objid IN(SELECT oid FROM pg_attrdef WHERE adrelid IN(SELECT oid FROM own_rel))))`)).rows[0].n;assert.equal(foreignDeps,0);
 phase="inspect_role_dependencies";const ownOids=databases.map(x=>x.oid),guardOid=(await admin.query("SELECT oid FROM pg_database WHERE datname=$1",[GUARD_DB])).rows[0].oid;
 const refs=(await g.query("SELECT dbid,classid::regclass::text class,objid FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid IN(SELECT oid FROM pg_roles WHERE rolname=ANY($1))",[roles])).rows;
 const sharedObjects=(await g.query("SELECT oid,'pg_namespace' kind FROM pg_namespace WHERE nspname='sim_erasure_guard_v2' UNION ALL SELECT oid,'pg_class' FROM pg_class WHERE relnamespace='sim_erasure_guard_v2'::regnamespace UNION ALL SELECT oid,'pg_proc' FROM pg_proc WHERE pronamespace='sim_erasure_guard_v2'::regnamespace UNION ALL SELECT p.oid,'pg_policy' FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relnamespace='sim_erasure_guard_v2'::regnamespace")).rows;
 for(const ref of refs)assert.ok(ownOids.includes(ref.dbid)||(ref.dbid===0&&ref.class==="pg_database"&&[...ownOids,guardOid].includes(ref.objid))||(ref.dbid===guardOid&&sharedObjects.some(x=>x.kind===ref.class&&x.oid===ref.objid)));
 phase="inspect_connections";const pids=[];for(const p of [admin,g,d,r])pids.push((await p.query("SELECT pg_backend_pid() n")).rows[0].n);
 assert.equal((await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE (datname IN('sim_driver_measurements','sim_ai_router') OR usename=ANY($1)) AND pid<>ALL($2::int[])",[roles,pids])).rows[0].n,0);
 await d.end();await r.end();
 if(inspectOnly){console.log(JSON.stringify({status:"exact_empty_failed_fixture_verified_read_only",actualCatalogsChecked:8,zeroBusinessAndJournalRows:true,noForeignDependencies:true,mutates:false,productionChanged:false}));return;}
 phase="cleanup_exact_empty_fixture";
 await g.query("DROP SCHEMA sim_erasure_guard_v2 CASCADE");
 for(const db of ["sim_driver_measurements","sim_ai_router"])await admin.query(`DROP DATABASE ${db}`);
 await g.query("REVOKE CONNECT ON DATABASE cop_account_safety_guard FROM sim_measurements_guard_runtime,ai_router_guard_runtime");
 for(const role of roles)await admin.query(`DROP ROLE ${role}`);
 console.log(JSON.stringify({status:"removed_exact_empty_failed_fixture",observedFailureFile:failure,historicalInitialFailureReference:"actual-tool-output:7cb13b; provision_guard_schema/42601",sourcePins:SQL,actualCatalogsChecked:8,zeroBusinessAndJournalRows:true,noForeignDependencies:true,sharedGuardDatabasePreserved:true,productionChanged:false}));
}
function environment(state,part){
 const {input,enrollment}=state,e=input.environment,b=enrollment.bindings;
 Object.assign(process.env,{NODE_ENV:"test",SIM_ACCOUNT_ERASURE_AUTHORITY_MODE:"database_v2",SIM_ACCOUNT_ERASURE_GUARD_DATABASE_URL:url(GUARD_DB,part==="driver"?"sim_measurements_guard_runtime":"ai_router_guard_runtime"),SIM_ACCOUNT_ERASURE_GUARD_STORE_ID:enrollment.guardId,SIM_ACCOUNT_ERASURE_CONFIGURATION_FINGERPRINT:enrollment.configurationFingerprint,SIM_ACCOUNT_ERASURE_DRIVER_IDENTITY_FINGERPRINT:enrollment.driverFingerprint,SIM_ACCOUNT_ERASURE_ROUTER_IDENTITY_FINGERPRINT:enrollment.routerFingerprint,
 DRIVER_MEASUREMENT_REPORTS_DIR:REPORTS,DRIVER_MEASUREMENTS_DATABASE_URL:url("sim_driver_measurements","driver_measurements_runtime"),DRIVER_MEASUREMENTS_HASH_SECRET:e.driverHashSecret,DRIVER_MEASUREMENTS_COP_TOKEN:e.copServiceToken,DRIVER_MEASUREMENTS_ENABLED:"false",DRIVER_MEASUREMENTS_REVOCATION_ENABLED:"true",DRIVER_ACCOUNT_ERASURE_ENABLED:"true",DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET:e.driverActorSecret,DRIVER_ACCOUNT_ERASURE_ISSUER:input.issuer,DRIVER_ACCOUNT_ERASURE_REPLAY_CHECKPOINT:b.sim_measurements.checkpointId,
 AI_ROUTER_PORT:"4312",AI_ROUTER_DATABASE_URL:url("sim_ai_router","ai_router_runtime"),AI_ROUTER_COP_TOKEN:e.copServiceToken,AI_ROUTER_SIM_TOKEN:e.routerSimToken,AI_ROUTER_ADMIN_TOKEN:e.routerAdminToken,AI_ROUTER_USER_HASH_SECRET:e.routerHashSecret,AI_ROUTER_COP_ACTOR_SECRET:e.routerActorSecret,AI_ROUTER_CREDENTIAL_ENCRYPTION_KEY:e.routerEncryptionKey,AI_ROUTER_ACCOUNT_ERASURE_ISSUER:input.issuer,AI_ROUTER_ACCOUNT_ERASURE_ENABLED:"true",AI_ROUTER_ACCOUNT_ERASURE_REPLAY_READY:"true",AI_ROUTER_ACCOUNT_ERASURE_COST_POLICY:POLICY,AI_ROUTER_COP_BYOK_ENABLED:"true",AI_ROUTER_SIM_IZS_ENABLED:"false",AI_ROUTER_EXTERNAL_ENABLED:"false",AI_ROUTER_ADVANCED_ENABLED:"false",AI_ROUTER_COP_INTERNAL_MINIMIZED_ENABLED:"false",AI_ROUTER_LOCAL_URL:"",AI_ROUTER_LOCAL_URLS:"",OPENAI_API_KEY:"",AI_ROUTER_SIM_IZS_OPENAI_API_KEY:""});
}
const limits={dailyMicrousd:1000000,monthlyMicrousd:10000000,perUserDailyRequests:10};
async function routerRuntime(state){environment(state,"router");const {BudgetStore}=await load("router","budget"),{PgSeparateBilling}=await load("router","separate-billing"),{PgAccountErasure}=await load("router","account-erasure"),{loadDatabaseRouterGuard}=await load("router","database-erasure");
 const budget=new BudgetStore(process.env.AI_ROUTER_DATABASE_URL,state.input.environment.routerHashSecret,limits);await budget.init();const binding=await loadDatabaseRouterGuard(budget.pool);const eraser=new PgAccountErasure(budget.pool,POLICY,true,cp=>binding.safety.verifyRouterCheckpoint(cp),binding.safety);budget.accountErasure=eraser;await eraser.checkSchema();
 const separate=new PgSeparateBilling(budget.pool,state.input.environment.routerEncryptionKey,eraser);await separate.checkSchema();
 return {budget,binding,eraser,separate,async close(){await binding.close();await budget.close();}};
}
export async function seedWholeErasureFixture(state,part){
 phase=`seed_${part}`;validateWholeErasureFixture(state.input);environment(state,part);await ownedAdmin();
 if(part==="driver"){
  const api=await load("driver","driver-account-erasure"),p=pool("sim_driver_measurements","driver_measurements_runtime");assert.equal((await p.query("SELECT count(*)::int n FROM driver_measurement_receipts")).rows[0].n,0,"Fresh driver seed only");
  for(const name of ["a","b"]){const a=state.input.actors[name],s=state.seed[name];const parsed=api.parseDriverErasureRequest({contractVersion:"sim-account-erasure-v1",operationId:s.batchId,contributors:a.contributors,attestation:"cop-account-erasure-contributors-reviewed-v1"});const days=api.driverErasureRequiredDays(Date.now());assert.ok(days.every(day=>parsed.contributors.some(c=>c.contributorDay===day)));const contributor=parsed.contributors.at(-1);const hash=api.driverErasureHash(state.input.environment.driverHashSecret,"cop",contributor.contributorIdDay);const c=await p.connect();try{await c.query("BEGIN");await c.query("SELECT set_config('sim.driver_erasure_context','driver-account-erasure-v1',true),set_config('sim.driver_erasure_checkpoint',$1,true)",[createHmac("sha256",state.input.environment.driverHashSecret).update("cop:account-erasure-checkpoint:"+state.enrollment.bindings.sim_measurements.checkpointId).digest("hex")]);
   const receipt={contractVersion:"sim-driver-measurements-v1",batchId:s.batchId,receivedAt:new Date().toISOString(),acceptedIntervalCount:1,deduplicatedIntervalCount:0,rejectionCounts:{},etaAccepted:true,applicationMode:"shadow_only",rawPositionsStored:false};
   await c.query("INSERT INTO driver_measurement_receipts VALUES('cop',$1,$2,$3,now(),now()+interval '7 days',$4)",[s.batchId,hash,sha("fixture-receipt:"+s.batchId),receipt]);await c.query("INSERT INTO driver_measurement_intervals VALUES('cop',$1,$2,'sim-routing-2026-10-16-1','1',now(),50,50,3)",[s.batchId,sha("fixture-interval:"+s.batchId)]);await c.query("INSERT INTO driver_measurement_eta VALUES('cop',$1,$2,$3,'sim-routing-2026-10-16-1',now(),100,110)",[s.batchId,s.observationId,hash]);await c.query("COMMIT");}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}}
 }else{const r=await routerRuntime(state);try{assert.equal((await r.budget.pool.query("SELECT count(*)::int n FROM ai_router_user_key")).rows[0].n,0,"Fresh router seed only");for(const name of ["a","b","sim"]){const actor=state.input.actors[name==="sim"?"a":name],client=name==="sim"?"sim":"cop",hash=r.budget.hashUser(client,actor.routerUserId);await r.separate.putKey(hash,`synthetic-${name}-not-an-openai-key-never-transmitted`);const id=await r.budget.reserve(client,actor.routerUserId,"cop_chat","fixture-no-provider","fixture-local","simple","local_fast",10);await r.budget.finish(id,"success",3,4,8);const bill=await r.separate.reserve(name==="sim"?"sim_project":"user_openai_key",hash,hash,"synthetic-fixture-fingerprint",name==="sim"?"synthetic-fixture-project":null,name==="sim"?"sim_izs_summary":"cop_chat","fixture-no-provider",10,{dailyMicrousd:1000000,monthlyMicrousd:10000000,dailyRequests:10});await r.separate.finish(bill,"success",3,4,8);}}finally{await r.close();}}
 return {component:part,status:"seeded",syntheticActors:2,rawGpsStored:false,providerCalls:0,productionChanged:false};
}
export async function readWholeErasureFixture(state,part){
 phase=`read_${part}`;validateWholeErasureFixture(state.input);environment(state,part);await ownedAdmin();const result={component:part,actors:{},providerCalls:0,productionChanged:false};
 if(part==="driver"){const api=await load("driver","driver-account-erasure"),p=pool("sim_driver_measurements","driver_measurements_runtime");for(const name of ["a","b"]){const hashes=state.input.actors[name].contributors.map(c=>api.driverErasureHash(state.input.environment.driverHashSecret,"cop",c.contributorIdDay));const row=(await p.query("SELECT (SELECT count(*)::int FROM driver_measurement_receipts WHERE contributor_hash=ANY($1::text[])) receipts,(SELECT count(*)::int FROM driver_measurement_intervals i JOIN driver_measurement_receipts r USING(owner,batch_id) WHERE r.contributor_hash=ANY($1::text[])) intervals,(SELECT count(*)::int FROM driver_measurement_eta WHERE contributor_hash=ANY($1::text[])) eta",[hashes])).rows[0];result.actors[name]=row;}}
 else{const {BudgetStore}=await load("router","budget"),{PgSeparateBilling}=await load("router","separate-billing");const b=new BudgetStore(process.env.AI_ROUTER_DATABASE_URL,state.input.environment.routerHashSecret,limits);try{const separate=new PgSeparateBilling(b.pool,state.input.environment.routerEncryptionKey);for(const name of ["a","b","sim"]){const actor=state.input.actors[name==="sim"?"a":name],hash=b.hashUser(name==="sim"?"sim":"cop",actor.routerUserId);result.actors[name]=(await b.pool.query("SELECT (SELECT count(*)::int FROM ai_router_user_key WHERE user_hash=$1) keys,(SELECT count(*)::int FROM ai_router_user_key_audit WHERE user_hash=$1) key_audit,(SELECT count(*)::int FROM ai_router_request WHERE user_hash=$1) requests,(SELECT count(*)::int FROM ai_router_billing_request WHERE payer_hash=$1) billing",[hash])).rows[0];const key=await separate.getKey(hash);result.actors[name].syntheticKeyIntact=key?.apiKey===`synthetic-${name}-not-an-openai-key-never-transmitted`;const rows=(await b.pool.query("SELECT (SELECT jsonb_agg(to_jsonb(k) ORDER BY user_hash) FROM ai_router_user_key k WHERE user_hash=$1) keys,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM ai_router_user_key_audit a WHERE user_hash=$1) key_audit,(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM ai_router_request r WHERE user_hash=$1) requests,(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM ai_router_billing_request r WHERE payer_hash=$1) billing",[hash])).rows[0];result.actors[name].storedRowsFingerprint=sha(JSON.stringify(rows));}result.anonymousCostRows=(await b.pool.query("SELECT count(*)::int n FROM ai_router_erased_cost_daily")).rows[0].n;}finally{await b.close();}}
 if(part==="driver"){const api=await load("driver","driver-account-erasure"),p=pool("sim_driver_measurements","driver_measurements_runtime");for(const name of ["a","b"]){const hashes=state.input.actors[name].contributors.map(c=>api.driverErasureHash(state.input.environment.driverHashSecret,"cop",c.contributorIdDay));const rows=(await p.query("SELECT (SELECT jsonb_agg(to_jsonb(r) ORDER BY batch_id) FROM driver_measurement_receipts r WHERE contributor_hash=ANY($1::text[])) receipts,(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.batch_id,i.measurement_key) FROM driver_measurement_intervals i JOIN driver_measurement_receipts r USING(owner,batch_id) WHERE r.contributor_hash=ANY($1::text[])) intervals,(SELECT jsonb_agg(to_jsonb(e) ORDER BY batch_id) FROM driver_measurement_eta e WHERE contributor_hash=ANY($1::text[])) eta",[hashes])).rows[0];result.actors[name].storedRowsFingerprint=sha(JSON.stringify(rows));}}
 return result;
}
async function startReadbackBridge(state,part){
 let busy=false;
 const token=Buffer.from(`Bearer ${state.input.environment.copServiceToken}`);
 const server=createServer(async(req,res)=>{
  res.setHeader("Cache-Control","no-store");res.setHeader("Content-Type","application/json");
  const deny=(status,code)=>{res.writeHead(status);res.end(JSON.stringify({code}));};
  if(req.method!=="GET"||req.url!=="/readback"||req.headers.origin)return deny(404,"NOT_FOUND");
  const supplied=Buffer.from(typeof req.headers.authorization==="string"?req.headers.authorization:"");
  if(supplied.length!==token.length||!timingSafeEqual(supplied,token))return deny(401,"UNAUTHORIZED");
  if(busy)return deny(503,"SIM_FIXTURE_READBACK_UNAVAILABLE");
  busy=true;const firstPool=pools.length;
  try{
   const actual=await readWholeErasureFixture(state,part),columns=part==="driver"?["receipts","intervals","eta"]:["keys","key_audit","requests","billing"];
   const owner=part==="driver"?"sim_measurements":"ai_router",a=actual.actors.a,b=actual.actors.b;
   const output={contractVersion:"cop-whole-erasure-readback-v1",owners:{[owner]:{removableA:columns.reduce((n,k)=>n+a[k],0),removableB:columns.reduce((n,k)=>n+b[k],0),preservedBFingerprint:b.storedRowsFingerprint}},productionChanged:false,wholeCopAccepted:false};
   if(part==="router")output.simPreserved=actual.actors.sim;
   res.writeHead(200);res.end(JSON.stringify(output));
  }catch{deny(503,"SIM_FIXTURE_READBACK_UNAVAILABLE");}
  finally{const fresh=pools.splice(firstPool);for(const p of fresh)await p.end().catch(()=>{});busy=false;}
 });
 await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(part==="driver"?4321:4322,"127.0.0.1",resolve);});
 return server;
}
async function serve(state,part){
 phase=`serve_${part}`;validateWholeErasureFixture(state.input);await ownedAdmin();environment(state,part);let close,app;
 if(part==="driver"){await mkdir(REPORTS,{recursive:true,mode:0o700});const {loadDatabaseDriverOwnerComposition}=await load("driver","database-erasure"),{registerDriverMeasurementRoutes}=await load("driver","driver-measurements");const binding=await loadDatabaseDriverOwnerComposition();app=require("express")();app.use(require("express").json({limit:"1mb"}));const retention=registerDriverMeasurementRoutes(app,{},undefined,binding.driverMeasurements);await retention.start();close=async()=>{await retention.close();await binding.close();};}
 else{const r=await routerRuntime(state),{loadConfig}=await load("router","config"),{createApp}=await load("router","app");await r.eraser.processPending();app=createApp(loadConfig(),r.budget,r.separate,r.eraser);let advancing=false;const timer=setInterval(()=>{if(advancing)return;advancing=true;void r.eraser.processPending().catch(()=>{}).finally(()=>{advancing=false;});},15000);timer.unref();close=async()=>{clearInterval(timer);await r.close();};}
 const port=part==="driver"?4311:4312;const server=await new Promise(resolve=>{const s=app.listen(port,"127.0.0.1",()=>resolve(s));});const bridge=await startReadbackBridge(state,part);console.log(JSON.stringify({status:"listening",component:part,port,readbackPort:part==="driver"?4321:4322,intakeEnabled:false,externalProvidersEnabled:false,productionChanged:false}));
 await new Promise(resolve=>{process.once("SIGINT",resolve);process.once("SIGTERM",resolve);});await new Promise(resolve=>bridge.close(resolve));await new Promise(resolve=>server.close(resolve));await close();
}
async function main(){
 const action=process.argv[2];assert.ok(["provision","serve","seed","read","validate","cleanup-failed-owner-transfer","inspect-failed-owner-transfer"].includes(action));const value=await privateInput();
 if(action==="inspect-failed-owner-transfer")return cleanupFailedOwnerTransfer(value,true);
 if(action==="cleanup-failed-owner-transfer")return cleanupFailedOwnerTransfer(value);
 if(action==="provision")return provision(value);
 if(action==="validate"){validateWholeErasureFixture(value.input??value);console.log(JSON.stringify({valid:true}));return;}
 assert.equal(value.contractVersion,CONTRACT);assert.ok(["driver","router"].includes(process.argv[3]));
 if(action==="serve")return serve(value,component);
 console.log(JSON.stringify(action==="seed"?await seedWholeErasureFixture(value,component):await readWholeErasureFixture(value,component)));
}
if(process.argv[1]===new URL(import.meta.url).pathname){main().catch(async error=>{const failure={code:"SIM_WHOLE_FIXTURE_FAILED",phase,sqlState:typeof error?.code==="string"&&/^[0-9A-Z]{5}$/.test(error.code)?error.code:null,sourceLine:error?.stack?.match(/whole-erasure-sim-fixture\.mjs:(\d+):/)?.[1]??null};const name=process.argv[2]?.includes("failed-owner-transfer")?"failure-cleanup.json":`failure-${component}.json`;await writeFile(`${HOME}/${name}`,JSON.stringify(failure),{mode:0o600}).catch(()=>{});console.error(JSON.stringify(failure));process.exitCode=1;}).finally(async()=>{for(const p of pools)await p.end().catch(()=>{});});}
