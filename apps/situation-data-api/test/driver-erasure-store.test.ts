import {describe,it,expect,vi} from "vitest";
import type {Pool} from "pg";
import {PostgresDriverAccountErasureStore,type DriverErasureProtectedProof} from "../src/driver-account-erasure-store.js";
import {driverErasureHash,driverErasureRequiredDays,type DriverErasureInput} from "../src/driver-account-erasure.js";
const secret="s".repeat(40),checkpoint="c".repeat(40),now=Date.parse("2026-10-14T12:00:00.000Z"),op="00000000-0000-4000-8000-000000000001";
function input():DriverErasureInput{return {operationId:op,actorHash:"a".repeat(64),requestHash:"b".repeat(64),contributors:driverErasureRequiredDays(now).map((day,i)=>({contributorDay:day,contributorHash:String(i).repeat(64)}))};}
const proof:DriverErasureProtectedProof={checkpoint,restoreCheckpointCurrent:true,identityReviewed:true,retentionReviewed:true,publicationFenceVerified:true,reportProtection:"no_report"};
function fixture(options:{schema?:boolean;active?:boolean;external?:boolean;proof?:Partial<DriverErasureProtectedProof>;permissions?:boolean}={}){
  const rows=new Map<string,Record<string,any>>(),fences=new Set<string>(),calls:Array<{sql:string;params:unknown[]}>=[];
  let receipts=2,clock=now;
  const query=vi.fn(async(sql:string,params:unknown[]=[])=>{
    calls.push({sql,params});const result=(values:unknown[])=>({rows:values,rowCount:values.length});
    if(sql.includes("pg_trigger"))return result([{at:new Date(clock),installed:options.schema!==false}]);
    if(sql.includes("pg_roles WHERE"))return result([{ready:options.permissions!==false}]);
    if(sql.includes("proof_valid_until>now()"))return result([{valid:true,replay_ready:true,replay_checkpoint_hash:driverErasureHash(secret,"cop:account-erasure-checkpoint",checkpoint),retention_reviewed:true,report_protection:"no_report",publication_fence_verified:true}]);
    if(sql.includes("AS operations,"))return result([{operations:options.active===true,fences:options.active===true}]);
    if(sql.includes(" AS active"))return result([{active:options.active===true||rows.size>0||fences.size>0}]);
    if(sql.includes("clock_timestamp()"))return result([{at:new Date(clock)}]);
    if(sql.startsWith("SELECT * FROM driver_account_erasure_operations")||sql.startsWith("SELECT actor_hash,request_hash,created_at")){
      const row=rows.get(params[0] as string);return result(row&&(!sql.includes("AND actor_hash")||row.actor_hash===params[1])?[{...row}]:[]);}
    if(sql.startsWith("INSERT INTO driver_account_erasure_operations")){
      rows.set(params[0] as string,{actor_hash:params[1],request_hash:params[2],contributor_count:params[3],created_at:new Date(clock),updated_at:new Date(clock),deleted_batch_count:0,remaining_batch_count:0,database_zero_verified:false,derived_report_acknowledged:false,replay_checkpoint_hash:null,status:"pending"});return result([]);}
    if(sql.startsWith("INSERT INTO driver_account_erasure_revocations")){for(const h of params[0] as string[])fences.add(h);return result([]);}
    if(sql.startsWith("SELECT 1 FROM driver_account_erasure_revocations"))return result(fences.has(params[1] as string)?[{}]:[]);
    if(sql.startsWith("DELETE FROM driver_measurement_receipts")){const n=receipts;receipts=0;return {rows:[],rowCount:n};}
    if(sql.includes("count(*)::integer AS n"))return result([{n:receipts}]);
    if(sql.startsWith("UPDATE driver_account_erasure_operations")){
      const row=rows.get(params[0] as string)!;row.updated_at=new Date(clock);
      if(sql.includes("deleted_batch_count=deleted_batch_count")){row.deleted_batch_count+=params[1] as number;row.remaining_batch_count=params[2];row.database_zero_verified=params[3];row.derived_report_acknowledged=false;row.status="pending";row.replay_checkpoint_hash=params[4];}
      else{row.remaining_batch_count=params[1];row.database_zero_verified=params[2];row.derived_report_acknowledged=params[3];row.status=params[4];row.replay_checkpoint_hash=params[5];}
      return result([{...row}]);}
    return result([]);
  });
  const pool={query,connect:async()=>({query,release:vi.fn()})} as unknown as Pool;
  const protectedProof=options.external===false?undefined:vi.fn(async()=>({...proof,...options.proof}));
  const store=new PostgresDriverAccountErasureStore(pool,secret,{enabled:true,identityConfigured:true,expectedCheckpoint:checkpoint,protectedProof});
  return {store,rows,fences,calls,protectedProof,setClock:(at:number)=>{clock=at;}};
}
describe("driver erasure durable evidence and passive gates",()=>{
  it("old ready DB state without the current protected guard is never ready",async()=>{
    const f=fixture({external:false}),cap=await f.store.capability();expect(cap.ready).toBe(false);expect(cap.blockers).toContain("restore_checkpoint_not_current");
    await expect(f.store.erase(input())).rejects.toMatchObject({code:"DRIVER_ACCOUNT_ERASURE_NOT_READY"});expect(f.rows.size).toBe(0);expect(f.fences.size).toBe(0);
  });
  it.each(["restoreCheckpointCurrent","identityReviewed","retentionReviewed","publicationFenceVerified"] as const)("requires an independently current %s proof",async field=>{
    const f=fixture({proof:{[field]:false}});expect((await f.store.capability()).ready).toBe(false);await expect(f.store.erase(input())).rejects.toMatchObject({status:503});expect(f.rows.size).toBe(0);
  });
  it("requires actual schema, invoker trigger and restricted privileges",async()=>{
    for(const options of [{schema:false},{permissions:false}]){const f=fixture(options);expect((await f.store.capability()).ready).toBe(false);await expect(f.store.erase(input())).rejects.toMatchObject({status:503});}
  });
  it("passive preflight checks coverage but creates no ledger, fence or mutation",async()=>{
    const f=fixture(),p=await f.store.preflight(input());expect(p.ready).toBe(true);expect(p.coverageAnchor).toEqual({kind:"checked_at",at:p.checkedAt});expect(f.rows.size).toBe(0);expect(f.fences.size).toBe(0);
    expect(f.calls.some(call=>/^(INSERT|UPDATE|DELETE|TRUNCATE)/.test(call.sql))).toBe(false);
  });
  it("retains all bounded older days and key versions in the ephemeral operation without a durable join",async()=>{
    const f=fixture(),i=input();i.contributors.push({contributorDay:"2026-09-29",contributorHash:"a".repeat(64)},{contributorDay:"2026-09-29",contributorHash:"b".repeat(64)});
    const p=await f.store.preflight(i);expect(p.contributorCount).toBe(11);expect(f.rows.size).toBe(0);expect(f.fences.size).toBe(0);
    const r=await f.store.erase(i);expect(r.contributorCount).toBe(11);expect(f.fences.size).toBe(11);expect(r.deletedBatchCount).toBe(2);
    const raw=JSON.stringify([...f.rows]);expect(raw).not.toContain("2026-09-29");expect(raw).not.toContain("contributorHash");expect(raw).not.toContain(op);
    expect(await f.store.status(op,"z".repeat(64))).toBeUndefined();await expect(f.store.erase({...i,actorHash:"z".repeat(64)})).rejects.toMatchObject({status:404});
  });
  it("a midnight retry retains its original accepted anchor and immutable full inventory",async()=>{
    const f=fixture(),i=input();i.contributors.push({contributorDay:"2026-09-29",contributorHash:"a".repeat(64)},{contributorDay:"2026-09-29",contributorHash:"b".repeat(64)});
    const original=await f.store.erase(i);f.setClock(Date.parse("2026-10-15T00:01:00Z"));
    const p=await f.store.preflight(i);expect(p.coverageAnchor).toEqual({kind:"first_accepted_at",at:original.acceptedAt});expect(p.checkedAt).toBe("2026-10-15T00:01:00.000Z");
    const replay=await f.store.erase(i);expect(replay.acceptedAt).toBe(original.acceptedAt);expect(replay.deletedBatchCount).toBe(2);expect(replay.contributorCount).toBe(11);expect(f.rows.size).toBe(1);
    await expect(f.store.erase({...i,requestHash:"c".repeat(64)})).rejects.toMatchObject({status:409});
  });
  it("an acknowledged online receipt remains separate from whole-account and backup completion",async()=>{
    const f=fixture(),i=input(),start=await f.store.erase(i);expect(start.status).toBe("pending");expect(start.deletedBatchCount).toBe(2);expect(f.fences.size).toBe(9);
    const done=await f.store.acknowledge(i);expect(done.status).toBe("completed");expect(done.wholeAccountComplete).toBe(false);expect(done.backupReplayRequired).toBe(true);
    expect(await f.store.status(op,i.actorHash)).toEqual(done);
    const replay=await f.store.erase(i);expect(replay.deletedBatchCount).toBe(2);expect(replay.status).toBe("pending");await f.store.acknowledge(i);expect(f.rows.size).toBe(1);
    const stored=JSON.stringify([...f.rows]);expect(stored).not.toContain(op);expect(stored).not.toContain("contributorHash");expect(stored).not.toContain("2026-10-06");
  });
  it("cross-actor status and start are non-disclosing 404; changed digest is 409",async()=>{
    const f=fixture(),i=input();await f.store.erase(i);expect(await f.store.status(op,"z".repeat(64))).toBeUndefined();
    await expect(f.store.erase({...i,actorHash:"z".repeat(64)})).rejects.toMatchObject({status:404});
    await expect(f.store.erase({...i,requestHash:"c".repeat(64)})).rejects.toMatchObject({status:409});
  });
  it("sorted accountless locks precede deletion and late daily commits remain fenced",async()=>{
    const f=fixture(),i=input();i.contributors.reverse();await f.store.erase(i);
    const locks=f.calls.filter(call=>call.sql.includes("pg_advisory_xact_lock")).map(call=>call.params[0] as string);expect(locks.slice(1)).toEqual(i.contributors.map(c=>`cop:${c.contributorHash}`).sort());
    await expect(f.store.assertIntake({query:vi.fn(async(sql:string,params:unknown[])=>{
      if(sql.startsWith("SELECT 1 FROM driver_account_erasure_revocations"))return {rows:[{}],rowCount:1};return (f as any).store.pool.query(sql,params);
    })} as any,"cop",i.contributors[0].contributorHash)).rejects.toMatchObject({code:"DRIVER_CONSENT_REVOKED"});
  });
  it("a missing trigger with existing erasure evidence cannot permit intake",async()=>{
    const f=fixture({schema:false,active:true});await expect(f.store.assertIntake((f.store as any).pool,"cop")).rejects.toMatchObject({code:"DRIVER_ACCOUNT_ERASURE_REPLAY_REQUIRED"});
  });
  it("GET is a read-only snapshot and never reprocesses the ephemeral manifest",async()=>{
    const f=fixture(),i=input();await f.store.erase(i);f.calls.length=0;const status=await f.store.status(op,i.actorHash);expect(status?.status).toBe("pending");
    expect(f.calls[0].sql).toContain("REPEATABLE READ READ ONLY");expect(f.calls.some(call=>/^(INSERT|UPDATE|DELETE)/.test(call.sql))).toBe(false);
  });
});
