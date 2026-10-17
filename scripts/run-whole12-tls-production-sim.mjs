/** Isolated fixture launcher ONLY. Fixed private KC input/output, no secret argv. */
import assert from 'node:assert/strict';
import {mkdir,open} from 'node:fs/promises';
import {createTlsProductionSimFixture} from './fixtures/whole12-tls-production-sim.mjs';
import {readPrivateCompanionInput} from './fixtures/clean-whole12-sim-companion.mjs';
assert.deepEqual(process.argv.slice(2),['--run']);
const previousUmask=process.umask(0o077);
let fixture;
try {
  const seed=await readPrivateCompanionInput('/dev/shm/cop-clean-whole/keycloak-seed.json');
  assert.equal(seed.contractVersion,'cop-clean-whole12-keycloak-private-v1');
  const actor=x=>{
    const jwt=x.cop.access_token,claims=JSON.parse(Buffer.from(jwt.split('.')[1],'base64url').toString('utf8'));
    assert.equal(claims.sub,x.subjectId);return {subjectId:x.subjectId,oidcIat:claims.iat,jwt};
  };
  fixture=await createTlsProductionSimFixture({root:'/private/tmp/sim-user-install-pg-9aff26e65b74',sourceRoot:'/fixture-clean',runtimeRoot:{'simulator-api':'/app','ai-router-api':'/runtime/router','situation-data-api':'/runtime/situation'}});
  const privateConfiguration=await fixture.seed(actor(seed.actors.a),actor(seed.actors.b),'https://cop-erasure-keycloak.invalid/realms/cop','http://127.0.0.1:8080/realms/cop/protocol/openid-connect/certs');
  const firstRead=await fixture.read();
  assert.ok(firstRead.appOwners.a.fileCount>0&&firstRead.appOwners.b.fileCount>0);
  assert.ok(firstRead.simHistory.a.requests>0&&firstRead.simHistory.b.requests>0);
  await mkdir('/dev/shm/cop-clean-whole',{recursive:true,mode:0o700});
  const out=await open('/dev/shm/cop-clean-whole/sim-private.json','wx',0o600);
  try{await out.writeFile(JSON.stringify(privateConfiguration));await out.sync();}finally{await out.close();}
  console.log(JSON.stringify({contractVersion:'whole12-tls-sim-fixture-listening-v1',actualRestrictedTls:true,actualProductionBootstrap:true,actualRootAdmission:false,wholeAccountComplete:false,publicPorts:0}));
  await new Promise(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
}catch(error){
  // Provider errors/assertions may carry private input. Never print messages,
  // SQL, arguments, JWTs, stack text or credentials into Docker logs.
  console.error(JSON.stringify({error:'WHOLE12_TLS_FIXTURE_FAILED',code:/^[A-Z0-9_]{1,64}$/.test(error?.code??'')?error.code:'UNSPECIFIED',wholeAccountComplete:false}));process.exitCode=1;
}finally{await fixture?.close();process.umask(previousUmask);}
