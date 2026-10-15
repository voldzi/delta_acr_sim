import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {PostgresDriverMeasurementStore,type DriverMeasurementStorageOptions} from "../src/driver-measurement-store.js";
import {PostgresDriverAccountErasureStore} from "../src/driver-account-erasure-store.js";
import type {DriverErasureInput,DriverErasureReceipt} from "../src/driver-account-erasure.js";
import type {DriverGuardedExecutionPort,DriverGuardedExecutionRequest,DriverGuardedExecutionResult,DriverGuardedKind,DriverGuardedOperationContext,DriverGuardedOperationRef} from "../src/driver-guarded-execution-port.js";
import type {DriverRetentionConsumer,DriverRetentionOperationContext} from "../src/driver-retention-lifecycle.js";

// These injected ports and database spies are synthetic application mechanics,
// NOT a Root producer, signed authority, PostgreSQL run or production acceptance.
const postgres=vi.hoisted(()=>({construct:vi.fn(),connect:vi.fn(),query:vi.fn(),end:vi.fn(),on:vi.fn()}));
vi.mock("pg",()=>({Pool:function SyntheticPool(options:unknown){postgres.construct(options);return {connect:postgres.connect,query:postgres.query,end:postgres.end,on:postgres.on};}}));

const ORIGIN="10000000-0000-4000-8000-000000000001";
const HASH="a".repeat(64);
const CUTOFF="2026-10-14T12:00:00.000Z";
const reference={recordId:"20000000-0000-4000-8000-000000000001",digest:"b".repeat(64)};
function context(kind:DriverGuardedKind="revoke",operationId=ORIGIN):DriverGuardedOperationContext{return {operation:{operationId,kind}};}
function known(count?:number,operationId=ORIGIN):DriverGuardedExecutionResult{
  return {contractVersion:"cop-driver-origin-result-v1",operationId,state:"origin-commit-known",sqlOutcomeRef:reference,effectQuiescenceRef:reference,
    ...(count===undefined?{}:{revokeEffect:{deletedBatchCount:count}})};
}
function pending(operationId=ORIGIN):DriverGuardedExecutionResult{return {contractVersion:"cop-driver-origin-result-v1",operationId,state:"pending",reason:"origin-unresolved"};}
function port(result:unknown=known(2)){
  const execute=vi.fn(async(_request:DriverGuardedExecutionRequest)=>result),probe=vi.fn(async(_operation:DriverGuardedOperationRef)=>result);
  return {execute,probe,port:{execute,probe} as unknown as DriverGuardedExecutionPort};
}
function store(options:DriverMeasurementStorageOptions={}){
  return new PostgresDriverMeasurementStore("synthetic-not-a-connection","synthetic-storage-secret-only-0000000000",options);
}
function retentionContext(operation:unknown={operationId:ORIGIN,kind:"expire"}):DriverRetentionOperationContext{
  return Object.freeze({owner:"sim_driver_measurements",cutoff:CUTOFF,...(operation===undefined?{}:{operation})}) as DriverRetentionOperationContext;
}
function consumer(value:DriverRetentionOperationContext):DriverRetentionConsumer{return {owner:"sim_driver_measurements",execute:async work=>{await work(value);}};}
function initializedDatabase(){postgres.query.mockResolvedValue({rows:[{database_name:"sim_driver_measurements",receipts:true,revocations:true}]});}
function noApplicationSql(){expect(postgres.connect).not.toHaveBeenCalled();expect(postgres.query).not.toHaveBeenCalled();}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {promise,resolve};}
async function microtasks(){for(let i=0;i<8;i++)await Promise.resolve();}
const unavailable={status:503,code:"DRIVER_MEASUREMENTS_UNAVAILABLE"};

beforeEach(()=>{vi.clearAllMocks();postgres.connect.mockReset();postgres.query.mockReset();postgres.end.mockReset();postgres.end.mockResolvedValue(undefined);});
afterEach(()=>{vi.useRealTimers();});

