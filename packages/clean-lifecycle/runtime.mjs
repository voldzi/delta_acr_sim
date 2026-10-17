import {CleanLifecycle} from './store.mjs';
export async function loadCleanRuntime({pool,lane,serviceToken,actorSecret,ownerSecret,issuer,hashResource,env=process.env}) {
 if(env.SIM_CLEAN_LIFECYCLE_ENABLED===undefined||env.SIM_CLEAN_LIFECYCLE_ENABLED==='false')return undefined;
 if(env.SIM_CLEAN_LIFECYCLE_ENABLED!=='true')throw new Error('INVALID_CLEAN_ENABLED');
 const expected={mode:env.SIM_CLEAN_LIFECYCLE_MODE,environmentId:env.SIM_CLEAN_LIFECYCLE_ENVIRONMENT_ID,resetEpoch:env.SIM_CLEAN_LIFECYCLE_RESET_EPOCH,lane,userDatasetId:env.SIM_CLEAN_LIFECYCLE_USER_DATASET_ID,enrollmentId:env.SIM_CLEAN_LIFECYCLE_PRODUCTION_ENROLLMENT_ID};
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
 const tokensNotBefore=Number(env.SIM_CLEAN_LIFECYCLE_TOKENS_NOT_BEFORE);
 expected.tokensNotBefore=tokensNotBefore;
 if(!['isolated-clean-lifecycle-v1','production-clean-lifecycle-v1'].includes(expected.mode)||!uuid.test(expected.environmentId??'')||!uuid.test(expected.resetEpoch??'')
 ||!Number.isSafeInteger(tokensNotBefore)||tokensNotBefore<0||![serviceToken,actorSecret,ownerSecret].every(x=>typeof x==='string'&&x.length>=32)||!issuer||typeof hashResource!=='function')throw new Error('INVALID_CLEAN_CONFIGURATION');
 if(expected.mode==='production-clean-lifecycle-v1'&&(!uuid.test(expected.userDatasetId??'')||!uuid.test(expected.enrollmentId??'')||tokensNotBefore<=0||tokensNotBefore>Math.floor(Date.now()/1000)))throw new Error('INVALID_PRODUCTION_CLEAN_CONFIGURATION');
 const service=new CleanLifecycle(pool,expected);
 await service.tx(async c=>{await c.query('SELECT owner_key FROM sim_clean.account LIMIT 0');await c.query('SELECT operation_id FROM sim_clean.job LIMIT 0');if(lane==='ai')await c.query('SELECT record_count FROM sim_clean.router_usage LIMIT 0')});
 if(!await service.capability())throw new Error('CLEAN_DATABASE_NOT_READY');
 let running,timer,stopped=false,healthy=false;
 const options={enabled:true,expected,serviceToken,actorSecret,ownerSecret,issuer,hashResource,tokensNotBefore,service,workerReady:()=>healthy&&!stopped};
 return {options,start(){
   if(timer)return;healthy=true;
   timer=setInterval(()=>{if(stopped||running)return;running=(async()=>{await service.runOne();await service.purgeExpiredTotals();healthy=true})().catch(()=>{healthy=false}).finally(()=>{running=undefined})},15000);timer.unref();
 },async close(){stopped=true;if(timer)clearInterval(timer);await running;}};
}
