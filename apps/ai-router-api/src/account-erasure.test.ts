import { createHash, createHmac } from "node:crypto";
import type { Request } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountErasureError, erasureIdentity, verifyErasureActor, type AccountErasureStore, type ErasureActor, type ErasureIdentity, type RouterErasureCapability, type RouterErasureReceipt } from "./account-erasure.js";
import { createApp } from "./app.js";
import type { BudgetStore } from "./budget.js";
import type { Config } from "./config.js";
import type { SeparateBilling } from "./separate-billing.js";

const path="/api/v1/ai-router/cop/users/me/erasure-operations";
const secret="synthetic-actor-secret-with-sufficient-entropy";
const pepper="synthetic-owner-hash-pepper-at-least-24-chars";
const issuer="https://identity.example.invalid/realm";
const op1="00000000-0000-4000-8000-000000000001",op2="00000000-0000-4000-8000-000000000002";
const alias1=`cop_${"A".repeat(43)}`,alias2=`cop_${"B".repeat(43)}`;
const hashUser=(client:string,user:string)=>createHash("sha256").update(`${client}\0${user}`).digest("hex");
const config={copToken:"synthetic-cop-token-of-at-least-24-chars",simToken:"synthetic-sim-token-of-at-least-24-chars",adminToken:"synthetic-admin-token-at-least-24-chars",
  copActorSecret:secret,userHashSecret:pepper,accountErasureIssuer:issuer,accountErasureEnabled:true,copByokEnabled:true,
  economyModel:"gpt-6-luna",externalEnabled:true,openaiKey:"synthetic-shared-key-not-a-fallback",localUrl:"",localModel:"",
  byokDailyMicrousd:1000000,byokMonthlyMicrousd:10000000,byokDailyRequests:10} as Config;
function claims(operationId=op1,sub="synthetic-subject-one",routerUserId=alias1,now=Math.floor(Date.now()/1000)):ErasureActor {
  return {iss:issuer,sub,aud:"sim-account-erasure",iat:now,exp:now+60,operationId,routerUserId};
}
function signedText(text:string){const encoded=Buffer.from(text).toString("base64url");return {authorization:`Bearer ${config.copToken}`,"x-cop-actor":encoded,"x-cop-actor-signature":createHmac("sha256",secret).update(encoded).digest("hex")};}
function headers(actor=claims()){return signedText(JSON.stringify(actor));}
function req(h:Record<string,string>){return {header:(name:string)=>h[name]} as unknown as Request;}
const body=(operationId=op1)=>({contractVersion:"sim-account-erasure-v1",operationId});

