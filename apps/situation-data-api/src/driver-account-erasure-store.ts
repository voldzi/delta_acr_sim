import type {Pool,PoolClient} from "pg";
import {types} from "node:util";
import {DriverGuardedOperationRunner,readDriverGuardedAdmission} from "./driver-guarded-execution.js";
import type {DriverGuardedOperationContext,DriverGuardedReadRequest,DriverGuardedStoreOptions,DriverGuardedAckBody} from "./driver-guarded-execution-port.js";
import {DRIVER_ACCOUNT_ERASURE_CONTRACT,DriverAccountErasureError,driverErasureHash,validateDriverErasureCoverage,
  type DriverErasureInput,type DriverErasureReceipt,type DriverErasureCapability,type DriverErasurePreflight,type DriverErasureReportProtection,type DriverErasureBlocker} from "./driver-account-erasure.js";
/** Supplied only by a protected current-deployment guard, never a client/body/env flag. */
export interface DriverErasureProtectedProof {checkpoint:string;restoreCheckpointCurrent:boolean;identityReviewed:boolean;retentionReviewed:boolean;publicationFenceVerified:boolean;reportProtection:DriverErasureReportProtection}
export interface DriverErasureStorageOptions {enabled?:boolean;expectedCheckpoint?:string;identityConfigured?:boolean;protectedProof?:()=>Promise<DriverErasureProtectedProof>;guarded?:DriverGuardedStoreOptions}
type Queryable=Pick<PoolClient,"query">;
interface Gate {installed:boolean;permissions:boolean;identity:boolean;replay:boolean;retention:boolean;publication:boolean;protection:DriverErasureReportProtection;checkpoint:string|null;checkedAt:string;active:boolean}
/** Only scalar operation evidence and unlinked daily fences are durable. */
export class PostgresDriverAccountErasureStore {
  readonly #guardedMode:boolean;
  private readonly options:DriverErasureStorageOptions;
  private guardedRunner:DriverGuardedOperationRunner;
  constructor(private pool:Pool,private secret:string,options:DriverErasureStorageOptions={}){
    this.#guardedMode=options.guarded!==undefined;
    const execution=options.guarded?.execution,admission=options.guarded?.admission;
    // Own the mode/configuration and method references. A caller deleting or
    // mutating its options later must never switch this instance to raw SQL.
    const guarded=this.#guardedMode?Object.freeze({
      ...(execution&&typeof execution.execute==="function"&&typeof execution.probe==="function"?{execution:Object.freeze({execute:execution.execute.bind(execution),probe:execution.probe.bind(execution)})}:{}),
      ...(admission&&typeof admission.inspect==="function"?{admission:Object.freeze({inspect:admission.inspect.bind(admission)})}:{}),
    }):undefined;
    // Preserve the existing legacy configuration/callback semantics. Only the
    // explicit guarded instance owns a frozen dependency/configuration snapshot.
    this.options=this.#guardedMode?Object.freeze({...options,guarded}):options;
    this.guardedRunner=new DriverGuardedOperationRunner(guarded?.execution);
  }
  closeGuarded():Promise<void>{return this.guardedRunner.close();}
  private key(id:string):string{return driverErasureHash(this.secret,"cop:account-erasure-operation",id);}
  /** Catalog reads only: never invoke a database-supplied guard or Root probe. */
  private async guardedPrivileges(c:Queryable):Promise<{rows:Array<{ready:boolean}>}>{return c.query(`SELECT CASE
    WHEN to_regnamespace('sim_driver_guard_source') IS NULL THEN false ELSE coalesce(
      current_user='driver_measurements_runtime'
      AND NOT EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=current_user)
      AND NOT has_database_privilege(current_user,current_database(),'CREATE,TEMP')
      AND NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE has_schema_privilege(current_user,n.oid,'CREATE'))
      AND NOT has_schema_privilege(current_user,'sim_driver_guard_source','USAGE,CREATE')
      AND (SELECT count(*)=7 AND bool_and(pg_get_userbyid(t.relowner)='driver_measurements_migrator'
        AND NOT t.relrowsecurity AND NOT t.relforcerowsecurity
        AND has_table_privilege(current_user,t.oid,'SELECT')
        AND NOT has_table_privilege(current_user,t.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
        FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relkind='r'
          AND t.relname IN ('driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta',
            'driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations'))
      AND (SELECT count(*)=3 AND bool_and(has_table_privilege(current_user,t.oid,'INSERT'))
        FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relkind='r'
          AND t.relname IN ('driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta'))
      AND NOT EXISTS(SELECT 1 FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
        AND t.relname IN ('driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations')
        AND has_table_privilege(current_user,t.oid,'INSERT'))
      AND has_column_privilege(current_user,'public.driver_measurement_receipts','receipt','UPDATE')
      AND NOT EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class t ON t.oid=a.attrelid JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
          AND t.relname IN ('driver_measurement_receipts','driver_measurement_intervals','driver_measurement_eta',
            'driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations')
          AND ((NOT(t.relname='driver_measurement_receipts' AND a.attname='receipt') AND has_column_privilege(current_user,t.oid,a.attnum,'UPDATE'))
            OR has_column_privilege(current_user,t.oid,a.attnum,'REFERENCES')
            OR (t.relname IN ('driver_measurement_revocations','driver_account_erasure_state','driver_account_erasure_operations','driver_account_erasure_revocations')
              AND has_column_privilege(current_user,t.oid,a.attnum,'INSERT'))))
      AND has_function_privilege(current_user,'public.driver_account_erasure_receipt_guard()','EXECUTE')
      AND (SELECT count(*)=5 AND bool_and(p.prosecdef AND pg_get_userbyid(p.proowner)='sim_driver_guard_owner'
          AND NOT has_function_privilege(current_user,p.oid,'EXECUTE'))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='sim_driver_guard_source'
          AND p.proname IN ('register_origin','claim_origin','execute_origin','resolve_or_seal','read_publication_context'))
      AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls),false)
    END AS ready FROM pg_roles WHERE rolname=current_user`);}
  async gate(c:Queryable=this.pool,ordinaryIntake=false,request?:Pick<DriverGuardedReadRequest,"purpose"|"operationHash"|"actorHash">):Promise<Gate>{
    const schema=await c.query(`SELECT now() AS at,to_regclass('public.driver_account_erasure_state') IS NOT NULL
      AND to_regclass('public.driver_account_erasure_operations') IS NOT NULL AND to_regclass('public.driver_account_erasure_revocations') IS NOT NULL
      AND EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=to_regclass('public.driver_measurement_receipts')
        AND t.tgname='driver_account_erasure_receipt_guard' AND NOT t.tgisinternal AND t.tgenabled IN ('O','A') AND t.tgtype=23
        AND NOT p.prosecdef AND position('driver-account-erasure-receipt-guard-v1' IN pg_get_functiondef(p.oid))>0) AS installed`);
    const empty:Gate={installed:false,permissions:false,identity:false,replay:false,retention:false,publication:false,protection:"unverified",checkpoint:null,checkedAt:new Date(schema.rows[0].at).toISOString(),active:false};
    if(!schema.rows[0]?.installed)return empty;
    const guarded=this.#guardedMode;
    const privileges=guarded?await this.guardedPrivileges(c):await c.query(`SELECT
      has_table_privilege(current_user,'driver_account_erasure_state','SELECT') AND NOT has_table_privilege(current_user,'driver_account_erasure_state','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND has_table_privilege(current_user,'driver_account_erasure_operations','SELECT') AND has_table_privilege(current_user,'driver_account_erasure_operations','INSERT') AND has_table_privilege(current_user,'driver_account_erasure_operations','UPDATE')
      AND NOT has_table_privilege(current_user,'driver_account_erasure_operations','DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND has_table_privilege(current_user,'driver_account_erasure_revocations','SELECT') AND has_table_privilege(current_user,'driver_account_erasure_revocations','INSERT')
      AND NOT has_table_privilege(current_user,'driver_account_erasure_revocations','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND has_function_privilege(current_user,'driver_account_erasure_receipt_guard()','EXECUTE')
      AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS ready FROM pg_roles WHERE rolname=current_user`);
    const state=await c.query("SELECT *,proof_valid_until>now() AS valid FROM driver_account_erasure_state WHERE singleton=true");
    const active=(await c.query("SELECT EXISTS(SELECT 1 FROM driver_account_erasure_operations) OR EXISTS(SELECT 1 FROM driver_account_erasure_revocations) AS active")).rows[0].active===true;
    const proof=!guarded&&this.options.protectedProof&&(!ordinaryIntake||active)?await this.options.protectedProof():undefined;
    const admission=guarded?await readDriverGuardedAdmission(this.options.guarded,{owner:"sim_driver_measurements",scope:"online_driver_scope",purpose:ordinaryIntake?"intake":"capability",...request}):undefined;
    const configuredCheckpoint=this.options.expectedCheckpoint?driverErasureHash(this.secret,"cop:account-erasure-checkpoint",this.options.expectedCheckpoint):null;
    const checkpoint=guarded?(admission?.checkpointHash??null):configuredCheckpoint;
    const row=state.rows[0],valid=state.rowCount===1&&row.valid===true&&!!checkpoint&&row.replay_checkpoint_hash===checkpoint&&
      (guarded?!!admission&&(!configuredCheckpoint||configuredCheckpoint===checkpoint):proof?.checkpoint===this.options.expectedCheckpoint);
    return {...empty,installed:true,permissions:privileges.rows[0]?.ready===true,active,
      identity:valid&&(guarded||proof?.identityReviewed===true)&&this.options.identityConfigured===true,
      replay:valid&&row.replay_ready===true&&(guarded||proof?.restoreCheckpointCurrent===true),retention:valid&&row.retention_reviewed===true&&(guarded||proof?.retentionReviewed===true),
      publication:valid&&row.publication_fence_verified===true&&row.report_protection!=="unverified"&&(guarded?admission?.reportProtection===row.report_protection:proof?.publicationFenceVerified===true&&proof.reportProtection===row.report_protection),
      protection:valid?row.report_protection:"unverified",checkpoint:valid?checkpoint:null};
  }
  async assertIntake(c:Queryable,owner:string,contributor?:string):Promise<void>{
    const gate=await this.gate(c,true);
    if(this.#guardedMode&&(!gate.installed||!gate.permissions||!gate.identity||!gate.replay||!gate.retention||!gate.publication))throw new DriverAccountErasureError(503,"DRIVER_ACCOUNT_ERASURE_REPLAY_REQUIRED");
    if(!gate.installed){
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
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");const gate=await this.gate(c,false,{purpose:"preflight",operationHash:this.key(input.operationId),actorHash:input.actorHash});
      if(!gate.installed)throw new DriverAccountErasureError(503,"DRIVER_ACCOUNT_ERASURE_UNAVAILABLE");
      const prior=await c.query("SELECT actor_hash,request_hash,created_at FROM driver_account_erasure_operations WHERE operation_hash=$1",[this.key(input.operationId)]);
      if(prior.rowCount)this.check(prior.rows[0],input);
      const clock=prior.rowCount?new Date(prior.rows[0].created_at).getTime():new Date((await c.query("SELECT clock_timestamp() AS at")).rows[0].at).getTime();
      validateDriverErasureCoverage(input,clock);await c.query("COMMIT");
      const capability={...this.capabilityFrom(gate),checkedAt:prior.rowCount?gate.checkedAt:new Date(clock).toISOString()};
      return {...capability,checks:{...capability.checks,identityBindingReviewed:this.#guardedMode?gate.identity:true,manifestShapeAndCoverageValid:true},operationId:input.operationId,manifestValid:true,
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
  /** Current protected read admission is required for both new work and resume;
   * the feature flag governs new operations, not an accepted durable operation. */
  private guardedReadReady(gate:Gate):boolean{return gate.installed&&gate.permissions&&gate.identity&&gate.replay&&gate.retention&&gate.publication&&!!gate.checkpoint;}
  private async guardedAttempt(input:DriverErasureInput,context:DriverGuardedOperationContext|undefined,kind:"erase"|"ack"):Promise<DriverErasureReceipt>{
    const unavailable=()=>new DriverAccountErasureError(503,"DRIVER_ACCOUNT_ERASURE_UNAVAILABLE");
    const request={purpose:"receipt" as const,operationHash:this.key(input.operationId),actorHash:input.actorHash};
    let publication=false;
    try{
      const gate=await this.gate(this.pool,false,request);
      if(!this.guardedReadReady(gate)||!gate.checkpoint)throw unavailable();
      if(this.options.enabled!==true){
        const prior=await this.pool.query("SELECT * FROM driver_account_erasure_operations WHERE operation_hash=$1 AND actor_hash=$2",[request.operationHash,input.actorHash]);
        if(prior.rowCount!==1||prior.rows[0].actor_hash!==input.actorHash||prior.rows[0].request_hash!==input.requestHash)throw unavailable();
      }
      const body:DriverGuardedAckBody={contractVersion:"sim-driver-guarded-db-v1",operationHash:request.operationHash,
        actorHash:input.actorHash,requestHash:input.requestHash,contributors:input.contributors.map(row=>({...row})),checkpointHash:gate.checkpoint};
      // Read only a data descriptor; do not invoke a context getter before the
      // shared runner's exact-key/proxy validation. HTTP never supplies context.
      if(context&&typeof context==="object"&&!types.isProxy(context)){
        const value=Object.getOwnPropertyDescriptor(context,"publicationContext");
        if(value){if(kind!=="ack"||!("value" in value))throw unavailable();
          if(value.value!==undefined){Object.assign(body,{publicationContext:value.value});publication=true;}}
      }
      if(kind==="ack"&&!publication)throw unavailable();
      // Missing/ambiguous/no-effect outcomes are unavailable on a mutating call,
      // even if an older ledger exists. GET alone may project that older row.
      if((await this.guardedRunner.execute(context,kind,body)).state!=="origin-commit-known")throw unavailable();
      const c=await this.pool.connect();try{
        await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const current=await this.gate(c,false,request);
        if(!this.guardedReadReady(current)||current.checkpoint!==gate.checkpoint)throw unavailable();
        const rows=await c.query("SELECT * FROM driver_account_erasure_operations WHERE operation_hash=$1 AND actor_hash=$2",[request.operationHash,input.actorHash]);
        const row=rows.rows[0];
        if(rows.rowCount!==1||row.actor_hash!==input.actorHash||row.request_hash!==input.requestHash)throw unavailable();
        const receipt=this.receipt(input.operationId,row,current);
        await c.query("COMMIT");
        return receipt;
      }catch{await c.query("ROLLBACK").catch(()=>undefined);throw unavailable();}finally{c.release();}
    }catch{throw unavailable();}
  }
  async erase(input:DriverErasureInput,context?:DriverGuardedOperationContext):Promise<DriverErasureReceipt>{
    if(this.#guardedMode)return this.guardedAttempt(input,context,"erase");
    const c=await this.pool.connect(),key=this.key(input.operationId);try{
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
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");const gate=await this.gate(c,false,{purpose:"status",operationHash:this.key(id),actorHash});
    if(!gate.installed)throw new DriverAccountErasureError(503,"DRIVER_ACCOUNT_ERASURE_UNAVAILABLE");
    const row=await c.query("SELECT * FROM driver_account_erasure_operations WHERE operation_hash=$1 AND actor_hash=$2",[this.key(id),actorHash]);
    await c.query("COMMIT");return row.rowCount?this.receipt(id,row.rows[0],gate):undefined;
  }catch(error){await c.query("ROLLBACK").catch(()=>undefined);throw error;}finally{c.release();}}
  async acknowledge(input:DriverErasureInput,context?:DriverGuardedOperationContext):Promise<DriverErasureReceipt>{
    if(this.#guardedMode)return this.guardedAttempt(input,context,"ack");
    const c=await this.pool.connect(),key=this.key(input.operationId);try{
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
