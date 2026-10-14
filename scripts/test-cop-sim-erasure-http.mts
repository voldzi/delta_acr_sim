/**
 * Actual COP adapters -> actual SIM Express routes, loopback HTTP only.
 * Run: node --import ./apps/ai-router-api/node_modules/tsx/dist/loader.mjs
 *   scripts/test-cop-sim-erasure-http.mts --run --cop-source /absolute/COP/checkout
 *
 * Stores, identity/continuity authority and publication barrier below are
 * explicitly SYNTHETIC fixtures. This does not verify PostgreSQL, Root proof,
 * real identities, backups, provider retention or production readiness.
 * No .env, production credentials, model, matcher or external endpoint is used.
 * An unreviewed/dirty COP source is refused before import. The earlier e2f896c
 * source audit found a feature-off resume blocker. This runner pins the reviewed
 * corrected a0c6fd6 source and positively checks that exact HTTP recovery path.
 * Passing this synthetic contract check is NOT production/joint-release GO.
 */
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Server } from "node:http";
import { createApp } from "../apps/ai-router-api/src/app.js";
import { AccountErasureError, type AccountErasureStore, type ErasureIdentity, type RouterErasureReceipt } from "../apps/ai-router-api/src/account-erasure.js";
import type { BudgetStore } from "../apps/ai-router-api/src/budget.js";
import type { Config } from "../apps/ai-router-api/src/config.js";
import { registerDriverMeasurementRoutes, type DriverStore, type DriverSettings } from "../apps/situation-data-api/src/driver-measurements.js";
import { DriverAccountErasureError, driverErasureRequiredDays, validateDriverErasureCoverage, type DriverErasureInput, type DriverErasureReceipt } from "../apps/situation-data-api/src/driver-account-erasure.js";
import type { SituationDataConfig } from "../apps/situation-data-api/src/config.js";

