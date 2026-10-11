// Reviewed one-off operation, pinned to the pre-rotation production images.
// Run only on docker.home.cz under the COP storage flock. No secret output.
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,renameSync,statSync,existsSync,unlinkSync,openSync,closeSync,mkdirSync} from 'node:fs';
import {randomBytes,randomUUID,createHash,createHmac} from 'node:crypto';
import {posix} from 'node:path';
const mode=process.argv[2];
const targets=[
 {name:'csm-sim-situation-data-api',root:'/srv/sim',token:'DRIVER_MEASUREMENTS_COP_TOKEN',flag:'DRIVER_MEASUREMENTS_ENABLED',image:'sha256:60d66a8083e4df55ea5eb8d8713c1846556a96162cd4fce1b70600ffecf89fc4'},
 {name:'cop-cop-api-1',root:'/srv/cop',token:'COP_DRIVER_MEASUREMENTS_SIM_TOKEN',flag:'COP_DRIVER_MEASUREMENTS_ENABLED',image:'sha256:ed17360324c431e169c489cee888f49037582792214b45e0a94d9360144d29a5'}
];
const digest=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const requireSafe=(ok,code)=>{if(!ok)throw new Error(code);};
const run=(bin,args,cwd='/srv/sim',input,environment=process.env)=>{try{return execFileSync(bin,args,{cwd,input,env:environment,encoding:'utf8',stdio:['pipe','pipe','pipe','ignore','ignore','ignore','ignore','ignore','ignore',9],maxBuffer:16*1024*1024,timeout:120000});}catch{throw new Error('SUBPROCESS_FAILED_CAPTURE_SUPPRESSED');}};
const inspect=name=>JSON.parse(run('docker',['inspect',name]))[0];
const env=s=>Object.fromEntries(s.Config.Env.map(v=>{const i=v.indexOf('=');return[v.slice(0,i),v.slice(i+1)];}));
const canonicalHost=h=>{const r=structuredClone(h);if(r.Mounts){const a=r.Mounts.map(m=>m.Target);requireSafe(a.every(t=>typeof t==='string'&&t.startsWith('/')&&t!=='/'&&posix.normalize(t)===t)&&new Set(a).size===a.length,'AMBIGUOUS_MOUNT');r.Mounts.sort((a,b)=>a.Target.localeCompare(b.Target));}return r;};
const invariant=(s,token)=>({image:s.Image,environment:digest(Object.entries(env(s)).filter(([k])=>k!==token).sort(([a],[b])=>a.localeCompare(b))),host:digest(canonicalHost(s.HostConfig)),mounts:digest(s.Mounts),networks:Object.fromEntries(Object.entries(s.NetworkSettings.Networks).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,{id:v.NetworkID,aliases:(v.Aliases??[]).filter(a=>a!==s.Id&&a!==s.Id.slice(0,12)).sort()}]))});
const others=()=>run('docker',['ps','--format','{{.Names}} {{.ID}}']).trim().split('\n').filter(Boolean).sort().filter(l=>!targets.some(t=>l.startsWith(t.name+' ')));
const patchToken=(text,key,value)=>{const matches=text.split('\n').filter(l=>l.startsWith(key+'='));requireSafe(matches.length===1,'AMBIGUOUS_ENV_KEY');return text.replace(new RegExp('^'+key+'=.*$','m'),key+'='+value);};
const stripToken=(text,key)=>text.split('\n').filter(l=>!l.startsWith(key+'=')).join('\n');
const containerScript=(name,script)=>JSON.parse(run('docker',['exec','-i','-w','/app/apps/situation-data-api',name,'node','--input-type=module'], '/srv/sim',script));
const seedScript=(fixture)=>`
 import {PostgresDriverMeasurementStore} from '/app/apps/situation-data-api/dist/driver-measurement-store.js';
 import {Pool} from 'pg'; import {createHmac} from 'node:crypto';
 const f=${JSON.stringify(fixture)}, h=process.env.DRIVER_MEASUREMENTS_HASH_SECRET;
 const pool=new Pool({connectionString:process.env.DRIVER_MEASUREMENTS_DATABASE_URL,max:1,connectionTimeoutMillis:1500,statement_timeout:5000});
 const store=new PostgresDriverMeasurementStore(process.env.DRIVER_MEASUREMENTS_DATABASE_URL,h);
 try {
 const rights=await pool.query("SELECT current_database()='sim_driver_measurements' AND current_user='driver_measurements_runtime' AND NOT has_schema_privilege(current_user,'public','CREATE') AND NOT has_database_privilege(current_user,current_database(),'CREATE') AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AS ok FROM pg_roles WHERE rolname=current_user");
 if(rights.rows[0]?.ok!==true)throw new Error('RIGHTS');
 const before=(await pool.query('SELECT count(*)::int AS n FROM driver_measurement_receipts')).rows[0].n;
 const contributor=createHmac('sha256',h).update('cop:'+f.pseudonym).digest('hex');
 const receipt={contractVersion:'sim-driver-measurements-v1',batchId:f.batchId,receivedAt:new Date().toISOString(),acceptedIntervalCount:1,deduplicatedIntervalCount:0,rejectionCounts:{},etaAccepted:false,applicationMode:'shadow_only',rawPositionsStored:false};
 const batch={batchId:f.batchId,points:[]};
 await store.commit('cop',contributor,'a'.repeat(64),batch,[{key:f.intervalKey,dataset:'synthetic-token-rotation-check',edgeId:'8',windowStart:new Date().toISOString(),speedKph:36,distanceM:50,elapsedSeconds:5}],receipt);
 const saved=await pool.query('SELECT row_to_json(r)::text AS json FROM driver_measurement_receipts r WHERE owner=$1 AND contributor_hash=$2',['cop',contributor]);
 const raw=saved.rows.map(r=>r.json).join();
 const incomingIdentityNotStored=![f.batchId,f.pseudonym,f.intervalKey].some(v=>raw.includes(v));
 if(!incomingIdentityNotStored||/\"(lat|lon|points|contributorIdDay|sampleId)\"/.test(raw))throw new Error('PRIVACY');
 console.log(JSON.stringify({databaseReady:true,restrictedRuntime:true,historicalReceiptBefore:before,syntheticReceiptCreated:true,incomingIdentityNotStored}));
 }catch{console.log(JSON.stringify({databaseReady:false}));process.exitCode=1;}finally{await store.close();await pool.end();}
`;
const verifyScript=(oldToken,fixture)=>`
 import {Pool} from 'pg'; import {createHmac} from 'node:crypto';
 const previous=${JSON.stringify(oldToken)}, f=${JSON.stringify(fixture)};
 const base='http://127.0.0.1:4020/api/v1/internal/driver-measurements/v1';
 const token=process.env.DRIVER_MEASUREMENTS_COP_TOKEN;
 const result={};
 async function call(path,method,key,body){const r=await fetch(base+path,{method,signal:AbortSignal.timeout(10000),redirect:'error',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','x-correlation-id':'synthetic-token-rotation-probe'},...(body===undefined?{}:{body:JSON.stringify(body)})});let v={};try{v=await r.json();}catch{}return{status:r.status,value:v};}
 const p=new Pool({connectionString:process.env.DRIVER_MEASUREMENTS_DATABASE_URL,max:1,connectionTimeoutMillis:1500,statement_timeout:5000});
 try {
 result.oldTokenStatus=(await call('/quality','GET',previous)).status;
 result.newTokenValidationStatus=(await call('/contributions','DELETE',token,{})).status;
 result.disabledIntakeStatus=(await call('/batches','POST',token,{})).status;
 const deletion=await call('/contributions','DELETE',token,{contractVersion:'sim-driver-measurements-v1',contributorIdDay:f.pseudonym});
 result.historicalDeleteStatus=deletion.status; result.syntheticDeletedBatchCount=deletion.value.deletedBatchCount;
 const contributor=createHmac('sha256',process.env.DRIVER_MEASUREMENTS_HASH_SECRET).update('cop:'+f.pseudonym).digest('hex');
 result.remainingSyntheticReceipts=(await p.query('SELECT count(*)::int AS n FROM driver_measurement_receipts WHERE owner=$1 AND contributor_hash=$2',['cop',contributor])).rows[0].n;
 const intervalKey=createHmac('sha256',process.env.DRIVER_MEASUREMENTS_HASH_SECRET).update('cop:interval:'+f.intervalKey).digest('hex');
 result.remainingSyntheticIntervals=(await p.query('SELECT count(*)::int AS n FROM driver_measurement_intervals WHERE owner=$1 AND measurement_key=$2',['cop',intervalKey])).rows[0].n;
 result.tombstonePresent=(await p.query('SELECT count(*)::int AS n FROM driver_measurement_revocations WHERE owner=$1 AND contributor_hash=$2 AND expires_at>now()',['cop',contributor])).rows[0].n===1;
 if(result.oldTokenStatus!==401||result.newTokenValidationStatus!==400||result.disabledIntakeStatus!==503||deletion.status!==200||deletion.value.deletedBatchCount!==1||result.remainingSyntheticReceipts!==0||result.remainingSyntheticIntervals!==0||!result.tombstonePresent)throw new Error('SMOKE');
 console.log(JSON.stringify(result));
 }catch{console.log(JSON.stringify({...result,smokeFailed:true}));process.exitCode=1;}finally{await p.end();}
`;
let lock,phase='preflight',changed=false,fixture,oldToken,proofDir,simApplied=false,copApplied=false,simEnvWritten=false,copEnvWritten=false;
const staged=[];
try{
 requireSafe(['--check','--rotate'].includes(mode),'UNSUPPORTED_MODE');
 requireSafe(run('hostname').trim()==='docker','HOST_MISMATCH');
 requireSafe(process.env.COP_STORAGE_LOCK_FD==='9','COP_STORAGE_LOCK_NOT_INHERITED');
 run('python3',['scripts/cop-storage.py','preflight'],'/srv/cop');
 requireSafe(run('findmnt',['-n','-o','UUID','--mountpoint','/srv/x5-production']).trim()==='2f93f595-b61b-4eea-9054-7afa9b275b5b','X5_MOUNT_MISMATCH');
 requireSafe(!existsSync('/srv/sim/.deploy-search-boundary.lock'),'SIM_DEPLOYMENT_ACTIVE');
 lock=openSync('/srv/sim/.driver-token-rotation.lock','wx',0o600);
 const states=targets.map(t=>inspect(t.name));
 for(let i=0;i<2;i++){
  const t=targets[i],s=states[i],e=env(s);
  requireSafe(s.Image===t.image&&s.State.Health?.Status==='healthy','RUNTIME_IMAGE_OR_HEALTH_MISMATCH');
  requireSafe(e[t.flag]==='false','INTAKE_MUST_REMAIN_DISABLED');
  requireSafe(statSync(t.root+'/.env').isFile()&&(statSync(t.root+'/.env').mode&0o777)===0o600,'ENV_MODE_MISMATCH');
  requireSafe(e[t.token]?.length>=32,'TOKEN_MISSING');
  requireSafe(e[i===0?'DRIVER_MEASUREMENTS_REVOCATION_ENABLED':'COP_DRIVER_MEASUREMENTS_CLEANUP_ENABLED']==='true','DELETION_DISABLED');
  requireSafe(e[i===0?'DRIVER_MEASUREMENTS_HASH_SECRET':'COP_DRIVER_MEASUREMENTS_HASH_SECRET']?.length>=32,'HMAC_MISSING');
 }
 requireSafe(env(states[0])[targets[0].token]===env(states[1])[targets[1].token],'INITIAL_TOKEN_MISMATCH');
 oldToken=env(states[0])[targets[0].token];
 const files=states.map(s=>s.Config.Labels['com.docker.compose.project.config_files'].split(','));
 requireSafe(JSON.stringify(files[0])===JSON.stringify(['/srv/sim/docker-compose.yml','/srv/sim/docker-compose.x5.yml','/srv/sim/docker-compose.driver-measurements.yml']),'SIM_COMPOSE_MISMATCH');
 requireSafe(JSON.stringify(files[1])===JSON.stringify(['/srv/cop/docker-compose.yml','/srv/cop/docker-compose.driver-measurements.yml','/srv/cop/docker-compose.x5.yml','/srv/cop/docker-compose.ai-router.yml']),'COP_COMPOSE_MISMATCH');
 const args=i=>['compose','--project-name',i===0?'sim':'cop',...files[i].flatMap(f=>['-f',f])];
 const configs=targets.map((t,i)=>JSON.parse(run('docker',[...args(i),'config','--format','json'],t.root)));
 for(let i=0;i<2;i++)requireSafe(configs[i].services[i===0?'situation-data-api':'cop-api'].environment[targets[i].token]===oldToken,'ENV_RUNTIME_DRIFT');
 const network=JSON.parse(run('docker',['network','inspect','cop_sim_driver_measurements_internal']))[0];
 requireSafe(network.Internal===true&&JSON.stringify(Object.values(network.Containers).map(c=>c.Name).sort())===JSON.stringify(targets.map(t=>t.name).sort()),'INTERNAL_NETWORK_MISMATCH');
 if(mode==='--check'){console.log(JSON.stringify({status:'preflight_passed',pairedTokenMatches:true,intakeEnabled:false,revocationEnabled:true,cleanupEnabled:true,internalNetwork:true,imagesUnchanged:true}));}
 else {
  const originals=targets.map(t=>readFileSync(t.root+'/.env','utf8'));
  const newToken=randomBytes(48).toString('hex');
  for(let i=0;i<2;i++){
   const serviceName=i===0?'situation-data-api':'cop-api';
   const image=configs[i].services[serviceName].image;
   requireSafe(JSON.parse(run('docker',['image','inspect',image]))[0].Id===states[i].Image,'IMAGE_TAG_CHANGED');
   const candidate=JSON.parse(run('docker',[...args(i),'config','--format','json'],targets[i].root,undefined,{...process.env,[targets[i].token]:newToken}));
   requireSafe(candidate.services[serviceName].environment[targets[i].token]===newToken,'TOKEN_OVERRIDE_NOT_SUPPORTED');
   candidate.services[serviceName].environment[targets[i].token]=oldToken;
   requireSafe(digest(candidate)===digest(configs[i]),'COMPOSE_CHANGED_BEYOND_TOKEN');
  }
  const next=targets.map((t,i)=>patchToken(originals[i],t.token,newToken));
  requireSafe(next.every((n,i)=>stripToken(n,targets[i].token)===stripToken(originals[i],targets[i].token)),'UNRELATED_ENV_CHANGE');
  const otherBefore=others();
  phase='cop_storage_snapshot';
  run('python3',['scripts/cop-storage.py','snapshot',...files[1].flatMap(f=>['--compose-file',posix.relative('/srv/cop',f)])],'/srv/cop');
  phase='cop_health_capture';
  const copHealthBaseline=run('python3',['scripts/cop-health-gate.py','capture'],'/srv/cop');
  JSON.parse(copHealthBaseline);
  fixture={pseudonym:'synthetic-token-rotation-'+randomUUID(),batchId:randomUUID(),intervalKey:randomUUID()};
  phase='historical_fixture';const db=containerScript(targets[0].name,seedScript(fixture));
  requireSafe(db.databaseReady&&db.syntheticReceiptCreated,'DATABASE_ACCEPTANCE_FAILED');
  proofDir='/srv/sim/.driver-token-rotation/'+new Date().toISOString().replaceAll(':','-');mkdirSync(proofDir,{recursive:true,mode:0o700});
  writeFileSync(proofDir+'/before.json',JSON.stringify({at:new Date().toISOString(),sim:invariant(states[0],targets[0].token),cop:invariant(states[1],targets[1].token),historicalReceiptBefore:db.historicalReceiptBefore},null,2),{mode:0o600});
  writeFileSync(proofDir+'/cop-health-before.json',copHealthBaseline,{mode:0o600});
  phase='pair_write';
  for(let i=0;i<2;i++){requireSafe(readFileSync(targets[i].root+'/.env','utf8')===originals[i],'CONCURRENT_ENV_CHANGE');const p=targets[i].root+'/.env.measurement-token-next';writeFileSync(p,next[i],{flag:'wx',mode:0o600});staged.push(p);}
  renameSync('/srv/sim/.env.measurement-token-next','/srv/sim/.env');simEnvWritten=true;changed=true;
  try{renameSync('/srv/cop/.env.measurement-token-next','/srv/cop/.env');copEnvWritten=true;}catch{writeFileSync('/srv/sim/.env.measurement-token-restore',originals[0],{flag:'wx',mode:0o600});renameSync('/srv/sim/.env.measurement-token-restore','/srv/sim/.env');simEnvWritten=false;changed=false;throw new Error('PAIR_WRITE_FAILED_NO_RUNTIME_CHANGE');}
  changed=true;
  phase='compose_acceptance';
  for(let i=0;i<2;i++){const c=JSON.parse(run('docker',[...args(i),'config','--format','json'],targets[i].root));const service=c.services[i===0?'situation-data-api':'cop-api'];requireSafe(service.environment[targets[i].token]===newToken,'NEW_TOKEN_NOT_SELECTED');service.environment[targets[i].token]=oldToken;requireSafe(digest(c)===digest(configs[i]),'COMPOSE_CHANGED_BEYOND_TOKEN');}
  phase='sim_recreate';run('docker',[...args(0),'up','-d','--no-deps','--no-build','--pull','never','situation-data-api']);
  let after;
  for(let i=0;i<60;i++){after=inspect(targets[0].name);if(after.State.Health?.Status==='healthy')break;requireSafe(after.State.Running,'SIM_STOPPED');await new Promise(r=>setTimeout(r,1000));}
  phase='runtime_acceptance';requireSafe(after.State.Health?.Status==='healthy','SIM_HEALTH_DEADLINE');
  requireSafe(digest(invariant(after,targets[0].token))===digest(invariant(states[0],targets[0].token)),'SIM_INVARIANTS_CHANGED');
  requireSafe(env(after)[targets[0].token]===newToken,'SIM_TOKEN_NOT_APPLIED');simApplied=true;requireSafe(digest(others())===digest(otherBefore),'ANOTHER_CONTAINER_CHANGED');
  phase='credential_and_historical_delete_acceptance';const smoke=containerScript(targets[0].name,verifyScript(oldToken,fixture));
  phase='cop_recreate';run('python3',['scripts/cop-storage.py','preflight'],'/srv/cop');
  run('docker',[...args(1),'up','-d','--no-deps','--no-build','--pull','never','cop-api'],'/srv/cop');
  let copAfter;
  for(let i=0;i<60;i++){copAfter=inspect(targets[1].name);if(copAfter.State.Health?.Status==='healthy')break;requireSafe(copAfter.State.Running,'COP_STOPPED');await new Promise(r=>setTimeout(r,1000));}
  phase='cop_acceptance';requireSafe(copAfter.State.Health?.Status==='healthy','COP_HEALTH_DEADLINE');
  requireSafe(digest(invariant(copAfter,targets[1].token))===digest(invariant(states[1],targets[1].token)),'COP_INVARIANTS_CHANGED');
  requireSafe(env(copAfter)[targets[1].token]===newToken,'COP_TOKEN_NOT_APPLIED');copApplied=true;
  requireSafe(digest(others())===digest(otherBefore),'ANOTHER_CONTAINER_CHANGED');
  for(let i=0;i<2;i++)requireSafe(stripToken(readFileSync(targets[i].root+'/.env','utf8'),targets[i].token)===stripToken(originals[i],targets[i].token),'UNRELATED_ENV_CHANGE');
  run('python3',['scripts/cop-health-gate.py','verify',proofDir+'/cop-health-before.json'],'/srv/cop');
  const copSmoke=JSON.parse(run('docker',['exec','-i',targets[1].name,'node','--input-type=module'],'/srv/cop',`const base=process.env.COP_DRIVER_MEASUREMENTS_SIM_URL;const token=process.env.COP_DRIVER_MEASUREMENTS_SIM_TOKEN;try{const r=await fetch(base+'/contributions',{method:'DELETE',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});await r.arrayBuffer();if(r.status!==400)throw new Error('AUTH');console.log(JSON.stringify({actualCopPathStatus:r.status,privateEndpoint:true}));}catch{process.exitCode=1;}`));
  const proof={status:'paired_token_rotation_complete',at:new Date().toISOString(),simImage:after.Image,copImage:copAfter.Image,intakeEnabled:false,revocationEnabled:true,cleanupEnabled:true,hmacPreserved:true,onlySimAndCopApiRecreated:true,pairedProductionSecretsUpdated:true,smoke,copSmoke,proofDir};
  writeFileSync(proofDir+'/after.json',JSON.stringify(proof,null,2),{mode:0o600});console.log(JSON.stringify(proof));
 }
}catch(error){console.log(JSON.stringify({status:'failed',phase,errorCode:/^[A-Z_]+$/.test(error?.message??'')?error.message:'DIAGNOSTIC_CAPTURE_SUPPRESSED',pairedNewSecretsInstalled:simEnvWritten&&copEnvWritten,configurationPartiallyWritten:simEnvWritten!==copEnvWritten,intakeEnabled:false,simTokenApplied:simApplied,copTokenApplied:copApplied,simRestartRequired:simEnvWritten&&!simApplied,copRestartRequired:copEnvWritten&&!copApplied,proofDir}));process.exitCode=1;}
finally{
 if(fixture){try{containerScript(targets[0].name,`import {PostgresDriverMeasurementStore} from '/app/apps/situation-data-api/dist/driver-measurement-store.js';import {createHmac} from 'node:crypto';const h=process.env.DRIVER_MEASUREMENTS_HASH_SECRET;const store=new PostgresDriverMeasurementStore(process.env.DRIVER_MEASUREMENTS_DATABASE_URL,h);try{await store.revoke('cop',createHmac('sha256',h).update('cop:'+${JSON.stringify(fixture.pseudonym)}).digest('hex'));console.log(JSON.stringify({syntheticCleanup:true}));}catch{process.exitCode=1;}finally{await store.close();}`);}catch{console.log(JSON.stringify({syntheticCleanup:false,requiresAttention:true}));process.exitCode=1;}}
 for(const p of staged)if(existsSync(p))unlinkSync(p);
 if(lock!==undefined){closeSync(lock);unlinkSync('/srv/sim/.driver-token-rotation.lock');}
}
