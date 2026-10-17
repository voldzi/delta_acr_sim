/** Whole concrete installer against OWNED Unix PG18.3; no host/production target. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, chmod, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { catalog } from "./lib/clean-reset-ops.mjs";
import { userDataCatalog } from "./lib/sim-user-data-profile.mjs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runSimUserInstall, privateSimRuntimeConfiguration } from "./lib/sim-user-data-private-install.mjs";
import { runtimeIdentityFingerprint } from "../packages/sim-user-data/bootstrap.mjs";
import { transitionOwnedFixture, sourceMigrations, readResetManifest } from "./lib/clean-reset-ops.mjs";
assert.equal(process.argv.length, 3);
assert.ok(["--run", "--run-completed-replay", "--compile-completed-profile"].includes(process.argv[2]));
const source = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  bin = "/opt/homebrew/opt/postgresql@18/bin",
  exec = promisify(execFile);
const { Pool } = createRequire(join(source, "apps/ai-router-api/package.json"))("pg");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG"].includes(k)));
assert.match((await exec(join(bin, "postgres"), ["--version"], { env })).stdout, /PostgreSQL\) 18\.3/);
const root = await mkdtemp("/private/tmp/sim-user-install-pg-");
await chmod(root, 0o700);
await mkdir(join(root, "s"), { mode: 0o700 });
let started = false,
  passed = false,
  checks = 0,
  admin,
  ai;
const check = (v, label) => {
  assert.ok(v, label);
  checks++;
};
const credentials = Object.fromEntries(
  ["sim_user_data_migrator", "sim_user_data_runtime", "sim_user_data_guard_runtime", "sim_user_history_guard_runtime"].map((k) => [
    k,
    randomBytes(32).toString("base64url")
  ])
);
const secret = () => randomBytes(32).toString("base64url");
try {
  await exec(join(bin, "initdb"), ["-D", join(root, "db"), "-U", "fixture_admin", "--auth-local=trust", "--auth-host=reject", "--no-locale"], { env });
  await writeFile(join(root, "db/pg_hba.conf"), "local all fixture_admin trust\nlocal all all scram-sha-256\n", { mode: 0o600 });
  await exec(join(bin, "pg_ctl"), ["-D", join(root, "db"), "-l", join(root, "pg.log"), "-o", `-k ${join(root, "s")} -c listen_addresses=''`, "-w", "start"], {
    env
  });
  started = true;
  const conn = (database) => ({ host: join(root, "s"), database, user: "fixture_admin" });
  admin = new Pool(conn("postgres"));
  await admin.query(
    "CREATE ROLE ai_router_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;CREATE ROLE ai_router_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE"
  );
  await admin.query("CREATE DATABASE sim_ai_router OWNER ai_router_migrator");
  await admin.query("CREATE DATABASE cop_account_safety_guard");
  ai = new Pool(conn("sim_ai_router"));
  const c = await ai.connect();
  const resetEpoch = randomUUID(),
    environmentId = randomUUID(),
    tokensNotBefore = Math.floor(Date.now() / 1000) - 120;
  try {
    await c.query("SET ROLE ai_router_migrator");
    for (const file of ["deploy/ai-router/001_schema.sql", "deploy/ai-router/002_separate_billing.sql"])
      await c.query(await readFile(join(source, file), "utf8"));
    await c.query(
      "REVOKE CREATE ON SCHEMA public FROM PUBLIC;GRANT USAGE ON SCHEMA public TO ai_router_runtime;GRANT SELECT,INSERT,UPDATE ON ai_router_request,ai_router_policy,ai_router_policy_audit TO ai_router_runtime;GRANT USAGE,SELECT ON SEQUENCE ai_router_policy_audit_id_seq TO ai_router_runtime"
    );
    await c.query(await readFile(join(source, "deploy/ai-router/003_account_erasure.sql"), "utf8"));
    await c.query("SELECT set_config('sim.router_erasure_code_version','1',false)");
    await c.query(
      "INSERT INTO ai_router_request(id,client_id,user_hash,task_type,model,routing_reason,difficulty,status,reserved_microusd,charged_microusd) VALUES($1,'sim',$2,'sim_scenario','synthetic','synthetic','simple','success',7,7)",
      [randomUUID(), "a".repeat(64)]
    );
    const old = await readResetManifest();
    await c.query("BEGIN");
    await transitionOwnedFixture(
      c,
      "ai",
      { environmentId, resetEpoch, tokensNotBefore, userDatasetId: randomUUID(), enrollmentId: randomUUID() },
      await sourceMigrations("ai", old.pins)
    );
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  const manifest = JSON.parse(await readFile(join(source, "deploy/sim-user-data/reset-manifest-v2.json"), "utf8"));
  const routerActor = secret(),
    issuer = "https://cop-erasure-keycloak.invalid/realms/cop";
  const identities = {
    sim_user_data: { ownerSecret: secret(), actorSecret: secret(), routerActorSecret: routerActor, issuer },
    sim_user_history: { hashSecret: secret(), actorSecret: routerActor, issuer }
  };
  const guard_store_id = randomUUID(),
    bindings = Object.fromEntries(
      Object.keys(identities).map((component) => [
        component,
        {
          guard_store_id,
          target_store_id: randomUUID(),
          incarnation_id: randomUUID(),
          environment_id: environmentId,
          reset_epoch: resetEpoch,
          checkpoint_id: randomUUID(),
          restore_generation: "1",
          source_sha256: manifest.authoritySourceSha256,
          identity_sha256: runtimeIdentityFingerprint(component, identities[component])
        }
      ])
    );
  const config = {
    contractVersion: "sim-user-private-install-v1",
    profile: "owned-isolated-pg-v1",
    phase: "inspect",
    manifest,
    resetEpoch,
    tokensNotBefore,
    connections: { admin: conn("postgres"), ai: conn("sim_ai_router"), guard: conn("cop_account_safety_guard") },
    credentials,
    serviceToken: secret(),
    identities,
    bindings
  };
  if (process.argv[2] === "--run-completed-replay") config.completedReplayMode = "same-epoch-completed-content-replay-v1";
  let begins = 0,
    stops = 0,
    expectedPlan;
  const rootGate = {
    async withResetAdmission(context, work) {
      begins++;
      check(
        context.planDigest === expectedPlan.planDigest && context.resetEpoch === resetEpoch && context.tokensNotBefore === tokensNotBefore,
        "Root context binds plan/epoch/cutoff"
      );
      return work({ async assertCurrent() {} });
    }
  };
  const assertWritersStopped = async () => {
    stops++;
  };
  const plan = await runSimUserInstall(config, { Pool, rootGate, assertWritersStopped });
  const staged = privateSimRuntimeConfiguration(config, secret());
  if (config.completedReplayMode) {
    check(staged.environment["sim-api"].SIM_USER_DATA_COMPLETED_REPLAY_MODE === config.completedReplayMode, "main actual staging mode");
    check(staged.environment["ai-router-api"].SIM_USER_HISTORY_COMPLETED_REPLAY_MODE === config.completedReplayMode, "history actual staging mode");
    check(staged.environment["ai-router-api"].SIM_CLEAN_COMPLETED_REPLAY_MODE === config.completedReplayMode && staged.environment["situation-data-api"].SIM_CLEAN_COMPLETED_REPLAY_MODE === config.completedReplayMode, "base lane staging modes");
  }
  check(
    staged.environment["sim-api"].SIM_USER_DATA_ENABLED === "false" &&
      staged.environment["ai-router-api"].SIM_USER_HISTORY_ENABLED === "false" &&
      staged.environment["situation-data-api"].SIM_USER_DATA_RELAY_ENABLED === "false",
    "runtime staging flags all disabled"
  );
  check(!JSON.stringify(staged).includes(credentials.sim_user_data_migrator), "migration password excluded from runtime secrets");
  check(staged.readonlyCaMount.read_only === true && staged.readonlyCaMount.target === "/etc/csm-sim/postgresql-ca.pem", "exact readonly runtime CA mount");
  const targetUri = new URL(staged.environment["sim-api"].SIM_USER_DATA_DATABASE_URL);
  check(
    targetUri.hostname === "haproxy.home.cz" && targetUri.port === "5000" && targetUri.searchParams.get("sslmode") === "verify-full",
    "runtime database follows hostname-verified HAProxy route"
  );
  expectedPlan = plan;
  check(plan.facts.roles.length === 0 && plan.facts.databases.length === 0, "plan sees exact absent new objects");
  check(!Object.values(credentials).some((x) => JSON.stringify(plan).includes(x)), "no credential in plan");
  await assert.rejects(() =>
    runSimUserInstall({ ...config, phase: "apply", reviewedPlan: { ...plan, planDigest: "0".repeat(64) } }, { Pool, rootGate, assertWritersStopped })
  );
  check(true, "tampered Root plan denied before DDL");
  const before = begins,
    result = await runSimUserInstall({ ...config, phase: "apply", reviewedPlan: plan }, { Pool, rootGate, assertWritersStopped });
  check(begins === before + 1, "one real outer lease; no nested RPC begin");
  check(stops > 4, "stopped writers checked through entire install");
  check(
    Object.keys(result.components).length === 2 && Object.values(result.components).every((x) => x.actualRestrictedAuthority && x.unused),
    "both real limited-role authorities ready"
  );
  check(result.wholeAccountComplete === false, "installer not whole-account acceptance");
  if (config.completedReplayMode) check(result.completedReplayProfileSha256 === "51d197e30097efc07798a692de1939d46aee3a203ab446d1e67ff901cc2e7352", "actual bounded apply verifies separate full new catalog profile");
  check(!Object.values(credentials).some((x) => JSON.stringify(result).includes(x)), "no credential in result");
  check(Number((await ai.query("SELECT count(*) n FROM public.ai_router_request WHERE client_id='sim'")).rows[0].n) === 0, "legacy SIM rows removed");
  check(Number((await ai.query("SELECT sum(microusd) n FROM sim_user_history.cost_daily")).rows[0].n) === 7, "anonymous financial sum preserved");
  const runtime = new Pool({ host: join(root, "s"), database: "sim_user_data", user: "sim_user_data_runtime", password: credentials.sim_user_data_runtime });
  try {
    check((await runtime.query("SELECT current_user u")).rows[0].u === "sim_user_data_runtime", "actual SCRAM runtime login");
    await assert.rejects(() => runtime.query("CREATE TABLE public.forbidden(id int)"));
    check(true, "runtime DDL refused");
  } finally {
    await runtime.end();
  }
  const fresh = await runSimUserInstall({ ...config, phase: "readback", reviewedPlan: plan }, { Pool, rootGate, assertWritersStopped });
  check(fresh.components.sim_user_history.unused, "separate fresh full readback");
  if (config.completedReplayMode) {
    const c = await ai.connect();
    try {
      await c.query("SET ROLE ai_router_migrator");
      await c.query("CREATE POLICY unreviewed_completed_policy ON public.ai_router_request FOR DELETE TO ai_router_runtime USING(true)");
      await assert.rejects(() => runSimUserInstall({ ...config, phase: "readback", reviewedPlan: plan }, { Pool, rootGate, assertWritersStopped }), /UNKNOWN_CATALOG/); checks++;
      await c.query("DROP POLICY unreviewed_completed_policy ON public.ai_router_request");
    } finally { c.release(); }
  }
  await assert.rejects(() => runSimUserInstall({ ...config, phase: "apply", reviewedPlan: plan }, { Pool, rootGate, assertWritersStopped }));
  check(true, "second apply cannot replace new epoch/objects");
  const log = await readFile(join(root, "pg.log"), "utf8");
  check(!Object.values(credentials).some((x) => log.includes(x)), "actual PostgreSQL log contains no generated password");
  if (process.argv[2] === "--compile-completed-profile") {
    const migrationPaths = ["deploy/clean-lifecycle/009_completed_content_replay.sql", "deploy/sim-user-data/006_completed_content_replay.sql"];
    const pins = {}, c = await ai.connect();
    try {
      await c.query("SET ROLE ai_router_migrator");
      for (const path of migrationPaths) {
        const bytes = await readFile(join(source, path));
        pins[path] = createHash("sha256").update(bytes).digest("hex");
        await c.query(bytes.toString("utf8"));
      }
      console.log(JSON.stringify({ contractVersion: "sim-completed-content-replay-profile-v1", mode: "same-epoch-completed-content-replay-v1", pins, aiPostCatalogDigest: (await catalog(c, "ai")).digest, aiUserDataCatalogDigest: (await userDataCatalog(c, "sim_user_history")).digest, baseManifestSha256: "9f71d113ba47a7880fca6a7df76f7fefbca401c1791acb57f86969c1fdaed76e", productionWrites: 0 }));
    } finally { c.release(); }
  } else {
  console.log(
    JSON.stringify({
      contractVersion: "sim-user-private-install-v1",
      checks,
      actualPostgres: true,
      actualScramLogin: true,
      completedReplayMode: config.completedReplayMode ?? "disabled",
      realRootAdmission: false,
      productionWrites: 0,
      wholeAccountComplete: false
    })
  );
  }
  passed = true;
} finally {
  await ai?.end();
  await admin?.end();
  if (started) await exec(join(bin, "pg_ctl"), ["-D", join(root, "db"), "-m", "fast", "-w", "stop"], { env });
  if (passed) await rm(root, { recursive: true, force: true });
}