const args=process.argv.slice(2);
if(args.length===1&&args[0]==="--help"){
  console.log("Synthetic loopback HTTP only. Use --run --cop-source /absolute/reviewed/COP/checkout; no URLs or credentials accepted.");process.exit(0);
}
assert.ok(args.length===3&&args[0]==="--run"&&args[1]==="--cop-source"&&isAbsolute(args[2]!),"Only --run --cop-source /absolute/checkout is accepted.");
assert.equal(process.versions.node.split(".")[0],"24","Use the pinned Node.js 24 runtime.");
const copSource=resolve(args[2]!);
const source=resolve(fileURLToPath(new URL("..",import.meta.url)));
const execute=promisify(execFile);
const reviewedCopRevision="a0c6fd683ab51fa677c485e22c9f9e83621a188b";
const reviewedFiles={
  "apps/cop-api/src/sim-account-erasure.ts":"75e4bfde21c8e3ece5f6853e44c13c6158ba8c5504cee6bb14467201e04dfe2d",
  "apps/cop-api/src/ai-router-chat.ts":"a2357095540f118c1c77208e2ae4abd767178558969e00b1af7277efdba14e57",
  "apps/cop-api/src/driver-measurement-contract.ts":"d0d5c9275c8cb04ae97c3199508509a4e2dd6e08738eb226aa1acdf46b4b40c0"
};
async function verifyCopSource(){
  assert.equal((await execute("git",["rev-parse","HEAD"],{cwd:copSource})).stdout.trim(),reviewedCopRevision,"Unreviewed COP revision: wait for explicit source review and update the pins.");
  assert.equal((await execute("git",["status","--porcelain"],{cwd:copSource})).stdout.trim(),"","COP source is being changed: do not test a moving/unreviewed checkout.");
  for(const [path,pin]of Object.entries(reviewedFiles))assert.equal(createHash("sha256").update(await readFile(join(copSource,path))).digest("hex"),pin,`Unreviewed COP source: ${path}`);
}
await verifyCopSource();
const simHandlerFiles=["apps/ai-router-api/src/app.ts","apps/ai-router-api/src/account-erasure.ts","apps/situation-data-api/src/driver-measurements.ts","apps/situation-data-api/src/driver-account-erasure.ts"];
const simSourceSha256=Object.fromEntries(await Promise.all(simHandlerFiles.map(async path=>[path,createHash("sha256").update(await readFile(join(source,path))).digest("hex")])));
// Erase imported deployment settings rather than read or forward any of them.
for(const key of Object.keys(process.env))if(/DATABASE|^PG|OPENAI|API_KEY|SECRET|TOKEN|ERASURE|MEASUREMENTS/u.test(key))delete process.env[key];
const realFetch=globalThis.fetch,allowedOrigins=new Set<string>(),servers:Server[]=[];
let forbiddenNetworkCalls=0,matcherCalls=0,providerCalls=0;
const requests:Array<{owner:string;method:string;status:number}>=[];
globalThis.fetch=async(input,init)=>{
  const url=new URL(typeof input==="string"||input instanceof URL?input:input.url);
  const method=init?.method??(input instanceof Request?input.method:"GET");
  if(url.hostname!=="127.0.0.1"||url.username||url.password||url.search||url.hash||!allowedOrigins.has(url.origin)||!['GET','POST'].includes(method)||
     !/^\/api\/v1\/(?:ai-router\/cop\/users\/me\/erasure-operations|internal\/driver-measurements\/v1\/account-erasure-operations)(?:\/(?:capability|preflight|[0-9a-f-]{36}))?$/u.test(url.pathname)){
    forbiddenNetworkCalls++;throw new Error("External/provider/non-erasure calls are forbidden in this synthetic HTTP runner.");
  }
  const response=await realFetch(input,init);
  requests.push({owner:url.pathname.includes("ai-router")?"ai_router":"sim_measurements",method,status:response.status});
  return response;
};
const issuer="https://synthetic-erasure.example.invalid/realms/cop";
const token="synthetic-internal-service-token-not-production-".repeat(2);
const actorSecret="synthetic-purpose-actor-key-not-production-".repeat(2);
const userIdSecret="synthetic-existing-router-alias-key-not-production-".repeat(2);
const dailySecret="synthetic-existing-driver-daily-key-not-production-".repeat(2);
const actor:{authMode:"oidc";issuer:string;subjectId:string}={authMode:"oidc",issuer,subjectId:"synthetic-owner-subject-1"};
const otherActor={...actor,subjectId:"synthetic-owner-subject-2"};
// Explicit shared DRIVER fixture clock only; real AI time validation is unchanged.
const driverNow=new Date(new Date().toISOString().slice(0,10)+"T12:00:00.000Z");
const routerPath="/api/v1/ai-router/cop/users/me/erasure-operations";
const driverPath="/api/v1/internal/driver-measurements/v1/account-erasure-operations";
const hashUser=(client:string,user:string)=>createHash("sha256").update(`${client}\0${user}`).digest("hex");
const context=(operationId:string)=>({operationId,accountKey:"synthetic-not-forwarded",requestedAt:new Date().toISOString(),signal:new AbortController().signal});
const body=(operationId:string)=>({contractVersion:"sim-account-erasure-v1",operationId});
const cases:Array<{name:string;result:"PASS"}>=[],blockers:string[]=[];
async function check(name:string,run:()=>Promise<void>){await run();cases.push({name,result:"PASS"});}
async function listen(app:any):Promise<string>{
  const server:Server=await new Promise((resolveListen,reject)=>{const s=app.listen(0,"127.0.0.1",()=>{s.removeListener("error",reject);resolveListen(s);});s.once("error",reject);});servers.push(server);
  const address=server.address();assert.ok(address&&typeof address!=="string");const origin=`http://127.0.0.1:${address.port}`;allowedOrigins.add(origin);return origin;
}
const routerOperations=new Map<string,{identity:ErasureIdentity;complete:boolean}>();
const routerState={pending:false,outage:false,starts:0};
const config={copToken:token,simToken:"synthetic-other-service-token-not-production",adminToken:"synthetic-admin-token-not-production",userHashSecret:userIdSecret,
  copActorSecret:actorSecret,accountErasureIssuer:issuer,accountErasureEnabled:true,accountErasureCostPolicy:"aggregate-costs-current-month-v1",accountErasureReplayReady:true,
  copByokEnabled:false,simIzsEnabled:false,externalEnabled:false,advancedEnabled:false,openaiKey:"",localUrl:"",localModel:"",economyModel:"gpt-6-luna",advancedModel:"gpt-6-sol"} as Config;
