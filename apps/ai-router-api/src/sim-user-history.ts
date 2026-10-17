import type { Express, Request, Response } from "express";
import type { BudgetStore } from "./budget.js";
import type { Config } from "./config.js";
import { UserLedger } from "../../../packages/sim-user-data/ledger.mjs";
import { loadSimUserAuthority } from "../../../packages/sim-user-data/bootstrap.mjs";
import pg from "pg";
import { verifySimOwner, simOwnerAlias, SIM_USER_DATA_CONTRACT, SIM_USER_SCOPE } from "../../../packages/sim-user-data/claims.mjs";
import { timingSafeEqual } from "node:crypto";
export interface SimHistorySettings {
  environmentId: string;
  resetEpoch: string;
  tokensNotBefore: number;
  secret: string;
  mode: "isolated-sim-user-data-v1" | "production-sim-user-data-v1";
}
export function simHistorySettings(env = process.env): SimHistorySettings | undefined {
  if (env.SIM_USER_HISTORY_ENABLED === undefined || env.SIM_USER_HISTORY_ENABLED === "false") return;
  if (env.SIM_USER_HISTORY_ENABLED !== "true" || !["isolated-sim-user-data-v1", "production-sim-user-data-v1"].includes(env.SIM_USER_HISTORY_MODE ?? ""))
    throw Error("SIM_HISTORY_MODE_NOT_ACCEPTED");
  const s = {
    environmentId: env.SIM_USER_DATA_ENVIRONMENT_ID!,
    resetEpoch: env.SIM_USER_DATA_RESET_EPOCH!,
    tokensNotBefore: Number(env.SIM_USER_DATA_TOKENS_NOT_BEFORE),
    secret: env.SIM_USER_DATA_ROUTER_ACTOR_SECRET!,
    mode: env.SIM_USER_HISTORY_MODE as SimHistorySettings["mode"]
  };
  if (!s.secret || s.secret.length < 32 || !s.environmentId || !s.resetEpoch || !Number.isSafeInteger(s.tokensNotBefore) || s.tokensNotBefore <= 0)
    throw Error("SIM_HISTORY_CONFIGURATION_REQUIRED");
  return s;
}
const secure = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export async function loadSimHistory(config: Config, store: BudgetStore, s: SimHistorySettings) {
  if (
    !["isolated-sim-user-data-v1", "production-sim-user-data-v1"].includes(s.mode) ||
    (process.env.NODE_ENV === "production" && s.mode !== "production-sim-user-data-v1")
  )
    throw Error("SIM_HISTORY_ISOLATION_MODE_REQUIRED");
  const continuity = await loadSimUserAuthority({
    Pool: pg.Pool,
    targetPool: store.pool,
    targetDatabaseUrl: config.databaseUrl,
    component: "sim_user_history",
    settings: s,
    identity: { hashSecret: config.userHashSecret, actorSecret: s.secret, issuer: config.accountErasureIssuer }
  });
  const ledger = new UserLedger(store.pool, s, "sim_user_history", continuity?.authority);
  await ledger.tx(async () => {});
  const hashes = (owner: string) => ({ sim: store.hashUser("sim", simOwnerAlias(owner)), izs: store.hashUser("izs", simOwnerAlias(owner)) });
  const active = async (hash: string, c?: any) => {
    const read = async (client: any) => {
      const row = (
        await client.query(
          "SELECT a.state,a.reset_epoch FROM sim_user_history.resource r JOIN sim_user_history.account a USING(owner_key) WHERE r.resource_hash=$1 FOR SHARE OF a",
          [hash]
        )
      ).rows[0];
      if (!row || row.state !== "active" || row.reset_epoch !== s.resetEpoch) throw Error("SIM_HISTORY_FENCED");
    };
    if (c && continuity)
      await continuity.authority.withAdmission(async (lease: any) => {
        await read(c);
        await lease.assertCurrent();
      });
    else if (c) await read(c);
    else await ledger.tx(read);
  };
  store.simUserData = { assertActive: active };
  const legacy = store.accountErasure;
  const combinedGate = {
    async assertActive(hash: string, c?: any) {
      const p = c ?? store.pool;
      const r = await p.query("SELECT 1 FROM sim_user_history.resource WHERE resource_hash=$1", [hash]);
      if (r.rowCount) await active(hash, c);
      else if (legacy) await legacy.assertActive(hash, c);
      else throw Error("SIM_HISTORY_OWNER_REQUIRED");
    }
  };
  function authorize(req: Request, res: Response, izs = false) {
    res.set("Cache-Control", "no-store");
    const token = /^Bearer (.+)$/.exec(req.header("authorization") ?? "")?.[1] ?? "";
    const expectedToken = izs ? (config.izsToken ?? "") : config.simToken;
    if (expectedToken.length < 32 || !secure(token, expectedToken)) {
      res.status(401).json({ error: "UNAUTHORIZED" });
      return null;
    }
    const actor = verifySimOwner(req, s);
    if (!actor) {
      res.status(401).json({ error: "SIM_OWNER_ATTESTATION_INVALID" });
      return null;
    }
    return actor;
  }
  async function tick() {
    return ledger.runOne(async (c, a) => {
      const h = hashes(a.owner_key),
        values = Object.values(h);
      if (
        Number(
          (
            await c.query(
              "SELECT (SELECT count(*) FROM ai_router_request WHERE client_id='sim' AND user_hash=$1 AND status IN('reserved','uncertain'))+(SELECT count(*) FROM ai_router_billing_request WHERE task_type='sim_izs_summary' AND actor_hash=$2 AND status IN('reserved','uncertain')) n",
              [h.sim, h.izs]
            )
          ).rows[0].n
        ) > 0
      )
        return null;
      if (
        Number(
          (
            await c.query(
              "SELECT count(*) n FROM ai_router_billing_request WHERE task_type='sim_izs_summary' AND actor_hash=$1 AND(billing_source<>'sim_project' OR payer_hash<>'sim_izs_project')",
              [h.izs]
            )
          ).rows[0].n
        ) !== 0
      )
        throw Error("SIM_HISTORY_FOREIGN_PAYER");
      for (const spec of [
        {
          table: "ai_router_request",
          condition: "client_id='sim' AND user_hash=$1",
          hash: h.sim,
          cost: "COALESCE(charged_microusd,reserved_microusd,0)",
          lane: "router"
        },
        {
          table: "ai_router_billing_request",
          condition: "task_type='sim_izs_summary' AND billing_source='sim_project' AND payer_hash='sim_izs_project' AND actor_hash=$1",
          hash: h.izs,
          cost: "COALESCE(estimated_microusd,reserved_microusd,0)",
          lane: "sim_project"
        }
      ]) {
        await c.query(
          `INSERT INTO sim_user_history.cost_daily SELECT '${spec.lane}',(created_at AT TIME ZONE 'UTC')::date,sum(${spec.cost}),count(*),sum(COALESCE(input_tokens,0)),sum(COALESCE(output_tokens,0)),(date_trunc('month',now() AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC' FROM ${spec.table} WHERE ${spec.condition} AND created_at>=date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' GROUP BY 2 ON CONFLICT(lane,usage_day) DO UPDATE SET microusd=sim_user_history.cost_daily.microusd+excluded.microusd,requests=sim_user_history.cost_daily.requests+excluded.requests,input_tokens=sim_user_history.cost_daily.input_tokens+excluded.input_tokens,output_tokens=sim_user_history.cost_daily.output_tokens+excluded.output_tokens`,
          [spec.hash]
        );
        await c.query(`DELETE FROM ${spec.table} WHERE ${spec.condition}`, [spec.hash]);
      }
      const n = Number(
        (
          await c.query(
            "SELECT(SELECT count(*) FROM ai_router_request WHERE client_id='sim' AND user_hash=ANY($1::text[]))+(SELECT count(*) FROM ai_router_billing_request WHERE task_type='sim_izs_summary' AND actor_hash=ANY($1::text[])) n",
            [values]
          )
        ).rows[0].n
      );
      if (n !== 0) throw Error("SIM_HISTORY_READBACK_FAILED");
      return { app_store: "deleted", audit_and_publisher: "deleted", router_sim_history: "deleted" };
    });
  }
  async function receipt(v: any, owner: string) {
    let remainingRecords: null | number = null;
    if (v.state === "deleted") {
      const h = hashes(owner);
      remainingRecords = await ledger.tx(async (c) =>
        Number(
          (
            await c.query(
              "SELECT(SELECT count(*) FROM ai_router_request WHERE client_id='sim' AND user_hash=$1)+(SELECT count(*) FROM ai_router_billing_request WHERE task_type='sim_izs_summary' AND actor_hash=$2) n",
              [h.sim, h.izs]
            )
          ).rows[0].n
        )
      );
      if (remainingRecords !== 0) throw Error("SIM_HISTORY_READBACK_FAILED");
    }
    const { subcomponents: _mainOnly, ...historyReceipt } = v;
    return { ...historyReceipt, component: "sim_router_history", remainingRecords };
  }
  function register(app: Express) {
    const prefix = "/api/v1/ai-router/internal/sim-user-history/v1";
    app.use(prefix, (req, res, next) => {
      res.set("Cache-Control", "no-store");
      if (req.headers.origin || req.originalUrl.includes("?")) return res.status(404).json({ error: "NOT_FOUND" });
      return next();
    });
    app.get(prefix + "/capabilities", async (req, res) => {
      if (!secure(req.header("authorization") ?? "", "Bearer " + config.simToken)) return res.status(401).json({ error: "UNAUTHORIZED" });
      try {
        await ledger.tx(async () => {});
        return res.json({
          contractVersion: SIM_USER_DATA_CONTRACT,
          component: "sim_router_history",
          scope: SIM_USER_SCOPE,
          resetEpoch: s.resetEpoch,
          ready: true,
          wholeAccountComplete: false
        });
      } catch {
        return res.status(503).json({ error: "SIM_HISTORY_UNAVAILABLE" });
      }
    });
    app.post(prefix + "/deletions", async (req, res) => {
      const a = authorize(req, res);
      if (!a) return;
      const b = req.body;
      if (
        !b ||
        Object.keys(b).length !== 5 ||
        !["contractVersion", "scope", "resetEpoch", "operationId", "requestedAt"].every((k) => Object.hasOwn(b, k)) ||
        b.contractVersion !== SIM_USER_DATA_CONTRACT ||
        b.scope !== SIM_USER_SCOPE ||
        b.resetEpoch !== s.resetEpoch ||
        b.operationId !== a.operationId ||
        b.requestedAt !== a.requestedAt
      )
        return res.status(400).json({ error: "INVALID_REQUEST" });
      try {
        const v = await ledger.request(a.ownerKey, b.operationId, b.requestedAt, a.oidcIat);
        return res.status(v.state === "deleted" ? 200 : 202).json(await receipt(v, a.ownerKey));
      } catch {
        return res.status(503).json({ error: "SIM_HISTORY_UNAVAILABLE" });
      }
    });
    app.get(prefix + "/deletions/:operationId", async (req, res) => {
      const a = authorize(req, res);
      if (!a) return;
      if (req.params.operationId !== a.operationId) return res.status(400).json({ error: "INVALID_OPERATION" });
      try {
        const r = await ledger.status(a.ownerKey, String(req.params.operationId));
        return r ? res.json(await receipt(r, a.ownerKey)) : res.status(404).json({ error: "NOT_FOUND" });
      } catch {
        return res.status(503).json({ error: "SIM_HISTORY_UNAVAILABLE" });
      }
    });
    app.use(async (req, res, next) => {
      const sim =
          req.path === "/api/v1/ai-router/generate" &&
          req.method === "POST" &&
          /^Bearer (.+)$/.exec(req.header("authorization") ?? "")?.[1] === config.simToken,
        izs = req.path === "/api/v1/ai-router/sim/izs-summary" && req.method === "POST";
      if (!sim && !izs) return next();
      const a = authorize(req, res, izs);
      if (!a) return;
      const alias = simOwnerAlias(a.ownerKey);
      if ((sim && req.body?.userId !== alias) || (izs && req.header("x-sim-actor") !== alias))
        return res.status(400).json({ error: "SIM_OWNER_RESOURCE_MISMATCH" });
      try {
        await ledger.withOwner(a.ownerKey, async (c) => {
          for (const [k, h] of Object.entries(hashes(a.ownerKey))) {
            await c.query("INSERT INTO sim_user_history.resource VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [h, a.ownerKey, k]);
            const r = (await c.query("SELECT owner_key FROM sim_user_history.resource WHERE resource_hash=$1", [h])).rows[0];
            if (r.owner_key !== a.ownerKey) throw Error("SIM_HISTORY_BINDING_CONFLICT");
          }
        });
        return next();
      } catch {
        return res.status(503).json({ error: "SIM_HISTORY_FENCED" });
      }
    });
  }
  let running: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (!running)
      running = (async () => {
        await tick();
        await ledger.tx(async (c) => {
          await c.query("DELETE FROM sim_user_history.cost_daily WHERE expires_at<=now()");
        });
      })()
        .catch(() => {})
        .finally(() => {
          running = undefined;
        });
  }, 1000);
  timer.unref();
  return {
    ledger,
    register,
    tick,
    combinedGate,
    async close() {
      clearInterval(timer);
      await running;
      await continuity?.close();
    }
  };
}
