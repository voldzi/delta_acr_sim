/** Synthetic orchestration only; no production environment or provider access. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {assembleInspectedCommonConfig,prepareCommonRootPrivateConfig,COMMON_COP_SOURCE} from './lib/prepare-common-root-private.mjs';
const epoch=randomUUID(),cutoff=1234,d='a'.repeat(64),secret='synthetic-only-private-value';
const root={contractVersion:'cop-sim-clean-reset-worker-v1',phase:'inspect',resetEpoch:epoch,tokensNotBefore:cutoff,connections:{cop:{database:'cop',password:secret}},keycloak:{clientSecret:secret}};
const plan={planDigest:d};
const part={contractVersion:'sim-root-private-part-v1',resetEpoch:epoch,tokensNotBefore:cutoff,connections:{ai:{database:'sim_ai_router'},driver:{database:'sim_driver_measurements'}},enrollments:{ai:{resetEpoch:epoch},driver:{resetEpoch:epoch}},simUserInstall:{reviewedPlan:plan},reviewedPlans:{sim_user_install:plan},reviewedPlanDigests:{sim_user_install:d}};
const calls=[],inspectors=Object.fromEntries(['cop','ai','driver','files','sim_app_files','keycloak'].map(n=>[n,async()=>{calls.push(n);return n==='keycloak'?{inventoryDigest:d}:{planDigest:d};}]));
const x=await assembleInspectedCommonConfig(root,part,inspectors);
let checks=0;const check=v=>{assert.ok(v);checks++};
check(calls.join(',')==='cop,ai,driver,files,sim_app_files,keycloak');
check(Object.keys(x.privateConfig.reviewedPlans).length===7);
check(x.privateConfig.connections.cop===root.connections.cop&&x.privateConfig.keycloak===root.keycloak);
check(x.privateConfig.simUserInstall===part.simUserInstall);
check(!JSON.stringify(x.publicSummary).includes(secret));
check(x.publicSummary.completeForFreeze===false&&x.publicSummary.mutationPerformed===false);
check(x.publicSummary.missingPlans.join(',')==='cop_safety_install,messaging,media,edge');
check(COMMON_COP_SOURCE==='/srv/x5-production/staging/cop/clean-operator-2e61857/app');
for(const changed of [{phase:'apply'},{resetEpoch:randomUUID()},{reviewedPlans:{}},{reviewedPlanDigests:{}},{contractVersion:'wrong'}]){await assert.rejects(assembleInspectedCommonConfig({...root,...changed},part,inspectors));checks++;}
await assert.rejects(assembleInspectedCommonConfig(root,part,{...inspectors,ai:async()=>({planDigest:'placeholder'})}));checks++;
await assert.rejects(assembleInspectedCommonConfig(root,part,{...inspectors,keycloak:async()=>({planDigest:d})}));checks++;
await assert.rejects(assembleInspectedCommonConfig(root,part,{...inspectors,driver:async()=>{throw Error('SYNTHETIC_DB_DOWN')}}),/SYNTHETIC_DB_DOWN/);checks++;
if(process.getuid()!==0){await assert.rejects(prepareCommonRootPrivateConfig({}),/COMMON_ROOT_PREPARATION_REJECTED/);checks++;}
const source=await readFile(new URL('./lib/prepare-common-root-private.mjs',import.meta.url),'utf8');
for(const bad of ['applyReset(','.apply(','.writeFile(','.spawn(','.stop(','.freeze_reviewed(']){check(!source.includes(bad));}
check(source.includes('default_transaction_read_only=on'));
console.log(JSON.stringify({checks,syntheticAdaptersOnly:true,productionFactoryExecuted:false,productionMutations:0,wholeAccountComplete:false}));
