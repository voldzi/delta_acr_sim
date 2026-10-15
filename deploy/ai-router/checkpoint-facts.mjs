/** Pure bounded target-observation checks, NOT a Root verifier, admission
 * producer, SQL connector, signer or positive authority callback. */
import {createHash} from 'node:crypto';
import {types} from 'node:util';

export class AiCheckpointFactsError extends Error {
  constructor(){super('AI_ROUTER_CHECKPOINT_UNAVAILABLE');this.name='AiCheckpointFactsError';}
}
const need=value=>{if(!value)throw new AiCheckpointFactsError();};
const hex=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const generation=value=>typeof value==='string'&&/^(?:0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n;
const policies=['pending_requires_review','aggregate-costs-current-month-v1'];
function exact(value,names){
  if(!value||typeof value!=='object'||Array.isArray(value)||types.isProxy(value))return false;
  const proto=Object.getPrototypeOf(value);if(proto!==null&&proto!==Object.prototype)return false;
  const keys=Reflect.ownKeys(value);
  return keys.length===names.length&&names.every(name=>keys.includes(name))&&keys.every(name=>{
    const d=Object.getOwnPropertyDescriptor(value,name);return typeof name==='string'&&d?.enumerable&&'value' in d;
  });
}
function stamp(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))return false;
  const time=Date.parse(value);return Number.isFinite(time)&&new Date(time).toISOString()===value;
}
function freeze(value){
  if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;
}
const snapshot=value=>freeze(structuredClone(value));
export function parseAiCheckpointRequest(value){
  need(exact(value,['owner','scope','purpose','expectedSnapshot']));
  need(value.owner==='sim_ai_router'&&value.scope==='cop_router_primary_database'&&value.purpose==='checkpoint');
  const expected=value.expectedSnapshot;
  need(exact(expected,['checkpointId','generation','operationDigest','schemaDigest']));
  need(uuid(expected.checkpointId)&&generation(expected.generation)&&hex(expected.operationDigest)&&hex(expected.schemaDigest));
  return snapshot(value);
}
/** Sorted canonical request JSON only. SQL operation/schema/catalog digests
 * retain their own existing PostgreSQL byte rules and are not recomputed here. */
export function aiCheckpointRequestDigest(value){
  const r=parseAiCheckpointRequest(value),s=r.expectedSnapshot;
  return createHash('sha256').update(JSON.stringify({expectedSnapshot:{checkpointId:s.checkpointId,generation:s.generation,
    operationDigest:s.operationDigest,schemaDigest:s.schemaDigest},owner:r.owner,purpose:r.purpose,scope:r.scope})).digest('hex');
}
export function validateAiCheckpointFacts(value,expectedRequest){
  const request=parseAiCheckpointRequest(expectedRequest);
  need(exact(value,['contractVersion','request','observedAtUTC','storeIncarnation','checkpoint','snapshotMatches','schema','permissions','invariants']));
  need(value.contractVersion==='sim-ai-checkpoint-facts-v1'&&stamp(value.observedAtUTC));
  need(aiCheckpointRequestDigest(value.request)===aiCheckpointRequestDigest(request));
  need(value.storeIncarnation===null||uuid(value.storeIncarnation));
  const cp=value.checkpoint;
  if(cp!==null){
    need(exact(cp,['identity_reviewed','replay_ready','cost_policy','checkpoint_id','checkpoint_generation','operation_digest','schema_digest']));
    need(typeof cp.identity_reviewed==='boolean'&&typeof cp.replay_ready==='boolean'&&policies.includes(cp.cost_policy)&&uuid(cp.checkpoint_id)&&
      generation(cp.checkpoint_generation)&&hex(cp.operation_digest)&&hex(cp.schema_digest));
  }
  need(typeof value.snapshotMatches==='boolean');
  const expected=request.expectedSnapshot;
  need(value.snapshotMatches===(cp!==null&&cp.checkpoint_id===expected.checkpointId&&cp.checkpoint_generation===expected.generation&&
    cp.operation_digest===expected.operationDigest&&cp.schema_digest===expected.schemaDigest));
  need(exact(value.schema,['ready','fingerprint'])&&typeof value.schema.ready==='boolean'&&hex(value.schema.fingerprint));
  need(exact(value.permissions,['runtimeProfileMatches','fingerprint'])&&typeof value.permissions.runtimeProfileMatches==='boolean'&&hex(value.permissions.fingerprint));
  need(exact(value.invariants,['rlsEnabled','fencesReady','financialViewsReady','costRetentionReady']));
  for(const key of ['rlsEnabled','fencesReady','financialViewsReady','costRetentionReady'])need(typeof value.invariants[key]==='boolean');
  return snapshot(value);
}
/** Necessary target facts only. All expected values must come from current,
 * independently verified Root policy/enrollment. This does not verify a permit,
 * signature, kernel peer, registry/frontier, generation lease or restore. */
export function matchAiCheckpointPolicy(facts,request,expected,now=Date.now()){
  const checked=validateAiCheckpointFacts(facts,request);
  need(exact(expected,['storeIncarnation','schemaFingerprint','privilegeFingerprint','costPolicy']));
  need(uuid(expected.storeIncarnation)&&hex(expected.schemaFingerprint)&&hex(expected.privilegeFingerprint)&&expected.costPolicy==='aggregate-costs-current-month-v1');
  need(Number.isFinite(now)&&Date.parse(checked.observedAtUTC)<=now&&now-Date.parse(checked.observedAtUTC)<=5000);
  need(checked.storeIncarnation===expected.storeIncarnation&&checked.checkpoint!==null&&checked.snapshotMatches&&
    checked.checkpoint.identity_reviewed&&checked.checkpoint.replay_ready&&checked.checkpoint.cost_policy===expected.costPolicy&&
    checked.schema.ready&&checked.schema.fingerprint===expected.schemaFingerprint&&checked.permissions.runtimeProfileMatches&&
    checked.permissions.fingerprint===expected.privilegeFingerprint&&Object.values(checked.invariants).every(value=>value===true));
  return checked;
}
