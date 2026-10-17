/** NEW isolated test composition of unchanged production-mode factories.
 * No production launcher, runtime switches, Root proof or public listener. */
import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { readFile, mkdir, lstat, realpath, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { runSimUserInstall } from "../lib/sim-user-data-private-install.mjs";
import { transitionOwnedFixture, sourceMigrations, readResetManifest, SCOPES } from "../lib/clean-reset-ops.mjs";
import { runtimeIdentityFingerprint } from "../../packages/sim-user-data/bootstrap.mjs";
import { canonicalOwnerKey, simOwnerAlias } from "../../packages/sim-user-data/claims.mjs";
import { makeCleanWholeInput, seedCleanWhole, readCleanWhole, forbidExternalFixtureFetch, FIXTURE_ISSUER } from "./clean-whole-sim-v1.mjs";
import { makeCleanWholeAppInput } from "./clean-whole-sim-user-data-v2.mjs";
import { validateCompanionActors } from "./clean-whole12-sim-companion.mjs";
import { verifiedCompletedReplayProfile, verifyCompletedReplayCatalog } from "../lib/completed-replay-install.mjs";
const secret = () => randomBytes(32).toString("base64url");
const closeServer = (s) => (s ? new Promise((r, j) => s.close((e) => (e ? j(e) : r()))) : Promise.resolve());
const listen = (app, port) =>
  new Promise((r, j) => {
    const s = createServer(app);
    s.once("error", j);
    s.listen(port, "127.0.0.1", () => r(s));
  });

/** Root supplies fresh own PG with Unix socket + TLS5000 and private mounts.
 * This factory checks ownership, actual server identity and all TLS outcomes.
 * No host files or DNS are edited here. Runtime source is not patched. */
export async function createTlsProductionSimFixture({ root, sourceRoot, runtimeRoot }) {
  const serviceRoot = (service) => (typeof runtimeRoot === "string" ? runtimeRoot : runtimeRoot[service]);
  assert.match(root, /^\/private\/tmp\/sim-user-install-pg-[A-Za-z0-9_-]+$/);
  assert.equal(await realpath(root), root);
  const st = await lstat(root);
  assert.ok(st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o777) === 0o700);
  const resolved = await lookup("haproxy.home.cz", { all: true });
  assert.ok(resolved.length && resolved.every((x) => x.address === "127.0.0.1"), "FIXTURE_DNS_NOT_LOOPBACK");
  const ca = await readFile(join(root, "tls/ca.pem"), "utf8"),
    wrongCa = await readFile(join(root, "tls/wrong-ca.pem"), "utf8");
  assert.equal(await readFile("/etc/csm-sim/postgresql-ca.pem", "utf8"), ca, "FIXTURE_CA_MOUNT_MISMATCH");
  const { Pool } = createRequire(join(serviceRoot("ai-router-api"), "apps/ai-router-api/package.json"))("pg");
  const conn = (database) => ({ host: join(root, "s"), port: 5000, database, user: "fixture_admin" });
  const pools = [];
  const pool = (cfg) => {
    const p = new Pool({ ...cfg, max: 4, connectionTimeoutMillis: 2000, statement_timeout: 7000 });
    p.on("error", () => {});
    pools.push(p);
    return p;
  };
  const admin = pool(conn("postgres"));
  const identity = (
    await admin.query(
      "SELECT current_user u,current_setting('data_directory') d,current_setting('cluster_name') c,current_setting('ssl') ssl,current_setting('listen_addresses') l,current_setting('port') p,inet_server_addr() a"
    )
  ).rows[0];
  assert.deepEqual(identity, { u: "fixture_admin", d: join(root, "db"), c: "sim_whole12_tls_fixture_v1", ssl: "on", l: "127.0.0.1", p: "5000", a: null });
  let input, install, ai, driver, main, model, mainServer, aiServer, driverServer, guardAdmin, acceptedReplay;
  let jwks,
    phase = "fresh",
    preparedPlan,
    installerInvocations = 0;
  const readbackServers = [];
  const passwords = { ai_router_runtime: secret(), driver_measurements_runtime: secret() };
  const uri = (database, user) =>
    `postgresql://${user}:${passwords[user]}@haproxy.home.cz:5000/${database}?sslmode=verify-full&sslrootcert=%2Fetc%2Fcsm-sim%2Fpostgresql-ca.pem`;
  const importRuntime = (service, file) => import(pathToFileURL(join(serviceRoot(service), "apps", service, "dist", file + ".js")).href);
  const loadSql = (path) => readFile(join(sourceRoot, path), "utf8");
  const runtimeEnv = () => ({
    NODE_ENV: "production",
    SIM_USER_DATA_GUARD_DATABASE_URL: uri("cop_account_safety_guard", "sim_user_data_guard_runtime"),
    SIM_USER_HISTORY_GUARD_DATABASE_URL: uri("cop_account_safety_guard", "sim_user_history_guard_runtime"),
    SIM_USER_DATA_CONTINUITY_BINDING: JSON.stringify(install.bindings.sim_user_data),
    SIM_USER_HISTORY_CONTINUITY_BINDING: JSON.stringify(install.bindings.sim_user_history),
    ...(acceptedReplay ? { SIM_USER_DATA_COMPLETED_REPLAY_MODE: acceptedReplay.mode, SIM_USER_HISTORY_COMPLETED_REPLAY_MODE: acceptedReplay.mode } : {})
  });
  async function withRuntimeEnv(work) {
    const values = runtimeEnv(),
      prior = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
    Object.assign(process.env, values);
    try {
      return await work();
    } finally {
      for (const [k, v] of Object.entries(prior))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  }
  function cleanEnv(lane) {
    const e = install.enrollments[lane];
    return {
      SIM_CLEAN_LIFECYCLE_ENABLED: "true",
      SIM_CLEAN_LIFECYCLE_MODE: "production-clean-lifecycle-v1",
      SIM_CLEAN_LIFECYCLE_ENVIRONMENT_ID: e.environmentId,
      SIM_CLEAN_LIFECYCLE_RESET_EPOCH: e.resetEpoch,
      SIM_CLEAN_LIFECYCLE_TOKENS_NOT_BEFORE: String(e.tokensNotBefore),
      SIM_CLEAN_LIFECYCLE_USER_DATASET_ID: e.userDatasetId,
      SIM_CLEAN_LIFECYCLE_PRODUCTION_ENROLLMENT_ID: e.enrollmentId,
      ...(acceptedReplay ? { SIM_CLEAN_COMPLETED_REPLAY_MODE: acceptedReplay.mode } : {})
    };
  }
  async function prepare(A, B, issuer, jwksOrigin) {
    assert.equal(phase, "fresh");
    validateCompanionActors(A, B, issuer, jwksOrigin);
    const initial = (a) => ({ subjectId: a.subjectId, oidcIat: a.oidcIat, routerUserId: "cop_" + secret(), contributorIdDay: secret() });
    input = makeCleanWholeAppInput(makeCleanWholeInput({ actors: { a: initial(A), b: initial(B) }, tokensNotBefore: Math.min(A.oidcIat, B.oidcIat) - 1 }));
    const day = new Date().toISOString().slice(0, 10),
      derivationEnv = input.base.environment;
    for (const a of Object.values(input.base.actors)) {
      a.routerUserId = "cop_" + createHmac("sha256", derivationEnv.routerHashSecret).update("cop-router-chat-v1\0").update(a.subjectId).digest("base64url");
      a.contributorIdDay = createHmac("sha256", derivationEnv.driverHashSecret).update(`cop-driver-contributor-v1\0${a.subjectId}\0${day}`).digest("base64url");
    }
    jwks = jwksOrigin;
    assert.equal(
      (
        await admin.query(
          "SELECT count(*) n FROM pg_database WHERE datname IN('sim_ai_router','sim_driver_measurements','sim_user_data','cop_account_safety_guard')"
        )
      ).rows[0].n,
      "0"
    );
    await admin.query(
      "CREATE ROLE ai_router_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;CREATE ROLE ai_router_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;CREATE ROLE driver_measurements_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;CREATE ROLE driver_measurements_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"
    );
    const enrollments = {};
    const old = await readResetManifest();
    for (const lane of ["ai", "driver"]) {
      const s = SCOPES[lane];
      await admin.query(`CREATE DATABASE ${s.database} OWNER ${s.owner}`);
      const owner = pool(conn(s.database)),
        c = await owner.connect();
      try {
        await c.query("SET ROLE " + s.owner);
        for (const f of lane === "ai"
          ? ["deploy/ai-router/001_schema.sql", "deploy/ai-router/002_separate_billing.sql"]
          : ["deploy/driver-measurements/schema.sql"])
          await c.query(await loadSql(f));
        await c.query("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
        await c.query(
          lane === "ai"
            ? "GRANT USAGE ON SCHEMA public TO ai_router_runtime;GRANT SELECT,INSERT,UPDATE ON ai_router_request,ai_router_policy,ai_router_policy_audit TO ai_router_runtime;GRANT USAGE,SELECT ON SEQUENCE ai_router_policy_audit_id_seq TO ai_router_runtime"
            : "GRANT USAGE ON SCHEMA public TO driver_measurements_runtime;GRANT SELECT,INSERT,UPDATE,DELETE ON driver_measurement_receipts,driver_measurement_intervals,driver_measurement_eta,driver_measurement_revocations TO driver_measurements_runtime"
        );
        await c.query(await loadSql(lane === "ai" ? "deploy/ai-router/003_account_erasure.sql" : "deploy/driver-measurements/002_account_erasure.sql"));
        if (lane === "driver") await c.query(await loadSql("deploy/driver-measurements/008_eta_contributor_binding_database_v2.sql"));
        const enrollment = {
          environmentId: input.base.environmentId,
          resetEpoch: input.base.resetEpoch,
          tokensNotBefore: input.base.tokensNotBefore,
          userDatasetId: randomUUID(),
          enrollmentId: randomUUID()
        };
        enrollments[lane] = enrollment;
        await c.query("BEGIN");
        try {
          await transitionOwnedFixture(c, lane, enrollment, await sourceMigrations(lane, old.pins));
          await c.query("COMMIT");
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        }
      } finally {
        c.release();
      }
    }
    await admin.query("CREATE DATABASE cop_account_safety_guard");
    const manifest = JSON.parse(await loadSql("deploy/sim-user-data/reset-manifest-v2.json"));
    const u = input.userDataEnvironment,
      b = input.base,
      e = b.environment;
    const identities = {
      sim_user_data: { ownerSecret: u.ownerSecret, actorSecret: u.copActorSecret, routerActorSecret: u.routerActorSecret, issuer },
      sim_user_history: { hashSecret: e.routerHashSecret, actorSecret: u.routerActorSecret, issuer }
    };
    const guard_store_id = randomUUID();
    const bindings = Object.fromEntries(
      Object.keys(identities).map((component) => [
        component,
        {
          guard_store_id,
          target_store_id: randomUUID(),
          incarnation_id: randomUUID(),
          environment_id: b.environmentId,
          reset_epoch: b.resetEpoch,
          checkpoint_id: randomUUID(),
          restore_generation: "1",
          source_sha256: manifest.authoritySourceSha256,
          identity_sha256: runtimeIdentityFingerprint(component, identities[component])
        }
      ])
    );
    const credentials = Object.fromEntries(
      ["sim_user_data_migrator", "sim_user_data_runtime", "sim_user_data_guard_runtime", "sim_user_history_guard_runtime"].map((k) => [k, secret()])
    );
    Object.assign(passwords, credentials);
    install = {
      contractVersion: "sim-user-private-install-v1",
      profile: "owned-isolated-pg-v1",
      phase: "inspect",
      manifest,
      resetEpoch: b.resetEpoch,
      tokensNotBefore: b.tokensNotBefore,
      connections: { admin: conn("postgres"), ai: conn("sim_ai_router"), guard: conn("cop_account_safety_guard") },
      credentials,
      serviceToken: u.copToken,
      identities,
      bindings,
      enrollments
    };
    // Synthetic fixture admission ONLY, never an actual Root acceptance proof.
    const fixtureGate = {
      async withResetAdmission(context, work) {
        assert.equal(context.planDigest, preparedPlan.planDigest);
        installerInvocations++;
        return work({
          async assertCurrent() {
            assert.equal(phase, "fresh");
          }
        });
      }
    };
    const deps = {
      Pool,
      rootGate: fixtureGate,
      assertWritersStopped: async () => {
        assert.equal(phase, "fresh");
        assert.ok(!main && !ai && !driver);
      }
    };
    preparedPlan = await runSimUserInstall(install, deps);
    await runSimUserInstall({ ...install, phase: "apply", reviewedPlan: preparedPlan }, deps);
    // Set only synthetic base runtime credentials, suppress statement/parameter
    // logging on the SAME session, normalize errors rather than expose SQL.
    const c = await admin.connect();
    try {
      await c.query(
        "SET log_statement='none';SET log_min_duration_statement=-1;SET log_min_error_statement='panic';SET log_parameter_max_length=0;SET log_parameter_max_length_on_error=0;SET password_encryption='scram-sha-256'"
      );
      for (const role of ["ai_router_runtime", "driver_measurements_runtime"]) await c.query(`ALTER ROLE ${role} PASSWORD '${passwords[role]}'`);
    } catch {
      throw Error("FIXTURE_CREDENTIAL_SETUP_FAILED");
    } finally {
      c.release();
    }
    phase = "prepared";
    guardAdmin = pool(conn("cop_account_safety_guard"));
  }
  async function tlsChecks() {
    assert.equal(phase, "prepared");
    const cfg = {
      host: "haproxy.home.cz",
      port: 5000,
      database: "sim_user_data",
      user: "sim_user_data_runtime",
      password: passwords.sim_user_data_runtime,
      ssl: { ca, rejectUnauthorized: true }
    };
    const valid = pool(cfg);
    const actual = (await valid.query("SELECT current_user u,s.ssl,s.version FROM pg_stat_ssl s WHERE pid=pg_backend_pid()")).rows[0];
    assert.equal(actual.u, "sim_user_data_runtime");
    assert.equal(actual.ssl, true);
    assert.match(actual.version, /^TLSv1\.[23]$/);
    await assert.rejects(() => valid.query("CREATE TABLE public.forbidden(id int)"));
    async function rejected(config, codes) {
      const p = pool(config);
      try {
        await assert.rejects(
          () => p.query("SELECT 1"),
          (err) => codes.includes(err.code)
        );
      } finally {
        await p.end();
      }
    }
    await rejected({ ...cfg, ssl: { ca: wrongCa, rejectUnauthorized: true } }, [
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
    ]);
    // Same test server and CA, IP is deliberately absent from its DNS-only SAN.
    await rejected({ ...cfg, host: "127.0.0.1", ssl: { ca, rejectUnauthorized: true, servername: "wrong.invalid" } }, ["ERR_TLS_CERT_ALTNAME_INVALID"]);
    return {
      actualTls: true,
      actualRestrictedRuntimeRole: true,
      runtimeDdlDenied: true,
      wrongCaRejected: true,
      wrongSanRejected: true,
      productionHaProxyVerified: false
    };
  }
  async function start(lane) {
    assert.ok(["prepared", "started"].includes(phase));
    const b = input.base,
      e = b.environment;
    if (lane === "ai") {
      assert.ok(!ai);
      const express = createRequire(join(serviceRoot("ai-router-api"), "apps/ai-router-api/package.json"))("express");
      const m = express();
      m.use(express.json());
      m.post("/api/generate", (_q, r) =>
        r.json({
          response: JSON.stringify({
            name: "Synthetic TLS fixture",
            description: "Fictional civil flood exercise for synthetic accounts.",
            durationSeconds: 60,
            objectCount: 1
          }),
          prompt_eval_count: 7,
          eval_count: 3
        })
      );
      model = await listen(m, 0);
      const { BudgetStore } = await importRuntime("ai-router-api", "budget"),
        { PgSeparateBilling } = await importRuntime("ai-router-api", "separate-billing"),
        { loadCleanRouterComposition } = await importRuntime("ai-router-api", "clean-bootstrap"),
        { loadSimHistory } = await importRuntime("ai-router-api", "sim-user-history"),
        { createApp } = await importRuntime("ai-router-api", "app");
      const limits = { dailyMicrousd: 1000000, monthlyMicrousd: 10000000, perUserDailyRequests: 100 };
      const store = new BudgetStore(uri("sim_ai_router", "ai_router_runtime"), e.routerHashSecret, limits);
      const config = {
        port: 4312,
        databaseUrl: uri("sim_ai_router", "ai_router_runtime"),
        copToken: e.copServiceToken,
        simToken: e.routerSimToken,
        adminToken: e.routerAdminToken,
        userHashSecret: e.routerHashSecret,
        openaiKey: "",
        externalEnabled: false,
        copInternalMinimizedEnabled: false,
        advancedEnabled: false,
        localUrl: "http://127.0.0.1:" + model.address().port,
        localModel: "synthetic-fixture",
        economyModel: "gpt-6-luna",
        advancedModel: "gpt-6-sol",
        ...limits,
        copActorSecret: e.routerActorSecret,
        accountErasureIssuer: b.issuer,
        accountErasureEnabled: false,
        copByokEnabled: true
      };
      const composition = await loadCleanRouterComposition(config, store, cleanEnv("ai"));
      await store.init();
      const history = await withRuntimeEnv(() =>
        loadSimHistory(config, store, {
          mode: "production-sim-user-data-v1",
          environmentId: b.environmentId,
          resetEpoch: b.resetEpoch,
          tokensNotBefore: b.tokensNotBefore,
          secret: input.userDataEnvironment.routerActorSecret
        })
      );
      const separate = new PgSeparateBilling(store.pool, e.routerEncryptionKey, history.combinedGate);
      separate.cleanLifecycleEnabled = true;
      await separate.checkSchema();
      const app = createApp(config, store, separate, undefined, composition.options, history);
      composition.start();
      aiServer = await listen(app, 4312);
      ai = { component: "ai", input: b, api: "http://127.0.0.1:4312", runtime: store.pool, store, separate, composition, history, guard: externalGuard };
    } else if (lane === "main") {
      assert.ok(!main && ai);
      const { createOwnedSimulatorApp } = await importRuntime("simulator-api", "user-data");
      const dataDir = join(root, "data/main");
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const u = input.userDataEnvironment;
      const settings = {
        mode: "production-sim-user-data-v1",
        databaseUrl: uri("sim_user_data", "sim_user_data_runtime"),
        root: join(dataDir, "sim-user-data-v1"),
        environmentId: b.environmentId,
        resetEpoch: b.resetEpoch,
        tokensNotBefore: b.tokensNotBefore,
        issuer: b.issuer,
        ownerSecret: u.ownerSecret,
        serviceToken: u.copToken,
        actorSecret: u.copActorSecret,
        routerActorSecret: u.routerActorSecret,
        routerUrl: ai.api,
        routerToken: e.routerSimToken
      };
      const config = {
        port: 4314,
        dataDir,
        schemaDir: join(serviceRoot("simulator-api"), "docs/api/schemas"),
        publisherMode: "DRY_RUN",
        sourceSystemId: "sim-tls-fixture",
        adapterVersion: "synthetic-tls",
        externalAiAllowed: false,
        aiRouterBaseUrl: ai.api,
        aiRouterSimToken: e.routerSimToken,
        apiAuthRequired: true,
        apiAuthMode: "oidc",
        apiOidcIssuer: b.issuer,
        apiOidcJwksUri: jwks,
        apiOidcAllowedClients: ["cop-web"],
        apiCorsOrigins: [],
        apiRateLimitMaxRequests: 1000,
        scenarioMaxBlocks: 6,
        scenarioMaxActiveObjects: 100,
        scenarioMaxEventsPerSecond: 100
      };
      main = await withRuntimeEnv(() => createOwnedSimulatorApp(config, settings));
      main.settings = settings;
      mainServer = await listen(main.app, 4314);
    } else if (lane === "driver") {
      assert.ok(!driver);
      const { loadCleanDriverComposition } = await importRuntime("situation-data-api", "clean-bootstrap"),
        { loadConfig } = await importRuntime("situation-data-api", "config"),
        { createApp } = await importRuntime("situation-data-api", "app");
      const settings = {
        enabled: true,
        revocationEnabled: true,
        databaseUrl: uri("sim_driver_measurements", "driver_measurements_runtime"),
        token: e.copServiceToken,
        hashSecret: e.driverHashSecret,
        ratePerMinute: 120,
        driverAccountErasureEnabled: false,
        driverAccountErasureActorSecret: e.driverActorSecret,
        driverAccountErasureIssuer: b.issuer
      };
      const composition = await loadCleanDriverComposition(settings, cleanEnv("driver"));
      const dataDir = join(root, "data/situation");
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const dataset = "sim-routing-2026-10-17-1792195200",
        matcher = {
          dataset: async () => dataset,
          match: async (points) => ({
            dataset,
            points: points.map((_p, i) => ({ edgeId: "8", fraction: 0.1 + i * 0.1, distanceM: 2, matched: true, disconnected: false, edgeLengthM: 500 }))
          })
        };
      const envValues = {
        SITUATION_DATA_DIR: dataDir,
        SITUATION_DATA_ENABLED_SOURCES: "mock",
        DRIVER_MEASUREMENTS_ENABLED: "true",
        DRIVER_MEASUREMENTS_REVOCATION_ENABLED: "true",
        DRIVER_MEASUREMENTS_DATABASE_URL: settings.databaseUrl,
        DRIVER_MEASUREMENTS_COP_TOKEN: e.copServiceToken,
        DRIVER_MEASUREMENTS_HASH_SECRET: e.driverHashSecret,
        DRIVER_ACCOUNT_ERASURE_ENABLED: "false"
      };
      const prior = { ...process.env };
      let result;
      try {
        for (const k of Object.keys(process.env)) if (!["PATH", "HOME", "TMPDIR", "LANG", "NODE_ENV"].includes(k)) delete process.env[k];
        Object.assign(process.env, envValues);
        const config = await loadConfig();
        config.enabledSources = ["mock"];
        config.valhallaBaseUrl = undefined;
        config.valhallaTrafficEnabled = false;
        result = await createApp(config, { cleanLifecycle: composition.options, driverMeasurements: { ...composition.driverMeasurements, matcher } });
      } finally {
        for (const k of Object.keys(process.env)) if (!(k in prior)) delete process.env[k];
        Object.assign(process.env, prior);
      }
      composition.start();
      driverServer = await listen(result.app, 4311);
      driver = {
        component: "driver",
        input: b,
        api: "http://127.0.0.1:4311",
        runtime: pool({ connectionString: settings.databaseUrl }),
        composition,
        context: result.context,
        guard: externalGuard
      };
    } else throw Error("UNKNOWN_TLS_COMPONENT");
    phase = "started";
  }
  async function outage(lane) {
    if (lane === "guard") {
      assert.ok(guardAdmin);
      await guardAdmin.query("ALTER ROLE sim_user_data_guard_runtime NOLOGIN;ALTER ROLE sim_user_history_guard_runtime NOLOGIN");
      await guardAdmin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='cop_account_safety_guard' AND usename IN('sim_user_data_guard_runtime','sim_user_history_guard_runtime') AND pid<>pg_backend_pid()"
      );
    } else if (lane === "main") {
      await closeServer(mainServer);
      mainServer = undefined;
      await main?.close();
      main = undefined;
    } else if (lane === "ai") {
      await closeServer(aiServer);
      aiServer = undefined;
      await ai?.history.close();
      await ai?.composition.close();
      await ai?.store.close();
      ai = undefined;
      await closeServer(model);
      model = undefined;
    } else if (lane === "driver") {
      await closeServer(driverServer);
      driverServer = undefined;
      await driver?.composition.close();
      await driver?.runtime.end();
      driver = undefined;
    } else throw Error("UNKNOWN_TLS_COMPONENT");
  }
  let externalGuard;
  async function openReadbacks() {
    assert.equal(readbackServers.length, 0);
    for (const [port, lane] of [[4321, "driver"], [4322, "ai"], [4324, "all"]]) {
      const handler = async (q, r) => {
        r.setHeader("cache-control", "no-store");
        r.setHeader("content-type", "application/json");
        const deny = (status, error) => { r.writeHead(status); r.end(JSON.stringify({ error })); };
        if (q.method !== "GET" || q.url !== "/readback" || q.headers.origin) return deny(404, "NOT_FOUND");
        const got = Buffer.from(q.headers.authorization ?? ""), want = Buffer.from("Bearer " + input.base.environment.copServiceToken);
        if (got.length !== want.length || !timingSafeEqual(got, want)) return deny(401, "UNAUTHORIZED");
        try { const result = await api.read(); r.end(JSON.stringify(lane === "all" ? result : result[lane])); }
        catch { return deny(503, "TLS_FIXTURE_READBACK_UNAVAILABLE"); }
      };
      readbackServers.push(await listen(handler, port));
    }
  }
  const api = {
    /** Existing synthetic fixture only. No seed, reset, enrollment or role DDL.
     * Caller must have stopped the previous runner and supplied new test-only
     * role credentials privately. Original identities and bindings are retained. */
    async resumeExisting(configuration, credentials, jwksOrigin, replay) {
      assert.equal(phase, "fresh");
      assert.equal(root, "/private/tmp/sim-user-install-pg-9aff26e65b74");
      assert.equal(configuration.input.contractVersion, "cop-sim-clean-whole-fixture-v2");
      assert.equal(configuration.input.base.issuer, "https://cop-erasure-keycloak.invalid/realms/cop");
      assert.equal(configuration.input.base.resetEpoch, "7f970a87-f36b-4e7f-8226-8c9107c8d3e4");
      assert.equal(jwksOrigin, "http://127.0.0.1:8080/realms/cop/protocol/openid-connect/certs");
      if (replay !== undefined) {
        assert.deepEqual(replay, { mode: "same-epoch-completed-content-replay-v1", acceptedOperationId: "b6fe7a68-d7a2-49e0-a9da-6dd7bcb01a4e" });
        acceptedReplay = replay;
      }
      async function verifyJobs(c, schema) {
        const jobs = (await c.query(`SELECT operation_id FROM ${schema}.job ORDER BY operation_id`)).rows;
        if (!acceptedReplay) {
          assert.equal(jobs.length, 0);
          assert.equal(Number((await c.query(`SELECT count(*) n FROM ${schema}.account WHERE state<>'active'`)).rows[0].n), 0);
        } else {
          assert.deepEqual(jobs, [{ operation_id: acceptedReplay.acceptedOperationId }]);
          assert.equal(Number((await c.query(`SELECT count(*) n FROM ${schema}.account WHERE state='deleted'`)).rows[0].n), 1);
          assert.equal(Number((await c.query(`SELECT count(*) n FROM ${schema}.account WHERE state='deletion_pending'`)).rows[0].n), 0);
        }
      }
      const roles = ["ai_router_runtime", "driver_measurements_runtime", "sim_user_data_runtime", "sim_user_data_guard_runtime", "sim_user_history_guard_runtime"];
      assert.deepEqual(Object.keys(credentials).sort(), roles.slice().sort());
      for (const role of roles) assert.match(credentials[role], /^[A-Za-z0-9_-]{43}$/);
      input = configuration.input;
      jwks = jwksOrigin;
      Object.assign(passwords, credentials);
      const enrollments = {};
      for (const lane of ["ai", "driver"]) {
        const c = pool(conn(lane === "ai" ? "sim_ai_router" : "sim_driver_measurements"));
        const cfg = (await c.query("SELECT * FROM sim_clean.config WHERE singleton")).rows[0];
        const e = (await c.query("SELECT * FROM sim_clean.production_enrollment WHERE singleton")).rows[0];
        assert.equal(cfg.mode, "production-clean-lifecycle-v1");
        assert.equal(cfg.environment_id, input.base.environmentId);
        assert.equal(cfg.reset_epoch, input.base.resetEpoch);
        assert.equal(Number(cfg.tokens_not_before), input.base.tokensNotBefore);
        assert.equal(e.environment_id, cfg.environment_id);
        assert.equal(e.reset_epoch, cfg.reset_epoch);
        await verifyJobs(c, "sim_clean");
        enrollments[lane] = { environmentId: e.environment_id, resetEpoch: e.reset_epoch, tokensNotBefore: Number(cfg.tokens_not_before), userDatasetId: e.user_dataset_id, enrollmentId: e.enrollment_id };
      }
      for (const [component, database] of [["sim_user_data", "sim_user_data"], ["sim_user_history", "sim_ai_router"]]) {
        const c = pool(conn(database)), row = (await c.query(`SELECT * FROM ${component}.continuity WHERE singleton`)).rows[0];
        const binding = configuration.bindings[component];
        for (const [key, value] of Object.entries(binding)) assert.equal(String(row[key]), String(value));
        await verifyJobs(c, component);
      }
      install = { bindings: configuration.bindings, enrollments };
      if (acceptedReplay) await verifyCompletedReplayCatalog(pool(conn("sim_ai_router")), await verifiedCompletedReplayProfile(acceptedReplay.mode));
      guardAdmin = pool(conn("cop_account_safety_guard"));
      externalGuard = forbidExternalFixtureFetch();
      phase = "prepared";
      await tlsChecks();
      await start("ai");
      await start("driver");
      await start("main");
      await openReadbacks();
      return api.read();
    },
    async seed(A, B, issuer, jwksOrigin) {
      externalGuard = forbidExternalFixtureFetch();
      await prepare(A, B, issuer, jwksOrigin);
      const tls = await tlsChecks();
      await start("ai");
      await start("driver");
      await start("main");
      await seedCleanWhole(ai);
      await seedCleanWhole(driver);
      for (const a of [A, B])
        for (const [path, body] of [
          [
            "/api/v1/scenarios",
            {
              name: "Synthetic TLS account",
              description: "Fictional civil fixture",
              area: { type: "BBOX", bbox: [14, 49.8, 15, 50.3] },
              durationSeconds: 60,
              seed: 17,
              blocks: [{ blockId: "rescue-sim", enabled: true, objectCount: 1, updateRateHz: 1 }],
              faults: []
            }
          ],
          ["/api/v1/ai/router-scenario-drafts", { prompt: "Fictional civil flood exercise only", syntheticOnly: true }]
        ]) {
          const r = await fetch("http://127.0.0.1:4314" + path, {
            method: "POST",
            headers: { authorization: "Bearer " + a.jwt, "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(7000)
          });
          assert.equal(r.status, 201, "ACTUAL_TLS_MAIN_SEED");
        }
      for (const [port, lane] of [
        [4321, "driver"],
        [4322, "ai"],
        [4324, "all"]
      ]) {
        const handler = async (q, r) => {
          r.setHeader("cache-control", "no-store");
          r.setHeader("content-type", "application/json");
          const deny = (status, error) => {
            r.writeHead(status);
            r.end(JSON.stringify({ error }));
          };
          if (q.method !== "GET" || q.url !== "/readback" || q.headers.origin) return deny(404, "NOT_FOUND");
          const got = Buffer.from(q.headers.authorization ?? ""),
            want = Buffer.from("Bearer " + input.base.environment.copServiceToken);
          if (got.length !== want.length || !timingSafeEqual(got, want)) return deny(401, "UNAUTHORIZED");
          try {
            const result = await api.read();
            r.end(JSON.stringify(lane === "all" ? result : result[lane]));
          } catch {
            return deny(503, "TLS_FIXTURE_READBACK_UNAVAILABLE");
          }
        };
        readbackServers.push(await listen(handler, port));
      }
      return {
        input,
        bindings: install.bindings,
        endpoints: { main: "http://127.0.0.1:4314", ai: ai.api, driver: driver.api },
        tls,
        actualRootAdmission: false,
        fixtureInstallerAdmissions: installerInvocations,
        productionInfrastructureChanged: false
      };
    },
    async read() {
      assert.ok(main && ai && driver);
      assert.ok(main.ledger.authority && ai.history.ledger.authority);
      await main.ledger.tx(async () => {});
      await ai.history.ledger.tx(async () => {});
      const app = {},
        history = {};
      for (const name of ["a", "b"]) {
        const owner = canonicalOwnerKey(input.userDataEnvironment.ownerSecret, { issuer: FIXTURE_ISSUER, subject: input.base.actors[name].subjectId });
        const state = (await main.pool.query("SELECT state FROM sim_user_data.account WHERE owner_key=$1", [owner])).rows[0]?.state ?? "unused";
        const directory = join(main.settings.root, input.base.resetEpoch, owner),
          files = {};
        try {
          for (const name of await readdir(directory)) {
            assert.ok(["sim-store.json", "publisher-queue.json", "sim-audit.jsonl", ".owner-scope.json"].includes(name));
            const path = join(directory, name),
              s = await lstat(path);
            assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1);
            const bytes = await readFile(path);
            files[name] = createHash("sha256").update(bytes).digest("hex");
          }
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        app[name] = { state, fileCount: Object.keys(files).length, fingerprint: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
        const h = ai.store.hashUser("sim", simOwnerAlias(owner)),
          izs = ai.store.hashUser("izs", simOwnerAlias(owner));
        const rows = (
          await ai.runtime.query(
            "SELECT(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM ai_router_request r WHERE client_id='sim' AND user_hash=$1) requests,(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM ai_router_billing_request r WHERE task_type='sim_izs_summary' AND actor_hash=$2) billing",
            [h, izs]
          )
        ).rows[0];
        history[name] = {
          requests: rows.requests?.length ?? 0,
          billing: rows.billing?.length ?? 0,
          state: (await ai.runtime.query("SELECT state FROM sim_user_history.account WHERE owner_key=$1", [owner])).rows[0]?.state ?? "unused",
          fingerprint: createHash("sha256").update(JSON.stringify(rows)).digest("hex")
        };
      }
      const componentRead = async (instance) => {
        const value = await readCleanWhole(instance);
        const mode = (await instance.runtime.query("SELECT mode FROM sim_clean.config WHERE singleton")).rows[0]?.mode;
        assert.equal(mode, "production-clean-lifecycle-v1");
        return { ...value, contractVersion: "cop-clean-whole-tls-component-readback-v1", mode };
      };
      return {
        appOwners: app,
        simHistory: history,
        ai: await componentRead(ai),
        driver: await componentRead(driver),
        sameCompiledProductionBootstrap: true,
        actualRootAdmission: false,
        productionHaProxyVerified: false,
        externalProviderAttempts: externalGuard.attempts,
        wholeAccountComplete: false
      };
    },
    outage,
    async recover(lane) {
      if (lane === "guard") await guardAdmin.query("ALTER ROLE sim_user_data_guard_runtime LOGIN;ALTER ROLE sim_user_history_guard_runtime LOGIN");
      else await start(lane);
    },
    async quarantine(component, enabled) {
      assert.ok(["sim_user_data", "sim_user_history"].includes(component));
      await guardAdmin.query("UPDATE sim_erasure_guard_v2.user_data_checkpoint SET state=$2 WHERE component=$1", [
        component,
        enabled ? "quarantined" : "ready"
      ]);
    },
    async close() {
      for (const s of readbackServers) await closeServer(s);
      readbackServers.length = 0;
      await outage("main");
      await outage("driver");
      await outage("ai");
      for (const p of pools) if (!p.ended) await p.end();
      externalGuard?.restore();
    }
  };
  return api;
}
