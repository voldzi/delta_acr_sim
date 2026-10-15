/** Actual fixed Root owner authority. SOURCE ONLY, not installation/enrollment.
 * Registry session advisory locks are real; no TTL, error or callback releases
 * a HOLD. Restart eligibility comes from the actual observer's new app cohort.
 * No app-selected profile/path/source proof, policy adoption or positive DI.
 */
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {lstatSync,readFileSync,statfsSync} from 'node:fs';
import {canonical,canonicalJson,exact,hex,uuid,sha256,readRootFile,requireRootCodeTree,requireRootDirectory,verifyRootRecord} from './root-records.mjs';
import {issueRootRecord,storeRootRecord} from './root-record-issuer.mjs';
import {verifyRootJws} from './root-jws.mjs';
import {nativeModule} from './root-native.mjs';
import {connectionProfile,RootDriverAuthority} from './root-driver-runtime.mjs';
import {parseDriverReadRequest,validateDriverReadFacts,matchDriverReadPolicy} from './read-admission-facts.mjs';
import {parseAiCheckpointRequest,validateAiCheckpointFacts,matchAiCheckpointPolicy} from './checkpoint-facts.mjs';
import {verifyOwnerPolicyLineage} from './root-owner-policy-lineage.mjs';
import {BASE,BINDING,LIVE,READ_BINDING,COST,DRIVER_DECISIONS,AI_DECISIONS,SPEC,need,copy,freeze,ref,stamp,peerValid,
  equalBinding,domainPolicy,observation,transitionBody,readFactsShape} from './root-owner-authority-protocol.mjs';
export {assertCopJournalActor,assertCopRevocationIntent,assertCopDriverErasureManifest} from './root-cop-actor.mjs';

const ROOT='/opt/cop-account-safety',STATE='/var/lib/cop-account-safety',PRIVATE='/run/cop-account-safety/private';
const KEYRING='/etc/cop-account-safety/public/verification-keys.json';
const contexts=new WeakMap(),heldSessions=new Set(); let globalHold=false;
let ownProcessFacts,ownNative;
const PURPOSES=['read','checkpoint-read','mutation','publication','retention','checkpoint-publish'];
// Digest the complete ORIGINAL rows inside PG/UTC, before bigint JSON parsing.
// Data used for comparisons casts every bigint to canonical decimal text.
const SQL=`SELECT row_to_json(i) AS identity,
 (to_jsonb(p)||jsonb_build_object('policy_generation',p.policy_generation::text,'predecessor_generation',p.predecessor_generation::text)) AS policy,
 (to_jsonb(d)||jsonb_build_object('target_restore_generation',d.target_restore_generation::text)) AS dataset,
 (to_jsonb(b)||jsonb_build_object('policy_generation',b.policy_generation::text)) AS runtime,
 (to_jsonb(a)||jsonb_build_object('frontier_sequence',a.frontier_sequence::text)) AS proof,
 CASE WHEN c.acceptance_id IS NULL THEN NULL ELSE to_jsonb(c)||jsonb_build_object('generation',c.generation::text,'policy_generation',c.policy_generation::text,
  'accepted_frontier_sequence',c.accepted_frontier_sequence::text,'fence_sequence',c.fence_sequence::text,'cleanup_sequence',c.cleanup_sequence::text) END AS acceptance,
 CASE WHEN r.receipt_id IS NULL THEN NULL ELSE to_jsonb(r)||jsonb_build_object('expected_checkpoint_generation',r.expected_checkpoint_generation::text,
  'expected_fence_sequence',r.expected_fence_sequence::text,'expected_cleanup_sequence',r.expected_cleanup_sequence::text,
  'fence_sequence',r.fence_sequence::text,'cleanup_sequence',r.cleanup_sequence::text,'attempt',r.attempt::text) END AS receipt,
 row_to_json(o) AS replay,(to_jsonb(h)||jsonb_build_object('frontier_sequence',h.frontier_sequence::text)) AS receipt_proof,
 (to_jsonb(pc)||jsonb_build_object('generation',pc.generation::text,'policy_generation',pc.policy_generation::text,
  'accepted_frontier_sequence',pc.accepted_frontier_sequence::text,'fence_sequence',pc.fence_sequence::text,'cleanup_sequence',pc.cleanup_sequence::text)) AS previous_acceptance,
 (to_jsonb(pr)||jsonb_build_object('expected_checkpoint_generation',pr.expected_checkpoint_generation::text,
  'expected_fence_sequence',pr.expected_fence_sequence::text,'expected_cleanup_sequence',pr.expected_cleanup_sequence::text,
  'fence_sequence',pr.fence_sequence::text,'cleanup_sequence',pr.cleanup_sequence::text,'attempt',pr.attempt::text)) AS previous_receipt,
 row_to_json(po) AS previous_replay,
 encode(sha256(convert_to(to_jsonb(c)::text,'UTF8')),'hex') AS acceptance_digest,
 encode(sha256(convert_to(to_jsonb(r)::text,'UTF8')),'hex') AS receipt_digest,
 encode(sha256(convert_to(to_jsonb(o)::text,'UTF8')),'hex') AS replay_digest,
 encode(sha256(convert_to(to_jsonb(pc)::text,'UTF8')),'hex') AS previous_acceptance_digest,
 encode(sha256(convert_to(to_jsonb(pr)::text,'UTF8')),'hex') AS previous_receipt_digest,
 encode(sha256(convert_to(to_jsonb(po)::text,'UTF8')),'hex') AS previous_replay_digest,
 CASE WHEN r.cleanup_sequence=0 THEN i.initial_prefix_digest ELSE
  (SELECT entry_digest FROM cop_guard.fence_journal WHERE sequence=r.cleanup_sequence) END AS cleanup_prefix,
 coalesce((SELECT sequence::text FROM cop_guard.fence_journal ORDER BY sequence DESC LIMIT 1),'0') AS frontier_sequence,
 coalesce((SELECT entry_digest FROM cop_guard.fence_journal ORDER BY sequence DESC LIMIT 1),i.initial_prefix_digest) AS frontier_digest,
 (SELECT system_identifier::text FROM pg_control_system()) AS cluster_id,
 (SELECT timeline_id FROM pg_control_checkpoint()) AS timeline_id,
 to_char(a.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS observed,
 to_char(a.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS issued,
 to_char(a.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires,
 to_char(h.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS receipt_proof_observed,
 to_char(h.issued_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS receipt_proof_issued,
 to_char(h.valid_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS receipt_proof_expires,
 (extract(microseconds FROM h.observed_at)::bigint%1000=0 AND extract(microseconds FROM h.issued_at)::bigint%1000=0
  AND extract(microseconds FROM h.valid_until)::bigint%1000=0) AS receipt_proof_exact_milliseconds,
 (extract(microseconds FROM a.observed_at)::bigint%1000=0 AND extract(microseconds FROM a.issued_at)::bigint%1000=0
  AND extract(microseconds FROM a.valid_until)::bigint%1000=0) AS exact_milliseconds,
 (a.observed_at<=a.issued_at AND a.issued_at<=clock_timestamp() AND a.valid_until>clock_timestamp()
  AND a.valid_until-a.observed_at<=interval '30 seconds') AS proof_current
 FROM cop_guard.guard_identity i JOIN cop_guard.policies p ON p.guard_store_id=i.guard_store_id
  AND p.policy_generation=(SELECT max(policy_generation) FROM cop_guard.policies)
 JOIN cop_guard.dataset_bindings d ON d.dataset_binding_id=$1::uuid AND d.guard_store_id=i.guard_store_id
 JOIN cop_guard.runtime_bindings b ON b.binding_id=$2::uuid AND b.dataset_binding_id=d.dataset_binding_id
 JOIN LATERAL (SELECT * FROM cop_guard.accepted_runtime_proofs a WHERE a.binding_id=b.binding_id
  ORDER BY a.accepted_at DESC,a.issued_at DESC,a.proof_id DESC LIMIT 1) a ON true
 LEFT JOIN LATERAL (SELECT * FROM cop_guard.checkpoint_acceptances c WHERE c.dataset_binding_id=d.dataset_binding_id
  ORDER BY c.generation DESC LIMIT 1) c ON true
 LEFT JOIN cop_guard.owner_receipts r ON r.receipt_id=c.receipt_id
 LEFT JOIN cop_guard.replay_operations o ON o.operation_id=r.replay_operation_id
 LEFT JOIN cop_guard.accepted_runtime_proofs h ON h.proof_id=r.source_proof_id
 LEFT JOIN cop_guard.checkpoint_acceptances pc ON pc.acceptance_id=c.previous_acceptance_id
 LEFT JOIN cop_guard.owner_receipts pr ON pr.receipt_id=pc.receipt_id
 LEFT JOIN cop_guard.replay_operations po ON po.operation_id=pr.replay_operation_id
 WHERE i.singleton`;
