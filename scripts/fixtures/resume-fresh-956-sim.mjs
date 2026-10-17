/** Resume exact existing fresh956, never seed/enroll/rotate. Public source only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createTlsProductionSimFixture} from './whole12-tls-production-sim.mjs';
assert.deepEqual(process.argv.slice(2),['--resume-existing']);
const D='/dev/shm/cop-clean-whole';let fixture;
try{
 const cfg=JSON.parse(await fs.readFile(D+'/sim-private.json')),resume=JSON.parse(await fs.readFile(D+'/sim-resume-private.json'));
 assert.equal(resume.contractVersion,'sim-whole12-fresh-prepared-resume-v1');
 assert.equal(resume.configurationSha256,createHash('sha256').update(JSON.stringify(cfg)).digest('hex'));
 assert.equal(cfg.input.base.resetEpoch,'a7f98504-9c29-4942-8fb3-7236ab819a07');
 fixture=await createTlsProductionSimFixture({root:'/private/tmp/sim-user-install-pg-956262c6abdb',sourceRoot:new URL('../../',import.meta.url).pathname.replace(/\/$/,''),runtimeRoot:{'simulator-api':'/app','ai-router-api':'/runtime/router','situation-data-api':'/runtime/situation'}});
 const x=await fixture.resumeExisting(cfg,resume.credentials,'http://127.0.0.1:8080/realms/cop/protocol/openid-connect/certs',{mode:'same-epoch-completed-content-replay-v1',acceptedOperationId:'b1c21024-0c2f-4a3d-afad-911f95d73c1b'});
 assert.equal(x.appOwners.a.fileCount,0);assert.equal(x.simHistory.a.requests+x.simHistory.a.billing,0);
 assert.equal(x.ai.owners.ai_router.removableA,0);assert.equal(x.driver.owners.sim_measurements.removableA,0);
 const seed=JSON.parse(await fs.readFile(D+'/admitted-seed-readback-private.json'));
 assert.deepEqual(x.appOwners.b,seed.appOwners.b);assert.deepEqual(x.simHistory.b,seed.simHistory.b);
 for(const[lane,owner]of[['ai','ai_router'],['driver','sim_measurements']])for(const k of ['removableB','stateB','countsB','preservedBFingerprint'])assert.deepEqual(x[lane].owners[owner][k],seed[lane].owners[owner][k]);
 console.log(JSON.stringify({contractVersion:'fresh-956-resume-existing-proof-v1',sameConfiguration:true,sameRuntimeCredentials:true,allAAbsent:true,bPreserved:true,reseeded:false,productionTouched:false}));
 await new Promise(r=>{process.once('SIGTERM',r);process.once('SIGINT',r)});
}catch(e){console.error(JSON.stringify({error:'FRESH_956_RESUME_FAILED',code:/^[A-Z0-9_]{1,60}$/.test(e.code??'')?e.code:undefined,locations:[...String(e.stack).matchAll(/((?:resume-fresh-956-sim|whole12-tls-production-sim)\.mjs:\d+:\d+)/g)].map(x=>x[1])}));process.exitCode=1;}
finally{await fixture?.close()}
