import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";

export type BillingSource = "user_openai_key" | "sim_project";
export type BillingStatus = "success" | "failed" | "uncertain";

export interface BillingLimits {
  dailyMicrousd: number;
  monthlyMicrousd: number;
  dailyRequests: number;
}

export interface StoredUserKey { apiKey: string; fingerprint: string; }

export class SeparateBillingError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export interface SeparateBilling {
  keyStatus(userHash: string): Promise<{ configured: boolean; fingerprint?: string; updatedAt?: string }>;
  putKey(userHash: string, apiKey: string): Promise<{ configured: true; fingerprint: string }>;
  removeKey(userHash: string): Promise<void>;
  getKey(userHash: string): Promise<StoredUserKey | null>;
  reserve(source: BillingSource, payerHash: string, actorHash: string, credentialFingerprint: string, providerProjectId: string | null, taskType: string, model: string, microusd: number, limits: BillingLimits): Promise<string>;
  finish(id: string, status: BillingStatus, inputTokens?: number, outputTokens?: number, estimatedMicrousd?: number, errorCode?: string): Promise<void>;
  usage(): Promise<Record<BillingSource, { dailyMicrousd: number; monthlyMicrousd: number; dailyRequests: number; monthlyRequests: number; dailyInputTokens: number; dailyOutputTokens: number }>>;
}

export class PgSeparateBilling implements SeparateBilling {
  private readonly encryptionKey: Buffer;
  constructor(private readonly pool: pg.Pool, encodedKey: string) {
    this.encryptionKey = Buffer.from(encodedKey, "base64");
    if (this.encryptionKey.length !== 32) throw new Error("credential_encryption_key_invalid");
  }

  async checkSchema(): Promise<void> {
    await this.pool.query("SELECT user_hash FROM ai_router_user_key LIMIT 0");
    await this.pool.query("SELECT id FROM ai_router_billing_request LIMIT 0");
  }

  private fingerprint(apiKey: string): string {
    return createHmac("sha256", this.encryptionKey).update("fingerprint\0").update(apiKey).digest("hex").slice(0, 16);
  }

  async keyStatus(userHash: string): Promise<{ configured: boolean; fingerprint?: string; updatedAt?: string }> {
    const result = await this.pool.query<{ fingerprint: string; updated_at: Date }>("SELECT fingerprint, updated_at FROM ai_router_user_key WHERE user_hash=$1", [userHash]);
    const row = result.rows[0];
    return row ? { configured: true, fingerprint: row.fingerprint, updatedAt: row.updated_at.toISOString() } : { configured: false };
  }

