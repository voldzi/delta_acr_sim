/** Concrete PostgreSQL erasure continuity. Trusted application/admin model.
 * No signatures, native broker, auto-enrollment, network fallback or positive
 * callback. This module accepts actual pg pools, never caller-provided facts. */
import {createHash,createHmac} from 'node:crypto';
import {DriverReportFiles} from './driver-report-files.mjs';
const HEX=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const need=(v)=>{if(!v)throw new Error('SIM_DATABASE_SAFETY_UNAVAILABLE');};
const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
const equal=(a,b)=>JSON.stringify(ordered(a))===JSON.stringify(ordered(b));
const BINDING='guard_store_id,store_id,incarnation_id,configuration_fingerprint,checkpoint_id,restore_generation::text';
export function runtimeIdentityFingerprint(owner,hashSecret,actorSecret,issuer) {
 need(['sim_measurements','ai_router'].includes(owner)&&typeof hashSecret==='string'&&hashSecret.length>=24&&typeof actorSecret==='string'&&actorSecret.length>=32&&typeof issuer==='string'&&issuer.startsWith('https://'));
 return createHash('sha256').update(JSON.stringify({contractVersion:'sim-erasure-runtime-identity-v2',owner,hashSecret,actorSecret,issuer})).digest('hex');
}
export function configurationFingerprint(driver,router) {
 need(HEX.test(driver)&&HEX.test(router));return createHash('sha256').update(JSON.stringify({contractVersion:'sim-erasure-configuration-v2',driver,router})).digest('hex');
}
export function verifyRuntimeIdentity(owner,hashSecret,actorSecret,issuer,env=process.env) {
 const driver=env.SIM_ACCOUNT_ERASURE_DRIVER_IDENTITY_FINGERPRINT,router=env.SIM_ACCOUNT_ERASURE_ROUTER_IDENTITY_FINGERPRINT;
 need(configurationFingerprint(driver,router)===env.SIM_ACCOUNT_ERASURE_CONFIGURATION_FINGERPRINT&&runtimeIdentityFingerprint(owner,hashSecret,actorSecret,issuer)===(owner==='sim_measurements'?driver:router));
}
/** Production uses only the reviewed, hostname-verified HAProxy TCP route.
 * Isolated loopback fixtures do not run with NODE_ENV=production. */
