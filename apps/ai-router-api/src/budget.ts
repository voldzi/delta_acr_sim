import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;

export interface BudgetLimits {
  dailyMicrousd: number;
  monthlyMicrousd: number;
  perUserDailyRequests: number;
}

export interface RouterPolicy {
  externalAllowed: boolean;
  advancedAllowed: boolean;
  limits: BudgetLimits;
}

export class BudgetError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export class BudgetStore {
  readonly pool: pg.Pool;
  constructor(
    url: string,
    private readonly userHashSecret: string,
    private readonly limits: BudgetLimits
  ) {
    this.pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 3000 });
  }

  async init(): Promise<void> {
    // Schema is an explicit deployment migration; runtime needs no DDL grant.
    await this.pool.query("SELECT id FROM ai_router_policy LIMIT 0");
    await this.pool.query("SELECT id FROM ai_router_request LIMIT 0");
    await this.pool.query(
      `INSERT INTO ai_router_policy
      (id, daily_microusd, monthly_microusd, per_user_daily_requests)
      VALUES (1,$1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      [this.limits.dailyMicrousd, this.limits.monthlyMicrousd, this.limits.perUserDailyRequests]
    );
    await this.pool.query(
      `UPDATE ai_router_policy SET daily_microusd=LEAST(daily_microusd,$1),
      monthly_microusd=LEAST(monthly_microusd,$2), per_user_daily_requests=LEAST(per_user_daily_requests,$3)
      WHERE id=1`,
      [this.limits.dailyMicrousd, this.limits.monthlyMicrousd, this.limits.perUserDailyRequests]
    );
  }

  async policy(): Promise<RouterPolicy> {
    const result = await this.pool.query<{
      external_allowed: boolean;
      advanced_allowed: boolean;
      daily_microusd: string;
      monthly_microusd: string;
      per_user_daily_requests: number;
    }>("SELECT * FROM ai_router_policy WHERE id=1");
    const row = result.rows[0];
    if (!row) throw new Error("router_policy_missing");
    return {
      externalAllowed: row.external_allowed,
      advancedAllowed: row.advanced_allowed,
      limits: {
        dailyMicrousd: Number(row.daily_microusd),
        monthlyMicrousd: Number(row.monthly_microusd),
        perUserDailyRequests: row.per_user_daily_requests
      }
    };
  }

  async updatePolicy(policy: RouterPolicy): Promise<RouterPolicy> {
    const limits = policy.limits;
    if (
      ![limits.dailyMicrousd, limits.monthlyMicrousd, limits.perUserDailyRequests].every(Number.isSafeInteger) ||
      limits.dailyMicrousd < 1 ||
      limits.monthlyMicrousd < 1 ||
      limits.perUserDailyRequests < 1 ||
      limits.dailyMicrousd > this.limits.dailyMicrousd ||
      limits.monthlyMicrousd > this.limits.monthlyMicrousd ||
      limits.perUserDailyRequests > this.limits.perUserDailyRequests
    )
      throw new BudgetError("policy_exceeds_environment_cap");
    if (policy.advancedAllowed && !policy.externalAllowed) throw new BudgetError("advanced_requires_external");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(634019, 1)");
      await client.query(
        `UPDATE ai_router_policy SET external_allowed=$1, advanced_allowed=$2,
        daily_microusd=$3, monthly_microusd=$4, per_user_daily_requests=$5, updated_at=now() WHERE id=1`,
        [policy.externalAllowed, policy.advancedAllowed, limits.dailyMicrousd, limits.monthlyMicrousd, limits.perUserDailyRequests]
      );
      await client.query(
        `INSERT INTO ai_router_policy_audit
        (external_allowed, advanced_allowed, daily_microusd, monthly_microusd, per_user_daily_requests)
        VALUES ($1,$2,$3,$4,$5)`,
        [policy.externalAllowed, policy.advancedAllowed, limits.dailyMicrousd, limits.monthlyMicrousd, limits.perUserDailyRequests]
      );
      await client.query("COMMIT");
      return policy;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  hashUser(clientId: string, userId: string): string {
    return createHash("sha256").update(this.userHashSecret).update("\0").update(clientId).update("\0").update(userId).digest("hex");
  }

  async reserve(
    clientId: string,
    userId: string,
    taskType: string,
    model: string,
    routingReason: string,
    difficulty: string,
    tier: "local_fast" | "external_economy" | "external_advanced",
    microusd: number
  ): Promise<string> {
    const client = await this.pool.connect();
    const id = randomUUID();
    const userHash = this.hashUser(clientId, userId);
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(634019, 1)");
      const policyResult = await client.query<{
        daily_microusd: string;
        monthly_microusd: string;
        per_user_daily_requests: number;
        external_allowed: boolean;
        advanced_allowed: boolean;
      }>("SELECT daily_microusd, monthly_microusd, per_user_daily_requests, external_allowed, advanced_allowed FROM ai_router_policy WHERE id=1");
      const limits = policyResult.rows[0];
      if (!limits) throw new Error("router_policy_missing");
      if ((tier !== "local_fast" && !limits.external_allowed) || (tier === "external_advanced" && !limits.advanced_allowed)) {
        throw new BudgetError("model_policy_revoked");
      }
      const totals = await client.query<{ day_total: string; month_total: string; user_count: string }>(
        `
        SELECT
          COALESCE(SUM(COALESCE(charged_microusd, reserved_microusd)) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0) AS day_total,
          COALESCE(SUM(COALESCE(charged_microusd, reserved_microusd)) FILTER (WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0) AS month_total,
          COUNT(*) FILTER (WHERE user_hash = $1 AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS user_count
        FROM ai_router_request
        WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      `,
        [userHash]
      );
      const row = totals.rows[0]!;
      if (Number(row.day_total) + microusd > Number(limits.daily_microusd)) throw new BudgetError("daily_budget_exceeded");
      if (Number(row.month_total) + microusd > Number(limits.monthly_microusd)) throw new BudgetError("monthly_budget_exceeded");
      if (Number(row.user_count) >= limits.per_user_daily_requests) throw new BudgetError("user_daily_limit_exceeded");
      await client.query(
        `INSERT INTO ai_router_request
        (id, client_id, user_hash, task_type, model, routing_reason, difficulty, status, reserved_microusd)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'reserved',$8)`,
        [id, clientId, userHash, taskType, model, routingReason, difficulty, microusd]
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

  async finish(id: string, status: "success" | "failed", inputTokens?: number, outputTokens?: number, chargedMicrousd?: number): Promise<void> {
    await this.pool.query(
      `UPDATE ai_router_request SET status=$2, input_tokens=$3,
      output_tokens=$4, charged_microusd=$5 WHERE id=$1 AND status='reserved'`,
      [id, status, inputTokens ?? null, outputTokens ?? null, status === "success" ? (chargedMicrousd ?? null) : null]
    );
  }

  async usage(): Promise<{ dailyMicrousd: number; monthlyMicrousd: number; dailyRequests: number; limits: BudgetLimits }> {
    const result = await this.pool.query<{ day_total: string; month_total: string; day_count: string }>(`
      SELECT
        COALESCE(SUM(COALESCE(charged_microusd, reserved_microusd)) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0) AS day_total,
        COALESCE(SUM(COALESCE(charged_microusd, reserved_microusd)), 0) AS month_total,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS day_count
      FROM ai_router_request WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    `);
    const row = result.rows[0]!;
    return {
      dailyMicrousd: Number(row.day_total),
      monthlyMicrousd: Number(row.month_total),
      dailyRequests: Number(row.day_count),
      limits: (await this.policy()).limits
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
