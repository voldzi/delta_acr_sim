import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import type pg from "pg";
import type { Config } from "./config.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export type CostErasurePolicy = "pending_requires_review" | "aggregate-costs-current-month-v1";
export interface ErasureActor { iss: string; sub: string; aud: "sim-account-erasure"; iat: number; exp: number; operationId: string; routerUserId: string; }
export class AccountErasureError extends Error {
  constructor(public readonly code: "account_erasure_pending" | "account_erased" | "erasure_operation_conflict" | "erasure_operation_not_found" | "erasure_review_required") { super(code); }
}
export interface AccountErasureGate { assertActive(target: string, transaction?: Pick<pg.PoolClient, "query">): Promise<void>; }
export interface RouterErasureReceipt {
  contractVersion: "sim-account-erasure-v1"; operationId: string; status: "pending" | "online_complete";
  scope: "cop_router_primary_database";
  pendingReasons: Array<"provider_requests_pending" | "cost_retention_review_required" | "backup_replay_not_ready" | "erasure_processing_pending">;
  pendingRequestCount: number; onlineScopeComplete: boolean; wholeAccountComplete: false;
  backupsComplete: false; providerRetentionComplete: false; retainedMinimumReplayFence: true; aliasScope: "sim_izs_preserved_out_of_scope";
}
export interface ErasureIdentity { ownerHash: string; targetHash: string; }
export interface RouterErasureCapability {
  contractVersion: "sim-account-erasure-v1"; owner: "ai_router"; scope: "cop_router_primary_database";
  enabled: boolean; ready: boolean; checkedAt: string;
  checks: { schemaReady: boolean; permissionsReady: boolean; identityReviewed: boolean; restoreCheckpointCurrent: boolean; retentionReviewed: boolean };
  blockers: Array<"erasure_disabled" | "schema_not_ready" | "permissions_not_ready" | "identity_review_required" | "restore_checkpoint_not_current" | "retention_review_required" | "provider_requests_pending" | "identity_binding_review_required">;
  costPolicy: CostErasurePolicy; mutates: false; providerCalls: false; wholeAccountComplete: false;
}
export interface RouterErasurePreflight extends Omit<RouterErasureCapability, "checks"> {
  operationId: string; identityBinding: "cop_attested_existing_router_alias";
  checks: RouterErasureCapability["checks"] & { identityBindingReviewed: boolean; providerRequestsSettled: boolean };
}
export interface AccountErasureStore extends AccountErasureGate {
  capability(enabled: boolean): Promise<RouterErasureCapability>;
  preflight(identity: ErasureIdentity, operationId: string, enabled: boolean): Promise<RouterErasurePreflight | null>;
  request(identity: ErasureIdentity, operationId: string): Promise<RouterErasureReceipt>;
  status(identity: ErasureIdentity, operationId: string): Promise<RouterErasureReceipt | null>;
  processPending(): Promise<void>;
}