export function verifyProductionDatabaseTransport(connectionString,database,env=process.env) {
 if(env.NODE_ENV!=='production')return;
 let u;try{u=new URL(connectionString);}catch{throw new Error('SIM_DATABASE_SAFETY_UNAVAILABLE');}
 need(['postgresql:','postgres:'].includes(u.protocol)&&u.hostname==='haproxy.home.cz'&&u.port==='5000'&&u.pathname==='/'+database&&
  u.searchParams.getAll('sslmode').length===1&&u.searchParams.get('sslmode')==='verify-full'&&
  u.searchParams.getAll('sslrootcert').length===1&&u.searchParams.get('sslrootcert')==='/etc/csm-sim/postgresql-ca.pem'&&
  [...u.searchParams.keys()].every(k=>['sslmode','sslrootcert'].includes(k))&&env.NODE_TLS_REJECT_UNAUTHORIZED!=='0');
}
export class DatabaseErasureGuard {
 constructor({guardPool,targetPool,owner,guardStoreId,configurationFingerprint,driverHashSecret,reportDirectory}) {
  need(['sim_measurements','ai_router'].includes(owner)&&UUID.test(guardStoreId)&&HEX.test(configurationFingerprint));
  this.guard=guardPool;this.target=targetPool;this.owner=owner;this.guardStoreId=guardStoreId;this.fingerprint=configurationFingerprint;
  this.secret=driverHashSecret;this.binding=undefined;this.ready=false;
  this.reports=owner==='sim_measurements'&&reportDirectory?new DriverReportFiles(reportDirectory):undefined;
 }
 async bindingNow(query=this.guard,target=this.target) {
  const configuration=await query.query('SELECT current_database() AS db,store_id,configuration_fingerprint FROM sim_erasure_guard_v2.store WHERE singleton');
  need(configuration.rowCount===1&&configuration.rows[0].db==='cop_account_safety_guard'&&configuration.rows[0].store_id===this.guardStoreId&&configuration.rows[0].configuration_fingerprint===this.fingerprint);
  const local=await target.query(`SELECT current_database() AS db,${BINDING} FROM public.sim_erasure_dataset_binding WHERE singleton`);
  const registered=await query.query('SELECT guard_store_id,target_store_id AS store_id,incarnation_id,configuration_fingerprint,checkpoint_id,restore_generation::text,state,replay_sequence::text FROM sim_erasure_guard_v2.owner_binding WHERE owner=$1',[this.owner]);
  need(local.rowCount===1&&registered.rowCount===1);
  const l=local.rows[0],r=registered.rows[0];
  need(l.db===(this.owner==='sim_measurements'?'sim_driver_measurements':'sim_ai_router')&&r.state==='ready'&&
   l.guard_store_id===this.guardStoreId&&l.configuration_fingerprint===this.fingerprint&&
   ['guard_store_id','store_id','incarnation_id','configuration_fingerprint','checkpoint_id','restore_generation'].every(k=>l[k]===r[k])&&
   ['guard_store_id','store_id','incarnation_id','checkpoint_id'].every(k=>UUID.test(l[k]))&&/^[1-9][0-9]*$/.test(l.restore_generation));
  const fixed={guard_store_id:l.guard_store_id,store_id:l.store_id,incarnation_id:l.incarnation_id,configuration_fingerprint:l.configuration_fingerprint,checkpoint_id:l.checkpoint_id,restore_generation:l.restore_generation};
  if(this.owner==='sim_measurements'){
   const schema=await target.query("SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.driver_measurement_eta'::regclass AND conname='driver_eta_contributor_binding_fkey' AND contype='f' AND conkey=ARRAY[1,2,4]::smallint[] AND confkey=ARRAY[1,2,3]::smallint[] AND confrelid='public.driver_measurement_receipts'::regclass AND convalidated AND NOT condeferrable AND confdeltype='c') AS ready");need(schema.rows[0]?.ready===true);
  }
  need(!this.binding||equal(fixed,this.binding));return {fixed,replaySequence:r.replay_sequence};
 }
 async init() {
  need(!this.ready);this.binding=(await this.bindingNow()).fixed;
  // Always replay all tombstones, not a cursor restored with an application DB.
  await this.replay();await this.bindingNow();
  if(this.reports){const c=await this.target.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(612031,1)');await this.bindingNow(this.guard,c);await this.reports.withLock(()=>this.reports.invalidateAll());await c.query('COMMIT');}catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}}
  this.ready=true;
 }
 async assertCurrent() {need(this.ready);await this.bindingNow();}
 validate(row) {
  need(UUID.test(row.operation_id)&&HEX.test(row.actor_hash)&&HEX.test(row.request_hash));
  const p=row.payload;
  if(this.owner==='sim_measurements')need(exact(p,['operationHash','contributorHashes','contributorCount'])&&HEX.test(p.operationHash)&&
   Number.isInteger(p.contributorCount)&&p.contributorCount>=9&&p.contributorCount<=40&&Array.isArray(p.contributorHashes)&&
   p.contributorHashes.length>=1&&p.contributorHashes.length<=p.contributorCount&&p.contributorHashes.every(x=>typeof x==='string'&&HEX.test(x))&&new Set(p.contributorHashes).size===p.contributorHashes.length);
  else need(exact(p,['targetHash'])&&HEX.test(p.targetHash));
  need(Number.isFinite(new Date(row.accepted_at).getTime()));
 }
 async append(operationId,actorHash,requestHash,payload,enabled=true) {
  await this.assertCurrent();const c=await this.guard.connect();
  try {
   await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1500ms'");
   await c.query('SELECT owner FROM sim_erasure_guard_v2.owner_binding WHERE owner=$1 FOR UPDATE',[this.owner]);await this.bindingNow(c);
   const prior=await c.query('SELECT * FROM sim_erasure_guard_v2.tombstone WHERE owner=$1 AND (operation_id=$2 OR actor_hash=$3)',[this.owner,operationId,actorHash]);
   if(prior.rowCount)need(prior.rowCount===1&&prior.rows[0].operation_id===operationId&&prior.rows[0].actor_hash===actorHash&&prior.rows[0].request_hash===requestHash&&equal(prior.rows[0].payload,JSON.parse(JSON.stringify(payload))));
   else {need(enabled);await c.query('INSERT INTO sim_erasure_guard_v2.tombstone(owner,operation_id,actor_hash,request_hash,payload) VALUES($1,$2,$3,$4,$5)',[this.owner,operationId,actorHash,requestHash,JSON.stringify(payload)]);}
   await c.query('COMMIT');
  } catch(error) {await c.query('ROLLBACK').catch(()=>{});throw error;} finally {c.release();}
  // A lost guard COMMIT never causes a target mutation or a replacement ID.
  // A retry looks up exactly the same immutable operation before projection.
  await this.replay();
 }
 async replay() {
  const g=await this.guard.connect();
  try {
   await g.query('BEGIN');await g.query("SET LOCAL lock_timeout='1500ms'");
   await g.query('SELECT owner FROM sim_erasure_guard_v2.owner_binding WHERE owner=$1 FOR UPDATE',[this.owner]);await this.bindingNow(g);
   const rows=await g.query('SELECT * FROM sim_erasure_guard_v2.tombstone WHERE owner=$1 ORDER BY sequence',[this.owner]);
   for(const row of rows.rows){this.validate(row);await this.project(row);}
   const last=rows.rows.at(-1)?.sequence??'0';
   await g.query('UPDATE sim_erasure_guard_v2.owner_binding SET replay_sequence=$2 WHERE owner=$1',[this.owner,last]);await this.bindingNow(g);
   await g.query('COMMIT');
  } catch(error) {await g.query('ROLLBACK').catch(()=>{});throw error;} finally {g.release();}
 }
 async project(row) {
  const c=await this.target.connect();const p=row.payload;
  try {
   await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='1500ms'");
   if(this.owner==='sim_measurements') {
    await c.query('SELECT pg_advisory_xact_lock(612031,1)');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`cop:account-erasure:${p.operationHash}`]);
    const prior=await c.query('SELECT actor_hash,request_hash,contributor_count FROM driver_account_erasure_operations WHERE operation_hash=$1',[p.operationHash]);
    need(!prior.rowCount||prior.rows[0].actor_hash===row.actor_hash&&prior.rows[0].request_hash===row.request_hash&&prior.rows[0].contributor_count===p.contributorCount);
    await c.query('INSERT INTO driver_account_erasure_operations(operation_hash,actor_hash,request_hash,contributor_count,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT DO NOTHING',[p.operationHash,row.actor_hash,row.request_hash,p.contributorCount,row.accepted_at]);
    for(const hash of [...p.contributorHashes].sort())await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`cop:${hash}`]);
    await c.query("INSERT INTO driver_account_erasure_revocations(owner,contributor_hash) SELECT 'cop',v FROM unnest($1::text[]) v ON CONFLICT DO NOTHING",[p.contributorHashes]);
    const deleted=await c.query("DELETE FROM driver_measurement_receipts WHERE owner='cop' AND contributor_hash=ANY($1::text[])",[p.contributorHashes]);
    const zero=await c.query("SELECT count(*)::int n FROM driver_measurement_receipts WHERE owner='cop' AND contributor_hash=ANY($1::text[])",[p.contributorHashes]);need(zero.rows[0].n===0);
    await c.query('UPDATE driver_account_erasure_operations SET deleted_batch_count=deleted_batch_count+$2,remaining_batch_count=0,database_zero_verified=true,updated_at=now() WHERE operation_hash=$1',[p.operationHash,deleted.rowCount]);
    // Same exclusive lock as the actual report writer; discard the whole
    // reproducible cache rather than retaining a mixed-account old report.
    if(this.reports)await this.reports.withLock(()=>this.reports.invalidateAll());
   } else {
    await c.query('SELECT pg_advisory_xact_lock(634020,hashtext($1))',[p.targetHash]);
    const prior=await c.query('SELECT operation_id,owner_hash,target_hash,body_digest FROM ai_router_account_erasure WHERE operation_id=$1 OR target_hash=$2',[row.operation_id,p.targetHash]);
    need(!prior.rowCount||prior.rowCount===1&&prior.rows[0].operation_id===row.operation_id&&prior.rows[0].owner_hash===row.actor_hash&&prior.rows[0].target_hash===p.targetHash&&prior.rows[0].body_digest===row.request_hash);
    await c.query('INSERT INTO ai_router_account_erasure(operation_id,owner_hash,target_hash,body_digest,requested_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[row.operation_id,row.actor_hash,p.targetHash,row.request_hash,row.accepted_at]);
    await c.query('DELETE FROM ai_router_user_key WHERE user_hash=$1',[p.targetHash]);
   }
   await c.query('COMMIT');
  } catch(error) {await c.query('ROLLBACK').catch(()=>{});throw error;} finally {c.release();}
 }
 async recordDriver(input,enabled) {
  need(this.owner==='sim_measurements'&&typeof this.secret==='string'&&this.secret.length>=32);
  const operationHash=createHmac('sha256',this.secret).update('cop:account-erasure-operation:'+input.operationId).digest('hex');
  const payload={operationHash,contributorHashes:[...new Set(input.contributors.map(x=>x.contributorHash))].sort(),contributorCount:input.contributors.length};
  this.validate({operation_id:input.operationId,actor_hash:input.actorHash,request_hash:input.requestHash,payload,accepted_at:new Date()});
  await this.append(input.operationId,input.actorHash,input.requestHash,payload,enabled);
 }
 async recordRouter(identity,operationId) {
  need(this.owner==='ai_router');const digest=createHash('sha256').update(JSON.stringify({contractVersion:'sim-account-erasure-v1',operationId})).digest('hex');
  const payload={targetHash:identity.targetHash};this.validate({operation_id:operationId,actor_hash:identity.ownerHash,request_hash:digest,payload,accepted_at:new Date()});
  await this.append(operationId,identity.ownerHash,digest,payload);
 }
 async driverProof() {
  await this.assertCurrent();need(this.owner==='sim_measurements');
  const r=await this.target.query('SELECT *,proof_valid_until>now() AS valid FROM driver_account_erasure_state WHERE singleton');need(r.rowCount===1);
  const p=r.rows[0],checkpoint=this.binding.checkpoint_id;
  need(p.replay_checkpoint_hash===createHmac('sha256',this.secret).update('cop:account-erasure-checkpoint:'+checkpoint).digest('hex'));
  const filesProtected=!!this.reports&&!!this.reports.assertProtected();
  return {checkpoint,restoreCheckpointCurrent:p.replay_ready===true&&p.valid===true,identityReviewed:true,retentionReviewed:p.retention_reviewed===true,publicationFenceVerified:p.publication_fence_verified===true&&p.report_protection==='shared_generation_fence'&&filesProtected,reportProtection:filesProtected?p.report_protection:'unverified'};
 }
 async verifyRouterCheckpoint(checkpoint) {
  try {await this.assertCurrent();need(this.owner==='ai_router');const r=await this.target.query('SELECT checkpoint_id,checkpoint_generation::text,identity_reviewed,replay_ready,cost_policy FROM ai_router_erasure_checkpoint WHERE id=1');need(r.rowCount===1);
   const p=r.rows[0];return p.checkpoint_id===this.binding.checkpoint_id&&p.checkpoint_generation===this.binding.restore_generation&&p.identity_reviewed===true&&p.replay_ready===true&&p.cost_policy==='aggregate-costs-current-month-v1'&&checkpoint.checkpoint_id===p.checkpoint_id&&checkpoint.checkpoint_generation===p.checkpoint_generation;
  } catch{return false;}
 }
 async publicationBarrier(input) {
  await this.assertCurrent();need(this.owner==='sim_measurements'&&this.reports&&input);const c=await this.target.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(612031,1)');await this.bindingNow(this.guard,c);
   const op=await this.guard.query('SELECT * FROM sim_erasure_guard_v2.tombstone WHERE owner=$1 AND operation_id=$2',[this.owner,input.operationId]);
   need(op.rowCount===1&&op.rows[0].actor_hash===input.actorHash&&op.rows[0].request_hash===input.requestHash);this.validate(op.rows[0]);
   const local=await c.query('SELECT database_zero_verified,remaining_batch_count FROM driver_account_erasure_operations WHERE operation_hash=$1 AND actor_hash=$2 AND request_hash=$3',[op.rows[0].payload.operationHash,input.actorHash,input.requestHash]);need(local.rowCount===1&&local.rows[0].database_zero_verified===true&&local.rows[0].remaining_batch_count===0);
   await this.reports.withLock(()=>this.reports.invalidateAll());await c.query('COMMIT');}
  catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}
 }
 async writeFileReport(kind,work) {
  need(this.reports);return this.withLease({kind},lease=>this.reports.withLock(async()=>{const value=await work(lease);await lease.assertCurrent();this.reports.write(kind,value);}));
 }
 async withReportMaintenance(work) {
  await this.assertCurrent();need(this.owner==='sim_measurements');const c=await this.target.connect();
  try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(612031,1)');await this.bindingNow(this.guard,c);
   const run=async()=>{const result=await work();await this.bindingNow(this.guard,c);this.reports?.invalidateAll();return result;};
   const result=this.reports?await this.reports.withLock(run):await run();await c.query('COMMIT');return result;
  }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}
 }
 async withLease(request,work) {
  need(this.owner==='sim_measurements'&&['aggregates','quality'].includes(request.kind));await this.assertCurrent();const c=await this.target.connect();
  let lost=false;const failed=()=>{lost=true;};c.on('error',failed);
  try {await c.query('SELECT pg_advisory_lock_shared(612031,1)');await this.bindingNow(this.guard,c);const result=await work({assertCurrent:async()=>{need(this.ready&&!lost);await this.bindingNow(this.guard,c);}});need(!lost);return result;}
  finally {try{await c.query('SELECT pg_advisory_unlock_shared(612031,1)');c.release();}catch{c.release(true);}finally{c.removeListener('error',failed);}}
 }
}
