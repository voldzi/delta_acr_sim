/** Own Unix-only synthetic PG18.3; never accepts a DB URL or remote target. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, chmod } from "node:fs/promises";
import { statSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCOPES, catalog, dataSnapshot, transitionOwnedFixture, stoppedWriters, inspectPlan, applyReset } from "./lib/clean-reset-ops.mjs";
import { exerciseBootstrap } from "./test-clean-bootstrap.mjs";
const arg = process.argv[2];
if (process.argv.length !== 3 || !["--compile-profiles", "--run"].includes(arg)) throw new Error("Only owned local fixture modes accepted");
const source = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  bin = "/opt/homebrew/opt/postgresql@18/bin";
const { Pool } = createRequire(join(source, "apps/ai-router-api/package.json"))("pg"),
  execute = promisify(execFile);
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"].includes(k)));
assert.match((await execute(join(bin, "postgres"), ["--version"], { env })).stdout, /PostgreSQL\) 18\.3/);
const priorUmask = process.umask(0o077),
  root = await mkdtemp("/private/tmp/sim-clean-reset-pg-");
await chmod(root, 0o700);
await mkdir(join(root, "s"), { mode: 0o700 });
const owned = () => {
  assert.equal(dirname(realpathSync(root)), "/private/tmp");
  assert.equal(statSync(root).uid, process.getuid());
  assert.equal(statSync(root).mode & 0o777, 0o700);
};
const pools = [];
const pool = (db, user) => {
  const p = new Pool({ host: join(root, "s"), database: db, user, connectionTimeoutMillis: 2000, statement_timeout: 10000 });
  pools.push(p);
  return p;
};
let started = false,
  passed = false,
  checks = 0;
const check = (x, m) => {
    assert.ok(x, m);
    checks++;
  },
  sha = (x) => createHash("sha256").update(x).digest("hex"),
  h = (n) => n.toString(16).padStart(64, "0");
const profiles = { version: "sim-clean-reset-manifest-v1", baseSourceRevision: "6238345b8e50a67441043b2e732e1516254f5f27", pins: {}, ai: {}, driver: {} };
const persisted = {};
const migrationNames = [...new Set([...SCOPES.ai.migrations, ...SCOPES.driver.migrations])];
for (const name of migrationNames) profiles.pins[name] = sha(await readFile(join(source, "deploy/clean-lifecycle", name), "utf8"));
const migrations = async (lane) =>
  Promise.all(
    SCOPES[lane].migrations.map(async (name) =>
      (await readFile(join(source, "deploy/clean-lifecycle", name), "utf8")).replace(/^BEGIN;\r?$/m, "").replace(/^COMMIT;\s*$/m, "")
    )
  );
const safeEnv = (e) => ({
  environmentId: randomUUID(),
  resetEpoch: randomUUID(),
  userDatasetId: randomUUID(),
  enrollmentId: randomUUID(),
  tokensNotBefore: Math.floor(Date.now() / 1000) - 60,
  ...e
});
const fixtureImages = { "csm-sim-ai-router-api": "sha256:" + "a".repeat(64), "csm-sim-situation-data-api": "sha256:" + "b".repeat(64) };
const receipt = () =>
  stoppedWriters(
    async (name) => ({ Name: "/" + name, Id: "c".repeat(64), Image: fixtureImages[name], State: { Running: false, Restarting: false, Status: "exited" } }),
    fixtureImages
  );
const gate = { withResetAdmission: async (_context, work) => work({ assertCurrent: async () => {} }) };
try {
  owned();
  await execute(join(bin, "initdb"), ["-D", join(root, "db"), "-U", "fixture_admin", "--auth-local=trust", "--auth-host=reject", "--no-locale"], { env });
  await execute(
    join(bin, "pg_ctl"),
    ["-D", join(root, "db"), "-l", join(root, "pg.log"), "-o", `-k ${join(root, "s")} -c listen_addresses=''`, "-w", "start"],
    { env }
  );
  started = true;
  const admin = pool("postgres", "fixture_admin");
  const identity = (await admin.query("SELECT current_setting('data_directory') AS d,current_setting('listen_addresses') AS l,inet_server_addr() AS a"))
    .rows[0];
  assert.equal(identity.d, join(root, "db"));
  assert.equal(identity.l, "");
  assert.equal(identity.a, null);
  await admin.query(
    "CREATE ROLE ai_router_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;CREATE ROLE ai_router_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;CREATE ROLE driver_measurements_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;CREATE ROLE driver_measurements_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE"
  );
  for (const lane of ["ai", "driver"]) {
    const s = SCOPES[lane];
    await admin.query(`CREATE DATABASE ${s.database} OWNER ${s.owner}`);
    const p = pool(s.database, s.owner),
      c = await p.connect();
    try {
      for (const file of lane === "ai"
        ? ["deploy/ai-router/001_schema.sql", "deploy/ai-router/002_separate_billing.sql"]
        : ["deploy/driver-measurements/schema.sql"])
        await c.query(await readFile(join(source, file), "utf8"));
      await c.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
      if (lane === "ai")
        await c.query(
          "GRANT USAGE ON SCHEMA public TO ai_router_runtime; GRANT SELECT,INSERT,UPDATE ON ai_router_request,ai_router_policy,ai_router_policy_audit TO ai_router_runtime;GRANT USAGE,SELECT ON SEQUENCE ai_router_policy_audit_id_seq TO ai_router_runtime"
        );
      else
        await c.query(
          "GRANT USAGE ON SCHEMA public TO driver_measurements_runtime;GRANT SELECT,INSERT,UPDATE,DELETE ON driver_measurement_receipts,driver_measurement_intervals,driver_measurement_eta,driver_measurement_revocations TO driver_measurements_runtime"
        );
      await c.query(
        await readFile(join(source, lane === "ai" ? "deploy/ai-router/003_account_erasure.sql" : "deploy/driver-measurements/002_account_erasure.sql"), "utf8")
      );
      if (lane === "driver") await c.query(await readFile(join(source, "deploy/driver-measurements/008_eta_contributor_binding_database_v2.sql"), "utf8"));
      await c.query("SET search_path=pg_catalog");
      profiles[lane].oldDigest = (await catalog(c, lane)).digest;
      profiles[lane].oldCatalog = (await catalog(c, lane)).value;
      if (lane === "ai") {
        await c.query("SELECT set_config('sim.router_erasure_code_version','1',false)");
        for (let i = 0; i < 3; i++)
          await c.query(
            "INSERT INTO public.ai_router_request(id,client_id,user_hash,task_type,model,routing_reason,difficulty,status,reserved_microusd,charged_microusd) VALUES($1,'sim',$2,'sim_scenario','preserve','fixture','simple','success',5,5)",
            [randomUUID(), h(100 + i)]
          );
        await c.query(
          "INSERT INTO public.ai_router_request(id,client_id,user_hash,task_type,model,routing_reason,difficulty,status,reserved_microusd,charged_microusd) VALUES($1,'cop',$2,'cop_chat','fixture','fixture','simple','success',5,5)",
          [randomUUID(), h(1)]
        );
        await c.query("INSERT INTO public.ai_router_policy VALUES(1,false,false,1000000,10000000,10,now())");
        await c.query(
          "INSERT INTO public.ai_router_policy_audit(external_allowed,advanced_allowed,daily_microusd,monthly_microusd,per_user_daily_requests) VALUES(false,false,1000000,10000000,10)"
        );
      } else {
        await c.query("INSERT INTO public.driver_measurement_receipts VALUES('cop',$1,$2,$3,now(),now()+interval '7 days','{}')", [randomUUID(), h(1), h(2)]);
        await c.query("INSERT INTO public.driver_measurement_revocations VALUES('cop',$1,now()+interval '7 days')", [h(3)]);
      }
      const enrollment = safeEnv();
      const before = await dataSnapshot(c, lane);
      if (arg === "--compile-profiles") {
        await c.query("BEGIN");
        await c.query(`LOCK TABLE ${s.tables.map((t) => "public." + t).join(",")} IN ACCESS EXCLUSIVE MODE`);
        await transitionOwnedFixture(c, lane, enrollment, await migrations(lane));
        profiles[lane].newDigest = (await catalog(c, lane)).digest;
        profiles[lane].newCatalog = (await catalog(c, lane)).value;
        check(JSON.stringify((await dataSnapshot(c, lane)).preserve) === JSON.stringify(before.preserve), "compiler preserve");
        await c.query("COMMIT");
      } else {
        const frozen = JSON.parse(await readFile(join(source, "deploy/clean-lifecycle/reset-manifest-v1.json"), "utf8"));
        assert.equal(profiles[lane].oldDigest, frozen[lane].oldDigest, "old manifest must derive from independently pinned source");
        const plan = await inspectPlan(c, lane, frozen);
        check(plan.state === "known-old", "known-old recognized");
        const options = {
          manifest: frozen,
          pins: frozen.pins,
          reviewedPlan: plan,
          expectedPlanDigest: plan.planDigest,
          writerReceipt: await receipt(),
          enrollment,
          rootGate: gate
        };
        await assert.rejects(applyReset(c, lane, { ...options, writerReceipt: {} }), /RESET_REVIEW_OR_GATE_REQUIRED/);
        checks++;
        await assert.rejects(applyReset(c, lane, { ...options, expectedPlanDigest: "0".repeat(64) }), /RESET_REVIEW_OR_GATE_REQUIRED/);
        checks++;
        await assert.rejects(applyReset(c, lane, { ...options, reviewedPlan: { ...plan, lane: "foreign" } }), /RESET_PLAN_DIGEST_MISMATCH/);
        checks++;
        await assert.rejects(
          applyReset(c, lane, { ...options, rootGate: { withResetAdmission: async () => ({ state: "transitioned" }) } }),
          /RESET_ADMISSION_DID_NOT_COMPLETE_WORK/
        );
        checks++;
        const early = {
          withResetAdmission: async (_context, work) => {
            void work({ assertCurrent: async () => {} }).catch(() => {});
            return { state: "transitioned" };
          }
        };
        await assert.rejects(applyReset(c, lane, { ...options, rootGate: early }), /RESET_ADMISSION_CLOSED/);
        checks++;
        check((await catalog(c, lane)).digest === frozen[lane].oldDigest, "early gate cannot commit DDL");
        const tg = (
          await c.query(
            "SELECT pg_get_triggerdef(t.oid,true) AS def,t.tgname,c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE t.tgname=$1",
            [lane === "ai" ? "ai_router_request_erasure_fence" : "driver_account_erasure_receipt_guard"]
          )
        ).rows[0];
        await c.query(`DROP TRIGGER ${tg.tgname} ON public.${tg.relname}`);
        const missing = await inspectPlan(c, lane);
        check(missing.state === "blocked-unknown", "missing old guard is not success");
        await assert.rejects(
          applyReset(c, lane, { ...options, reviewedPlan: missing, expectedPlanDigest: missing.planDigest }),
          /RESET_REVIEW_OR_GATE_REQUIRED/
        );
        checks++;
        await c.query(tg.def);
        const functionName = lane === "ai" ? "ai_router_cop_erasure_fence" : "driver_account_erasure_receipt_guard";
        const originalFunction = (await c.query("SELECT pg_get_functiondef($1::regprocedure) AS def", ["public." + functionName + "()"])).rows[0].def;
        await c.query(`CREATE OR REPLACE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
        check((await inspectPlan(c, lane)).state === "blocked-unknown", "same trigger name with altered body rejected");
        await c.query(originalFunction);
        await c.query("CREATE FUNCTION public.reset_fixture_unknown() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$");
        await c.query(
          `CREATE TRIGGER reset_fixture_unknown BEFORE INSERT ON public.${s.userTables[0]} FOR EACH ROW EXECUTE FUNCTION public.reset_fixture_unknown()`
        );
        check((await inspectPlan(c, lane)).state === "blocked-unknown", "unknown/shared guard rejected");
        await c.query(`DROP TRIGGER reset_fixture_unknown ON public.${s.userTables[0]};DROP FUNCTION public.reset_fixture_unknown()`);
        if (lane === "ai")
          await c.query("INSERT INTO public.ai_router_account_erasure(operation_id,owner_hash,target_hash,body_digest) VALUES($1,$2,$3,$4)", [
            randomUUID(),
            h(10),
            h(11),
            h(12)
          ]);
        else
          await c.query("INSERT INTO public.driver_account_erasure_operations(operation_hash,actor_hash,request_hash,contributor_count) VALUES($1,$2,$3,9)", [
            h(10),
            h(11),
            h(12)
          ]);
        const legacy = await inspectPlan(c, lane);
        await assert.rejects(
          applyReset(c, lane, { ...options, reviewedPlan: legacy, expectedPlanDigest: legacy.planDigest }),
          /RESET_NONZERO_LEGACY_OR_FOREIGN_SCOPE/
        );
        checks++;
        await c.query(`DELETE FROM public.${s.legacy[0]}`);
        if (lane === "ai") {
          const foreign = randomUUID();
          await c.query(
            "INSERT INTO public.ai_router_billing_request(id,billing_source,payer_hash,actor_hash,credential_fingerprint,task_type,model,status,reserved_microusd) VALUES($1,'sim_project',$2,$3,'synthetic','cop_chat','fixture','success',0)",
            [foreign, h(20), h(21)]
          );
          const foreignPlan = await inspectPlan(c, lane);
          await assert.rejects(
            applyReset(c, lane, { ...options, reviewedPlan: foreignPlan, expectedPlanDigest: foreignPlan.planDigest }),
            /RESET_NONZERO_LEGACY_OR_FOREIGN_SCOPE/
          );
          checks++;
          await c.query("DELETE FROM public.ai_router_billing_request WHERE id=$1", [foreign]);
        }
        check((await catalog(c, lane)).digest === frozen[lane].oldDigest, "negative fixtures restore exact reviewed metadata");
        const rp = pool(s.database, s.runtime);
        await rp.query("SELECT 1");
        await assert.rejects(applyReset(c, lane, options), /RESET_DATABASE_WRITER_PRESENT/);
        checks++;
        await rp.end();
        const failureGate = {
          withResetAdmission: async (_context, work) => {
            let seen = 0;
            return work({
              assertCurrent: async () => {
                if (++seen === 2) throw new Error("SYNTHETIC_ADMISSION_LOST");
              }
            });
          }
        };
        await assert.rejects(applyReset(c, lane, { ...options, rootGate: failureGate }), /SYNTHETIC_ADMISSION_LOST/);
        checks++;
        check((await catalog(c, lane)).digest === frozen[lane].oldDigest, "failed cutover rolled back every guard");
        check(JSON.stringify(await dataSnapshot(c, lane)) === JSON.stringify(before), "failed cutover rolled back data");
        let lateWriter;
        const reappeared = {
          withResetAdmission: async (_context, work) => {
            let seen = 0;
            return work({
              assertCurrent: async () => {
                if (++seen === 2) {
                  lateWriter = pool(s.database, s.runtime);
                  await lateWriter.query("SELECT 1");
                }
              }
            });
          }
        };
        await assert.rejects(applyReset(c, lane, { ...options, rootGate: reappeared }), /RESET_DATABASE_WRITER_REAPPEARED/);
        checks++;
        await lateWriter.end();
        check((await catalog(c, lane)).digest === frozen[lane].oldDigest, "late writer rolls back guard replacement");
        const applied = await applyReset(c, lane, options);
        check(applied.state === "transitioned", "known-old atomically replaced");
        check(applied.wholeAccountComplete === false, "not a whole-service receipt");
        check((await catalog(c, lane)).digest === frozen[lane].newDigest, "exact new catalog");
        check(JSON.stringify((await dataSnapshot(c, lane)).preserve) === JSON.stringify(before.preserve), "three other rows and config remain byte-consistent");
        const newPlan = await inspectPlan(c, lane, frozen);
        const again = await applyReset(c, lane, { ...options, reviewedPlan: newPlan, expectedPlanDigest: newPlan.planDigest });
        check(again.state === "already-new", "exact new idempotent retry");
        const wrong = safeEnv();
        await assert.rejects(
          applyReset(c, lane, { ...options, reviewedPlan: newPlan, expectedPlanDigest: newPlan.planDigest, enrollment: wrong }),
          /RESET_ENROLLMENT_MISMATCH/
        );
        checks++;
        const business = pool(s.database, s.runtime),
          params = new URLSearchParams({ host: join(root, "s"), port: "5432", user: s.runtime });
        checks += await exerciseBootstrap({
          lane,
          url: "postgresql:///" + s.database + "?" + params.toString(),
          expected: { lane, mode: "production-clean-lifecycle-v1", ...enrollment },
          root,
          runtime: business
        });
        await business.end();
        const used = await inspectPlan(c, lane);
        await assert.rejects(applyReset(c, lane, { ...options, reviewedPlan: used, expectedPlanDigest: used.planDigest }), /RESET_NEW_DATASET_ALREADY_USED/);
        checks++;
      }
      if (arg === "--run") persisted[lane] = await dataSnapshot(c, lane);
    } finally {
      c.release();
    }
  }
  if (arg === "--run") {
    for (const p of pools) if (!p.ended && !p.ending) await p.end();
    owned();
    await execute(join(bin, "pg_ctl"), ["-D", join(root, "db"), "-m", "fast", "-w", "stop"], { env });
    started = false;
    await execute(
      join(bin, "pg_ctl"),
      ["-D", join(root, "db"), "-l", join(root, "pg.log"), "-o", `-k ${join(root, "s")} -c listen_addresses=''`, "-w", "start"],
      { env }
    );
    started = true;
    const frozen = JSON.parse(await readFile(join(source, "deploy/clean-lifecycle/reset-manifest-v1.json"), "utf8"));
    for (const lane of ["ai", "driver"]) {
      const p = pool(SCOPES[lane].database, SCOPES[lane].owner),
        c = await p.connect();
      try {
        check((await catalog(c, lane)).digest === frozen[lane].newDigest, "new guard catalog survives actual PostgreSQL restart");
        check(JSON.stringify(await dataSnapshot(c, lane)) === JSON.stringify(persisted[lane]), "actual post-business data and preserved rows survive restart");
      } finally {
        c.release();
      }
    }
  }
  passed = true;
  if (arg === "--compile-profiles") {
    for (const lane of ["ai", "driver"]) {
      for (const kind of ["old", "new"]) {
        const cat = profiles[lane][kind + "Catalog"];
        profiles[lane][kind + "Tables"] = Object.fromEntries(cat.tables.map((t) => [t.name, sha(JSON.stringify(t))]));
        profiles[lane][kind + "Functions"] = [...new Set(cat.tables.flatMap((t) => (t.triggers ?? []).map((x) => x.function + ":" + x.functionSha)))];
        delete profiles[lane][kind + "Catalog"];
      }
    }
    console.log(JSON.stringify(profiles));
  } else
    console.log(
      JSON.stringify({
        contractVersion: "sim-clean-reset-ops-v1",
        checks,
        transport: "owned-unix-only",
        actualDatabaseRestarts: 1,
        productionWrites: 0,
        realRootAdmission: false
      })
    );
} finally {
  for (const p of pools) if (!p.ended && !p.ending) await p.end().catch(() => {});
  if (started) {
    owned();
    await execute(join(bin, "pg_ctl"), ["-D", join(root, "db"), "-m", "fast", "-w", "stop"], { env });
  }
  if (passed) {
    owned();
    await rm(root, { recursive: true });
  }
  process.umask(priorUmask);
}
