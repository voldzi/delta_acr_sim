/** Actual local PostgreSQL test of the same offline installer. No production
 * URL/secret is accepted; its private cluster is verified before every apply. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, statSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
        s.volumes.filter((v: any) => v !== ca),
        b.volumes ?? []
      );
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
  console.log(JSON.stringify({ passed, scope: "actual_isolated_postgresql_installer", productionChanged: false, servicesStarted: false, providerCalls: 0 }));
} finally {
  if (started) {
    assert.equal(realpathSync(root + "/pg"), root + "/pg");
    execFileSync(resolve(pg, "pg_ctl"), ["-D", root + "/pg", "-m", "fast", "-w", "stop"], { env, stdio: "pipe" });
  }
  assert.ok(root.startsWith("/private/tmp/sim-erasure-installer-"));
  rmSync(root, { recursive: true, force: true });
}
