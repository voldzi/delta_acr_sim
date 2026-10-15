/** Pure exact wire checks for the fixed Root owner authority; never authority. */
import {canonical, exact, hex, uuid, requireGuard} from './root-records.mjs';
import {parseDriverReadRequest, driverReadRequestDigest} from './read-admission-facts.mjs';
import {parseAiCheckpointRequest, aiCheckpointRequestDigest} from './checkpoint-facts.mjs';

export const BASE = ['contractVersion','kind','recordId','issuedAt','expiresAt'];
export const BINDING = ['guardStoreId','continuityEpoch','protectedConfigId','datasetBindingId','runtimeBindingId','policyGeneration','policyDigest','storeIncarnation'];
export const LIVE = ['guardStoreId','continuityEpoch','datasetBindingId','runtimeBindingId','sourceProofId','storeIncarnation','policyGeneration','frontierSequence','frontierDigest'];
export const READ_BINDING = ['readPermitId','requestDigest','owner','scope',...LIVE];
export const COST = 'aggregate-costs-current-month-v1';
export const DRIVER_DECISIONS = Object.freeze({'driver-read-identity':'cop-jizda-owned-sim-preserved','driver-read-retention':'bounded-read-permitted',
  'driver-read-report':'verified-report-inventory','driver-read-schema':'exact-read-facts-policy-verified'});
export const AI_DECISIONS = Object.freeze({'ai-router-read-identity':'sim-preserved-cop-owned','ai-router-read-retention':COST,
  'ai-router-read-cost':'financial-caps-preserved','ai-router-read-schema':'exact-checkpoint-policy-verified'});
export const SPEC = Object.freeze({sim_driver_measurements:{scope:'online_driver_scope',directory:'clients',registration:'driver-client-registration',
  projection:'cop-sim-driver-projection-v1',profile:'driver-control',database:'sim_driver_measurements',user:'sim_driver_guard_control',
  facts:'SELECT sim_driver_guard_source.read_admission_facts($1::jsonb) AS value'},
sim_ai_router:{scope:'cop_router_primary_database',directory:'ai-clients',registration:'ai-router-client-registration',
  projection:'cop-sim-ai-projection-v1',profile:'ai-router-control',database:'sim_ai_router',user:'sim_ai_guard_control',
  facts:'SELECT sim_ai_guard_source.read_checkpoint_facts($1::jsonb) AS value'}});
export const need = (value, code='GUARD_OWNER_BINDING') => requireGuard(value, code);
export const copy = value => JSON.parse(canonical(value));
export function freeze(value) {if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
export const ref = value => exact(value,['recordId','digest'])&&uuid(value.recordId)&&hex(value.digest);
export const stamp = value => typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)&&
  Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
export const peerValid = value => exact(value,['device','inode','uid','gid'])&&typeof value.device==='string'&&/^[0-9]{1,20}$/.test(value.device)&&
  typeof value.inode==='string'&&/^[0-9]{1,20}$/.test(value.inode)&&value.inode!=='0'&&Number.isSafeInteger(value.uid)&&value.uid>=0&&Number.isSafeInteger(value.gid)&&value.gid>=0;
