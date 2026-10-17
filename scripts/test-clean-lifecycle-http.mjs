import assert from 'node:assert/strict';
import {createHmac,createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {registerCleanLifecycle} from '../packages/clean-lifecycle/http.mjs';
const express=createRequire(new URL('../apps/ai-router-api/package.json',import.meta.url))('express');
export async function exerciseHttp(service,runtime,lane,expected) {
 const options={enabled:true,tokensNotBefore:0,workerReady:()=>true,serviceToken:'fixture-service-'.repeat(4),actorSecret:'fixture-signing-'.repeat(4),ownerSecret:'fixture-owner-'.repeat(4),issuer:'https://identity.invalid/isolated',expected:{...expected,mode:'isolated-clean-lifecycle-v1'},service,hashResource:r=>createHash('sha256').update('synthetic:'+r).digest('hex')};
 const app=express();app.use(express.json({limit:'32kb'}));const worker=registerCleanLifecycle(app,options);
 const path=lane==='ai'?'/api/v1/ai-router/generate':'/api/v1/internal/driver-measurements/v1/batches';
 const prefix=lane==='ai'?'/api/v1/ai-router/internal/user-lifecycle/v1':'/api/v1/internal/user-lifecycle/v1';
 app.post(path,async(req,res)=>{
   try{const h=options.hashResource(lane==='ai'?req.body.userId:req.body.contributorIdDay);
    if(lane==='ai')await runtime.query("INSERT INTO ai_router_request(id,client_id,user_hash,task_type,model,routing_reason,difficulty,status,reserved_microusd,charged_microusd) VALUES($1,'cop',$2,'cop_chat','fixture','fixture','simple','success',10,2)",[randomUUID(),h]);
    else await runtime.query("INSERT INTO driver_measurement_receipts VALUES('cop',$1,$2,$3,now(),now()+interval '7 days','{}')",[randomUUID(),h,createHash('sha256').update('fixture').digest('hex')]);
    res.status(201).json({ok:true});
   }catch{res.status(503).json({error:'WRITE_FAILED'})}
 });
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
 const base='http://127.0.0.1:'+server.address().port;
 const a={oidcIat:Math.floor(Date.now()/1000),iss:'cop',aud:'sim-clean-lifecycle-v1',sub:'cop_'+'a'.repeat(43),oidcIssuer:options.issuer,oidcSubject:randomUUID(),resetEpoch:expected.resetEpoch,operationId:randomUUID(),requestedAt:new Date().toISOString(),iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+60,jti:randomUUID(),resourceId:lane==='ai'?'cop_'+'a'.repeat(43):'fixture-contributor-'+'a'.repeat(32)};
 const sign=x=>{const encoded=Buffer.from(JSON.stringify(x)).toString('base64url');return {'authorization':'Bearer '+options.serviceToken,'x-cop-clean-actor':encoded,'x-cop-clean-actor-signature':createHmac('sha256',options.actorSecret).update(encoded).digest('hex'),'content-type':'application/json'}};
 const body={contractVersion:'cop-sim-user-lifecycle-v1',scope:'cop_sim_shared_identity_v1',resetEpoch:a.resetEpoch,operationId:a.operationId,requestedAt:a.requestedAt};
 let n=0;const request=async(method,url,data,headers)=>{const r=await fetch(base+url,{method,headers,body:data===undefined?undefined:JSON.stringify(data)});await r.json();return r.status};
 const check=async(expectedStatus,...args)=>{assert.equal(await request(...args),expectedStatus);n++};
 try{
  await check(200,'GET',prefix+'/capabilities',undefined,{authorization:'Bearer '+options.serviceToken});
  await check(401,'GET',prefix+'/capabilities',undefined,{});
  await check(401,'POST',prefix+'/deletions',body,sign({...a,oidcIat:0}));
  await check(401,'POST',prefix+'/deletions',body,{'content-type':'application/json'});
  await check(401,'POST',prefix+'/deletions',body,sign({...a,aud:'sim-account-erasure'}));
  await check(401,'POST',prefix+'/deletions',body,sign({...a,oidcSubject:'service-account'}));
  await check(401,'POST',prefix+'/deletions',body,sign({...a,resetEpoch:randomUUID()}));
  await check(401,'POST',prefix+'/deletions',body,sign({...a,exp:a.iat-1}));
  const b=lane==='ai'?{taskType:'cop_chat',userId:a.sub}:{contributorIdDay:a.resourceId};
  await check(201,'POST',path,b,sign(a));
  await check(400,'POST',path,lane==='ai'?{...b,userId:'cop_'+'b'.repeat(43)}:{...b,contributorIdDay:'wrong-contributor'},sign(a));
  await check(400,'POST',prefix+'/deletions',{...body,ownerKey:'browser-selected'},sign(a));
  await check(202,'POST',prefix+'/deletions',body,sign(a));
  await check(200,'GET',prefix+'/deletions/'+a.operationId,undefined,sign(a));
  await check(503,'POST',path,b,sign(a));
  const second={...a,oidcSubject:randomUUID(),sub:'cop_'+'b'.repeat(43),operationId:randomUUID(),jti:randomUUID(),resourceId:lane==='ai'?'cop_'+'b'.repeat(43):'fixture-contributor-'+'b'.repeat(32)};
  await check(404,'GET',prefix+'/deletions/'+a.operationId,undefined,sign({...second,operationId:a.operationId}));
  await check(201,'POST',path,lane==='ai'?{taskType:'cop_chat',userId:second.sub}:{contributorIdDay:second.resourceId},sign(second));
  await worker.tick();
  await check(200,'POST',prefix+'/deletions',body,sign(a));
  await check(503,'POST',path,b,sign(a));
  options.enabled=false;await check(503,'GET',prefix+'/deletions/'+a.operationId,undefined,sign(a));
  return n;
 }finally{await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
}
