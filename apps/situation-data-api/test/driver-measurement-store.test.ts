import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresDriverMeasurementStore } from "../src/driver-measurement-store.js";
import { DRIVER_CONTRACT, type DriverBatch, type DriverInterval, type DriverReceipt } from "../src/driver-measurements.js";

// Explicit isolated test database only. Never defaults to a deployed URL.
const url=process.env.DRIVER_MEASUREMENTS_TEST_DATABASE_URL;
describe.skipIf(!url)("driver measurement PostgreSQL persistence",()=>{
  let admin:Pool,store:PostgresDriverMeasurementStore;
  const runtimePassword=randomBytes(24).toString("hex");
  const dataset="sim-routing-2026-09-29-1790679143";
  const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
  const contributor=(n:number)=>String(n).padStart(64,"0");
  const payload=(n:number):DriverBatch=>({contractVersion:DRIVER_CONTRACT,batchId:id(n),contributorIdDay:"a".repeat(40),contributorDay:"2026-10-01",
    consent:{version:"traffic-quality-v1",grantedAt:"2026-10-01T00:00:00.000Z",attestation:"cop-driver-consent-v1"},vehicleClass:"passenger_car",points:[],
    eta:{observationId:id(n+1000),routingDataset:dataset,predictedDurationSeconds:100,actualDurationSeconds:120,plannedDistanceM:1000,actualDistanceM:1000,personalStopSeconds:0,estimatedSeconds:0,offRoute:false,completedAt:"2026-10-01T12:00:00.000Z"}});
  const receipt=(n:number):DriverReceipt=>({contractVersion:DRIVER_CONTRACT,batchId:id(n),receivedAt:new Date().toISOString(),acceptedIntervalCount:2,
    deduplicatedIntervalCount:0,rejectionCounts:{sampling_gap:1},etaAccepted:true,applicationMode:"shadow_only",rawPositionsStored:false});
  const intervals=(n:number):DriverInterval[]=>[0,1].map(i=>({key:contributor(n*2+i),dataset,edgeId:"8",windowStart:"2026-10-01T12:00:00.000Z",speedKph:36,distanceM:50,elapsedSeconds:5}));
  beforeAll(async()=>{
    admin=new Pool({connectionString:url});
    const sql=await readFile(new URL("../../../deploy/driver-measurements/schema.sql",import.meta.url),"utf8");
    await admin.query(sql);await admin.query(sql);
    await admin.query(`CREATE ROLE sim_driver_test_runtime LOGIN PASSWORD '${runtimePassword}'`);
    await admin.query("GRANT USAGE ON SCHEMA public TO sim_driver_test_runtime");
    await admin.query("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO sim_driver_test_runtime");
    const runtime=new URL(url!);runtime.username="sim_driver_test_runtime";runtime.password=runtimePassword;
    store=new PostgresDriverMeasurementStore(runtime.toString(),"synthetic-storage-secret-".repeat(2));
  });
  beforeEach(async()=>{await admin.query("TRUNCATE driver_measurement_receipts,driver_measurement_revocations CASCADE");});
  afterAll(async()=>{await store?.close();await admin?.query("DROP OWNED BY sim_driver_test_runtime");await admin?.query("DROP ROLE sim_driver_test_runtime");await admin?.end();});
  it("persists only derived data, exact replay and interval/ETA dedupe",async()=>{
    const first=await store.commit("cop",contributor(1),"a".repeat(64),payload(1),intervals(1),receipt(1));
    expect(first.acceptedIntervalCount).toBe(2);
    expect(await store.lookup("cop",id(1),"a".repeat(64))).toEqual(first);
    await expect(store.lookup("cop",id(1),"b".repeat(64))).rejects.toThrow("DRIVER_IDEMPOTENCY_CONFLICT");
    const second=payload(2);second.eta!.observationId=payload(1).eta!.observationId;
    const duplicate=await store.commit("cop",contributor(1),"b".repeat(64),second,intervals(1),receipt(2));
    expect(duplicate.acceptedIntervalCount).toBe(0);expect(duplicate.deduplicatedIntervalCount).toBe(2);expect(duplicate.etaAccepted).toBe(false);
    const persisted=await admin.query("SELECT row_to_json(r)::text AS json FROM driver_measurement_receipts r");
    expect(persisted.rows.map(r=>r.json).join()).not.toMatch(/\"(lat|lon|points|contributorIdDay|sampleId)\"/);
    const all=await admin.query(`SELECT row_to_json(r)::text AS json FROM driver_measurement_receipts r
      UNION ALL SELECT row_to_json(i)::text FROM driver_measurement_intervals i
      UNION ALL SELECT row_to_json(e)::text FROM driver_measurement_eta e`);
    const serialized=all.rows.map(r=>r.json).join();
    for(const requestId of [id(1),id(2),id(1001),"a".repeat(40)])expect(serialized).not.toContain(`"${requestId}"`);
    expect((await admin.query("SELECT count(*)::int AS n FROM driver_measurement_eta")).rows[0].n).toBe(1);
  });
  it("requires five attested contributors and ten intervals, balances oversampling, fences dataset",async()=>{
    for(let n=1;n<=4;n++)await store.commit("cop",contributor(n),"a".repeat(64),payload(n),intervals(n),receipt(n));
    expect(await store.aggregates(dataset,"2026-10-01T11:00:00.000Z","2026-10-01T12:03:00.000Z")).toHaveLength(0);
    await store.commit("cop",contributor(5),"a".repeat(64),payload(5),intervals(5),receipt(5));
    const rows=await store.aggregates(dataset,"2026-10-01T11:00:00.000Z","2026-10-01T12:03:00.000Z") as any[];
    expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({attestedContributorCount:5,intervalCount:10,medianSpeedKph:36,state:"current"});
    const oversampled=Array.from({length:100},(_,i)=>({...intervals(6)[0]!,key:contributor(10000+i),speedKph:90}));
    await store.commit("cop",contributor(1),"a".repeat(64),payload(6),oversampled,receipt(6));
    const balanced=await store.aggregates(dataset,"2026-10-01T11:00:00.000Z","2026-10-01T12:03:00.000Z") as any[];
    expect(balanced[0]).toMatchObject({attestedContributorCount:5,intervalCount:110,medianSpeedKph:36});
    expect(await store.aggregates("sim-routing-2026-10-02-1","2026-10-01T11:00:00.000Z",new Date().toISOString())).toHaveLength(0);
    const historical=await store.aggregates(dataset,"2026-10-01T11:00:00.000Z","2026-10-01T12:06:00.000Z") as any[];
    expect(historical[0].state).toBe("historical");
  });
  it("gates client-reported ETA summaries independently, with explicit denominator",async()=>{
    for(let n=1;n<=10;n++)await store.commit("cop",contributor((n-1)%5+1),"a".repeat(64),payload(n),intervals(n),receipt(n));
    const q=await store.quality(new Date().toISOString()) as any;
    expect(q.eta).toHaveLength(1);expect(q.eta[0]).toMatchObject({attestedContributorCount:5,observationCount:10,medianAbsoluteErrorSeconds:20,medianAbsoluteErrorPercent:20});
    expect(q.acceptedIntervalCount).toBe(20);expect(q.rejectionCounts.sampling_gap).toBe(10);
  });
  it("serializes concurrent reuse of batch identity and revocation; cascades deletion",async()=>{
    const settled=await Promise.allSettled([store.commit("cop",contributor(1),"a".repeat(64),payload(1),intervals(1),receipt(1)),
      store.commit("cop",contributor(2),"b".repeat(64),payload(1),intervals(2),receipt(1))]);
    expect(settled.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const saved=await admin.query("SELECT contributor_hash FROM driver_measurement_receipts");
    expect(await store.revoke("cop",saved.rows[0].contributor_hash)).toBe(1);
    await expect(store.commit("cop",saved.rows[0].contributor_hash,"c".repeat(64),payload(3),intervals(3),receipt(3))).rejects.toThrow("DRIVER_CONSENT_REVOKED");
    expect((await admin.query("SELECT count(*)::int AS n FROM driver_measurement_intervals")).rows[0].n).toBe(0);
    expect((await admin.query("SELECT count(*)::int AS n FROM driver_measurement_eta")).rows[0].n).toBe(0);
  });
  it("removes a revoked driver from published aggregates and fences a racing submission",async()=>{
    for(let n=1;n<=5;n++)await store.commit("cop",contributor(n),"a".repeat(64),payload(n),intervals(n),receipt(n));
    const since="2026-10-01T11:00:00.000Z", at="2026-10-01T12:03:00.000Z";
    expect(await store.aggregates(dataset,since,at)).toHaveLength(1);
    const raced=await Promise.allSettled([
      store.commit("cop",contributor(5),"b".repeat(64),payload(6),intervals(6),receipt(6)),
      store.revoke("cop",contributor(5))
    ]);
    expect(raced[1]?.status).toBe("fulfilled");
    expect(await store.aggregates(dataset,since,at)).toHaveLength(0);
    await expect(store.commit("cop",contributor(5),"c".repeat(64),payload(7),intervals(7),receipt(7)))
      .rejects.toThrow("DRIVER_CONSENT_REVOKED");
    expect((await admin.query("SELECT count(*)::int AS n FROM driver_measurement_receipts WHERE contributor_hash=$1",[contributor(5)])).rows[0].n).toBe(0);
  });
  it("runtime cannot create tables; expired rows are excluded and purged",async()=>{
    const runtime=new URL(url!);runtime.username="sim_driver_test_runtime";runtime.password=runtimePassword;const p=new Pool({connectionString:runtime.toString()});
    try{await expect(p.query("CREATE TABLE forbidden_driver_test(id int)")).rejects.toThrow();}finally{await p.end();}
    await store.commit("cop",contributor(1),"a".repeat(64),payload(1),intervals(1),receipt(1));
    await admin.query("UPDATE driver_measurement_receipts SET expires_at=now()-interval '1 minute'");
    expect(await store.lookup("cop",id(1),"a".repeat(64))).toBeUndefined();
    expect((await store.quality(new Date().toISOString()) as any).retainedBatchCount).toBe(0);
    await (store as unknown as {cleanup:()=>Promise<void>}).cleanup();
    expect((await admin.query("SELECT count(*)::int AS n FROM driver_measurement_intervals")).rows[0].n).toBe(0);
  });
  it("evaluates contributor thresholds, graph and time groups without exposing identities",async()=>{
    const at=new Date(Date.now()+60000).toISOString(), start=new Date(Math.floor(Date.parse(at)/300000)*300000).toISOString();
    const submit=async(n:number,driver:number,window:string,edge="8",graph=dataset,extra=0)=>{
      const p=payload(n);p.eta=undefined;
      const rows=[...intervals(n),...Array.from({length:extra},(_,i)=>({...intervals(n)[0]!,key:contributor(20000+n*200+i)}))]
        .map(i=>({...i,dataset:graph,edgeId:edge,windowStart:window}));
      await store.commit("cop",contributor(driver),"a".repeat(64),p,rows,{...receipt(n),acceptedIntervalCount:rows.length,etaAccepted:false});
    };
    for(let n=1;n<=5;n++)await submit(n,n,start);
    // Many samples from an existing contributor do not create another contributor.
    await submit(6,1,start,"8",dataset,100);
    await submit(7,6,start,"16",dataset,30);await submit(8,7,start,"16",dataset,30);
    const historical=new Date(Date.parse(start)-300000).toISOString();
    for(let n=9;n<=13;n++)await submit(n,n,historical);
    await submit(14,14,new Date(Date.parse(start)+300000).toISOString());
    await submit(15,15,start,"8","sim-routing-2026-10-12-1791774006");
    const result=await store.evaluation(dataset,at);
    expect(result.summary.speed).toEqual({evaluatedGroupCount:5,currentGroupCount:2,historicalGroupCount:1,futureGroupCount:1,
      otherDatasetGroupCount:1,subthresholdGroupCount:1,qualityGroupCount:2,closedWindowGroupCount:1,
      currentQualityGroupCount:1,currentQualityIntervalCount:112});
    expect(result.summary.eta).toEqual([]);expect(result.livePromotionSupported).toBe(false);
    const serialized=JSON.stringify(result);
    for(const forbidden of ['"lat"','"lon"','"points"','"edgeId"','"directedEdgeId"','"contributor_hash"','"batch_id"',`"${contributor(1)}"`,`"${id(1)}"`])expect(serialized).not.toContain(forbidden);
    const end=await store.evaluation(dataset,new Date(Date.parse(start)+300000).toISOString());
    expect(end.summary.speed.historicalGroupCount).toBe(3);
    expect(end.summary.speed.currentGroupCount).toBe(1);expect(end.summary.speed.currentQualityGroupCount).toBe(0);
    const legacy=await store.aggregates(dataset,start,at) as Array<{windowStart:Date}>;
    expect(legacy.every(row=>row.windowStart.toISOString()<=at)).toBe(true);
  });
  it("balances ETA by contributor, bounds current-graph evidence and does not call it ground truth",async()=>{
    const at=new Date(Date.now()+60000).toISOString(), start=new Date(Math.floor(Date.parse(at)/300000)*300000).toISOString();
    const submit=async(n:number,driver:number,error:number,graph=dataset)=>{
      const p=payload(n);p.eta={...p.eta!,routingDataset:graph,completedAt:at,predictedDurationSeconds:100,actualDurationSeconds:100+error};
      await store.commit("cop",contributor(driver),"a".repeat(64),p,
        intervals(n).map(i=>({...i,dataset:graph,windowStart:start})),receipt(n));
    };
    for(let n=1;n<=10;n++)await submit(n,(n-1)%5+1,20);
    for(let n=11;n<=25;n++)await submit(n,1,1000);
    await submit(26,26,50,"sim-routing-2026-10-12-1791774006");
    const result=await store.evaluation(dataset,at);
    expect(result.summary.eta).toHaveLength(1);
    expect(result.summary.eta[0]).toMatchObject({routingDataset:dataset,attestedContributorCount:5,observationCount:25,
      medianAbsoluteErrorSeconds:20,medianAbsoluteErrorPercent:20});
    expect(result.etaEvidence).toBe("client_reported_not_ground_truth");
  });
  it("fresh evaluation after raced revocation contains no removed contribution or usable group",async()=>{
    const at=new Date(Date.now()+60000).toISOString(), start=new Date(Math.floor(Date.parse(at)/300000)*300000).toISOString();
    const rows=(n:number)=>intervals(n).map(i=>({...i,windowStart:start}));
    for(let n=1;n<=5;n++)await store.commit("cop",contributor(n),"a".repeat(64),payload(n),rows(n),receipt(n));
    expect((await store.evaluation(dataset,at)).summary.speed.currentQualityGroupCount).toBe(1);
    const raced=await Promise.allSettled([store.commit("cop",contributor(5),"b".repeat(64),payload(6),rows(6),receipt(6)),store.revoke("cop",contributor(5))]);
    expect(raced[1]?.status).toBe("fulfilled");
    const after=await store.evaluation(dataset,at);
    expect(after.summary).toMatchObject({retainedBatchCount:4,acceptedIntervalCount:8,activeRevocationTombstoneCount:1,
      speed:{currentQualityGroupCount:0,currentQualityIntervalCount:0,subthresholdGroupCount:1}});
    expect(after.revocationCoverage).toBe("database_only");
    await expect(store.commit("cop",contributor(5),"c".repeat(64),payload(7),rows(7),receipt(7))).rejects.toThrow("DRIVER_CONSENT_REVOKED");
  });
  it("a repeatable-read view is not a live revocation fence; a new evaluation observes deletion",async()=>{
    const at=new Date(Date.now()+60000).toISOString(), start=new Date(Math.floor(Date.parse(at)/300000)*300000).toISOString();
    for(let n=1;n<=5;n++)await store.commit("cop",contributor(n),"a".repeat(64),payload(n),
      intervals(n).map(i=>({...i,windowStart:start})),receipt(n));
    const read=await admin.connect();
    try {
      await read.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect((await read.query("SELECT count(*)::int AS n FROM driver_measurement_receipts")).rows[0].n).toBe(5);
      await store.revoke("cop",contributor(5));
      // PostgreSQL deliberately keeps the older read snapshot; do not persist or apply it.
      expect((await read.query("SELECT count(*)::int AS n FROM driver_measurement_receipts")).rows[0].n).toBe(5);
      await read.query("COMMIT");
    } catch(error) {await read.query("ROLLBACK").catch(()=>undefined);throw error;}finally{read.release();}
    const current=await store.evaluation(dataset,at);
    expect(current.summary.retainedBatchCount).toBe(4);expect(current.summary.speed.currentQualityGroupCount).toBe(0);
    expect(current.livePromotionSupported).toBe(false);expect(current.revocationCoverage).toBe("database_only");
  });
  it("a commit queued behind revocation cannot reinsert data after the delete transaction completes",async()=>{
    const driver=contributor(5), blocker=await admin.connect();
    await store.commit("cop",driver,"a".repeat(64),payload(1),intervals(1),receipt(1));
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`cop:${driver}`]);
    const revoked=store.revoke("cop",driver);
    let late:Promise<{error?:Error; committed?:boolean}>|undefined;
    try {
      // This isolated test DB has no other clients waiting on advisory locks.
      const waiting=async()=>Number((await admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted")).rows[0].n);
      await vi.waitFor(async()=>expect(await waiting()).toBe(1),{timeout:500,interval:10});
      late=store.commit("cop",driver,"b".repeat(64),payload(2),intervals(2),receipt(2))
        .then(()=>({committed:true}),error=>({error}));
      await vi.waitFor(async()=>expect(await waiting()).toBe(2),{timeout:500,interval:10});
      await blocker.query("COMMIT");
      expect(await revoked).toBe(1);
      expect((await late).error?.message).toBe("DRIVER_CONSENT_REVOKED");
      expect((await admin.query("SELECT count(*)::int AS n FROM driver_measurement_receipts")).rows[0].n).toBe(0);
      expect((await admin.query("SELECT count(*)::int AS n FROM driver_measurement_intervals")).rows[0].n).toBe(0);
    } finally {
      await blocker.query("ROLLBACK").catch(()=>undefined);blocker.release();
      await revoked.catch(()=>undefined);await late;
    }
  });
});
