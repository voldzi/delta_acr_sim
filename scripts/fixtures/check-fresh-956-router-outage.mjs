/** Finite approved isolated outage; LOGIN always restored in finally. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {cleanFixtureHeaders} from '/fixture-clean/scripts/fixtures/clean-whole-sim-v1.mjs';
assert.deepEqual(process.argv.slice(2),['--isolated-outage']);
const OP='b1c21024-0c2f-4a3d-afad-911f95d73c1b',ROOT='/private/tmp/sim-user-install-pg-956262c6abdb';
const cfg=JSON.parse(await fs.readFile('/dev/shm/cop-clean-whole/sim-private.json'));
assert.equal(cfg.input.base.resetEpoch,'a7f98504-9c29-4942-8fb3-7236ab819a07');
const {Pool}=createRequire('/runtime/router/apps/ai-router-api/package.json')('pg');
const admin=new Pool({host:ROOT+'/s',port:5000,user:'fixture_admin',database:'sim_ai_router',max:1,connectionTimeoutMillis:3000});
let changed=false,unavailable,recovered,terminated,stage='connect';
try{
 const id=(await admin.query("SELECT current_user u,current_database() db,current_setting('cluster_name') n,current_setting('data_directory') d")).rows[0];
 stage='identity';assert.deepEqual(id,{u:'fixture_admin',db:'sim_ai_router',n:'sim_whole12_tls_fixture_v1',d:ROOT+'/db'});
 assert.equal((await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='ai_router_runtime'")).rows[0].rolcanlogin,true);
 const jobs=(await admin.query('SELECT operation_id,requested_at FROM sim_clean.job')).rows;assert.equal(jobs.length,1);assert.equal(jobs[0].operation_id,OP);
 const headers=()=>cleanFixtureHeaders(cfg.input.base,'a','ai',{operationId:OP,requestedAt:jobs[0].requested_at.toISOString()});
 const get=async()=>{const r=await fetch('http://127.0.0.1:4312/api/v1/ai-router/internal/user-lifecycle/v1/deletions/'+OP,{headers:headers(),signal:AbortSignal.timeout(5000)});const b=await r.json();return{http:r.status,deleted:b.state==='deleted'}};
 stage='before_http';assert.equal((await get()).http,200);
 try{
  stage='disable';await admin.query('ALTER ROLE ai_router_runtime NOLOGIN');changed=true;
  terminated=(await admin.query("SELECT pg_terminate_backend(pid) ok FROM pg_stat_activity WHERE usename='ai_router_runtime' AND datname='sim_ai_router' AND pid<>pg_backend_pid()")).rows.length;
  stage='unavailable_http';unavailable=await get();assert.equal(unavailable.http,503);assert.equal(unavailable.deleted,false);
 }finally{if(changed){await admin.query('ALTER ROLE ai_router_runtime LOGIN');changed=false;}}
 stage='restored_login';assert.equal((await admin.query("SELECT rolcanlogin FROM pg_roles WHERE rolname='ai_router_runtime'")).rows[0].rolcanlogin,true);
 for(let i=0;i<20;i++){recovered=await get();if(recovered.http===200&&recovered.deleted)break;await new Promise(r=>setTimeout(r,250));}
 assert.equal(recovered.http,200);assert.equal(recovered.deleted,true);
 console.log(JSON.stringify({contractVersion:'fresh-956-router-outage-proof-v1',operationId:OP,unavailableHttp:unavailable.http,recoveredHttp:recovered.http,loginRestored:true,onlyExactRuntimeSessionsTerminated:terminated,productionTouched:false,wholeAccountComplete:false}));
}catch(e){console.error(JSON.stringify({error:'FRESH_956_OUTAGE_PROBE_FAILED',stage,code:/^[A-Z0-9_]{1,60}$/.test(e.code??'')?e.code:undefined,loginRestorationStillRequired:changed,locations:[...String(e.stack).matchAll(/(check-fresh-956-router-outage.mjs:\d+:\d+)/g)].map(x=>x[1])}));process.exitCode=1;}
finally{if(changed)await admin.query('ALTER ROLE ai_router_runtime LOGIN');await admin.end();}
