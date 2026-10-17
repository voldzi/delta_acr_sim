import {createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
const keys=['iss','aud','sub','oidcIssuer','oidcSubject','resetEpoch','operationId','requestedAt','iat','exp','jti','resourceId','oidcIat'];
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const exact=(x,k)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).length===k.length&&k.every(v=>Object.hasOwn(x,v));
const equal=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y)};
export function verifyCleanActor(req,options,now=Math.floor(Date.now()/1000)) {
 const encoded=req.header('x-cop-clean-actor')??'', signature=req.header('x-cop-clean-actor-signature')??'';
 if(!Number.isSafeInteger(options.tokensNotBefore)||options.tokensNotBefore<0||options.actorSecret.length<32||!/^[-_a-zA-Z0-9]{20,4096}$/.test(encoded)||!/^[a-f0-9]{64}$/.test(signature))return null;
 if(!equal(signature,createHmac('sha256',options.actorSecret).update(encoded).digest('hex')))return null;
 try{
  const bytes=Buffer.from(encoded,'base64url'),x=JSON.parse(bytes.toString('utf8'));
  if(bytes.toString('base64url')!==encoded||!exact(x,keys)||JSON.stringify(x)!==bytes.toString('utf8'))return null;
  if(x.iss!=='cop'||x.aud!=='sim-clean-lifecycle-v1'||x.oidcIssuer!==options.issuer||!uuid.test(x.oidcSubject)
   ||!/^cop_[A-Za-z0-9_-]{43}$/.test(x.sub)||x.resetEpoch!==options.expected.resetEpoch||!uuid.test(x.operationId)||!uuid.test(x.jti)
   ||typeof x.requestedAt!=='string'||!Number.isFinite(Date.parse(x.requestedAt))||new Date(x.requestedAt).toISOString()!==x.requestedAt
   ||!Number.isSafeInteger(x.iat)||!Number.isSafeInteger(x.exp)||x.iat>now||x.iat<now-60||x.exp<=now||x.exp<=x.iat||x.exp-x.iat>60
   ||!Number.isSafeInteger(x.oidcIat)||x.oidcIat<=options.tokensNotBefore||x.oidcIat>now
   ||typeof x.resourceId!=='string'||!/^[-_A-Za-z0-9]{32,128}$/.test(x.resourceId))return null;
  return x;
 }catch{return null}
}
export function registerCleanLifecycle(app,options) {
 const prefix=options.expected.lane==='ai'?'/api/v1/ai-router/internal/user-lifecycle/v1':'/api/v1/internal/user-lifecycle/v1';
 const owner=a=>createHmac('sha256',options.ownerSecret).update('sim-clean-owner-v1\0'+a.oidcIssuer+'\0'+a.oidcSubject).digest('hex');
 const fail=(res,status,code)=>res.status(status).json({error:code,correlationId:res.locals.cleanCorrelationId});
 const authorize=(req,res)=>{
   res.locals.cleanCorrelationId=randomUUID();res.set('Cache-Control','no-store');
   const token=/^Bearer (.+)$/.exec(req.header('authorization')??'')?.[1]??'';
   if(options.serviceToken.length<32||!equal(token,options.serviceToken)){fail(res,401,'CLEAN_UNAUTHORIZED');return null}
   if(!options.enabled||options.expected.mode!=='isolated-clean-lifecycle-v1'||options.ownerSecret.length<32){fail(res,503,'CLEAN_NOT_ENABLED');return null}
   const a=verifyCleanActor(req,options);if(!a){fail(res,401,'CLEAN_ACTOR_INVALID');return null}return a;
 };
 const receipt=(state,a)=>({contractVersion:'cop-sim-user-lifecycle-v1',scope:'cop_sim_shared_identity_v1',resetEpoch:a.resetEpoch,operationId:a.operationId,state,component:options.expected.lane,wholeAccountComplete:false});
 app.get(prefix+'/capabilities',async(req,res)=>{
   res.set('Cache-Control','no-store');
   const token=/^Bearer (.+)$/.exec(req.header('authorization')??'')?.[1]??'';
   if(options.serviceToken.length<32||!equal(token,options.serviceToken)){res.status(401).json({error:'CLEAN_UNAUTHORIZED'});return}
   let ready=false;try{ready=options.enabled&&options.workerReady?.()===true&&await options.service.capability()}catch{}
   res.status(ready?200:503).json({contractVersion:'cop-sim-user-lifecycle-v1',scope:'cop_sim_shared_identity_v1',resetEpoch:options.expected.resetEpoch,component:options.expected.lane,ready,wholeAccountComplete:false});
 });
 app.post(prefix+'/deletions',async(req,res)=>{
   const a=authorize(req,res);if(!a)return;
   const b=req.body;
   if(!exact(b,['contractVersion','scope','resetEpoch','operationId','requestedAt'])||b.contractVersion!=='cop-sim-user-lifecycle-v1'||b.scope!=='cop_sim_shared_identity_v1'||b.resetEpoch!==a.resetEpoch||b.operationId!==a.operationId||b.requestedAt!==a.requestedAt){fail(res,400,'CLEAN_INVALID_REQUEST');return}
   try{const r=await options.service.request(owner(a),a.operationId,a.requestedAt);res.status(r.state==='deleted'?200:202).json(receipt(r.state,a))}
   catch(e){fail(res,e.message==='IMMUTABLE_OPERATION_CONFLICT'?409:503,'CLEAN_REQUEST_UNAVAILABLE')}
 });
 app.get(prefix+'/deletions/:operationId',async(req,res)=>{
   const a=authorize(req,res);if(!a)return;if(req.params.operationId!==a.operationId){fail(res,400,'CLEAN_INVALID_OPERATION');return}
   try{const r=await options.service.status(owner(a),a.operationId);if(!r){fail(res,404,'CLEAN_NOT_FOUND');return}res.json(receipt(r.state,a))}
   catch{fail(res,503,'CLEAN_STATUS_UNAVAILABLE')}
 });
 // Reserve before the existing route has any persistent side effect. Each
 // existing handler still performs its normal auth, validation and guard checks.
 const writes=options.expected.lane==='ai'?new Set(['/api/v1/ai-router/generate','/api/v1/ai-router/cop/chat','/api/v1/ai-router/cop/users/me/openai-key']):new Set(['/api/v1/internal/driver-measurements/v1/batches']);
 app.use(async(req,res,next)=>{
   if(!writes.has(req.path)||!['POST','PUT'].includes(req.method))return next();
   // SIM/IZS non-COP tasks are out of this separate scope.
   if(options.expected.lane==='ai'&&req.path.endsWith('/generate')&&req.body?.taskType!=='cop_chat')return next();
   const a=authorize(req,res);if(!a)return;
   if(options.expected.lane==='ai'&&(a.resourceId!==a.sub||(req.body?.userId!==undefined&&req.body.userId!==a.sub))){fail(res,400,'CLEAN_RESOURCE_MISMATCH');return}
   if(options.expected.lane==='ai'&&!req.path.endsWith('/generate')){
     let existing;try{existing=JSON.parse(Buffer.from(req.header('x-cop-actor')??'','base64url').toString('utf8'))}catch{}
     if(existing?.sub!==a.sub){fail(res,400,'CLEAN_RESOURCE_MISMATCH');return}
   }
   if(options.expected.lane==='driver'&&req.body?.contributorIdDay!==a.resourceId){fail(res,400,'CLEAN_RESOURCE_MISMATCH');return}
   // The body resource is attested by the authenticated COP service actor.
   // It is never used to select an account; identity always comes from signed OIDC.
   try{await options.service.reserve(owner(a),[options.hashResource(a.resourceId)]);next()}
   catch{fail(res,503,'CLEAN_WRITE_FENCED')}
 });
 return {async tick(){await options.service.runOne();await options.service.purgeExpiredTotals()}};
}
