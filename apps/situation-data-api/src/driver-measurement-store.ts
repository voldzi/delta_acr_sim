import { Pool, type PoolClient } from "pg";
import type {CleanLifecycle} from "../../../packages/clean-lifecycle/store.mjs";
import { createHmac } from "node:crypto";
import { DriverMeasurementError, type DriverBatch, type DriverInterval, type DriverReceipt, type DriverStore } from "./driver-measurements.js";
import {PostgresDriverAccountErasureStore,type DriverErasureStorageOptions} from "./driver-account-erasure-store.js";
import type {DriverErasureInput} from "./driver-account-erasure.js";
import {DriverRetentionLifecycle,DriverRetentionLifecycleError,type DriverRetentionConsumer,type DriverRetentionOperationContext,type DriverRetentionScheduler} from "./driver-retention-lifecycle.js";
import {DriverGuardedOperationRunner} from "./driver-guarded-execution.js";
import type {DriverGuardedOperationContext} from "./driver-guarded-execution-port.js";
import type {DriverPublicationLease} from "./driver-publication.js";

export type DriverMeasurementStorageOptions=DriverErasureStorageOptions&{retentionConsumer?:DriverRetentionConsumer;retentionScheduler?:DriverRetentionScheduler;cleanLifecycle?:{mode:'isolated-clean-lifecycle-v1';service:CleanLifecycle}};

