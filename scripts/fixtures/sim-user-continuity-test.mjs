/** Actual owned PostgreSQL continuity checks; not a Root or production proof. */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createSimUserDataAuthority } from "../../packages/sim-user-data/authority.mjs";
import { UserLedger } from "../../packages/sim-user-data/ledger.mjs";
import { runtimeIdentityFingerprint, loadSimUserAuthority } from "../../packages/sim-user-data/bootstrap.mjs";
export async function testUserContinuity({ db, main, ai, input, Pool, check }) {
  const owned = (await db.admin.query("SELECT current_user r,current_setting('cluster_name') c")).rows[0];
  assert.equal(owned.r, "owned_fixture_admin");
  assert.equal(owned.c, "cop_clean_whole_fixture_v1");
  await db.admin.query("CREATE DATABASE cop_account_safety_guard");
  await db.admin.query("CREATE ROLE sim_user_data_guard_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
  await db.admin.query("CREATE ROLE sim_user_history_guard_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
  const url = (database, user) =>
    db
      .url("sim_ai_router", "ai_router_migrator")
      .replace("/sim_ai_router?", "/" + database + "?")
      .replace("user=ai_router_migrator", "user=" + user);
  const guardAdmin = new Pool({ connectionString: url("cop_account_safety_guard", "owned_fixture_admin") });
  const guard = new Pool({ connectionString: url("cop_account_safety_guard", "sim_user_data_guard_runtime") });
  const target = new Pool({ connectionString: url("sim_user_data", "sim_user_data_migrator") });
  const historyGuard = new Pool({ connectionString: url("cop_account_safety_guard", "sim_user_history_guard_runtime") });
  const historyTarget = new Pool({ connectionString: url("sim_ai_router", "ai_router_migrator") });
  try {
    await guardAdmin.query(
      "REVOKE ALL ON DATABASE cop_account_safety_guard FROM PUBLIC;GRANT CONNECT ON DATABASE cop_account_safety_guard TO sim_user_data_guard_runtime,sim_user_history_guard_runtime;REVOKE ALL ON SCHEMA public FROM PUBLIC"
    );
    await guardAdmin.query(await readFile(join(db.sourceRoot, "deploy/sim-user-data/003_independent_checkpoint.sql"), "utf8"));
    await target.query(await readFile(join(db.sourceRoot, "deploy/sim-user-data/004_app_continuity.sql"), "utf8"));
    const binding = {
      guard_store_id: randomUUID(),
      target_store_id: randomUUID(),
      incarnation_id: randomUUID(),
      environment_id: input.base.environmentId,
      reset_epoch: input.base.resetEpoch,
      checkpoint_id: randomUUID(),
      restore_generation: "1",
      source_sha256: createHash("sha256")
        .update(await readFile(join(db.sourceRoot, "packages/sim-user-data/authority.mjs")))
        .digest("hex"),
      identity_sha256: runtimeIdentityFingerprint("sim_user_data", {
        ownerSecret: input.userDataEnvironment.ownerSecret,
        actorSecret: input.userDataEnvironment.copActorSecret,
        routerActorSecret: input.userDataEnvironment.routerActorSecret,
        issuer: input.base.issuer
      })
    };
    const fields = Object.keys(binding),
      values = Object.values(binding);
    await guardAdmin.query(
      `INSERT INTO sim_erasure_guard_v2.user_data_checkpoint(component,contract,${fields.join(",")},state) VALUES('sim_user_data','sim-user-continuity-v1',${fields.map((_, i) => "$" + (i + 1)).join(",")},'ready')`,
      values
    );
    await target.query(
      `INSERT INTO sim_user_data.continuity(singleton,contract,${fields.join(",")}) VALUES(true,'sim-user-continuity-v1',${fields.map((_, i) => "$" + (i + 1)).join(",")})`,
      values
    );
    const factory = () => createSimUserDataAuthority({ guardPool: guard, targetPool: main.pool, component: "sim_user_data", binding });
    const authority = await factory(),
      ledger = new UserLedger(main.pool, main.settings, "sim_user_data", authority);
    const identity = {
      ownerSecret: input.userDataEnvironment.ownerSecret,
      actorSecret: input.userDataEnvironment.copActorSecret,
      routerActorSecret: input.userDataEnvironment.routerActorSecret,
      issuer: input.base.issuer
    };
    check(
      runtimeIdentityFingerprint("sim_user_data", { ...identity, ownerSecret: identity.ownerSecret + "changed" }) !== binding.identity_sha256,
      "changing owner secret changes runtime identity fingerprint"
    );
    await assert.rejects(
      () =>
        loadSimUserAuthority({
          Pool: class {
            constructor() {
              throw Error("UNEXPECTED_POOL");
            }
          },
          targetPool: main.pool,
          targetDatabaseUrl: main.settings.databaseUrl,
          component: "sim_user_data",
          settings: { ...main.settings, mode: "production-sim-user-data-v1" },
          identity: { ...identity, ownerSecret: identity.ownerSecret + "changed" },
          env: { SIM_USER_DATA_CONTINUITY_BINDING: JSON.stringify(binding) }
        }),
      /CONTINUITY_SOURCE_REQUIRED/
    );
    check(true, "production bootstrap refuses changed secret before connecting");
    check(
      await authority.withAdmission(async (lease) => {
        await lease.assertCurrent();
        return true;
      }),
      "concrete independent DB admission"
    );
    await assert.rejects(() =>
      createSimUserDataAuthority({
        guardPool: guard,
        targetPool: main.pool,
        component: "sim_user_data",
        binding: { ...binding, source_sha256: "0".repeat(64) }
      })
    );
    check(true, "source mismatch blocks factory");
    await assert.rejects(() => main.pool.query("UPDATE sim_user_data.continuity SET restore_generation=2"));
    check(true, "runtime cannot alter target witness");
    check(
      (await guard.query("UPDATE sim_erasure_guard_v2.user_data_checkpoint SET state='quarantined'")).rowCount === 0,
      "RLS denies runtime checkpoint updates"
    );
    // RLS UPDATE without policy can also return zero; verify it did not change.
    check(
      (await guardAdmin.query("SELECT state FROM sim_erasure_guard_v2.user_data_checkpoint")).rows[0].state === "ready",
      "runtime cannot change independent admission"
    );
    const owner = createHash("sha256").update(randomUUID()).digest("hex"),
      operation = randomUUID(),
      at = new Date().toISOString(),
      iat = input.base.actors.a.oidcIat;
    await ledger.withOwner(owner, async (c) => {
      await ledger.withOwner(owner, async (nested) => {
        check(nested === c, "nested owner writes share locked connection");
      });
      void ledger.withOwner(owner, async (nested) => {
        await nested.query("SELECT pg_sleep(0.02)");
      });
    });
    await assert.rejects(() =>
      ledger.withOwner(owner, async () => {
        void ledger
          .withOwner(owner, async () => {
            throw Error("SYNTHETIC_GUARD_FAILURE");
          })
          .catch(() => {});
      })
    );
    check(true, "nested failure aborts owner transaction even if child catches its promise");
    check((await ledger.request(owner, operation, at, iat)).state === "deletion_pending", "independent tombstone precedes target fence");
    check(
      Number((await guard.query("SELECT count(*) n FROM sim_erasure_guard_v2.user_data_tombstone")).rows[0].n) === 1,
      "actual immutable independent tombstone"
    );
    await assert.rejects(() => guard.query("DELETE FROM sim_erasure_guard_v2.user_data_tombstone"));
    check(true, "runtime tombstone deletion refused");
    await assert.rejects(() => ledger.withOwner(owner, async () => {}));
    check(true, "late writer after independent fence refused");
    // Simulate an older target backup by removing only the synthetic new owner,
    // through this owned test's migrator. Independent DB remains untouched.
    await target.query("DELETE FROM sim_user_data.job WHERE owner_key=$1", [owner]);
    await target.query("DELETE FROM sim_user_data.account WHERE owner_key=$1", [owner]);
    await assert.rejects(() => authority.withAdmission(async () => true));
    check(true, "restored target without tombstone projection is blocked");
    const restarted = await factory();
    check(
      (await new UserLedger(main.pool, main.settings, "sim_user_data", restarted).status(owner, operation)).state === "deletion_pending",
      "restart replays original immutable operation, never completes optimistically"
    );
    await guardAdmin.query("UPDATE sim_erasure_guard_v2.user_data_checkpoint SET restore_generation=2");
    await assert.rejects(() => restarted.withAdmission(async () => true));
    await assert.rejects(factory);
    check(true, "different restore generation blocks existing and restarted authority");
    await guardAdmin.query("UPDATE sim_erasure_guard_v2.user_data_checkpoint SET restore_generation=1,state='quarantined'");
    await assert.rejects(factory);
    check(true, "quarantine blocks restart");
    await guardAdmin.query("UPDATE sim_erasure_guard_v2.user_data_checkpoint SET state='ready'");
    await authority.withAdmission(async () => true);
    check(true, "exact original binding only resumes after real checks");
    await historyTarget.query(await readFile(join(db.sourceRoot, "deploy/sim-user-data/005_history_continuity.sql"), "utf8"));
    const historyBinding = {
      ...binding,
      target_store_id: randomUUID(),
      incarnation_id: randomUUID(),
      checkpoint_id: randomUUID(),
      identity_sha256: runtimeIdentityFingerprint("sim_user_history", {
        hashSecret: input.base.environment.routerHashSecret,
        actorSecret: input.userDataEnvironment.routerActorSecret,
        issuer: input.base.issuer
      })
    };
    await guardAdmin.query(
      `INSERT INTO sim_erasure_guard_v2.user_data_checkpoint(component,contract,${fields.join(",")},state) VALUES('sim_user_history','sim-user-continuity-v1',${fields.map((_, i) => "$" + (i + 1)).join(",")},'ready')`,
      Object.values(historyBinding)
    );
    await historyTarget.query(
      `INSERT INTO sim_user_history.continuity(singleton,contract,${fields.join(",")}) VALUES(true,'sim-user-continuity-v1',${fields.map((_, i) => "$" + (i + 1)).join(",")})`,
      Object.values(historyBinding)
    );
    const history = await createSimUserDataAuthority({
      guardPool: historyGuard,
      targetPool: ai.runtime,
      component: "sim_user_history",
      binding: historyBinding
    });
    check(await history.withAdmission(async () => true), "actual separate history checkpoint admission");
    check(
      (await guard.query("SELECT count(*) n FROM sim_erasure_guard_v2.user_data_checkpoint")).rows[0].n === "1",
      "app guard cannot read history checkpoint"
    );
    check(
      (await historyGuard.query("SELECT count(*) n FROM sim_erasure_guard_v2.user_data_checkpoint")).rows[0].n === "1",
      "history guard cannot read app checkpoint"
    );
    await assert.rejects(() => createSimUserDataAuthority({ guardPool: historyGuard, targetPool: main.pool, component: "sim_user_data", binding }));
    check(true, "cross-component guard role rejected");
    assert.throws(() => new UserLedger(main.pool, main.settings, "sim_user_data", { withAdmission: async (work) => work({ assertCurrent: async () => {} }) }));
    check(true, "unissued positive authority callback rejected");
  } finally {
    await historyGuard.end();
    await historyTarget.end();
    await guard.end();
    await guardAdmin.end();
    await target.end();
  }
}