function root() {
  need(process.getuid?.()===0&&process.geteuid?.()===0,'ROOT_EXECUTION_REQUIRED');requireRootCodeTree(ROOT);
  // Runtime custody, not merely installer intent: per-inspect records must
  // never silently land on a persistent filesystem when the mount is absent.
  const mounts=readFileSync('/proc/self/mountinfo','utf8').trim().split('\n').map(line=>line.split(' - '));
  const privateMounts=mounts.filter(([head])=>head.split(' ')[4]===PRIVATE);
  need(privateMounts.length===1&&privateMounts[0][1]?.split(' ')[0]==='tmpfs','GUARD_PRIVATE_TMPFS_REQUIRED');
  for(const path of [PRIVATE,...['owner-authority','runtime-observations','read-evidence','read-permits','ai-read-permits'].map(name=>PRIVATE+'/'+name)]) {
    requireRootDirectory(path,{secret:true});need((lstatSync(path).mode&0o777)===0o700&&statfsSync(path).type===0x01021994,'GUARD_PRIVATE_TMPFS_CUSTODY');
  }
}
function assertCurrentBroker(observed) {
  // globalHold is process-local. A new Root process must never reuse the old
  // broker's still-live signed snapshot to forget an unresolved held cohort.
  need(process.getuid?.()===0&&process.geteuid?.()===0,'ROOT_EXECUTION_REQUIRED');
  const identity=(ownNative??=nativeModule()).selfIdentity();
  need(exact(identity,['device','inode']),'GUARD_OWNER_SELF_IDENTITY');
  const peer={...identity,uid:process.getuid(),gid:process.getgid()};need(peerValid(peer),'GUARD_OWNER_SELF_IDENTITY');
  if(!ownProcessFacts) {
    const raw=readFileSync('/proc/self/stat','utf8'),closing=raw.lastIndexOf(')'),fields=raw.slice(closing+2).trim().split(/\s+/);
    need(closing>0&&raw.startsWith(String(process.pid)+' (')&&/^[0-9]{1,20}$/.test(fields[19])&&BigInt(fields[19])>0n,'GUARD_OWNER_SELF_START');
    const machineBootId=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();need(uuid(machineBootId),'GUARD_OWNER_SELF_BOOT');
    ownProcessFacts=freeze({startTicks:fields[19],executableDigest:sha256(readFileSync('/proc/self/exe')),machineBootId});
  }
  need(canonical(observed.broker.peer)===canonical(peer)&&observed.broker.startTicks===ownProcessFacts.startTicks&&
    observed.broker.executableDigest===ownProcessFacts.executableDigest&&observed.machineBootId===ownProcessFacts.machineBootId,'GUARD_OWNER_BROKER_RESTARTED');
}
function hold(entry) {entry.hold=true;globalHold=true;heldSessions.add(entry);}
function entryFor(ctx) {root();const entry=contexts.get(ctx);need(entry&&entry.ctx===ctx&&!entry.closed,'GUARD_OWNER_CONTEXT');return entry;}
export function holdOwnerLease(ctx) {
  // An emergency HOLD must remain possible after custody/authority failure.
  // It grants no authority and must not touch a filesystem or a SQL session.
  need(process.getuid?.()===0&&process.geteuid?.()===0,'ROOT_EXECUTION_REQUIRED');
  const entry=contexts.get(ctx);need(entry&&entry.ctx===ctx&&!entry.closed,'GUARD_OWNER_CONTEXT');hold(entry);
}
function newClient(profile,database,user,entry) {
  const {Client}=createRequire(ROOT+'/package.json')('pg');
  const client=new Client({...connectionProfile(profile,database,user),connectionTimeoutMillis:5000,query_timeout:5000,
    statement_timeout:3000,application_name:'cop-root-owner-authority-v1'});
  const state={client,ended:false,expectedEnd:false};
  client.on('error',()=>{if(entry.locked||entry.acquiring)hold(entry);});
  client.on('end',()=>{state.ended=true;if((entry.locked||entry.acquiring)&&!state.expectedEnd)hold(entry);});
  return state;
}
async function endKnown(state,entry) {
  state.expectedEnd=true;
  let timer;
  try {const ending=state.client.end();void ending.catch(()=>undefined);
    await Promise.race([ending,new Promise((_,reject)=>{timer=setTimeout(()=>{hold(entry);reject(new Error('GUARD_OWNER_SESSION_END_UNKNOWN'));},15000);})]);need(state.ended,'GUARD_OWNER_SESSION_END_UNKNOWN');}
  catch {hold(entry);throw new Error('GUARD_OWNER_SESSION_END_UNKNOWN');}
  finally {clearTimeout(timer);}
}
async function target(entry,work) {
  const spec=SPEC[entry.owner],state=newClient(spec.profile,spec.database,spec.user,entry);entry.targets.add(state);
  const watchdog=setTimeout(()=>{hold(entry);state.client.connection?.stream?.destroy();},15000);
  let result,error;
  const query=async(text,values)=>{try{return await state.client.query(text,values);}catch(failure){hold(entry);throw failure;}};
  try {try{await state.client.connect();}catch(failure){hold(entry);throw failure;}result=await work(query);}
  catch(failure) {error=failure;}
  finally {
    // Await real closure even on an error. Never erase an uncertain target from
    // the retained entry or release the independent registry session barrier.
    try {await endKnown(state,entry);entry.targets.delete(state);}catch(failure) {error=failure;}
    clearTimeout(watchdog);
  }
  if(error)throw error;
  need(!entry.hold,'GUARD_OWNER_HOLD');return result;
}
async function metadata(entry,text,values) {
  try{return await entry.client.client.query(text,values);}catch(error){hold(entry);throw error;}
}
function keyring() {const bytes=readRootFile(KEYRING);return {bytes,keys:canonicalJson(bytes)};}
function signed(path,keys,kind,expectedRef,historical=false) {
  const record=verifyRootRecord(readRootFile(path,{secret:true}),keys,kind,{historical});
  need(!expectedRef||ref(expectedRef)&&expectedRef.recordId===record.payload.recordId&&expectedRef.digest===record.digest,'GUARD_OWNER_RECORD_REFERENCE');return record;
}
function currentHost(owner,keys) {
  const record=signed(PRIVATE+'/runtime-observations/'+owner+'.json',keys,'host-runtime-observation'),p=record.payload;
  need(exact(p,[...BASE,'observation'])&&Date.parse(p.expiresAt)-Date.parse(p.issuedAt)<=5000,'GUARD_OWNER_HOST_OBSERVATION');
  const observed=observation(p.observation,owner),time=Date.parse(observed.observedAtUTC),now=Date.now();
  need(time<=Date.parse(p.issuedAt)&&time<=now&&now-time<=5000,'GUARD_OWNER_HOST_OBSERVATION');assertCurrentBroker(observed);
  return {record,observed};
}
function registration(owner,peer,keys) {
  const spec=SPEC[owner],r=signed(STATE+'/'+spec.directory+'/'+peer.device+'-'+peer.inode+'.json',keys,spec.registration),p=r.payload;
  need(exact(p,[...BASE,'peer','runtimeBindingId','datasetBindingId','guardStoreId','continuityEpoch','imageId','sourceRevision','machineBootId'])&&
    peerValid(p.peer)&&canonical(p.peer)===canonical(peer)&&[p.runtimeBindingId,p.datasetBindingId,p.guardStoreId,p.continuityEpoch,p.machineBootId].every(uuid)&&
    /^sha256:[0-9a-f]{64}$/.test(p.imageId)&&/^[0-9a-f]{40}$/.test(p.sourceRevision),'GUARD_OWNER_REGISTRATION');return r;
}
function sqlBinding(row,owner,reg) {
  const {identity:i,policy:p,dataset:d,runtime:b,proof:a}=row;
  need(i?.application_id==='cop'&&i.guard_contract_version==='cop-account-safety-runtime-v1'&&i.stream_scope_id==='cop-global-fences-v1'&&
    p?.policy_id==='cop-jizda-only-sim-preserved-v1'&&p.guard_store_id===i.guard_store_id&&p.continuity_epoch===d?.continuity_epoch&&
    d.guard_store_id===i.guard_store_id&&d.owner_id===owner&&d.projection_contract_id===SPEC[owner].projection&&d.dataset_binding_id===reg.datasetBindingId&&
    b?.binding_id===reg.runtimeBindingId&&b.dataset_binding_id===d.dataset_binding_id&&b.owner_id===owner&&b.policy_generation===p.policy_generation&&
    b.image_id===reg.imageId&&b.source_revision===reg.sourceRevision&&hex(b.runtime_instance_id)&&uuid(b.runtime_profile_id)&&
    a?.binding_id===b.binding_id&&uuid(a.proof_id)&&uuid(a.operation_id)&&['enrollment','deployment','restore','rollback','refresh'].includes(a.operation_kind)&&
    hex(a.proof_jws_digest)&&a.accepted_jws_ref===a.proof_id+':'+a.proof_jws_digest&&typeof a.trust_profile_id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(a.trust_profile_id)&&
    row.proof_current===true&&row.exact_milliseconds===true&&stamp(row.observed)&&stamp(row.issued)&&stamp(row.expires),'GUARD_OWNER_REGISTRY');
  const binding={guardStoreId:i.guard_store_id,continuityEpoch:p.continuity_epoch,protectedConfigId:p.protected_config_id,datasetBindingId:d.dataset_binding_id,
    runtimeBindingId:b.binding_id,policyGeneration:Number(p.policy_generation),policyDigest:p.policy_digest,storeIncarnation:d.target_incarnation_id};
  need(BINDING.filter(k=>!['policyGeneration','policyDigest'].includes(k)).every(k=>uuid(binding[k]))&&hex(binding.policyDigest)&&
    Number.isSafeInteger(binding.policyGeneration)&&binding.policyGeneration>0&&String(binding.policyGeneration)===String(p.policy_generation)&&
    reg.guardStoreId===binding.guardStoreId&&reg.continuityEpoch===binding.continuityEpoch,'GUARD_OWNER_SQL_BINDING');return binding;
}
function policyEvidence(policy,binding,owner,keys) {
  const cases=[['identityEvidenceRef','owner-identity','cop-jizda-owned-sim-preserved'],['retentionEvidenceRef','owner-retention','bounded-owner-retention'],
    ['schemaEvidenceRef','owner-schema','exact-schema-reviewed','schemaFingerprint'],['privilegeEvidenceRef','owner-privileges','least-privilege-reviewed','privilegeFingerprint'],
    owner==='sim_driver_measurements'?['reportPolicyRef','driver-report-policy','verified-report-inventory']:['costEvidenceRef','ai-cost-policy','financial-caps-preserved']];
  for(const [field,kind,decision,pin] of cases) {
    const r=signed(STATE+'/evidence/'+policy[field].recordId+'.json',keys,kind,policy[field],true),p=r.payload;
    need(exact(p,[...BASE,...BINDING,'owner','scope','decision',...(pin?['fingerprint']:[])])&&equalBinding(p,binding)&&p.owner===owner&&p.scope===policy.scope&&
      p.decision===decision&&(!pin||p.fingerprint===policy[pin]),'GUARD_OWNER_POLICY_EVIDENCE');
  }
  if(policy.transition) {
    const t=policy.transition,r=signed(STATE+'/owner-transitions/'+t.operationId+'.json',keys,'owner-checkpoint-transition',t.intentRef,true),p=r.payload;
    const transition=Object.fromEntries(Object.entries(t).filter(([k])=>k!=='intentRef'));
    need(exact(p,[...BASE,...BINDING,'owner','scope','transition'])&&equalBinding(p,binding)&&p.owner===owner&&p.scope===policy.scope&&
      canonical(p.transition)===canonical(transition),'GUARD_OWNER_TRANSITION_REFERENCE');
  }
}
function checkpointPolicyLineage(entry,row,source,prior,binding,keys) {
  if(canonical(prior.ownerPolicyRef)===canonical(source.ownerPolicyRef))return null;
  // A different policy is NEVER admitted by its shape alone. The complete
  // archived A -> signed original transition/intent/dispatch -> current B is
  // necessary in addition to every existing P0/P1, registry and cohort check.
  const lineage=verifyOwnerPolicyLineage({owner:entry.owner,binding,priorRef:prior.ownerPolicyRef,currentRef:source.ownerPolicyRef});
  need(canonical(canonicalJson(readRootFile(KEYRING)))===canonical(keys),'GUARD_OWNER_KEYRING_CHANGED');
  const c=row.acceptance,r=row.receipt,pc=row.previous_acceptance,pr=row.previous_receipt,po=row.previous_replay;
  need(ref(prior.checkpointAcceptanceRef)&&pc&&pr&&po&&
    prior.checkpointAcceptanceRef.recordId===c.previous_acceptance_id&&c.previous_acceptance_id===pc.acceptance_id&&
    r.expected_checkpoint_id===pc.acceptance_id&&/^[1-9][0-9]*$/.test(pc.generation)&&
    pc.generation===r.expected_checkpoint_generation&&BigInt(c.generation)===BigInt(pc.generation)+1n&&
    pc.dataset_binding_id===binding.datasetBindingId&&pc.policy_generation===String(binding.policyGeneration)&&pc.policy_digest===binding.policyDigest&&
    pc.protected_config_id===binding.protectedConfigId&&pc.continuity_epoch===binding.continuityEpoch&&pc.admission_policy_id===c.admission_policy_id&&
    pc.root_evidence_ref===pc.acceptance_id&&pc.receipt_id===pr.receipt_id&&pr.owner_id===entry.owner&&pr.binding_id===binding.runtimeBindingId&&
    pr.production_authorization===false&&pr.replay_operation_id===po.operation_id&&pr.source_proof_id===po.source_proof_id&&po.binding_id===binding.runtimeBindingId&&
    [row.previous_acceptance_digest,row.previous_receipt_digest,row.previous_replay_digest].every(hex),'GUARD_OWNER_POLICY_LINEAGE_ACCEPTANCE');
  const original=signed(STATE+'/checkpoint-acceptances/'+pc.acceptance_id+'.json',keys,'checkpoint-acceptance',prior.checkpointAcceptanceRef,true).payload;
  need(exact(original,[...BASE,'acceptanceId','datasetBindingId','receiptId','replayOperationId','sourceProofId','acceptanceDigest','receiptDigest','replayDigest'])&&
    original.recordId===pc.acceptance_id&&original.acceptanceId===pc.acceptance_id&&original.datasetBindingId===binding.datasetBindingId&&original.receiptId===pr.receipt_id&&
    original.replayOperationId===po.operation_id&&original.sourceProofId===pr.source_proof_id&&original.acceptanceDigest===row.previous_acceptance_digest&&
    original.receiptDigest===row.previous_receipt_digest&&original.replayDigest===row.previous_replay_digest,'GUARD_OWNER_POLICY_LINEAGE_PREVIOUS');
  const intent=signed(STATE+'/checkpoint-intents/'+lineage.operationId+'.json',keys,'owner-checkpoint-intent',lineage.intentRef,true).payload;
  const dispatch=signed(STATE+'/checkpoint-dispatches/'+lineage.operationId+'.json',keys,'checkpoint-dispatch',lineage.dispatchRef,true).payload;
  need(Date.parse(prior.issuedAt)<=Date.parse(intent.issuedAt)&&Date.parse(intent.issuedAt)<=Date.parse(dispatch.issuedAt)&&
    Date.parse(dispatch.issuedAt)<Date.parse(prior.expiresAt)&&
    Date.parse(intent.originalBody.proofValidUntilUTC)<=Date.parse(prior.expiresAt),'GUARD_OWNER_POLICY_LINEAGE_SOURCE_TIME');
  return lineage;
}
function checkpointAcceptance(entry,row,source,binding,policy,keys) {
  const c=row.acceptance,r=row.receipt,o=row.replay,h=row.receipt_proof;
  if(source.checkpointAcceptanceRef===null) {
    need(entry.purpose==='checkpoint-publish'&&policy.transition&&c===null,'GUARD_OWNER_CHECKPOINT_ACCEPTANCE_REQUIRED');
    return null;
  }
  need(ref(source.checkpointAcceptanceRef)&&c&&r&&o&&h&&uuid(c.acceptance_id)&&uuid(c.receipt_id)&&uuid(r.replay_operation_id)&&uuid(r.source_proof_id)&&
    c.dataset_binding_id===binding.datasetBindingId&&c.receipt_id===r.receipt_id&&c.policy_generation===String(binding.policyGeneration)&&c.policy_digest===binding.policyDigest&&
    c.protected_config_id===binding.protectedConfigId&&c.continuity_epoch===binding.continuityEpoch&&c.admission_policy_id===row.policy.admission_policy_id&&
    c.root_evidence_ref===c.acceptance_id&&r.owner_id===entry.owner&&r.binding_id===binding.runtimeBindingId&&r.production_authorization===false&&
    r.replay_operation_id===o.operation_id&&r.source_proof_id===o.source_proof_id&&o.binding_id===binding.runtimeBindingId&&
    h.proof_id===r.source_proof_id&&h.proof_jws_digest===r.source_proof_jws_digest&&h.binding_id===binding.runtimeBindingId&&
    h.operation_id===o.operation_id&&h.operation_kind===o.operation_kind&&hex(row.acceptance_digest)&&hex(row.receipt_digest)&&hex(row.replay_digest),
  'GUARD_OWNER_CHECKPOINT_LINKS');
  const accepted=signed(STATE+'/checkpoint-acceptances/'+c.acceptance_id+'.json',keys,'checkpoint-acceptance',source.checkpointAcceptanceRef,true),p=accepted.payload;
  need(exact(p,[...BASE,'acceptanceId','datasetBindingId','receiptId','replayOperationId','sourceProofId','acceptanceDigest','receiptDigest','replayDigest'])&&
    p.recordId===c.acceptance_id&&p.acceptanceId===c.acceptance_id&&p.datasetBindingId===binding.datasetBindingId&&p.receiptId===r.receipt_id&&
    p.replayOperationId===o.operation_id&&p.sourceProofId===h.proof_id&&p.acceptanceDigest===row.acceptance_digest&&p.receiptDigest===row.receipt_digest&&p.replayDigest===row.replay_digest,
  'GUARD_OWNER_CHECKPOINT_DIGESTS');
  // P0 -> receipt/replay -> acceptance -> current P1. P0 is deliberately
  // historical and need not be P1; requiring equality creates a digest cycle.
  const historical=verifyRootJws(readRootFile(STATE+'/runtime-proofs/'+h.proof_id+'.jws',{secret:true}),keys,'runtime-proof',{historical:true}),q=historical.payload;
  need(exact(q,[...BASE,'owner','binding','operationId','operationKind','trustProfileId','ownerPolicyRef','checkpointAcceptanceRef','frontierSequence','frontierDigest','clusterId','timelineId','observation'])&&
    historical.digest===h.proof_jws_digest&&h.accepted_jws_ref===h.proof_id+':'+historical.digest&&q.recordId===h.proof_id&&q.owner===entry.owner&&
    exact(q.binding,BINDING)&&equalBinding(q.binding,binding)&&q.operationId===o.operation_id&&q.operationKind===o.operation_kind&&q.trustProfileId===h.trust_profile_id,
  'GUARD_OWNER_CHECKPOINT_SOURCE');
  const prior=observation(q.observation,entry.owner);
  need((q.checkpointAcceptanceRef===null||ref(q.checkpointAcceptanceRef))&&
    row.receipt_proof_exact_milliseconds===true&&q.issuedAt===row.receipt_proof_issued&&q.expiresAt===row.receipt_proof_expires&&prior.observedAtUTC===row.receipt_proof_observed&&
    Date.parse(prior.observedAtUTC)<=Date.parse(q.issuedAt)&&Date.parse(q.expiresAt)-Date.parse(prior.observedAtUTC)<=30000&&
    Date.parse(prior.observedAtUTC)<=Date.parse(source.observation.observedAtUTC)&&canonical({...prior,observedAtUTC:null})===canonical({...source.observation,observedAtUTC:null})&&
    q.frontierSequence===source.frontierSequence&&q.frontierDigest===source.frontierDigest&&h.frontier_sequence===String(source.frontierSequence)&&h.frontier_digest===source.frontierDigest&&
    q.clusterId===source.clusterId&&q.timelineId===source.timelineId,'GUARD_OWNER_CHECKPOINT_COHORT');
  const lineage=checkpointPolicyLineage(entry,row,source,q,binding,keys);
  const frontier=row.frontier_sequence,digest=row.frontier_digest;
  need(c.accepted_frontier_sequence===frontier&&c.accepted_frontier_digest===digest&&c.fence_sequence===frontier&&c.fence_digest===digest&&
    r.fence_sequence===frontier&&r.fence_digest===digest&&c.cleanup_sequence===r.cleanup_sequence&&c.cleanup_digest===r.cleanup_digest&&
    c.cleanup_status===r.cleanup_status&&['pending','complete'].includes(c.cleanup_status)&&/^(0|[1-9][0-9]*)$/.test(c.cleanup_sequence)&&
    BigInt(c.cleanup_sequence)<=BigInt(frontier)&&c.cleanup_digest===row.cleanup_prefix,'GUARD_OWNER_CHECKPOINT_FRONTIER');
  if(['read','checkpoint-read'].includes(entry.purpose))need(c.cleanup_status==='complete'&&c.cleanup_sequence===frontier&&c.cleanup_digest===digest,'GUARD_OWNER_CHECKPOINT_PENDING');
  return {reference:{recordId:p.recordId,digest:accepted.digest},lineage};
}
function consumedCheckpointTransition(entry,policy,binding,keys) {
  const t=policy.transition,body=transitionBody(policy,entry.owner,binding.storeIncarnation),bodyDigest=sha256(canonical(body));
  const facts={...binding,owner:entry.owner,scope:policy.scope,operationId:t.operationId,transitionIntentRef:t.intentRef,bodyDigest,originalBody:body};
  const intent=signed(STATE+'/checkpoint-intents/'+t.operationId+'.json',keys,'owner-checkpoint-intent',undefined,true),ip=intent.payload;
  need(exact(ip,[...BASE,...Object.keys(facts)])&&ip.recordId===t.operationId&&
    Object.keys(facts).every(k=>canonical(ip[k])===canonical(facts[k])),'GUARD_OWNER_POST_TRANSITION_INTENT');
  const expected={owner:entry.owner,scope:policy.scope,operationId:t.operationId,storeIncarnation:binding.storeIncarnation,
    guardStoreId:binding.guardStoreId,continuityEpoch:binding.continuityEpoch,protectedConfigId:binding.protectedConfigId,
    datasetBindingId:binding.datasetBindingId,runtimeBindingId:binding.runtimeBindingId,transitionIntentRef:t.intentRef,
    intentRef:{recordId:ip.recordId,digest:intent.digest},bodyDigest};
  const dp=signed(STATE+'/checkpoint-dispatches/'+t.operationId+'.json',keys,'checkpoint-dispatch',undefined,true).payload;
  need(exact(dp,[...BASE,...Object.keys(expected)])&&dp.recordId===t.operationId&&
    Object.keys(expected).every(k=>canonical(dp[k])===canonical(expected[k])),'GUARD_OWNER_POST_TRANSITION_DISPATCH');
  const deadline=Date.parse(t.proofValidUntilUTC);
  need(Date.parse(ip.issuedAt)<=Date.parse(dp.issuedAt)&&Date.parse(ip.issuedAt)<deadline&&
    deadline-Date.parse(ip.issuedAt)<=30000&&Date.parse(dp.issuedAt)<deadline,'GUARD_OWNER_POST_TRANSITION_DEADLINE');
}
async function targetPins(entry,policy,binding,lineage,keys) {
  const owner=entry.owner,spec=SPEC[owner],driver=owner==='sim_driver_measurements';
  const request=driver?parseDriverReadRequest({owner,scope:spec.scope,purpose:'capability'}):
    parseAiCheckpointRequest({owner,scope:spec.scope,purpose:'checkpoint',expectedSnapshot:policy.expectedSnapshot});
  return target(entry,async query=>{
    await query('BEGIN READ ONLY');await query("SET LOCAL statement_timeout='3000ms'");await query("SET LOCAL lock_timeout='1000ms'");
    const r=await query(spec.facts,[JSON.stringify(request)]);need(r.rows.length===1,'GUARD_OWNER_TARGET_FACTS');
    const f=driver?validateDriverReadFacts(r.rows[0].value,request):validateAiCheckpointFacts(r.rows[0].value,request),permissions=driver?f.privileges:f.permissions,now=Date.now();
    need(Date.parse(f.observedAtUTC)<=now&&now-Date.parse(f.observedAtUTC)<=5000&&f.storeIncarnation===binding.storeIncarnation&&f.schema.ready&&
      f.schema.fingerprint===policy.schemaFingerprint&&permissions.runtimeProfileMatches&&permissions.fingerprint===policy.privilegeFingerprint,'GUARD_OWNER_TARGET_PINS');
    let authorizedPost=false;
    if(entry.purpose!=='checkpoint-publish') {
      if(driver)matchDriverReadPolicy(f,request,{storeIncarnation:binding.storeIncarnation,checkpointHash:policy.expectedCheckpointHash,
        schemaFingerprint:policy.schemaFingerprint,privilegeFingerprint:policy.privilegeFingerprint,reportProtection:policy.reportProtection},now);
      else matchAiCheckpointPolicy(f,request,{storeIncarnation:binding.storeIncarnation,schemaFingerprint:policy.schemaFingerprint,
        privilegeFingerprint:policy.privilegeFingerprint,costPolicy:policy.costPolicy},now);
    }else {
      // Only the independently signed transition permits the exact old OR new
      // target during a publisher's actual exclusive lease. Never adopt a
      // third checkpoint, mixed flags, changed digest, or arbitrary DB state.
      const t=policy.transition;need(t,'GUARD_OWNER_TRANSITION_REQUIRED');
      if(driver) {
        const post=['checkpointHash','proofValidUntilUTC','replayReady','retentionReviewed','reportProtection','publicationFenceVerified'].every(k=>f.state[k]===t[k]);
        const pre=f.state.checkpointHash===t.expectedPreviousCheckpointHash&&(t.expectedPreviousCheckpointHash===null?
          !f.state.replayReady&&!f.state.retentionReviewed&&!f.state.publicationFenceVerified&&f.state.reportProtection==='unverified'&&
            f.state.proofValidUntilUTC===null&&!f.state.proofCurrent:
          f.state.checkpointHash===policy.expectedCheckpointHash&&
            (f.state.replayReady&&f.state.retentionReviewed&&f.state.publicationFenceVerified&&f.state.reportProtection===policy.reportProtection||
              !f.state.replayReady&&!f.state.retentionReviewed&&!f.state.publicationFenceVerified&&f.state.reportProtection==='unverified'));
        need(pre||post,'GUARD_OWNER_TARGET_CHECKPOINT');
        if(!pre){consumedCheckpointTransition(entry,policy,binding,keys);authorizedPost=true;}
      }else {
        const cp=f.checkpoint;
        need(cp&&f.invariants.rlsEnabled&&f.invariants.fencesReady&&f.invariants.financialViewsReady&&
          cp.operation_digest===t.operationDigest&&cp.schema_digest===t.schemaDigest,'GUARD_OWNER_TARGET_INVARIANTS');
        const pre=cp.checkpoint_id===t.expectedCheckpointId&&cp.checkpoint_generation===t.expectedGeneration&&f.snapshotMatches&&
          (cp.identity_reviewed&&cp.replay_ready&&cp.cost_policy===COST&&f.invariants.costRetentionReady||
            !cp.identity_reviewed&&!cp.replay_ready&&cp.cost_policy==='pending_requires_review'&&!f.invariants.costRetentionReady);
        const post=cp.checkpoint_id===t.checkpointId&&cp.checkpoint_generation===t.generation&&cp.identity_reviewed===t.identityReviewed&&
          cp.replay_ready===t.replayReady&&cp.cost_policy===t.costPolicy&&f.invariants.costRetentionReady===(t.costPolicy===COST);
        need(pre||post,'GUARD_OWNER_TARGET_CHECKPOINT');
        if(!pre){consumedCheckpointTransition(entry,policy,binding,keys);authorizedPost=true;}
      }
    }
    // A's old receipt cannot approve B against a different current target.
    if(lineage&&!authorizedPost) {
      if(driver)need(Object.keys(lineage.expectedDriverState).every(k=>f.state[k]===lineage.expectedDriverState[k]),'GUARD_OWNER_POLICY_LINEAGE_TARGET');
      else need(f.checkpoint&&f.checkpoint.checkpoint_id===lineage.expectedAiSnapshot.checkpointId&&
        f.checkpoint.checkpoint_generation===lineage.expectedAiSnapshot.generation&&f.checkpoint.operation_digest===lineage.expectedAiSnapshot.operationDigest&&
        f.checkpoint.schema_digest===lineage.expectedAiSnapshot.schemaDigest,'GUARD_OWNER_POLICY_LINEAGE_TARGET');
    }
    await query('COMMIT');return f;
  });
}
async function inspectCurrent(entry) {
  root();
  need(!globalHold&&!entry.hold&&!entry.closed&&entry.locked,'GUARD_OWNER_HOLD');
  const before=keyring();if(entry.keysDigest)need(sha256(before.bytes)===entry.keysDigest,'GUARD_OWNER_KEYRING_CHANGED');
  const {observed:live}=currentHost(entry.owner,before.keys);
  const reg=registration(entry.owner,entry.peer,before.keys),res=await metadata(entry,SQL,[reg.payload.datasetBindingId,reg.payload.runtimeBindingId]);
  need(res.rows.length===1,'GUARD_OWNER_REGISTRY');const row=res.rows[0],binding=sqlBinding(row,entry.owner,reg.payload);
  const policyRecord=signed(STATE+'/owner-policies/'+entry.owner+'.json',before.keys,'owner-policy',undefined,true),p=policyRecord.payload;
  need(exact(p,[...BASE,'binding','policy'])&&exact(p.binding,BINDING)&&equalBinding(p.binding,binding),'GUARD_OWNER_POLICY_BINDING');
  const policy=domainPolicy(p.policy,entry.owner,SPEC[entry.owner].scope),policyRef={recordId:p.recordId,digest:policyRecord.digest};
  const proof=verifyRootJws(readRootFile(STATE+'/runtime-proofs/'+row.proof.proof_id+'.jws',{secret:true}),before.keys,'runtime-proof'),s=proof.payload;
  need(exact(s,[...BASE,'owner','binding','operationId','operationKind','trustProfileId','ownerPolicyRef','checkpointAcceptanceRef','frontierSequence','frontierDigest','clusterId','timelineId','observation'])&&
    s.owner===entry.owner&&exact(s.binding,BINDING)&&equalBinding(s.binding,binding)&&s.recordId===row.proof.proof_id&&proof.digest===row.proof.proof_jws_digest&&
    s.operationId===row.proof.operation_id&&s.operationKind===row.proof.operation_kind&&s.trustProfileId===row.proof.trust_profile_id&&
    canonical(s.ownerPolicyRef)===canonical(policyRef)&&s.issuedAt===row.issued&&s.expiresAt===row.expires,'GUARD_OWNER_SOURCE_PROOF');
  const observed=observation(s.observation,entry.owner);
  need(observed.observedAtUTC===row.observed&&Date.parse(s.expiresAt)-Date.parse(observed.observedAtUTC)<=30000&&
    Date.parse(observed.observedAtUTC)<=Date.parse(s.issuedAt)&&Date.parse(live.observedAtUTC)>=Date.parse(observed.observedAtUTC)&&
    Date.parse(live.observedAtUTC)-Date.parse(observed.observedAtUTC)<=30000&&Date.parse(live.observedAtUTC)<=Date.now()&&Date.now()-Date.parse(live.observedAtUTC)<=5000&&
    canonical({...observed,observedAtUTC:null})===canonical({...live,observedAtUTC:null})&&canonical(live.peer)===canonical(entry.peer)&&
    live.dockerContainerId===row.runtime.runtime_instance_id&&live.imageId===row.runtime.image_id&&live.sourceRevision===row.runtime.source_revision&&
    live.machineBootId===reg.payload.machineBootId,'GUARD_OWNER_RUNTIME_OBSERVATION');
  const anchor=signed(STATE+'/authority/current-frontier.json',before.keys,'current-frontier'),a=anchor.payload;
  need(exact(a,[...BASE,'guardStoreId','continuityEpoch','sequence','digest','machineBootId','clusterId','timelineId'])&&
    a.guardStoreId===binding.guardStoreId&&a.continuityEpoch===binding.continuityEpoch&&a.sequence===s.frontierSequence&&a.digest===s.frontierDigest&&
    Number.isSafeInteger(a.sequence)&&a.sequence>=0&&String(a.sequence)===row.frontier_sequence&&a.digest===row.frontier_digest&&hex(a.digest)&&
    String(row.proof.frontier_sequence)===String(a.sequence)&&row.proof.frontier_digest===a.digest&&a.machineBootId===live.machineBootId&&
    typeof a.clusterId==='string'&&/^[0-9]{1,20}$/.test(a.clusterId)&&a.clusterId===row.cluster_id&&s.clusterId===a.clusterId&&
    Number.isSafeInteger(a.timelineId)&&a.timelineId>0&&a.timelineId===row.timeline_id&&s.timelineId===a.timelineId&&
    Date.parse(a.expiresAt)-Date.parse(a.issuedAt)<=30000,'GUARD_OWNER_FRONTIER');
  const acceptance=checkpointAcceptance(entry,row,s,binding,policy,before.keys),acceptanceRef=acceptance?.reference??null;
  policyEvidence(policy,binding,entry.owner,before.keys);await targetPins(entry,policy,binding,acceptance?.lineage,before.keys);
  const second=await metadata(entry,SQL,[reg.payload.datasetBindingId,reg.payload.runtimeBindingId]);
  const lastReg=registration(entry.owner,entry.peer,before.keys),lastPolicy=signed(STATE+'/owner-policies/'+entry.owner+'.json',before.keys,'owner-policy',policyRef,true);
  const lastProof=verifyRootJws(readRootFile(STATE+'/runtime-proofs/'+row.proof.proof_id+'.jws',{secret:true}),before.keys,'runtime-proof');
  const lastAnchor=signed(STATE+'/authority/current-frontier.json',before.keys,'current-frontier');
  policyEvidence(policy,binding,entry.owner,before.keys);
  const lastAcceptance=checkpointAcceptance(entry,row,s,binding,policy,before.keys);
  const {observed:lastObservation}=currentHost(entry.owner,before.keys);
  need(second.rows.length===1&&canonical(second.rows[0])===canonical(row)&&sha256(readRootFile(KEYRING))===sha256(before.bytes)&&
    lastReg.digest===reg.digest&&lastPolicy.digest===policyRecord.digest&&lastProof.digest===proof.digest&&lastAnchor.digest===anchor.digest&&canonical(lastAcceptance)===canonical(acceptance)&&
    canonical({...lastObservation,observedAtUTC:null})===canonical({...live,observedAtUTC:null})&&Date.parse(lastObservation.observedAtUTC)>=Date.parse(live.observedAtUTC)&&
    Date.parse(lastObservation.observedAtUTC)<=Date.now()&&Date.now()-Date.parse(lastObservation.observedAtUTC)<=5000&&!globalHold&&!entry.hold,'GUARD_OWNER_CONTINUITY_CHANGED');
  const expiresAtUTC=new Date(Math.min(Date.parse(s.expiresAt),Date.parse(reg.payload.expiresAt),Date.parse(a.expiresAt))).toISOString();
  need(Date.parse(expiresAtUTC)>Date.now(),'GUARD_OWNER_EXPIRED');
  const state=freeze({binding,registration:reg.payload,registrationRef:{recordId:reg.payload.recordId,digest:reg.digest},keys:before.keys,keysDigest:sha256(before.bytes),
    rootPolicy:{...policy,reference:policyRef},sourceProofId:s.recordId,frontierSequence:a.sequence,frontierDigest:a.digest,expiresAtUTC,
    checkpointAcceptanceRef:acceptanceRef,proofDigest:proof.digest,anchorDigest:anchor.digest,observationDigest:sha256(canonical({...observed,observedAtUTC:null}))});
  if(entry.state)need(canonical(state)===canonical(entry.state),'GUARD_OWNER_CONTEXT_CHANGED');return state;
}
function serial(entry,work) {
  // A known authorization expiry rejects work but is not an unknown session.
  // Only explicit close after the caller's drain can release this real lease.
  const next=entry.queue.then(async()=>{need(!entry.closing&&!entry.closed&&!entry.hold&&!globalHold,'GUARD_OWNER_HOLD');return work();});
  entry.queue=next.catch(()=>undefined);return next;
}
async function current(entry) {return serial(entry,()=>inspectCurrent(entry));}
async function signedCurrent(entry,kind,facts,path,recordId=randomUUID(),lifetime=5000) {
    await current(entry);const ceiling=Date.parse(entry.state.expiresAtUTC);
    const ttl=Math.min(lifetime,5000,ceiling-Date.now()-100);need(Number.isSafeInteger(ttl)&&ttl>0,'GUARD_OWNER_EXPIRED');
    const record=issueRootRecord(kind,facts,{recordId,lifetimeMs:ttl,expectedKeyringDigest:entry.state.keysDigest});
    verifyRootRecord(record.bytes,entry.state.keys,kind);need(Date.parse(record.payload.expiresAt)<=ceiling&&
      Date.parse(record.payload.expiresAt)-Date.parse(record.payload.issuedAt)<=5000,'GUARD_OWNER_RECORD_EXPIRY');
    storeRootRecord(path(recordId),record.bytes);await current(entry);
    verifyRootRecord(record.bytes,entry.state.keys,kind);
    // Typed-array elements cannot be frozen. Return a distinct byte copy; the
    // signed protected file and digest, never mutability, carry its authority.
    return Object.freeze({recordId,digest:record.digest,bytes:Buffer.from(record.bytes)});
}
export async function requireCurrentOwner(owner,peer,purpose) {
  root();need(Object.hasOwn(SPEC,owner)&&peerValid(peer)&&PURPOSES.includes(purpose)&&
    !(owner==='sim_ai_router'&&purpose==='read')&&!(owner==='sim_driver_measurements'&&purpose==='checkpoint-read')&&!globalHold,'GUARD_OWNER_REQUEST');
  // Reject a prior broker's snapshot before even opening the registry socket.
  currentHost(owner,keyring().keys);
  const entry={owner,peer:freeze(copy(peer)),purpose,locked:false,acquiring:false,hold:false,closed:false,closing:false,queue:Promise.resolve(),targets:new Set()};
  entry.client=newClient('registry-probe','cop_account_safety_guard','cop_guard_root_reader',entry);
  try {
    await entry.client.client.connect();need(!globalHold,'GUARD_OWNER_HOLD');
    entry.acquiring=true;
    const shared=['read','checkpoint-read'].includes(purpose),sql=shared?'pg_try_advisory_lock_shared':'pg_try_advisory_lock';
    const r=await metadata(entry,`SELECT pg_catalog.${sql}(pg_catalog.hashtext(current_database()),904214) AS held`);
    need(r.rows.length===1&&typeof r.rows[0].held==='boolean','GUARD_OWNER_LOCK_UNKNOWN');
    entry.acquiring=false;if(!r.rows[0].held){await endKnown(entry.client,entry);throw new Error('GUARD_OWNER_LEASE_BUSY');}
    entry.locked=true;heldSessions.add(entry);need(!globalHold,'GUARD_OWNER_HOLD');await metadata(entry,'BEGIN READ ONLY');await metadata(entry,"SET LOCAL TimeZone='UTC'");
    await metadata(entry,'SET LOCAL search_path=pg_catalog');
    entry.state=await inspectCurrent(entry);entry.keysDigest=entry.state.keysDigest;const s=entry.state;
    const authority=await signedCurrent(entry,'owner-authority',{...s.binding,owner,scope:SPEC[owner].scope,purpose,sourceProofId:s.sourceProofId,
      ownerPolicyRef:s.rootPolicy.reference,frontierSequence:s.frontierSequence,frontierDigest:s.frontierDigest,peer:entry.peer,
      registrationRef:s.registrationRef,observationDigest:s.observationDigest},id=>PRIVATE+'/owner-authority/'+id+'.json');
    let ctx;ctx=freeze({contractVersion:'cop-root-owner-authority-v1',owner,scope:SPEC[owner].scope,purpose,registration:s.registration,peer:entry.peer,
      ...Object.fromEntries(LIVE.filter(k=>!['sourceProofId','frontierSequence','frontierDigest'].includes(k)).map(k=>[k,s.binding[k]])),
      protectedConfigId:s.binding.protectedConfigId,sourceProofId:s.sourceProofId,frontierSequence:s.frontierSequence,frontierDigest:s.frontierDigest,
      expiresAtUTC:s.expiresAtUTC,reference:{recordId:authority.recordId,digest:authority.digest},rootPolicy:s.rootPolicy,keys:s.keys,
      assertCurrent:async()=>{need(contexts.get(ctx)===entry,'GUARD_OWNER_CONTEXT');await current(entry);},close:()=>{
        if(entry.closePromise)return entry.closePromise;if(entry.closed)return Promise.resolve();
        // Concurrent explicit callers await the same actual cleanup. A failed
        // first cleanup is retained; it never starts another rollback/end.
        entry.closePromise=(async()=>{
          try {
            need(!entry.hold&&!globalHold,'GUARD_OWNER_HOLD');entry.closing=true;await entry.queue;
            need(!entry.hold&&!globalHold&&entry.targets.size===0,'GUARD_OWNER_HOLD');
            await metadata(entry,'ROLLBACK');await endKnown(entry.client,entry);entry.locked=false;entry.closed=true;heldSessions.delete(entry);
          }catch {hold(entry);throw new Error('GUARD_OWNER_HOLD');}
        })();return entry.closePromise;
      }});
    need(!globalHold&&!entry.hold,'GUARD_OWNER_HOLD');entry.ctx=ctx;contexts.set(ctx,entry);return ctx;
  }catch(error){
    if(entry.acquiring||entry.hold||globalHold){hold(entry);throw error;}
    // No context/callback was ever returned. A known rejection may release only
    // after actual target closure and a positively completed registry end.
    need(entry.targets.size===0,'GUARD_OWNER_TARGET_END_UNKNOWN');
    if(entry.locked)await metadata(entry,'ROLLBACK');
    if(!entry.client.ended)await endKnown(entry.client,entry);
    entry.locked=false;entry.closed=true;heldSessions.delete(entry);throw error;
  }
}
export async function issueOwnerEphemeralRecord(ctx,kind,facts,recordId=randomUUID()) {
  const entry=entryFor(ctx);need(['read','checkpoint-read'].includes(entry.purpose)&&uuid(recordId),'GUARD_OWNER_READ_PURPOSE');
  const value=freeze(copy(facts)),plan=readFactsShape(kind,value,ctx,recordId);
  // A permit must reference the exact still-live records independently signed
  // for this same Root context, never a caller's unchecked evidence references.
  if(kind==='driver-read-permit'||kind==='ai-router-read-permit') {
    const decisions=entry.owner==='sim_driver_measurements'?DRIVER_DECISIONS:AI_DECISIONS;
    for(const [k,decision]of Object.entries(decisions)) {
      const r=signed(PRIVATE+'/read-evidence/'+value.evidence[k].recordId+'.json',entry.state.keys,k,value.evidence[k]);
      readFactsShape(k,Object.fromEntries(Object.entries(r.payload).filter(([name])=>!BASE.includes(name))),ctx,r.payload.recordId);
      need(READ_BINDING.every(name=>r.payload[name]===plan.bound[name])&&r.payload.decision===decision,'GUARD_OWNER_READ_EVIDENCE');
    }
    if(entry.owner==='sim_driver_measurements') {
      const r=signed(PRIVATE+'/read-evidence/'+value.reportInventoryRef.recordId+'.json',entry.state.keys,'driver-report-inventory',value.reportInventoryRef);
      readFactsShape('driver-report-inventory',Object.fromEntries(Object.entries(r.payload).filter(([name])=>!BASE.includes(name))),ctx,r.payload.recordId);
      need(READ_BINDING.every(name=>r.payload[name]===plan.bound[name]),'GUARD_OWNER_READ_INVENTORY');
    }
  }
  return signedCurrent(entry,kind,value,id=>PRIVATE+'/'+plan.directory+'/'+id+'.json',recordId);
}
function exists(path) {try{lstatSync(path);return true;}catch(error){if(error?.code==='ENOENT')return false;throw error;}}
export async function archiveCurrentOwnerPolicy(ctx) {
  const entry=entryFor(ctx);need(entry.purpose==='checkpoint-publish','GUARD_OWNER_CHECKPOINT_PURPOSE');
  return serial(entry,async()=>{
    await inspectCurrent(entry);
    const directory=STATE+'/owner-policy-history';requireRootDirectory(directory,{secret:true});
    need((lstatSync(directory).mode&0o777)===0o700,'GUARD_OWNER_POLICY_HISTORY_CUSTODY');
    const reference=entry.state.rootPolicy.reference,currentPath=STATE+'/owner-policies/'+entry.owner+'.json';
    const bytes=readRootFile(currentPath,{secret:true}),record=verifyRootRecord(bytes,entry.state.keys,'owner-policy',{historical:true});
    need(record.digest===reference.digest&&record.payload.recordId===reference.recordId,'GUARD_OWNER_POLICY_HISTORY_REFERENCE');
    const path=directory+'/'+reference.recordId+'.json';
    try{storeRootRecord(path,bytes);}catch(error){if(error?.code!=='EEXIST')throw error;}
    const archived=readRootFile(path,{secret:true});
    need(archived.equals(bytes)&&sha256(archived)===reference.digest,'GUARD_OWNER_POLICY_HISTORY_IMMUTABLE');
    verifyRootRecord(archived,entry.state.keys,'owner-policy',{historical:true});
    await inspectCurrent(entry);
    need(readRootFile(currentPath,{secret:true}).equals(bytes)&&readRootFile(path,{secret:true}).equals(bytes),'GUARD_OWNER_POLICY_HISTORY_CHANGED');
    return freeze(copy(reference));
  });
}
export async function beginOwnerPublicationIntent(ctx,body) {
  const entry=entryFor(ctx);need(entry.purpose==='checkpoint-publish','GUARD_OWNER_CHECKPOINT_PURPOSE');await current(entry);
  const t=ctx.rootPolicy.transition;need(t,'GUARD_OWNER_TRANSITION_REQUIRED');
  const value=freeze(copy(body));need(canonical(value)===canonical(transitionBody(ctx.rootPolicy,ctx.owner,ctx.storeIncarnation)),'GUARD_OWNER_ORIGINAL_BODY');
  const path=STATE+'/checkpoint-intents/'+t.operationId+'.json',facts={...entry.state.binding,owner:ctx.owner,scope:ctx.scope,operationId:t.operationId,
    transitionIntentRef:t.intentRef,bodyDigest:sha256(canonical(value)),originalBody:value};
  let record;
  if(exists(path))record=signed(path,entry.state.keys,'owner-checkpoint-intent',undefined,true);
  else {
    need(Date.parse(t.proofValidUntilUTC)>Date.now()&&Date.parse(t.proofValidUntilUTC)-Date.now()<=30000,'GUARD_OWNER_TRANSITION_EXPIRED');
    const r=issueRootRecord('owner-checkpoint-intent',facts,{recordId:t.operationId,lifetimeMs:300000,expectedKeyringDigest:entry.state.keysDigest});
    try{storeRootRecord(path,r.bytes);}catch(error){if(error?.code!=='EEXIST')throw error;}
    record=signed(path,entry.state.keys,'owner-checkpoint-intent',undefined,true);
  }
  need(exact(record.payload,[...BASE,...Object.keys(facts)])&&record.payload.recordId===t.operationId&&
    Object.keys(facts).every(k=>canonical(record.payload[k])===canonical(facts[k])),'GUARD_OWNER_IMMUTABLE_INTENT');
  await current(entry);return freeze({recordId:record.payload.recordId,digest:record.digest,operationId:t.operationId,bodyDigest:facts.bodyDigest,originalBody:value});
}
export async function requirePublicationBarrier(ctx,facts) {
  const entry=entryFor(ctx);need(ctx.owner==='sim_driver_measurements'&&['publication','mutation'].includes(entry.purpose),'GUARD_PUBLICATION_PURPOSE');
  need(exact(facts,['operationDigest','readbackDigest','reportProtection','storeIncarnation','eraseOriginId','baseBody','observedAtUTC'])&&
    hex(facts.operationDigest)&&hex(facts.readbackDigest)&&facts.reportProtection===ctx.rootPolicy.reportProtection&&facts.storeIncarnation===ctx.storeIncarnation&&
    uuid(facts.eraseOriginId)&&stamp(facts.observedAtUTC)&&Date.parse(facts.observedAtUTC)<=Date.now()&&Date.now()-Date.parse(facts.observedAtUTC)<=5000,'GUARD_PUBLICATION_FACTS');
  const value=freeze(copy(facts)),base=value.baseBody;
  need(exact(base,['contractVersion','operationHash','actorHash','requestHash','contributors','checkpointHash'])&&base.contractVersion==='sim-driver-guarded-db-v1'&&
    ['operationHash','actorHash','requestHash','checkpointHash'].every(k=>hex(base[k]))&&base.checkpointHash===ctx.rootPolicy.expectedCheckpointHash&&
    Array.isArray(base.contributors)&&base.contributors.length>=9&&base.contributors.length<=40&&base.contributors.every(row=>exact(row,['contributorDay','contributorHash'])&&
      typeof row.contributorDay==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(row.contributorDay)&&Number.isFinite(Date.parse(row.contributorDay+'T00:00:00Z'))&&
      new Date(row.contributorDay+'T00:00:00Z').toISOString().slice(0,10)===row.contributorDay&&hex(row.contributorHash)),'GUARD_PUBLICATION_BODY');
  const unique=new Set(base.contributors.map(row=>row.contributorHash));
  await current(entry);
  const original=new RootDriverAuthority({query:(text,values)=>metadata(entry,text,values)},value.eraseOriginId,ctx.registration),op=original.operation;
  need(op.kind==='erase'&&op.storeIncarnation===ctx.storeIncarnation,'GUARD_PUBLICATION_ERASE_ORIGIN');await original.validate(op,'probe');
  const readback=()=>target(entry,async query=>{
    await query('BEGIN');await query("SET LOCAL statement_timeout='3000ms'");await query("SET LOCAL lock_timeout='1000ms'");
    const digest=(await query("SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') AS digest",[JSON.stringify(base)])).rows[0]?.digest;
    need(digest===op.bodyDigest,'GUARD_PUBLICATION_BODY_DIGEST');
    const r=await query('SELECT sim_driver_guard_source.read_publication_context($1::uuid,$2::jsonb) AS value',[value.eraseOriginId,JSON.stringify(base)]),v=r.rows[0]?.value;
    need(r.rows.length===1&&exact(v,['storeIncarnation','payloadDigest','erasureOperationDigest','databaseZeroVerified','remainingBatchCount','exactFenceCount','readbackAt'])&&
      v.storeIncarnation===ctx.storeIncarnation&&v.payloadDigest===op.bodyDigest&&v.erasureOperationDigest===value.operationDigest&&v.databaseZeroVerified===true&&v.remainingBatchCount===0&&
      v.exactFenceCount===unique.size&&stamp(v.readbackAt)&&Date.parse(v.readbackAt)>=Date.parse(value.observedAtUTC)&&
      Date.parse(v.readbackAt)<=Date.now()&&Date.now()-Date.parse(v.readbackAt)<=5000,'GUARD_PUBLICATION_READBACK');
    const normalized={...v,readbackAt:value.observedAtUTC};
    const hash=(await query("SELECT encode(sha256(convert_to($1::jsonb::text,'UTF8')),'hex') AS digest",[JSON.stringify(normalized)])).rows[0]?.digest;
    need(hash===value.readbackDigest,'GUARD_PUBLICATION_READBACK_DIGEST');await query('COMMIT');return normalized;
  });
  const first=await readback();await current(entry);const second=await readback();need(canonical(first)===canonical(second),'GUARD_PUBLICATION_READBACK_CHANGED');
  need(Date.now()-Date.parse(value.observedAtUTC)<=5000,'GUARD_PUBLICATION_EXPIRED');await original.validate(op,'probe');await current(entry);
  const result=await signedCurrent(entry,'driver-publication-barrier',{...entry.state.binding,owner:ctx.owner,scope:ctx.scope,eraseOriginId:value.eraseOriginId,
    operationDigest:value.operationDigest,readbackDigest:value.readbackDigest,reportProtection:value.reportProtection,observedAtUTC:value.observedAtUTC,reportPolicyRef:ctx.rootPolicy.reportPolicyRef},
  id=>STATE+'/evidence/'+id+'.json');return freeze({recordId:result.recordId,digest:result.digest});
}