function routerReceipt(operationId:string,entry:{complete:boolean}):RouterErasureReceipt{return{
  contractVersion:"sim-account-erasure-v1",operationId,status:entry.complete?"online_complete":"pending",scope:"cop_router_primary_database",
  pendingReasons:entry.complete?[]:["provider_requests_pending"],pendingRequestCount:entry.complete?0:1,onlineScopeComplete:entry.complete,
  wholeAccountComplete:false,backupsComplete:false,providerRetentionComplete:false,retainedMinimumReplayFence:true,aliasScope:"sim_izs_preserved_out_of_scope"};}
const routerStore:AccountErasureStore={
  async assertActive(){throw new Error("Chat/key/budget access is forbidden in this erasure-only runner.");},
  async capability(enabled){if(routerState.outage)throw new Error("SYNTHETIC_STORE_OUTAGE");return{
    contractVersion:"sim-account-erasure-v1",owner:"ai_router",scope:"cop_router_primary_database",enabled,ready:enabled,checkedAt:new Date().toISOString(),
    checks:{schemaReady:true,permissionsReady:true,identityReviewed:true,restoreCheckpointCurrent:true,retentionReviewed:true},blockers:enabled?[]:["erasure_disabled"],
    costPolicy:"aggregate-costs-current-month-v1",mutates:false,providerCalls:false,wholeAccountComplete:false};},
  async preflight(identity,id,enabled){const cap=await this.capability(enabled),old=routerOperations.get(id);if(old&&old.identity.ownerHash!==identity.ownerHash)return null;
    return{...cap,operationId:id,identityBinding:"cop_attested_existing_router_alias",checks:{...cap.checks,identityBindingReviewed:true,providerRequestsSettled:!routerState.pending},
      ready:cap.ready&&!routerState.pending,blockers:[...cap.blockers,...(routerState.pending?["provider_requests_pending" as const]:[])]};},
  async request(identity,id){if(routerState.outage)throw new Error("SYNTHETIC_STORE_OUTAGE");const old=routerOperations.get(id);
    if(old&&old.identity.ownerHash!==identity.ownerHash)throw new AccountErasureError("erasure_operation_not_found");
    if(old&&old.identity.targetHash!==identity.targetHash)throw new AccountErasureError("erasure_operation_conflict");
    if([...routerOperations.entries()].some(([op,row])=>op!==id&&row.identity.targetHash===identity.targetHash))throw new AccountErasureError("erasure_operation_conflict");
    routerState.starts++;const entry=old??{identity,complete:false};entry.complete=!routerState.pending;routerOperations.set(id,entry);return routerReceipt(id,entry);},
  async status(identity,id){if(routerState.outage)throw new Error("SYNTHETIC_STORE_OUTAGE");const old=routerOperations.get(id);return old&&old.identity.ownerHash===identity.ownerHash&&old.identity.targetHash===identity.targetHash?routerReceipt(id,old):null;},
  async processPending(){throw new Error("No background/store worker is run by this HTTP-only fixture.");}
};
const budget={hashUser,reserve:async()=>{providerCalls++;throw new Error("Budget/provider calls forbidden.");}} as unknown as BudgetStore;
const driverSettings:DriverSettings={enabled:false,revocationEnabled:true,ratePerMinute:120,token,hashSecret:dailySecret,driverAccountErasureEnabled:true,
  driverAccountErasureActorSecret:actorSecret,driverAccountErasureIssuer:issuer};
