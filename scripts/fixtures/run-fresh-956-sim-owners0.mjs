/** Exact new owned fixture; no user/native seed before common enrollment. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import{createHash}from'node:crypto';
import{createTlsProductionSimFixture}from'/fixture-clean/scripts/fixtures/whole12-tls-production-sim.mjs';
import{readPrivateCompanionInput}from'/fixture-clean/scripts/fixtures/clean-whole12-sim-companion.mjs';
const D='/dev/shm/cop-clean-whole',R='/private/tmp/sim-user-install-pg-956262c6abdb';
assert.deepEqual(process.argv.slice(2),['--prepare-owners0']);process.umask(0o077);let fixture;
try{
const seed=await readPrivateCompanionInput(D+'/keycloak-seed.json');assert.equal(seed.contractVersion,'cop-clean-whole12-keycloak-private-v1');
const actor=x=>{const jwt=x.cop.access_token,c=JSON.parse(Buffer.from(jwt.split('.')[1],'base64url'));assert.equal(c.sub,x.subjectId);return{subjectId:x.subjectId,oidcIat:c.iat,jwt}};
fixture=await createTlsProductionSimFixture({root:R,sourceRoot:'/fixture-clean',runtimeRoot:{'simulator-api':'/app','ai-router-api':'/runtime/router','situation-data-api':'/runtime/situation'},completedReplayMode:'same-epoch-completed-content-replay-v1'});
const cfg=await fixture.seed(actor(seed.actors.a),actor(seed.actors.b),'https://cop-erasure-keycloak.invalid/realms/cop','http://127.0.0.1:8080/realms/cop/protocol/openid-connect/certs',{seedUserData:false});
const current=await fixture.read();
for(const n of ['a','b']){assert.equal(current.appOwners[n].state,'unused');assert.equal(current.appOwners[n].fileCount,0);assert.equal(current.simHistory[n].state,'unused');assert.equal(current.simHistory[n].requests+current.simHistory[n].billing,0)}
for(const[lane,owner]of[['ai','ai_router'],['driver','sim_measurements']])for(const n of ['A','B'])assert.equal(current[lane].owners[owner]['removable'+n],0);
await fs.mkdir(D,{recursive:true,mode:0o700});
for(const[n,v]of[['sim-private.json',cfg],['sim-resume-private.json',{contractVersion:'sim-whole12-fresh-prepared-resume-v1',completedReplayMode:'same-epoch-completed-content-replay-v1',configurationSha256:createHash('sha256').update(JSON.stringify(cfg)).digest('hex'),credentials:fixture.privateRuntimeCredentials(),expectedReadback:current}]])await fs.writeFile(D+'/'+n,JSON.stringify(v),{mode:0o600,flag:'wx'});
const statuses={};
for(const[name,port,path,token]of[['main',4314,'/api/v1/internal/sim-user-data/v1/capabilities',cfg.input.userDataEnvironment.copToken],['ai',4312,'/api/v1/ai-router/internal/user-lifecycle/v1/capabilities',cfg.input.base.environment.copServiceToken],['driver',4311,'/api/v1/internal/user-lifecycle/v1/capabilities',cfg.input.base.environment.copServiceToken],['history',4312,'/api/v1/ai-router/internal/sim-user-history/v1/capabilities',cfg.input.base.environment.routerSimToken]]){const r=await fetch('http://127.0.0.1:'+port+path,{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);await r.body?.cancel();statuses[name]=r.status;}
console.log(JSON.stringify({contractVersion:'sim-fresh-956-owners0-prepared-v1',actualCapabilities:statuses,actualRestrictedTls:cfg.tls,driverWorkerStarted:true,allFourOwnerStoresEmpty:true,userDataSeeded:false,nativeActorsSeeded:false,completedReplayMode:'same-epoch-completed-content-replay-v1',resetEpoch:cfg.input.base.resetEpoch,privateRuntimeCredentialsSaved:true,productionTouched:false,wholeAccountComplete:false}));
await new Promise(r=>{process.once('SIGTERM',r);process.once('SIGINT',r)});
}catch(e){console.error(JSON.stringify({error:'FRESH_956_SIM_PREPARATION_FAILED',code:/^[A-Z0-9_]{1,80}$/.test(e.code??'')?e.code:undefined,locations:[...String(e.stack).matchAll(/(\/(?:fixture-clean|dev\/shm)\/[^\s)]+:\d+:\d+)/g)].map(x=>x[1]).slice(0,8),wholeAccountComplete:false}));process.exitCode=1;}
finally{await fixture?.close();}
