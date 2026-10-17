/** Concrete independent PostgreSQL continuity for the NEW user-data contract.
 * No callback claims, environment booleans, enrollment or legacy adoption.
 * This factory is source/isolated-test only until joint Root acceptance. */
import { createHash } from "node:crypto";
const issued = new WeakSet();
const keys = [
  "guard_store_id",
  "target_store_id",
  "incarnation_id",
  "environment_id",
  "reset_epoch",
  "checkpoint_id",
  "restore_generation",
  "source_sha256",
  "identity_sha256"
];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hex = /^[a-f0-9]{64}$/;
const need = (value) => {
  if (!value) throw Error("SIM_USER_CONTINUITY_UNAVAILABLE");
};
const stable = (row) => Object.fromEntries(keys.map((k) => [k, String(row[k])]));
export function isSimUserDataAuthority(value) {
  return issued.has(value);
}
export async function createSimUserDataAuthority({ guardPool, targetPool, component, binding }) {
  need(["sim_user_data", "sim_user_history"].includes(component));
  need(binding && Object.keys(binding).length === keys.length && keys.every((k) => Object.hasOwn(binding, k)));
  need(
    keys.slice(0, 6).every((k) => uuid.test(binding[k])) &&
      /^[1-9][0-9]*$/.test(binding.restore_generation) &&
      hex.test(binding.source_sha256) &&
      hex.test(binding.identity_sha256)
  );
  const expected = JSON.stringify(stable(binding));
  const lock = createHash("sha256")
    .update("sim-user-continuity-v1\0" + component)
    .digest()
    .readInt32BE(0);
  let initialized = false;
  async function verify(g, target = targetPool) {
    const role = (
      await g.query(
        "SELECT current_user AS name,r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication AS elevated FROM pg_roles r WHERE rolname=current_user"
      )
    ).rows[0];
    need(role && role.name === component + "_guard_runtime" && role.elevated === false);
    const targetRole = (
      await target.query(
        "SELECT current_user AS name,r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication AS elevated FROM pg_roles r WHERE rolname=current_user"
      )
    ).rows[0];
    need(targetRole && targetRole.name === (component === "sim_user_data" ? "sim_user_data_runtime" : "ai_router_runtime") && targetRole.elevated === false);
    const row = (await g.query("SELECT current_database() db,* FROM sim_erasure_guard_v2.user_data_checkpoint WHERE component=$1", [component])).rows;
    need(
      row.length === 1 &&
        row[0].db === "cop_account_safety_guard" &&
        row[0].contract === "sim-user-continuity-v1" &&
        row[0].state === "ready" &&
        JSON.stringify(stable(row[0])) === expected
    );
    const local = (await target.query(`SELECT current_database() db,* FROM ${component}.continuity WHERE singleton`)).rows;
    need(
      local.length === 1 &&
        local[0].db === (component === "sim_user_data" ? "sim_user_data" : "sim_ai_router") &&
        local[0].contract === "sim-user-continuity-v1" &&
        JSON.stringify(stable(local[0])) === expected
    );
    const cfg = (await target.query(`SELECT environment_id,reset_epoch FROM ${component}.config WHERE singleton`)).rows;
    need(cfg.length === 1 && cfg[0].environment_id === binding.environment_id && cfg[0].reset_epoch === binding.reset_epoch);
  }
  async function tombstones(g) {
    const rows = (await g.query("SELECT * FROM sim_erasure_guard_v2.user_data_tombstone WHERE component=$1 ORDER BY operation_id LIMIT 10001", [component]))
      .rows;
    need(rows.length <= 10000);
    for (const row of rows)
      need(
        hex.test(row.owner_key) &&
          uuid.test(row.operation_id) &&
          row.reset_epoch === binding.reset_epoch &&
          Number.isSafeInteger(Number(row.oidc_iat)) &&
          Number(row.oidc_iat) > 0
      );
    return rows;
  }
  async function projected(g) {
    const rows = await tombstones(g);
    for (const r of rows) {
      const a = (
        await targetPool.query(
          `SELECT a.state,a.reset_epoch,j.operation_id,j.requested_at,j.oidc_iat FROM ${component}.account a JOIN ${component}.job j USING(owner_key) WHERE owner_key=$1`,
          [r.owner_key]
        )
      ).rows;
      need(
        a.length === 1 &&
          ["deletion_pending", "deleted"].includes(a[0].state) &&
          a[0].reset_epoch === r.reset_epoch &&
          a[0].operation_id === r.operation_id &&
          a[0].requested_at.toISOString() === r.requested_at.toISOString() &&
          String(a[0].oidc_iat) === String(r.oidc_iat)
      );
    }
  }
  async function replay(g) {
    for (const r of await tombstones(g)) {
      const t = await targetPool.connect();
      try {
        await t.query("BEGIN");
        await t.query("SET LOCAL lock_timeout='1500ms'");
        await verify(g, t);
        await t.query(`INSERT INTO ${component}.account(owner_key,reset_epoch) VALUES($1,$2) ON CONFLICT DO NOTHING`, [r.owner_key, r.reset_epoch]);
        const a = (await t.query(`SELECT * FROM ${component}.account WHERE owner_key=$1 FOR UPDATE`, [r.owner_key])).rows[0];
        need(a.reset_epoch === r.reset_epoch);
        const prior = (await t.query(`SELECT * FROM ${component}.job WHERE owner_key=$1 OR operation_id=$2`, [r.owner_key, r.operation_id])).rows;
        need(
          !prior.length ||
            (prior.length === 1 &&
              prior[0].owner_key === r.owner_key &&
              prior[0].operation_id === r.operation_id &&
              prior[0].requested_at.toISOString() === r.requested_at.toISOString() &&
              String(prior[0].oidc_iat) === String(r.oidc_iat))
        );
        if (!prior.length)
          await t.query(`INSERT INTO ${component}.job(owner_key,operation_id,requested_at,oidc_iat) VALUES($1,$2,$3,$4)`, [
            r.owner_key,
            r.operation_id,
            r.requested_at,
            r.oidc_iat
          ]);
        if (a.state === "active") await t.query(`UPDATE ${component}.account SET state='deletion_pending' WHERE owner_key=$1`, [r.owner_key]);
        await verify(g, t);
        await t.query("COMMIT");
      } catch (e) {
        await t.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        t.release();
      }
    }
  }
  async function locked(exclusive, work) {
    const g = await guardPool.connect();
    let acquired = false;
    try {
      await g.query("SET statement_timeout='10000ms';SET lock_timeout='1500ms'");
      await g.query(`SELECT pg_advisory_lock${exclusive ? "" : "_shared"}(781425,$1)`, [lock]);
      acquired = true;
      await verify(g);
      return await work(g);
    } finally {
      if (acquired)
        try {
          await g.query(`SELECT pg_advisory_unlock${exclusive ? "" : "_shared"}(781425,$1)`, [lock]);
        } catch {
          g.release(true);
          throw Error("SIM_USER_CONTINUITY_UNAVAILABLE");
        }
      g.release();
    }
  }
  const authority = {
    async init() {
      need(!initialized);
      await locked(true, async (g) => {
        await replay(g);
        await projected(g);
        await verify(g);
      });
      initialized = true;
    },
    async withAdmission(work) {
      need(initialized);
      return locked(false, async (g) => {
        await g.query("BEGIN");
        let open = true;
        const lease = {
          assertCurrent: async () => {
            need(open && initialized);
            await verify(g);
            await projected(g);
          }
        };
        try {
          await g.query("SELECT component FROM sim_erasure_guard_v2.user_data_checkpoint WHERE component=$1 FOR SHARE", [component]);
          await verify(g);
          await projected(g);
          const result = await work(lease);
          await lease.assertCurrent();
          await g.query("COMMIT");
          return result;
        } catch (e) {
          await g.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          open = false;
        }
      });
    },
    async recordDeletion(owner, operation, requestedAt, oidcIat) {
      need(
        initialized &&
          hex.test(owner) &&
          uuid.test(operation) &&
          new Date(requestedAt).toISOString() === requestedAt &&
          Number.isSafeInteger(oidcIat) &&
          oidcIat > 0
      );
      await locked(true, async (g) => {
        const cfg = (await targetPool.query(`SELECT tokens_not_before FROM ${component}.config WHERE singleton`)).rows[0];
        need(cfg && oidcIat > Number(cfg.tokens_not_before));
        await g.query("BEGIN");
        try {
          await verify(g);
          const rows = (
            await g.query("SELECT * FROM sim_erasure_guard_v2.user_data_tombstone WHERE component=$1 AND(owner_key=$2 OR operation_id=$3)", [
              component,
              owner,
              operation
            ])
          ).rows;
          need(
            !rows.length ||
              (rows.length === 1 &&
                rows[0].owner_key === owner &&
                rows[0].operation_id === operation &&
                rows[0].requested_at.toISOString() === requestedAt &&
                String(rows[0].oidc_iat) === String(oidcIat) &&
                rows[0].reset_epoch === binding.reset_epoch)
          );
          if (!rows.length)
            await g.query(
              "INSERT INTO sim_erasure_guard_v2.user_data_tombstone(component,owner_key,operation_id,requested_at,oidc_iat,reset_epoch) VALUES($1,$2,$3,$4,$5,$6)",
              [component, owner, operation, requestedAt, oidcIat, binding.reset_epoch]
            );
          await g.query("COMMIT");
        } catch (e) {
          await g.query("ROLLBACK").catch(() => {});
          throw e;
        }
        // Independent acceptance is committed BEFORE any target projection.
        await replay(g);
        await projected(g);
        await verify(g);
      });
    }
  };
  await authority.init();
  issued.add(authority);
  return Object.freeze(authority);
}