const driverState={waiting:false,outage:false,starts:0};
const driverOperations=new Map<string,{input:DriverErasureInput;acceptedAt:string;complete:boolean}>();
function driverReceipt(id:string,row:{input:DriverErasureInput;acceptedAt:string;complete:boolean}):DriverErasureReceipt{return{
  contractVersion:"sim-account-erasure-v1",operationId:id,status:row.complete?"completed":"pending",scope:"online_driver_scope",wholeAccountComplete:false,backupReplayRequired:true,
  acceptedAt:row.acceptedAt,updatedAt:driverNow.toISOString(),contributorCount:row.input.contributors.length,deletedBatchCount:0,remainingBatchCount:0,databaseZeroVerified:true,
  derivedReportAcknowledged:row.complete,reportProtection:"enforced_single_writer",publicationFenceVerified:true,replayReady:true,retentionReviewed:true,pendingReason:row.complete?null:"derived_report_pending"};}
const driverStore:DriverStore={
  async lookup(){throw new Error("No intake/read path is permitted by this HTTP-only fixture.");},async commit(){throw new Error("No measurement intake is permitted.");},
  async aggregates(){throw new Error("No aggregate data read is permitted.");},async quality(){throw new Error("No quality data read is permitted.");},async revoke(){throw new Error("No non-erasure revocation is permitted.");},async close(){},
  async accountErasureCapability(){if(driverState.outage)throw new Error("SYNTHETIC_STORE_OUTAGE");const enabled=driverSettings.driverAccountErasureEnabled===true;return{
    contractVersion:"sim-account-erasure-v1",owner:"sim_measurements",scope:"online_driver_scope",enabled,ready:enabled,checkedAt:driverNow.toISOString(),mutates:false,providerCalls:false,wholeAccountComplete:false,
    checks:{schemaReady:true,permissionsReady:true,identityReviewed:true,restoreCheckpointCurrent:true,retentionReviewed:true,publicationFenceVerified:true},reportProtection:"enforced_single_writer",blockers:enabled?[]:["erasure_disabled"]};},
  async accountErasurePreflight(input){const cap=await this.accountErasureCapability!(),old=driverOperations.get(input.operationId);
    if(old&&old.input.actorHash!==input.actorHash)throw new DriverAccountErasureError(404,"DRIVER_ACCOUNT_ERASURE_NOT_FOUND");
    if(old&&old.input.requestHash!==input.requestHash)throw new DriverAccountErasureError(409,"DRIVER_ACCOUNT_ERASURE_CONFLICT");
    const at=old?.acceptedAt??driverNow.toISOString();validateDriverErasureCoverage(input,Date.parse(at));return{
      ...cap,checkedAt:old?cap.checkedAt:at,checks:{...cap.checks,identityBindingReviewed:true,manifestShapeAndCoverageValid:true},operationId:input.operationId,manifestValid:true,
      identityBinding:"cop_attested_daily_manifest",coverageAnchor:{kind:old?"first_accepted_at":"checked_at",at},contributorCount:input.contributors.length};},
  async accountErasure(input){if(driverState.outage)throw new Error("SYNTHETIC_STORE_OUTAGE");const old=driverOperations.get(input.operationId);
    if(old&&old.input.actorHash!==input.actorHash)throw new DriverAccountErasureError(404,"DRIVER_ACCOUNT_ERASURE_NOT_FOUND");
    if(old&&old.input.requestHash!==input.requestHash)throw new DriverAccountErasureError(409,"DRIVER_ACCOUNT_ERASURE_CONFLICT");
    const row=old??{input,acceptedAt:driverNow.toISOString(),complete:false};validateDriverErasureCoverage(input,Date.parse(row.acceptedAt));driverState.starts++;driverOperations.set(input.operationId,row);return driverReceipt(input.operationId,row);},
  async accountErasureStatus(id,actorHash){if(driverState.outage)throw new Error("SYNTHETIC_STORE_OUTAGE");const row=driverOperations.get(id);return row&&row.input.actorHash===actorHash?driverReceipt(id,row):undefined;},
  async acknowledgeAccountErasure(input){const row=driverOperations.get(input.operationId);assert.ok(row);assert.equal(row.input.requestHash,input.requestHash);row.complete=true;return driverReceipt(input.operationId,row);}
};
try{
  const cop=await import(pathToFileURL(join(copSource,"apps/cop-api/src/sim-account-erasure.ts")).href);
  const helper=await import(pathToFileURL(join(copSource,"apps/cop-api/src/ai-router-chat.ts")).href);
  const contributorHelper=await import(pathToFileURL(join(copSource,"apps/cop-api/src/driver-measurement-contract.ts")).href);
  const routerOrigin=await listen(createApp(config,budget,undefined,routerStore));
  const require=createRequire(join(source,"apps/situation-data-api/package.json")),express=require("express"),driverApp=express();driverApp.use(express.json({limit:"32kb"}));
  const driverPayloads:Array<{operationId:string;contributors:Array<{contributorDay:string;contributorIdDay:string}>}>=[];
  driverApp.use(driverPath,(req:any,_res:any,next:()=>void)=>{if(req.method==="POST"&&req.body?.contributors)driverPayloads.push(structuredClone(req.body));next();});
  const driverLifecycle=registerDriverMeasurementRoutes(driverApp,{} as SituationDataConfig,driverSettings,{store:driverStore,
    now:()=>driverNow.getTime(),
    matcher:{async match(){matcherCalls++;throw new Error("Valhalla/matcher calls forbidden.");},async dataset(){matcherCalls++;throw new Error("Dataset calls forbidden.");}},
    accountErasureDerivedBarrier:async()=>{if(driverState.waiting)throw new Error("SYNTHETIC_PUBLICATION_PENDING");}});
  const driverOrigin=await listen(driverApp);
  const options=(origin:string)=>({baseUrl:origin,token,issuer,actorSecret,userIdSecret,timeoutMs:2000,
    verifyConfiguredOwner:async(_owner:unknown,c:{origin:string})=>c.origin===origin,
    reviewExistingIdentity:async(a:{subjectId:string},c:{routerUserId:string})=>({reviewed:c.routerUserId===helper.opaqueUserId(userIdSecret,a.subjectId),version:"a".repeat(64)}),
    inventory:async()=>({version:"b".repeat(64),retainedComplete:true,outboxComplete:true,keyVersionsComplete:true,retainedDays:[],outboxDays:[],keys:[{version:"synthetic-reviewed-v1",secret:dailySecret}]})});
  const driverOptions={...options(driverOrigin),now:()=>new Date(driverNow)};
  const router=cop.createSimRouterAccountErasureAdapter(options(routerOrigin)),driver=cop.createSimMeasurementsAccountErasureAdapter(driverOptions);
  const signed=(id:string,who=actor,at=Date.now())=>{const iat=Math.floor(at/1000),claim={iss:issuer,sub:who.subjectId,aud:"sim-account-erasure",iat,exp:iat+60,operationId:id,routerUserId:helper.opaqueUserId(userIdSecret,who.subjectId)};
    const encoded=Buffer.from(JSON.stringify(claim)).toString("base64url");return{authorization:`Bearer ${token}`,"x-cop-actor":encoded,"x-cop-actor-signature":createHmac("sha256",actorSecret).update(encoded).digest("hex")};};
  const driverSigned=(id:string,who=actor)=>signed(id,who,driverNow.getTime());
  const raw=async(origin:string,path:string,headers:Record<string,string>,payload?:unknown)=>{const response=await fetch(origin+path,{method:payload===undefined?"GET":"POST",headers:{...headers,...(payload===undefined?{}:{"content-type":"application/json"})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
    assert.equal(response.headers.get("cache-control"),"no-store","Actual handler, not a mocked response, owns this header.");return{status:response.status,body:await response.json() as any};};
  await check("actual handler 401, exact cache header and safe correlation IDs",async()=>{for(const [origin,path]of [[routerOrigin,routerPath],[driverOrigin,driverPath]]){
    const response=await raw(origin,path+"/capability",{});assert.equal(response.status,401);assert.match(response.body.correlationId??response.body.error?.correlationId,/^[a-f0-9-]{36}$/u);}});
  await check("default missing configured-owner authority is not ready",async()=>{assert.equal(await cop.createSimRouterAccountErasureAdapter({...options(routerOrigin),verifyConfiguredOwner:undefined}).ready(),false);});
  const routerComplete=randomUUID(),routerPending=randomUUID(),driverComplete=randomUUID(),driverPending=randomUUID();
  await check("COP Router adapter: actual capability/preflight/start/status 200",async()=>{assert.equal(await router.ready(),true);assert.equal((await router.preflight(actor,context(routerComplete))).ready,true);
    assert.equal((await router.erase(actor,context(routerComplete))).status,"completed");assert.equal((await raw(routerOrigin,routerPath+"/"+routerComplete,signed(routerComplete))).status,200);});
  await check("COP driver adapter: actual canonical actor, coverage/preflight/start/status 200",async()=>{assert.equal(await driver.ready(),true);assert.equal((await driver.preflight(actor,context(driverComplete))).ready,true);
    assert.equal((await driver.erase(actor,context(driverComplete))).status,"completed");assert.equal((await raw(driverOrigin,driverPath+"/"+driverComplete,driverSigned(driverComplete))).status,200);});
  await check("full historical retained/outbox inventory and two key versions are never truncated",async()=>{
    const historicalActor={...actor,subjectId:"synthetic-historical-owner-subject"},id=randomUUID();
    const retainedDay=new Date(driverNow.getTime()-15*86400000).toISOString().slice(0,10),outboxDay=new Date(driverNow.getTime()-14*86400000).toISOString().slice(0,10);
    const oldSecret="synthetic-historical-driver-key-not-production-".repeat(2),keys=[{version:"synthetic-reviewed-current",secret:dailySecret},{version:"synthetic-reviewed-historical",secret:oldSecret}];
    const inventory={version:"c".repeat(64),retainedComplete:true,outboxComplete:true,keyVersionsComplete:true,retainedDays:[retainedDay],outboxDays:[outboxDay],keys};
    const historical=cop.createSimMeasurementsAccountErasureAdapter({...driverOptions,inventory:async()=>inventory});
    assert.equal((await historical.preflight(historicalActor,context(id))).ready,true);assert.equal((await historical.erase(historicalActor,context(id))).status,"completed");
    const days=[...new Set([...driverErasureRequiredDays(driverNow.getTime()),retainedDay,outboxDay])].sort();
    const expected=keys.flatMap(key=>days.map(contributorDay=>({contributorDay,contributorIdDay:contributorHelper.contributorIdDay(key.secret,historicalActor.subjectId,contributorDay)})));
    const canonical=(rows:Array<{contributorDay:string;contributorIdDay:string}>)=>rows.map(row=>JSON.stringify(row)).sort();
    const sent=driverPayloads.filter(payload=>payload.operationId===id);assert.equal(sent.length,3,"Actual COP preflight, erase preflight and start must each send the entire inventory.");
    for(const payload of sent){assert.equal(payload.contributors.length,expected.length);assert.deepEqual(canonical(payload.contributors),canonical(expected));}
    const status=await raw(driverOrigin,driverPath+"/"+id,driverSigned(id,historicalActor));assert.equal(status.status,200);assert.equal(status.body.contributorCount,expected.length);
    assert.equal(driverOperations.get(id)!.input.contributors.length,expected.length);assert.equal(expected.length,22);
  });
  await check("actual Router 202 remains pending, never whole completion",async()=>{routerState.pending=true;assert.equal((await router.erase(otherActor,context(routerPending))).status,"pending");
    const response=await raw(routerOrigin,routerPath+"/"+routerPending,signed(routerPending,otherActor));assert.equal(response.status,202);assert.equal(response.body.wholeAccountComplete,false);});
  await check("actual driver publication 202 remains pending",async()=>{driverState.waiting=true;assert.equal((await driver.erase(otherActor,context(driverPending))).status,"pending");assert.equal((await raw(driverOrigin,driverPath+"/"+driverPending,driverSigned(driverPending,otherActor))).status,202);});
  await check("401/wrong dedicated token and 503 outage never complete or fallback",async()=>{const wrong=cop.createSimRouterAccountErasureAdapter({...options(routerOrigin),token:"synthetic-invalid-dedicated-token-".repeat(2)});assert.equal(await wrong.ready(),false);assert.equal((await wrong.erase(actor,context(randomUUID()))).status,"pending");
    routerState.outage=true;assert.equal((await raw(routerOrigin,routerPath+"/capability",{authorization:`Bearer ${token}`})).status,503);assert.equal(await router.ready(),false);routerState.outage=false;
    driverState.outage=true;assert.equal((await raw(driverOrigin,driverPath+"/capability",{authorization:`Bearer ${token}`})).status,503);assert.equal(await driver.ready(),false);driverState.outage=false;});
  await check("reviewed corrected COP resumes only accepted operations with the feature off",async()=>{
    config.accountErasureEnabled=false;driverSettings.driverAccountErasureEnabled=false;routerState.pending=false;driverState.waiting=false;
    const beforeRouter=routerState.starts,beforeDriver=driverState.starts;
    assert.equal(await router.ready(),false);assert.equal(await driver.ready(),false);
    assert.equal(await router.readyForAcceptedOperation(otherActor,context(routerPending)),true);
    assert.equal(await driver.readyForAcceptedOperation(otherActor,context(driverPending)),true);
    assert.equal((await router.erase(otherActor,context(routerPending))).status,"completed");assert.equal((await driver.erase(otherActor,context(driverPending))).status,"completed");
    assert.equal(routerState.starts,beforeRouter+1);assert.equal(driverState.starts,beforeDriver+1);
    assert.equal((await raw(routerOrigin,routerPath+"/"+routerPending,signed(routerPending,otherActor))).status,200);
    assert.equal((await raw(driverOrigin,driverPath+"/"+driverPending,driverSigned(driverPending,otherActor))).status,200);
  });
  await check("feature off cannot create unknown or foreign operations",async()=>{
    const beforeRouter=routerState.starts,beforeDriver=driverState.starts;
    assert.equal(await router.readyForAcceptedOperation(actor,context(randomUUID())),false);
    assert.equal(await driver.readyForAcceptedOperation(actor,context(randomUUID())),false);
    assert.equal((await router.erase(actor,context(randomUUID()))).status,"pending");assert.equal((await driver.erase(actor,context(randomUUID()))).status,"pending");
    assert.equal((await router.erase(actor,context(routerPending))).status,"pending");assert.equal((await driver.erase(actor,context(driverPending))).status,"pending");
    assert.equal(routerState.starts,beforeRouter);assert.equal(driverState.starts,beforeDriver);
  });
  await driverLifecycle.close();await verifyCopSource();
  for(const [path,pin]of Object.entries(simSourceSha256))assert.equal(createHash("sha256").update(await readFile(join(source,path))).digest("hex"),pin,`SIM handler changed during test: ${path}`);
  assert.equal(forbiddenNetworkCalls,0);assert.equal(matcherCalls,0);assert.equal(providerCalls,0);
  console.log(JSON.stringify({scope:"synthetic_loopback_HTTP_only",copRevision:reviewedCopRevision,copSourceSha256:reviewedFiles,simSourceSha256,driverFixtureClock:driverNow.toISOString(),actualSimExpressHandlers:true,syntheticStoresAndAuthority:true,
    cases,requestStatusCounts:Object.fromEntries([200,202,401,404,503].map(status=>[status,requests.filter(r=>r.status===status).length])),
    forbiddenNetworkCalls,matcherCalls,providerCalls,syntheticHttpAcceptance:blockers.length===0,productionAcceptance:false,productionAuthorization:false,actualRootProof:false,actualPostgresTest:false,blockers},null,2));
  process.exitCode=blockers.length?1:0;
}finally{
  globalThis.fetch=realFetch;
  for(const server of servers){server.closeAllConnections();await new Promise<void>((resolveClose,reject)=>server.close(error=>error?reject(error):resolveClose()));}
}
