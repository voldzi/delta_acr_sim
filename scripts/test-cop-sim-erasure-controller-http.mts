/**
 * COP 898cd51 actual controller + consent composition -> actual SIM handlers.
 * Node 24; synthetic stores/identity/native/publication/other owners only.
 * No PostgreSQL, .env, native authority, provider, model, matcher or real user.
 * This isolated source test is NOT production authorization or deployment GO.
 */
import assert from "node:assert/strict";
import {createHash,createHmac,randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import net from "node:net";
import type {Server} from "node:http";
import {isAbsolute,join,resolve} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {promisify} from "node:util";
import {createApp} from "../apps/ai-router-api/src/app.js";
import {AccountErasureError,type AccountErasureStore,type ErasureIdentity,type RouterErasureReceipt} from "../apps/ai-router-api/src/account-erasure.js";
import type {BudgetStore} from "../apps/ai-router-api/src/budget.js";
import type {Config} from "../apps/ai-router-api/src/config.js";
import {registerDriverMeasurementRoutes,type DriverStore,type DriverSettings} from "../apps/situation-data-api/src/driver-measurements.js";
import {DriverAccountErasureError,validateDriverErasureCoverage,type DriverErasureInput,type DriverErasureReceipt} from "../apps/situation-data-api/src/driver-account-erasure.js";
import type {SituationDataConfig} from "../apps/situation-data-api/src/config.js";

const args=process.argv.slice(2);
if(args.length===1&&args[0]==="--help"){
  console.log("Node 24, synthetic loopback only: --run --cop-source /absolute/clean/COP/checkout. No credentials, endpoints or DB arguments accepted.");process.exit(0);
}
assert.equal(process.versions.node.split(".")[0],"24","Use the pinned Node 24 runtime.");
assert.ok(args.length===3&&args[0]==="--run"&&args[1]==="--cop-source"&&isAbsolute(args[2]!),"Only --run --cop-source /absolute/checkout is accepted.");
const source=resolve(fileURLToPath(new URL("..",import.meta.url))),copSource=resolve(args[2]!),execute=promisify(execFile);
const copRevision="898cd5132f513259b226d5beff5c3876156b56e7";
const copTree="a41ee5b065216dfb5e8ab37ee020fc766b66a5c6";
const copPins:Record<string,string>={
  "apps/cop-api/src/account-erasure.ts":"597d79d34e23f279bc527b2870a954198fc5b4f59f16dd409be9a3401704bdb7",
  "apps/cop-api/src/cop-driver-consent-erasure.ts":"b3db56b6a67a401d76544ede3df32707be8d7b20005e84d5955483db4a15d690",
  "apps/cop-api/src/driver-measurement-consent-store.ts":"e0c368cee3eee5a6d1a5f56a0419ace4cc949a05733aeb2a3bffb6d7777be6be",
  "apps/cop-api/src/sim-account-erasure.ts":"d9e20c5fbbbf25eb75182a328f26055d15a159279f55daffe787af20c27f676a",
  "apps/cop-api/src/mobility-store.ts":"d125b4c96c14bcba1ec323e8003ca1f6882d3cd02a686b5821d974cc57c82e8a",
  "apps/cop-api/src/ai-router-chat.ts":"a2357095540f118c1c77208e2ae4abd767178558969e00b1af7277efdba14e57",
  "apps/cop-api/src/driver-measurement-contract.ts":"d0d5c9275c8cb04ae97c3199508509a4e2dd6e08738eb226aa1acdf46b4b40c0",
  "apps/cop-api/src/cop-pg-pool.ts":"13c8d567ff1860a6bfb4d0fba04cafb6c6236f51ad24f0ac09ac3118823b71ed",
  "apps/cop-api/src/cop-session-database.ts":"f5da56a3e4d85b476c607233dd675da3d60f5e17a3d7896a18df3da1fa6358f8",
  "apps/cop-api/src/bounded-upstream.ts":"5f691417fc4064dd699f7bc015ae55e9023bb8e2de50a5c4b06c66d2dfb5112a",
  "apps/cop-api/src/dispatch-lease.ts":"cb48402a1c5701b82ba5148d0ba9d4ed88a85cc9a8012c8321bbbc673875ffa8",
  "docs/testing/account-erasure-consent-followup-20261014.json":"2319d529ee8640f953cef9fa9c11a0a953e2d74180396fd3e9bda89239cf7aca"
};
const simPins:Record<string,string>={
  "apps/ai-router-api/src/app.ts":"e298137791c2240aab3f2d0996fbb1ed6d1b0e9e91b881520f47e676bd5dce37",
  "apps/ai-router-api/src/account-erasure.ts":"0d59e2009749dc973b76f9fa3b15da1afe28c2eaeb5589b3ce32f2fa93c39d7a",
  "apps/situation-data-api/src/driver-measurements.ts":"bf128290ecaca8250e763f2347b0733a66296c39ff8dd0411c82c5b1879d7652",
  "apps/situation-data-api/src/driver-account-erasure.ts":"25e6c9731452150c4424b3bc60a0679d03b99044e824813d19a92674d342ca23"
};
async function verifyPins(root:string,pins:Record<string,string>){for(const[path,pin]of Object.entries(pins))assert.equal(createHash("sha256").update(await readFile(join(root,path))).digest("hex"),pin,`Unreviewed source: ${path}`);}
async function verifyCop(){assert.equal((await execute("git",["rev-parse","HEAD"],{cwd:copSource})).stdout.trim(),copRevision,"Unreviewed COP revision.");
  assert.equal((await execute("git",["rev-parse","HEAD^{tree}"],{cwd:copSource})).stdout.trim(),copTree,"Unreviewed COP tree.");
  assert.equal((await execute("git",["status","--porcelain"],{cwd:copSource})).stdout.trim(),"","COP must remain clean before and after the test.");await verifyPins(copSource,copPins);}
await verifyCop();await verifyPins(source,simPins);
const runnerHash=createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex");
// Never read, copy or print inherited production credentials/settings.
for(const key of Object.keys(process.env))if(/DATABASE|^PG|OPENAI|API_KEY|SECRET|TOKEN|ERASURE|MEASUREMENTS/u.test(key))delete process.env[key];
const actualFetch=globalThis.fetch,actualConnect=net.Socket.prototype.connect,allowedOrigins=new Set<string>(),allowedPorts=new Set<number>(),servers:Server[]=[];
let forbiddenNetwork=0,matcherCalls=0,providerCalls=0,controllerHandoffs=0;
const traffic:Array<{owner:"ai_router"|"sim_measurements";method:string;kind:string;status:number}>=[];
const cases:Array<{name:string;result:"PASS"}>=[];
let currentCase="source and fixture setup";
const routerPath="/api/v1/ai-router/cop/users/me/erasure-operations",driverPath="/api/v1/internal/driver-measurements/v1/account-erasure-operations";
globalThis.fetch=async(input,init)=>{
  const url=new URL(typeof input==="string"||input instanceof URL?input:input.url),method=init?.method??(input instanceof Request?input.method:"GET");
  if(url.protocol!=="http:"||url.hostname!=="127.0.0.1"||url.username||url.password||url.search||url.hash||!allowedOrigins.has(url.origin)||!['GET','POST'].includes(method)||
      !/^\/api\/v1\/(?:ai-router\/cop\/users\/me\/erasure-operations|internal\/driver-measurements\/v1\/account-erasure-operations)(?:\/(?:capability|preflight|[0-9a-f-]{36}))?$/u.test(url.pathname)){
    forbiddenNetwork++;throw new Error("Only the two exact synthetic loopback erasure surfaces are allowed.");}
  const response=await actualFetch(input,{...init,redirect:"error"});
  traffic.push({owner:url.pathname.startsWith(routerPath)?"ai_router":"sim_measurements",method,kind:url.pathname.endsWith("/capability")?"capability":url.pathname.endsWith("/preflight")?"preflight":url.pathname===routerPath||url.pathname===driverPath?"start":"status",status:response.status});return response;
};
// Defense in depth: no TCP egress/Unix/native/DB socket can slip past fetch.
net.Socket.prototype.connect=function(this:net.Socket,...args:any[]){const first=Array.isArray(args[0])?args[0][0]:args[0],object=first&&typeof first==="object"?first:{};
  const host=object.host??(typeof args[1]==="string"?args[1]:undefined),port=Number(object.port??(typeof first==="number"?first:undefined));
  if(object.path||host!=="127.0.0.1"||!allowedPorts.has(port)){forbiddenNetwork++;throw new Error("External, native and PostgreSQL sockets are forbidden.");}
  return actualConnect.apply(this,args as any);
} as typeof net.Socket.prototype.connect;
const issuer="https://synthetic-controller.example.invalid/realms/cop",token="synthetic-service-bearer-not-production-".repeat(2),actorSecret="synthetic-purpose-signer-not-production-".repeat(2),
  userSecret="synthetic-router-alias-secret-not-production-".repeat(2),daySecret="synthetic-driver-day-secret-not-production-".repeat(2),controllerSecret="synthetic-controller-secret-not-production-".repeat(2);
const now=new Date(),driverNow=new Date(now.toISOString().slice(0,10)+"T12:00:00.000Z");
const principal=(subjectId:string)=>({authMode:"oidc" as const,issuer,subjectId,username:"",displayName:"",authTime:Math.floor(now.getTime()/1000)});
const owner=principal("synthetic-controller-owner-a"),other=principal("synthetic-controller-owner-b"),operation=randomUUID();
const fixture={authority:true,identity:true,inventory:true,driverWaiting:true,storeOutage:false,interruptCheckpoint:false};
const config={copToken:token,simToken:"synthetic-preserved-sim-token-not-production",adminToken:"synthetic-not-used",userHashSecret:userSecret,copActorSecret:actorSecret,
  accountErasureIssuer:issuer,accountErasureEnabled:true,accountErasureCostPolicy:"aggregate-costs-current-month-v1",accountErasureReplayReady:true,
  copByokEnabled:false,simIzsEnabled:false,externalEnabled:false,advancedEnabled:false,openaiKey:"",localUrl:"",localModel:"",economyModel:"synthetic-never-called",advancedModel:"synthetic-never-called"} as Config;
const driverSettings:DriverSettings={enabled:false,revocationEnabled:false,ratePerMinute:600,token,hashSecret:daySecret,driverAccountErasureEnabled:true,driverAccountErasureActorSecret:actorSecret,driverAccountErasureIssuer:issuer};
const routerRows=new Map<string,{identity:ErasureIdentity}>(),driverRows=new Map<string,{input:DriverErasureInput;acceptedAt:string;complete:boolean}>();
let routerStarts=0,driverStarts=0,controller:any,lastDriverContext:any;
const completeRouter=(id:string):RouterErasureReceipt=>({contractVersion:"sim-account-erasure-v1",operationId:id,status:"online_complete",scope:"cop_router_primary_database",pendingReasons:[],pendingRequestCount:0,
  onlineScopeComplete:true,wholeAccountComplete:false,backupsComplete:false,providerRetentionComplete:false,retainedMinimumReplayFence:true,aliasScope:"sim_izs_preserved_out_of_scope"});
const routerStore:AccountErasureStore={
  async assertActive(){throw new Error("Non-erasure key/chat paths forbidden.");},
  async capability(enabled){if(fixture.storeOutage)throw new Error("Synthetic unavailable storage");return{contractVersion:"sim-account-erasure-v1",owner:"ai_router",scope:"cop_router_primary_database",enabled,ready:enabled,
    checkedAt:new Date().toISOString(),checks:{schemaReady:true,permissionsReady:true,identityReviewed:true,restoreCheckpointCurrent:true,retentionReviewed:true},blockers:enabled?[]:["erasure_disabled"],
    costPolicy:"aggregate-costs-current-month-v1",mutates:false,providerCalls:false,wholeAccountComplete:false};},
  async preflight(identity,id,enabled){const cap=await this.capability(enabled),old=routerRows.get(id);if(old&&(old.identity.ownerHash!==identity.ownerHash||old.identity.targetHash!==identity.targetHash))return null;
    return{...cap,operationId:id,identityBinding:"cop_attested_existing_router_alias",checks:{...cap.checks,identityBindingReviewed:true,providerRequestsSettled:true}};},
  async request(identity,id){if(fixture.storeOutage)throw new Error("Synthetic unavailable storage");const old=routerRows.get(id);
    if(old&&old.identity.ownerHash!==identity.ownerHash)throw new AccountErasureError("erasure_operation_not_found");if(old&&old.identity.targetHash!==identity.targetHash)throw new AccountErasureError("erasure_operation_conflict");
    if(!old&&!config.accountErasureEnabled)throw new AccountErasureError("erasure_review_required");routerStarts++;routerRows.set(id,{identity});return completeRouter(id);},
  async status(identity,id){if(fixture.storeOutage)throw new Error("Synthetic unavailable storage");const row=routerRows.get(id);return row&&row.identity.ownerHash===identity.ownerHash&&row.identity.targetHash===identity.targetHash?completeRouter(id):null;},
  async processPending(){throw new Error("No store worker in this HTTP-only fixture.");}
};
const receipt=(id:string,row:{input:DriverErasureInput;acceptedAt:string;complete:boolean}):DriverErasureReceipt=>({contractVersion:"sim-account-erasure-v1",operationId:id,status:row.complete?"completed":"pending",scope:"online_driver_scope",
  wholeAccountComplete:false,backupReplayRequired:true,acceptedAt:row.acceptedAt,updatedAt:driverNow.toISOString(),contributorCount:row.input.contributors.length,deletedBatchCount:0,remainingBatchCount:0,
  databaseZeroVerified:true,derivedReportAcknowledged:row.complete,reportProtection:"enforced_single_writer",publicationFenceVerified:true,replayReady:true,retentionReviewed:true,pendingReason:row.complete?null:"derived_report_pending"});
const driverStore:DriverStore={async lookup(){throw new Error("Intake forbidden.");},async commit(){throw new Error("Intake forbidden.");},async quality(){throw new Error("Data reads forbidden.");},
  async aggregates(){throw new Error("Data reads forbidden.");},async revoke(){throw new Error("Ordinary daily revocation forbidden.");},async close(){},
  async accountErasureCapability(){if(fixture.storeOutage)throw new Error("Synthetic unavailable storage");const enabled=!!driverSettings.driverAccountErasureEnabled;return{
    contractVersion:"sim-account-erasure-v1",owner:"sim_measurements",scope:"online_driver_scope",enabled,ready:enabled,checkedAt:driverNow.toISOString(),mutates:false,providerCalls:false,wholeAccountComplete:false,
    reportProtection:"enforced_single_writer",checks:{schemaReady:true,permissionsReady:true,identityReviewed:true,restoreCheckpointCurrent:true,retentionReviewed:true,publicationFenceVerified:true},blockers:enabled?[]:["erasure_disabled"]};},
  async accountErasurePreflight(input){const cap=await this.accountErasureCapability!(),old=driverRows.get(input.operationId);
    if(old&&old.input.actorHash!==input.actorHash)throw new DriverAccountErasureError(404,"DRIVER_ACCOUNT_ERASURE_NOT_FOUND");if(old&&old.input.requestHash!==input.requestHash)throw new DriverAccountErasureError(409,"DRIVER_ACCOUNT_ERASURE_CONFLICT");
    const at=old?.acceptedAt??driverNow.toISOString();validateDriverErasureCoverage(input,Date.parse(at));return{...cap,checks:{...cap.checks,identityBindingReviewed:true,manifestShapeAndCoverageValid:true},operationId:input.operationId,
      contributorCount:input.contributors.length,manifestValid:true,identityBinding:"cop_attested_daily_manifest",coverageAnchor:{kind:old?"first_accepted_at":"checked_at",at}};},
  async accountErasure(input){if(fixture.storeOutage)throw new Error("Synthetic unavailable storage");const old=driverRows.get(input.operationId);
    if(old&&old.input.actorHash!==input.actorHash)throw new DriverAccountErasureError(404,"DRIVER_ACCOUNT_ERASURE_NOT_FOUND");if(old&&old.input.requestHash!==input.requestHash)throw new DriverAccountErasureError(409,"DRIVER_ACCOUNT_ERASURE_CONFLICT");
    if(!old&&!driverSettings.driverAccountErasureEnabled)throw new DriverAccountErasureError(503,"DRIVER_ACCOUNT_ERASURE_DISABLED");const row=old??{input,acceptedAt:driverNow.toISOString(),complete:false};
    validateDriverErasureCoverage(input,Date.parse(row.acceptedAt));driverStarts++;driverRows.set(input.operationId,row);return receipt(input.operationId,row);},
  async accountErasureStatus(id,hash){if(fixture.storeOutage)throw new Error("Synthetic unavailable storage");const row=driverRows.get(id);return row&&row.input.actorHash===hash?receipt(id,row):undefined;},
  async acknowledgeAccountErasure(input){const row=driverRows.get(input.operationId);assert.ok(row);assert.equal(row.input.requestHash,input.requestHash);row.complete=true;return receipt(input.operationId,row);}
};
async function listen(app:any){const server:Server=await new Promise((yes,no)=>{const server=app.listen(0,"127.0.0.1",()=>{server.removeListener("error",no);yes(server);});server.once("error",no);});servers.push(server);
  const address=server.address();assert.ok(address&&typeof address!=="string");allowedPorts.add(address.port);const origin=`http://127.0.0.1:${address.port}`;allowedOrigins.add(origin);return origin;}
async function check(name:string,run:()=>Promise<void>){currentCase=name;await run();cases.push({name,result:"PASS"});}
let consent:any,guardStore:any,lifecycle:{close():Promise<void>}|undefined;
try{
  const cop=await import(pathToFileURL(join(copSource,"apps/cop-api/src/sim-account-erasure.ts")).href),controllerModule=await import(pathToFileURL(join(copSource,"apps/cop-api/src/account-erasure.ts")).href),
    composition=await import(pathToFileURL(join(copSource,"apps/cop-api/src/cop-driver-consent-erasure.ts")).href),consentModule=await import(pathToFileURL(join(copSource,"apps/cop-api/src/driver-measurement-consent-store.ts")).href),
    memory=await import(pathToFileURL(join(copSource,"apps/cop-api/src/mobility-store.ts")).href),helper=await import(pathToFileURL(join(copSource,"apps/cop-api/src/ai-router-chat.ts")).href),
    daily=await import(pathToFileURL(join(copSource,"apps/cop-api/src/driver-measurement-contract.ts")).href);
  const budget={hashUser:(client:string,user:string)=>createHash("sha256").update(`${client}\0${user}`).digest("hex"),reserve:async()=>{providerCalls++;throw new Error("Budget/model forbidden.");}} as unknown as BudgetStore;
  const routerOrigin=await listen(createApp(config,budget,undefined,routerStore));
  const require=createRequire(join(source,"apps/situation-data-api/package.json")),express=require("express"),app=express();app.use(express.json({limit:"32kb"}));
  const driverPayloads:Array<{operationId:string;contributors:Array<{contributorDay:string;contributorIdDay:string}>}>=[];
  app.use(driverPath,(req:any,_res:any,next:()=>void)=>{if(req.method==="POST"&&Array.isArray(req.body?.contributors))driverPayloads.push(structuredClone(req.body));next();});
  lifecycle=registerDriverMeasurementRoutes(app,{} as SituationDataConfig,driverSettings,{store:driverStore,now:()=>driverNow.getTime(),
    matcher:{async match(){matcherCalls++;throw new Error("Matcher forbidden.");},async dataset(){matcherCalls++;throw new Error("Valhalla forbidden.");}},
    accountErasureDerivedBarrier:async()=>{if(fixture.driverWaiting)throw new Error("Synthetic publication pending.");}});
  const driverOrigin=await listen(app);
  const options=(origin:string)=>({baseUrl:origin,issuer,token,actorSecret,userIdSecret:userSecret,timeoutMs:2000,
    verifyConfiguredOwner:async(_scope:unknown,c:{origin:string})=>fixture.authority&&c.origin===origin,
    reviewExistingIdentity:async(a:{subjectId:string},c:{routerUserId:string})=>fixture.identity&&c.routerUserId===helper.opaqueUserId(userSecret,a.subjectId)?{reviewed:true as const,version:"a".repeat(64)}:{reviewed:false as const},
    inventory:async()=>{if(!fixture.inventory)throw new Error("Completed retries must not reconstruct removed inventory.");return{version:"b".repeat(64),retainedComplete:true as const,outboxComplete:true as const,keyVersionsComplete:true as const,retainedDays:[],outboxDays:[],keys:[{version:"synthetic-reviewed-current",secret:daySecret}]};}});
  consent=new consentModule.InMemoryDriverMeasurementConsentStore();await consent.init(daySecret);
  const oldDay=new Date(driverNow.getTime()-15*86400000);await consent.grant(owner.subjectId,new Date(oldDay.getTime()-86400000),owner);await consent.revoke(owner.subjectId,oldDay,owner);
  const originalDays=(await consent.get(owner.subjectId)).pendingDays as string[];assert.equal(originalDays.length,9);
  const driver=composition.createCOPDriverMeasurementsErasureAdapter({...options(driverOrigin),now:()=>new Date(driverNow)},consent),router=cop.createSimRouterAccountErasureAdapter(options(routerOrigin));
  guardStore=new memory.MemoryMobilityStore();await guardStore.init();const actualTransact=guardStore.transact.bind(guardStore);
  // Real memory controller transaction rollback simulates a crash AFTER local
  // consent purge but BEFORE its global completed checkpoint is committed.
  guardStore.transact=(keys:string[],run:(tx:any)=>Promise<unknown>)=>actualTransact(keys,(tx:any)=>run({...tx,set:async(key:string,value:any)=>{
    if(fixture.interruptCheckpoint&&key.startsWith("account-erasure:job:")&&value.checkpoints?.sim_measurements?.status==="completed"){
      fixture.interruptCheckpoint=false;throw new Error("SYNTHETIC_GLOBAL_CHECKPOINT_WRITE_INTERRUPTED");}return tx.set(key,value);
  }}));
  const wrap=(adapter:any)=>({...adapter,erase:async(a:any,c:any)=>{assert.equal(await controller.operationFenceConfirmed(a,c),true,"Real controller must commit its confirmed durable job before SIM handoff.");
    const jobs=await guardStore.transact([],async(tx:any)=>tx.scan("account-erasure:job:"));assert.ok(jobs.some((row:any)=>row.value.operationId===c.operationId));controllerHandoffs++;
    if(adapter.id==="sim_measurements")lastDriverContext={...c};return adapter.erase(a,c);}});
  const wrappedDriver=wrap(driver),wrappedRouter=wrap(router),otherOwners=controllerModule.ACCOUNT_ERASURE_ADAPTER_IDS.filter((id:string)=>id!=="sim_measurements"&&id!=="ai_router").map((id:string)=>({
    id,ready:async()=>true,preflight:async()=>({ready:true as const,version:"synthetic-other-owner-v1"}),erase:async()=>id==="backup_restore"?{status:"pending" as const,remaining:"cleanup_pending" as const}:{status:"completed" as const,proofId:"synthetic-other-owner-v1"}}));
  const controllerOptions={store:guardStore,issuer,identitySecret:controllerSecret,requiredAdapters:controllerModule.ACCOUNT_ERASURE_ADAPTER_IDS,adapters:[...otherOwners,wrappedDriver,wrappedRouter],accepted:true,
    allowUnboundSyntheticStore:true,now:()=>new Date(now),admissionGuard:{run:async(_a:unknown,signal:AbortSignal,run:()=>Promise<unknown>)=>{signal.throwIfAborted();return run();}}};
  controller=new controllerModule.AccountErasureService(controllerOptions);await controller.init();
  const signed=(id:string,who=owner,time=Date.now())=>{const iat=Math.floor(time/1000),claims={iss:issuer,sub:who.subjectId,aud:"sim-account-erasure",iat,exp:iat+60,operationId:id,routerUserId:helper.opaqueUserId(userSecret,who.subjectId)},encoded=Buffer.from(JSON.stringify(claims)).toString("base64url");
    return{authorization:`Bearer ${token}`,"x-cop-actor":encoded,"x-cop-actor-signature":createHmac("sha256",actorSecret).update(encoded).digest("hex")};};
  const raw=async(origin:string,path:string,headers:Record<string,string>,body?:unknown)=>{const r=await fetch(origin+path,{method:body===undefined?"GET":"POST",headers:{...headers,...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json() as any};};
  await check("actual controller preflight is ordinary-ready without premature own-provider acceptance",async()=>{
    const p=await controller.preflight(owner,operation);assert.equal(p.response.canConfirm,true);assert.ok(p.capability);assert.ok(p.response.planId);
    assert.equal(routerRows.size,0);assert.equal(driverRows.size,0);assert.equal((await guardStore.transact([],async(tx:any)=>tx.scan("account-erasure:job:"))).length,0);
    (fixture as any).prepared=p;
  });
  await check("first SIM handoff follows actual durable confirmed COP job; Driver202 preserves consent inventory",async()=>{
    const p=(fixture as any).prepared,result=await controller.request(owner,operation,{confirmAccountDeletion:true},{planId:p.response.planId,capability:p.capability});
    assert.equal(result.accountDeleted,false);assert.equal(result.status,"deleting");assert.ok(result.remaining.includes("sim_measurements"));assert.equal(result.deletionScope,"cop_jizda_preserve_shared_identity_sim");
    assert.equal(routerStarts,1);assert.equal(driverStarts,1);assert.ok(controllerHandoffs>=2);assert.equal(driverRows.get(operation)?.complete,false);
    const local=await consent.erasureCheckpoint(owner,operation);assert.equal(local.completed,false);assert.deepEqual(local.pendingDays,originalDays);
    const status=await raw(driverOrigin,driverPath+"/"+operation,signed(operation,owner,driverNow.getTime()));assert.equal(status.status,202);assert.equal(status.body.wholeAccountComplete,false);
  });
  await check("actual composition sends every old COP pending date, never raw subject or secret",async()=>{
    const posted=driverPayloads.filter(row=>row.operationId===operation);assert.ok(posted.length>=3);
    for(const payload of posted)for(const day of originalDays)assert.ok(payload.contributors.some(row=>row.contributorDay===day&&row.contributorIdDay===daily.contributorIdDay(daySecret,owner.subjectId,day)));
    const serialized=JSON.stringify(posted);assert.ok(!serialized.includes(owner.subjectId));assert.ok(!serialized.includes(daySecret));assert.equal(driverRows.get(operation)!.input.contributors.length,18);
  });
  await check("feature-off resumes only this own accepted job; interruption preserves pending controller checkpoint after actual local purge",async()=>{
    config.accountErasureEnabled=false;driverSettings.driverAccountErasureEnabled=false;fixture.driverWaiting=false;fixture.interruptCheckpoint=true;
    assert.equal((await controller.capabilities()).accountDeletion,false);assert.equal(await wrappedDriver.readyForAcceptedOperation(owner,lastDriverContext),true);
    await assert.rejects(()=>controller.request(owner,operation,{confirmAccountDeletion:true}),(error:any)=>error.status===503);
    assert.equal(fixture.interruptCheckpoint,false);assert.equal(driverRows.get(operation)?.complete,true);
    const checkpoint=await consent.erasureCheckpoint(owner,operation);assert.equal(checkpoint.completed,true);assert.deepEqual(checkpoint.pendingDays,[]);
    const local=await consent.preflightActorErasure(owner);assert.equal(local.present,false);assert.deepEqual(local.pendingDays,[]);
    const r=await controller.read(owner,operation);assert.equal(r.accountDeleted,false);assert.ok(r.remaining.includes("sim_measurements"));
  });
  await check("actual restarted controller uses fresh GET-only Driver proof after consent and every inventory date are removed",async()=>{
    fixture.inventory=false;const offset=traffic.length,before=driverStarts;
    controller=new controllerModule.AccountErasureService(controllerOptions);await controller.init();await controller.resumePending();
    const driverTraffic=traffic.slice(offset).filter(row=>row.owner==="sim_measurements");assert.ok(driverTraffic.some(row=>row.kind==="status"&&row.status===200));assert.ok(driverTraffic.every(row=>row.method==="GET"));assert.equal(driverStarts,before);
    const result=await controller.read(owner,operation);assert.equal(result.accountDeleted,false);assert.ok(!result.remaining.includes("sim_measurements"));assert.ok(result.remaining.includes("backup_restore"));
    assert.deepEqual((await consent.erasureCheckpoint(owner,operation)).pendingDays,[]);assert.equal((await consent.preflightActorErasure(owner)).present,false);
  });
  await check("foreign actor and operation cannot resume, mutate or reconstruct completed inventory",async()=>{
    const before=driverStarts+routerStarts;
    assert.equal(await driver.readyForAcceptedOperation(other,lastDriverContext),false);await assert.rejects(()=>driver.readyForAcceptedOperation(owner,{...lastDriverContext,operationId:randomUUID()}));
    await assert.rejects(()=>controller.read(other,operation),(error:any)=>error.status===404);
    for(const [origin,path,time]of [[driverOrigin,driverPath,driverNow.getTime()],[routerOrigin,routerPath,Date.now()]] as const){
      assert.equal((await raw(origin,path+"/"+operation,signed(operation,other,time))).status,404);
      assert.equal((await raw(origin,path,signed(operation,other,time),{contractVersion:"sim-account-erasure-v1",operationId:operation,...(path===driverPath?{contributors:[...driverPayloads[0]!.contributors],attestation:"cop-account-erasure-contributors-reviewed-v1"}:{})})).status,503);
    }assert.equal(driverStarts+routerStarts,before);
  });
  await check("missing identity and unapproved authority prevent new controller jobs without fallback",async()=>{
    const before=driverStarts+routerStarts,count=(await guardStore.transact([],async(tx:any)=>tx.scan("account-erasure:job:"))).length;
    await assert.rejects(()=>controller.preflight({...other,authTime:undefined},randomUUID()),(error:any)=>error.status===401);
    await assert.rejects(()=>controller.preflight({...other,issuer:"https://other.invalid"},randomUUID()),(error:any)=>error.status===401);
    fixture.identity=false;config.accountErasureEnabled=true;driverSettings.driverAccountErasureEnabled=true;
    const rejected=await controller.preflight(other,randomUUID());assert.equal(rejected.response.canConfirm,false);fixture.identity=true;fixture.authority=false;
    assert.equal((await controller.capabilities()).accountDeletion,false);await assert.rejects(()=>controller.request(other,randomUUID(),{confirmAccountDeletion:true}),(error:any)=>error.status===503);
    fixture.authority=true;assert.equal(driverStarts+routerStarts,before);assert.equal((await guardStore.transact([],async(tx:any)=>tx.scan("account-erasure:job:"))).length,count);
  });
  await check("no shared SIM/IZS or identity deletion and no real backup/provider proof is claimed",async()=>{
    const result=await controller.read(owner,operation);assert.equal(result.deletionScope,"cop_jizda_preserve_shared_identity_sim");assert.equal(result.accountDeleted,false);assert.ok(result.remaining.includes("backup_restore"));
    assert.ok(result.remaining.includes("keycloak"));assert.equal(completeRouter(operation).aliasScope,"sim_izs_preserved_out_of_scope");
    assert.equal(providerCalls,0);assert.equal(matcherCalls,0);assert.equal(forbiddenNetwork,0);
  });
  await verifyCop();await verifyPins(source,simPins);assert.equal(createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"),runnerHash,"Runner changed during execution.");
  console.log(JSON.stringify({scope:"synthetic_controller_consent_loopback_HTTP_only",copRevision,copTree,copSourceSha256:copPins,simSourceSha256:simPins,runnerSha256:runnerHash,
    actualCopController:true,actualCopConsentComposition:true,actualCopInMemoryConsentLogic:true,actualCopSimAdapters:true,actualSimExpressHandlers:true,actualPublicCopLoginOrHttpRoutes:false,
    syntheticDependencies:["COP durable store in memory","SIM Router and Driver stores","OIDC actor and identity review","native admission and owner authority","publication barrier","all other owners"],
    productionGo:false,productionChanged:false,actualUserDeletion:false,actualPostgres:false,actualNativeAuthority:false,providerCalls,matcherCalls,forbiddenNetworkCalls:forbiddenNetwork,
    sharedIdentityAndSimIzsPreservedByFixture:true,backupCompletionClaimed:false,cases,requestCounts:{total:traffic.length,routerStarts,driverStarts,controllerHandoffs},
    unverified:["real COP/SIM native admission, commit, drain and restore","production database and identity/key-version/outbox provenance","public login/frontend/iPhone","provider and backup retention","production activation"]},null,2));
}catch(error){console.error(JSON.stringify({scope:"synthetic_controller_consent_loopback_HTTP_only",result:"FAIL",failedCase:currentCase,completedCases:cases,productionChanged:false,
  errorKind:error instanceof assert.AssertionError?"assertion":"synthetic_fixture_error",message:"Synthetic controller test failed; no raw payload/identity/credentials are emitted."}));process.exitCode=1;
}finally{
  await lifecycle?.close().catch(()=>undefined);await consent?.close().catch(()=>undefined);await guardStore?.close().catch(()=>undefined);
  for(const server of servers){server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}
  globalThis.fetch=actualFetch;net.Socket.prototype.connect=actualConnect;
}
