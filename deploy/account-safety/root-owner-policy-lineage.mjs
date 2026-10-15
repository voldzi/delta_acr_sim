/** SOURCE ONLY: necessary historical owner-policy lineage, NEVER authority.
 * Fixed Root files/signatures prove a single independently signed A -> T -> B
 * relationship and the original consumed dispatch, not an original COMMIT,
 * present target state, accepted metadata, current cohort, lease or readiness.
 * The actual common must independently bind its WeakMap context, P0/P1 JWS,
 * latest acceptance/receipt/replay, current self/host/frontier and fresh SQL004
 * target facts before any positive operation. This module neither writes nor
 * archives policies, issues records, renews deadlines or dispatches SQL.
 *
 * Input exact {owner,binding,priorRef,currentRef}; binding has the existing8
 * BINDING fields and each reference is exact {recordId,digest}. Different IDs
 * are required. Both signed policies use BASE + nested binding + policy.
 *
 * Output exact {contractVersion:'cop-root-owner-policy-lineage-v1',priorRef,
 * currentRef,operationId,transitionIntentRef,intentRef,dispatchRef,
 * expectedDriverState} for Driver; the AI variant substitutes
 * expectedAiSnapshot. expectedDriverState has exactly checkpointHash,
 * proofValidUntilUTC,replayReady,retentionReviewed,reportProtection,
 * publicationFenceVerified. expectedAiSnapshot has exactly checkpointId,
 * generation,operationDigest,schemaDigest. These are signed EXPECTATIONS,
 * never an observation/boolean grant. All returned objects are deeply frozen.
 * Historical expiry is allowed; the original body/deadline remains unchanged.
 */
import {dirname} from 'node:path';
import {canonical,canonicalJson,exact,hex,uuid,sha256,readRootFile,requireRootCodeTree,
  requireRootDirectory,verifyRootRecord} from './root-records.mjs';
import {BASE,BINDING,COST,SPEC,need,copy,freeze,ref,equalBinding,domainPolicy,
  transitionBody} from './root-owner-authority-protocol.mjs';

const ROOT='/opt/cop-account-safety',STATE='/var/lib/cop-account-safety';
const KEYRING='/etc/cop-account-safety/public/verification-keys.json';
const CLAIM=['owner','scope','operationId','storeIncarnation','guardStoreId','continuityEpoch',
  'protectedConfigId','datasetBindingId','runtimeBindingId','transitionIntentRef','intentRef','bodyDigest'];

