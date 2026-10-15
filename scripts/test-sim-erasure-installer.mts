/** Actual local PostgreSQL test of the same offline installer. No production
 * URL/secret is accepted; its private cluster is verified before every apply. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, statSync, readdirSync, symlinkSync, unlinkSync, rmdirSync } from "node:fs";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { provision, protectLegacyDeployment, postgresTlsEnvironment } from "./provision-sim-erasure-production.mjs";
import {
  configurationFingerprint,
  runtimeIdentityFingerprint,
  verifyRuntimeIdentity,
  verifyProductionDatabaseTransport
} from "../deploy/account-safety/database-erasure-guard.mjs";
import { loadDatabaseDriverOwnerComposition } from "../apps/situation-data-api/src/database-erasure.js";
import { loadDatabaseRouterGuard } from "../apps/ai-router-api/src/database-erasure.js";
import { PgAccountErasure } from "../apps/ai-router-api/src/account-erasure.js";
import { BudgetStore } from "../apps/ai-router-api/src/budget.js";
import { PgSeparateBilling } from "../apps/ai-router-api/src/separate-billing.js";
import { PostgresDriverAccountErasureStore } from "../apps/situation-data-api/src/driver-account-erasure-store.js";
import { PostgresDriverMeasurementStore } from "../apps/situation-data-api/src/driver-measurement-store.js";
import { driverErasureRequiredDays, prepareDriverErasureInput } from "../apps/situation-data-api/src/driver-account-erasure.js";
import { reportInventory } from "./driver-report-inventory.mjs";
assert.deepEqual(process.argv.slice(2), ["--run"]);
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pg = process.env.PG_BIN ?? execFileSync("pg_config", ["--bindir"], { encoding: "utf8" }).trim();
assert.match(execFileSync(resolve(pg, "postgres"), ["--version"], { encoding: "utf8" }), /PostgreSQL\) 18\./);
const root = mkdtempSync("/private/tmp/sim-erasure-installer-");
mkdirSync(root + "/socket", { mode: 0o700 });
const password = randomBytes(32).toString("hex"),
  pw = root + "/initial-password";
writeFileSync(pw, password, { mode: 0o600 });
const tcp = createServer();
await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", () => r()));
const port = (tcp.address() as any).port;
await new Promise<void>((r) => tcp.close(() => r()));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: "C", PGPASSWORD: password, PGPASSFILE: "/dev/null" };
const q = (db: string, sql: string) =>
  execFileSync(
    resolve(pg, "psql"),
    ["-X", "-w", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", db],
    { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env }
  ).trim();
const file = (name: string) => readFileSync(resolve(source, name), "utf8");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const secret = "synthetic-installer-hash-secret-at-least-32",
  actor = "synthetic-installer-actor-secret-at-least-32",
  issuer = "https://synthetic.example.invalid/realm";
const driverFp = runtimeIdentityFingerprint("sim_measurements", secret, actor, issuer),
  routerFp = runtimeIdentityFingerprint("ai_router", secret, actor, issuer);
const fingerprint = configurationFingerprint(driverFp, routerFp);
const envPath = root + "/production.env",
  manifestPath = root + "/reviewed.json";
const initial =
  [
    "DRIVER_MEASUREMENTS_HASH_SECRET=" + secret,
    "AI_ROUTER_USER_HASH_SECRET=" + secret,
    "DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET=" + actor,
    "AI_ROUTER_COP_ACTOR_SECRET=" + actor,
    "DRIVER_ACCOUNT_ERASURE_ISSUER=" + issuer,
    "AI_ROUTER_ACCOUNT_ERASURE_ISSUER=" + issuer,
    "UNRELATED_SENTINEL=synthetic-preserved"
  ].join("\n") + "\n";
writeFileSync(envPath, initial, { mode: 0o600 });
const binding = () => ({ storeId: randomUUID(), incarnationId: randomUUID(), checkpointId: randomUUID(), restoreGeneration: 1 });
const manifest = {
  contractVersion: "sim-erasure-production-enrollment-v2",
  guardStoreId: randomUUID(),
  configurationFingerprint: fingerprint,
  driverIdentityFingerprint: driverFp,
  routerIdentityFingerprint: routerFp,
  identityReviewed: true,
  identityReviewEvidenceDigest: hash("explicit synthetic fixture enrollment"),
  retentionPolicy: "driver-7-days-v1",
  costPolicy: "aggregate-costs-current-month-v1",
  driver: binding(),
  router: binding()
};
writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
const options = { synthetic: true, port, envPath, enrollmentPath: manifestPath, sourceRoot: source, psql: resolve(pg, "psql"), user: "postgres", password };
let started = false,
  passed = 0;
const check = (name: string, work: () => void) => {
  work();
  passed++;
  console.log("PASS " + name);
};
try {
  execFileSync(
    resolve(pg, "initdb"),
    ["-D", root + "/pg", "--username=postgres", "--auth-local=trust", "--auth-host=scram-sha-256", "--pwfile=" + pw, "--encoding=UTF8", "--locale=C"],
    { env, stdio: "pipe" }
  );
  rmSync(pw);
  execFileSync(
    resolve(pg, "pg_ctl"),
    [
      "-D",
      root + "/pg",
      "-l",
      root + "/server.log",
      "-o",
      `-k ${root}/socket -h 127.0.0.1 -p ${port} -c cluster_name=sim_erasure_installer_test -c log_statement=none -c log_min_error_statement=panic`,
      "-w",
      "start"
    ],
    { env, stdio: "pipe" }
  );
  started = true;
  assert.equal(q("postgres", "SELECT current_setting('data_directory')"), root + "/pg");
  for (const name of ["driver_measurements_migrator", "driver_measurements_runtime", "ai_router_migrator", "ai_router_runtime"])
    q("postgres", `CREATE ROLE ${name} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  q("postgres", "CREATE DATABASE cop_account_safety_guard");
  q("cop_account_safety_guard", "CREATE SCHEMA cop_guard;CREATE TABLE cop_guard.untouched(id integer);INSERT INTO cop_guard.untouched VALUES(7)");
  for (const [db, owner, runtime] of [
    ["sim_driver_measurements", "driver_measurements_migrator", "driver_measurements_runtime"],
    ["sim_ai_router", "ai_router_migrator", "ai_router_runtime"]
  ]) {
    q("postgres", `CREATE DATABASE ${db} OWNER ${owner}`);
    q(db, `REVOKE ALL ON SCHEMA public FROM PUBLIC;GRANT USAGE ON SCHEMA public TO ${runtime}`);
  }
  q("sim_driver_measurements", "SET ROLE driver_measurements_migrator;" + file("deploy/driver-measurements/schema.sql"));
  q(
    "sim_driver_measurements",
    "GRANT SELECT,INSERT,UPDATE,DELETE ON driver_measurement_receipts,driver_measurement_intervals,driver_measurement_eta,driver_measurement_revocations TO driver_measurements_runtime"
  );
  for (const path of ["001_schema.sql", "002_separate_billing.sql"]) q("sim_ai_router", "SET ROLE ai_router_migrator;" + file("deploy/ai-router/" + path));
  q("sim_ai_router", "GRANT SELECT,INSERT,UPDATE ON ai_router_request,ai_router_policy,ai_router_policy_audit TO ai_router_runtime");
  check("check is read-only and reports actual configuration fingerprints", () => {
    const result = provision({ ...options, mode: "check" });
    assert.equal(result.configurationFingerprint, fingerprint);
    assert.equal(result.driver.erasure, false);
    assert.equal(result.ai.erasure, false);
    assert.equal(readFileSync(envPath, "utf8"), initial);
    assert.equal(q("postgres", "SELECT count(*) FROM pg_roles WHERE rolname='sim_erasure_guard_owner'"), "0");
  });
  check("wrong reviewed configuration is rejected before env or database changes", () => {
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, configurationFingerprint: "f".repeat(64) }));
    assert.throws(() => provision({ ...options, mode: "apply" }), /REVIEWED_ENROLLMENT_REQUIRED/);
    assert.equal(readFileSync(envPath, "utf8"), initial);
    writeFileSync(manifestPath, JSON.stringify(manifest));
  });
  check("historical cross-owner ETA blocks preflight without repair", () => {
    const batch = randomUUID(),
      eta = randomUUID();
    q(
      "sim_driver_measurements",
      `INSERT INTO driver_measurement_receipts VALUES('cop','${batch}','${"a".repeat(64)}','${"b".repeat(64)}',now(),now()+interval '1 day','{}');INSERT INTO driver_measurement_eta VALUES('cop','${batch}','${eta}','${"c".repeat(64)}','synthetic',now(),10,11)`
    );
    assert.throws(() => provision({ ...options, mode: "apply" }), /TARGET_SCHEMA_REQUIRES_SEPARATE_REVIEW/);
    assert.equal(readFileSync(envPath, "utf8"), initial);
    assert.equal(q("sim_driver_measurements", `SELECT count(*) FROM driver_measurement_eta WHERE observation_id='${eta}'`), "1");
    q(
      "sim_driver_measurements",
      `DELETE FROM driver_measurement_eta WHERE observation_id='${eta}';DELETE FROM driver_measurement_receipts WHERE batch_id='${batch}'`
    );
  });
  check("actual installer applies migrations and enrolls with false flags", () => {
    const r = provision({ ...options, mode: "apply" });
    assert.equal(r.installed, true);
    assert.equal(r.erasureEnabled, false);
    assert.equal(r.driverPublicationVerified, false);
    assert.equal(r.servicesStarted, false);
    const text = readFileSync(envPath, "utf8");
    assert.ok(text.includes("UNRELATED_SENTINEL=synthetic-preserved"));
    assert.ok(text.includes('DRIVER_ACCOUNT_ERASURE_ENABLED="false"'));
    assert.ok(text.includes('AI_ROUTER_ACCOUNT_ERASURE_ENABLED="false"'));
    assert.equal(statSync(envPath).mode & 0o777, 0o600);
    for (const s of [password, secret, actor]) assert.ok(!JSON.stringify(r).includes(s));
  });
  check("same reviewed apply reuses secrets and does not rotate credentials", () => {
    const before = readFileSync(envPath, "utf8"),
      credentials = q(
        "postgres",
        "SELECT rolname,rolpassword FROM pg_authid WHERE rolname IN ('sim_measurements_guard_runtime','ai_router_guard_runtime') ORDER BY rolname"
      );
    provision({ ...options, mode: "apply" });
    assert.equal(readFileSync(envPath, "utf8"), before);
    assert.equal(
      q("postgres", "SELECT rolname,rolpassword FROM pg_authid WHERE rolname IN ('sim_measurements_guard_runtime','ai_router_guard_runtime') ORDER BY rolname"),
      credentials
    );
  });
  check("quarantine cannot be silently reenrolled or rewrite env", () => {
    q("cop_account_safety_guard", "UPDATE sim_erasure_guard_v2.owner_binding SET state='quarantined' WHERE owner='ai_router'");
    const before = readFileSync(envPath, "utf8");
    assert.throws(() => provision({ ...options, mode: "apply" }), /REFUSE_BINDING_REENROLLMENT_OR_QUARANTINE/);
    assert.equal(readFileSync(envPath, "utf8"), before);
    q("cop_account_safety_guard", "UPDATE sim_erasure_guard_v2.owner_binding SET state='ready' WHERE owner='ai_router'");
  });
  check("existing guard foundation and offline role isolation remain unchanged", () => {
    assert.equal(q("cop_account_safety_guard", "SELECT id FROM cop_guard.untouched"), "7");
    assert.equal(
      q(
        "postgres",
        "SELECT count(*) FROM pg_auth_members WHERE member IN(SELECT oid FROM pg_roles WHERE rolname IN ('sim_erasure_guard_owner','sim_measurements_guard_runtime','ai_router_guard_runtime'))"
      ),
      "0"
    );
    assert.equal(q("postgres", "SELECT rolcanlogin FROM pg_roles WHERE rolname='sim_erasure_guard_owner'"), "f");
  });
  check("changed actual user namespace key or actor issuer fails runtime identity check", () => {
    const pins = {
      SIM_ACCOUNT_ERASURE_DRIVER_IDENTITY_FINGERPRINT: driverFp,
      SIM_ACCOUNT_ERASURE_ROUTER_IDENTITY_FINGERPRINT: routerFp,
      SIM_ACCOUNT_ERASURE_CONFIGURATION_FINGERPRINT: fingerprint
    };
    verifyRuntimeIdentity("ai_router", secret, actor, issuer, pins);
    assert.throws(() => verifyRuntimeIdentity("ai_router", secret + "changed", actor, issuer, pins));
    assert.throws(() => verifyRuntimeIdentity("ai_router", secret, actor, issuer + "/foreign", pins));
  });
  check("legacy deployment protection preserves all existing local edits", () => {
    const original = "#!/usr/bin/env bash\nset -e\n# synthetic local operator customization\ngit pull --ff-only\n";
    const guarded = protectLegacyDeployment(original);
    assert.ok(guarded.indexOf("SIM_DATABASE_V2_DEPLOY_GUARD") < guarded.indexOf("git pull"));
    assert.ok(guarded.endsWith(original.slice(original.indexOf("\n") + 1)));
    assert.equal(protectLegacyDeployment(guarded), guarded);
  });
  check("production transport cannot inherit a TLS downgrade", () => {
    const effective = { PGSSLMODE: "disable", ...postgresTlsEnvironment(false, "/reviewed/public-ca.pem") };
    assert.equal(effective.PGSSLMODE, "verify-full");
    assert.equal(effective.PGSSLROOTCERT, "/reviewed/public-ca.pem");
    assert.equal(postgresTlsEnvironment(true, null).PGSSLMODE, "disable");
  });
  check("production factory rejects unverified transport or TLS bypass", () => {
    const env = { NODE_ENV: "production" },
      base =
        "postgresql://synthetic:synthetic@haproxy.home.cz:5000/cop_account_safety_guard?sslmode=verify-full&sslrootcert=%2Fetc%2Fcsm-sim%2Fpostgresql-ca.pem";
    verifyProductionDatabaseTransport(base, "cop_account_safety_guard", env);
    for (const bad of [
      base.replace("verify-full", "disable"),
      base.replace("verify-full", "require"),
      base.replace("haproxy.home.cz", "127.0.0.1"),
      base + "&sslmode=verify-full",
      base + "&uselibpqcompat=true",
      base.replace("postgresql-ca.pem", "other.pem")
    ])
      assert.throws(() => verifyProductionDatabaseTransport(bad, "cop_account_safety_guard", env));
    assert.throws(() => verifyProductionDatabaseTransport(base, "cop_account_safety_guard", { ...env, NODE_TLS_REJECT_UNAUTHORIZED: "0" }));
  });
  check("preparation Compose changes only reviewed images, DB environment and read-only public CA", () => {
    const syntheticEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SIM_API_ADMIN_TOKEN: "synthetic-compose-token-not-for-use",
      SIM_ERASURE_DRIVER_IMAGE: "sha256:" + "1".repeat(64),
      SIM_ERASURE_ROUTER_IMAGE: "sha256:" + "2".repeat(64),
      SIM_ERASURE_PG_ROOT_CERT_FILE: "/synthetic/public-ca.pem",
      DRIVER_MEASUREMENTS_DATABASE_URL: "postgresql://synthetic@haproxy.home.cz:5000/sim_driver_measurements?sslmode=verify-full",
      AI_ROUTER_DATABASE_URL: "postgresql://synthetic@haproxy.home.cz:5000/sim_ai_router?sslmode=verify-full",
      DRIVER_ERASURE_GUARD_DATABASE_URL: "postgresql://synthetic-driver@haproxy.home.cz:5000/cop_account_safety_guard?sslmode=verify-full",
      AI_ROUTER_ERASURE_GUARD_DATABASE_URL: "postgresql://synthetic-router@haproxy.home.cz:5000/cop_account_safety_guard?sslmode=verify-full",
      SIM_ACCOUNT_ERASURE_GUARD_STORE_ID: "synthetic-store",
      SIM_ACCOUNT_ERASURE_CONFIGURATION_FINGERPRINT: "a".repeat(64),
      SIM_ACCOUNT_ERASURE_DRIVER_IDENTITY_FINGERPRINT: "b".repeat(64),
      SIM_ACCOUNT_ERASURE_ROUTER_IDENTITY_FINGERPRINT: "c".repeat(64),
      DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET: "synthetic",
      DRIVER_ACCOUNT_ERASURE_ISSUER: "https://synthetic.invalid",
      DRIVER_ACCOUNT_ERASURE_REPLAY_CHECKPOINT: "synthetic",
      AI_ROUTER_ACCOUNT_ERASURE_ISSUER: "https://synthetic.invalid",
      AI_ROUTER_COP_ACTOR_SECRET: "synthetic"
    };
    const args = ["compose", "--profile", "*", "--env-file", "/dev/null", "-f", "docker-compose.yml"];
    const compose = (overlay: boolean) =>
      JSON.parse(
        execFileSync("docker", [...args, ...(overlay ? ["-f", "deploy/account-safety/database-v2.prepare.compose.yml"] : []), "config", "--format", "json"], {
          cwd: source,
          encoding: "utf8",
          env: syntheticEnv,
          stdio: ["ignore", "pipe", "pipe"]
        })
      );
    const base = compose(false),
      prepared = compose(true);
    for (const name of Object.keys(base.services))
      if (!["situation-data-api", "ai-router-api"].includes(name)) assert.deepEqual(prepared.services[name], base.services[name]);
    for (const [name, flag, key] of [
      ["situation-data-api", "DRIVER_ACCOUNT_ERASURE_ENABLED", "DRIVER_MEASUREMENTS_DATABASE_URL"],
      ["ai-router-api", "AI_ROUTER_ACCOUNT_ERASURE_ENABLED", "AI_ROUTER_DATABASE_URL"]
    ]) {
      const b = base.services[name],
        s = prepared.services[name];
      assert.equal(s.environment[flag], "false");
      assert.equal(s.environment[key], syntheticEnv[key]);
      assert.equal(s.pull_policy, "never");
      assert.deepEqual(s.networks, b.networks);
      assert.deepEqual(s.ports, b.ports);
      const ca = s.volumes.find((v: any) => v.target === "/etc/csm-sim/postgresql-ca.pem");
      assert.equal(ca.read_only, true);
      assert.equal(ca.bind.create_host_path, false);
      assert.deepEqual(
        s.volumes.filter((v: any) => v !== ca && v.target !== "/driver-measurement-reports"),
        b.volumes ?? []
      );
      const report = s.volumes.find((v: any) => v.target === "/driver-measurement-reports");
      if (name === "situation-data-api") {
        assert.equal(report.source, "/srv/x5-production/cache/csm-sim/driver-measurement-reports");
        assert.equal(report.bind.create_host_path, false);
      } else assert.equal(report, undefined);
    }
  });
  const installed = Object.fromEntries(
    readFileSync(envPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf("=");
        const raw = line.slice(at + 1);
        return [line.slice(0, at), raw.startsWith('"') ? JSON.parse(raw) : raw];
      })
  );
  const previous = { ...process.env };
  const { Pool } = createRequire(resolve(source, "apps/ai-router-api/package.json"))("pg");
  const runtimeUrl = (db: string, user: string) => `postgresql://${user}:${password}@127.0.0.1:${port}/${db}`;
  const targetPool = new Pool({ connectionString: runtimeUrl("sim_ai_router", "ai_router_runtime"), max: 2 });
  let dBinding: Awaited<ReturnType<typeof loadDatabaseDriverOwnerComposition>> | undefined,
    aBinding: Awaited<ReturnType<typeof loadDatabaseRouterGuard>> | undefined;
  try {
    Object.assign(process.env, installed, {
      NODE_ENV: "test",
      DRIVER_MEASUREMENTS_DATABASE_URL: runtimeUrl("sim_driver_measurements", "driver_measurements_runtime"),
      SIM_ACCOUNT_ERASURE_GUARD_DATABASE_URL: installed.DRIVER_ERASURE_GUARD_DATABASE_URL
    });
    dBinding = await loadDatabaseDriverOwnerComposition();
    assert.equal((await dBinding.driverMeasurements.databaseSafety!.driverProof()).publicationFenceVerified, false);
    process.env.SIM_ACCOUNT_ERASURE_GUARD_DATABASE_URL = installed.AI_ROUTER_ERASURE_GUARD_DATABASE_URL;
    aBinding = await loadDatabaseRouterGuard(targetPool);
    const safety = aBinding.safety;
    const eraser = new PgAccountErasure(targetPool, "aggregate-costs-current-month-v1", true, (cp) => safety.verifyRouterCheckpoint(cp), safety);
    const capability = await eraser.capability(false);
    assert.equal(capability.ready, false);
    assert.equal(capability.enabled, false);
    assert.equal(capability.checks.restoreCheckpointCurrent, true);
    process.env.AI_ROUTER_USER_HASH_SECRET = secret + "changed";
    await assert.rejects(() => loadDatabaseRouterGuard(targetPool));
    process.env.AI_ROUTER_USER_HASH_SECRET = secret;
    process.env.SIM_ACCOUNT_ERASURE_GUARD_DATABASE_URL = installed.DRIVER_ERASURE_GUARD_DATABASE_URL;
    process.env.DRIVER_MEASUREMENTS_HASH_SECRET = secret + "changed";
    await assert.rejects(() => loadDatabaseDriverOwnerComposition());
    passed++;
    console.log("PASS actual production factories accept enrolled databases and reject actual changed keys before serving");
  } finally {
    await dBinding?.close();
    await aBinding?.close();
    await targetPool.end();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
  // Real report publication and pg_dump/restore, retaining the independent
  // guard journal. No Root callbacks or substitute positive verifier.
  const reportDir = root + "/driver-report-files";
  mkdirSync(reportDir, { mode: 0o700 });
  mkdirSync(root + "/producer-fixtures", { mode: 0o700 });
  check("report producer inventory detects cron and blocks admission without changing env", () => {
    const cron = root + "/producer-fixtures/root-cron";
    writeFileSync(cron, "* * * * * curl http://synthetic/api/v1/internal/driver-measurements/v1/quality\n", { mode: 0o600 });
    const inv = reportInventory({ syntheticRoot: root });
    assert.equal(inv.producerMatches.length, 1);
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifest,
        reportPublication: { policy: "shared_generation_fence-v1", externalProducersReviewed: true, inventoryDigest: inv.inventoryDigest }
      })
    );
    const before = readFileSync(envPath, "utf8");
    assert.throws(() => provision({ ...options, mode: "apply" }), /REPORT_PRODUCER_INVENTORY_CHANGED_OR_ACTIVE/);
    assert.equal(readFileSync(envPath, "utf8"), before);
    unlinkSync(cron);
  });
  check("explicit reviewed real report inventory enrolls only shared-generation protection", () => {
    const inv = reportInventory({ syntheticRoot: root });
    assert.equal(inv.producerMatches.length, 0);
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifest,
        reportPublication: { policy: "shared_generation_fence-v1", externalProducersReviewed: true, inventoryDigest: inv.inventoryDigest }
      })
    );
    const r = provision({ ...options, mode: "apply" });
    assert.equal(r.driverPublicationVerified, true);
    assert.equal(r.erasureEnabled, false);
  });
  const savedEnv = { ...process.env };
  Object.assign(process.env, installed, {
    NODE_ENV: "test",
    DRIVER_MEASUREMENT_REPORTS_DIR: reportDir,
    DRIVER_MEASUREMENTS_DATABASE_URL: runtimeUrl("sim_driver_measurements", "driver_measurements_runtime"),
    SIM_ACCOUNT_ERASURE_GUARD_DATABASE_URL: installed.DRIVER_ERASURE_GUARD_DATABASE_URL
  });
  const driverRuntime = new Pool({ connectionString: runtimeUrl("sim_driver_measurements", "driver_measurements_runtime"), max: 4 });
  let bound = await loadDatabaseDriverOwnerComposition();
  const driver = bound.driverMeasurements.databaseSafety!;
  mkdirSync(reportDir + "/.publication-lock", { mode: 0o700 });
  await assert.rejects(() => loadDatabaseDriverOwnerComposition());
  assert.ok(readdirSync(reportDir).includes(".publication-lock"));
  rmdirSync(reportDir + "/.publication-lock");
  passed++;
  console.log("PASS leftover filesystem mutex refuses actual factory start and is never automatically stolen or expired");
  const erasureStore = new PostgresDriverAccountErasureStore(driverRuntime, secret, {
    enabled: true,
    expectedCheckpoint: manifest.driver.checkpointId,
    identityConfigured: true,
    protectedProof: () => driver.driverProof(),
    databaseSafety: driver
  });
  const measurementStore = new PostgresDriverMeasurementStore(runtimeUrl("sim_driver_measurements", "driver_measurements_runtime"), secret);
  const budget = new BudgetStore(runtimeUrl("sim_ai_router", "ai_router_runtime"), secret, {
    dailyMicrousd: 1000000,
    monthlyMicrousd: 10000000,
    perUserDailyRequests: 10
  });
  await budget.init();
  process.env.SIM_ACCOUNT_ERASURE_GUARD_DATABASE_URL = installed.AI_ROUTER_ERASURE_GUARD_DATABASE_URL;
  let routerBound = await loadDatabaseRouterGuard(budget.pool);
  const routerEraser = new PgAccountErasure(
    budget.pool,
    "aggregate-costs-current-month-v1",
    true,
    (cp) => routerBound.safety.verifyRouterCheckpoint(cp),
    routerBound.safety
  );
  const keys = new PgSeparateBilling(budget.pool, createHash("sha256").update("synthetic-report-restore-encryption").digest("base64"), routerEraser);
  const operationId = randomUUID(),
    days = driverErasureRequiredDays(Date.now());
  const input = prepareDriverErasureInput(
    {
      contractVersion: "sim-account-erasure-v1",
      operationId,
      attestation: "cop-account-erasure-contributors-reviewed-v1",
      contributors: days.map((day, i) => ({ contributorDay: day, contributorIdDay: hash("synthetic-restored-A-day-" + i) }))
    },
    { iss: issuer, sub: "synthetic-restore-A", aud: "sim-account-erasure", operationId, iat: 1, exp: 2, routerUserId: "cop_" + "A".repeat(43) },
    secret
  );
  const ah = input.contributors.at(-1)!.contributorHash,
    bh = hash("synthetic-preserved-B");
  const keyA = budget.hashUser("cop", "cop_" + "A".repeat(43)),
    keyB = budget.hashUser("cop", "cop_" + "B".repeat(43)),
    keySim = budget.hashUser("sim", "same-shared-person");
  const routerIdentity = { ownerHash: hash("synthetic-router-owner-A"), targetHash: keyA };
  let restoredDriver: Awaited<ReturnType<typeof loadDatabaseDriverOwnerComposition>> | undefined,
    restoredRouter: Awaited<ReturnType<typeof loadDatabaseRouterGuard>> | undefined,
    restoredBudget: BudgetStore | undefined;
  try {
    for (const h of [ah, bh])
      q(
        "sim_driver_measurements",
        `INSERT INTO driver_measurement_receipts VALUES('cop','${randomUUID()}','${h}','${"d".repeat(64)}',now(),now()+interval '7 days','{"acceptedIntervalCount":1}')`
      );
    for (const key of [keyA, keyB, keySim]) await keys.putKey(key, "sk-synthetic-restore-key-only-no-provider-contact");
    await driver.writeFileReport("quality", (lease) => measurementStore.quality(new Date().toISOString(), lease));
    const historicalReport = readFileSync(reportDir + "/quality.json");
    assert.equal(JSON.parse(historicalReport.toString()).retainedBatchCount, 2);
    for (const db of ["sim_driver_measurements", "sim_ai_router"])
      execFileSync(resolve(pg, "pg_dump"), ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-Fc", "-f", root + "/" + db + ".dump", db], {
        env,
        stdio: "pipe"
      });
    passed++;
    console.log("PASS actual report contains both contributors and real pre-erasure target snapshots are created");
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      hold = new Promise<void>((r) => (release = r));
    const writing = driver.writeFileReport("quality", async (lease) => {
      const result = await measurementStore.quality(new Date().toISOString(), lease);
      entered();
      await hold;
      return result;
    });
    await started;
    const releaseTimeout = setTimeout(() => release(), 6000);
    releaseTimeout.unref();
    let eraseDone = false;
    const erasing = erasureStore.erase(input).finally(() => {
      eraseDone = true;
    });
    void erasing.catch(() => {});
    let blocked = false;
    for (let i = 0; i < 100; i++) {
      if (
        Number(
          q("sim_driver_measurements", "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0")
        ) > 0
      ) {
        blocked = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(blocked, true);
    assert.equal(eraseDone, false);
    release();
    clearTimeout(releaseTimeout);
    await writing;
    await erasing;
    assert.deepEqual(readdirSync(reportDir), []);
    await driver.publicationBarrier(input);
    assert.equal((await erasureStore.acknowledge(input)).status, "completed");
    assert.equal(q("sim_driver_measurements", `SELECT count(*) FROM driver_measurement_receipts WHERE contributor_hash='${bh}'`), "1");
    passed++;
    console.log("PASS actual exporter lock blocks erasure until atomic publication then invalidates every old report before ACK");
    await assert.rejects(() => driver.publicationBarrier({ ...input, actorHash: "f".repeat(64) }));
    symlinkSync(root + "/sim_ai_router.dump", reportDir + "/bad-link");
    await assert.rejects(() => driver.publicationBarrier(input));
    unlinkSync(reportDir + "/bad-link");
    passed++;
    console.log("PASS wrong erasure identity and report symlink refuse publication acknowledgement");
    await driver.writeFileReport("quality", (lease) => measurementStore.quality(new Date().toISOString(), lease));
    assert.equal(JSON.parse(readFileSync(reportDir + "/quality.json", "utf8")).retainedBatchCount, 1);
    const inputC = {
      ...input,
      operationId: randomUUID(),
      actorHash: hash("synthetic-actor-C"),
      requestHash: hash("synthetic-request-C"),
      contributors: input.contributors.map((x, i) => ({ ...x, contributorHash: hash("synthetic-C-" + i) }))
    };
    const ch = inputC.contributors.at(-1)!.contributorHash,
      cpHash = createHmac("sha256", secret)
        .update("cop:account-erasure-checkpoint:" + manifest.driver.checkpointId)
        .digest("hex");
    q(
      "sim_driver_measurements",
      `BEGIN;SELECT set_config('sim.driver_erasure_context','driver-account-erasure-v1',true),set_config('sim.driver_erasure_checkpoint','${cpHash}',true);INSERT INTO driver_measurement_receipts VALUES('cop','${randomUUID()}','${ch}','${"e".repeat(64)}',now(),now()+interval '7 days','{}');COMMIT;`
    );
    let finishLost!: () => void, signalLost!: () => void;
    const materialized = new Promise<void>((r) => (signalLost = r)),
      holdLost = new Promise<void>((r) => (finishLost = r));
    const lostWrite = driver.writeFileReport("quality", async (lease) => {
      const value = await measurementStore.quality(new Date().toISOString(), lease);
      assert.equal((value as any).retainedBatchCount, 2);
      signalLost();
      await holdLost;
      return value;
    });
    void lostWrite.catch(() => {});
    await materialized;
    const lostTimer = setTimeout(() => finishLost(), 6000);
    lostTimer.unref();
    const publisherPid = q(
      "sim_driver_measurements",
      "SELECT pid FROM pg_locks WHERE locktype='advisory' AND classid=612031 AND objid=1 AND mode='ShareLock' AND granted"
    );
    assert.match(publisherPid, /^[0-9]+$/);
    assert.equal(q("postgres", `SELECT pg_terminate_backend(${publisherPid})`), "t");
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(() => erasureStore.erase(inputC));
    assert.ok(readdirSync(reportDir).includes(".publication-lock"));
    finishLost();
    clearTimeout(lostTimer);
    await assert.rejects(() => lostWrite);
    await erasureStore.erase(inputC);
    assert.equal((await erasureStore.acknowledge(inputC)).status, "completed");
    assert.deepEqual(readdirSync(reportDir), []);
    passed++;
    console.log("PASS actual publisher backend termination cannot release the filesystem interlock or acknowledge deletion before the old writer settles");
    await routerEraser.request(routerIdentity, randomUUID());
    await routerEraser.processPending();
    await assert.rejects(() => keys.getKey(keyA));
    assert.equal(q("sim_ai_router", `SELECT count(*) FROM ai_router_user_key WHERE user_hash='${keyA}'`), "0");
    assert.ok(await keys.getKey(keyB));
    assert.ok(await keys.getKey(keySim));
    await bound.close();
    await routerBound.close();
    await driverRuntime.end();
    await measurementStore.close();
    await budget.close();
    q("cop_account_safety_guard", "UPDATE sim_erasure_guard_v2.owner_binding SET state='quarantined'");
    for (const [db, owner] of [
      ["sim_driver_measurements", "driver_measurements_migrator"],
      ["sim_ai_router", "ai_router_migrator"]
    ]) {
      q("postgres", `DROP DATABASE ${db}`);
      q("postgres", `CREATE DATABASE ${db} OWNER ${owner}`);
      execFileSync(
        resolve(pg, "pg_restore"),
        ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "--exit-on-error", "-d", db, root + "/" + db + ".dump"],
        { env, stdio: "pipe" }
      );
    }
    writeFileSync(reportDir + "/quality.json", historicalReport, { mode: 0o600 });
    assert.equal(q("sim_driver_measurements", `SELECT count(*) FROM driver_measurement_receipts WHERE contributor_hash='${ah}'`), "1");
    process.env.SIM_ACCOUNT_ERASURE_GUARD_DATABASE_URL = installed.DRIVER_ERASURE_GUARD_DATABASE_URL;
    await assert.rejects(() => loadDatabaseDriverOwnerComposition());
    assert.equal(JSON.parse(readFileSync(reportDir + "/quality.json", "utf8")).retainedBatchCount, 2);
    passed++;
    console.log("PASS actual pg_restore resurrects A and historical report but quarantined factory refuses exposure");
    // Explicit synthetic restore administration, never runtime auto-enrollment.
    for (const [name, db, key] of [
      ["sim_measurements", "sim_driver_measurements", "driver"],
      ["ai_router", "sim_ai_router", "router"]
    ] as const) {
      const incarnation = randomUUID(),
        cp = randomUUID();
      q(
        "cop_account_safety_guard",
        `UPDATE sim_erasure_guard_v2.owner_binding SET incarnation_id='${incarnation}',checkpoint_id='${cp}',restore_generation=2,state='ready' WHERE owner='${name}'`
      );
      q(db, `UPDATE sim_erasure_dataset_binding SET incarnation_id='${incarnation}',checkpoint_id='${cp}',restore_generation=2`);
      if (key === "driver") {
        process.env.DRIVER_ACCOUNT_ERASURE_REPLAY_CHECKPOINT = cp;
        q(
          db,
          `UPDATE driver_account_erasure_state SET replay_checkpoint_hash='${createHmac("sha256", secret)
            .update("cop:account-erasure-checkpoint:" + cp)
            .digest("hex")}'`
        );
      } else q(db, `UPDATE ai_router_erasure_checkpoint SET checkpoint_id='${cp}',checkpoint_generation=2`);
    }
    // Current source identity fingerprints remain recomputed from the SAME
    // actual secrets; rotating namespace secrets would break historical replay.
    process.env.DRIVER_MEASUREMENTS_HASH_SECRET = secret + "wrong";
    await assert.rejects(() => loadDatabaseDriverOwnerComposition());
    process.env.DRIVER_MEASUREMENTS_HASH_SECRET = secret;
    restoredDriver = await loadDatabaseDriverOwnerComposition();
    assert.equal(q("sim_driver_measurements", `SELECT count(*) FROM driver_measurement_receipts WHERE contributor_hash='${ah}'`), "0");
    assert.equal(q("sim_driver_measurements", `SELECT count(*) FROM driver_measurement_receipts WHERE contributor_hash='${bh}'`), "1");
    assert.deepEqual(readdirSync(reportDir), []);
    restoredBudget = new BudgetStore(runtimeUrl("sim_ai_router", "ai_router_runtime"), secret, {
      dailyMicrousd: 1000000,
      monthlyMicrousd: 10000000,
      perUserDailyRequests: 10
    });
    await restoredBudget.init();
    process.env.SIM_ACCOUNT_ERASURE_GUARD_DATABASE_URL = installed.AI_ROUTER_ERASURE_GUARD_DATABASE_URL;
    restoredRouter = await loadDatabaseRouterGuard(restoredBudget.pool);
    const after = new PgAccountErasure(
      restoredBudget.pool,
      "aggregate-costs-current-month-v1",
      true,
      (cp) => restoredRouter!.safety.verifyRouterCheckpoint(cp),
      restoredRouter.safety
    );
    await after.processPending();
    const restoredKeys = new PgSeparateBilling(restoredBudget.pool, createHash("sha256").update("synthetic-report-restore-encryption").digest("base64"), after);
    await assert.rejects(() => restoredKeys.getKey(keyA));
    assert.equal(q("sim_ai_router", `SELECT count(*) FROM ai_router_user_key WHERE user_hash='${keyA}'`), "0");
    assert.ok(await restoredKeys.getKey(keyB));
    assert.ok(await restoredKeys.getKey(keySim));
    passed++;
    console.log(
      "PASS new generation and actual identity-bound factories replay independent guard after real restore; A is zero, B and SIM keys survive, old reports are gone"
    );
    const restoredStore = new PostgresDriverMeasurementStore(runtimeUrl("sim_driver_measurements", "driver_measurements_runtime"), secret, {
      databaseSafety: restoredDriver.driverMeasurements.databaseSafety,
      retentionConsumer: restoredDriver.driverMeasurements.retentionConsumer
    });
    try {
      await restoredStore.init();
      await restoredDriver.driverMeasurements.databaseSafety!.writeFileReport("quality", (lease) => restoredStore.quality(new Date().toISOString(), lease));
      await restoredStore.runRetentionOnce();
      assert.deepEqual(readdirSync(reportDir), []);
      await restoredDriver.driverMeasurements.databaseSafety!.writeFileReport("quality", (lease) => restoredStore.quality(new Date().toISOString(), lease));
      assert.equal(await restoredStore.revoke("cop", bh), 1);
      assert.deepEqual(readdirSync(reportDir), []);
    } finally {
      await restoredStore.close();
    }
    passed++;
    console.log("PASS actual accepted retention consumer and separate consent revocation invalidate cached reports under the same lock");
  } finally {
    await restoredDriver?.close();
    await restoredRouter?.close();
    await restoredBudget?.close();
    await bound.close().catch(() => {});
    await routerBound.close().catch(() => {});
    await driverRuntime.end().catch(() => {});
    await measurementStore.close().catch(() => {});
    await budget.close().catch(() => {});
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  }
  console.log(JSON.stringify({ passed, scope: "actual_isolated_postgresql_installer", productionChanged: false, servicesStarted: false, providerCalls: 0 }));
} finally {
  if (started) {
    assert.equal(realpathSync(root + "/pg"), root + "/pg");
    execFileSync(resolve(pg, "pg_ctl"), ["-D", root + "/pg", "-m", "fast", "-w", "stop"], { env, stdio: "pipe" });
  }
  assert.ok(root.startsWith("/private/tmp/sim-erasure-installer-"));
  rmSync(root, { recursive: true, force: true });
}
