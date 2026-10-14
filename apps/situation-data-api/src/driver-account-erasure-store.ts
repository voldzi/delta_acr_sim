import type {Pool,PoolClient} from "pg";
import {DRIVER_ACCOUNT_ERASURE_CONTRACT,DriverAccountErasureError,driverErasureHash,validateDriverErasureCoverage,
  type DriverErasureInput,type DriverErasureReceipt,type DriverErasureCapability,type DriverErasurePreflight,type DriverErasureReportProtection,type DriverErasureBlocker} from "./driver-account-erasure.js";
/** Supplied only by a protected current-deployment guard, never a client/body/env flag. */
export interface DriverErasureProtectedProof {checkpoint:string;restoreCheckpointCurrent:boolean;identityReviewed:boolean;retentionReviewed:boolean;publicationFenceVerified:boolean;reportProtection:DriverErasureReportProtection}
export interface DriverErasureStorageOptions {enabled?:boolean;expectedCheckpoint?:string;identityConfigured?:boolean;protectedProof?:()=>Promise<DriverErasureProtectedProof>}
type Queryable=Pick<PoolClient,"query">;
interface Gate {installed:boolean;permissions:boolean;identity:boolean;replay:boolean;retention:boolean;publication:boolean;protection:DriverErasureReportProtection;checkpoint:string|null;checkedAt:string;active:boolean}
/** Only scalar operation evidence and unlinked daily fences are durable. */
export class PostgresDriverAccountErasureStore {
  constructor(private pool:Pool,private secret:string,private options:DriverErasureStorageOptions={}){}
  private key(id:string):string{return driverErasureHash(this.secret,"cop:account-erasure-operation",id);}
  async gate(c:Queryable=this.pool,ordinaryIntake=false):Promise<Gate>{
    const schema=await c.query(`SELECT now() AS at,to_regclass('public.driver_account_erasure_state') IS NOT NULL
      AND to_regclass('public.driver_account_erasure_operations') IS NOT NULL AND to_regclass('public.driver_account_erasure_revocations') IS NOT NULL
      AND EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=to_regclass('public.driver_measurement_receipts')
        AND t.tgname='driver_account_erasure_receipt_guard' AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND t.tgtype=23
        AND NOT p.prosecdef AND position('driver-account-erasure-receipt-guard-v1' IN pg_get_functiondef(p.oid))>0) AS installed`);
    const empty:Gate={installed:false,permissions:false,identity:false,replay:false,retention:false,publication:false,protection:"unverified",checkpoint:null,checkedAt:new Date(schema.rows[0].at).toISOString(),active:false};
    if(!schema.rows[0]?.installed)return empty;
    const privileges=await c.query(`SELECT
      has_table_privilege(current_user,'driver_account_erasure_state','SELECT') AND NOT has_table_privilege(current_user,'driver_account_erasure_state','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND has_table_privilege(current_user,'driver_account_erasure_operations','SELECT') AND has_table_privilege(current_user,'driver_account_erasure_operations','INSERT') AND has_table_privilege(current_user,'driver_account_erasure_operations','UPDATE')
      AND NOT has_table_privilege(current_user,'driver_account_erasure_operations','DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND has_table_privilege(current_user,'driver_account_erasure_revocations','SELECT') AND has_table_privilege(current_user,'driver_account_erasure_revocations','INSERT')
      AND NOT has_table_privilege(current_user,'driver_account_erasure_revocations','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND has_function_privilege(current_user,'driver_account_erasure_receipt_guard()','EXECUTE')
      AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS ready FROM pg_roles WHERE rolname=current_user`);
    const state=await c.query("SELECT *,proof_valid_until>now() AS valid FROM driver_account_erasure_state WHERE singleton=true");
    const active=(await c.query("SELECT EXISTS(SELECT 1 FROM driver_account_erasure_operations) OR EXISTS(SELECT 1 FROM driver_account_erasure_revocations) AS active")).rows[0].active===true;
    const proof=this.options.protectedProof&&(!ordinaryIntake||active)?await this.options.protectedProof():undefined;
    const checkpoint=this.options.expectedCheckpoint?driverErasureHash(this.secret,"cop:account-erasure-checkpoint",this.options.expectedCheckpoint):null;
    const row=state.rows[0],valid=state.rowCount===1&&row.valid===true&&!!checkpoint&&row.replay_checkpoint_hash===checkpoint&&proof?.checkpoint===this.options.expectedCheckpoint;
    return {...empty,installed:true,permissions:privileges.rows[0]?.ready===true,active,
      identity:valid&&proof?.identityReviewed===true&&this.options.identityConfigured===true,
      replay:valid&&row.replay_ready===true&&proof?.restoreCheckpointCurrent===true,retention:valid&&row.retention_reviewed===true&&proof?.retentionReviewed===true,
      publication:valid&&row.publication_fence_verified===true&&row.report_protection!=="unverified"&&proof?.publicationFenceVerified===true&&proof.reportProtection===row.report_protection,
      protection:valid?row.report_protection:"unverified",checkpoint:valid?checkpoint:null};
  }
  async assertIntake(c:Queryable,owner:string,contributor?:string):Promise<void>{
    const gate=await this.gate(c,true);if(!gate.installed){
      const ledger=await c.query("SELECT to_regclass('public.driver_account_erasure_operations') IS NOT NULL AS operations,to_regclass('public.driver_account_erasure_revocations') IS NOT NULL AS fences");
      const operations=ledger.rows[0].operations?(await c.query("SELECT EXISTS(SELECT 1 FROM driver_account_erasure_operations) AS active")).rows[0].active:false;
      const fences=ledger.rows[0].fences?(await c.query("SELECT EXISTS(SELECT 1 FROM driver_account_erasure_revocations) AS active")).rows[0].active:false;
      if(operations||fences)throw new DriverAccountErasureError(503,"DRIVER_ACCOUNT_ERASURE_REPLAY_REQUIRED");return;}
    // An initially empty installation does not disable ordinary existing pilot intake.
    if(gate.active&&(!gate.replay||!gate.permissions))throw new DriverAccountErasureError(503,"DRIVER_ACCOUNT_ERASURE_REPLAY_REQUIRED");
    if(contributor){const found=await c.query("SELECT 1 FROM driver_account_erasure_revocations WHERE owner=$1 AND contributor_hash=$2",[owner,contributor]);
      if(found.rowCount)throw new DriverAccountErasureError(403,"DRIVER_CONSENT_REVOKED");}
    if(gate.active)await c.query("SELECT set_config('sim.driver_erasure_context','driver-account-erasure-v1',true),set_config('sim.driver_erasure_checkpoint',$1,true)",[gate.checkpoint]);
  }
  private capabilityFrom(gate:Gate):DriverErasureCapability{return {contractVersion:DRIVER_ACCOUNT_ERASURE_CONTRACT,owner:"sim_measurements",scope:"online_driver_scope",enabled:this.options.enabled===true,
    checkedAt:gate.checkedAt,mutates:false,providerCalls:false,wholeAccountComplete:false,reportProtection:gate.protection,
    checks:{schemaReady:gate.installed,permissionsReady:gate.permissions,identityReviewed:gate.identity,restoreCheckpointCurrent:gate.replay,retentionReviewed:gate.retention,publicationFenceVerified:gate.publication},
    ready:this.options.enabled===true&&gate.installed&&gate.permissions&&gate.identity&&gate.replay&&gate.retention&&gate.publication,blockers:this.blockers(gate)};}
  async capability():Promise<DriverErasureCapability>{return this.capabilityFrom(await this.gate());}
  private check(row:Record<string,any>,input:Pick<DriverErasureInput,"actorHash"|"requestHash">):void{
    if(row.actor_hash!==input.actorHash)throw new DriverAccountErasureError(404,"DRIVER_ACCOUNT_ERASURE_NOT_FOUND");
    if(row.request_hash!==input.requestHash)throw new DriverAccountErasureError(409,"DRIVER_ACCOUNT_ERASURE_CONFLICT");
  }
  private blockers(gate:Gate):DriverErasureBlocker[]{return [...(!this.options.enabled?["erasure_disabled" as const]:[]),...(!gate.installed?["schema_not_ready" as const]:[]),...(!gate.permissions?["permissions_not_ready" as const]:[]),
    ...(!gate.identity?["identity_review_required" as const]:[]),...(!gate.replay?["restore_checkpoint_not_current" as const]:[]),...(!gate.retention?["retention_review_required" as const]:[]),...(!gate.publication?["publication_proof_required" as const]:[])];}
  async preflight(input:DriverErasureInput):Promise<DriverErasurePreflight>{
    const c=await this.pool.connect();try{
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");const gate=await this.gate(c);
      if(!gate.installed)throw new DriverAccountErasureError(503,"DRIVER_ACCOUNT_ERASURE_UNAVAILABLE");
      const prior=await c.query("SELECT actor_hash,request_hash,created_at FROM driver_account_erasure_operations WHERE operation_hash=$1",[this.key(input.operationId)]);
      if(prior.rowCount)this.check(prior.rows[0],input);
      const clock=prior.rowCount?new Date(prior.rows[0].created_at).getTime():new Date((await c.query("SELECT clock_timestamp() AS at")).rows[0].at).getTime();
      validateDriverErasureCoverage(input,clock);await c.query("COMMIT");
      const capability={...this.capabilityFrom(gate),checkedAt:prior.rowCount?gate.checkedAt:new Date(clock).toISOString()};
      return {...capability,checks:{...capability.checks,identityBindingReviewed:true,manifestShapeAndCoverageValid:true},operationId:input.operationId,manifestValid:true,
        identityBinding:"cop_attested_daily_manifest",coverageAnchor:{kind:prior.rowCount?"first_accepted_at":"checked_at",at:new Date(clock).toISOString()},contributorCount:input.contributors.length};
    }catch(error){await c.query("ROLLBACK").catch(()=>undefined);throw error;}finally{c.release();}
  }
  private receipt(id:string,row:Record<string,any>,gate:Gate):DriverErasureReceipt{
    const zero=row.database_zero_verified===true&&row.remaining_batch_count===0,ack=row.derived_report_acknowledged===true;
    const replay=gate.replay&&row.replay_checkpoint_hash===gate.checkpoint;
    const complete=row.status==="completed"&&zero&&ack&&replay&&gate.publication&&gate.retention&&gate.permissions&&gate.identity;
    return {contractVersion:DRIVER_ACCOUNT_ERASURE_CONTRACT,operationId:id,status:complete?"completed":"pending",scope:"online_driver_scope",wholeAccountComplete:false,backupReplayRequired:true,
      acceptedAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),contributorCount:row.contributor_count,deletedBatchCount:row.deleted_batch_count,
      remainingBatchCount:row.remaining_batch_count,databaseZeroVerified:zero,derivedReportAcknowledged:ack,reportProtection:gate.protection,publicationFenceVerified:gate.publication,
      replayReady:replay,retentionReviewed:gate.retention,pendingReason:complete?null:!zero?"stored_rows_remaining":!gate.retention?"retention_review_required":!replay||!gate.permissions||!gate.identity?"replay_review_required":!gate.publication?"publisher_review_required":"derived_report_pending"};
  }
  private async lockOp(c:PoolClient,key:string):Promise<void>{await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`cop:account-erasure:${key}`]);}
  private async lockContributors(c:PoolClient,input:DriverErasureInput):Promise<string[]>{const hashes=[...new Set(input.contributors.map(row=>row.contributorHash))].sort();
    for(const hash of hashes)await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`cop:${hash}`]);return hashes;}
  private async remaining(c:PoolClient,hashes:string[]):Promise<number>{return (await c.query("SELECT count(*)::integer AS n FROM driver_measurement_receipts WHERE owner='cop' AND contributor_hash=ANY($1::text[])",[hashes])).rows[0].n;}
  async erase(input:DriverErasureInput):Promise<DriverErasureReceipt>{const c=await this.pool.connect(),key=this.key(input.operationId);try{
    await c.query("BEGIN");await c.query("SET LOCAL lock_timeout='1500ms'");const gate=await this.gate(c);
    if(!gate.installed)throw new DriverAccountErasureError(503,"DRIVER_ACCOUNT_ERASURE_UNAVAILABLE");await this.lockOp(c,key);
    const prior=await c.query("SELECT * FROM driver_account_erasure_operations WHERE operation_hash=$1",[key]);
    if(prior.rowCount)this.check(prior.rows[0],input);else{
      if(!this.capabilityFrom(gate).ready)throw new DriverAccountErasureError(503,"DRIVER_ACCOUNT_ERASURE_NOT_READY");
      const accepted=(await c.query("SELECT clock_timestamp() AS at")).rows[0].at;
      validateDriverErasureCoverage(input,new Date(accepted).getTime());
      await c.query("INSERT INTO driver_account_erasure_operations(operation_hash,actor_hash,request_hash,contributor_count,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)",[key,input.actorHash,input.requestHash,input.contributors.length,accepted]);}
    const hashes=await this.lockContributors(c,input);
    await c.query("INSERT INTO driver_account_erasure_revocations(owner,contributor_hash) SELECT 'cop',v FROM unnest($1::text[]) AS v ON CONFLICT(owner,contributor_hash) DO NOTHING",[hashes]);
    const deleted=await c.query("DELETE FROM driver_measurement_receipts WHERE owner='cop' AND contributor_hash=ANY($1::text[])",[hashes]);
    const left=await this.remaining(c,hashes);
    const row=await c.query(`UPDATE driver_account_erasure_operations SET updated_at=now(),deleted_batch_count=deleted_batch_count+$2,remaining_batch_count=$3,database_zero_verified=$4,
      derived_report_acknowledged=false,status='pending',replay_checkpoint_hash=$5 WHERE operation_hash=$1 RETURNING *`,[key,deleted.rowCount??0,left,left===0,gate.checkpoint]);
    await c.query("COMMIT");return this.receipt(input.operationId,row.rows[0],gate);
  }catch(error){await c.query("ROLLBACK").catch(()=>undefined);throw error;}finally{c.release();}}
  /** Read-only status; only a repeated POST can replay the COP-owned manifest. */
  async status(id:string,actorHash:string):Promise<DriverErasureReceipt|undefined>{const c=await this.pool.connect();try{
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");const gate=await this.gate(c);
    if(!gate.installed)throw new DriverAccountErasureError(503,"DRIVER_ACCOUNT_ERASURE_UNAVAILABLE");
    const row=await c.query("SELECT * FROM driver_account_erasure_operations WHERE operation_hash=$1 AND actor_hash=$2",[this.key(id),actorHash]);
    await c.query("COMMIT");return row.rowCount?this.receipt(id,row.rows[0],gate):undefined;
  }catch(error){await c.query("ROLLBACK").catch(()=>undefined);throw error;}finally{c.release();}}
  async acknowledge(input:DriverErasureInput):Promise<DriverErasureReceipt>{const c=await this.pool.connect(),key=this.key(input.operationId);try{
    await c.query("BEGIN");await c.query("SET LOCAL lock_timeout='1500ms'");const gate=await this.gate(c);await this.lockOp(c,key);
    const prior=await c.query("SELECT * FROM driver_account_erasure_operations WHERE operation_hash=$1",[key]);
    if(!prior.rowCount)throw new DriverAccountErasureError(404,"DRIVER_ACCOUNT_ERASURE_NOT_FOUND");this.check(prior.rows[0],input);
    const left=await this.remaining(c,await this.lockContributors(c,input));
    const complete=left===0&&gate.replay&&gate.publication&&gate.retention&&gate.permissions&&gate.identity;
    const row=await c.query("UPDATE driver_account_erasure_operations SET updated_at=now(),remaining_batch_count=$2,database_zero_verified=$3,derived_report_acknowledged=$4,status=$5,replay_checkpoint_hash=$6 WHERE operation_hash=$1 RETURNING *",
      [key,left,left===0,gate.publication,complete?"completed":"pending",gate.checkpoint]);
    await c.query("COMMIT");return this.receipt(input.operationId,row.rows[0],gate);
  }catch(error){await c.query("ROLLBACK").catch(()=>undefined);throw error;}finally{c.release();}}
}