function bindingValid(value) {
  return exact(value,BINDING)&&BINDING.filter(k=>!['policyGeneration','policyDigest'].includes(k)).every(k=>uuid(value[k]))&&
    Number.isSafeInteger(value.policyGeneration)&&value.policyGeneration>0&&hex(value.policyDigest);
}
function matching(payload,facts) {
  return Object.keys(facts).every(k=>canonical(payload[k])===canonical(facts[k]));
}
function policyEvidence(policy,binding,owner,read) {
  const cases=[['identityEvidenceRef','owner-identity','cop-jizda-owned-sim-preserved'],
    ['retentionEvidenceRef','owner-retention','bounded-owner-retention'],
    ['schemaEvidenceRef','owner-schema','exact-schema-reviewed','schemaFingerprint'],
    ['privilegeEvidenceRef','owner-privileges','least-privilege-reviewed','privilegeFingerprint'],
    owner==='sim_driver_measurements'?['reportPolicyRef','driver-report-policy','verified-report-inventory']:
      ['costEvidenceRef','ai-cost-policy','financial-caps-preserved']];
  for(const [field,kind,decision,pin]of cases) {
    const r=read(STATE+'/evidence/'+policy[field].recordId+'.json',kind,policy[field]),p=r.payload;
    need(exact(p,[...BASE,...BINDING,'owner','scope','decision',...(pin?['fingerprint']:[])])&&
      equalBinding(p,binding)&&p.owner===owner&&p.scope===policy.scope&&p.decision===decision&&
      (!pin||p.fingerprint===policy[pin]),'GUARD_POLICY_LINEAGE_EVIDENCE');
  }
  if(policy.transition) {
    const t=policy.transition,r=read(STATE+'/owner-transitions/'+t.operationId+'.json','owner-checkpoint-transition',t.intentRef),p=r.payload;
    need(exact(p,[...BASE,...BINDING,'owner','scope','transition'])&&equalBinding(p,binding)&&p.owner===owner&&p.scope===policy.scope&&
      canonical(p.transition)===canonical(Object.fromEntries(Object.entries(t).filter(([k])=>k!=='intentRef'))),'GUARD_POLICY_LINEAGE_TRANSITION');
  }
}
function policies(owner,binding,priorRef,currentRef,read) {
  const prior=read(STATE+'/owner-policy-history/'+priorRef.recordId+'.json','owner-policy',priorRef);
  const current=read(STATE+'/owner-policies/'+owner+'.json','owner-policy',currentRef);
  for(const r of [prior,current])need(exact(r.payload,[...BASE,'binding','policy'])&&exact(r.payload.binding,BINDING)&&
    equalBinding(r.payload.binding,binding),'GUARD_POLICY_LINEAGE_BINDING');
  const a=domainPolicy(prior.payload.policy,owner,SPEC[owner].scope),b=domainPolicy(current.payload.policy,owner,SPEC[owner].scope);
  policyEvidence(a,binding,owner,read);policyEvidence(b,binding,owner,read);
  need(a.schemaFingerprint===b.schemaFingerprint&&a.privilegeFingerprint===b.privilegeFingerprint&&a.transition,'GUARD_POLICY_LINEAGE_PINS');
  const t=a.transition;
  if(b.transition)need(b.transition.operationId!==t.operationId&&canonical(b.transition.intentRef)!==canonical(t.intentRef),'GUARD_POLICY_LINEAGE_STALE_TRANSITION');
  if(owner==='sim_driver_measurements') {
    // Initial-null is deliberately not an allowed different-policy lineage.
    need(hex(t.expectedPreviousCheckpointHash)&&t.expectedPreviousCheckpointHash===a.expectedCheckpointHash&&
      t.checkpointHash===b.expectedCheckpointHash&&t.replayReady===true&&t.retentionReviewed===true&&t.publicationFenceVerified===true&&
      t.reportProtection===b.reportProtection,'GUARD_POLICY_LINEAGE_DRIVER_CAS');
  }else {
    need(a.costPolicy===COST&&b.costPolicy===COST&&t.costPolicy===COST&&t.identityReviewed===true&&t.replayReady===true&&
      canonical(a.expectedSnapshot)===canonical({checkpointId:t.expectedCheckpointId,generation:t.expectedGeneration,operationDigest:t.operationDigest,schemaDigest:t.schemaDigest})&&
      canonical(b.expectedSnapshot)===canonical({checkpointId:t.checkpointId,generation:t.generation,operationDigest:t.operationDigest,schemaDigest:t.schemaDigest})&&
      BigInt(t.generation)===BigInt(t.expectedGeneration)+1n,'GUARD_POLICY_LINEAGE_AI_CAS');
  }
  return {a,b,t};
}

/** A necessary partial verifier. Callers cannot turn its result into authority
 * without the independent actual common lease/metadata/cohort/SQL checks. */
