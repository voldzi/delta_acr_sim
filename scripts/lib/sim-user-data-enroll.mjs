/** Root controller source port; never called by application startup or a CLI.
 * Requires real Root reset admission AND exact fresh catalog/source. */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { withResetWork } from "./clean-reset-admission.mjs";
import { catalog } from "./clean-reset-ops.mjs";
import { inspectUserDataProfile, userDataCatalog } from "./sim-user-data-profile.mjs";
const source = fileURLToPath(new URL("../../", import.meta.url)),
  sha = (x) => createHash("sha256").update(x).digest("hex");
const need = (v) => {
  if (!v) throw Error("SIM_USER_ENROLL_UNPROVEN");
};
export const USER_DATA_MANIFEST_SHA = "9f71d113ba47a7880fca6a7df76f7fefbca401c1791acb57f86969c1fdaed76e";
export async function verifiedUserMigrations(manifest) {
  need(manifest?.contractVersion === "sim-user-data-reset-profile-v2");
  const frozen = await readFile(join(source, "deploy/sim-user-data/reset-manifest-v2.json"));
  need(sha(frozen) === USER_DATA_MANIFEST_SHA && JSON.stringify(JSON.parse(frozen)) === JSON.stringify(manifest));
  const texts = {};
  for (const file of ["001_app_schema.sql", "002_ai_history.sql", "003_independent_checkpoint.sql", "004_app_continuity.sql", "005_history_continuity.sql"]) {
    const bytes = await readFile(join(source, "deploy/sim-user-data", file));
    need(sha(bytes) === manifest.pins[file]);
    texts[file] = bytes.toString("utf8");
  }
  need(sha(await readFile(join(source, "packages/sim-user-data/authority.mjs"))) === manifest.authoritySourceSha256);
  return texts;
}
export async function transitionSimHistory({ client, manifest, rootGate, reviewedCatalogDigest, assertWritersStopped }) {
  const texts = await verifiedUserMigrations(manifest);
  need(reviewedCatalogDigest === manifest.aiBaseCatalogDigest && typeof assertWritersStopped === "function");
  return withResetWork(rootGate, { contractVersion: manifest.contractVersion, reviewedCatalogDigest }, async (admission, assertOpen) => {
    await admission.assertCurrent();
    await assertWritersStopped();
    assertOpen();
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL lock_timeout='1500ms';SET LOCAL statement_timeout='10000ms'");
      await client.query(
        "LOCK TABLE public.ai_router_request,public.ai_router_billing_request,public.ai_router_policy,public.ai_router_policy_audit,sim_clean.config,sim_clean.account,sim_clean.job IN ACCESS EXCLUSIVE MODE"
      );
      need((await catalog(client, "ai")).digest === reviewedCatalogDigest);
      const config = (await client.query("SELECT * FROM sim_clean.config WHERE singleton")).rows[0];
      need(config?.mode === "production-clean-lifecycle-v1");
      need(
        Number(
          (
            await client.query(
              "SELECT(SELECT count(*) FROM sim_clean.account)+(SELECT count(*) FROM sim_clean.job)+(SELECT count(*) FROM sim_clean.resource) n"
            )
          ).rows[0].n
        ) === 0
      );
      await client.query("SET LOCAL search_path=public,pg_catalog");
      for (const name of ["002_ai_history.sql", "005_history_continuity.sql"])
        await client.query(texts[name].replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, ""));
      const result = await inspectUserDataProfile(client, manifest);
      need(result.state === "known-new-unused");
      await assertWritersStopped();
      await admission.assertCurrent();
      assertOpen();
      await client.query("COMMIT");
      return result;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  });
}
export async function enrollSimUserTarget({ client, component, binding, tokensNotBefore, rootGate, manifest, assertWritersStopped }) {
  const schema = component;
  need(
    ["sim_user_data", "sim_user_history"].includes(schema) &&
      Number.isSafeInteger(tokensNotBefore) &&
      tokensNotBefore > 0 &&
      tokensNotBefore <= Math.floor(Date.now() / 1000)
  );
  await verifiedUserMigrations(manifest);
  need(binding?.source_sha256 === manifest.authoritySourceSha256 && typeof assertWritersStopped === "function");
  return withResetWork(rootGate, { contractVersion: "sim-user-continuity-v1", component, resetEpoch: binding.reset_epoch }, async (admission, assertOpen) => {
    await admission.assertCurrent();
    await assertWritersStopped();
    assertOpen();
    await client.query("BEGIN");
    try {
      const identity = (await client.query("SELECT current_user r,current_database() d")).rows[0];
      need(
        identity.r === (schema === "sim_user_data" ? "sim_user_data_migrator" : "ai_router_migrator") &&
          identity.d === (schema === "sim_user_data" ? "sim_user_data" : "sim_ai_router")
      );
      await client.query(`LOCK TABLE ${schema}.config,${schema}.account,${schema}.job,${schema}.continuity IN ACCESS EXCLUSIVE MODE`);
      need(
        Number(
          (
            await client.query(
              `SELECT(SELECT count(*) FROM ${schema}.config)+(SELECT count(*) FROM ${schema}.account)+(SELECT count(*) FROM ${schema}.job)+(SELECT count(*) FROM ${schema}.continuity) n`
            )
          ).rows[0].n
        ) === 0
      );
      const fields = [
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
      need(Object.keys(binding).length === fields.length && fields.every((k) => Object.hasOwn(binding, k)));
      await client.query(
        `INSERT INTO ${schema}.continuity(singleton,contract,${fields.join(",")}) VALUES(true,'sim-user-continuity-v1',${fields.map((_, i) => "$" + (i + 1)).join(",")})`,
        fields.map((k) => binding[k])
      );
      await client.query(`INSERT INTO ${schema}.config VALUES(true,'cop-sim-user-data-v1','production-sim-user-data-v1',$1,$2,$3)`, [
        binding.environment_id,
        binding.reset_epoch,
        tokensNotBefore
      ]);
      await assertWritersStopped();
      await admission.assertCurrent();
      assertOpen();
      await client.query("COMMIT");
      return { component, resetEpoch: binding.reset_epoch, state: "enrolled-not-activated", wholeAccountComplete: false };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  });
}
export async function enrollSimGuardCheckpoint({ guardClient, targetClient, component, binding, rootGate, manifest, assertWritersStopped }) {
  await verifiedUserMigrations(manifest);
  need(["sim_user_data", "sim_user_history"].includes(component) && typeof assertWritersStopped === "function");
  const fields = [
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
  need(
    binding &&
      Object.keys(binding).length === fields.length &&
      fields.every((k) => Object.hasOwn(binding, k)) &&
      binding.source_sha256 === manifest.authoritySourceSha256
  );
  return withResetWork(rootGate, { contractVersion: "sim-user-continuity-v1", component, resetEpoch: binding.reset_epoch }, async (admission, assertOpen) => {
    await admission.assertCurrent();
    await assertWritersStopped();
    assertOpen();
    await guardClient.query("BEGIN");
    try {
      need((await guardClient.query("SELECT current_database() d")).rows[0].d === "cop_account_safety_guard");
      const cat = await userDataCatalog(targetClient, component);
      need(cat.digest === (component === "sim_user_data" ? manifest.appUserDataCatalogDigest : manifest.aiUserDataCatalogDigest));
      const witness = (await targetClient.query(`SELECT * FROM ${component}.continuity WHERE singleton`)).rows[0];
      const cfg = (await targetClient.query(`SELECT * FROM ${component}.config WHERE singleton`)).rows[0];
      need(
        witness &&
          fields.every((k) => String(witness[k]) === String(binding[k])) &&
          cfg?.mode === "production-sim-user-data-v1" &&
          cfg.environment_id === binding.environment_id &&
          cfg.reset_epoch === binding.reset_epoch
      );
      need(Number((await targetClient.query(`SELECT(SELECT count(*) FROM ${component}.account)+(SELECT count(*) FROM ${component}.job) n`)).rows[0].n) === 0);
      await guardClient.query(
        `INSERT INTO sim_erasure_guard_v2.user_data_checkpoint(component,contract,${fields.join(",")},state) VALUES($1,'sim-user-continuity-v1',${fields.map((_, i) => "$" + (i + 2)).join(",")},'quarantined') ON CONFLICT DO NOTHING`,
        [component, ...fields.map((k) => binding[k])]
      );
      const row = (await guardClient.query("SELECT * FROM sim_erasure_guard_v2.user_data_checkpoint WHERE component=$1 FOR UPDATE", [component])).rows[0];
      need(row && fields.every((k) => String(row[k]) === String(binding[k])) && row.contract === "sim-user-continuity-v1");
      await admission.assertCurrent();
      await assertWritersStopped();
      assertOpen();
      need((await guardClient.query("UPDATE sim_erasure_guard_v2.user_data_checkpoint SET state='ready' WHERE component=$1", [component])).rowCount === 1);
      await guardClient.query("COMMIT");
      return { component, state: "ready-not-activated", wholeAccountComplete: false };
    } catch (e) {
      await guardClient.query("ROLLBACK").catch(() => {});
      throw e;
    }
  });
}
