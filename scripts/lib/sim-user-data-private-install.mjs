/** Concrete private Root worker. Connection/password/identity inputs stay in RAM.
 * No CLI, env-selected target, public port, secret file, implicit apply or start. */
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { withResetWork } from "./clean-reset-admission.mjs";
import {
  verifiedUserMigrations,
  transitionSimHistory,
  enrollSimUserTarget,
  enrollSimGuardCheckpoint,
  USER_DATA_MANIFEST_SHA
} from "./sim-user-data-enroll.mjs";
import { userDataCatalog, inspectUserDataProfile } from "./sim-user-data-profile.mjs";
import { runtimeIdentityFingerprint } from "../../packages/sim-user-data/bootstrap.mjs";
import { createSimUserDataAuthority } from "../../packages/sim-user-data/authority.mjs";
import { completedReplayEnabled } from "../../packages/clean-lifecycle/completed-replay.mjs";
import { verifiedCompletedReplayProfile, installCompletedReplay, inspectCompletedReplayProfile, COMPLETED_REPLAY_PROFILE_SHA } from "./completed-replay-install.mjs";
const roles = ["sim_user_data_migrator", "sim_user_data_runtime", "sim_user_data_guard_runtime", "sim_user_history_guard_runtime"];
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
const need = (x, code = "SIM_USER_INSTALL_REJECTED") => {
  if (!x) throw Error(code);
};
const ordered = (x) =>
  Array.isArray(x)
    ? x.map(ordered)
    : x && typeof x === "object"
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, ordered(x[k])])
        )
      : x;
const sha = (x) =>
  createHash("sha256")
    .update(JSON.stringify(ordered(x)))
    .digest("hex");
const equal = (a, b) => sha(a) === sha(b);
/** PRIVATE in-process host file-worker input only. Never return through RPC,
 * print, log or persist this object outside the reviewed production secrets. */
