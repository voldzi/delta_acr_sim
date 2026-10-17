/** ONE admitted synthetic seed of the already-running owner-empty 956 fixture.
 * No restart/enrollment/new identity/refresh/provider request/production target. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import{createRequire}from'node:module';
import{seedCleanWhole,forbidExternalFixtureFetch}from'/fixture-clean/scripts/fixtures/clean-whole-sim-v1.mjs';
import{BudgetStore}from'/runtime/router/apps/ai-router-api/dist/budget.js';
import{PgSeparateBilling}from'/runtime/router/apps/ai-router-api/dist/separate-billing.js';
import{loadCleanRouterComposition}from'/runtime/router/apps/ai-router-api/dist/clean-bootstrap.js';
assert.deepEqual(process.argv.slice(2),['--seed-after-common-enrollment']);
const D='/dev/shm/cop-clean-whole',R='/private/tmp/sim-user-install-pg-956262c6abdb';process.umask(0o077);
let composition,store,guard,pool,driverPool;
try{
const cfg=JSON.parse(await fs.readFile(D+'/sim-private.json')),resume=JSON.parse(await fs.readFile(D+'/sim-resume-private.json')),seed=JSON.parse(await fs.readFile(D+'/keycloak-admitted-seed.json'));
const b=cfg.input.base,e=b.environment;assert.equal(b.resetEpoch,'a7f98504-9c29-4942-8fb3-7236ab819a07');
const input=Object.fromEntries(['a','b'].map(n=>{const x=seed.actors[n],c=JSON.parse(Buffer.from(x.cop.access_token.split('.')[1],'base64url'));assert.equal(c.sub,b.actors[n].subjectId);assert.ok(c.exp-Math.floor(Date.now()/1000)>=90,'FRESH_KC_REFRESH_REQUIRED');return[n,x.cop.access_token]}));
for(const n of ['a','b']){const r=await fetch('http://127.0.0.1:8080/realms/cop/protocol/openid-connect/userinfo',{headers:{authorization:'Bearer '+input[n]},signal:AbortSignal.timeout(4000)});assert.equal(r.status,200);assert.equal((await r.json()).sub,b.actors[n].subjectId);}
const read=async()=>{const r=await fetch('http://127.0.0.1:4324/readback',{headers:{authorization:'Bearer '+e.copServiceToken},signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);return r.json()};
const before=await read();for(const n of ['a','b']){assert.equal(before.appOwners[n].state,'unused');assert.equal(before.simHistory[n].state,'unused')}
for(const[lane,owner]of[['ai','ai_router'],['driver','sim_measurements']])assert.equal(before[lane].owners[owner].removableA+before[lane].owners[owner].removableB,0);
const{Pool}=createRequire('/runtime/router/apps/ai-router-api/package.json')('pg');pool=new Pool({host:R+'/s',port:5000,user:'fixture_admin',database:'sim_ai_router'});
const enrollment=(await pool.query('SELECT c.*,p.user_dataset_id,p.enrollment_id FROM sim_clean.config c CROSS JOIN sim_clean.production_enrollment p WHERE c.singleton AND p.singleton')).rows[0];
const uri='postgresql://ai_router_runtime:'+resume.credentials.ai_router_runtime+'@haproxy.home.cz:5000/sim_ai_router?sslmode=verify-full&sslrootcert=%2Fetc%2Fcsm-sim%2Fpostgresql-ca.pem';
const limits={dailyMicrousd:1000000,monthlyMicrousd:10000000,perUserDailyRequests:100};store=new BudgetStore(uri,e.routerHashSecret,limits);
const config={databaseUrl:uri,copToken:e.copServiceToken,simToken:e.routerSimToken,adminToken:e.routerAdminToken,userHashSecret:e.routerHashSecret,copActorSecret:e.routerActorSecret,accountErasureIssuer:b.issuer,accountErasureEnabled:false,...limits};
const env={SIM_CLEAN_LIFECYCLE_ENABLED:'true',SIM_CLEAN_LIFECYCLE_MODE:'production-clean-lifecycle-v1',SIM_CLEAN_LIFECYCLE_ENVIRONMENT_ID:b.environmentId,SIM_CLEAN_LIFECYCLE_RESET_EPOCH:b.resetEpoch,SIM_CLEAN_LIFECYCLE_TOKENS_NOT_BEFORE:String(b.tokensNotBefore),SIM_CLEAN_LIFECYCLE_USER_DATASET_ID:enrollment.user_dataset_id,SIM_CLEAN_LIFECYCLE_PRODUCTION_ENROLLMENT_ID:enrollment.enrollment_id,SIM_CLEAN_COMPLETED_REPLAY_MODE:'same-epoch-completed-content-replay-v1'};
composition=await loadCleanRouterComposition(config,store,env);await store.init();
const separate=new PgSeparateBilling(store.pool,e.routerEncryptionKey,composition.gate);separate.cleanLifecycleEnabled=true;await separate.checkSchema();
guard=forbidExternalFixtureFetch();
await seedCleanWhole({component:'ai',input:b,api:'http://127.0.0.1:4312',runtime:store.pool,store,separate,guard});
driverPool=new Pool({connectionString:'postgresql://driver_measurements_runtime:'+resume.credentials.driver_measurements_runtime+'@haproxy.home.cz:5000/sim_driver_measurements?sslmode=verify-full&sslrootcert=%2Fetc%2Fcsm-sim%2Fpostgresql-ca.pem'});
await seedCleanWhole({component:'driver',input:b,api:'http://127.0.0.1:4311',runtime:driverPool,guard});
for(const n of ['a','b'])for(const[path,body]of[
 ['/api/v1/scenarios',{name:'Synthetic admitted civil scenario',description:'Fictional civil fixture only',area:{type:'BBOX',bbox:[14,49.8,15,50.3]},durationSeconds:60,seed:17,blocks:[{blockId:'rescue-sim',enabled:true,objectCount:1,updateRateHz:1}],faults:[]}],
 ['/api/v1/ai/router-scenario-drafts',{prompt:'Fictional civil flood exercise only',syntheticOnly:true}]
]){const r=await fetch('http://127.0.0.1:4314'+path,{method:'POST',headers:{authorization:'Bearer '+input[n],'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(7000)});assert.equal(r.status,201);await r.body?.cancel();}
const after=await read();for(const n of ['a','b']){assert.equal(after.appOwners[n].fileCount,4);assert.equal(after.appOwners[n].state,'active');assert.equal(after.simHistory[n].requests,1)}
for(const[lane,owner]of[['ai','ai_router'],['driver','sim_measurements']])for(const n of ['A','B'])assert.equal(after[lane].owners[owner]['removable'+n],4);
assert.equal(guard.attempts,0);await fs.writeFile(D+'/admitted-seed-readback-private.json',JSON.stringify(after),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({contractVersion:'fresh-956-admitted-sim-seed-v1',actualRunningApisUsed:true,actualSignedOidcUsers:2,actualAiRowsPerActor:4,actualDriverRowsPerActor:4,actualHistoryRowsPerActor:1,actualMainFilesPerActor:4,syntheticSeparateBillingFixtureMethodsUsed:true,actualExternalKeyValidation:false,externalProviderAttempts:0,identitiesOrCredentialsChanged:false,servicesRestarted:false,productionTouched:false,wholeAccountComplete:false}));
}catch(e){console.error(JSON.stringify({error:'FRESH_956_ADMITTED_SEED_FAILED',code:e.code,locations:[...String(e.stack).matchAll(/(seed-admitted-fresh-956-sim.mjs:\d+:\d+)/g)].map(x=>x[1]),wholeAccountComplete:false}));process.exitCode=1;}
finally{guard?.restore();await composition?.close();await store?.close();await pool?.end();await driverPool?.end();}
