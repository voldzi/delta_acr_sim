/** Synthetic pure-module checks only; no database, network, Root records or
 * accepted authority is created. The main agent owns test execution. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {AiCheckpointFactsError,parseAiCheckpointRequest,aiCheckpointRequestDigest,validateAiCheckpointFacts,matchAiCheckpointPolicy} from './checkpoint-facts.mjs';
const h=c=>c.repeat(64),id='10000000-0000-4000-8000-000000000031',store='20000000-0000-4000-8000-000000000031';
const now=Date.parse('2026-10-15T12:00:00.000Z');
const request=()=>({owner:'sim_ai_router',scope:'cop_router_primary_database',purpose:'checkpoint',expectedSnapshot:{checkpointId:id,generation:'42',operationDigest:h('a'),schemaDigest:h('b')}});
const expected=()=>({storeIncarnation:store,schemaFingerprint:h('c'),privilegeFingerprint:h('d'),costPolicy:'aggregate-costs-current-month-v1'});
const facts=()=>({contractVersion:'sim-ai-checkpoint-facts-v1',request:request(),observedAtUTC:new Date(now).toISOString(),storeIncarnation:store,
  checkpoint:{identity_reviewed:true,replay_ready:true,cost_policy:'aggregate-costs-current-month-v1',checkpoint_id:id,checkpoint_generation:'42',operation_digest:h('a'),schema_digest:h('b')},
  snapshotMatches:true,schema:{ready:true,fingerprint:h('c')},permissions:{runtimeProfileMatches:true,fingerprint:h('d')},
  invariants:{rlsEnabled:true,fencesReady:true,financialViewsReady:true,costRetentionReady:true}});
const unavailable=fn=>assert.throws(fn,error=>error instanceof AiCheckpointFactsError&&error.message==='AI_ROUTER_CHECKPOINT_UNAVAILABLE');

test('exact request is copied/deep-frozen and digest sorts both fixed object levels',()=>{
  const r=request(),parsed=parseAiCheckpointRequest(r);r.expectedSnapshot.generation='43';assert.equal(parsed.expectedSnapshot.generation,'42');
  assert.ok(Object.isFrozen(parsed)&&Object.isFrozen(parsed.expectedSnapshot));
  const reordered={scope:parsed.scope,purpose:parsed.purpose,owner:parsed.owner,expectedSnapshot:{schemaDigest:h('b'),operationDigest:h('a'),generation:'42',checkpointId:id}};
  assert.equal(aiCheckpointRequestDigest(reordered),aiCheckpointRequestDigest(parsed));
  const canonical=JSON.stringify({expectedSnapshot:{checkpointId:id,generation:'42',operationDigest:h('a'),schemaDigest:h('b')},owner:'sim_ai_router',purpose:'checkpoint',scope:'cop_router_primary_database'});
  assert.equal(aiCheckpointRequestDigest(parsed),createHash('sha256').update(canonical).digest('hex'));
});
test('unknown keys, identities, arbitrary purposes and extra snapshot selectors are rejected',()=>{
  for(const r of [null,[],{}, {...request(),owner:'ai_router'},{...request(),scope:'all'},{...request(),purpose:'erase'},
    {...request(),sql:'SELECT anything'},{...request(),expectedSnapshot:{...request().expectedSnapshot,accountId:'forbidden'}}])unavailable(()=>parseAiCheckpointRequest(r));
});
test('accessors, proxies, symbols and inherited shapes are rejected without invoking getters',()=>{
  let calls=0;const accessor=Object.defineProperty({...request()},'purpose',{enumerable:true,get(){calls++;throw new Error('getter');}});
  for(const r of [accessor,new Proxy(request(),{}),Object.assign(Object.create({}),request()),{...request(),[Symbol('extra')]:true}])unavailable(()=>parseAiCheckpointRequest(r));
  const nested={...request(),expectedSnapshot:Object.defineProperty({...request().expectedSnapshot},'generation',{enumerable:true,get(){calls++;return '42';}})};
  unavailable(()=>parseAiCheckpointRequest(nested));assert.equal(calls,0);
});
test('generation is exact bounded PostgreSQL bigint decimal text, never a JS number',()=>{
  for(const generation of ['0','9223372036854775807'])assert.equal(parseAiCheckpointRequest({...request(),expectedSnapshot:{...request().expectedSnapshot,generation}}).expectedSnapshot.generation,generation);
  for(const generation of [42,'-1','01','1.0','1e3','9223372036854775808','9'.repeat(100)])unavailable(()=>parseAiCheckpointRequest({...request(),expectedSnapshot:{...request().expectedSnapshot,generation}}));
});
test('only exact canonical UUID/digests and correlated facts are accepted',()=>{
  const f=facts();assert.deepEqual(validateAiCheckpointFacts(f,request()),f);
  for(const field of ['checkpointId','operationDigest','schemaDigest']){
    const r=request();r.expectedSnapshot[field]='INVALID';unavailable(()=>parseAiCheckpointRequest(r));
  }
  unavailable(()=>validateAiCheckpointFacts({...f,request:{...request(),expectedSnapshot:{...request().expectedSnapshot,generation:'43'}}},request()));
  unavailable(()=>validateAiCheckpointFacts({...f,extra:'private context'},request()));
  unavailable(()=>validateAiCheckpointFacts({...f,checkpoint:{...f.checkpoint,owner_hash:h('e')}},request()));
});
test('null/unbound and mismatched checkpoints remain facts, never necessary-ready',()=>{
  const missing={...facts(),checkpoint:null,snapshotMatches:false,storeIncarnation:null};assert.deepEqual(validateAiCheckpointFacts(missing,request()),missing);
  unavailable(()=>matchAiCheckpointPolicy(missing,request(),expected(),now));
  const mismatch=facts();mismatch.checkpoint.checkpoint_generation='43';mismatch.snapshotMatches=false;validateAiCheckpointFacts(mismatch,request());
  unavailable(()=>matchAiCheckpointPolicy(mismatch,request(),expected(),now));
});
test('snapshotMatches is recomputed rather than trusted from database flags',()=>{
  unavailable(()=>validateAiCheckpointFacts({...facts(),snapshotMatches:false},request()));
  const altered=facts();altered.checkpoint.operation_digest=h('e');unavailable(()=>validateAiCheckpointFacts(altered,request()));
});
test('canonical finite UTC observations and strict five-second freshness are enforced',()=>{
  for(const observedAtUTC of ['2026-10-15T12:00:00Z','2026-10-15T12:00:00.000+00:00','invalid','2026-02-31T12:00:00.000Z'])unavailable(()=>validateAiCheckpointFacts({...facts(),observedAtUTC},request()));
  matchAiCheckpointPolicy({...facts(),observedAtUTC:new Date(now-5000).toISOString()},request(),expected(),now);
  for(const observedAtUTC of [new Date(now-5001).toISOString(),new Date(now+1).toISOString()])unavailable(()=>matchAiCheckpointPolicy({...facts(),observedAtUTC},request(),expected(),now));
  unavailable(()=>matchAiCheckpointPolicy(facts(),request(),expected(),Number.NaN));
});
test('each actual invariant, schema/permission state and reviewed policy is independently required',()=>{
  matchAiCheckpointPolicy(facts(),request(),expected(),now);
  for(const name of Object.keys(facts().invariants)){const f=facts();f.invariants[name]=false;unavailable(()=>matchAiCheckpointPolicy(f,request(),expected(),now));}
  for(const key of ['identity_reviewed','replay_ready']){const f=facts();f.checkpoint[key]=false;unavailable(()=>matchAiCheckpointPolicy(f,request(),expected(),now));}
  for(const f of [{...facts(),schema:{ready:false,fingerprint:h('c')}},{...facts(),permissions:{runtimeProfileMatches:false,fingerprint:h('d')}}])unavailable(()=>matchAiCheckpointPolicy(f,request(),expected(),now));
  const pending=facts();pending.checkpoint.cost_policy='pending_requires_review';unavailable(()=>matchAiCheckpointPolicy(pending,request(),expected(),now));
});
test('independent store/schema/privilege/cost-policy pins cannot be substituted or expanded',()=>{
  for(const [field,value] of [['storeIncarnation','20000000-0000-4000-8000-000000000032'],['schemaFingerprint',h('e')],['privilegeFingerprint',h('e')],['costPolicy','pending_requires_review']])
    unavailable(()=>matchAiCheckpointPolicy(facts(),request(),{...expected(),[field]:value},now));
  unavailable(()=>matchAiCheckpointPolicy(facts(),request(),{...expected(),authority:true},now));
  const result=matchAiCheckpointPolicy(facts(),request(),expected(),now);assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.checkpoint)&&Object.isFrozen(result.request.expectedSnapshot));
  assert.equal(Object.hasOwn(result,'authority'),false);assert.equal(Object.hasOwn(result,'admission'),false);
});
