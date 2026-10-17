/** Pure synthetic configuration tests; never opens production/PG/network. */
import assert from'node:assert/strict';
import{randomUUID}from'node:crypto';
import{buildSimRootPrivatePart,selectedSimIdentityEnvironment,mergeSimRootPrivatePart,prepareSimRootPrivatePart}from'./lib/prepare-sim-root-private.mjs';
const issuer='https://login.zeleznalady.cz/realms/cop';
const env={AI_ROUTER_COP_TOKEN:'a'.repeat(43),AI_ROUTER_COP_ACTOR_SECRET:'b'.repeat(43),AI_ROUTER_USER_HASH_SECRET:'c'.repeat(43),AI_ROUTER_SIM_TOKEN:'d'.repeat(43),AI_ROUTER_ACCOUNT_ERASURE_ISSUER:issuer,DRIVER_MEASUREMENTS_COP_TOKEN:'e'.repeat(43),DRIVER_MEASUREMENTS_HASH_SECRET:'f'.repeat(43),DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET:'g'.repeat(43),DRIVER_ACCOUNT_ERASURE_ISSUER:issuer,SIM_OIDC_ISSUER:issuer,SIM_API_AUTH_MODE:'hybrid',SIM_PUBLISHER_MODE:'DRY_RUN',OPENAI_API_KEY:'synthetic-ignored-openai-key'};
const raw=e=>Buffer.from(Object.entries(e).map(([k,v])=>k+'='+v).join('\n'));
const now=Math.floor(Date.now()/1000),base={environmentBytes:raw(env),caPem:'-----BEGIN CERTIFICATE-----\nsynthetic-not-used-for-network\n-----END CERTIFICATE-----',postgresPassword:'synthetic-root-password-never-used',resetEpoch:randomUUID(),tokensNotBefore:now-1,now};
let checks=0;const check=v=>{assert.ok(v);checks++};
const part=await buildSimRootPrivatePart(base);
check(part.resetEpoch===base.resetEpoch&&part.tokensNotBefore===base.tokensNotBefore&&part.mutationPerformed===false);
check(part.enrollments.ai.userDatasetId!==part.enrollments.driver.userDatasetId&&part.enrollments.ai.enrollmentId!==part.enrollments.driver.enrollmentId);
check(part.simUserInstall.completedReplayMode==='same-epoch-completed-content-replay-v1');
check(part.generatedCanonicalIdentityFields.length===4);
check(part.simUserInstall.identities.sim_user_history.hashSecret===env.AI_ROUTER_USER_HASH_SECRET);
check(part.simUserInstall.identities.sim_user_data.routerActorSecret===part.simUserInstall.identities.sim_user_history.actorSecret);
check(part.simUserInstall.bindings.sim_user_data.guard_store_id===part.simUserInstall.bindings.sim_user_history.guard_store_id);
check(part.simUserInstall.bindings.sim_user_data.identity_sha256!==part.simUserInstall.bindings.sim_user_history.identity_sha256);
check(!JSON.stringify(part).includes(env.OPENAI_API_KEY));
check(part.connections.ai.host==='haproxy.home.cz'&&part.connections.ai.port===5000&&part.connections.ai.ssl.rejectUnauthorized===true&&part.connections.ai.password===base.postgresPassword);
check(Object.keys(part.simUserInstall.credentials).length===4&&new Set(Object.values(part.simUserInstall.credentials)).size===4);
const canonical={SIM_USER_DATA_OWNER_SECRET:'h'.repeat(43),SIM_USER_DATA_COP_TOKEN:'i'.repeat(43),SIM_USER_DATA_COP_ACTOR_SECRET:'j'.repeat(43),SIM_USER_DATA_ROUTER_ACTOR_SECRET:'k'.repeat(43)};
const preserved=await buildSimRootPrivatePart({...base,environmentBytes:raw({...env,...canonical,SIM_USER_DATA_ENABLED:'true'})});
check(preserved.generatedCanonicalIdentityFields.length===0&&preserved.simUserInstall.serviceToken===canonical.SIM_USER_DATA_COP_TOKEN&&preserved.simUserInstall.identities.sim_user_data.ownerSecret===canonical.SIM_USER_DATA_OWNER_SECRET);
for(const change of [{SIM_OIDC_ISSUER:'https://wrong.invalid'},{AI_ROUTER_COP_ACTOR_SECRET:''},{SIM_API_AUTH_MODE:'none'},{SIM_PUBLISHER_MODE:'LIVE'},{SIM_USER_DATA_ENABLED:'true'}]){await assert.rejects(buildSimRootPrivatePart({...base,environmentBytes:raw({...env,...change})}),/SIM_ROOT_PRIVATE_PREPARATION_REJECTED/);checks++;}
for(const change of [{tokensNotBefore:now+1000},{resetEpoch:'invalid'},{postgresPassword:''},{caPem:'PRIVATE KEY'}]){await assert.rejects(buildSimRootPrivatePart({...base,...change}),/SIM_ROOT_PRIVATE_PREPARATION_REJECTED/);checks++;}
assert.throws(()=>selectedSimIdentityEnvironment(raw(env).toString()+'\nAI_ROUTER_COP_TOKEN=duplicated'),/SIM_ROOT_PRIVATE_PREPARATION_REJECTED/);checks++;
check(selectedSimIdentityEnvironment("SIM_API_AUTH_MODE='hybrid'").SIM_API_AUTH_MODE==='hybrid');
const root={contractVersion:'cop-sim-clean-reset-worker-v1',resetEpoch:part.resetEpoch,tokensNotBefore:part.tokensNotBefore,connections:{cop:{database:'cop'}},reviewedPlans:{cop:{planDigest:'existing-cop-plan'}},reviewedPlanDigests:{cop:'existing-cop-plan'}};
const ready={...part,simUserInstall:{...part.simUserInstall,reviewedPlan:{planDigest:'synthetic-actual-inspection-placeholder'}},reviewedPlans:{sim_user_install:{planDigest:'synthetic-actual-inspection-placeholder'}},reviewedPlanDigests:{sim_user_install:'synthetic-actual-inspection-placeholder'}};
const merged=mergeSimRootPrivatePart(root,ready);check(merged.contractVersion===root.contractVersion&&merged.connections.cop===root.connections.cop&&merged.reviewedPlans.cop===root.reviewedPlans.cop&&merged.simUserInstall===ready.simUserInstall);
assert.throws(()=>mergeSimRootPrivatePart({...root,resetEpoch:randomUUID()},ready));checks++;
assert.throws(()=>mergeSimRootPrivatePart(root,part));checks++;
// The production reader refuses on this non-root development host before FS/PG.
if(process.getuid()!==0){await assert.rejects(prepareSimRootPrivatePart(base,{Pool:class{constructor(){throw Error('UNEXPECTED_POOL')}}}),/SIM_ROOT_PRIVATE_PREPARATION_REJECTED/);checks++;}
console.log(JSON.stringify({checks,pureSyntheticConfiguration:true,realProductionEnvironmentRead:false,actualPostgresInspection:false,productionMutations:0,providerCalls:0,wholeAccountComplete:false}));
