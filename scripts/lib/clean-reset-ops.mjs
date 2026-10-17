import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha = (x) => createHash("sha256").update(x).digest("hex");
export const RESET_VERSION = "sim-clean-reset-ops-v1";
export const BASE_SOURCE = "6238345b8e50a67441043b2e732e1516254f5f27";
export const RESET_MANIFEST_SHA = "de4548fad17c1bc978d91951f59ec5bd8648b2711f5d168f517efe332aedd09d";
export async function readResetManifest() {
  const text = await readFile(join(root, "deploy/clean-lifecycle/reset-manifest-v1.json"), "utf8");
  if (sha(text) !== RESET_MANIFEST_SHA) throw new Error("RESET_MANIFEST_DIGEST_MISMATCH");
  return JSON.parse(text);
}
export const SCOPES = Object.freeze({
  ai: {
    database: "sim_ai_router",
    owner: "ai_router_migrator",
    runtime: "ai_router_runtime",
    tables: [
      "ai_router_request",
      "ai_router_user_key",
      "ai_router_user_key_audit",
      "ai_router_billing_request",
      "ai_router_policy",
      "ai_router_policy_audit",
      "ai_router_account_erasure",
      "ai_router_erasure_checkpoint",
      "ai_router_erased_cost_daily"
    ],
    userTables: ["ai_router_request", "ai_router_user_key", "ai_router_user_key_audit", "ai_router_billing_request"],
    legacy: ["ai_router_account_erasure"],
    deletes: [
      ["ai_router_request", "client_id='cop'"],
      ["ai_router_user_key", "true"],
      ["ai_router_user_key_audit", "true"],
      ["ai_router_billing_request", "task_type='cop_chat'"]
    ],
    preserve: [
      ["ai_router_request", "client_id<>'cop'"],
      ["ai_router_billing_request", "task_type<>'cop_chat'"],
      ["ai_router_policy", "true"],
      ["ai_router_policy_audit", "true"],
      ["ai_router_erasure_checkpoint", "true"],
      ["ai_router_erased_cost_daily", "true"]
    ],
    migrations: [
      "001_clean_lifecycle.sql",
      "002_ai_budget_views.sql",
      "007_replace_known_ai_guards.sql",
      "005_ai_writer_fences.sql",
      "003_ai_runtime_grants.sql"
    ]
  },
  driver: {
    database: "sim_driver_measurements",
    owner: "driver_measurements_migrator",
    runtime: "driver_measurements_runtime",
    tables: [
      "driver_measurement_receipts",
      "driver_measurement_intervals",
      "driver_measurement_eta",
      "driver_measurement_revocations",
      "driver_account_erasure_operations",
      "driver_account_erasure_revocations",
      "driver_account_erasure_state"
    ],
    userTables: ["driver_measurement_receipts", "driver_measurement_intervals", "driver_measurement_eta", "driver_measurement_revocations"],
    legacy: ["driver_account_erasure_operations", "driver_account_erasure_revocations"],
    deletes: [
      ["driver_measurement_eta", "true"],
      ["driver_measurement_intervals", "true"],
      ["driver_measurement_receipts", "true"],
      ["driver_measurement_revocations", "true"]
    ],
    preserve: [["driver_account_erasure_state", "true"]],
    migrations: ["001_clean_lifecycle.sql", "008_replace_known_driver_guard.sql", "006_driver_writer_fences.sql", "004_driver_runtime_grants.sql"]
  }
});
const scope = (lane) => {
  if (!Object.hasOwn(SCOPES, lane)) throw new Error("RESET_LANE_INVALID");
  return SCOPES[lane];
};
export async function catalog(c, lane) {
  const s = scope(lane);
  await c.query("SET search_path=pg_catalog");
  const query = await c.query(
    `SELECT jsonb_build_object(
  'database',current_database(),
  'roles',(SELECT jsonb_agg(jsonb_build_object('name',rolname,'super',rolsuper,'createDb',rolcreatedb,'createRole',rolcreaterole,'bypass',rolbypassrls,'replication',rolreplication) ORDER BY rolname) FROM pg_roles WHERE rolname=ANY($2::text[])),
  'tables',(SELECT jsonb_agg(jsonb_build_object('schema',ns.nspname,'name',r.relname,'owner',pg_get_userbyid(r.relowner),'rls',r.relrowsecurity,'forceRls',r.relforcerowsecurity,'acl',r.relacl::text,
    'columns',(SELECT jsonb_agg(jsonb_build_object('n',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'def',pg_get_constraintdef(k.oid,true),'valid',k.convalidated) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=r.oid),
    'indexes',(SELECT jsonb_agg(jsonb_build_object('def',pg_get_indexdef(i.indexrelid,0,true),'valid',i.indisvalid,'ready',i.indisready) ORDER BY pg_get_indexdef(i.indexrelid,0,true)) FROM pg_index i WHERE i.indrelid=r.oid),
    'rules',(SELECT jsonb_agg(pg_get_ruledef(w.oid,true) ORDER BY w.rulename) FROM pg_rewrite w WHERE w.ev_class=r.oid),
    'policies',(SELECT jsonb_agg(jsonb_build_object('name',p.polname,'cmd',p.polcmd,'roles',(SELECT jsonb_agg(pg_get_userbyid(x) ORDER BY pg_get_userbyid(x)) FROM unnest(p.polroles) x),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname) FROM pg_policy p WHERE p.polrelid=r.oid),
    'triggers',(SELECT jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'def',pg_get_triggerdef(t.oid,true),'function',n.nspname||'.'||p.proname,'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'functionSha',encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')) ORDER BY t.tgname) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace WHERE t.tgrelid=r.oid AND NOT t.tgisinternal)) ORDER BY r.relname)
    FROM pg_class r JOIN pg_namespace ns ON ns.oid=r.relnamespace WHERE ((ns.nspname='public' AND r.relname=ANY($1::text[])) OR ns.nspname='sim_clean') AND r.relkind='r'),
  'guardFunctions',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'owner',pg_get_userbyid(p.proowner),'definer',p.prosecdef,'acl',p.proacl::text,'sha',encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')) ORDER BY n.nspname,p.proname,p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='sim_clean' OR (n.nspname='public' AND p.proname=ANY($3::text[]))),
  'eventTriggers',(SELECT count(*) FROM pg_event_trigger),
  'foreignReferences',(SELECT count(*) FROM pg_constraint k JOIN pg_class parent ON parent.oid=k.confrelid JOIN pg_namespace pn ON pn.oid=parent.relnamespace JOIN pg_class child ON child.oid=k.conrelid JOIN pg_namespace cn ON cn.oid=child.relnamespace WHERE k.contype='f' AND pn.nspname='public' AND parent.relname=ANY($1::text[]) AND (cn.nspname<>'public' OR NOT child.relname=ANY($1::text[])))
 ) AS descriptor`,
    [
      s.tables,
      [s.owner, s.runtime],
      lane === "ai"
        ? ["ai_router_cop_erasure_fence", "ai_router_erasure_delete_scope", "ai_router_erasure_operation_immutable"]
        : ["driver_account_erasure_receipt_guard"]
    ]
  );
  const value = query.rows[0].descriptor;
  return { value, digest: sha(JSON.stringify(value)) };
}
export async function dataSnapshot(c, lane) {
  const s = scope(lane),
    out = { deleteCounts: {}, preserve: {}, legacyCounts: {} };
  for (const [table, where] of s.deletes)
    out.deleteCounts[table] = Number((await c.query(`SELECT count(*) AS n FROM public.${table} WHERE ${where}`)).rows[0].n);
  for (const [table, where] of s.preserve) {
    // Hash on the DB server; no row, subject, key, prompt or raw GPS leaves SQL.
    const q = await c.query(
      `SELECT count(*)::integer AS count,encode(sha256(convert_to(COALESCE(string_agg(h,'' ORDER BY h),''),'UTF8')),'hex') AS digest FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') h FROM public.${table} t WHERE ${where}) protected`
    );
    out.preserve[table] = q.rows[0];
  }
  for (const table of s.legacy) out.legacyCounts[table] = Number((await c.query(`SELECT count(*) AS n FROM public.${table}`)).rows[0].n);
  if ((await c.query("SELECT to_regclass('sim_erasure_guard_v2.tombstone') IS NOT NULL AS present")).rows[0].present)
    out.legacyCounts["sim_erasure_guard_v2.tombstone"] = Number((await c.query("SELECT count(*) AS n FROM sim_erasure_guard_v2.tombstone")).rows[0].n);
  if (lane === "ai")
    out.foreignBilling = Number(
      (
        await c.query(
          "SELECT count(*) AS n FROM public.ai_router_billing_request WHERE task_type='cop_chat' AND (billing_source<>'user_openai_key' OR actor_hash<>payer_hash)"
        )
      ).rows[0].n
    );
  return out;
}
export async function sourceMigrations(lane, pins) {
  const s = scope(lane),
    files = [];
  for (const name of s.migrations) {
    const text = await readFile(join(root, "deploy/clean-lifecycle", name), "utf8");
    if (pins[name] !== sha(text)) throw new Error("RESET_SOURCE_DIGEST_MISMATCH");
    files.push(text.replace(/^BEGIN;\r?$/m, "").replace(/^COMMIT;\s*$/m, ""));
  }
  return files;
}
export async function transitionOwnedFixture(c, lane, enrollment, migrations) {
  // Low-level transaction body shared with the OWNED fixture profile compiler.
  // No CLI exposes this function and it never opens a DB, secret file or SSH.
  const s = scope(lane);
  for (const [table, where] of s.deletes) await c.query(`DELETE FROM public.${table} WHERE ${where}`);
  await c.query("SET LOCAL search_path=pg_catalog,public");
  for (const text of migrations) await c.query(text);
  await c.query("SELECT sim_clean.enroll_production($1,$2,$3,$4,$5,$6)", [
    enrollment.environmentId,
    enrollment.resetEpoch,
    enrollment.userDatasetId,
    enrollment.enrollmentId,
    enrollment.tokensNotBefore,
    lane
  ]);
}
const receipts = new WeakSet();
export function requireStoppedWriters(receipt) {
  if (!receipts.has(receipt)) throw new Error("RESET_WRITERS_RECEIPT_REQUIRED");
}
export async function stoppedWriters(readInspect, expectedImages) {
  const names = ["csm-sim-ai-router-api", "csm-sim-situation-data-api"];
  const items = [];
  for (const name of names) {
    const x = await readInspect(name);
    if (
      x.Name !== "/" + name ||
      x.State?.Running !== false ||
      x.State?.Restarting !== false ||
      x.State?.Status !== "exited" ||
      !/^sha256:[a-f0-9]{64}$/.test(x.Image ?? "") ||
      x.Image !== expectedImages[name] ||
      !/^[a-f0-9]{64}$/.test(x.Id ?? "")
    )
      throw new Error("RESET_WRITERS_NOT_STOPPED");
    items.push(Object.freeze({ name, id: x.Id, image: x.Image }));
  }
  const r = Object.freeze({ contractVersion: RESET_VERSION, items: Object.freeze(items) });
  receipts.add(r);
  return r;
}
export async function inspectPlan(c, lane) {
  const manifest = await readResetManifest();
  const s = scope(lane);
  await c.query("BEGIN READ ONLY");
  try {
    await c.query("SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='5000ms'");
    const cat = await catalog(c, lane);
    const data = await dataSnapshot(c, lane);
    const state = cat.digest === manifest[lane].oldDigest ? "known-old" : cat.digest === manifest[lane].newDigest ? "known-new" : "blocked-unknown";
    const value = {
      contractVersion: RESET_VERSION,
      baseSourceRevision: BASE_SOURCE,
      lane,
      database: s.database,
      catalogDigest: cat.digest,
      state,
      data,
      manifestDigest: sha(JSON.stringify(manifest))
    };
    return { ...value, planDigest: sha(JSON.stringify(value)) };
  } finally {
    await c.query("ROLLBACK");
  }
}
export async function applyReset(c, lane, { reviewedPlan, expectedPlanDigest, writerReceipt, enrollment, rootGate }) {
  const s = scope(lane);
  const manifest = await readResetManifest(),
    pins = manifest.pins;
  const { planDigest, ...unsigned } = reviewedPlan;
  if (sha(JSON.stringify(unsigned)) !== planDigest) throw new Error("RESET_PLAN_DIGEST_MISMATCH");
  if (
    !receipts.has(writerReceipt) ||
    typeof rootGate?.withResetAdmission !== "function" ||
    reviewedPlan.planDigest !== expectedPlanDigest ||
    reviewedPlan.lane !== lane ||
    reviewedPlan.state === "blocked-unknown"
  )
    throw new Error("RESET_REVIEW_OR_GATE_REQUIRED");
  const migrations = await sourceMigrations(lane, pins);
  let gateOpen = true,
    flight,
    gateResult,
    gateFailure;
  try {
    gateResult = await rootGate.withResetAdmission(
      Object.freeze({ contractVersion: RESET_VERSION, lane, planDigest: expectedPlanDigest, manifestSha: RESET_MANIFEST_SHA, enrollment, writerReceipt }),
      (admission) => {
        if (!gateOpen || flight) throw new Error("RESET_ADMISSION_CALLBACK_INVALID");
        flight = (async () => {
          if (typeof admission?.assertCurrent !== "function") throw new Error("RESET_LIVE_ADMISSION_REQUIRED");
          await admission.assertCurrent();
          await c.query("BEGIN");
          let success = false;
          try {
            await c.query(
              "SET LOCAL search_path=pg_catalog; SET LOCAL lock_timeout='1500ms'; SET LOCAL statement_timeout='10000ms'; SET LOCAL row_security=off"
            );
            const identity = (await c.query("SELECT current_database() AS db,current_user AS role")).rows[0];
            if (identity.db !== s.database || identity.role !== s.owner) throw new Error("RESET_OWNER_OR_DATABASE_MISMATCH");
            await c.query("SELECT pg_stat_clear_snapshot()");
            const clients = Number(
              (
                await c.query(
                  "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND usename=ANY($1::text[])",
                  [[s.runtime, s.owner]]
                )
              ).rows[0].n
            );
            if (clients !== 0) throw new Error("RESET_DATABASE_WRITER_PRESENT");
            await c.query(`LOCK TABLE ${s.tables.map((t) => "public." + t).join(",")} IN ACCESS EXCLUSIVE MODE`);
            const before = await catalog(c, lane),
              data = await dataSnapshot(c, lane);
            if (
              before.digest !== reviewedPlan.catalogDigest ||
              JSON.stringify(data) !== JSON.stringify(reviewedPlan.data) ||
              reviewedPlan.manifestDigest !== sha(JSON.stringify(manifest))
            )
              throw new Error("RESET_PLAN_DRIFT");
            if (Object.values(data.legacyCounts).some((n) => n !== 0) || data.foreignBilling > 0) throw new Error("RESET_NONZERO_LEGACY_OR_FOREIGN_SCOPE");
            let result;
            if (before.digest === manifest[lane].oldDigest) {
              await transitionOwnedFixture(c, lane, enrollment, migrations);
              result = "transitioned";
            } else if (before.digest === manifest[lane].newDigest) {
              if (Object.values(data.deleteCounts).some((n) => n !== 0)) throw new Error("RESET_NEW_DATASET_ALREADY_USED");
              result = "already-new";
            } else throw new Error("RESET_UNKNOWN_CATALOG");
            const after = await catalog(c, lane),
              readback = await dataSnapshot(c, lane);
            if (
              after.digest !== manifest[lane].newDigest ||
              Object.values(readback.deleteCounts).some((n) => n !== 0) ||
              JSON.stringify(readback.preserve) !== JSON.stringify(data.preserve) ||
              Object.values(readback.legacyCounts).some((n) => n !== 0)
            )
              throw new Error("RESET_POSTCONDITION_FAILED");
            const cfg = (await c.query("SELECT * FROM sim_clean.config WHERE singleton")).rows[0],
              proof = (await c.query("SELECT * FROM sim_clean.production_enrollment WHERE singleton")).rows[0];
            if (
              cfg.mode !== "production-clean-lifecycle-v1" ||
              cfg.environment_id !== enrollment.environmentId ||
              cfg.reset_epoch !== enrollment.resetEpoch ||
              Number(cfg.tokens_not_before) !== enrollment.tokensNotBefore ||
              proof.user_dataset_id !== enrollment.userDatasetId ||
              proof.enrollment_id !== enrollment.enrollmentId
            )
              throw new Error("RESET_ENROLLMENT_MISMATCH");
            if (
              Number(
                (
                  await c.query(
                    "SELECT (SELECT count(*) FROM sim_clean.account)+(SELECT count(*) FROM sim_clean.resource)+(SELECT count(*) FROM sim_clean.job) AS n"
                  )
                ).rows[0].n
              ) !== 0
            )
              throw new Error("RESET_NEW_DATASET_ALREADY_USED");
            await admission.assertCurrent();
            if (!gateOpen) throw new Error("RESET_ADMISSION_CLOSED");
            await c.query("SELECT pg_stat_clear_snapshot()");
            if (
              Number(
                (
                  await c.query(
                    "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND usename=ANY($1::text[])",
                    [[s.runtime, s.owner]]
                  )
                ).rows[0].n
              ) !== 0
            )
              throw new Error("RESET_DATABASE_WRITER_REAPPEARED");
            await c.query("COMMIT");
            success = true;
            return {
              contractVersion: RESET_VERSION,
              lane,
              state: result,
              mode: cfg.mode,
              catalogDigest: after.digest,
              resetEpoch: cfg.reset_epoch,
              userDatasetId: proof.user_dataset_id,
              deletedCounts: data.deleteCounts,
              preserved: readback.preserve,
              legacyCounts: readback.legacyCounts,
              wholeAccountComplete: false
            };
          } finally {
            if (!success) await c.query("ROLLBACK").catch(() => {});
          }
        })();
        void flight.catch(() => {});
        return flight;
      }
    );
  } catch (error) {
    gateFailure = error;
  } finally {
    gateOpen = false;
  }
  let result, workFailure;
  if (flight)
    try {
      result = await flight;
    } catch (error) {
      workFailure = error;
    }
  if (gateFailure || workFailure) throw gateFailure ?? workFailure;
  if (!result || result !== gateResult) throw new Error("RESET_ADMISSION_DID_NOT_COMPLETE_WORK");
  return result;
}