export function verifyOwnerPolicyLineage(input) {
  need(process.getuid?.()===0&&process.geteuid?.()===0,'ROOT_EXECUTION_REQUIRED');requireRootCodeTree(ROOT);
  need(exact(input,['owner','binding','priorRef','currentRef'])&&Object.hasOwn(SPEC,input.owner)&&bindingValid(input.binding)&&
    ref(input.priorRef)&&ref(input.currentRef)&&input.priorRef.recordId!==input.currentRef.recordId,'GUARD_POLICY_LINEAGE_INPUT');
  const {owner,binding,priorRef,currentRef}=freeze(copy(input)),keyBytes=readRootFile(KEYRING),keys=canonicalJson(keyBytes),files=new Map();
  const read=(path,kind,reference)=>{
    requireRootDirectory(dirname(path),{secret:true});
    const r=verifyRootRecord(readRootFile(path,{secret:true}),keys,kind,{historical:true});
    need(!reference||ref(reference)&&r.payload.recordId===reference.recordId&&r.digest===reference.digest,'GUARD_POLICY_LINEAGE_REFERENCE');
    const existing=files.get(path);need(!existing||existing.digest===r.digest,'GUARD_POLICY_LINEAGE_CHANGED');
    files.set(path,{path,kind,digest:r.digest});return r;
  };
  const {a,b,t}=policies(owner,binding,priorRef,currentRef,read),body=transitionBody(a,owner,binding.storeIncarnation);
  const bodyDigest=sha256(canonical(body)),facts={...binding,owner,scope:SPEC[owner].scope,operationId:t.operationId,
    transitionIntentRef:t.intentRef,bodyDigest,originalBody:body};
  const intent=read(STATE+'/checkpoint-intents/'+t.operationId+'.json','owner-checkpoint-intent'),ip=intent.payload;
  need(exact(ip,[...BASE,...Object.keys(facts)])&&ip.recordId===t.operationId&&matching(ip,facts),'GUARD_POLICY_LINEAGE_INTENT');
  const intentRef={recordId:ip.recordId,digest:intent.digest};
  const wanted={owner,scope:SPEC[owner].scope,operationId:t.operationId,storeIncarnation:binding.storeIncarnation,
    guardStoreId:binding.guardStoreId,continuityEpoch:binding.continuityEpoch,protectedConfigId:binding.protectedConfigId,
    datasetBindingId:binding.datasetBindingId,runtimeBindingId:binding.runtimeBindingId,transitionIntentRef:t.intentRef,intentRef,bodyDigest};
  const dispatch=read(STATE+'/checkpoint-dispatches/'+t.operationId+'.json','checkpoint-dispatch'),dp=dispatch.payload;
  need(exact(dp,[...BASE,...CLAIM])&&dp.recordId===t.operationId&&matching(dp,wanted),'GUARD_POLICY_LINEAGE_DISPATCH');
  const deadline=Date.parse(t.proofValidUntilUTC),intentTime=Date.parse(ip.issuedAt),dispatchTime=Date.parse(dp.issuedAt);
  need(intentTime<=dispatchTime&&intentTime<deadline&&deadline-intentTime<=30000&&dispatchTime<deadline,'GUARD_POLICY_LINEAGE_ORIGINAL_DEADLINE');
  // Re-read every actual protected file with the original trust snapshot.
  // Never reload a changed keyring or reconstruct/refresh a missing artifact.
  need(sha256(readRootFile(KEYRING))===sha256(keyBytes),'GUARD_POLICY_LINEAGE_KEYRING_CHANGED');
  for(const item of files.values()) {
    requireRootDirectory(dirname(item.path),{secret:true});
    const r=verifyRootRecord(readRootFile(item.path,{secret:true}),keys,item.kind,{historical:true});
    need(r.digest===item.digest,'GUARD_POLICY_LINEAGE_CHANGED');
  }
  need(sha256(readRootFile(KEYRING))===sha256(keyBytes),'GUARD_POLICY_LINEAGE_KEYRING_CHANGED');
  const result={contractVersion:'cop-root-owner-policy-lineage-v1',priorRef,currentRef,operationId:t.operationId,
    transitionIntentRef:t.intentRef,intentRef,dispatchRef:{recordId:dp.recordId,digest:dispatch.digest}};
  if(owner==='sim_driver_measurements')result.expectedDriverState={checkpointHash:t.checkpointHash,proofValidUntilUTC:t.proofValidUntilUTC,
    replayReady:t.replayReady,retentionReviewed:t.retentionReviewed,reportProtection:t.reportProtection,publicationFenceVerified:t.publicationFenceVerified};
  else result.expectedAiSnapshot=b.expectedSnapshot;
  return freeze(result);
}
