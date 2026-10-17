/** Additive fresh-install step under the existing bounded Root admission.
 * No CLI, connection, role, secret, restart, epoch reset or independent authority. */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { completedReplayEnabled } from "../../packages/clean-lifecycle/completed-replay.mjs";
import { userDataCatalog } from "./sim-user-data-profile.mjs";
import { withResetWork } from "./clean-reset-admission.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const sha = b => createHash("sha256").update(b).digest("hex");
const need = (v, code="SIM_COMPLETED_REPLAY_INSTALL_REFUSED") => { if (!v) throw Error(code); };
export const COMPLETED_REPLAY_PROFILE_SHA = "51d197e30097efc07798a692de1939d46aee3a203ab446d1e67ff901cc2e7352";
const paths = ["deploy/clean-lifecycle/009_completed_content_replay.sql", "deploy/sim-user-data/006_completed_content_replay.sql"];
export async function verifiedCompletedReplayProfile(mode) {
  if (!completedReplayEnabled(mode)) return undefined;
  const raw = await readFile(join(root, "deploy/sim-user-data/completed-replay-profile-v1.json"));
  need(sha(raw) === COMPLETED_REPLAY_PROFILE_SHA);
  const profile = JSON.parse(raw), texts = [];
  need(profile.contractVersion === "sim-completed-content-replay-profile-v1" && profile.mode === mode);
  need(profile.baseManifestSha256 === "9f71d113ba47a7880fca6a7df76f7fefbca401c1791acb57f86969c1fdaed76e");
  need(Object.keys(profile.pins).sort().join("|") === paths.slice().sort().join("|"));
  for (const path of paths) {
    const bytes = await readFile(join(root, path));
    need(sha(bytes) === profile.pins[path]);
    texts.push(bytes.toString("utf8").replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, ""));
  }
  return { profile, texts };
}
export async function verifyCompletedReplayCatalog(client, verified) {
  need(verified?.profile);
  const actual = await userDataCatalog(client, "sim_user_history");
  need(actual.baseCatalogDigest === verified.profile.aiPostCatalogDigest && actual.digest === verified.profile.aiUserDataCatalogDigest, "SIM_COMPLETED_REPLAY_UNKNOWN_CATALOG");
  return actual;
}
export async function inspectCompletedReplayProfile(client, verified) {
  const actual = await verifyCompletedReplayCatalog(client, verified);
  const n = Number((await client.query("SELECT(SELECT count(*) FROM sim_clean.account)+(SELECT count(*) FROM sim_clean.job)+(SELECT count(*) FROM sim_user_history.account)+(SELECT count(*) FROM sim_user_history.job) n")).rows[0].n);
  need(n === 0, "SIM_COMPLETED_REPLAY_INSTALL_NOT_UNUSED");
  return { state: "known-new-unused", ...actual, completedReplayProfileSha256: COMPLETED_REPLAY_PROFILE_SHA };
}
export async function installCompletedReplay({ client, mode, baseManifest, rootGate, assertWritersStopped, resetEpoch }) {
  const verified = await verifiedCompletedReplayProfile(mode);
  need(verified && typeof assertWritersStopped === "function");
  return withResetWork(rootGate, { contractVersion: verified.profile.contractVersion, profileSha256: COMPLETED_REPLAY_PROFILE_SHA, resetEpoch }, async (admission, assertOpen) => {
    await admission.assertCurrent(); await assertWritersStopped(); assertOpen();
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL lock_timeout='1500ms';SET LOCAL statement_timeout='10000ms';SET LOCAL search_path=public,pg_catalog");
      await client.query("LOCK TABLE public.ai_router_request,public.ai_router_billing_request,public.ai_router_user_key_audit,sim_clean.config,sim_clean.account,sim_clean.job,sim_user_history.config,sim_user_history.account,sim_user_history.job IN ACCESS EXCLUSIVE MODE");
      const identity = (await client.query("SELECT current_user u,current_database() d")).rows[0];
      need(identity.u === "ai_router_migrator" && identity.d === "sim_ai_router");
      const before = await userDataCatalog(client, "sim_user_history");
      need(before.baseCatalogDigest === baseManifest.aiPostCatalogDigest && before.digest === baseManifest.aiUserDataCatalogDigest, "SIM_COMPLETED_REPLAY_UNKNOWN_BASE");
      const config = (await client.query("SELECT c.reset_epoch,c.mode,h.reset_epoch history_epoch,h.mode history_mode FROM sim_clean.config c CROSS JOIN sim_user_history.config h WHERE c.singleton AND h.singleton")).rows[0];
      need(config?.mode === "production-clean-lifecycle-v1" && config.history_mode === "production-sim-user-data-v1" && config.reset_epoch === resetEpoch && config.history_epoch === resetEpoch);
      need(Number((await client.query("SELECT(SELECT count(*) FROM sim_clean.account)+(SELECT count(*) FROM sim_clean.job)+(SELECT count(*) FROM sim_user_history.account)+(SELECT count(*) FROM sim_user_history.job) n")).rows[0].n) === 0);
      for (const text of verified.texts) await client.query(text);
      const result = await inspectCompletedReplayProfile(client, verified);
      await assertWritersStopped(); await admission.assertCurrent(); assertOpen();
      await client.query("COMMIT"); return result;
    } catch (e) { await client.query("ROLLBACK").catch(()=>{}); throw e; }
  });
}
