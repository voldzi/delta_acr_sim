import {describe,it,expect,vi} from "vitest";
import type {Pool} from "pg";
import {PostgresDriverAccountErasureStore} from "../src/driver-account-erasure-store.js";
import {driverErasureHash,driverErasureRequiredDays,type DriverErasureInput} from "../src/driver-account-erasure.js";
import type {DriverGuardedExecutionRequest,DriverGuardedExecutionResult,DriverGuardedOperationContext,DriverGuardedReadRequest,DriverGuardedRecordRef,DriverGuardedStoreOptions} from "../src/driver-guarded-execution-port.js";
import {DriverReadFactsError,matchDriverReadPolicy} from "../../../deploy/driver-measurements/read-admission-facts.mjs";

// All ports, references and rows below are synthetic mocks. Passing these tests
// proves application control flow, NOT signed Root delivery or production use.
const secret="s".repeat(40),checkpoint="c".repeat(40),now=Date.parse("2026-10-14T12:00:00.000Z");
const business="00000000-0000-4000-8000-000000000001",origin="10000000-0000-4000-8000-000000000001";
const checkpointHash=driverErasureHash(secret,"cop:account-erasure-checkpoint",checkpoint);
const syntheticPolicy={storeIncarnation:"30000000-0000-4000-8000-000000000001",checkpointHash,schemaFingerprint:"7".repeat(64),privilegeFingerprint:"8".repeat(64),reportProtection:"no_report"};
const input=():DriverErasureInput=>({operationId:business,actorHash:"a".repeat(64),requestHash:"b".repeat(64),contributors:driverErasureRequiredDays(now).map((day,index)=>({contributorDay:day,contributorHash:index.toString(16).repeat(64)}))});
const context=(kind:"erase"|"ack"="erase"):DriverGuardedOperationContext=>({operation:{operationId:origin,kind}});
const mutationScope={recordId:"70000000-0000-4000-8000-000000000001",digest:"7".repeat(64)};
const publication={contractVersion:"cop-driver-publication-context-v1" as const,recordId:"20000000-0000-4000-8000-000000000001",recordDigest:"1".repeat(64),storeIncarnation:"30000000-0000-4000-8000-000000000001",operationDigest:"2".repeat(64),readbackDigest:"3".repeat(64),reportProtection:"no_report" as const,observedAtUTC:"2026-10-14T12:00:00.000Z"};
function outcome(id:string,state:"origin-commit-known"|"origin-no-effects-closed"|"pending"="origin-commit-known"):DriverGuardedExecutionResult{
  const binding={contractVersion:"cop-driver-origin-result-v1" as const,operationId:id};
  return state==="pending"?{...binding,state,reason:"origin-unresolved"}:{...binding,state,
    sqlOutcomeRef:{recordId:"40000000-0000-4000-8000-000000000001",digest:"4".repeat(64)},
    effectQuiescenceRef:{recordId:"50000000-0000-4000-8000-000000000001",digest:"5".repeat(64)}};
}
function fixture(options:{enabled?:boolean;execution?:boolean;admission?:boolean;permissions?:boolean;state?:"origin-commit-known"|"origin-no-effects-closed"|"pending"|"throw";
  admissionPatch?:Record<string,unknown>;mutationScopeRef?:DriverGuardedRecordRef;onInspect?:()=>void;onExecute?:(request:DriverGuardedExecutionRequest)=>void}={}){
  const rows=new Map<string,Record<string,any>>(),calls:Array<{sql:string;params:unknown[]}>=[];
  const database={checkpointHash,protection:"no_report",valid:true};
  const result=(values:unknown[])=>({rows:values,rowCount:values.length});
  const query=vi.fn(async(sql:string,params:unknown[]=[])=>{
    calls.push({sql,params});
    if(/^(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i.test(sql.trim()))throw new Error("Synthetic runtime pool forbids DML/DDL");
    if(sql.includes("pg_trigger"))return result([{at:new Date(now),installed:true}]);
    if(sql.includes("FROM pg_roles WHERE"))return result([{ready:options.permissions!==false}]);
    if(sql.includes("proof_valid_until>now()"))return result([{valid:database.valid,replay_ready:true,replay_checkpoint_hash:database.checkpointHash,retention_reviewed:true,report_protection:database.protection,publication_fence_verified:true}]);
    if(sql.includes(" AS active"))return result([{active:rows.size>0}]);
    if(sql.includes("clock_timestamp()"))return result([{at:new Date(now)}]);
    if(sql.startsWith("SELECT * FROM driver_account_erasure_operations")||sql.startsWith("SELECT actor_hash,request_hash,created_at")){
      const row=rows.get(params[0] as string);return result(row&&(!sql.includes("AND actor_hash")||row.actor_hash===params[1])?[{...row}]:[]);
    }
    return result([]);
  });
  const pool={query,connect:vi.fn(async()=>({query,release:vi.fn()}))} as unknown as Pool;
  const execute=vi.fn(async(request:DriverGuardedExecutionRequest)=>{options.onExecute?.(request);if(options.state==="throw")throw new Error("Synthetic unavailable transport");return outcome(request.operation.operationId,options.state);});
  const probe=vi.fn(async(operation:{operationId:string})=>outcome(operation.operationId));
  const observations:Array<{purpose:DriverGuardedReadRequest["purpose"];hasOperation:boolean}>=[];
  const readScopes:Array<DriverGuardedRecordRef|undefined>=[];
  const inspect=vi.fn(async(request:DriverGuardedReadRequest,expectedScope?:DriverGuardedRecordRef)=>{
    readScopes.push(expectedScope);options.onInspect?.();
    const row=request.operationHash?rows.get(request.operationHash):undefined;
    const owned=row?.actor_hash===request.actorHash?row:undefined;
    const operation=owned?{operationHash:request.operationHash,actorHash:owned.actor_hash,requestHash:owned.request_hash,contributorCount:owned.contributor_count,
      status:owned.status,createdAtUTC:owned.created_at.toISOString(),updatedAtUTC:owned.updated_at.toISOString(),deletedBatchCount:owned.deleted_batch_count,
      remainingBatchCount:owned.remaining_batch_count,databaseZeroVerified:owned.database_zero_verified,derivedReportAcknowledged:owned.derived_report_acknowledged,
      replayCheckpointHash:owned.replay_checkpoint_hash,ledgerDigest:"9".repeat(64)}:null;
    observations.push({purpose:request.purpose,hasOperation:operation!==null});
    // Exercise the real pure target-facts boundary: preflight may have no row;
    // receipt may not. These synthetic facts still provide NO Root authority.
    try{matchDriverReadPolicy({contractVersion:"sim-driver-read-facts-v1",request,observedAtUTC:new Date(now).toISOString(),storeIncarnation:syntheticPolicy.storeIncarnation,
      state:{checkpointHash:database.checkpointHash,replayReady:true,proofValidUntilUTC:new Date(now+60_000).toISOString(),proofCurrent:database.valid,
        retentionReviewed:true,reportProtection:database.protection,publicationFenceVerified:true},
      schema:{ready:true,fingerprint:syntheticPolicy.schemaFingerprint},privileges:{runtimeProfileMatches:options.permissions!==false,fingerprint:syntheticPolicy.privilegeFingerprint},operation},request,syntheticPolicy,now);
    }catch(error){if(error instanceof DriverReadFactsError)return undefined;throw error;}
    const common={...request,checkpointHash,reportProtection:"no_report" as const,
      reference:{recordId:"60000000-0000-4000-8000-000000000001",digest:"6".repeat(64)}};
    if(options.mutationScopeRef){
      if(!["preflight","status","receipt"].includes(request.purpose))return undefined;
      return {contractVersion:"sim-driver-mutation-read-admission-v2" as const,...common,
        purpose:request.purpose as "preflight"|"status"|"receipt",operationHash:request.operationHash!,actorHash:request.actorHash!,
        mutationScopeRef:{...options.mutationScopeRef},...options.admissionPatch};
    }
    return {contractVersion:"sim-driver-guarded-read-admission-v1" as const,...common,...options.admissionPatch};
  });
  const protectedProof=vi.fn(async()=>({checkpoint,identityReviewed:true,restoreCheckpointCurrent:true,retentionReviewed:true,publicationFenceVerified:true,reportProtection:"no_report" as const}));
  const guarded:DriverGuardedStoreOptions={...(options.execution===false?{}:{execution:{execute,probe}}),...(options.admission===false?{}:{admission:{inspect}})};
  const store=new PostgresDriverAccountErasureStore(pool,secret,{enabled:options.enabled??true,expectedCheckpoint:checkpoint,identityConfigured:true,protectedProof,guarded});
  const seed=(patch:Record<string,unknown>={})=>{const value=input();const key=driverErasureHash(secret,"cop:account-erasure-operation",value.operationId);
    const row={actor_hash:value.actorHash,request_hash:value.requestHash,created_at:new Date(now),updated_at:new Date(now),contributor_count:9,deleted_batch_count:2,remaining_batch_count:0,database_zero_verified:true,derived_report_acknowledged:false,replay_checkpoint_hash:checkpointHash,status:"pending",...patch};rows.set(key,row);return row;};
  return {store,guarded,pool,rows,calls,database,execute,probe,inspect,observations,readScopes,protectedProof,seed};
}
describe("guarded driver erasure store (synthetic ports; no Root acceptance)",()=>{
  it("starts the first ERASE on an empty ledger through preflight, then requires a fresh receipt without runtime DML",async()=>{
    let f:ReturnType<typeof fixture>;f=fixture({onExecute:()=>{expect(f.rows.size).toBe(0);f.seed();}});
    const receipt=await f.store.erase(input(),context());
    expect(receipt.status).toBe("pending");expect(receipt.wholeAccountComplete).toBe(false);
    expect(f.execute).toHaveBeenCalledExactlyOnceWith({operation:context().operation,body:{contractVersion:"sim-driver-guarded-db-v1",operationHash:driverErasureHash(secret,"cop:account-erasure-operation",business),actorHash:input().actorHash,requestHash:input().requestHash,contributors:input().contributors,checkpointHash}});
    expect(f.calls.some(call=>call.sql.includes("WHERE operation_hash=$1 AND actor_hash=$2"))).toBe(true);
    expect(f.calls.some(call=>call.sql.includes("REPEATABLE READ READ ONLY"))).toBe(true);
    expect(f.observations).toEqual([{purpose:"preflight",hasOperation:false},{purpose:"receipt",hasOperation:true}]);
    expect(f.inspect.mock.invocationCallOrder[0]).toBeLessThan(f.execute.mock.invocationCallOrder[0]);
    expect(f.execute.mock.invocationCallOrder[0]).toBeLessThan(f.inspect.mock.invocationCallOrder[1]);
    expect(f.protectedProof).not.toHaveBeenCalled();expect(f.probe).not.toHaveBeenCalled();
    expect(f.calls.some(call=>/^(INSERT|UPDATE|DELETE|TRUNCATE)/i.test(call.sql))).toBe(false);
  });
  it("accepts an ACK receipt only from a known commit plus fresh independent ledger/admission",async()=>{
    let f:ReturnType<typeof fixture>;f=fixture({onExecute:()=>{f.seed({status:"completed",derived_report_acknowledged:true});}});f.seed();
    const receipt=await f.store.acknowledge(input(),{...context("ack"),publicationContext:publication});
    expect(receipt.status).toBe("completed");expect(receipt.backupReplayRequired).toBe(true);
    expect(f.execute.mock.calls[0][0].body).toEqual(expect.objectContaining({publicationContext:publication,checkpointHash}));
    expect(f.observations).toEqual([{purpose:"receipt",hasOperation:true},{purpose:"receipt",hasOperation:true}]);
    expect(f.inspect.mock.calls.every(([request])=>request.purpose==="receipt"&&request.actorHash===input().actorHash&&request.operationHash===driverErasureHash(secret,"cop:account-erasure-operation",business))).toBe(true);
  });
  it("binds both reads and execute to the same owned v2 invocation scope even if the caller changes it during admission",async()=>{
    const caller={...context(),mutationScopeRef:{...mutationScope}};
    let f:ReturnType<typeof fixture>;f=fixture({mutationScopeRef:mutationScope,onInspect:()=>{caller.mutationScopeRef.digest="8".repeat(64);},onExecute:()=>{f.seed();}});
    const receipt=await f.store.erase(input(),caller);expect(receipt.status).toBe("pending");
    expect(f.readScopes).toEqual([mutationScope,mutationScope]);
    expect(f.execute.mock.calls[0][0].mutationScopeRef).toEqual(mutationScope);
    expect(f.observations).toEqual([{purpose:"preflight",hasOperation:false},{purpose:"receipt",hasOperation:true}]);
  });
  it("requires the same v2 scope for ACK admission and its publication-bound dispatch",async()=>{
    const f=fixture({mutationScopeRef:mutationScope});f.seed({status:"completed",derived_report_acknowledged:true});
    expect((await f.store.acknowledge(input(),{...context("ack"),mutationScopeRef:mutationScope,publicationContext:publication})).status).toBe("completed");
    expect(f.readScopes).toEqual([mutationScope,mutationScope]);expect(f.execute.mock.calls[0][0].mutationScopeRef).toEqual(mutationScope);
    expect(f.execute.mock.calls[0][0].body).toEqual(expect.objectContaining({publicationContext:publication}));
  });
  it.each(["downgrade","unscoped","foreign-scope"] as const)("rejects %s admission without a fallback or dispatch",async mode=>{
    const f=fixture(mode==="downgrade"?{}:{mutationScopeRef:mode==="foreign-scope"?{...mutationScope,digest:"8".repeat(64)}:mutationScope});f.seed();
    await expect(f.store.erase(input(),mode==="unscoped"?context():{...context(),mutationScopeRef:mutationScope})).rejects.toMatchObject({status:503});
    expect(f.execute).not.toHaveBeenCalled();expect(f.probe).not.toHaveBeenCalled();expect(f.protectedProof).not.toHaveBeenCalled();
  });
  it("requires an existing actor-bound receipt before ACK dispatch",async()=>{
    const f=fixture();await expect(f.store.acknowledge(input(),{...context("ack"),publicationContext:publication})).rejects.toMatchObject({status:503});
    expect(f.observations).toEqual([{purpose:"receipt",hasOperation:false}]);expect(f.execute).not.toHaveBeenCalled();expect(f.probe).not.toHaveBeenCalled();
  });
  it("can resume an actor/request-owned durable operation with current admission after the feature flag is disabled",async()=>{
    for(const kind of ["erase","ack"] as const){
      let readBeforeDispatch=false;let f:ReturnType<typeof fixture>;
      f=fixture({enabled:false,onExecute:()=>{readBeforeDispatch=f.calls.some(call=>call.sql.includes("WHERE operation_hash=$1 AND actor_hash=$2"));}});
      f.seed(kind==="ack"?{status:"completed",derived_report_acknowledged:true}:{});
      expect((await f.store.capability()).ready).toBe(false);
      const receipt=kind==="ack"?await f.store.acknowledge(input(),{...context("ack"),publicationContext:publication}):await f.store.erase(input(),context());
      expect(receipt.status).toBe(kind==="ack"?"completed":"pending");expect(readBeforeDispatch).toBe(true);expect(f.execute).toHaveBeenCalledTimes(1);
      expect(f.protectedProof).not.toHaveBeenCalled();expect(f.calls.some(call=>/^(INSERT|UPDATE|DELETE|TRUNCATE)/i.test(call.sql))).toBe(false);
    }
  });
  it("cannot start a new operation while disabled or substitute a different durable actor/request",async()=>{
    for(const kind of ["erase","ack"] as const)for(const patch of [undefined,{actor_hash:"d".repeat(64)},{request_hash:"d".repeat(64)}]){
      const f=fixture({enabled:false});if(patch)f.seed(patch);
      const attempt=kind==="ack"?f.store.acknowledge(input(),{...context("ack"),publicationContext:publication}):f.store.erase(input(),context());
      await expect(attempt).rejects.toMatchObject({status:503});expect(f.execute).not.toHaveBeenCalled();expect(f.probe).not.toHaveBeenCalled();
      expect(f.protectedProof).not.toHaveBeenCalled();expect(f.calls.some(call=>/^(INSERT|UPDATE|DELETE|TRUNCATE)/i.test(call.sql))).toBe(false);
    }
  });
  it.each(["pending","origin-no-effects-closed","throw"] as const)("never masks %s with a previous completed ledger",async state=>{
    const f=fixture({state});f.seed({status:"completed",derived_report_acknowledged:true});
    await expect(f.store.erase(input(),context())).rejects.toMatchObject({status:503});
    expect(f.calls.some(call=>call.sql.startsWith("SELECT * FROM driver_account_erasure_operations"))).toBe(false);
  });
  it("fails missing context/port/admission and ACK publication context without falling back to legacy",async()=>{
    for(const options of [{},{execution:false},{admission:false}]){const f=fixture(options);f.seed({status:"completed",derived_report_acknowledged:true});
      await expect(f.store.erase(input(),options.execution===false||options.admission===false?context():undefined)).rejects.toMatchObject({status:503});expect(f.protectedProof).not.toHaveBeenCalled();}
    const f=fixture();f.seed({status:"completed",derived_report_acknowledged:true});await expect(f.store.acknowledge(input(),context("ack"))).rejects.toMatchObject({status:503});expect(f.execute).not.toHaveBeenCalled();
  });
  it("does not turn null or empty guarded options into the legacy path",async()=>{
    for(const guarded of [null,{}]){const f=fixture();f.seed();const store=new PostgresDriverAccountErasureStore(f.pool,secret,{enabled:true,expectedCheckpoint:checkpoint,identityConfigured:true,protectedProof:f.protectedProof,guarded:guarded as any});
      await expect(store.erase(input(),context())).rejects.toMatchObject({status:503});expect(f.protectedProof).not.toHaveBeenCalled();expect(f.execute).not.toHaveBeenCalled();}
  });
  it("captures guarded mode/options so caller mutation cannot select legacy SQL or replace its ports",async()=>{
    const f=fixture();f.seed();
    const caller:any={enabled:true,expectedCheckpoint:checkpoint,identityConfigured:true,protectedProof:f.protectedProof,guarded:f.guarded};
    const store=new PostgresDriverAccountErasureStore(f.pool,secret,caller);
    delete caller.guarded;caller.enabled=false;caller.expectedCheckpoint="changed";
    delete (f.guarded as any).execution;delete (f.guarded as any).admission;
    const receipt=await store.erase(input(),context());expect(receipt.status).toBe("pending");
    expect(f.execute).toHaveBeenCalledTimes(1);expect(f.inspect).toHaveBeenCalledTimes(2);expect(f.protectedProof).not.toHaveBeenCalled();
    expect(f.calls.some(call=>/^(INSERT|UPDATE|DELETE|TRUNCATE)/i.test(call.sql))).toBe(false);
  });
  it("preserves legacy mutable configuration and replacement callback semantics without guarded mode",async()=>{
    const f=fixture();const caller:any={enabled:false,expectedCheckpoint:checkpoint,identityConfigured:true,protectedProof:f.protectedProof};
    const store=new PostgresDriverAccountErasureStore(f.pool,secret,caller);
    expect((await store.capability()).ready).toBe(false);caller.enabled=true;expect((await store.capability()).ready).toBe(true);
    const replacement=vi.fn(async()=>({...await f.protectedProof(),identityReviewed:false}));caller.protectedProof=replacement;
    expect((await store.capability()).ready).toBe(false);expect(replacement).toHaveBeenCalledTimes(1);expect(f.inspect).not.toHaveBeenCalled();
  });
  it.each([{actor_hash:"d".repeat(64)},{request_hash:"d".repeat(64)}])("requires actor/request-bound fresh rows after known commit: %j",async patch=>{
    const f=fixture();f.seed(patch);await expect(f.store.erase(input(),context())).rejects.toMatchObject({status:503});expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it("does not turn a known ERASE commit into success without a newly readable receipt",async()=>{
    const f=fixture();await expect(f.store.erase(input(),context())).rejects.toMatchObject({status:503});expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.observations).toEqual([{purpose:"preflight",hasOperation:false},{purpose:"receipt",hasOperation:false}]);
    expect(f.probe).not.toHaveBeenCalled();expect(f.protectedProof).not.toHaveBeenCalled();
  });
  it.each([{purpose:"status"},{actorHash:"d".repeat(64)},{operationHash:"d".repeat(64)},{checkpointHash:"d".repeat(64)},{reportProtection:"shared_generation_fence"},{reference:{recordId:"invalid",digest:"6".repeat(64)}}])("rejects mismatched/malformed read admission %j",async admissionPatch=>{
    const f=fixture({admissionPatch});f.seed();await expect(f.store.erase(input(),context())).rejects.toMatchObject({status:503});expect(f.execute).not.toHaveBeenCalled();
  });
  it("requires the scoped catalog profile and rechecks current checkpoint after execution",async()=>{
    const denied=fixture({permissions:false});denied.seed();await expect(denied.store.erase(input(),context())).rejects.toMatchObject({status:503});expect(denied.execute).not.toHaveBeenCalled();
    let f:ReturnType<typeof fixture>;f=fixture({onExecute:()=>{f.database.checkpointHash="d".repeat(64);}});f.seed();await expect(f.store.erase(input(),context())).rejects.toMatchObject({status:503});
    expect(f.calls.some(call=>call.sql.includes("has_column_privilege")&&call.sql.includes("'REFERENCES'"))).toBe(true);
  });
  it("repeats an uncertain origin through probe only; passive GET/preflight never probe",async()=>{
    const f=fixture({state:"pending"});f.seed();await expect(f.store.erase(input(),context())).rejects.toMatchObject({status:503});
    await f.store.status(business,input().actorHash);await f.store.preflight(input());await f.store.capability();expect(f.probe).not.toHaveBeenCalled();
    const receipt=await f.store.erase(input(),context());expect(receipt.status).toBe("pending");expect(f.execute).toHaveBeenCalledTimes(1);expect(f.probe).toHaveBeenCalledExactlyOnceWith(context().operation);
    expect(f.inspect.mock.calls.map(([request])=>request.purpose)).toEqual(expect.arrayContaining(["receipt","status","preflight","capability"]));
  });
  it("cannot mint read readiness from a legacy zero-argument proof and uses owner-wide intake admission",async()=>{
    const denied=fixture({admission:false});expect((await denied.store.capability()).ready).toBe(false);expect((await denied.store.preflight(input())).checks.identityBindingReviewed).toBe(false);
    await expect(denied.store.assertIntake(denied.pool,"cop")).rejects.toMatchObject({status:503});expect(denied.protectedProof).not.toHaveBeenCalled();
    const f=fixture();await f.store.assertIntake(f.pool,"cop");expect(f.inspect).toHaveBeenCalledExactlyOnceWith({owner:"sim_driver_measurements",scope:"online_driver_scope",purpose:"intake"});
  });
  it("close is local lifecycle only and stops new dispatch",async()=>{
    const f=fixture();f.seed();await f.store.closeGuarded();await expect(f.store.erase(input(),context())).rejects.toMatchObject({status:503});expect(f.execute).not.toHaveBeenCalled();expect(f.probe).not.toHaveBeenCalled();
  });
});
