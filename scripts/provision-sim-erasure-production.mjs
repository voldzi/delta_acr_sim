/** Offline administration, not runtime authority. No secret is printed. */
import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, chmodSync, chownSync, unlinkSync, realpathSync } from "node:fs";
import { createHash, randomBytes, pbkdf2Sync, createHmac } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configurationFingerprint, runtimeIdentityFingerprint } from "../deploy/account-safety/database-erasure-guard.mjs";
import { reportInventory } from "./driver-report-inventory.mjs";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const need = (v, code) => {
  if (!v) throw new Error(code);
};
const literal = (v) => "'" + String(v).replaceAll("'", "''") + "'";
const identifier = (v) => {
  need(/^[a-z_][a-z0-9_]*$/.test(v), "UNEXPECTED_ROLE_NAME");
  return '"' + v + '"';
};
const sha = (v) => createHash("sha256").update(v).digest("hex");
const PINS = {
  "deploy/driver-measurements/002_account_erasure.sql": "f13db2106a1fe1a02d0d1a26afa8ad7d7c045172ba4419749719ed0f166e16ad",
  "deploy/driver-measurements/008_eta_contributor_binding_database_v2.sql": "4a156baee81ded14d01b9ce261cca82a4f835905d32f91418fc8f67038b3f185",
  "deploy/ai-router/003_account_erasure.sql": "921e19e1bae334bb3ae84dadfc9ab4b9cd333b4f515e77a3a286b68649426a56",
  "deploy/account-safety/010_sim_database_safety_v2.sql": "c7865609b4ccb88b220026f5a5844cfcdd9e492a6dbdf1da50471f062b95c3fa",
  "deploy/account-safety/011_sim_target_binding.sql": "fbd9e8230e8b2ef3bcbbc20bf023e3828fd004dd57f3042d6a210b286f5244ac"
};
export function protectLegacyDeployment(text) {
  if (text.includes("# SIM_DATABASE_V2_DEPLOY_GUARD")) return text;
  need(text.startsWith("#!/"), "EXPECTED_LEGACY_DEPLOY_SCRIPT");
  const at = text.indexOf("\n") + 1;
  const guard = `# SIM_DATABASE_V2_DEPLOY_GUARD\nif [ -f /srv/sim/.env ] && grep -Eq '^SIM_ACCOUNT_ERASURE_AUTHORITY_MODE="?database_v2"?$' /srv/sim/.env; then\n  printf 'DBv2 is enrolled; legacy environment rewrite is disabled. Use the coordinated release.\\n' >&2\n  exit 1\nfi\n`;
  return text.slice(0, at) + guard + text.slice(at);
}
export function postgresTlsEnvironment(synthetic, rootCert) {
  return synthetic ? { PGSSLMODE: "disable" } : { PGSSLMODE: "verify-full", PGSSLROOTCERT: rootCert, PGGSSENCMODE: "disable" };
}
function selectedEnv(text, key) {
  const lines = text.split(/\r?\n/).filter((x) => x.startsWith(key + "="));
  if (!lines.length) return "";
  let value = lines
    .at(-1)
    .slice(key.length + 1)
    .trim();
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error("INVALID_SELECTED_ENV_QUOTING");
    }
  }
  if (value.startsWith("'")) {
    need(value.endsWith("'"), "INVALID_SELECTED_ENV_QUOTING");
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/, "").trim();
}
function scram(password) {
  const salt = randomBytes(16),
    salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const stored = createHash("sha256").update(createHmac("sha256", salted).update("Client Key").digest()).digest("base64");
  const server = createHmac("sha256", salted).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${stored}:${server}`;
}
/** Tests call the same implementation against a separately verified owned PG
 * fixture. The production CLI never accepts alternate hosts/paths/test flags. */
export function provision(o) {
  const host = o.synthetic ? "127.0.0.1" : "haproxy.home.cz",
    port = o.synthetic ? o.port : 5000;
  const envPath = o.synthetic ? o.envPath : "/srv/sim/.env",
    root = o.sourceRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const envStat = lstatSync(envPath);
  need(envStat.isFile() && !envStat.isSymbolicLink() && (envStat.mode & 0o077) === 0, "PRIVATE_ENV_REQUIRED");
  if (o.synthetic) need(realpathSync(envPath).startsWith("/private/tmp/sim-erasure-installer-"), "OWNED_TEST_PATH_REQUIRED");
  const original = readFileSync(envPath, "utf8");
  const value = (key) => selectedEnv(original, key);
  const rootCert = o.synthetic ? null : process.env.SIM_ERASURE_PG_ROOT_CERT_FILE || value("SIM_ERASURE_PG_ROOT_CERT_FILE");
  let caHash = null;
  if (!o.synthetic) {
    need(typeof rootCert === "string" && rootCert.startsWith("/"), "EXPLICIT_TRUSTED_POSTGRES_CA_REQUIRED");
    const stat = lstatSync(rootCert);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o022) === 0, "TRUSTED_PUBLIC_CA_FILE_REQUIRED");
    const ca = readFileSync(rootCert, "utf8");
    need(ca.includes("-----BEGIN CERTIFICATE-----") && !ca.includes("PRIVATE KEY"), "PUBLIC_CA_ONLY");
    caHash = sha(ca);
  }
  let stage = "preflight";
  function sql(db, text, user = o.user, password = o.password) {
    try {
      return execFileSync(
        o.psql ?? "psql",
        ["-X", "-w", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=sqlstate", "-h", host, "-p", String(port), "-U", user, "-d", db],
        {
          input: text,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            // Do not inherit libpq service/hostaddr/option overrides.
            ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PG"))),
            ...postgresTlsEnvironment(o.synthetic, rootCert),
            PGPASSWORD: password,
            PGPASSFILE: "/dev/null",
            PGCONNECT_TIMEOUT: "8",
            PGOPTIONS: user === o.user ? "-c log_statement=none -c log_min_error_statement=panic" : "-c statement_timeout=5000"
          },
          maxBuffer: 1024 * 1024
        }
      ).trim();
    } catch (error) {
      const code = /ERROR:\s*([A-Z0-9]{5})\b/.exec(String(error.stderr ?? ""))?.[1] ?? "UNKNOWN";
      throw new Error("POSTGRES_STAGE_FAILED_" + stage.toUpperCase() + "_" + code);
    }
  }
  const json = (db, query) => JSON.parse(sql(db, `SELECT row_to_json(q) FROM (${query}) q`));
  const server = json(
    "postgres",
    "SELECT current_setting('cluster_name') AS cluster,current_setting('data_directory') AS directory,current_setting('server_version_num')::int AS version,pg_is_in_recovery() AS standby,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS admin"
  );
  need(server.admin === true && !server.standby && server.version >= 180000, "PRIMARY_POSTGRES_ADMIN_REQUIRED");
  if (o.synthetic)
    need(server.cluster === "sim_erasure_installer_test" && server.directory.startsWith("/private/tmp/sim-erasure-installer-"), "OWNED_TEST_CLUSTER_REQUIRED");
  const guard = json(
    "postgres",
    "SELECT count(*)::int AS count,min(pg_get_userbyid(datdba)) AS owner FROM pg_database WHERE datname='cop_account_safety_guard'"
  );
  need(guard.count === 1, "EXISTING_GUARD_DATABASE_REQUIRED"); // Never CREATE DATABASE.
  const targets = [
    ["sim_driver_measurements", "driver_measurements_migrator"],
    ["sim_ai_router", "ai_router_migrator"]
  ];
  for (const [db, owner] of targets) {
    const r = json("postgres", `SELECT count(*)::int AS n FROM pg_database WHERE datname=${literal(db)} AND pg_get_userbyid(datdba)=${literal(owner)}`);
    need(r.n === 1, "EXPECTED_TARGET_DATABASE_OWNER_REQUIRED");
  }
  const selected = {
    driverHash: value("DRIVER_MEASUREMENTS_HASH_SECRET"),
    routerHash: value("AI_ROUTER_USER_HASH_SECRET"),
    driverActor: value("DRIVER_ACCOUNT_ERASURE_ACTOR_SECRET"),
    routerActor: value("AI_ROUTER_COP_ACTOR_SECRET"),
    driverIssuer: value("DRIVER_ACCOUNT_ERASURE_ISSUER"),
    routerIssuer: value("AI_ROUTER_ACCOUNT_ERASURE_ISSUER")
  };
  const missing = Object.entries(selected)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  const fingerprints = missing.length
    ? null
    : {
        driver: runtimeIdentityFingerprint("sim_measurements", selected.driverHash, selected.driverActor, selected.driverIssuer),
        router: runtimeIdentityFingerprint("ai_router", selected.routerHash, selected.routerActor, selected.routerIssuer)
      };
  const expected = fingerprints ? configurationFingerprint(fingerprints.driver, fingerprints.router) : null;
  const metadata = {
    mode: o.mode,
    guardDatabaseOwner: guard.owner,
    missingConfiguration: missing,
    identityFingerprints: fingerprints,
    configurationFingerprint: expected,
    postgresTls: o.synthetic ? "isolated-loopback-only" : "verify-full",
    postgresCaSha256: caHash,
    productionChanged: false
  };
  const driver = json(
    "sim_driver_measurements",
    "SELECT to_regnamespace('sim_driver_guard_source') IS NOT NULL AS root_guarded,to_regclass('public.driver_account_erasure_state') IS NOT NULL AS erasure,to_regclass('public.sim_erasure_dataset_binding') IS NOT NULL AS binding,(SELECT count(*)::int FROM driver_measurement_eta e LEFT JOIN driver_measurement_receipts r ON r.owner=e.owner AND r.batch_id=e.batch_id WHERE r.batch_id IS NULL OR r.contributor_hash IS DISTINCT FROM e.contributor_hash) AS eta_mismatch"
  );
  const ai = json(
    "sim_ai_router",
    "SELECT to_regclass('public.ai_router_erasure_checkpoint') IS NOT NULL AS erasure,to_regclass('public.sim_erasure_dataset_binding') IS NOT NULL AS binding"
  );
  need(!driver.root_guarded && driver.eta_mismatch === 0, "TARGET_SCHEMA_REQUIRES_SEPARATE_REVIEW");
  for (const path of Object.keys(PINS)) need(sha(readFileSync(resolve(root, path))) === PINS[path], "UNREVIEWED_MIGRATION_BYTES");
  if (o.mode === "check") return { ...metadata, driver, ai };
  need(o.mode === "apply" && fingerprints, "COMPLETE_STAGED_IDENTITY_CONFIGURATION_REQUIRED");
  if (!o.synthetic) {
    const stat = lstatSync(o.enrollmentPath);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0 && (stat.mode & 0o077) === 0, "ROOT_PRIVATE_REVIEWED_ENROLLMENT_REQUIRED");
  }
  const m = JSON.parse(readFileSync(o.enrollmentPath, "utf8"));
  need(
    m.contractVersion === "sim-erasure-production-enrollment-v2" &&
      m.identityReviewed === true &&
      HEX.test(m.identityReviewEvidenceDigest) &&
      m.retentionPolicy === "driver-7-days-v1" &&
      m.costPolicy === "aggregate-costs-current-month-v1" &&
      UUID.test(m.guardStoreId) &&
      m.configurationFingerprint === expected &&
      m.driverIdentityFingerprint === fingerprints.driver &&
      m.routerIdentityFingerprint === fingerprints.router,
    "REVIEWED_ENROLLMENT_REQUIRED"
  );
  if (!o.synthetic) need(m.postgresCaSha256 === caHash, "REVIEWED_POSTGRES_CA_REQUIRED");
  for (const owner of ["driver", "router"])
    need(
      m[owner] &&
        ["storeId", "incarnationId", "checkpointId"].every((k) => UUID.test(m[owner][k])) &&
        Number.isSafeInteger(m[owner].restoreGeneration) &&
        m[owner].restoreGeneration >= 1,
      "EXACT_TARGET_ENROLLMENT_REQUIRED"
    );
  const reports = m.reportPublication;
  let inventory;
  if (reports) {
    need(
      reports.policy === "shared_generation_fence-v1" && reports.externalProducersReviewed === true && HEX.test(reports.inventoryDigest),
      "EXPLICIT_REPORT_PRODUCER_REVIEW_REQUIRED"
    );
    inventory = reportInventory(o.synthetic ? { syntheticRoot: dirname(envPath) } : {});
    need(
      inventory.inventoryDigest === reports.inventoryDigest &&
        inventory.producerMatches.length === 0 &&
        inventory.activeProducerCount === 0 &&
        !inventory.lockPresent,
      "REPORT_PRODUCER_INVENTORY_CHANGED_OR_ACTIVE"
    );
  }
  if (!o.synthetic) {
    for (const container of ["csm-sim-situation-data-api", "csm-sim-ai-router-api"])
      need(
        execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", container], { encoding: "utf8" }).trim() === "false",
        "STOP_ONLY_TARGET_WRITERS_BEFORE_APPLY"
      );
    const legacy = lstatSync("/srv/sim/scripts/deploy-docker-home.sh");
    need(legacy.isFile() && !legacy.isSymbolicLink(), "EXPECTED_LEGACY_DEPLOY_SCRIPT");
  }
  const roles = ["sim_erasure_guard_owner", "sim_measurements_guard_runtime", "ai_router_guard_runtime"];
  const roleState = json(
    "postgres",
    `SELECT count(*)::int AS n,coalesce(bool_and(NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND (rolname='sim_erasure_guard_owner')<>rolcanlogin),true) AS restricted FROM pg_roles WHERE rolname IN (${roles.map(literal).join(",")})`
  );
  need(roleState.restricted, "UNEXPECTED_GUARD_ROLE_PRIVILEGES");
  const membership = json(
    "postgres",
    `SELECT count(*)::int AS n FROM pg_auth_members WHERE member IN(SELECT oid FROM pg_roles WHERE rolname IN (${roles.map(literal).join(",")}))`
  );
  need(membership.n === 0, "NO_RUNTIME_OR_OWNER_MEMBERSHIP_ALLOWED");
  const guardSchema = json(
    "cop_account_safety_guard",
    "SELECT to_regclass('sim_erasure_guard_v2.store') IS NOT NULL AS store,to_regclass('sim_erasure_guard_v2.owner_binding') IS NOT NULL AS binding,to_regclass('sim_erasure_guard_v2.tombstone') IS NOT NULL AS tombstone"
  );
  need(Object.values(guardSchema).every(Boolean) || Object.values(guardSchema).every((x) => !x), "PARTIAL_GUARD_SCHEMA_REQUIRES_REVIEW");
  if (guardSchema.store) {
    const s = json("cop_account_safety_guard", "SELECT count(*)::int AS n FROM sim_erasure_guard_v2.store");
    if (s.n)
      need(
        json(
          "cop_account_safety_guard",
          `SELECT count(*)::int AS n FROM sim_erasure_guard_v2.store WHERE store_id=${literal(m.guardStoreId)} AND configuration_fingerprint=${literal(expected)}`
        ).n === 1,
        "REFUSE_STORE_REENROLLMENT"
      );
  }
  for (const [name, key, db, present] of [
    ["sim_measurements", "driver", "sim_driver_measurements", driver.binding],
    ["ai_router", "router", "sim_ai_router", ai.binding]
  ]) {
    const v = m[key];
    const fields = `guard_store_id=${literal(m.guardStoreId)} AND store_id=${literal(v.storeId)} AND incarnation_id=${literal(v.incarnationId)} AND configuration_fingerprint=${literal(expected)} AND checkpoint_id=${literal(v.checkpointId)} AND restore_generation=${v.restoreGeneration}`;
    if (present) need(json(db, `SELECT count(*)::int AS n FROM sim_erasure_dataset_binding WHERE ${fields}`).n === 1, "REFUSE_TARGET_REENROLLMENT");
    if (guardSchema.binding) {
      const count = json("cop_account_safety_guard", `SELECT count(*)::int AS n FROM sim_erasure_guard_v2.owner_binding WHERE owner=${literal(name)}`);
      if (count.n)
        need(
          json(
            "cop_account_safety_guard",
            `SELECT count(*)::int AS n FROM sim_erasure_guard_v2.owner_binding WHERE owner=${literal(name)} AND ${fields.replace(" AND store_id=", " AND target_store_id=")} AND state='ready'`
          ).n === 1,
          "REFUSE_BINDING_REENROLLMENT_OR_QUARANTINE"
        );
    }
  }
  const passwords = {};
  const urls = {};
  for (const [key, user] of [
    ["DRIVER_ERASURE_GUARD_DATABASE_URL", "sim_measurements_guard_runtime"],
    ["AI_ROUTER_ERASURE_GUARD_DATABASE_URL", "ai_router_guard_runtime"]
  ]) {
    const existing = value(key);
    if (existing) {
      const u = new URL(existing);
      need(
        u.protocol === "postgresql:" &&
          u.hostname === host &&
          Number(u.port) === port &&
          u.pathname === "/cop_account_safety_guard" &&
          u.username === user &&
          u.password,
        "EXISTING_GUARD_URL_MISMATCH"
      );
      passwords[user] = decodeURIComponent(u.password);
      urls[key] = existing;
    } else {
      need(json("postgres", `SELECT count(*)::int AS n FROM pg_roles WHERE rolname=${literal(user)}`).n === 0, "EXISTING_ROLE_WITHOUT_RETAINED_SECRET");
      passwords[user] = randomBytes(32).toString("hex");
      urls[key] = `postgresql://${user}:${passwords[user]}@${host}:${port}/cop_account_safety_guard`;
    }
    if (!o.synthetic) {
      const u = new URL(urls[key]);
      need(
        [...u.searchParams.keys()].every((k) => ["sslmode", "sslrootcert"].includes(k)),
        "UNREVIEWED_GUARD_URL_OPTIONS"
      );
      u.searchParams.set("sslmode", "verify-full");
      u.searchParams.set("sslrootcert", "/etc/csm-sim/postgresql-ca.pem");
      urls[key] = u.toString();
    }
  }
  // Do not adopt an older erasure history into a newly empty guard journal.
  if (!driver.binding && driver.erasure)
    need(
      json(
        "sim_driver_measurements",
        "SELECT (SELECT count(*) FROM driver_account_erasure_operations)+(SELECT count(*) FROM driver_account_erasure_revocations) AS n"
      ).n === "0",
      "EXISTING_DRIVER_HISTORY_REQUIRES_REPLAY_REVIEW"
    );
  if (!ai.binding && ai.erasure)
    need(json("sim_ai_router", "SELECT count(*) AS n FROM ai_router_account_erasure").n === "0", "EXISTING_ROUTER_HISTORY_REQUIRES_REPLAY_REVIEW");
  const update = {
    ...urls,
    SIM_ACCOUNT_ERASURE_AUTHORITY_MODE: "database_v2",
    SIM_ACCOUNT_ERASURE_GUARD_STORE_ID: m.guardStoreId,
    SIM_ACCOUNT_ERASURE_CONFIGURATION_FINGERPRINT: expected,
    SIM_ACCOUNT_ERASURE_DRIVER_IDENTITY_FINGERPRINT: fingerprints.driver,
    SIM_ACCOUNT_ERASURE_ROUTER_IDENTITY_FINGERPRINT: fingerprints.router,
    DRIVER_ACCOUNT_ERASURE_ENABLED: "false",
    AI_ROUTER_ACCOUNT_ERASURE_ENABLED: "false",
    AI_ROUTER_ACCOUNT_ERASURE_REPLAY_READY: "true",
    AI_ROUTER_ACCOUNT_ERASURE_COST_POLICY: m.costPolicy,
    DRIVER_ACCOUNT_ERASURE_REPLAY_CHECKPOINT: m.driver.checkpointId
  };
  if (reports) update.DRIVER_MEASUREMENT_REPORTS_DIR = o.synthetic ? dirname(envPath) + "/driver-report-files" : "/driver-measurement-reports";
  if (!o.synthetic) {
    update.SIM_ERASURE_PG_ROOT_CERT_FILE = rootCert;
    for (const [key, db, user] of [
      ["DRIVER_MEASUREMENTS_DATABASE_URL", "sim_driver_measurements", "driver_measurements_runtime"],
      ["AI_ROUTER_DATABASE_URL", "sim_ai_router", "ai_router_runtime"]
    ]) {
      const u = new URL(value(key));
      need(
        ["postgresql:", "postgres:"].includes(u.protocol) &&
          u.hostname === "haproxy.home.cz" &&
          Number(u.port) === 5000 &&
          u.username === user &&
          u.pathname === "/" + db &&
          [...u.searchParams.keys()].every((k) => ["sslmode", "sslrootcert"].includes(k)),
        "EXACT_RUNTIME_DATABASE_URL_REQUIRED"
      );
      u.searchParams.set("sslmode", "verify-full");
      u.searchParams.set("sslrootcert", "/etc/csm-sim/postgresql-ca.pem");
      update[key] = u.toString();
    }
  }
  const lines = original.split(/\r?\n/).filter((line) => !Object.keys(update).some((k) => line.startsWith(k + "=")));
  const next =
    lines.join("\n").replace(/\n*$/, "\n") +
    Object.entries(update)
      .map(([k, v]) => k + "=" + JSON.stringify(v))
      .join("\n") +
    "\n";
  need(readFileSync(envPath, "utf8") === original, "ENV_CHANGED_DURING_PREFLIGHT");
  const temporary = envPath + ".sim-erasure-install-" + process.pid;
  let fd;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, next);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temporary, 0o600);
    if (process.getuid?.() === 0) chownSync(temporary, envStat.uid, envStat.gid);
    renameSync(temporary, envPath);
    const directory = openSync(dirname(envPath), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {}
  }
  if (!o.synthetic) {
    const path = "/srv/sim/scripts/deploy-docker-home.sh",
      stat = lstatSync(path),
      text = readFileSync(path, "utf8"),
      protectedText = protectLegacyDeployment(text);
    if (text !== protectedText) {
      const temporary = path + ".sim-erasure-" + process.pid;
      const handle = openSync(temporary, "wx", stat.mode & 0o777);
      try {
        writeFileSync(handle, protectedText);
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
      chownSync(temporary, stat.uid, stat.gid);
      renameSync(temporary, path);
    }
  }
  // Secret persistence precedes role creation: interrupted retries reuse it;
  // passwords are never rotated and are never included in output or argv.
  stage = "guard_roles";
  sql(
    "postgres",
    `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='sim_erasure_guard_owner') THEN CREATE ROLE sim_erasure_guard_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$;`
  );
  for (const user of roles.slice(1))
    sql(
      "postgres",
      `DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${literal(user)}) THEN CREATE ROLE ${identifier(user)} LOGIN PASSWORD ${literal(scram(passwords[user]))} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$; GRANT CONNECT ON DATABASE cop_account_safety_guard TO ${identifier(user)};`
    );
  const migration = (db, path, role) => {
    stage = path
      .split("/")
      .at(-1)
      .replace(/[^a-z0-9]/gi, "_");
    sql(db, (role ? `SET ROLE ${identifier(role)};\n` : "") + readFileSync(resolve(root, path), "utf8"));
  };
  migration("cop_account_safety_guard", "deploy/account-safety/010_sim_database_safety_v2.sql");
  stage = "guard_ownership";
  sql(
    "cop_account_safety_guard",
    `ALTER SCHEMA sim_erasure_guard_v2 OWNER TO sim_erasure_guard_owner; ALTER TABLE sim_erasure_guard_v2.store OWNER TO sim_erasure_guard_owner; ALTER TABLE sim_erasure_guard_v2.owner_binding OWNER TO sim_erasure_guard_owner; ALTER TABLE sim_erasure_guard_v2.tombstone OWNER TO sim_erasure_guard_owner; ALTER FUNCTION sim_erasure_guard_v2.immutable_tombstone() OWNER TO sim_erasure_guard_owner;`
  );
  for (const path of [
    "deploy/driver-measurements/002_account_erasure.sql",
    "deploy/driver-measurements/008_eta_contributor_binding_database_v2.sql",
    "deploy/account-safety/011_sim_target_binding.sql"
  ])
    migration("sim_driver_measurements", path, "driver_measurements_migrator");
  for (const path of ["deploy/ai-router/003_account_erasure.sql", "deploy/account-safety/011_sim_target_binding.sql"])
    migration("sim_ai_router", path, "ai_router_migrator");
  stage = "enrollment";
  const store = json("cop_account_safety_guard", "SELECT count(*)::int AS n FROM sim_erasure_guard_v2.store");
  if (store.n)
    need(
      json(
        "cop_account_safety_guard",
        `SELECT count(*)::int AS n FROM sim_erasure_guard_v2.store WHERE store_id=${literal(m.guardStoreId)} AND configuration_fingerprint=${literal(expected)}`
      ).n === 1,
      "REFUSE_STORE_REENROLLMENT"
    );
  sql(
    "cop_account_safety_guard",
    `INSERT INTO sim_erasure_guard_v2.store(store_id,configuration_fingerprint) VALUES(${literal(m.guardStoreId)},${literal(expected)}) ON CONFLICT DO NOTHING;`
  );
  for (const [name, key, db] of [
    ["sim_measurements", "driver", "sim_driver_measurements"],
    ["ai_router", "router", "sim_ai_router"]
  ]) {
    const v = m[key];
    const fields = `guard_store_id=${literal(m.guardStoreId)} AND store_id=${literal(v.storeId)} AND incarnation_id=${literal(v.incarnationId)} AND configuration_fingerprint=${literal(expected)} AND checkpoint_id=${literal(v.checkpointId)} AND restore_generation=${v.restoreGeneration}`;
    const local = json(db, "SELECT count(*)::int AS n FROM sim_erasure_dataset_binding");
    if (local.n) need(json(db, `SELECT count(*)::int AS n FROM sim_erasure_dataset_binding WHERE ${fields}`).n === 1, "REFUSE_TARGET_REENROLLMENT");
    sql(
      db,
      `INSERT INTO sim_erasure_dataset_binding VALUES(true,${literal(m.guardStoreId)},${literal(v.storeId)},${literal(v.incarnationId)},${literal(expected)},${literal(v.checkpointId)},${v.restoreGeneration}) ON CONFLICT DO NOTHING;`
    );
    const accepted = json("cop_account_safety_guard", `SELECT count(*)::int AS n FROM sim_erasure_guard_v2.owner_binding WHERE owner=${literal(name)}`);
    if (accepted.n)
      need(
        json(
          "cop_account_safety_guard",
          `SELECT count(*)::int AS n FROM sim_erasure_guard_v2.owner_binding WHERE owner=${literal(name)} AND ${fields.replace(" AND store_id=", " AND target_store_id=")} AND state='ready'`
        ).n === 1,
        "REFUSE_BINDING_REENROLLMENT_OR_QUARANTINE"
      );
    sql(
      "cop_account_safety_guard",
      `INSERT INTO sim_erasure_guard_v2.owner_binding(owner,guard_store_id,target_store_id,incarnation_id,configuration_fingerprint,checkpoint_id,restore_generation,state) VALUES(${literal(name)},${literal(m.guardStoreId)},${literal(v.storeId)},${literal(v.incarnationId)},${literal(expected)},${literal(v.checkpointId)},${v.restoreGeneration},'ready') ON CONFLICT DO NOTHING;`
    );
  }
  const checkpoint = createHmac("sha256", selected.driverHash)
    .update("cop:account-erasure-checkpoint:" + m.driver.checkpointId)
    .digest("hex");
  sql(
    "sim_driver_measurements",
    `UPDATE driver_account_erasure_state SET replay_ready=true,replay_checkpoint_hash=${literal(checkpoint)},proof_valid_until='infinity',retention_reviewed=true,publication_fence_verified=false,report_protection='unverified' WHERE singleton AND replay_checkpoint_hash IS NULL;`
  );
  if (reports) {
    // The actual directory is mounted only into the reviewed SDA image; its
    // writer and invalidator hold the same target advisory lock. No no_report.
    need(
      reportInventory(o.synthetic ? { syntheticRoot: dirname(envPath) } : {}).inventoryDigest === inventory.inventoryDigest,
      "REPORT_INVENTORY_CHANGED_DURING_INSTALL"
    );
    sql(
      "sim_driver_measurements",
      "UPDATE driver_account_erasure_state SET publication_fence_verified=true,report_protection='shared_generation_fence' WHERE singleton"
    );
  }
  sql(
    "sim_ai_router",
    `UPDATE ai_router_erasure_checkpoint SET identity_reviewed=true,replay_ready=true,cost_policy='aggregate-costs-current-month-v1',checkpoint_id=${literal(m.router.checkpointId)},checkpoint_generation=${m.router.restoreGeneration} WHERE id=1 AND NOT identity_reviewed AND NOT replay_ready;`
  );
  stage = "runtime_verification";
  for (const user of roles.slice(1)) need(jsonForRole(user).role === user, "GUARD_RUNTIME_LOGIN_FAILED");
  function jsonForRole(user) {
    return JSON.parse(sql("cop_account_safety_guard", "SELECT row_to_json(q) FROM (SELECT current_user AS role) q", user, passwords[user]));
  }
  return {
    ...metadata,
    installed: true,
    erasureEnabled: false,
    driverPublicationVerified: json("sim_driver_measurements", "SELECT publication_fence_verified AS value FROM driver_account_erasure_state WHERE singleton")
      .value,
    servicesStarted: false,
    productionChanged: !o.synthetic
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    need(process.getuid?.() === 0, "ROOT_INSTALLER_REQUIRED");
    const args = process.argv.slice(2);
    need(
      (args[0] === "--check" && args.length === 1) || (args[0] === "--apply" && args[1] === "--enrollment" && args.length === 3),
      "USAGE_CHECK_OR_APPLY_ENROLLMENT"
    );
    need(
      (!process.env.PGHOST || process.env.PGHOST === "haproxy.home.cz") && (!process.env.PGPORT || process.env.PGPORT === "5000") && process.env.PGPASSWORD,
      "FIXED_HAPROXY_AND_HIDDEN_PASSWORD_REQUIRED"
    );
    console.log(
      JSON.stringify(
        provision({ mode: args[0].slice(2), enrollmentPath: args[2], user: process.env.PGUSER ?? "postgres", password: process.env.PGPASSWORD }),
        null,
        2
      )
    );
  } catch (error) {
    console.error(error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "SIM_ERASURE_INSTALL_FAILED");
    process.exitCode = 1;
  }
}
