import {loadCleanRuntime} from '../../../packages/clean-lifecycle/runtime.mjs';
import type {CleanLifecycle} from '../../../packages/clean-lifecycle/store.mjs';
import type {Config} from './config.js';
import type {BudgetStore} from './budget.js';
import type {AccountErasureGate} from './account-erasure.js';

export async function loadCleanRouterComposition(config:Config,store:BudgetStore,env:NodeJS.ProcessEnv=process.env){
 const runtime=await loadCleanRuntime({pool:store.pool,lane:'ai',serviceToken:config.copToken,actorSecret:config.copActorSecret,
   ownerSecret:config.copActorSecret,issuer:config.accountErasureIssuer,hashResource:id=>store.hashUser('cop',id),env});
 if(!runtime)return undefined;
 if(config.accountErasureEnabled)throw new Error('CLEAN_LEGACY_COMPOSITION_CONFLICT');
 const service=runtime.options.service as CleanLifecycle;
 const gate:AccountErasureGate={async assertActive(hash,transaction){
   if(transaction)await service.assertIntake(transaction,hash);
   else await service.tx(c=>service.assertIntake(c,hash));
 }};
 store.cleanLifecycleEnabled=true;store.accountErasure=gate;
 return {...runtime,gate};
}