/** Dedicated database only; no DDL or raw position persistence in the runtime. */
export class PostgresDriverMeasurementStore implements DriverStore {
  private pool: Pool;
  private retention:DriverRetentionLifecycle;
  private closing?:Promise<void>;
  private erasures?:PostgresDriverAccountErasureStore;
  private cleanLifecycle?:DriverMeasurementStorageOptions['cleanLifecycle'];
  private guarded?:DriverGuardedOperationRunner;
  private databaseSafety?:import("../../../deploy/account-safety/database-erasure-guard.mjs").DatabaseErasureGuard;
  constructor(url: string, private hashSecret: string, options:DriverMeasurementStorageOptions={}) {
    if (hashSecret.length < 32) throw new Error("Invalid driver storage secret");
    if(options.cleanLifecycle&&(options.cleanLifecycle.mode!=='isolated-clean-lifecycle-v1'||options.guarded!==undefined||options.databaseSafety!==undefined||options.enabled===true||options.retentionConsumer!==undefined))throw new Error('CLEAN_DRIVER_COMPOSITION_CONFLICT');
    this.cleanLifecycle=options.cleanLifecycle;
    this.pool=new Pool({connectionString:url,max:4,connectionTimeoutMillis:1500,statement_timeout:5000,idleTimeoutMillis:10000});
    this.pool.on("error",()=>{ /* No connection string/error payload is logged. */ });
    this.databaseSafety=options.databaseSafety;
    // Presence opts in even when unbound: never fall back to application DML.
    if(options.guarded!==undefined)this.guarded=new DriverGuardedOperationRunner(options.guarded?.execution);
    if(!this.cleanLifecycle)this.erasures=new PostgresDriverAccountErasureStore(this.pool,hashSecret,options);
    const clean=this.cleanLifecycle;
    const consumer:DriverRetentionConsumer|undefined=clean?{owner:'sim_driver_measurements',execute:async work=>{
      await clean.service.tx(async()=>{});
      await work(Object.freeze({owner:'sim_driver_measurements',cutoff:new Date().toISOString()}));
    }}:options.retentionConsumer;
    this.retention=new DriverRetentionLifecycle({initialize:()=>this.initializeRetentionStorage(),cleanup:context=>this.cleanup(context),
      consumer,scheduler:options.retentionScheduler});
  }
  private legacyErasure():PostgresDriverAccountErasureStore {
    if(!this.erasures)throw new DriverMeasurementError(503,'CLEAN_LEGACY_ERASURE_DISABLED');
    return this.erasures;
  }
  private async assertIntake(c:PoolClient,owner:string,contributor?:string):Promise<void> {
    if(this.cleanLifecycle){if(owner!=='cop')throw new DriverMeasurementError(403,'CLEAN_OWNER_INVALID');await this.cleanLifecycle.service.assertIntake(c,contributor);return;}
    await this.legacyErasure().assertIntake(c,owner,contributor);
  }
  private key(owner:string,kind:string,value:string):string {
    return createHmac("sha256",this.hashSecret).update(`${owner}:${kind}:${value}`).digest("hex");
  }
  private id(owner:string,kind:string,value:string):string {
    const h=this.key(owner,kind,value);
    return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
  }
  async lookup(owner:string,batchId:string,hash:string):Promise<DriverReceipt|undefined> {
    const c=await this.pool.connect(),storedId=this.id(owner,"batch",batchId);
    try {
      await c.query("BEGIN");await c.query("SET LOCAL lock_timeout='1500ms'");await this.assertIntake(c,owner);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${owner}:batch:${storedId}`]);
      let r=await c.query("SELECT request_hash,receipt,contributor_hash FROM driver_measurement_receipts WHERE owner=$1 AND batch_id=$2 AND expires_at>now()",[owner,storedId]);
      if(r.rowCount){const contributor=r.rows[0].contributor_hash;
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${owner}:${contributor}`]);
        await this.assertIntake(c,owner,contributor);
        r=await c.query("SELECT request_hash,receipt FROM driver_measurement_receipts WHERE owner=$1 AND batch_id=$2 AND expires_at>now()",[owner,storedId]);
        if(r.rowCount&&r.rows[0].request_hash!==hash)throw new DriverMeasurementError(409,"DRIVER_IDEMPOTENCY_CONFLICT");}
      await c.query("COMMIT");return r.rowCount?{...r.rows[0].receipt,batchId}:undefined;
    }catch(error){await c.query("ROLLBACK").catch(()=>undefined);throw error;}finally{c.release();}
  }
  private async initializeRetentionStorage():Promise<void> {
    if(this.cleanLifecycle)await this.cleanLifecycle.service.tx(async()=>{});
    const result=await this.pool.query(`SELECT current_database() AS database_name,
      to_regclass('public.driver_measurement_receipts') IS NOT NULL AS receipts,
      to_regclass('public.driver_measurement_revocations') IS NOT NULL AS revocations`);
    if(result.rows.length!==1||result.rows[0]?.database_name!=="sim_driver_measurements"||result.rows[0].receipts!==true||result.rows[0].revocations!==true)
      throw new DriverRetentionLifecycleError("DRIVER_RETENTION_UNAVAILABLE");
    // Schema metadata verifies initialization only; it is never maintenance authority.
  }
  init():Promise<void> {return this.retention.init();}
  startRetention():Promise<void> {return this.retention.start();}
  runRetentionOnce():Promise<void> {return this.retention.runOnce();}
  private async cleanup(context:DriverRetentionOperationContext):Promise<void> {
    if(this.guarded){
      try {
        const result=await this.guarded.execute(context.operation?{operation:context.operation}:undefined,"expire",{contractVersion:"sim-driver-guarded-db-v1"});
        if(result.state!=="origin-commit-known")throw new DriverRetentionLifecycleError("DRIVER_RETENTION_UNAVAILABLE");
      }catch{throw new DriverRetentionLifecycleError("DRIVER_RETENTION_UNAVAILABLE");}
      return;
    }
    const client=await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='1500ms'");
      if(this.cleanLifecycle)await this.cleanLifecycle.service.assertIntake(client);
      await client.query("DELETE FROM public.driver_measurement_receipts WHERE expires_at<=$1::timestamptz",[context.cutoff]);
      await client.query("DELETE FROM public.driver_measurement_revocations WHERE expires_at<=$1::timestamptz",[context.cutoff]);
      await client.query("COMMIT");
    } catch(error) {await client.query("ROLLBACK").catch(()=>undefined);throw error;}
    finally {client.release();}
  }
  async commit(owner:string,contributor:string,hash:string,batch:DriverBatch,intervals:DriverInterval[],receipt:DriverReceipt):Promise<DriverReceipt> {
    const externalBatchId=batch.batchId;
    batch={...batch,batchId:this.id(owner,"batch",externalBatchId),
      ...(batch.eta ? {eta:{...batch.eta,observationId:this.id(owner,"eta",batch.eta.observationId)}} : {})};
    receipt={...receipt,batchId:batch.batchId};
    intervals=intervals.map(i=>({...i,key:this.key(owner,"interval",i.key)}));
    const client=await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Same lock for revocation and all submissions by this pseudonym, across replicas.
      await client.query("SET LOCAL lock_timeout='1500ms'");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${owner}:batch:${batch.batchId}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${owner}:${contributor}`]);
      await this.assertIntake(client,owner,contributor);
      const revoked=await client.query("SELECT 1 FROM driver_measurement_revocations WHERE owner=$1 AND contributor_hash=$2 AND expires_at>now()",[owner,contributor]);
      if (revoked.rowCount) throw new DriverMeasurementError(403,"DRIVER_CONSENT_REVOKED");
      const old=await client.query("SELECT request_hash,receipt FROM driver_measurement_receipts WHERE owner=$1 AND batch_id=$2",[owner,batch.batchId]);
      if (old.rowCount) {
        if (old.rows[0].request_hash!==hash) throw new DriverMeasurementError(409,"DRIVER_IDEMPOTENCY_CONFLICT");
        await client.query("COMMIT"); return {...old.rows[0].receipt,batchId:externalBatchId};
      }
      await client.query("INSERT INTO driver_measurement_receipts(owner,batch_id,contributor_hash,request_hash,received_at,expires_at,receipt) VALUES($1,$2,$3,$4,now(),now()+interval '7 days',$5)",[owner,batch.batchId,contributor,hash,JSON.stringify(receipt)]);
      // One bounded bulk statement rather than one database round trip per GPS pair.
      const insertedRows=await client.query(`INSERT INTO driver_measurement_intervals(owner,batch_id,measurement_key,dataset,edge_id,window_start,speed_kph,distance_m,elapsed_seconds)
        SELECT $1,$2,i.* FROM unnest($3::text[],$4::text[],$5::text[],$6::timestamptz[],
          $7::double precision[],$8::double precision[],$9::double precision[]) AS i
        ON CONFLICT(owner,measurement_key) DO NOTHING`,
      [owner,batch.batchId,intervals.map(i=>i.key),intervals.map(i=>i.dataset),intervals.map(i=>i.edgeId),
        intervals.map(i=>i.windowStart),intervals.map(i=>i.speedKph),intervals.map(i=>i.distanceM),intervals.map(i=>i.elapsedSeconds)]);
      const inserted=insertedRows.rowCount??0;
      const result={...receipt,acceptedIntervalCount:inserted,deduplicatedIntervalCount:intervals.length-inserted};
      if (result.etaAccepted && batch.eta) {
        const e=batch.eta;
        const insertedEta=await client.query("INSERT INTO driver_measurement_eta(owner,batch_id,observation_id,contributor_hash,dataset,window_start,predicted_seconds,actual_seconds) VALUES($1,$2,$3,$4,$5,date_trunc('hour',$6::timestamptz),$7,$8) ON CONFLICT(owner,contributor_hash,observation_id) DO NOTHING",[owner,batch.batchId,e.observationId,contributor,e.routingDataset,e.completedAt,e.predictedDurationSeconds,e.actualDurationSeconds]);
        result.etaAccepted=(insertedEta.rowCount??0)>0;
      }
      await client.query("UPDATE driver_measurement_receipts SET receipt=$3 WHERE owner=$1 AND batch_id=$2",[owner,batch.batchId,JSON.stringify(result)]);
      await client.query("COMMIT"); return {...result,batchId:externalBatchId};
    } catch(error) { await client.query("ROLLBACK").catch(()=>undefined); throw error; }
    finally {client.release();}
  }
  private async assertPublication(publication?:DriverPublicationLease):Promise<void> {
    if(this.cleanLifecycle)await this.cleanLifecycle.service.tx(async()=>{});
    if(!this.guarded)return;
    // Only an already held production Root publication port may supply this
    // callback. A short-lived read admission is not a publication/drain lease.
    try {
      if(!publication||typeof publication.assertCurrent!=="function")throw new Error();
      await publication.assertCurrent();
    }catch{throw new DriverMeasurementError(503,"DRIVER_MEASUREMENTS_UNAVAILABLE");}
  }
  async aggregates(dataset:string,since:string,now:string,publication?:DriverPublicationLease):Promise<unknown[]> {
    await this.assertPublication(publication);
    // Each attested contributor gets equal weight; a phone cannot dominate by oversampling.
    const r=await this.pool.query(`WITH per_contributor AS (
      SELECT i.dataset,i.edge_id,i.window_start,r.contributor_hash,count(*) AS intervals,
        percentile_cont(0.5) WITHIN GROUP(ORDER BY i.speed_kph) AS median_speed
      FROM driver_measurement_intervals i JOIN driver_measurement_receipts r USING(owner,batch_id)
      WHERE i.dataset=$1 AND i.window_start>=$2 AND r.expires_at>$3
      GROUP BY i.dataset,i.edge_id,i.window_start,r.contributor_hash
    ) SELECT dataset,edge_id AS "directedEdgeId",window_start AS "windowStart",
      count(*)::integer AS "attestedContributorCount",sum(intervals)::integer AS "intervalCount",
      percentile_cont(0.5) WITHIN GROUP(ORDER BY median_speed) AS "medianSpeedKph",
      percentile_cont(0.1) WITHIN GROUP(ORDER BY median_speed) AS "p10SpeedKph",
      percentile_cont(0.9) WITHIN GROUP(ORDER BY median_speed) AS "p90SpeedKph",
      window_start+interval '5 minutes' AS "usableUntil",
      CASE WHEN window_start+interval '5 minutes'>$3 THEN 'current' ELSE 'historical' END AS state
      FROM per_contributor GROUP BY dataset,edge_id,window_start HAVING count(*)>=5 AND sum(intervals)>=10
      ORDER BY window_start DESC,edge_id LIMIT 1000`,[dataset,since,now]);
    await this.assertPublication(publication);
    return r.rows;
  }
  async quality(now:string,publication?:DriverPublicationLease):Promise<unknown> {
    await this.assertPublication(publication);
    const r=await this.pool.query(`SELECT count(*)::integer AS "retainedBatchCount",
      max(received_at) AS "lastAcceptedAt",coalesce(sum((receipt->>'acceptedIntervalCount')::integer),0)::integer AS "acceptedIntervalCount"
      FROM driver_measurement_receipts WHERE expires_at>$1`,[now]);
    const eta=await this.pool.query(`WITH per_contributor AS (
      SELECT e.dataset,e.window_start,r.contributor_hash,count(*) AS n,
        percentile_cont(0.5) WITHIN GROUP(ORDER BY abs(e.actual_seconds-e.predicted_seconds)) AS error_seconds,
        percentile_cont(0.5) WITHIN GROUP(ORDER BY 100*abs(e.actual_seconds-e.predicted_seconds)/e.predicted_seconds) AS error_percent
      FROM driver_measurement_eta e JOIN driver_measurement_receipts r USING(owner,batch_id)
      WHERE r.expires_at>$1 GROUP BY e.dataset,e.window_start,r.contributor_hash)
      SELECT dataset,window_start AS "windowStart",count(*)::integer AS "attestedContributorCount",sum(n)::integer AS "observationCount",
        percentile_cont(0.5) WITHIN GROUP(ORDER BY error_seconds) AS "medianAbsoluteErrorSeconds",
        percentile_cont(0.5) WITHIN GROUP(ORDER BY error_percent) AS "medianAbsoluteErrorPercent"
      FROM per_contributor GROUP BY dataset,window_start HAVING count(*)>=5 AND sum(n)>=10
      ORDER BY window_start DESC LIMIT 100`,[now]);
    const rejected=await this.pool.query(`SELECT reason,sum(value::integer)::integer AS count
      FROM driver_measurement_receipts r CROSS JOIN LATERAL jsonb_each_text(r.receipt->'rejectionCounts') AS v(reason,value)
      WHERE r.expires_at>$1 GROUP BY reason`,[now]);
    await this.assertPublication(publication);
    return {...r.rows[0],rejectionCounts:Object.fromEntries(rejected.rows.map(x=>[x.reason,x.count])),eta:eta.rows};
  }
  async revoke(owner:string,contributor:string,context?:DriverGuardedOperationContext):Promise<number> {
    if(this.guarded){
      try {
        if(owner!=="cop"||typeof contributor!=="string"||!/^[0-9a-f]{64}$/u.test(contributor))throw new Error("Invalid guarded owner/contributor");
        const result=await this.guarded.execute(context,"revoke",{contractVersion:"sim-driver-guarded-db-v1",contributorHash:contributor});
        const count=result.state==="origin-commit-known"?result.revokeEffect?.deletedBatchCount:undefined;
        if(!Number.isSafeInteger(count)||count===undefined||count<0||count>2_147_483_647)throw new Error("Missing guarded revoke receipt");
        return count;
      }catch{throw new DriverMeasurementError(503,"DRIVER_MEASUREMENTS_UNAVAILABLE");}
    }
    if(this.databaseSafety)return this.databaseSafety.withReportMaintenance(()=>this.revokeStored(owner,contributor));
    return this.revokeStored(owner,contributor);
  }
  private async revokeStored(owner:string,contributor:string):Promise<number>{
    const c=await this.pool.connect();
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL lock_timeout='1500ms'");
      if(this.cleanLifecycle)await this.assertIntake(c,owner,contributor);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${owner}:${contributor}`]);
      await c.query("INSERT INTO driver_measurement_revocations(owner,contributor_hash,expires_at) VALUES($1,$2,now()+interval '7 days') ON CONFLICT(owner,contributor_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at",[owner,contributor]);
      const r=await c.query("DELETE FROM driver_measurement_receipts WHERE owner=$1 AND contributor_hash=$2",[owner,contributor]);
      await c.query("COMMIT"); return r.rowCount??0;
    } catch(error) { await c.query("ROLLBACK").catch(()=>undefined); throw error; } finally {c.release();}
  }
  close():Promise<void> {
    if(!this.closing)this.closing=(async()=>{
      try{await this.retention.close();}
      finally{
        try{
          if(this.guarded){
            const settled=await Promise.allSettled([this.guarded.close(),this.legacyErasure().closeGuarded()]);
            for(const result of settled)if(result.status==="rejected")throw result.reason;
          }
        }
        finally{await this.pool.end();}
      }
    })();
    return this.closing;
  }
  accountErasure(input:DriverErasureInput,context?:DriverGuardedOperationContext){return this.legacyErasure().erase(input,context);}
  accountErasureStatus(id:string,actorHash:string){return this.legacyErasure().status(id,actorHash);}
  acknowledgeAccountErasure(input:DriverErasureInput,context?:DriverGuardedOperationContext){return this.legacyErasure().acknowledge(input,context);}
  accountErasureCapability(){return this.legacyErasure().capability();}
  accountErasurePreflight(input:DriverErasureInput){return this.legacyErasure().preflight(input);}
}
