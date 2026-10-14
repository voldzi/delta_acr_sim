import {createHmac} from "node:crypto";
import express from "express";
import request from "supertest";
import {describe,it,expect,vi} from "vitest";
import {registerDriverMeasurementRoutes,type DriverStore,type DriverSettings} from "../src/driver-measurements.js";
import {DRIVER_ACCOUNT_ERASURE_CONTRACT,DriverAccountErasureError,driverErasureRequiredDays,parseDriverErasureRequest,prepareDriverErasureInput,validateDriverErasureCoverage,verifyDriverErasureActor,
  type DriverErasureActor,type DriverErasureInput,type DriverErasureReceipt,type DriverErasureCapability} from "../src/driver-account-erasure.js";
import type {SituationDataConfig} from "../src/config.js";

const now=Date.parse("2026-10-14T12:00:00.000Z"),op="00000000-0000-4000-8000-000000000001",issuer="https://identity.example/realms/cop",secret="s".repeat(40),signer="a".repeat(40),token="t".repeat(40);
const collection="/api/v1/internal/driver-measurements/v1/account-erasure-operations";
function manifest(at=now){return {contractVersion:DRIVER_ACCOUNT_ERASURE_CONTRACT,operationId:op,
  contributors:driverErasureRequiredDays(at).map((day,i)=>({contributorDay:day,contributorIdDay:`d${i}`.padEnd(40,"x")})),attestation:"cop-account-erasure-contributors-reviewed-v1" as const};}
function claims(sub="synthetic-subject",at=now):DriverErasureActor{return {iss:issuer,sub,aud:"sim-account-erasure",iat:Math.floor(at/1000),exp:Math.floor(at/1000)+60,operationId:op,routerUserId:`cop_${"r".repeat(43)}`};}
function headers(actor=claims(),text=JSON.stringify(actor)){const encoded=Buffer.from(text).toString("base64url");return {Authorization:`Bearer ${token}`,"x-cop-actor":encoded,"x-cop-actor-signature":createHmac("sha256",signer).update(encoded).digest("hex")};}
function receipt():DriverErasureReceipt{return {contractVersion:DRIVER_ACCOUNT_ERASURE_CONTRACT,operationId:op,status:"pending",scope:"online_driver_scope",wholeAccountComplete:false,backupReplayRequired:true,
  acceptedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),contributorCount:9,deletedBatchCount:2,remainingBatchCount:0,databaseZeroVerified:true,
  derivedReportAcknowledged:false,reportProtection:"no_report",publicationFenceVerified:true,replayReady:true,retentionReviewed:true,pendingReason:"derived_report_pending"};}
function capability():DriverErasureCapability{return {contractVersion:DRIVER_ACCOUNT_ERASURE_CONTRACT,owner:"sim_measurements",scope:"online_driver_scope",enabled:true,ready:true,checkedAt:new Date(now).toISOString(),
  blockers:[],mutates:false,providerCalls:false,wholeAccountComplete:false,reportProtection:"no_report",checks:{schemaReady:true,permissionsReady:true,identityReviewed:true,restoreCheckpointCurrent:true,retentionReviewed:true,publicationFenceVerified:true}};}