  async putKey(userHash: string, apiKey: string): Promise<{ configured: true; fingerprint: string }> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(userHash));
    const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const fingerprint = this.fingerprint(apiKey);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const old = await client.query<{ fingerprint: string }>("SELECT fingerprint FROM ai_router_user_key WHERE user_hash=$1 FOR UPDATE", [userHash]);
      await client.query(
        `INSERT INTO ai_router_user_key (user_hash,ciphertext,nonce,auth_tag,fingerprint)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_hash) DO UPDATE SET
         ciphertext=EXCLUDED.ciphertext, nonce=EXCLUDED.nonce, auth_tag=EXCLUDED.auth_tag,
         fingerprint=EXCLUDED.fingerprint, updated_at=now()`,
        [userHash, encrypted, nonce, tag, fingerprint]
      );
      await client.query("INSERT INTO ai_router_user_key_audit (user_hash,action,fingerprint) VALUES ($1,$2,$3)", [userHash, old.rowCount ? "replaced" : "created", fingerprint]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { configured: true, fingerprint };
  }

  async removeKey(userHash: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const removed = await client.query<{ fingerprint: string }>("DELETE FROM ai_router_user_key WHERE user_hash=$1 RETURNING fingerprint", [userHash]);
      if (removed.rows[0]) await client.query("INSERT INTO ai_router_user_key_audit (user_hash,action,fingerprint) VALUES ($1,'removed',$2)", [userHash, removed.rows[0].fingerprint]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getKey(userHash: string): Promise<StoredUserKey | null> {
    const result = await this.pool.query<{ ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer; fingerprint: string }>("SELECT ciphertext,nonce,auth_tag,fingerprint FROM ai_router_user_key WHERE user_hash=$1", [userHash]);
    const row = result.rows[0];
    if (!row) return null;
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, row.nonce);
    decipher.setAAD(Buffer.from(userHash));
    decipher.setAuthTag(row.auth_tag);
    return { apiKey: Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8"), fingerprint: row.fingerprint };
  }

  async reserve(source: BillingSource, payerHash: string, actorHash: string, credentialFingerprint: string, providerProjectId: string | null, taskType: string, model: string, microusd: number, limits: BillingLimits): Promise<string> {
    if (!Number.isSafeInteger(microusd) || microusd < 0) throw new Error("invalid_reservation");
    const client = await this.pool.connect();
    const id = randomUUID();
    try {
      await client.query("BEGIN");
      // One transaction lock makes parallel reservations obey the same hard cap.
      await client.query("SELECT pg_advisory_xact_lock(634019, 2)");
      const result = await client.query<{ day_total: string; month_total: string; day_count: string }>(
        `SELECT
          COALESCE(SUM(COALESCE(estimated_microusd,reserved_microusd)) FILTER (WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) AS day_total,
          COALESCE(SUM(COALESCE(estimated_microusd,reserved_microusd)),0) AS month_total,
          COUNT(*) FILTER (WHERE actor_hash=$3 AND created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS day_count
         FROM ai_router_billing_request
         WHERE billing_source=$1 AND payer_hash=$2 AND created_at >= date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        [source, payerHash, actorHash]
      );
      const row = result.rows[0]!;
      if (Number(row.day_total) + microusd > limits.dailyMicrousd) throw new SeparateBillingError("daily_budget_exceeded");
      if (Number(row.month_total) + microusd > limits.monthlyMicrousd) throw new SeparateBillingError("monthly_budget_exceeded");
      if (Number(row.day_count) >= limits.dailyRequests) throw new SeparateBillingError("user_daily_limit_exceeded");
      await client.query(
        `INSERT INTO ai_router_billing_request
         (id,billing_source,payer_hash,actor_hash,credential_fingerprint,provider_project_id,task_type,model,status,reserved_microusd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9)`,
        [id, source, payerHash, actorHash, credentialFingerprint, providerProjectId, taskType, model, microusd]
      );
      await client.query("COMMIT");
      return id;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async finish(id: string, status: BillingStatus, inputTokens?: number, outputTokens?: number, estimatedMicrousd?: number, errorCode?: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE ai_router_billing_request SET status=$2,input_tokens=$3,output_tokens=$4,
       estimated_microusd=$5,error_code=$6,completed_at=now() WHERE id=$1 AND status='reserved'`,
      [id, status, inputTokens ?? null, outputTokens ?? null, status === "success" ? estimatedMicrousd ?? null : null, errorCode ?? null]
    );
    if (result.rowCount !== 1) throw new Error("billing_audit_update_missing");
  }

  async usage(): Promise<Record<BillingSource, { dailyMicrousd: number; monthlyMicrousd: number; dailyRequests: number; monthlyRequests: number; dailyInputTokens: number; dailyOutputTokens: number }>> {
    const result = await this.pool.query<{ billing_source: BillingSource; day_total: string; month_total: string; day_count: string; month_count: string; day_input: string; day_output: string }>(
      `SELECT billing_source,
        COALESCE(SUM(COALESCE(estimated_microusd,reserved_microusd)) FILTER (WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) AS day_total,
        COALESCE(SUM(COALESCE(estimated_microusd,reserved_microusd)),0) AS month_total,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS day_count,
        COUNT(*) AS month_count,
        COALESCE(SUM(input_tokens) FILTER (WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) AS day_input,
        COALESCE(SUM(output_tokens) FILTER (WHERE created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),0) AS day_output
       FROM ai_router_billing_request WHERE created_at >= date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       GROUP BY billing_source`
    );
    const empty = () => ({ dailyMicrousd: 0, monthlyMicrousd: 0, dailyRequests: 0, monthlyRequests: 0, dailyInputTokens: 0, dailyOutputTokens: 0 });
    const usage = { user_openai_key: empty(), sim_project: empty() };
    for (const row of result.rows) usage[row.billing_source] = {
      dailyMicrousd: Number(row.day_total), monthlyMicrousd: Number(row.month_total),
      dailyRequests: Number(row.day_count), monthlyRequests: Number(row.month_count),
      dailyInputTokens: Number(row.day_input), dailyOutputTokens: Number(row.day_output)
    };
    return usage;
  }
}
