import { Pool } from "pg";
import { createHmac } from "node:crypto";
import { DriverMeasurementError, type DriverBatch, type DriverInterval, type DriverReceipt, type DriverStore } from "./driver-measurements.js";

/** Dedicated database only; no DDL or raw position persistence in the runtime. */
export class PostgresDriverMeasurementStore implements DriverStore {
  private pool: Pool;
  private timer: ReturnType<typeof setInterval>;
  constructor(url: string, private hashSecret: string) {
    if (hashSecret.length < 32) throw new Error("Invalid driver storage secret");
    this.pool=new Pool({connectionString:url,max:4,connectionTimeoutMillis:1500,statement_timeout:5000,idleTimeoutMillis:10000});
    this.pool.on("error",()=>{ /* No connection string/error payload is logged. */ });
    this.timer=setInterval(()=>{void this.cleanup().catch(()=>undefined);},60000); this.timer.unref();
  }
  private key(owner:string,kind:string,value:string):string {
    return createHmac("sha256",this.hashSecret).update(`${owner}:${kind}:${value}`).digest("hex");
  }
  private id(owner:string,kind:string,value:string):string {
    const h=this.key(owner,kind,value);
    return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
  }
  async lookup(owner:string,batchId:string,hash:string):Promise<DriverReceipt|undefined> {
    const r=await this.pool.query("SELECT request_hash,receipt FROM driver_measurement_receipts WHERE owner=$1 AND batch_id=$2 AND expires_at>now()",[owner,this.id(owner,"batch",batchId)]);
    if (!r.rowCount) return undefined;
    if (r.rows[0].request_hash!==hash) throw new DriverMeasurementError(409,"DRIVER_IDEMPOTENCY_CONFLICT");
    return {...r.rows[0].receipt,batchId};
  }
  private async cleanup():Promise<void> {
    await this.pool.query("DELETE FROM driver_measurement_receipts WHERE expires_at<=now()");
    await this.pool.query("DELETE FROM driver_measurement_revocations WHERE expires_at<=now()");
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
  async aggregates(dataset:string,since:string,now:string):Promise<unknown[]> {
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
    return r.rows;
  }
  async quality(now:string):Promise<unknown> {
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
    return {...r.rows[0],rejectionCounts:Object.fromEntries(rejected.rows.map(x=>[x.reason,x.count])),eta:eta.rows};
  }
  async revoke(owner:string,contributor:string):Promise<number> {
    const c=await this.pool.connect();
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL lock_timeout='1500ms'");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`${owner}:${contributor}`]);
      await c.query("INSERT INTO driver_measurement_revocations(owner,contributor_hash,expires_at) VALUES($1,$2,now()+interval '7 days') ON CONFLICT(owner,contributor_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at",[owner,contributor]);
      const r=await c.query("DELETE FROM driver_measurement_receipts WHERE owner=$1 AND contributor_hash=$2",[owner,contributor]);
      await c.query("COMMIT"); return r.rowCount??0;
    } catch(error) { await c.query("ROLLBACK").catch(()=>undefined); throw error; } finally {c.release();}
  }
  async close():Promise<void> {clearInterval(this.timer);await this.pool.end();}
}
