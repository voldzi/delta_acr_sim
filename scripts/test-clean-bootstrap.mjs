// Actual compiled bootstrap + app factories, real owned PostgreSQL. Only local
// synthetic model/matcher fixtures; never contacts a public provider.
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const express=createRequire(new URL('../apps/ai-router-api/package.json',import.meta.url))('express');
const listen=app=>new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server))});
const close=server=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));

export async function exerciseBootstrap({lane,url,expected,root,runtime}){
 const env={SIM_CLEAN_LIFECYCLE_ENABLED:'true',SIM_CLEAN_LIFECYCLE_MODE:'isolated-clean-lifecycle-v1',SIM_CLEAN_LIFECYCLE_ENVIRONMENT_ID:expected.environmentId,SIM_CLEAN_LIFECYCLE_RESET_EPOCH:expected.resetEpoch,SIM_CLEAN_LIFECYCLE_TOKENS_NOT_BEFORE:'0'};
 const serviceToken='synthetic-service-token-'.repeat(3),actorSecret='synthetic-actor-signing-'.repeat(3),hashSecret='synthetic-hash-secret-'.repeat(3),issuer='https://identity.invalid/isolated';
 const at=new Date().toISOString(),now=Math.floor(Date.now()/1000);
 const actor=letter=>({iss:'cop',aud:'sim-clean-lifecycle-v1',sub:'cop_'+letter.repeat(43),oidcIssuer:issuer,oidcSubject:randomUUID(),resetEpoch:expected.resetEpoch,operationId:randomUUID(),requestedAt:at,iat:now,exp:now+60,jti:randomUUID(),resourceId:lane==='ai'?'cop_'+letter.repeat(43):'synthetic-contributor-'+letter.repeat(32),oidcIat:now});
 const a=actor('x'),b=actor('y');
 const sign=x=>{const payload=Buffer.from(JSON.stringify(x)).toString('base64url');return {authorization:'Bearer '+serviceToken,'content-type':'application/json','x-cop-clean-actor':payload,'x-cop-clean-actor-signature':createHmac('sha256',actorSecret).update(payload).digest('hex')}};
 const body=x=>({contractVersion:'cop-sim-user-lifecycle-v1',scope:'cop_sim_shared_identity_v1',resetEpoch:x.resetEpoch,operationId:x.operationId,requestedAt:x.requestedAt});
 const saved={...process.env};let modelServer,server,composition,store,separate,context,checks=0;
 const priorFetch=globalThis.fetch;let providerAttempts=0;
 globalThis.fetch=(input,init)=>{const target=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(!['127.0.0.1','localhost'].includes(target.hostname)){providerAttempts++;throw new Error('EXTERNAL_PROVIDER_FORBIDDEN')}return priorFetch(input,init)};
 try{
   Object.assign(process.env,env);
   let app,sendWrite,hashResource;
   if(lane==='ai'){
     const {BudgetStore}=await import('../apps/ai-router-api/dist/budget.js');
     const {PgSeparateBilling}=await import('../apps/ai-router-api/dist/separate-billing.js');
     const {loadCleanRouterComposition}=await import('../apps/ai-router-api/dist/clean-bootstrap.js');
     const {createApp}=await import('../apps/ai-router-api/dist/app.js');
     const model=express();model.use(express.json());model.post('/api/generate',(_q,r)=>r.json({response:'Synthetic fixture reply',prompt_eval_count:7,eval_count:3}));modelServer=await listen(model);
     store=new BudgetStore(url,hashSecret,{dailyMicrousd:1000000,monthlyMicrousd:10000000,perUserDailyRequests:100});
     const config={port:0,databaseUrl:url,copToken:serviceToken,simToken:'synthetic-sim-token-'.repeat(3),adminToken:'synthetic-admin-token-'.repeat(3),userHashSecret:hashSecret,openaiKey:'',externalEnabled:false,copInternalMinimizedEnabled:false,advancedEnabled:false,localUrl:'http://127.0.0.1:'+modelServer.address().port,localModel:'synthetic-fixture',economyModel:'gpt-6-luna',advancedModel:'gpt-6-sol',dailyMicrousd:1000000,monthlyMicrousd:10000000,perUserDailyRequests:100,copActorSecret:actorSecret,accountErasureIssuer:issuer,accountErasureEnabled:false};
     await assert.rejects(loadCleanRouterComposition(config,store,{...env,SIM_CLEAN_LIFECYCLE_TOKENS_NOT_BEFORE:'1'}));checks++;
     composition=await loadCleanRouterComposition(config,store,env);await store.init();composition.start();
     separate=new PgSeparateBilling(store.pool,Buffer.alloc(32,7).toString('base64'),composition.gate);separate.cleanLifecycleEnabled=!!composition;await separate.checkSchema();
     app=createApp(config,store,separate,undefined,composition.options);
     hashResource=id=>store.hashUser('cop',id);
     sendWrite=x=>({taskType:'cop_chat',dataClass:'internal',preference:'local',prompt:'Synthetic fixture only',userId:x.sub,allowExternal:false,allowPaidEscalation:false,copContext:{contractVersion:'cop-chat-context-v1',dataClass:'internal'}});
   }else{
     const {loadCleanDriverComposition}=await import('../apps/situation-data-api/dist/clean-bootstrap.js');
     const {loadConfig}=await import('../apps/situation-data-api/dist/config.js');
     const {createApp}=await import('../apps/situation-data-api/dist/app.js');
     const settings={enabled:true,revocationEnabled:true,databaseUrl:url,token:serviceToken,hashSecret,ratePerMinute:120,driverAccountErasureEnabled:false,driverAccountErasureActorSecret:actorSecret,driverAccountErasureIssuer:issuer};
     Object.assign(process.env,{DRIVER_MEASUREMENTS_ENABLED:'true',DRIVER_MEASUREMENTS_REVOCATION_ENABLED:'true',DRIVER_MEASUREMENTS_DATABASE_URL:url,DRIVER_MEASUREMENTS_COP_TOKEN:serviceToken,DRIVER_MEASUREMENTS_HASH_SECRET:hashSecret,DRIVER_ACCOUNT_ERASURE_ENABLED:'false',DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET:actorSecret,DRIVER_ACCOUNT_ERASURE_ISSUER:issuer,SITUATION_DATA_DIR:join(root,'bootstrap-data'),SITUATION_DATA_ENABLED_SOURCES:'mock'});
     await mkdir(join(root,'bootstrap-data'),{mode:0o700,recursive:true});
     await assert.rejects(loadCleanDriverComposition(settings,{...env,SIM_CLEAN_LIFECYCLE_TOKENS_NOT_BEFORE:'1'}));checks++;
     composition=await loadCleanDriverComposition(settings,env);composition.start();
     const config=await loadConfig();config.enabledSources=['mock'];config.valhallaBaseUrl=undefined;config.valhallaTrafficEnabled=false;
     const dataset='sim-routing-2026-10-17-1792195200';
     const matcher={dataset:async()=>dataset,match:async points=>({dataset,points:points.map((_p,i)=>({edgeId:'8',fraction:.1+i*.1,distanceM:2,matched:true,disconnected:false,edgeLengthM:500}))})};
     const created=await createApp(config,{cleanLifecycle:composition.options,driverMeasurements:{...composition.driverMeasurements,matcher}});app=created.app;context=created.context;
     hashResource=id=>createHmac('sha256',hashSecret).update('cop:'+id).digest('hex');
     sendWrite=x=>{const time=Date.now();return {contractVersion:'sim-driver-measurements-v1',batchId:randomUUID(),contributorIdDay:x.resourceId,contributorDay:new Date(time).toISOString().slice(0,10),vehicleClass:'passenger_car',consent:{version:'traffic-quality-v1',grantedAt:new Date(time-3600000).toISOString(),attestation:'cop-driver-consent-v1'},points:[0,1,2].map(i=>({sampleId:randomUUID(),observedAt:new Date(time-20000+i*5000).toISOString(),lat:50,lon:14+i*.0007,horizontalAccuracyM:3,speedMps:10,speedAccuracyMps:.5,headingDeg:90,headingAccuracyDeg:5,positionSource:'gps',motion:'driving',reducedAccuracy:false}))}};
   }
   server=await listen(app);const base='http://127.0.0.1:'+server.address().port;
   const request=async(method,path,data,x)=>{const r=await fetch(base+path,{method,headers:sign(x),body:data===undefined?undefined:JSON.stringify(data)});return {status:r.status,data:await r.json()}};
   const prefix=lane==='ai'?'/api/v1/ai-router/internal/user-lifecycle/v1':'/api/v1/internal/user-lifecycle/v1',write=lane==='ai'?'/api/v1/ai-router/generate':'/api/v1/internal/driver-measurements/v1/batches';
   const check=(v,label)=>{assert.ok(v,label);checks++};
   const firstBody=sendWrite(a),secondBody=sendWrite(b);
   const first=await request('POST',write,firstBody,a);check(first.status===200,`actual ${lane} first ordinary write`);
   if(lane==='driver')check(first.data.applicationMode==='shadow_only'&&first.data.acceptedIntervalCount>0,'actual driver accepted intervals, shadow only');
   check((await request('POST',write,secondBody,b)).status===200,'actual B write');
   if(lane==='ai'){
     await separate.putKey(hashResource(a.resourceId),'synthetic-not-a-real-key-a');await separate.putKey(hashResource(b.resourceId),'synthetic-not-a-real-key-b');
     check(store.cleanLifecycleEnabled===true&&separate.cleanLifecycleEnabled===true,'actual clean budget views selected');
   }
   check((await request('GET',prefix+'/capabilities',undefined,a)).status===200,'actual bootstrap readiness');
   const before=lane==='ai'?await store.usage():null;
   const billingBefore=lane==='ai'?await separate.usage():null;
   check((await request('POST',prefix+'/deletions',body(a),a)).status===202,'actual durable fence');
   check((await request('POST',write,firstBody,a)).status===503,'ordinary late write fenced');
   await composition.options.service.runOne();
   check((await request('GET',prefix+'/deletions/'+a.operationId,undefined,a)).data.state==='deleted','actual component readback');
   if(lane==='ai'){
     const after=await store.usage();const billingAfter=await separate.usage();check(billingAfter.user_openai_key.monthlyMicrousd===billingBefore.user_openai_key.monthlyMicrousd,'real separate billing reads anonymous totals');
     check(after.dailyMicrousd===before.dailyMicrousd&&after.dailyRequests===before.dailyRequests&&after.dailyInputTokens===before.dailyInputTokens,'real BudgetStore preserves cost/count/token totals after cleanup');
     check((await separate.keyStatus(hashResource(b.resourceId))).configured===true,'actual B key preserved');
     await assert.rejects(separate.keyStatus(hashResource(a.resourceId)));checks++;
     await assert.rejects(store.reserve('cop',b.sub,'cop_chat','synthetic-fixture','test','simple','local_fast',10000001));checks++;
   }else{
     check(Number((await runtime.query('SELECT count(*) AS n FROM driver_measurement_receipts WHERE contributor_hash=$1',[hashResource(a.resourceId)])).rows[0].n)===0,'actual A receipt removed');
     check(Number((await runtime.query('SELECT count(*) AS n FROM driver_measurement_receipts WHERE contributor_hash=$1',[hashResource(b.resourceId)])).rows[0].n)===1,'actual B receipt remains');
     const stored=JSON.stringify((await runtime.query('SELECT receipt FROM driver_measurement_receipts WHERE contributor_hash=$1',[hashResource(b.resourceId)])).rows[0]);check(!stored.includes('lat')&&!stored.includes('lon')&&!stored.includes(secondBody.batchId),'no raw GPS or raw batch ID persisted');
   }
   const unused=actor('z');check((await request('POST',prefix+'/deletions',body(unused),unused)).status===202,'unused actual-factory user accepted');await composition.options.service.runOne();
   check((await request('GET',prefix+'/deletions/'+unused.operationId,undefined,unused)).data.state==='deleted','unused actual-factory user completed');
   check(providerAttempts===0,'no external provider attempts');return checks;
 }finally{
   if(server)await close(server);if(modelServer)await close(modelServer);await composition?.close();if(lane==='ai')await store?.close();
   if(context?.aggregation?.close)await context.aggregation.close();
   globalThis.fetch=priorFetch;
   for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);
 }
}