function fixture(){
  const operations=new Map<string,{identity:ErasureIdentity;complete:boolean}>();
  const keys=new Map<string,string>([[hashUser("cop",alias1),"sk-synthetic-user-one-long-enough"],[hashUser("cop",alias2),"sk-synthetic-user-two-long-enough"]]);
  const pending=new Map<string,number>();
  let retention=true,restore=true,outage=false;
  const capability=async(enabled:boolean):Promise<RouterErasureCapability>=>{
    if(outage)throw Error("synthetic_store_down");
    const blockers:RouterErasureCapability["blockers"]=[];
    if(!enabled)blockers.push("erasure_disabled");if(!retention)blockers.push("retention_review_required");if(!restore)blockers.push("restore_checkpoint_not_current");
    return {contractVersion:"sim-account-erasure-v1",owner:"ai_router",scope:"cop_router_primary_database",enabled,ready:!blockers.length,checkedAt:new Date().toISOString(),
      checks:{schemaReady:true,permissionsReady:true,identityReviewed:true,restoreCheckpointCurrent:restore,retentionReviewed:retention},blockers,
      costPolicy:retention?"aggregate-costs-current-month-v1":"pending_requires_review",mutates:false,providerCalls:false,wholeAccountComplete:false};
  };
  const receipt=(operationId:string,entry:{identity:ErasureIdentity;complete:boolean}):RouterErasureReceipt=>{
    const count=pending.get(entry.identity.targetHash)??0;
    const reasons:RouterErasureReceipt["pendingReasons"]=[];
    if(!entry.complete){if(count)reasons.push("provider_requests_pending");if(!retention)reasons.push("cost_retention_review_required");if(!restore)reasons.push("backup_replay_not_ready");if(!reasons.length)reasons.push("erasure_processing_pending");}
    return {contractVersion:"sim-account-erasure-v1",operationId,status:entry.complete?"online_complete":"pending",scope:"cop_router_primary_database",pendingReasons:reasons,
      pendingRequestCount:count,onlineScopeComplete:entry.complete,wholeAccountComplete:false,backupsComplete:false,providerRetentionComplete:false,retainedMinimumReplayFence:true,aliasScope:"sim_izs_preserved_out_of_scope"};
  };
  const erase:AccountErasureStore={capability,
    async assertActive(target){if(outage)throw Error("synthetic_store_down");if([...operations.values()].some(e=>e.identity.targetHash===target))throw new AccountErasureError("account_erasure_pending");},
    async preflight(identity,operationId,enabled){const c=await capability(enabled);const entry=operations.get(operationId);if(entry&&(entry.identity.ownerHash!==identity.ownerHash||entry.identity.targetHash!==identity.targetHash))return null;
      const settled=!(pending.get(identity.targetHash)??0);const blockers=[...c.blockers];if(!settled)blockers.push("provider_requests_pending");
      return {...c,operationId,identityBinding:"cop_attested_existing_router_alias",checks:{...c.checks,identityBindingReviewed:true,providerRequestsSettled:settled},blockers,ready:!blockers.length};},
    async request(identity,operationId){if(outage)throw Error("synthetic_store_down");const previous=operations.get(operationId);
      if(previous&&previous.identity.ownerHash!==identity.ownerHash)throw new AccountErasureError("erasure_operation_not_found");
      if(previous&&previous.identity.targetHash!==identity.targetHash)throw new AccountErasureError("erasure_operation_conflict");
      if([...operations.entries()].some(([id,e])=>id!==operationId&&e.identity.targetHash===identity.targetHash))throw new AccountErasureError("erasure_operation_conflict");
      const entry=previous??{identity,complete:false};operations.set(operationId,entry);keys.delete(identity.targetHash);
      if(retention&&restore&&!(pending.get(identity.targetHash)??0))entry.complete=true;return receipt(operationId,entry);},
    async status(identity,operationId){if(outage)throw Error("synthetic_store_down");const entry=operations.get(operationId);return entry&&entry.identity.ownerHash===identity.ownerHash&&entry.identity.targetHash===identity.targetHash?receipt(operationId,entry):null;},
    async processPending(){for(const entry of operations.values())if(retention&&restore&&!(pending.get(entry.identity.targetHash)??0))entry.complete=true;}
  };
  const reservations=new Map<string,string>();let sequence=0;
  const reserve=vi.fn(async(target:string)=>{await erase.assertActive(target);pending.set(target,(pending.get(target)??0)+1);const id=`req-${++sequence}`;reservations.set(id,target);return id;});
  const finish=vi.fn(async(id:string)=>{const target=reservations.get(id);if(target){pending.set(target,(pending.get(target)??1)-1);reservations.delete(id);}});
  const store={hashUser,policy:async()=>({externalAllowed:true,advancedAllowed:false}),reserve:vi.fn(async(client:string,user:string)=>reserve(hashUser(client,user))),finish} as unknown as BudgetStore;
  const separate={keyStatus:vi.fn(async(target:string)=>({configured:keys.has(target)})),putKey:vi.fn(async(target:string,key:string)=>{await erase.assertActive(target);keys.set(target,key);return{configured:true as const,fingerprint:"synthetic_fingerprint"};}),
    removeKey:vi.fn(async(target:string)=>{await erase.assertActive(target);keys.delete(target);}),getKey:vi.fn(async(target:string)=>keys.has(target)?{apiKey:keys.get(target)!,fingerprint:"synthetic_fingerprint"}:null),
    reserve:vi.fn(async(_source:string,_payer:string,actor:string)=>reserve(actor)),finish,usage:vi.fn(async()=>({}))} as unknown as SeparateBilling;
  return {erase,store,separate,operations,keys,pending,finish,flags:{setRetention:(v:boolean)=>{retention=v;},setRestore:(v:boolean)=>{restore=v;},setOutage:(v:boolean)=>{outage=v;}}};
}
function chatHeaders(alias=alias1){const now=Math.floor(Date.now()/1000);return signedText(JSON.stringify({sub:alias,aud:"sim-ai-router",iat:now,exp:now+60}));}
afterEach(()=>vi.unstubAllGlobals());