describe("guarded measurement mutations: opt-in synthetic port only",()=>{
  it("forwards each protected erase/ack invocation context to the erasure component unchanged",async()=>{
    const input:DriverErasureInput={operationId:ORIGIN,actorHash:HASH,requestHash:"c".repeat(64),contributors:[{contributorDay:"2026-10-14",contributorHash:HASH}]};
    const receipt:DriverErasureReceipt={contractVersion:"sim-account-erasure-v1",operationId:ORIGIN,status:"pending",scope:"online_driver_scope",wholeAccountComplete:false,
      backupReplayRequired:true,acceptedAt:CUTOFF,updatedAt:CUTOFF,contributorCount:1,deletedBatchCount:0,remainingBatchCount:1,databaseZeroVerified:false,
      derivedReportAcknowledged:false,reportProtection:"unverified",publicationFenceVerified:false,replayReady:false,retentionReviewed:false,pendingReason:"stored_rows_remaining"};
    const erase=vi.spyOn(PostgresDriverAccountErasureStore.prototype,"erase").mockResolvedValue(receipt);
    const acknowledge=vi.spyOn(PostgresDriverAccountErasureStore.prototype,"acknowledge").mockResolvedValue(receipt);
    const eraseContext=context("erase"),ackContext=context("ack","10000000-0000-4000-8000-000000000002"),s=store({guarded:{}});
    try{
      await expect(s.accountErasure(input,eraseContext)).resolves.toBe(receipt);
      await expect(s.acknowledgeAccountErasure(input,ackContext)).resolves.toBe(receipt);
      expect(erase).toHaveBeenCalledExactlyOnceWith(input,eraseContext);expect(erase.mock.calls[0]?.[1]).toBe(eraseContext);
      expect(acknowledge).toHaveBeenCalledExactlyOnceWith(input,ackContext);expect(acknowledge.mock.calls[0]?.[1]).toBe(ackContext);noApplicationSql();
    }finally{erase.mockRestore();acknowledge.mockRestore();await s.close();}
  });

  it("does not dispatch or connect while constructing an opted-in store",async()=>{
    const root=port(),s=store({guarded:{execution:root.port}});
    await microtasks();expect(root.execute).not.toHaveBeenCalled();expect(root.probe).not.toHaveBeenCalled();noApplicationSql();await s.close();
  });

  it.each([{},null])("an unbound guarded value %j never selects legacy revoke SQL",async guarded=>{
    const s=store({guarded} as unknown as DriverMeasurementStorageOptions);
    await expect(s.revoke("cop",HASH,context())).rejects.toMatchObject(unavailable);noApplicationSql();await s.close();
  });

  it.each([0,2,2_147_483_647])("returns only the original known-commit revoke scalar %i",async count=>{
    const root=port(known(count)),s=store({guarded:{execution:root.port}});
    await expect(s.revoke("cop",HASH,context())).resolves.toBe(count);
    expect(root.execute).toHaveBeenCalledExactlyOnceWith({operation:{operationId:ORIGIN,kind:"revoke"},body:{contractVersion:"sim-driver-guarded-db-v1",contributorHash:HASH}});
    expect(root.probe).not.toHaveBeenCalled();noApplicationSql();await s.close();
  });

  it.each([undefined,{operation:{operationId:ORIGIN,kind:"expire"}},{operation:{operationId:"not-an-origin",kind:"revoke"}},
    {operation:{operationId:ORIGIN,kind:"revoke",sql:"forbidden"}},{operation:{operationId:ORIGIN,kind:"revoke"},unknown:true}])(
    "rejects missing or invalid current-operation routing metadata without dispatch: %j",async value=>{
      const root=port(),s=store({guarded:{execution:root.port}});
      await expect(s.revoke("cop",HASH,value as DriverGuardedOperationContext|undefined)).rejects.toMatchObject(unavailable);
      expect(root.execute).not.toHaveBeenCalled();expect(root.probe).not.toHaveBeenCalled();noApplicationSql();await s.close();
    });

  it.each([["other",HASH],["cop","raw-contributor"],["cop",null]])("rejects owner/hash outside the guarded COP body",async(owner,hash)=>{
    const root=port(),s=store({guarded:{execution:root.port}});
    await expect(s.revoke(owner as string,hash as string,context())).rejects.toMatchObject(unavailable);
    expect(root.execute).not.toHaveBeenCalled();noApplicationSql();await s.close();
  });

  it.each([undefined,-1,1.5,Number.NaN,2_147_483_648,"2"])("does not infer an absent/invalid revoke count: %s",async count=>{
    const value=count===undefined?known():{...known(),revokeEffect:{deletedBatchCount:count}};
    const root=port(value),s=store({guarded:{execution:root.port}});
    await expect(s.revoke("cop",HASH,context())).rejects.toMatchObject(unavailable);noApplicationSql();await s.close();
  });

  it.each([
    {contractVersion:"cop-driver-origin-result-v1",operationId:ORIGIN,state:"origin-no-effects-closed",sqlOutcomeRef:reference,effectQuiescenceRef:reference},
    {...known(2),operationId:"10000000-0000-4000-8000-000000000002"},
    {...known(2),contractVersion:"unknown"},
    {...known(2),effectQuiescenceRef:undefined},
    {...known(2),extra:true}
  ])("rejects no-effects, mismatched or malformed terminal responses",async value=>{
    const root=port(value),s=store({guarded:{execution:root.port}});
    await expect(s.revoke("cop",HASH,context())).rejects.toMatchObject(unavailable);noApplicationSql();await s.close();
  });

  it("a pending same-origin retry probes; it never dispatches another destructive call",async()=>{
    const root=port(pending());root.probe.mockResolvedValue(known(4));const s=store({guarded:{execution:root.port}});
    await expect(s.revoke("cop",HASH,context())).rejects.toMatchObject(unavailable);
    await expect(s.revoke("cop",HASH,context())).resolves.toBe(4);
    expect(root.execute).toHaveBeenCalledTimes(1);expect(root.probe).toHaveBeenCalledExactlyOnceWith({operationId:ORIGIN,kind:"revoke"});noApplicationSql();await s.close();
  });

  it("a missing original scalar receipt remains ambiguous and retries only through probe",async()=>{
    const root=port(known());root.probe.mockResolvedValue(known(6));const s=store({guarded:{execution:root.port}});
    await expect(s.revoke("cop",HASH,context())).rejects.toMatchObject(unavailable);
    await expect(s.revoke("cop",HASH,context())).resolves.toBe(6);
    expect(root.execute).toHaveBeenCalledTimes(1);expect(root.probe).toHaveBeenCalledExactlyOnceWith({operationId:ORIGIN,kind:"revoke"});noApplicationSql();await s.close();
  });

  it("an uncertain failed call retries only the same origin and unchanged body through probe",async()=>{
    const root=port();root.execute.mockRejectedValue(new Error("synthetic transport loss after uncertain commit"));root.probe.mockResolvedValue(known(3));
    const s=store({guarded:{execution:root.port}});
    await expect(s.revoke("cop",HASH,context())).rejects.toMatchObject(unavailable);
    await expect(s.revoke("cop","c".repeat(64),context())).rejects.toMatchObject(unavailable);
    expect(root.probe).not.toHaveBeenCalled();
    await expect(s.revoke("cop",HASH,context())).resolves.toBe(3);
    expect(root.execute).toHaveBeenCalledTimes(1);expect(root.probe).toHaveBeenCalledTimes(1);noApplicationSql();await s.close();
  });

  it("joins an in-flight origin and closes only after the actual local port call settles",async()=>{
    const actual=deferred<DriverGuardedExecutionResult>(),root=port();root.execute.mockReturnValue(actual.promise);
    const s=store({guarded:{execution:root.port}}),first=s.revoke("cop",HASH,context()),second=s.revoke("cop",HASH,context());
    await microtasks();expect(root.execute).toHaveBeenCalledTimes(1);
    let closed=false;const closing=s.close().then(()=>{closed=true;});await microtasks();expect(closed).toBe(false);expect(postgres.end).not.toHaveBeenCalled();
    actual.resolve(known(5));await expect(first).resolves.toBe(5);await expect(second).resolves.toBe(5);await closing;
    expect(postgres.end).toHaveBeenCalledTimes(1);
    await expect(s.revoke("cop",HASH,context())).rejects.toMatchObject(unavailable);expect(root.execute).toHaveBeenCalledTimes(1);noApplicationSql();
  });

  it("absence of guarded preserves the existing application transaction",async()=>{
    const query=vi.fn(async(sql:string)=>({rowCount:sql.startsWith("DELETE")?7:0})),release=vi.fn();postgres.connect.mockResolvedValue({query,release});const s=store();
    await expect(s.revoke("cop",HASH)).resolves.toBe(7);
    expect(query.mock.calls.map(row=>row[0])).toEqual(["BEGIN","SET LOCAL lock_timeout='1500ms'","SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      "INSERT INTO driver_measurement_revocations(owner,contributor_hash,expires_at) VALUES($1,$2,now()+interval '7 days') ON CONFLICT(owner,contributor_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at",
      "DELETE FROM driver_measurement_receipts WHERE owner=$1 AND contributor_hash=$2","COMMIT"]);
    expect(release).toHaveBeenCalledTimes(1);await s.close();
  });
});

describe("guarded retention: immutable callback metadata, no application DELETE",()=>{
  it("executes the exact expire origin and sends only the fixed body, never cutoff",async()=>{
    initializedDatabase();const root=port(known()),s=store({guarded:{execution:root.port},retentionConsumer:consumer(retentionContext())});
    await s.init();await s.runRetentionOnce();
    expect(root.execute).toHaveBeenCalledExactlyOnceWith({operation:{operationId:ORIGIN,kind:"expire"},body:{contractVersion:"sim-driver-guarded-db-v1"}});
    expect(postgres.connect).not.toHaveBeenCalled();expect(postgres.query).toHaveBeenCalledTimes(1);expect(postgres.query.mock.calls[0]?.[0]).toContain("SELECT current_database()");await s.close();
  });

  it.each([{},null])("an opted-in unbound execution port cannot perform application cleanup",async guarded=>{
    initializedDatabase();const s=store({guarded,retentionConsumer:consumer(retentionContext())} as unknown as DriverMeasurementStorageOptions);
    await s.init();await expect(s.runRetentionOnce()).rejects.toMatchObject({code:"DRIVER_RETENTION_UNAVAILABLE"});expect(postgres.connect).not.toHaveBeenCalled();expect(postgres.query).toHaveBeenCalledTimes(1);await s.close();
  });

  it("a legacy callback lacking an expire origin fails closed only in guarded mode",async()=>{
    initializedDatabase();const root=port(known()),s=store({guarded:{execution:root.port},retentionConsumer:consumer(Object.freeze({owner:"sim_driver_measurements",cutoff:CUTOFF}))});
    await s.init();await expect(s.runRetentionOnce()).rejects.toMatchObject({code:"DRIVER_RETENTION_UNAVAILABLE"});
    expect(root.execute).not.toHaveBeenCalled();expect(postgres.connect).not.toHaveBeenCalled();await s.close();
  });

  it.each([undefined,null,{operationId:ORIGIN,kind:"revoke"},{operationId:"invalid",kind:"expire"},
    {operationId:ORIGIN,kind:"expire",extra:true},Object.defineProperty({kind:"expire"},"operationId",{enumerable:true,get(){throw new Error("must not invoke getter");}})])(
    "rejects a malformed optional expire reference before any dispatch (case %#)",async value=>{
      initializedDatabase();const root=port(known());
      const valueWithExplicitOperation=Object.freeze({owner:"sim_driver_measurements",cutoff:CUTOFF,operation:value}) as DriverRetentionOperationContext;
      const s=store({guarded:{execution:root.port},retentionConsumer:consumer(valueWithExplicitOperation)});
      await s.init();await expect(s.runRetentionOnce()).rejects.toMatchObject({code:"DRIVER_RETENTION_UNAVAILABLE"});
      expect(root.execute).not.toHaveBeenCalled();expect(postgres.connect).not.toHaveBeenCalled();await s.close();
    });

  it("copies and freezes exact nested origin metadata before async cleanup",async()=>{
    initializedDatabase();const root=port(known()),operation={operationId:ORIGIN,kind:"expire"};
    const context=Object.freeze({owner:"sim_driver_measurements",cutoff:CUTOFF,operation}) as DriverRetentionOperationContext;
    const injected:DriverRetentionConsumer={owner:"sim_driver_measurements",execute:async work=>{const actual=work(context);operation.operationId="10000000-0000-4000-8000-000000000002";await actual;}};
    const s=store({guarded:{execution:root.port},retentionConsumer:injected});await s.init();await s.runRetentionOnce();
    expect(root.execute.mock.calls[0]?.[0]).toEqual({operation:{operationId:ORIGIN,kind:"expire"},body:{contractVersion:"sim-driver-guarded-db-v1"}});expect(postgres.connect).not.toHaveBeenCalled();await s.close();
  });

  it.each([pending(),{contractVersion:"cop-driver-origin-result-v1",operationId:ORIGIN,state:"origin-no-effects-closed",sqlOutcomeRef:reference,effectQuiescenceRef:reference}])(
    "pending or no-effects is not successful retention",async value=>{
      initializedDatabase();const root=port(value),s=store({guarded:{execution:root.port},retentionConsumer:consumer(retentionContext())});
      await s.init();await expect(s.runRetentionOnce()).rejects.toMatchObject({code:"DRIVER_RETENTION_UNAVAILABLE"});expect(postgres.connect).not.toHaveBeenCalled();await s.close();
    });

  it("retention pending retries probe the exact registered origin, not another expiry",async()=>{
    initializedDatabase();const root=port(pending());root.probe.mockResolvedValue(known());const s=store({guarded:{execution:root.port},retentionConsumer:consumer(retentionContext())});
    await s.init();await expect(s.runRetentionOnce()).rejects.toMatchObject({code:"DRIVER_RETENTION_UNAVAILABLE"});await s.runRetentionOnce();
    expect(root.execute).toHaveBeenCalledTimes(1);expect(root.probe).toHaveBeenCalledExactlyOnceWith({operationId:ORIGIN,kind:"expire"});expect(postgres.connect).not.toHaveBeenCalled();await s.close();
  });

  it("close waits for actual guarded cleanup even if the consumer settles early",async()=>{
    initializedDatabase();const actual=deferred<DriverGuardedExecutionResult>(),root=port();root.execute.mockReturnValue(actual.promise);
    const s=store({guarded:{execution:root.port},retentionConsumer:{owner:"sim_driver_measurements",execute:async work=>{void work(retentionContext());}}});
    await s.init();const running=s.runRetentionOnce();await microtasks();let closed=false;const closing=s.close().then(()=>{closed=true;});await microtasks();
    expect(closed).toBe(false);expect(postgres.end).not.toHaveBeenCalled();actual.resolve(known());await running;await closing;expect(postgres.end).toHaveBeenCalledTimes(1);expect(postgres.connect).not.toHaveBeenCalled();
  });
});