function fixture(overrides:Partial<DriverSettings>={}){
  const ledger=new Map<string,{input:DriverErasureInput;result:DriverErasureReceipt}>();
  const bind=(input:DriverErasureInput)=>{const old=ledger.get(input.operationId);if(old&&old.input.actorHash!==input.actorHash)throw new DriverAccountErasureError(404,"DRIVER_ACCOUNT_ERASURE_NOT_FOUND");
    if(old&&old.input.requestHash!==input.requestHash)throw new DriverAccountErasureError(409,"DRIVER_ACCOUNT_ERASURE_CONFLICT");return old;};
  const store:DriverStore={lookup:vi.fn(async()=>undefined),commit:vi.fn(async(_owner,_contributor,_hash,_batch,_intervals,r)=>r),aggregates:vi.fn(async()=>[]),quality:vi.fn(async()=>({})),revoke:vi.fn(async()=>0),close:vi.fn(async()=>{}),
    accountErasure:vi.fn(async input=>{const old=bind(input);if(!old)validateDriverErasureCoverage(input,now);const result=old?.result??receipt();ledger.set(input.operationId,{input,result});return result;}),
    acknowledgeAccountErasure:vi.fn(async input=>{const old=bind(input)!;old.result={...old.result,status:"completed",derivedReportAcknowledged:true,pendingReason:null};return old.result;}),
    accountErasureStatus:vi.fn(async(id,actorHash)=>{const old=ledger.get(id);return old?.input.actorHash===actorHash?old.result:undefined;}),
    accountErasureCapability:vi.fn(async()=>capability()),accountErasurePreflight:vi.fn(async input=>{const old=bind(input);validateDriverErasureCoverage(input,old?Date.parse(old.result.acceptedAt):now);const c=capability();return {...c,
      checks:{...c.checks,identityBindingReviewed:true,manifestShapeAndCoverageValid:true},operationId:input.operationId,manifestValid:true,identityBinding:"cop_attested_daily_manifest",contributorCount:input.contributors.length,
      coverageAnchor:{kind:old?"first_accepted_at":"checked_at",at:old?.result.acceptedAt??new Date(now).toISOString()}};})};
  const matcher={match:vi.fn(async()=>{throw new Error("must not call provider");}),dataset:vi.fn(async()=>{throw new Error("must not call provider");})};
  const settings:DriverSettings={enabled:false,revocationEnabled:true,ratePerMinute:120,token,hashSecret:secret,driverAccountErasureEnabled:true,driverAccountErasureActorSecret:signer,driverAccountErasureIssuer:issuer,...overrides};
  const app=express();app.use(express.json());registerDriverMeasurementRoutes(app,{} as SituationDataConfig,settings,{store,matcher,now:()=>now});return {app,store,matcher,ledger,settings};
}
describe("driver erasure exact request and identity",()=>{
  it("covers all retained UTC dates and next-day tolerance without truncation",()=>{
    const parsed=parseDriverErasureRequest(manifest()),input=prepareDriverErasureInput(parsed,claims(),secret);validateDriverErasureCoverage(input,now);
    expect(input.contributors).toHaveLength(9);expect(driverErasureRequiredDays(Date.parse("2026-10-14T23:59:40Z"))).toHaveLength(10);
    expect(()=>validateDriverErasureCoverage(input,Date.parse("2026-10-14T23:59:40Z"))).toThrow("INCOMPLETE_MANIFEST");
    const text=JSON.stringify(input);expect(text).not.toContain(claims().sub);expect(text).not.toContain(claims().routerUserId);expect(text).not.toContain(parsed.contributors[0].contributorIdDay);
    const reordered={...parsed,contributors:[...parsed.contributors].reverse()};expect(prepareDriverErasureInput(parseDriverErasureRequest(reordered),claims("synthetic-subject",now+1000),secret).requestHash).toBe(input.requestHash);
  });
  it("accepts bounded older retained/outbox days while still requiring the full recent interval",()=>{
    const m=manifest();m.contributors.push({contributorDay:"2026-09-29",contributorIdDay:"old-a".padEnd(40,"x")},{contributorDay:"2026-09-29",contributorIdDay:"old-b".padEnd(40,"x")});
    const parsed=parseDriverErasureRequest(m),input=prepareDriverErasureInput(parsed,claims(),secret);expect(()=>validateDriverErasureCoverage(input,now)).not.toThrow();expect(input.contributors).toHaveLength(11);
    const missing={...input,contributors:input.contributors.filter(c=>c.contributorDay!=="2026-10-08")};expect(()=>validateDriverErasureCoverage(missing,now)).toThrow("INCOMPLETE_MANIFEST");
    const future={...input,contributors:[...input.contributors,{contributorDay:"2026-10-15",contributorHash:"f".repeat(64)}]};expect(()=>validateDriverErasureCoverage(future,now)).toThrow("INCOMPLETE_MANIFEST");
    const late=Date.parse("2026-10-14T23:59:40Z"),allowed=prepareDriverErasureInput(parseDriverErasureRequest(manifest(late)),claims(),secret);expect(()=>validateDriverErasureCoverage(allowed,late)).not.toThrow();
    expect(()=>validateDriverErasureCoverage({...allowed,contributors:[...allowed.contributors,{contributorDay:"2026-10-16",contributorHash:"f".repeat(64)}]},late)).toThrow("INCOMPLETE_MANIFEST");
    const retry=prepareDriverErasureInput(parsed,claims("synthetic-subject",Date.parse("2026-10-15T00:01:00Z")),secret);expect(retry.requestHash).toBe(input.requestHash);expect(()=>validateDriverErasureCoverage(retry,now)).not.toThrow();
  });
  it.each([
    (m:any)=>{m.email="private@example.invalid";},(m:any)=>{m.contributors[0].lat=50;},(m:any)=>{m.contributors[0].contributorDay="2026-02-30";},
    (m:any)=>{m.contributors[0].contributorDay="9999-99-99";},(m:any)=>{m.contributors[0].contributorIdDay="short";},(m:any)=>{m.attestation="automatic";},
    (m:any)=>{m.contributors=m.contributors.slice(0,8);},(m:any)=>{m.contributors=Array.from({length:41},(_,i)=>({...m.contributors[0],contributorIdDay:`v${i}`.padEnd(40,"x")}));},
    (m:any)=>{m.contributors[1]={...m.contributors[0]};},(m:any)=>{m.operationId="person@example.invalid";}
  ])("rejects invalid/unknown manifest structure",change=>{const m=manifest();change(m);expect(()=>parseDriverErasureRequest(m)).toThrow("DRIVER_ACCOUNT_ERASURE_INVALID");});
  it("validates the exact seven-claim purpose actor",()=>{const h=headers();expect(verifyDriverErasureActor(h["x-cop-actor"],h["x-cop-actor-signature"],signer,issuer,op,now)).toEqual(claims());});
  it.each([
    (c:any)=>{c.iss="https://other.example/realms/cop";},(c:any)=>{c.aud="sim-ai-router";},(c:any)=>{c.exp=c.iat;},(c:any)=>{c.exp=c.iat+61;},
    (c:any)=>{c.exp=Math.floor(now/1000);},(c:any)=>{c.iat=Math.floor(now/1000)+1;c.exp=c.iat+60;},(c:any)=>{c.sub="private\u0085subject";},
    (c:any)=>{c.sub="private\u0001subject";},(c:any)=>{c.routerUserId="subject";},(c:any)=>{c.operationId="00000000-0000-4000-8000-000000000002";},(c:any)=>{c.account="other";}
  ])("rejects wrong actor identity, scope, lifetime and unknown claims",change=>{const c=claims();change(c);const h=headers(c);expect(()=>verifyDriverErasureActor(h["x-cop-actor"],h["x-cop-actor-signature"],signer,issuer,op,now)).toThrow("ACTOR_INVALID");});
  it("rejects duplicate/reordered JSON and invalid signatures",()=>{
    const c=claims();for(const text of [JSON.stringify({...c,sub:c.sub}).replace('"sub":','"sub":"duplicate","sub":'),JSON.stringify({sub:c.sub,iss:c.iss,aud:c.aud,iat:c.iat,exp:c.exp,operationId:c.operationId,routerUserId:c.routerUserId})]){
      const h=headers(c,text);expect(()=>verifyDriverErasureActor(h["x-cop-actor"],h["x-cop-actor-signature"],signer,issuer,op,now)).toThrow("ACTOR_INVALID");}
    const h=headers();expect(()=>verifyDriverErasureActor(h["x-cop-actor"],"0".repeat(64),signer,issuer,op,now)).toThrow("ACTOR_INVALID");
  });
});
describe("driver erasure HTTP boundary and passive probes",()=>{
  it("enforces bearer, rejects browsers, and keeps flags independent",async()=>{
    const f=fixture();expect((await request(f.app).post(collection).send(manifest())).status).toBe(401);
    expect((await request(f.app).post(collection).set(headers()).set("Origin","https://cop.example").send(manifest())).status).toBe(403);
    const r=await request(f.app).post(collection).set(headers()).send(manifest());expect(r.status).toBe(200);expect(r.body.wholeAccountComplete).toBe(false);expect(r.body.backupReplayRequired).toBe(true);
    expect(f.matcher.match).not.toHaveBeenCalled();expect(f.matcher.dataset).not.toHaveBeenCalled();expect(f.store.commit).not.toHaveBeenCalled();
    expect((await request(f.app).post("/api/v1/internal/driver-measurements/v1/batches").set(headers()).send({})).status).toBe(503);
  });
  it("capability is bearer-only and cannot mutate or accept actor/query/body",async()=>{
    const f=fixture();expect((await request(f.app).get(`${collection}/capability`)).status).toBe(401);
    const r=await request(f.app).get(`${collection}/capability`).set("Authorization",`Bearer ${token}`);expect(r.status).toBe(200);expect(r.body.ready).toBe(true);expect(r.body.mutates).toBe(false);expect(r.headers["cache-control"]).toBe("no-store");
    expect((await request(f.app).get(`${collection}/capability`).set(headers())).status).toBe(400);
    expect((await request(f.app).get(`${collection}/capability?user=target`).set("Authorization",`Bearer ${token}`)).status).toBe(400);
    expect((await request(f.app).get(`${collection}/capability`).set("Authorization",`Bearer ${token}`).send({user:"target"})).status).toBe(400);
    expect(f.store.accountErasure).not.toHaveBeenCalled();expect(f.store.revoke).not.toHaveBeenCalled();
  });
  it("read-only preflight and GET never advance durable operations",async()=>{
    const f=fixture(),p=await request(f.app).post(`${collection}/preflight`).set(headers()).send(manifest());expect(p.status).toBe(200);expect(p.body.coverageAnchor.kind).toBe("checked_at");expect(p.body.identityBinding).toBe("cop_attested_daily_manifest");
    expect(f.store.accountErasure).not.toHaveBeenCalled();expect(f.ledger.size).toBe(0);
    expect((await request(f.app).get(`${collection}/${op}`).set(headers())).status).toBe(404);
    await request(f.app).post(collection).set(headers()).send(manifest());const count=(f.store.accountErasure as any).mock.calls.length;
    const status=await request(f.app).get(`${collection}/${op}`).set(headers());expect(status.status).toBe(200);expect((f.store.accountErasure as any).mock.calls).toHaveLength(count);
    expect((await request(f.app).get(`${collection}/${op}`).set(headers(claims("other-subject")))).status).toBe(404);
    const again=await request(f.app).post(`${collection}/preflight`).set(headers()).send(manifest());expect(again.body.coverageAnchor.kind).toBe("first_accepted_at");
  });
  it("preserves all older inventory through preflight and erase without widening another actor's scope",async()=>{
    const f=fixture(),m=manifest();m.contributors.push({contributorDay:"2026-09-29",contributorIdDay:"historical-a".padEnd(40,"x")},{contributorDay:"2026-09-29",contributorIdDay:"historical-b".padEnd(40,"x")});
    const p=await request(f.app).post(`${collection}/preflight`).set(headers()).send(m);expect(p.status).toBe(200);expect(p.body.contributorCount).toBe(11);expect(f.ledger.size).toBe(0);
    expect((await request(f.app).post(collection).set(headers()).send(m)).status).toBe(200);expect((f.store.accountErasure as any).mock.calls[0][0].contributors).toHaveLength(11);
    expect((await request(f.app).post(`${collection}/preflight`).set(headers(claims("other-subject"))).send(m)).status).toBe(404);
    expect((await request(f.app).post(collection).set(headers(claims("other-subject"))).send(m)).status).toBe(404);
    const changed=manifest();expect((await request(f.app).post(collection).set(headers()).send(changed)).status).toBe(409);expect(f.ledger.size).toBe(1);
  });
  it("rejects changed immutable requests and never joins other actors",async()=>{
    const f=fixture();await request(f.app).post(collection).set(headers()).send(manifest());
    const changed=manifest();changed.contributors[0].contributorIdDay="z".repeat(40);expect((await request(f.app).post(collection).set(headers()).send(changed)).status).toBe(409);
    expect((await request(f.app).post(collection).set(headers(claims("other-subject"))).send(manifest())).status).toBe(404);
    const replay=await request(f.app).post(collection).set(headers()).send(manifest());expect(replay.status).toBe(200);expect(f.ledger.size).toBe(1);
  });
  it("missing issuer/actor, limit and disabled operations fail closed",async()=>{
    const no=fixture({driverAccountErasureIssuer:undefined});expect((await request(no.app).post(collection).set(headers()).send(manifest())).status).toBe(401);
    const c=await request(no.app).get(`${collection}/capability`).set("Authorization",`Bearer ${token}`);expect(c.body.ready).toBe(false);expect(c.body.blockers).toContain("identity_review_required");
    const off=fixture({driverAccountErasureEnabled:false});expect((await request(off.app).post(collection).set(headers()).send(manifest())).status).toBe(503);
    const low=fixture({ratePerMinute:1});await request(low.app).get(`${collection}/capability`).set("Authorization",`Bearer ${token}`);expect((await request(low.app).post(collection).set(headers()).send(manifest())).status).toBe(429);
  });
  it("disabled start permits only an already accepted own operation, while probes stay read-only",async()=>{
    const f=fixture();await request(f.app).post(collection).set(headers()).send(manifest());f.settings.driverAccountErasureEnabled=false;
    const p=await request(f.app).post(`${collection}/preflight`).set(headers()).send(manifest());expect(p.status).toBe(200);expect(p.body.enabled).toBe(false);expect(p.body.ready).toBe(false);expect(p.body.blockers).toContain("erasure_disabled");
    expect((await request(f.app).get(`${collection}/${op}`).set(headers())).status).toBe(200);
    expect((await request(f.app).post(collection).set(headers()).send(manifest())).status).toBe(200);
    const fresh=fixture({driverAccountErasureEnabled:false});expect((await request(fresh.app).post(collection).set(headers()).send(manifest())).status).toBe(503);expect(fresh.store.accountErasure).not.toHaveBeenCalled();expect(fresh.ledger.size).toBe(0);
    const calls=(f.store.accountErasure as any).mock.calls.length;expect((await request(f.app).post(collection).set(headers(claims("other-subject"))).send(manifest())).status).toBe(503);expect((f.store.accountErasure as any).mock.calls).toHaveLength(calls);
  });
  it("does not acknowledge unverified publication or storage failures",async()=>{
    const f=fixture();(f.store.accountErasure as any).mockResolvedValue({...receipt(),reportProtection:"unverified",publicationFenceVerified:false,pendingReason:"publisher_review_required"});
    expect((await request(f.app).post(collection).set(headers()).send(manifest())).status).toBe(202);expect(f.store.acknowledgeAccountErasure).not.toHaveBeenCalled();
    (f.store.accountErasure as any).mockRejectedValue(new Error("postgres://private gps=secret"));const r=await request(f.app).post(collection).set(headers()).send(manifest());expect(r.status).toBe(503);expect(JSON.stringify(r.body)).not.toContain("private");
  });
});