describe("purpose-bound account erasure actor",()=>{
  it("binds issuer/subject separately from the EXACT old COP alias",()=>{
    const actor=claims();expect(verifyErasureActor(req(headers(actor)),secret,issuer,op1)).toEqual(actor);
    const identity=erasureIdentity(actor,pepper,hashUser);
    expect(identity.targetHash).toBe(hashUser("cop",alias1));expect(identity.targetHash).not.toBe(hashUser("cop",actor.sub));
    expect(identity.ownerHash).not.toBe(erasureIdentity({...actor,iss:"https://other.example.invalid"},pepper,hashUser).ownerHash);
    expect(JSON.stringify(identity)).not.toContain(actor.sub);expect(JSON.stringify(identity)).not.toContain(alias1);
  });
  it("rejects wrong audience/issuer/operation, unknown keys and noncanonical/duplicate JSON",()=>{
    const actor=claims();const invalid=[{...actor,aud:"sim-ai-router"},{...actor,iss:"https://wrong.example.invalid"},{...actor,operationId:op2},{...actor,extra:true}];
    for(const item of invalid)expect(verifyErasureActor(req(signedText(JSON.stringify(item))),secret,issuer,op1)).toBeNull();
    for(const text of [JSON.stringify(actor,null,2),`{"sub":"x",${JSON.stringify(actor).slice(1)}`,JSON.stringify({...actor,sub:undefined})])expect(verifyErasureActor(req(signedText(text)),secret,issuer,op1)).toBeNull();
    const reversed=Object.fromEntries(Object.entries(actor).reverse());expect(verifyErasureActor(req(signedText(JSON.stringify(reversed))),secret,issuer,op1)).toBeNull();
  });
  it("enforces strict time relationships and raw-sub boundaries",()=>{
    const now=2000000000;const actor=claims(op1,"subject",alias1,now);
    for(const delta of [{iat:now+1},{exp:now},{exp:now+61},{iat:now-61},{iat:1.5},{sub:""},{sub:"x".repeat(513)},{sub:"x\u0000"},{sub:"x\u007f"},{sub:"x\u0085"}])expect(verifyErasureActor(req(headers({...actor,...delta})),secret,issuer,op1,now)).toBeNull();
    for(const sub of ["x","Český ověřený předmět","x".repeat(512)])expect(verifyErasureActor(req(headers({...actor,sub})),secret,issuer,op1,now)?.sub).toBe(sub);
  });
  it("rejects a correctly signed header containing invalid UTF-8 bytes",()=>{
    const text=JSON.stringify(claims());const raw=Buffer.from(text);const at=text.indexOf("synthetic-subject-one");
    const malformed=Buffer.concat([raw.subarray(0,at),Buffer.from([0xff]),raw.subarray(at+"synthetic-subject-one".length)]);
    const encoded=malformed.toString("base64url");const h={"x-cop-actor":encoded,"x-cop-actor-signature":createHmac("sha256",secret).update(encoded).digest("hex")};
    expect(verifyErasureActor(req(h),secret,issuer,op1)).toBeNull();
  });
});

