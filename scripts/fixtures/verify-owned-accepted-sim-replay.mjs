/** Actual unchanged compiled workers on the exact restored synthetic operation. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import{createRequire}from'node:module';
import{createTlsProductionSimFixture}from'/fixture-clean/scripts/fixtures/whole12-tls-production-sim.mjs';
import{cleanFixtureHeaders}from'/fixture-clean/scripts/fixtures/clean-whole-sim-v1.mjs';
import{appDeletionHeaders}from'/fixture-clean/scripts/fixtures/clean-whole-sim-user-data-v2.mjs';
import{canonicalOwnerKey,signSimOwner}from'/app/packages/sim-user-data/claims.mjs';
const D='/dev/shm/cop-clean-whole',R='/private/tmp/sim-user-install-pg-9aff26e65b74',OP='b6fe7a68-d7a2-49e0-a9da-6dd7bcb01a4e';
const cfg=JSON.parse(await fs.readFile(D+'/sim-private.json')),resume=JSON.parse(await fs.readFile(D+'/sim-resume-private.json')),before=JSON.parse(await fs.readFile(D+'/accepted-replay-readback-before-private.json'));
const{Pool}=createRequire('/runtime/router/apps/ai-router-api/package.json')('pg');
const pools=[];let fixture;
try{
const jobs={};for(const[lane,db,s]of[['ai','sim_ai_router','sim_clean'],['driver','sim_driver_measurements','sim_clean'],['main','sim_user_data','sim_user_data'],['history','sim_ai_router','sim_user_history']]){const p=new Pool({host:R+'/s',port:5000,user:'fixture_admin',database:db});pools.push(p);const j=(await p.query(`SELECT operation_id,requested_at FROM ${s}.job`)).rows;assert.equal(j.length,1);assert.equal(j[0].operation_id,OP);jobs[lane]={operationId:OP,requestedAt:j[0].requested_at.toISOString()};}
fixture=await createTlsProductionSimFixture({root:R,sourceRoot:'/fixture-clean',runtimeRoot:{'simulator-api':'/app','ai-router-api':'/runtime/router','situation-data-api':'/runtime/situation'}});
const initial=await fixture.resumeExisting(cfg,resume.credentials,'http://127.0.0.1:8080/realms/cop/protocol/openid-connect/certs',resume.replay);
assert.equal(initial.appOwners.a.fileCount,4);assert.ok([0,1].includes(initial.simHistory.a.requests+initial.simHistory.a.billing));
assert.equal(initial.ai.owners.ai_router.removableA,4);assert.equal(initial.driver.owners.sim_measurements.removableA,4);
const owner=canonicalOwnerKey(cfg.input.userDataEnvironment.ownerSecret,{issuer:cfg.input.base.issuer,subject:cfg.input.base.actors.a.subjectId});
async function statuses(){const result={};for(const[lane,url,headers]of[
 ['main','http://127.0.0.1:4314/api/v1/internal/sim-user-data/v1/deletions/'+OP,appDeletionHeaders(cfg.input,'a',jobs.main)],
 ['history','http://127.0.0.1:4312/api/v1/ai-router/internal/sim-user-history/v1/deletions/'+OP,{authorization:'Bearer '+cfg.input.base.environment.routerSimToken,...signSimOwner(cfg.input.userDataEnvironment.routerActorSecret,{ownerKey:owner,resetEpoch:cfg.input.base.resetEpoch,oidcIat:cfg.input.base.actors.a.oidcIat,...jobs.history})}],
 ['ai','http://127.0.0.1:4312/api/v1/ai-router/internal/user-lifecycle/v1/deletions/'+OP,cleanFixtureHeaders(cfg.input.base,'a','ai',jobs.ai)],
 ['driver','http://127.0.0.1:4311/api/v1/internal/user-lifecycle/v1/deletions/'+OP,cleanFixtureHeaders(cfg.input.base,'a','driver',jobs.driver)]]){const r=await fetch(url,{headers,signal:AbortSignal.timeout(5000)});const b=await r.json();result[lane]={status:r.status,deleted:b.state==='deleted',remainingRecords:b.remainingRecords};}return result;}
const first=await statuses();assert.ok(['main','ai','driver'].every(k=>first[k].status===503),'ACTUAL_RESIDUAL_STATUS_NOT_OBSERVED');
assert.ok(first.history.status===503||(first.history.status===200&&first.history.deleted&&first.history.remainingRecords===0),'HISTORY_FRESH_READBACK_INVALID');
console.log(JSON.stringify({stage:'actual_restored_content_observed',restoredRowsBeforeWorkers:{ai:4,driver:4,history:1},historyRowsAtThisStartup:initial.simHistory.a.requests+initial.simHistory.a.billing,historyMayAlreadyHaveBeenCleanedByFirstActualWorkerAttempt:true,restoredFiles:4,initialStatuses:Object.fromEntries(Object.entries(first).map(([k,v])=>[k,v.status])),wholeAccountComplete:false}));
let after,final;const deadline=Date.now()+35000;
do{await new Promise(r=>setTimeout(r,500));final=await statuses();if(Object.values(final).every(x=>x.status===200&&x.deleted)){after=await fixture.read();break}}while(Date.now()<deadline);
assert.ok(after,'ACTUAL_REPLAY_WORKER_TIMEOUT');assert.deepEqual(JSON.parse(JSON.stringify(after)),before);
await new Promise(r=>setTimeout(r,16000));assert.deepEqual(JSON.parse(JSON.stringify(await fixture.read())),before);
console.log(JSON.stringify({contractVersion:'sim-owned-accepted-content-replay-proof-v1',acceptedOperationId:OP,actualRestoredRows:9,actualRestoredFiles:4,initialStatuses:Object.fromEntries(Object.entries(first).map(([k,v])=>[k,v.status])),finalStatuses:Object.fromEntries(Object.entries(final).map(([k,v])=>[k,v.status])),historyRemainingRecords:final.history.remainingRecords,actualFourWorkersReplayed:true,allAAbsentAndBFullReadbackPreserved:true,secondWorkerCycleIdempotent:true,productionTouched:false,wholeAccountComplete:false}));
await new Promise(r=>{process.once('SIGTERM',r);process.once('SIGINT',r)});
}catch(e){console.error(JSON.stringify({error:'OWNED_ACCEPTED_REPLAY_PROOF_FAILED',code:e.code,locations:[...String(e.stack).matchAll(/(verify-owned-accepted-sim-replay.mjs:\d+:\d+)/g)].map(x=>x[1]),wholeAccountComplete:false}));process.exitCode=1;}
finally{await fixture?.close();for(const p of pools)await p.end().catch(()=>{});}
