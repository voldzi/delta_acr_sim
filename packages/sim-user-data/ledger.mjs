/** The app and Router use separate dedicated ledgers; never browser-selected. */
import { AsyncLocalStorage } from "node:async_hooks";
import { isSimUserDataAuthority } from "./authority.mjs";
const leases = new AsyncLocalStorage();
export class UserLedger {
  constructor(pool, expected, schema = "sim_user_data", authority) {
    if (!["sim_user_data", "sim_user_history"].includes(schema)) throw Error("SIM_LEDGER_SCHEMA");
    this.pool = pool;
    this.expected = expected;
    this.schema = schema;
    this.completedCursor = "";
    if (authority !== undefined && !isSimUserDataAuthority(authority)) throw Error("SIM_USER_REAL_AUTHORITY_REQUIRED");
    if (expected.mode === "production-sim-user-data-v1" && !isSimUserDataAuthority(authority)) throw Error("SIM_USER_REAL_AUTHORITY_REQUIRED");
    this.authority = authority;
  }
  async tx(work) {
    if (this.authority) return this.authority.withAdmission((lease) => this.#targetTx(work, lease));
    return this.#targetTx(work);
  }
  async #targetTx(work, admission) {
    const c = await this.pool.connect();
    let lease;
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL statement_timeout='10000ms'; SET LOCAL lock_timeout='2000ms'");
      const cfg = (await c.query(`SELECT * FROM ${this.schema}.config WHERE singleton`)).rows[0];
      if (
        !cfg ||
        cfg.contract !== "cop-sim-user-data-v1" ||
        cfg.mode !== this.expected.mode ||
        cfg.environment_id !== this.expected.environmentId ||
        cfg.reset_epoch !== this.expected.resetEpoch ||
        Number(cfg.tokens_not_before) !== this.expected.tokensNotBefore
      )
        throw Error("SIM_USER_CONFIG_MISMATCH");
      lease = { ledger: this, c, cfg, owner: undefined, account: undefined, open: true, tasks: new Set(), failures: [] };
      const result = await leases.run(lease, () => work(c, cfg));
      while (lease.tasks.size) {
        await Promise.allSettled([...lease.tasks]);
      }
      lease.open = false;
      if (lease.failures.length) throw lease.failures[0];
      if (admission) await admission.assertCurrent();
      await c.query("COMMIT");
      return result;
    } catch (e) {
      if (lease) lease.open = false;
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      if (lease) lease.open = false;
      c.release();
    }
  }
  async withOwner(owner, work, { create = true } = {}) {
    if (!/^[a-f0-9]{64}$/.test(owner)) throw Error("SIM_OWNER_REQUIRED");
    const active = leases.getStore();
    if (active?.ledger === this && active.owner === owner && active.open) {
      const task = Promise.resolve().then(() => {
        if (!active.open || active.account.state !== "active") throw Error("SIM_USER_FENCED");
        return work(active.c, active.account);
      });
      active.tasks.add(task);
      void task.catch((e) => active.failures.push(e)).finally(() => active.tasks.delete(task));
      return task;
    }
    return this.tx(async (c, cfg) => {
      if (create) await c.query(`INSERT INTO ${this.schema}.account(owner_key,reset_epoch) VALUES($1,$2) ON CONFLICT DO NOTHING`, [owner, cfg.reset_epoch]);
      const row = (await c.query(`SELECT * FROM ${this.schema}.account WHERE owner_key=$1 FOR UPDATE`, [owner])).rows[0];
      if (!row || row.reset_epoch !== cfg.reset_epoch || row.state !== "active") throw Error("SIM_USER_FENCED");
      const lease = leases.getStore();
      lease.owner = owner;
      lease.account = row;
      return work(c, row);
    });
  }
  async request(owner, operation, requestedAt, oidcIat) {
    if (this.authority) await this.authority.recordDeletion(owner, operation, requestedAt, oidcIat);
    return this.tx(async (c, cfg) => {
      if (!/^[a-f0-9]{64}$/.test(owner) || !Number.isSafeInteger(oidcIat) || oidcIat <= Number(cfg.tokens_not_before)) throw Error("SIM_OWNER_REQUIRED");
      await c.query(`INSERT INTO ${this.schema}.account(owner_key,reset_epoch) VALUES($1,$2) ON CONFLICT DO NOTHING`, [owner, cfg.reset_epoch]);
      const a = (await c.query(`SELECT * FROM ${this.schema}.account WHERE owner_key=$1 FOR UPDATE`, [owner])).rows[0];
      if (a.reset_epoch !== cfg.reset_epoch) throw Error("SIM_USER_CONFIG_MISMATCH");
      const job = (await c.query(`SELECT * FROM ${this.schema}.job WHERE owner_key=$1`, [owner])).rows[0];
      if (job) {
        if (job.operation_id !== operation || job.requested_at.toISOString() !== requestedAt) throw Error("SIM_USER_OPERATION_CONFLICT");
        return this.receipt(a, job);
      }
      await c.query(`INSERT INTO ${this.schema}.job(owner_key,operation_id,requested_at,oidc_iat) VALUES($1,$2,$3,$4)`, [
        owner,
        operation,
        requestedAt,
        oidcIat
      ]);
      await c.query(`UPDATE ${this.schema}.account SET state='deletion_pending' WHERE owner_key=$1`, [owner]);
      return this.receipt({ ...a, state: "deletion_pending" }, (await c.query(`SELECT * FROM ${this.schema}.job WHERE owner_key=$1`, [owner])).rows[0]);
    });
  }
  receipt(a, j) {
    return {
      contractVersion: "cop-sim-user-data-v1",
      component: "sim_user_data",
      scope: "cop_sim_shared_identity_v1",
      resetEpoch: a.reset_epoch,
      operationId: j.operation_id,
      state: a.state,
      subcomponents: { app_store: j.app_store, audit_and_publisher: j.audit_and_publisher, router_sim_history: j.router_sim_history },
      wholeAccountComplete: false
    };
  }
  async status(owner, operation) {
    return this.tx(async (c) => {
      const a = (await c.query(`SELECT * FROM ${this.schema}.account WHERE owner_key=$1`, [owner])).rows[0],
        j = (await c.query(`SELECT * FROM ${this.schema}.job WHERE owner_key=$1 AND operation_id=$2`, [owner, operation])).rows[0];
      return a && j ? this.receipt(a, j) : null;
    });
  }
  async runOne(clean, { includeCompleted = false } = {}) {
    const result = await this.tx(async (c, cfg) => {
      let a = (
        await c.query(
          `SELECT a.* FROM ${this.schema}.account a JOIN ${this.schema}.job j USING(owner_key) WHERE a.state='deletion_pending' ORDER BY j.requested_at FOR UPDATE OF a SKIP LOCKED LIMIT 1`
        )
      ).rows[0];
      if (!a && includeCompleted) a = (await c.query(
        `SELECT a.* FROM ${this.schema}.account a JOIN ${this.schema}.job j USING(owner_key) WHERE a.state='deleted' AND a.reset_epoch=$1 AND j.app_store='deleted' AND j.audit_and_publisher='deleted' AND j.router_sim_history='deleted' ORDER BY (a.owner_key>$2) DESC,a.owner_key FOR UPDATE OF a SKIP LOCKED LIMIT 1`,
        [cfg.reset_epoch, this.completedCursor]
      )).rows[0];
      if (!a) return { state: "idle" };
      const j = (await c.query(`SELECT * FROM ${this.schema}.job WHERE owner_key=$1`, [a.owner_key])).rows[0];
      const r = await clean(c, a, j);
      if (a.state === "deleted") {
        if (!r || !["app_store", "audit_and_publisher", "router_sim_history"].every((k) => r[k] === "deleted")) throw Error("SIM_USER_REPLAY_UNPROVEN");
        return { ...this.receipt(a, j), replayedOwner: a.owner_key };
      }
      if (!r || !["app_store", "audit_and_publisher", "router_sim_history"].every((k) => r[k] === "deleted")) return this.receipt(a, j);
      await c.query(`UPDATE ${this.schema}.job SET app_store='deleted',audit_and_publisher='deleted',router_sim_history='deleted' WHERE owner_key=$1`, [
        a.owner_key
      ]);
      await c.query(`UPDATE ${this.schema}.account SET state='deleted' WHERE owner_key=$1`, [a.owner_key]);
      return this.receipt({ ...a, state: "deleted" }, { ...j, ...r });
    });
    if (result.replayedOwner) {
      this.completedCursor = result.replayedOwner;
      const { replayedOwner: _owner, ...receipt } = result;
      return receipt;
    }
    return result;
  }
}