describe("COP erasure HTTP owner boundary",()=>{
  it("uses the binding exact no-store header for owner probes, receipts and errors",async()=>{
    const f=fixture(),app=createApp(config,f.store,f.separate,f.erase);
    const responses=[
      await request(app).get(`${path}/capability`).set("authorization",`Bearer ${config.copToken}`).expect(200),
      await request(app).post(`${path}/preflight`).set(headers()).send(body()).expect(200),
      await request(app).post(path).set(headers()).send(body()).expect(200),
      await request(app).get(`${path}/${op1}`).set(headers()).expect(200),
      await request(app).get(`${path}/capability`).expect(401),
      await request(app).get(`${path}/capability`).set("authorization",`Bearer ${config.simToken}`).expect(403),
      await request(app).get(`${path}/capability`).set(headers()).expect(400),
      await request(app).get(`${path}/${op2}`).set(headers(claims(op2,"subject-two",alias2))).expect(404)
    ];
    const pendingFixture=fixture();pendingFixture.flags.setRetention(false);
    responses.push(await request(createApp(config,pendingFixture.store,pendingFixture.separate,pendingFixture.erase)).post(path).set(headers()).send(body()).expect(202));
    f.flags.setOutage(true);
    responses.push(await request(app).get(`${path}/capability`).set("authorization",`Bearer ${config.copToken}`).expect(503));
    for(const response of responses)expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("probes capability and disabled preflight without any writes/provider calls",async()=>{
    const f=fixture();const fetchMock=vi.fn();vi.stubGlobal("fetch",fetchMock);
    const app=createApp({...config,accountErasureEnabled:false},f.store,f.separate,f.erase);
    const cap=await request(app).get(`${path}/capability`).set("authorization",`Bearer ${config.copToken}`).expect(200);
    expect(cap.body.ready).toBe(false);expect(cap.body.blockers).toEqual(["erasure_disabled"]);expect(cap.headers["cache-control"]).toBe("no-store");
    const probe=await request(app).post(`${path}/preflight`).set(headers()).send(body()).expect(200);
    expect(probe.body.ready).toBe(false);expect(probe.body.checks.providerRequestsSettled).toBe(true);expect(probe.body.mutates).toBe(false);
    expect(f.operations.size).toBe(0);expect(f.keys.size).toBe(2);expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects invalid auth/browser/query/body and actor-bearing service capability",async()=>{
    const f=fixture();const app=createApp(config,f.store,f.separate,f.erase);
    await request(app).get(`${path}/capability`).expect(401);
    await request(app).get(`${path}/capability`).set("authorization",`Bearer ${config.simToken}`).expect(403);
    await request(app).get(`${path}/capability`).set(headers()).expect(400);
    await request(app).get(`${path}/capability?unexpected=1`).set("authorization",`Bearer ${config.copToken}`).expect(400);
    await request(app).get(`${path}/capability`).set("authorization",`Bearer ${config.copToken}`).send({}).expect(400);
    await request(app).post(path).set(headers()).set("Origin","https://browser.example.invalid").send(body()).expect(403);
    await request(app).post(path).set(headers()).send({...body(),userId:alias2}).expect(400);
    await request(app).post(path).set(chatHeaders()).send(body()).expect(401);
    const invalidGet=await request(app).get(`${path}/${op1}`).set(headers()).send({unexpected:true}).expect(400);
    expect(invalidGet.body.correlationId).toMatch(/^[a-f0-9-]{36}$/);expect(invalidGet.headers["cache-control"]).toBe("no-store");
    expect(f.operations.size).toBe(0);
  });
  it("isolates actors, immutable IDs, retry/restart and online-only receipts",async()=>{
    const f=fixture();const app=createApp(config,f.store,f.separate,f.erase);
    const one=await request(app).post(path).set(headers()).send(body()).expect(200);
    expect(one.body).toMatchObject({onlineScopeComplete:true,wholeAccountComplete:false,backupsComplete:false,providerRetentionComplete:false,aliasScope:"sim_izs_preserved_out_of_scope"});
    const restart=createApp(config,f.store,f.separate,f.erase);
    await request(restart).post(path).set(headers()).send(body()).expect(200);
    await request(restart).post(path).set(headers(claims(op1,"subject-two",alias2))).send(body()).expect(404);
    await request(restart).post(path).set(headers(claims(op1,"synthetic-subject-one",alias2))).send(body()).expect(409);
    const foreign=await request(restart).get(`${path}/${op1}`).set(headers(claims(op1,"subject-two",alias2))).expect(404);
    const missing=await request(restart).get(`${path}/${op2}`).set(headers(claims(op2,"subject-two",alias2))).expect(404);
    expect(foreign.body.error).toEqual(missing.body.error);
    for(const response of [foreign,missing]){expect(response.body.correlationId).toMatch(/^[a-f0-9-]{36}$/);expect(response.headers["x-correlation-id"]).toBe(response.body.correlationId);}
    expect(f.keys.has(hashUser("cop",alias2))).toBe(true);expect(f.operations.size).toBe(1);
    for(const method of ["get","put","delete"] as const){const r=request(restart)[method]("/api/v1/ai-router/cop/users/me/openai-key").set(chatHeaders());if(method==="put")r.send({apiKey:"sk-synthetic-replay-key-long-enough"});await r.expect(410);}
  });
  it("preserves pending review/restore and fails closed on store outages",async()=>{
    const f=fixture();f.flags.setRetention(false);f.flags.setRestore(false);
    const app=createApp(config,f.store,f.separate,f.erase);
    const pending=await request(app).post(path).set(headers()).send(body()).expect(202);
    expect(pending.body.pendingReasons).toEqual(["cost_retention_review_required","backup_replay_not_ready"]);
    const disabled=createApp({...config,accountErasureEnabled:false},f.store,f.separate,f.erase);
    await request(disabled).get(`${path}/${op1}`).set(headers()).expect(202);
    await request(disabled).post(path).set(headers()).send(body()).expect(202);
    await request(disabled).post(path).set(headers(claims(op2,"subject-two",alias2))).send(body(op2)).expect(503);
    f.flags.setOutage(true);
    await request(app).get(`${path}/${op1}`).set(headers()).expect(503);
    await request(app).get(`${path}/capability`).set("authorization",`Bearer ${config.copToken}`).expect(503);
  });
  it("bounds 70 synthetic service probes to 60/min without operations or provider calls",async()=>{
    const f=fixture();const fetchMock=vi.fn();vi.stubGlobal("fetch",fetchMock);const app=createApp(config,f.store,f.separate,f.erase);
    for(let i=0;i<70;i++){
      const response=await request(app).get(`${path}/capability`).set("authorization",`Bearer ${config.copToken}`);
      expect(response.status).toBe(i<60?200:429);
      expect(response.headers["cache-control"]).toBe("no-store");
      if(i>=60){expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);expect(response.body.error).toBe("erasure_rate_limited");}
    }
    expect(f.operations.size).toBe(0);expect(f.keys.size).toBe(2);expect(fetchMock).not.toHaveBeenCalled();
  });
  it("admits at most two simultaneous starts and releases slots after failure",async()=>{
    const f=fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let entered=0;
    const original=f.erase.request;f.erase.request=async(identity,id)=>{entered++;await gate;return original(identity,id);};
    const app=createApp(config,f.store,f.separate,f.erase);
    const first=request(app).post(path).set(headers()).send(body()).then(r=>r);
    const second=request(app).post(path).set(headers(claims(op2,"subject-two",alias2))).send(body(op2)).then(r=>r);
    for(let i=0;i<100&&entered<2;i++)await new Promise<void>(resolve=>setTimeout(resolve,1));
    expect(entered).toBe(2);
    await request(app).post(path).set(headers()).send(body()).expect(429);
    expect(f.operations.size).toBe(0);release();expect((await first).status).toBe(200);expect((await second).status).toBe(200);
    await request(app).post(path).set(headers()).send(body()).expect(200);
  });
  it.each(["byok","legacy"] as const)("discards late %s provider output but records conservative usage",async(lane)=>{
    const f=fixture();const app=createApp(config,f.store,f.separate,f.erase);
    let dispatch!:()=>void;const started=new Promise<void>(resolve=>{dispatch=resolve;});let complete!:(response:Response)=>void;
    vi.stubGlobal("fetch",vi.fn(async()=>{dispatch();return await new Promise<Response>(resolve=>{complete=resolve;});}));
    const target=lane==="byok"?"/api/v1/ai-router/cop/chat":"/api/v1/ai-router/generate";
    const payload=lane==="byok"?{contractVersion:"cop-chat-byok-v1",billingSource:"user_openai_key",question:"Syntetický dotaz.",allowExternal:true}:
      {taskType:"cop_chat",dataClass:"synthetic",prompt:"Syntetický dotaz.",userId:alias1,preference:"external",allowExternal:true,copContext:{contractVersion:"cop-chat-context-v1",dataClass:"synthetic",attestation:"cop-policy-reviewed-v1",scenarioId:"synthetic_test",facts:["Fiktivní událost."]}};
    const chat=request(app).post(target).set(chatHeaders()).send(payload).then(result=>result);
    await started;
    const erase=await request(app).post(path).set(headers()).send(body()).expect(202);
    expect(erase.body.pendingRequestCount).toBe(1);
    complete(new Response(JSON.stringify({output:[{content:[{type:"output_text",text:"MUST_NOT_RETURN_LATE_OUTPUT"}]}],usage:{input_tokens:10,output_tokens:5}}),{status:200}));
    const answer=await chat;expect(answer.status).toBe(410);expect(JSON.stringify(answer.body)).not.toContain("MUST_NOT_RETURN_LATE_OUTPUT");
    expect(f.finish).toHaveBeenCalledWith(expect.any(String),"success",10,5,expect.any(Number));
    await f.erase.processPending();await request(app).get(`${path}/${op1}`).set(headers()).expect(200);
  });
});