export function privateSimRuntimeConfiguration(config, simRouterServiceToken) {
  need(config?.contractVersion === "sim-user-private-install-v1" && typeof simRouterServiceToken === "string" && simRouterServiceToken.length >= 32);
  const uri = (database, user, password) =>
    "postgresql://" +
    user +
    ":" +
    encodeURIComponent(password) +
    "@haproxy.home.cz:5000/" +
    database +
    "?sslmode=verify-full&sslrootcert=%2Fetc%2Fcsm-sim%2Fpostgresql-ca.pem";
  const replayMode = completedReplayEnabled(config.completedReplayMode) ? config.completedReplayMode : "disabled";
  const common = {
    SIM_USER_DATA_ENVIRONMENT_ID: config.bindings.sim_user_data.environment_id,
    SIM_USER_DATA_RESET_EPOCH: config.resetEpoch,
    SIM_USER_DATA_TOKENS_NOT_BEFORE: String(config.tokensNotBefore),
    SIM_USER_DATA_ROUTER_ACTOR_SECRET: config.identities.sim_user_data.routerActorSecret
  };
  return {
    environment: {
      "sim-api": {
        ...common,
        SIM_USER_DATA_ENABLED: "false",
        SIM_USER_DATA_COMPLETED_REPLAY_MODE: replayMode,
        SIM_USER_DATA_MODE: "production-sim-user-data-v1",
        SIM_USER_DATA_DATABASE_URL: uri("sim_user_data", "sim_user_data_runtime", config.credentials.sim_user_data_runtime),
        SIM_USER_DATA_ROOT: "/data/sim-user-data-v1",
        SIM_USER_DATA_OWNER_SECRET: config.identities.sim_user_data.ownerSecret,
        SIM_USER_DATA_COP_ACTOR_SECRET: config.identities.sim_user_data.actorSecret,
        SIM_USER_DATA_COP_TOKEN: config.serviceToken,
        SIM_AI_ROUTER_SIM_TOKEN: simRouterServiceToken,
        SIM_USER_DATA_GUARD_DATABASE_URL: uri("cop_account_safety_guard", "sim_user_data_guard_runtime", config.credentials.sim_user_data_guard_runtime),
        SIM_USER_DATA_CONTINUITY_BINDING: JSON.stringify(config.bindings.sim_user_data)
      },
      "ai-router-api": {
        ...common,
        SIM_USER_HISTORY_ENABLED: "false",
        SIM_USER_HISTORY_COMPLETED_REPLAY_MODE: replayMode,
        SIM_CLEAN_COMPLETED_REPLAY_MODE: replayMode,
        SIM_USER_HISTORY_MODE: "production-sim-user-data-v1",
        SIM_USER_HISTORY_GUARD_DATABASE_URL: uri(
          "cop_account_safety_guard",
          "sim_user_history_guard_runtime",
          config.credentials.sim_user_history_guard_runtime
        ),
        SIM_USER_HISTORY_CONTINUITY_BINDING: JSON.stringify(config.bindings.sim_user_history)
      },
      "situation-data-api": { SIM_USER_DATA_RELAY_ENABLED: "false", SIM_CLEAN_COMPLETED_REPLAY_MODE: replayMode }
    },
    readonlyCaMount: {
      source: "/etc/vcode-cop-pgbouncer/postgres-ca.crt",
      target: "/etc/csm-sim/postgresql-ca.pem",
      read_only: true,
      services: ["sim-api", "ai-router-api"]
    }
  };
}
export async function runSimUserInstall(config, { Pool, rootGate, assertWritersStopped }) {
  need(
    config?.contractVersion === "sim-user-private-install-v1" &&
      ["inspect", "apply", "readback"].includes(config.phase) &&
      process.versions.node.split(".")[0] === "24"
  );
  need(
    typeof config.serviceToken === "string" &&
      /^[A-Za-z0-9_-]{32,128}$/.test(config.serviceToken) &&
      roles.every((r) => /^[A-Za-z0-9_-]{32,128}$/.test(config.credentials?.[r]))
  );
  const isolated = config.profile === "owned-isolated-pg-v1";
  need(isolated || (config.profile === "production" && process.getuid() === 0), "SIM_USER_INSTALL_CONTEXT");
  need(config.connections && Object.keys(config.connections).sort().join(",") === "admin,ai,guard");
  need(
    config.credentials &&
      Object.keys(config.credentials).sort().join(",") === roles.slice().sort().join(",") &&
      roles.every((r) => /^[A-Za-z0-9_-]{32,128}$/.test(config.credentials[r]))
  );
  need(Number.isSafeInteger(config.tokensNotBefore) && config.tokensNotBefore > 0 && config.tokensNotBefore <= Math.floor(Date.now() / 1000));
  for (const component of ["sim_user_data", "sim_user_history"]) {
    const b = config.bindings?.[component];
    need(
      b &&
        Object.keys(b).length === fields.length &&
        fields.every((k) => Object.hasOwn(b, k)) &&
        b.reset_epoch === config.resetEpoch &&
        b.source_sha256 === config.manifest?.authoritySourceSha256 &&
        b.identity_sha256 === runtimeIdentityFingerprint(component, config.identities?.[component])
    );
  }
  need(
    config.bindings.sim_user_data.environment_id === config.bindings.sim_user_history.environment_id &&
      config.bindings.sim_user_data.guard_store_id === config.bindings.sim_user_history.guard_store_id
  );
  need(
    config.identities.sim_user_data.routerActorSecret === config.identities.sim_user_history.actorSecret &&
      config.identities.sim_user_data.issuer === config.identities.sim_user_history.issuer
  );
  const texts = await verifiedUserMigrations(config.manifest),
    pools = [];
  const replay = await verifiedCompletedReplayProfile(config.completedReplayMode);
  function pool(connection) {
    need(connection && !["connectionString", "options", "passfile"].some((k) => Object.hasOwn(connection, k)));
    if (!isolated)
      need(
        connection.host === "haproxy.home.cz" &&
          Number(connection.port) === 5000 &&
          connection.user === "postgres" &&
          connection.ssl?.rejectUnauthorized === true &&
          typeof connection.ssl.ca === "string",
        "SIM_USER_INSTALL_TLS_REQUIRED"
      );
    else
      need(
        /^\/private\/tmp\/sim-user-install-pg-[^/]+\/s$/.test(connection.host) && connection.user === "fixture_admin" && !connection.ssl,
        "SIM_USER_INSTALL_OWNED_PG_REQUIRED"
      );
    const p = new Pool({ ...connection, max: 2, connectionTimeoutMillis: 3000, statement_timeout: 15000 });
    p.on("error", () => {});
    pools.push(p);
    return p;
  }
  const admin = pool(config.connections.admin),
    ai = pool(config.connections.ai),
    guard = pool(config.connections.guard);
  async function client(p, role, work) {
    const c = await p.connect();
    try {
      if (role) await c.query("SET ROLE " + role);
      return await work(c);
    } finally {
      c.release();
    }
  }
  async function facts() {
    return {
      roles: (await admin.query("SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname", [roles])).rows.map((x) => x.rolname),
      databases: (await admin.query("SELECT datname FROM pg_database WHERE datname='sim_user_data'")).rows.map((x) => x.datname),
      guardTables: (
        await guard.query(
          "SELECT to_regclass('sim_erasure_guard_v2.user_data_checkpoint') IS NOT NULL checkpoint,to_regclass('sim_erasure_guard_v2.user_data_tombstone') IS NOT NULL tombstone"
        )
      ).rows[0]
    };
  }
  function plan(f) {
    const value = {
      contractVersion: "sim-user-private-install-plan-v1",
      resetEpoch: config.resetEpoch,
      tokensNotBefore: config.tokensNotBefore,
      manifestSha256: USER_DATA_MANIFEST_SHA,
      bindings: config.bindings,
      credentialDigests: Object.fromEntries(roles.map((r) => [r, sha(config.credentials[r])])),
      facts: f
    };
    if (replay) value.completedReplayProfileSha256 = COMPLETED_REPLAY_PROFILE_SHA;
    return { ...value, planDigest: sha(value), wholeAccountComplete: false };
  }
  async function readback(withReplay = !!replay) {
    const app = pool({ ...config.connections.admin, database: "sim_user_data" });
    const appCat = await client(app, "sim_user_data_migrator", (c) => userDataCatalog(c, "sim_user_data"));
    need(appCat.digest === config.manifest.appUserDataCatalogDigest, "SIM_USER_INSTALL_APP_PROFILE");
    const history = await client(ai, "ai_router_migrator", (c) => withReplay ? inspectCompletedReplayProfile(c, replay) : inspectUserDataProfile(c, config.manifest));
    need(history.state === "known-new-unused", "SIM_USER_INSTALL_HISTORY_NOT_EMPTY");
    const copRemaining = Number(
      (
        await ai.query(
          "SELECT(SELECT count(*) FROM sim_clean.account)+(SELECT count(*) FROM sim_clean.job)+(SELECT count(*) FROM sim_clean.resource)+(SELECT count(*) FROM public.ai_router_request WHERE client_id='cop')+(SELECT count(*) FROM public.ai_router_billing_request WHERE task_type='cop_chat')+(SELECT count(*) FROM public.ai_router_user_key)+(SELECT count(*) FROM public.ai_router_user_key_audit) n"
        )
      ).rows[0].n
    );
    need(copRemaining === 0, "SIM_USER_INSTALL_COP_LANE_NOT_EMPTY");
    const result = {
      contractVersion: "sim-user-private-install-readback-v1",
      resetEpoch: config.resetEpoch,
      manifestSha256: USER_DATA_MANIFEST_SHA,
      components: {},
      wholeAccountComplete: false
    };
    if (withReplay) result.completedReplayProfileSha256 = COMPLETED_REPLAY_PROFILE_SHA;
    for (const component of ["sim_user_data", "sim_user_history"]) {
      const database = component === "sim_user_data" ? "sim_user_data" : "sim_ai_router",
        runtime = component === "sim_user_data" ? "sim_user_data_runtime" : "ai_router_runtime";
      // Actual restricted-role sessions, not a positive role/readiness callback.
      const target = pool({ ...config.connections.admin, database }),
        gp = pool({ ...config.connections.guard });
      const t = await target.connect(),
        g = await gp.connect();
      try {
        await t.query("SET ROLE " + runtime);
        await g.query("SET ROLE " + component + "_guard_runtime");
        const single = (c) => ({
          query: (...args) => c.query(...args),
          async connect() {
            return { query: (...args) => c.query(...args), release() {} };
          }
        });
        const authority = await createSimUserDataAuthority({ guardPool: single(g), targetPool: single(t), component, binding: config.bindings[component] });
        await authority.withAdmission(async (lease) => lease.assertCurrent());
        const cfg = (await t.query(`SELECT * FROM ${component}.config WHERE singleton`)).rows[0];
        need(cfg?.mode === "production-sim-user-data-v1" && cfg.reset_epoch === config.resetEpoch && Number(cfg.tokens_not_before) === config.tokensNotBefore);
        need(Number((await t.query(`SELECT(SELECT count(*) FROM ${component}.account)+(SELECT count(*) FROM ${component}.job) n`)).rows[0].n) === 0);
        result.components[component] = { schemaVerified: true, actualRestrictedAuthority: true, resetEpoch: cfg.reset_epoch, unused: true };
      } finally {
        g.release();
        t.release();
      }
    }
    return result;
  }
  try {
    need(
      config.connections.admin.database === "postgres" &&
        config.connections.ai.database === "sim_ai_router" &&
        config.connections.guard.database === "cop_account_safety_guard"
    );
    if (isolated) {
      const x = (await admin.query("SELECT current_setting('data_directory') d,inet_server_addr() a,current_user u")).rows[0];
      need(/^\/private\/tmp\/sim-user-install-pg-[^/]+\/db$/.test(x.d) && x.a === null && x.u === "fixture_admin");
      const root = x.d.slice(0, -3),
        st = lstatSync(root);
      need(st.uid === process.getuid() && (st.mode & 0o777) === 0o700 && realpathSync(root) === root);
    }
    if (config.phase === "inspect") return plan(await facts());
    need(typeof assertWritersStopped === "function" && config.reviewedPlan?.planDigest, "SIM_USER_INSTALL_REVIEW_REQUIRED");
    need(equal(plan(config.reviewedPlan.facts), config.reviewedPlan), "SIM_USER_INSTALL_REVIEW_MISMATCH");
    if (config.phase === "readback") {
      // Called inside Root's ALREADY-held global readback admission. This callback
      // is its live assertCurrent; never issue a nested begin RPC here.
      await assertWritersStopped();
      const result = await readback();
      await assertWritersStopped();
      return result;
    }
    const context = {
      phase: "sim_user_install",
      planDigest: config.reviewedPlan.planDigest,
      resetEpoch: config.resetEpoch,
      tokensNotBefore: config.tokensNotBefore
    };
    const execute = async (admission, assertOpen) => {
      await admission.assertCurrent();
      await assertWritersStopped();
      assertOpen();
      const borrowed = {
        async withResetAdmission(_context, work) {
          assertOpen();
          await admission.assertCurrent();
          const result = await work(admission);
          assertOpen();
          await admission.assertCurrent();
          return result;
        }
      };
      const current = plan(await facts());
      need(equal(current, config.reviewedPlan), "SIM_USER_INSTALL_STALE_PLAN");
      need(
        current.facts.roles.length === 0 && current.facts.databases.length === 0 && !Object.values(current.facts.guardTables).some(Boolean),
        "SIM_USER_INSTALL_EXISTING_OBJECTS"
      );
      // Suppress statement/parameter logging before credential DDL. Passwords
      // are only RAM input; error output is normalized below, never SQL text.
      await client(admin, null, async (c) => {
        await c.query(
          "SET log_statement='none';SET log_min_error_statement='panic';SET log_parameter_max_length=0;SET log_parameter_max_length_on_error=0;SET password_encryption='scram-sha-256'"
        );
        for (const role of roles) {
          const ddl = (
            await c.query(
              "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',$1::text,$2::text) ddl",
              [role, config.credentials[role]]
            )
          ).rows[0].ddl;
          await c.query(ddl);
          await admission.assertCurrent();
          assertOpen();
        }
        await c.query("CREATE DATABASE sim_user_data OWNER sim_user_data_migrator");
      });
      const app = pool({ ...config.connections.admin, database: "sim_user_data" });
      await client(app, "sim_user_data_migrator", async (c) => {
        await c.query(
          "REVOKE ALL ON DATABASE sim_user_data FROM PUBLIC;GRANT CONNECT ON DATABASE sim_user_data TO sim_user_data_runtime;REVOKE ALL ON SCHEMA public FROM PUBLIC"
        );
        await c.query(texts["001_app_schema.sql"]);
        await c.query(texts["004_app_continuity.sql"]);
      });
      await guard.query("GRANT CONNECT ON DATABASE cop_account_safety_guard TO sim_user_data_guard_runtime,sim_user_history_guard_runtime");
      await guard.query(texts["003_independent_checkpoint.sql"]);
      await client(ai, "ai_router_migrator", (c) =>
        transitionSimHistory({
          client: c,
          manifest: config.manifest,
          rootGate: borrowed,
          reviewedCatalogDigest: config.manifest.aiBaseCatalogDigest,
          assertWritersStopped
        })
      );
      for (const component of ["sim_user_data", "sim_user_history"]) {
        const p = component === "sim_user_data" ? app : ai,
          role = component === "sim_user_data" ? "sim_user_data_migrator" : "ai_router_migrator";
        await client(p, role, async (c) => {
          await enrollSimUserTarget({
            client: c,
            component,
            binding: config.bindings[component],
            tokensNotBefore: config.tokensNotBefore,
            rootGate: borrowed,
            manifest: config.manifest,
            assertWritersStopped
          });
          await client(guard, null, (g) =>
            enrollSimGuardCheckpoint({
              guardClient: g,
              targetClient: c,
              component,
              binding: config.bindings[component],
              rootGate: borrowed,
              manifest: config.manifest,
              assertWritersStopped
            })
          );
        });
      }
      let result = await readback(false);
      if (replay) {
        await client(ai, "ai_router_migrator", (c) => installCompletedReplay({ client: c, mode: config.completedReplayMode, baseManifest: config.manifest, rootGate: borrowed, assertWritersStopped, resetEpoch: config.resetEpoch }));
        result = await readback(true);
      }
      await assertWritersStopped();
      await admission.assertCurrent();
      assertOpen();
      return result;
    };
    return await withResetWork(rootGate, context, execute);
  } catch (error) {
    const code = /^SIM_[A-Z0-9_]+$/.test(error.message ?? "")
      ? error.message
      : /^[A-Z0-9]{5}$/.test(error.code ?? "")
        ? "SIM_USER_INSTALL_PG_" + error.code
        : "SIM_USER_INSTALL_FAILED";
    throw Error(code);
  } finally {
    await Promise.all(pools.map((p) => p.end().catch(() => {})));
  }
}