export const equalBinding = (value,binding) => BINDING.every(k=>value[k]===binding[k]);
const generation = value => typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n;
const protection = value => ['no_report','enforced_single_writer','shared_generation_fence'].includes(value);
export function domainPolicy(value,owner,scope) {
  const common=['contractVersion','owner','scope','identityEvidenceRef','retentionEvidenceRef','schemaEvidenceRef','privilegeEvidenceRef','schemaFingerprint','privilegeFingerprint'];
  const keys=owner==='sim_driver_measurements'?[...common,'expectedCheckpointHash','reportProtection','reportPolicyRef']:[...common,'costPolicy','costEvidenceRef','expectedSnapshot'];
  need((exact(value,keys)||exact(value,[...keys,'transition']))&&value.contractVersion==='cop-root-owner-policy-v1'&&value.owner===owner&&value.scope===scope&&
    hex(value.schemaFingerprint)&&hex(value.privilegeFingerprint)&&['identityEvidenceRef','retentionEvidenceRef','schemaEvidenceRef','privilegeEvidenceRef'].every(k=>ref(value[k])));
  if(owner==='sim_driver_measurements')need(hex(value.expectedCheckpointHash)&&protection(value.reportProtection)&&ref(value.reportPolicyRef));
  else {need(value.costPolicy===COST&&ref(value.costEvidenceRef));parseAiCheckpointRequest({owner,scope,purpose:'checkpoint',expectedSnapshot:value.expectedSnapshot});}
  if(Object.hasOwn(value,'transition')) {
    const t=value.transition, driver=owner==='sim_driver_measurements';
    need(exact(t,driver?['contractVersion','intentRef','operationId','expectedPreviousCheckpointHash','checkpointHash','proofValidUntilUTC','replayReady','retentionReviewed','reportProtection','publicationFenceVerified']:
      ['contractVersion','intentRef','operationId','expectedCheckpointId','expectedGeneration','checkpointId','generation','operationDigest','schemaDigest','identityReviewed','replayReady','costPolicy','proofValidUntilUTC'])&&
      ref(t.intentRef)&&uuid(t.operationId)&&stamp(t.proofValidUntilUTC));
    if(driver)need(t.contractVersion==='cop-root-driver-checkpoint-transition-v1'&&(t.expectedPreviousCheckpointHash===null||hex(t.expectedPreviousCheckpointHash)&&t.expectedPreviousCheckpointHash===value.expectedCheckpointHash)&&
      hex(t.checkpointHash)&&['replayReady','retentionReviewed','publicationFenceVerified'].every(k=>typeof t[k]==='boolean')&&
      (t.replayReady&&t.retentionReviewed&&t.publicationFenceVerified&&protection(t.reportProtection)||!t.replayReady&&!t.retentionReviewed&&!t.publicationFenceVerified&&t.reportProtection==='unverified'));
    else need(t.contractVersion==='cop-root-ai-checkpoint-transition-v1'&&uuid(t.expectedCheckpointId)&&uuid(t.checkpointId)&&generation(t.expectedGeneration)&&generation(t.generation)&&
      BigInt(t.expectedGeneration)<9223372036854775807n&&BigInt(t.generation)===BigInt(t.expectedGeneration)+1n&&hex(t.operationDigest)&&hex(t.schemaDigest)&&
      typeof t.identityReviewed==='boolean'&&typeof t.replayReady==='boolean'&&
      (t.identityReviewed&&t.replayReady&&t.costPolicy===COST||!t.identityReviewed&&!t.replayReady&&t.costPolicy==='pending_requires_review')&&
      canonical(value.expectedSnapshot)===canonical({checkpointId:t.expectedCheckpointId,generation:t.expectedGeneration,operationDigest:t.operationDigest,schemaDigest:t.schemaDigest}));
  }
  return freeze(copy(value));
}
export function observation(value,owner) {
  need(exact(value,['contractVersion','owner','observedAtUTC','machineBootId','dockerContainerId','imageId','sourceRevision','configurationDigest','readOnlyRootfs','peer','startTicks','executableDigest','broker'])&&
    value.contractVersion==='cop-root-host-observation-v1'&&value.owner===owner&&stamp(value.observedAtUTC)&&uuid(value.machineBootId)&&hex(value.dockerContainerId)&&
    /^sha256:[0-9a-f]{64}$/.test(value.imageId)&&/^[0-9a-f]{40}$/.test(value.sourceRevision)&&hex(value.configurationDigest)&&value.readOnlyRootfs===true&&peerValid(value.peer)&&
    typeof value.startTicks==='string'&&/^[0-9]{1,20}$/.test(value.startTicks)&&hex(value.executableDigest));
  const b=value.broker;
  need(exact(b,['dockerContainerId','imageId','configurationDigest','peer','startTicks','executableDigest'])&&hex(b.dockerContainerId)&&/^sha256:[0-9a-f]{64}$/.test(b.imageId)&&
    hex(b.configurationDigest)&&peerValid(b.peer)&&typeof b.startTicks==='string'&&/^[0-9]{1,20}$/.test(b.startTicks)&&hex(b.executableDigest)&&BigInt(value.startTicks)>BigInt(b.startTicks));
  return freeze(copy(value));
}
export function transitionBody(policy,owner,store) {
  const t=policy.transition;need(t,'GUARD_OWNER_TRANSITION_REQUIRED');
  return freeze(owner==='sim_driver_measurements'?{contractVersion:'sim-driver-root-checkpoint-v1',owner,scope:policy.scope,storeIncarnation:store,
    expectedPreviousCheckpointHash:t.expectedPreviousCheckpointHash,checkpointHash:t.checkpointHash,proofValidUntilUTC:t.proofValidUntilUTC,
    replayReady:t.replayReady,retentionReviewed:t.retentionReviewed,reportProtection:t.reportProtection,publicationFenceVerified:t.publicationFenceVerified}:
    {contractVersion:'sim-ai-root-checkpoint-v1',owner,scope:policy.scope,storeIncarnation:store,expectedCheckpointId:t.expectedCheckpointId,expectedGeneration:t.expectedGeneration,
      checkpointId:t.checkpointId,generation:t.generation,proofValidUntilUTC:t.proofValidUntilUTC,identityReviewed:t.identityReviewed,replayReady:t.replayReady,costPolicy:t.costPolicy});
}
export function readFactsShape(kind,facts,ctx,recordId) {
  const driver=ctx.owner==='sim_driver_measurements', decisions=driver?DRIVER_DECISIONS:AI_DECISIONS;
  if(Object.hasOwn(decisions,kind)||kind==='driver-report-inventory') {
    const extra=kind==='driver-report-inventory'?['reportProtection','checkpointHash','schemaFingerprint','privilegeFingerprint','decision']:driver?['decision']:['costPolicy','decision'];
    need(exact(facts,[...READ_BINDING,...extra])&&uuid(facts.readPermitId)&&hex(facts.requestDigest)&&facts.owner===ctx.owner&&facts.scope===ctx.scope&&LIVE.every(k=>facts[k]===ctx[k]));
    if(kind==='driver-report-inventory')need(driver&&facts.reportProtection===ctx.rootPolicy.reportProtection&&facts.checkpointHash===ctx.rootPolicy.expectedCheckpointHash&&
      facts.schemaFingerprint===ctx.rootPolicy.schemaFingerprint&&facts.privilegeFingerprint===ctx.rootPolicy.privilegeFingerprint&&
      facts.decision===(facts.reportProtection==='no_report'?'verified-no-derived-publication':'verified-derived-barrier'));
    else need(facts.decision===decisions[kind]&&(driver||facts.costPolicy===COST));
    return {directory:'read-evidence',bound:Object.fromEntries(READ_BINDING.map(k=>[k,facts[k]]))};
  }
  need(kind===(driver?'driver-read-permit':'ai-router-read-permit'));
  const extra=driver?['expectedCheckpointHash','reportProtection','reportInventoryRef']:['costPolicy'];
  need(exact(facts,['request','requestDigest',...LIVE,'expectedSchemaFingerprint','expectedPrivilegeFingerprint',...extra,'evidence'])&&LIVE.every(k=>facts[k]===ctx[k])&&
    facts.expectedSchemaFingerprint===ctx.rootPolicy.schemaFingerprint&&facts.expectedPrivilegeFingerprint===ctx.rootPolicy.privilegeFingerprint);
  const request=driver?parseDriverReadRequest(facts.request):parseAiCheckpointRequest(facts.request);
  need(facts.requestDigest===(driver?driverReadRequestDigest(request):aiCheckpointRequestDigest(request))&&exact(facts.evidence,Object.keys(decisions))&&Object.values(facts.evidence).every(ref));
  if(driver)need(facts.expectedCheckpointHash===ctx.rootPolicy.expectedCheckpointHash&&facts.reportProtection===ctx.rootPolicy.reportProtection&&ref(facts.reportInventoryRef));
  else need(facts.costPolicy===COST&&canonical(request.expectedSnapshot)===canonical(ctx.rootPolicy.expectedSnapshot));
  return {directory:driver?'read-permits':'ai-read-permits',bound:{readPermitId:recordId,requestDigest:facts.requestDigest,owner:ctx.owner,scope:ctx.scope,...Object.fromEntries(LIVE.map(k=>[k,ctx[k]]))}};
}