/** Exact canonical bytes reject duplicate keys, alternative field order and padding. */
export function verifyErasureActor(req: Request, secret: string, issuer: string, operationId?: string, now = Math.floor(Date.now() / 1000)): ErasureActor | null {
  if (secret.length < 32 || !issuer) return null;
  const encoded = req.header("x-cop-actor") ?? ""; const signature = req.header("x-cop-actor-signature") ?? "";
  if (!/^[A-Za-z0-9_-]{20,2048}$/u.test(encoded) || !/^[a-f0-9]{64}$/u.test(signature)) return null;
  const expected = createHmac("sha256", secret).update(encoded).digest(); const supplied = Buffer.from(signature, "hex");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  const bytes = Buffer.from(encoded, "base64url"); if (bytes.toString("base64url") !== encoded) return null;
  const decoded=bytes.toString("utf8");if(!Buffer.from(decoded,"utf8").equals(bytes))return null;
  let parsed: unknown; try { parsed = JSON.parse(decoded); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const v = parsed as Record<string, unknown>; const keys = ["iss", "sub", "aud", "iat", "exp", "operationId", "routerUserId"];
  if (Object.keys(v).length !== 7 || !keys.every((key) => Object.hasOwn(v, key)) || !Buffer.from(JSON.stringify(v),"utf8").equals(bytes) || Object.keys(v).join("\0") !== keys.join("\0")) return null;
  if (v.iss !== issuer || typeof v.sub !== "string" || [...v.sub].length < 1 || [...v.sub].length > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(v.sub) || v.aud !== "sim-account-erasure" ||
      typeof v.operationId !== "string" || !UUID.test(v.operationId) || (operationId !== undefined && operationId !== v.operationId) ||
      typeof v.routerUserId !== "string" || !/^cop_[A-Za-z0-9_-]{43}$/u.test(v.routerUserId) || !Number.isSafeInteger(v.iat) || !Number.isSafeInteger(v.exp)) return null;
  const iat = v.iat as number; const exp = v.exp as number;
  return iat <= now && iat >= now - 60 && exp > now && exp > iat && exp - iat <= 60 ? v as unknown as ErasureActor : null;
}
export function erasureIdentity(actor: ErasureActor, secret: string, hashUser: (client: string, user: string) => string): ErasureIdentity {
  return { ownerHash: createHmac("sha256", secret).update("sim-account-erasure-owner-v1\0").update(actor.iss).update("\0").update(actor.sub).digest("hex"),
    targetHash: hashUser("cop", actor.routerUserId) };
}

export type Checkpoint = { identity_reviewed: boolean; replay_ready: boolean; cost_policy: CostErasurePolicy; checkpoint_id: string; checkpoint_generation: string; operation_digest: string; schema_digest: string };
export type OwnerCheckpointVerifier = (checkpoint: Checkpoint) => Promise<boolean>;
export class PgAccountErasure implements AccountErasureStore {
  constructor(private readonly pool: pg.Pool, private readonly policy: CostErasurePolicy, private readonly replayReady: boolean,
    private readonly verifyCheckpoint: OwnerCheckpointVerifier = async () => false) {}
  async checkSchema(): Promise<void> {
    await this.pool.query("SELECT operation_id FROM ai_router_account_erasure LIMIT 0");
    await this.pool.query("SELECT record_count FROM ai_router_budget_usage LIMIT 0");
    await this.pool.query("SELECT record_count FROM ai_router_billing_usage LIMIT 0");
    await this.checkpoint();
  }
  private async checkpoint(client: Pick<pg.PoolClient, "query"> = this.pool): Promise<Checkpoint> {
    const result = await client.query<Checkpoint>(`SELECT identity_reviewed,replay_ready,cost_policy,checkpoint_id,checkpoint_generation::text,
      (SELECT encode(sha256(convert_to(COALESCE(string_agg(operation_id::text || ':' || owner_hash || ':' || target_hash || ':' || body_digest || ':' || status,E'\\n' ORDER BY operation_id),''),'UTF8')),'hex') FROM ai_router_account_erasure) AS operation_digest
      ,(SELECT encode(sha256(convert_to(COALESCE(string_agg(definition,E'\\n' ORDER BY definition),''),'UTF8')),'hex') FROM (
        SELECT pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('ai_router_cop_erasure_fence','ai_router_erasure_delete_scope','ai_router_erasure_operation_immutable')
        UNION ALL SELECT pg_get_triggerdef(oid) || ':' || tgenabled::text FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'ai_router_%erasure%'
        UNION ALL SELECT tablename || ':' || policyname || ':' || cmd || ':' || COALESCE(qual,'') || ':' || COALESCE(with_check,'') FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'router_%'
      ) definitions) AS schema_digest
      FROM ai_router_erasure_checkpoint WHERE id=1`);
    if (!result.rows[0]) throw new Error("erasure_checkpoint_missing");
    return result.rows[0];
  }
  private async permissionsReady(client: Pick<pg.PoolClient,"query">): Promise<boolean> {
    const permissions = await client.query<{ ok: boolean }>(`SELECT bool_and(has_table_privilege(current_user,t,p)) AND
      NOT has_table_privilege(current_user,'ai_router_account_erasure','DELETE') AND
      NOT has_table_privilege(current_user,'ai_router_erasure_checkpoint','UPDATE,DELETE') AND
      NOT has_schema_privilege(current_user,'public','CREATE') AND NOT has_database_privilege(current_user,current_database(),'CREATE') AND
      NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) AND
      NOT EXISTS(SELECT 1 FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('ai_router_account_erasure','ai_router_erasure_checkpoint','ai_router_request','ai_router_billing_request','ai_router_user_key_audit') AND pg_has_role(current_user,relowner,'MEMBER')) AND
      row_security_active('ai_router_request') AND row_security_active('ai_router_billing_request') AND row_security_active('ai_router_user_key_audit') AS ok
      FROM (VALUES ('ai_router_account_erasure','SELECT'),('ai_router_account_erasure','INSERT'),('ai_router_account_erasure','UPDATE'),
      ('ai_router_erased_cost_daily','SELECT'),('ai_router_erased_cost_daily','INSERT'),('ai_router_erased_cost_daily','UPDATE'),('ai_router_erased_cost_daily','DELETE'),
      ('ai_router_request','SELECT'),('ai_router_request','DELETE'),('ai_router_billing_request','SELECT'),('ai_router_billing_request','DELETE'),
      ('ai_router_user_key_audit','SELECT'),('ai_router_user_key_audit','DELETE')) rights(t,p)`);
    return permissions.rows[0]?.ok === true;
  }
  private async schemaReady(client: Pick<pg.PoolClient,"query">): Promise<boolean> {
    const schema = await client.query<{ok:boolean}>(`SELECT
      (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O' AND (
        (tgname='ai_router_key_erasure_fence' AND tgrelid='ai_router_user_key'::regclass AND tgfoid='ai_router_cop_erasure_fence()'::regprocedure) OR
        (tgname='ai_router_request_erasure_fence' AND tgrelid='ai_router_request'::regclass AND tgfoid='ai_router_cop_erasure_fence()'::regprocedure) OR
        (tgname='ai_router_billing_erasure_fence' AND tgrelid='ai_router_billing_request'::regclass AND tgfoid='ai_router_cop_erasure_fence()'::regprocedure) OR
        (tgname='ai_router_erasure_operation_guard' AND tgrelid='ai_router_account_erasure'::regclass AND tgfoid='ai_router_erasure_operation_immutable()'::regprocedure)))=4 AND
      (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('ai_router_cop_erasure_fence','ai_router_erasure_delete_scope','ai_router_erasure_operation_immutable') AND NOT prosecdef)=3 AND
      (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND cmd='DELETE' AND (
        (policyname='router_request_erasure_delete' AND tablename='ai_router_request' AND qual LIKE '%client_id%' AND qual LIKE '%cop%' AND qual LIKE '%ai_router_erasure_delete_scope%') OR
        (policyname='router_billing_erasure_delete' AND tablename='ai_router_billing_request' AND qual LIKE '%user_openai_key%' AND qual LIKE '%cop_chat%' AND qual LIKE '%actor_hash%' AND qual LIKE '%payer_hash%' AND qual LIKE '%ai_router_erasure_delete_scope%') OR
        (policyname='router_key_audit_erasure_delete' AND tablename='ai_router_user_key_audit' AND qual LIKE '%ai_router_erasure_delete_scope%') OR
        (policyname='router_rollup_expiry_delete' AND tablename='ai_router_erased_cost_daily' AND qual LIKE '%expires_at%' AND qual LIKE '%uncertain%')))=4 AS ok`);
    return schema.rows[0]?.ok === true;
  }
  async capability(enabled: boolean): Promise<RouterErasureCapability> {
    const cp = await this.checkpoint();
    const checks: RouterErasureCapability["checks"] = { schemaReady: await this.schemaReady(this.pool), permissionsReady: await this.permissionsReady(this.pool),
      identityReviewed: cp.identity_reviewed, restoreCheckpointCurrent: this.replayReady && cp.replay_ready && await this.verifyCheckpoint(cp),
      retentionReviewed: cp.cost_policy === "aggregate-costs-current-month-v1" && this.policy === cp.cost_policy };
    const blockers: RouterErasureCapability["blockers"] = [];
    if (!enabled) blockers.push("erasure_disabled");
    if (!checks.schemaReady) blockers.push("schema_not_ready");
    if (!checks.permissionsReady) blockers.push("permissions_not_ready");
    if (!checks.identityReviewed) blockers.push("identity_review_required");
    if (!checks.restoreCheckpointCurrent) blockers.push("restore_checkpoint_not_current");
    if (!checks.retentionReviewed) blockers.push("retention_review_required");
    return { contractVersion:"sim-account-erasure-v1",owner:"ai_router",scope:"cop_router_primary_database",enabled,ready:blockers.length===0,
      checkedAt:new Date().toISOString(),checks,blockers,costPolicy:checks.retentionReviewed?this.policy:"pending_requires_review",mutates:false,providerCalls:false,wholeAccountComplete:false };
  }
  async preflight(identity: ErasureIdentity, operationId: string, enabled: boolean): Promise<RouterErasurePreflight | null> {
    const base = await this.capability(enabled);
    const digest = createHash("sha256").update(JSON.stringify({contractVersion:"sim-account-erasure-v1",operationId})).digest("hex");
    const existing = await this.pool.query<{ owner_hash:string; target_hash:string; body_digest:string }>("SELECT owner_hash,target_hash,body_digest FROM ai_router_account_erasure WHERE operation_id=$1",[operationId]);
    const row = existing.rows[0];
    if (row && row.owner_hash!==identity.ownerHash) return null;
    if (row && row.target_hash!==identity.targetHash) throw new AccountErasureError("erasure_operation_conflict");
    if (row && row.body_digest!==digest) throw new AccountErasureError("erasure_operation_conflict");
    const pending = await this.pendingCount(identity.targetHash,this.pool);
    const checks = {...base.checks,identityBindingReviewed:base.checks.identityReviewed,providerRequestsSettled:pending===0};
    const blockers = [...base.blockers];
    if (!checks.identityBindingReviewed) blockers.push("identity_binding_review_required");
    if (!checks.providerRequestsSettled) blockers.push("provider_requests_pending");
    return {...base,operationId,identityBinding:"cop_attested_existing_router_alias",checks,blockers,ready:blockers.length===0};
  }
  private async pendingCount(target: string, client: Pick<pg.PoolClient,"query">): Promise<number> {
    const result = await client.query<{ count:string }>(`SELECT
      (SELECT count(*) FROM ai_router_request WHERE client_id='cop' AND user_hash=$1 AND status IN ('reserved','uncertain')) +
      (SELECT count(*) FROM ai_router_billing_request WHERE billing_source='user_openai_key' AND task_type='cop_chat' AND (actor_hash=$1 OR payer_hash=$1) AND status IN ('reserved','uncertain')) AS count`,[target]);
    const count = Number(result.rows[0]?.count);
    if (!Number.isSafeInteger(count) || count<0) throw new Error("erasure_pending_count_invalid");
    return count;
  }
  async assertActive(target: string, transaction?: Pick<pg.PoolClient, "query">): Promise<void> {
    if (transaction) await transaction.query("SELECT pg_advisory_xact_lock(634020,hashtext($1))", [target]);
    const result = await (transaction ?? this.pool).query<{ status: string }>("SELECT status FROM ai_router_account_erasure WHERE target_hash=$1", [target]);
    if (result.rows[0]) throw new AccountErasureError(result.rows[0].status === "online_complete" ? "account_erased" : "account_erasure_pending");
    const cp = await this.checkpoint(transaction);
    if (!cp.identity_reviewed || !cp.replay_ready || !this.replayReady || !await this.schemaReady(transaction??this.pool) || !await this.verifyCheckpoint(cp)) throw new Error("erasure_checkpoint_not_current");
  }
  async request(identity: ErasureIdentity, operationId: string): Promise<RouterErasureReceipt> {
    const client = await this.pool.connect();
    const digest = createHash("sha256").update(JSON.stringify({ contractVersion: "sim-account-erasure-v1", operationId })).digest("hex");
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(634020,hashtext($1))", [identity.targetHash]);
      const prior = await client.query<{ owner_hash: string; target_hash: string; operation_id: string; body_digest: string }>(
        "SELECT owner_hash,target_hash,operation_id,body_digest FROM ai_router_account_erasure WHERE operation_id=$1 OR target_hash=$2 FOR UPDATE", [operationId, identity.targetHash]);
      if (prior.rows.some((r)=>r.owner_hash!==identity.ownerHash)) throw new AccountErasureError("erasure_operation_not_found");
      if (prior.rows.some((r) => r.target_hash !== identity.targetHash || r.operation_id !== operationId || r.body_digest !== digest)) throw new AccountErasureError("erasure_operation_conflict");
      const cp = await this.checkpoint(client);
      if (!prior.rows.length && (!cp.identity_reviewed || !cp.replay_ready || !this.replayReady || cp.cost_policy!==this.policy || this.policy!=="aggregate-costs-current-month-v1" || !await this.schemaReady(client) || !await this.permissionsReady(client) || !await this.verifyCheckpoint(cp))) throw new AccountErasureError("erasure_review_required");
      await client.query("INSERT INTO ai_router_account_erasure(operation_id,owner_hash,target_hash,body_digest) VALUES($1,$2,$3,$4) ON CONFLICT(operation_id) DO NOTHING", [operationId, identity.ownerHash, identity.targetHash, digest]);
      await client.query("DELETE FROM ai_router_user_key WHERE user_hash=$1", [identity.targetHash]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        const owner=await client.query<{owner_hash:string}>("SELECT owner_hash FROM ai_router_account_erasure WHERE operation_id=$1 OR target_hash=$2",[operationId,identity.targetHash]);
        throw new AccountErasureError(owner.rows.length && owner.rows.every(r=>r.owner_hash===identity.ownerHash)?"erasure_operation_conflict":"erasure_operation_not_found");
      }
      throw error;
    }
    finally { client.release(); }
    await this.advance(identity, operationId);
    const result = await this.status(identity, operationId); if (!result) throw new Error("erasure_status_missing"); return result;
  }
  private async advance(identity: ErasureIdentity, operationId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(634020,hashtext($1))", [identity.targetHash]);
      const cp = await this.checkpoint(client);
      if (!cp.identity_reviewed || !this.replayReady || !cp.replay_ready || cp.cost_policy !== "aggregate-costs-current-month-v1" || this.policy !== cp.cost_policy || !await this.schemaReady(client) || !await this.permissionsReady(client) || !await this.verifyCheckpoint(cp)) { await client.query("COMMIT"); return; }
      const op = await client.query<{ status: string }>("SELECT status FROM ai_router_account_erasure WHERE operation_id=$1 AND owner_hash=$2 AND target_hash=$3 FOR UPDATE", [operationId, identity.ownerHash, identity.targetHash]);
      if (!op.rows[0]) throw new Error("erasure_status_missing");
      if (op.rows[0].status === "online_complete") { await client.query("COMMIT"); return; }
      await client.query("SELECT pg_advisory_xact_lock(634019,1)"); await client.query("SELECT pg_advisory_xact_lock(634019,2)");
      const count = await client.query<{ count: string }>(
        `SELECT (SELECT count(*) FROM ai_router_request WHERE client_id='cop' AND user_hash=$1 AND status IN ('reserved','uncertain')) +
        (SELECT count(*) FROM ai_router_billing_request WHERE billing_source='user_openai_key' AND task_type='cop_chat' AND (actor_hash=$1 OR payer_hash=$1) AND status IN ('reserved','uncertain')) AS count`, [identity.targetHash]);
      if (Number(count.rows[0]!.count) > 0) { await client.query("COMMIT"); return; }
      const bad = await client.query<{ count: string }>("SELECT count(*) AS count FROM ai_router_billing_request WHERE billing_source='user_openai_key' AND (actor_hash=$1 OR payer_hash=$1) AND (actor_hash<>payer_hash OR task_type<>'cop_chat')", [identity.targetHash]);
      if (Number(bad.rows[0]!.count)) throw new Error("erasure_billing_ownership_unresolved");
      await client.query("SELECT set_config('sim.erasure_target',$1,true),set_config('sim.erasure_operation',$2,true),set_config('sim.erasure_owner',$3,true)", [identity.targetHash, operationId, identity.ownerHash]);
      await client.query(`INSERT INTO ai_router_erased_cost_daily(billing_lane,usage_day,cost_microusd,request_count,input_tokens,output_tokens,expires_at)
        SELECT lane,day,sum(cost),count(*),sum(input),sum(output),(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC' FROM (
        SELECT 'legacy' AS lane,(created_at AT TIME ZONE 'UTC')::date AS day,COALESCE(charged_microusd,reserved_microusd) AS cost,COALESCE(input_tokens,0) AS input,COALESCE(output_tokens,0) AS output
        FROM ai_router_request WHERE client_id='cop' AND user_hash=$1 AND created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        UNION ALL SELECT 'user_openai_key',(created_at AT TIME ZONE 'UTC')::date,COALESCE(estimated_microusd,reserved_microusd),COALESCE(input_tokens,0),COALESCE(output_tokens,0)
        FROM ai_router_billing_request WHERE billing_source='user_openai_key' AND task_type='cop_chat' AND actor_hash=$1 AND payer_hash=$1 AND created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
        ) entries GROUP BY lane,day ON CONFLICT(billing_lane,usage_day) DO UPDATE SET
        cost_microusd=ai_router_erased_cost_daily.cost_microusd+EXCLUDED.cost_microusd,request_count=ai_router_erased_cost_daily.request_count+EXCLUDED.request_count,
        input_tokens=ai_router_erased_cost_daily.input_tokens+EXCLUDED.input_tokens,output_tokens=ai_router_erased_cost_daily.output_tokens+EXCLUDED.output_tokens`, [identity.targetHash]);
      await client.query("DELETE FROM ai_router_request WHERE client_id='cop' AND user_hash=$1", [identity.targetHash]);
      await client.query("DELETE FROM ai_router_billing_request WHERE billing_source='user_openai_key' AND task_type='cop_chat' AND actor_hash=$1 AND payer_hash=$1", [identity.targetHash]);
      await client.query("DELETE FROM ai_router_user_key_audit WHERE user_hash=$1", [identity.targetHash]);
      await client.query("DELETE FROM ai_router_user_key WHERE user_hash=$1", [identity.targetHash]);
      await client.query("UPDATE ai_router_account_erasure SET status='online_complete',completed_at=now(),reviewed_cost_policy='aggregate-costs-current-month-v1' WHERE operation_id=$1 AND owner_hash=$2 AND target_hash=$3", [operationId, identity.ownerHash, identity.targetHash]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async status(identity: ErasureIdentity, operationId: string): Promise<RouterErasureReceipt | null> {
    const result = await this.pool.query<{ status: "pending" | "online_complete"; pending: string; linked: string }>(`SELECT status,
      (SELECT count(*) FROM ai_router_request WHERE client_id='cop' AND user_hash=$1 AND status IN ('reserved','uncertain')) +
      (SELECT count(*) FROM ai_router_billing_request WHERE billing_source='user_openai_key' AND (actor_hash=$1 OR payer_hash=$1) AND status IN ('reserved','uncertain')) AS pending,
      (SELECT count(*) FROM ai_router_request WHERE client_id='cop' AND user_hash=$1) +
      (SELECT count(*) FROM ai_router_billing_request WHERE billing_source='user_openai_key' AND (actor_hash=$1 OR payer_hash=$1)) +
      (SELECT count(*) FROM ai_router_user_key WHERE user_hash=$1) +(SELECT count(*) FROM ai_router_user_key_audit WHERE user_hash=$1) AS linked
      FROM ai_router_account_erasure WHERE target_hash=$1 AND operation_id=$2 AND owner_hash=$3`, [identity.targetHash, operationId, identity.ownerHash]);
    const row = result.rows[0]; if (!row) return null;
    const cp = await this.checkpoint(); const pendingRequestCount = Number(row.pending); const complete = row.status === "online_complete";
    const proofCurrent = cp.identity_reviewed && cp.replay_ready && this.replayReady && await this.verifyCheckpoint(cp);
    if (!Number.isSafeInteger(pendingRequestCount) || pendingRequestCount < 0 || (complete && (Number(row.linked)!==0 || !proofCurrent || cp.cost_policy!==this.policy || this.policy!=="aggregate-costs-current-month-v1"))) throw new Error("erasure_zero_verification_failed");
    const pendingReasons: RouterErasureReceipt["pendingReasons"] = [];
    if (!complete) {
      if (pendingRequestCount) pendingReasons.push("provider_requests_pending");
      if (this.policy!=="aggregate-costs-current-month-v1" || cp.cost_policy!==this.policy) pendingReasons.push("cost_retention_review_required");
      if (!proofCurrent) pendingReasons.push("backup_replay_not_ready");
      if (!pendingReasons.length) pendingReasons.push("erasure_processing_pending");
    }
    return { contractVersion:"sim-account-erasure-v1",operationId,status:row.status,scope:"cop_router_primary_database",pendingReasons,pendingRequestCount,
      onlineScopeComplete:complete,wholeAccountComplete:false,backupsComplete:false,providerRetentionComplete:false,retainedMinimumReplayFence:true,aliasScope:"sim_izs_preserved_out_of_scope" };
  }
  async processPending(): Promise<void> {
    const rows = await this.pool.query<{ operation_id:string; owner_hash:string; target_hash:string }>("SELECT operation_id,owner_hash,target_hash FROM ai_router_account_erasure WHERE status='pending' ORDER BY requested_at LIMIT 100");
    for (const row of rows.rows) await this.advance({ownerHash:row.owner_hash,targetHash:row.target_hash},row.operation_id);
    // RLS permits only expired, fully settled lane/month evidence. No tombstone TTL.
    const cp = await this.checkpoint();
    if (cp.identity_reviewed && cp.replay_ready && this.replayReady && cp.cost_policy===this.policy && this.policy==="aggregate-costs-current-month-v1" && await this.verifyCheckpoint(cp)) {
      await this.pool.query("DELETE FROM ai_router_erased_cost_daily WHERE expires_at<=now()");
    }
  }
}

export function registerErasureRoutes(app:Express,config:Config,hashUser:(client:string,user:string)=>string,store?:AccountErasureStore):void {
  const path="/api/v1/ai-router/cop/users/me/erasure-operations";
  // One service-wide bucket: no raw actor identifiers and no distributed-limit claim.
  let windowStart=Date.now(),serviceRequests=0,activeStarts=0;
  const fail=(res:Response,status:number,error:string)=>res.status(status).json({error,correlationId:res.locals.erasureCorrelationId??randomUUID()});
  const service=(req:Request,res:Response)=> {
    res.setHeader("Cache-Control","private, no-store");
    if(res.locals.caller!=="cop" || req.header("origin")){fail(res,403,"task_not_allowed");return false;}
    const now=Date.now();if(now-windowStart>=60_000){windowStart=now;serviceRequests=0;}
    if(serviceRequests>=60){res.setHeader("Retry-After",String(Math.max(1,Math.ceil((60_000-(now-windowStart))/1000))));fail(res,429,"erasure_rate_limited");return false;}
    serviceRequests++;
    return true;
  };
  app.get(`${path}/capability`,async(req,res)=> {
    if(!service(req,res))return;
    if(Object.keys(req.query).length || req.body!==undefined || Number(req.header("content-length")??0)>0 || req.header("transfer-encoding")!==undefined || req.header("x-cop-actor")!==undefined || req.header("x-cop-actor-signature")!==undefined){fail(res,400,"invalid_erasure_request");return;}
    if(!store){fail(res,503,"account_erasure_store_unavailable");return;}
    try{res.json(await store.capability(config.accountErasureEnabled===true));}catch{fail(res,503,"account_erasure_store_unavailable");}
  });
  const handle=async(req:Request,res:Response,kind:"start"|"read"|"preflight")=> {
    if(!service(req,res))return;
    const body=req.body as Record<string,unknown>|undefined;
    const operationId=kind==="read"?req.params.operationId:body?.operationId;
    if(Object.keys(req.query).length || (kind==="read" && (req.body!==undefined || Number(req.header("content-length")??0)>0 || req.header("transfer-encoding")!==undefined)) || typeof operationId!=="string" || !UUID.test(operationId) || (kind!=="read" &&
      (!body || Array.isArray(body) || Object.keys(body).length!==2 || body.contractVersion!=="sim-account-erasure-v1" || !Object.hasOwn(body,"operationId")))){fail(res,400,"invalid_erasure_request");return;}
    const actor=verifyErasureActor(req,config.copActorSecret??"",config.accountErasureIssuer??"",operationId);
    if(!actor){fail(res,401,"erasure_actor_assertion_invalid");return;}
    if(!store){fail(res,503,"account_erasure_store_unavailable");return;}
    const identity=erasureIdentity(actor,config.userHashSecret,hashUser);
    try {
      if(kind==="preflight"){
        const probe=await store.preflight(identity,operationId,config.accountErasureEnabled===true);
        if(!probe){fail(res,404,"erasure_operation_not_found");return;}
        res.json(probe);return;
      }
      if(kind==="start" && !config.accountErasureEnabled && !await store.status(identity,operationId)){fail(res,503,"account_erasure_not_enabled");return;}
      let receipt:RouterErasureReceipt|null;
      if(kind==="start"){
        if(activeStarts>=2){res.setHeader("Retry-After","1");fail(res,429,"erasure_start_busy");return;}
        activeStarts++;
        try{receipt=await store.request(identity,operationId);}finally{activeStarts--;}
      }else{receipt=await store.status(identity,operationId);}
      if(!receipt){fail(res,404,"erasure_operation_not_found");return;}
      res.status(receipt.onlineScopeComplete?200:202).json(receipt);
    }catch(error){
      if(error instanceof AccountErasureError){fail(res,error.code==="erasure_operation_conflict"?409:error.code==="erasure_operation_not_found"?404:503,error.code);return;}
      fail(res,503,"account_erasure_store_unavailable");
    }
  };
  app.post(`${path}/preflight`,(req,res)=>{void handle(req,res,"preflight");});
  app.post(path,(req,res)=>{void handle(req,res,"start");});
  app.get(`${path}/:operationId`,(req,res)=>{void handle(req,res,"read");});
}
