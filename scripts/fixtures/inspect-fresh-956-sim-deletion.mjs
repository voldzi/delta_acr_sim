/** Exact fresh fixture, read-only acceptance probe. No restart, seed or restore. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {cleanFixtureHeaders} from '/fixture-clean/scripts/fixtures/clean-whole-sim-v1.mjs';
import {appDeletionHeaders} from '/fixture-clean/scripts/fixtures/clean-whole-sim-user-data-v2.mjs';
import {canonicalOwnerKey,signSimOwner} from '/app/packages/sim-user-data/claims.mjs';
assert.deepEqual(process.argv.slice(2),['--read-only']);
const D='/dev/shm/cop-clean-whole',OP='b1c21024-0c2f-4a3d-afad-911f95d73c1b';
const cfg=JSON.parse(await fs.readFile(D+'/sim-private.json'));
const before=JSON.parse(await fs.readFile(D+'/admitted-seed-readback-private.json'));
const b=cfg.input.base;assert.equal(b.resetEpoch,'a7f98504-9c29-4942-8fb3-7236ab819a07');
const {Pool}=createRequire('/runtime/router/apps/ai-router-api/package.json')('pg');
const jobs={};
for(const[lane,db,s]of[['ai','sim_ai_router','sim_clean'],['driver','sim_driver_measurements','sim_clean'],['main','sim_user_data','sim_user_data'],['history','sim_ai_router','sim_user_history']]){
 const p=new Pool({host:'/private/tmp/sim-user-install-pg-956262c6abdb/s',port:5000,user:'fixture_admin',database:db});
 try{const r=await p.query(`SELECT operation_id,requested_at FROM ${s}.job`);assert.equal(r.rows.length,1);assert.equal(r.rows[0].operation_id,OP);jobs[lane]={operationId:OP,requestedAt:r.rows[0].requested_at.toISOString()};}finally{await p.end()}
}
const owner=canonicalOwnerKey(cfg.input.userDataEnvironment.ownerSecret,{issuer:b.issuer,subject:b.actors.a.subjectId});
const statuses={};
for(const[lane,url,headers]of[
 ['main','http://127.0.0.1:4314/api/v1/internal/sim-user-data/v1/deletions/'+OP,appDeletionHeaders(cfg.input,'a',jobs.main)],
 ['history','http://127.0.0.1:4312/api/v1/ai-router/internal/sim-user-history/v1/deletions/'+OP,{authorization:'Bearer '+b.environment.routerSimToken,...signSimOwner(cfg.input.userDataEnvironment.routerActorSecret,{ownerKey:owner,resetEpoch:b.resetEpoch,oidcIat:b.actors.a.oidcIat,...jobs.history})}],
 ['ai','http://127.0.0.1:4312/api/v1/ai-router/internal/user-lifecycle/v1/deletions/'+OP,cleanFixtureHeaders(b,'a','ai',jobs.ai)],
 ['driver','http://127.0.0.1:4311/api/v1/internal/user-lifecycle/v1/deletions/'+OP,cleanFixtureHeaders(b,'a','driver',jobs.driver)]
]){const r=await fetch(url,{headers,signal:AbortSignal.timeout(5000)});const x=await r.json();statuses[lane]={http:r.status,deleted:x.state==='deleted',remainingRecords:x.remainingRecords};}
const r=await fetch('http://127.0.0.1:4324/readback',{headers:{authorization:'Bearer '+b.environment.copServiceToken},signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);const x=await r.json();
assert.deepEqual(x.appOwners.b,before.appOwners.b);assert.deepEqual(x.simHistory.b,before.simHistory.b);
for(const[lane,owner]of[['ai','ai_router'],['driver','sim_measurements']]){const a=x[lane].owners[owner],z=before[lane].owners[owner];for(const k of ['removableB','stateB','countsB','preservedBFingerprint'])assert.deepEqual(a[k],z[k]);}
const counts={main:x.appOwners.a.fileCount,history:x.simHistory.a.requests+x.simHistory.a.billing,ai:x.ai.owners.ai_router.removableA,driver:x.driver.owners.sim_measurements.removableA};
console.log(JSON.stringify({contractVersion:'fresh-956-readonly-deletion-proof-v1',operationId:OP,statuses,remainingA:counts,allFourDeleted:Object.values(statuses).every(s=>s.http===200&&s.deleted)&&Object.values(counts).every(n=>n===0),bPreserved:true,restorePerformed:false,financialAndGuardEqualityNotCheckedByThisProbe:true,productionTouched:false,wholeAccountComplete:false}));
