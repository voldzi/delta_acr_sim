/** Exact isolated completed OP; strict SQL identity+preservation before/during/after. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {cleanFixtureHeaders} from '/fixture-clean/scripts/fixtures/clean-whole-sim-v1.mjs';
import {appDeletionHeaders} from '/fixture-clean/scripts/fixtures/clean-whole-sim-user-data-v2.mjs';
import {canonicalOwnerKey,signSimOwner} from '/app/packages/sim-user-data/claims.mjs';
import {validateCompletedRouterOutageV3} from '/private/tmp/sim-user-install-pg-956262c6abdb/completed-router-outage-v3.mjs';
assert.deepEqual(process.argv.slice(2),['--completed-only-v3']);
const ROOT='/private/tmp/sim-user-install-pg-956262c6abdb',D='/dev/shm/cop-clean-whole';
const expected={operationId:'b1c21024-0c2f-4a3d-afad-911f95d73c1b',resetEpoch:'a7f98504-9c29-4942-8fb3-7236ab819a07',routerImage:'sha256:b6c5698553ca85e006e5af9c14532552ed794890661faa3306ca1c88309f9d73',testBundleImage:'sha256:739582dea16349b4d42b9c4c4b2250b6de616eaeb803b15a3013b0cc7d0a2118'};
const cfg=JSON.parse(await fs.readFile(D+'/sim-private.json'));assert.equal(cfg.input.base.resetEpoch,expected.resetEpoch);
const{Pool}=createRequire('/runtime/router/apps/ai-router-api/package.json')('pg'),pools=[];
const pool=db=>{const p=new Pool({host:ROOT+'/s',port:5000,user:'fixture_admin',database:db,max:1,connectionTimeoutMillis:3000});p.on('error',()=>{});pools.push(p);return p};
const ai=pool('sim_ai_router'),driver=pool('sim_driver_measurements'),main=pool('sim_user_data'),guard=pool('cop_account_safety_guard');
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function table(p,name){assert.match(name,/^[a-z_]+\.[a-z_]+$/);return(await p.query(`SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]'::jsonb) rows FROM ${name} x`)).rows[0].rows}
async function binding(){
 const out={};for(const[n,p,s]of[['ai',ai,'sim_clean'],['driver',driver,'sim_clean'],['main',main,'sim_user_data'],['history',ai,'sim_user_history']]){
  const r=(await p.query(`SELECT j.operation_id,a.reset_epoch,a.state FROM ${s}.job j JOIN ${s}.account a USING(owner_key)`)).rows;
  assert.equal(r.length,1);assert.equal(r[0].operation_id,expected.operationId);assert.equal(r[0].reset_epoch,expected.resetEpoch);assert.equal(r[0].state,'deleted');
  out[n]={operationId:r[0].operation_id,resetEpoch:r[0].reset_epoch,accountState:r[0].state};
 }return out;
}
async function read(){
 const r=await fetch('http://127.0.0.1:4324/readback',{headers:{authorization:'Bearer '+cfg.input.base.environment.copServiceToken},signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);return r.json();
}
async function preserved(){
 const r=await read(),jobs={};
 for(const[n,p,s]of[['ai',ai,'sim_clean'],['driver',driver,'sim_clean'],['main',main,'sim_user_data'],['history',ai,'sim_user_history']])for(const t of ['account','job','resource'])jobs[n+'.'+t]=await table(p,s+'.'+t);
 const finance={ai:await table(ai,'sim_clean.cost_daily'),driver:await table(driver,'sim_clean.cost_daily')};
 const tables=(await ai.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND (tablename LIKE 'ai_router_%' OR tablename LIKE 'sim_ai_%') ORDER BY tablename")).rows;
 for(const t of tables)finance[t.tablename]=await table(ai,'public.'+t.tablename);
 const g={};for(const t of (await guard.query("SELECT tablename FROM pg_tables WHERE schemaname='sim_erasure_guard_v2' ORDER BY tablename")).rows)g[t.tablename]=await table(guard,'sim_erasure_guard_v2.'+t.tablename);
 return {userB:hash({main:r.appOwners.b,history:r.simHistory.b,ai:r.ai.owners.ai_router.preservedBFingerprint,driver:r.driver.owners.sim_measurements.preservedBFingerprint}),jobsAndBindings:hash(jobs),finance:hash(finance),independentGuard:hash(g)};
}
let changed=false;
try{
 const id=(await ai.query("SELECT current_setting('cluster_name') n,current_setting('data_directory') d")).rows[0];assert.equal(id.n,'sim_whole12_tls_fixture_v1');assert.equal(id.d,ROOT+'/db');
 const j=(await ai.query('SELECT requested_at FROM sim_clean.job WHERE operation_id=$1',[expected.operationId])).rows;assert.equal(j.length,1);
 const headers=()=>cleanFixtureHeaders(cfg.input.base,'a','ai',{operationId:expected.operationId,requestedAt:j[0].requested_at.toISOString()});
 async function phase(){const r=await fetch('http://127.0.0.1:4312/api/v1/ai-router/internal/user-lifecycle/v1/deletions/'+expected.operationId,{headers:headers(),signal:AbortSignal.timeout(5000)});const x=await r.json();return{httpStatus:r.status,...(x.state?{httpState:x.state}:{}),loginAllowed:(await ai.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='ai_router_runtime'")).rows[0].rolcanlogin,databaseBindings:await binding()};}
 const beforePreserved=await preserved(),before=await phase();assert.equal(before.httpStatus,200);
 let during;
 try{await ai.query('ALTER ROLE ai_router_runtime NOLOGIN');changed=true;await ai.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='ai_router_runtime' AND datname='sim_ai_router' AND pid<>pg_backend_pid()");during=await phase();}
 finally{if(changed){await ai.query('ALTER ROLE ai_router_runtime LOGIN');changed=false}}
 let after;for(let i=0;i<20;i++){after=await phase();if(after.httpStatus===200)break;await new Promise(r=>setTimeout(r,250))}
 const afterPreserved=await preserved();assert.deepEqual(afterPreserved,beforePreserved);
 const rb=await read();assert.equal(rb.ai.externalProviderAttempts,0);assert.equal(rb.driver.externalProviderAttempts,0);
 const remaining={main:rb.appOwners.a.fileCount,history:rb.simHistory.a.requests+rb.simHistory.a.billing,ai:rb.ai.owners.ai_router.removableA,driver:rb.driver.owners.sim_measurements.removableA};
 const jobs={};for(const[n,p,s]of[['ai',ai,'sim_clean'],['driver',driver,'sim_clean'],['main',main,'sim_user_data'],['history',ai,'sim_user_history']]){
  const x=(await p.query(`SELECT requested_at FROM ${s}.job WHERE operation_id=$1`,[expected.operationId])).rows;assert.equal(x.length,1);jobs[n]={operationId:expected.operationId,requestedAt:x[0].requested_at.toISOString()};
 }
 const owner=canonicalOwnerKey(cfg.input.userDataEnvironment.ownerSecret,{issuer:cfg.input.base.issuer,subject:cfg.input.base.actors.a.subjectId});
 const finalReadbacks={};for(const[n,url,h]of[
  ['main','http://127.0.0.1:4314/api/v1/internal/sim-user-data/v1/deletions/',appDeletionHeaders(cfg.input,'a',jobs.main)],
  ['ai','http://127.0.0.1:4312/api/v1/ai-router/internal/user-lifecycle/v1/deletions/',cleanFixtureHeaders(cfg.input.base,'a','ai',jobs.ai)],
  ['driver','http://127.0.0.1:4311/api/v1/internal/user-lifecycle/v1/deletions/',cleanFixtureHeaders(cfg.input.base,'a','driver',jobs.driver)],
  ['history','http://127.0.0.1:4312/api/v1/ai-router/internal/sim-user-history/v1/deletions/',{authorization:'Bearer '+cfg.input.base.environment.routerSimToken,...signSimOwner(cfg.input.userDataEnvironment.routerActorSecret,{ownerKey:owner,resetEpoch:expected.resetEpoch,oidcIat:cfg.input.base.actors.a.oidcIat,...jobs.history})}]
 ]){
  const r=await fetch(url+expected.operationId,{headers:h,signal:AbortSignal.timeout(5000)}),body=await r.json();
  finalReadbacks[n]={httpStatus:r.status,state:body.state,remaining:remaining[n]};if(n==='history')assert.equal(body.remainingRecords,0);
 }
 const e={contractVersion:'sim-router-completed-operation-outage-v3',caseType:'already_completed_operation',...expected,phases:{before,during,after},preservation:Object.fromEntries(Object.keys(beforePreserved).map(k=>[k,{before:beforePreserved[k],after:afterPreserved[k]}])),finalReadbacks,loginRestored:after.loginAllowed,externalProviderAttempts:0,reseeded:false,productionTouched:false,pendingDeletionOutageClaimed:false};
 validateCompletedRouterOutageV3(e,expected);
 await fs.writeFile(D+'/completed-router-outage-v3.json',JSON.stringify(e)+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify(e));
}catch(e){console.error(JSON.stringify({error:'COMPLETED_OUTAGE_V3_FAILED',code:/^[A-Z0-9_]{1,60}$/.test(e.code??'')?e.code:undefined,locations:[...String(e.stack).matchAll(/(check-fresh-956-router-outage-v3.mjs:\d+:\d+)/g)].map(x=>x[1]),loginRestorationStillRequired:changed}));process.exitCode=1}
finally{if(changed)await ai.query('ALTER ROLE ai_router_runtime LOGIN');for(const p of pools)await p.end()}
