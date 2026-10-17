/** NEW synthetic clean whole fixture. Never CF24 or a production entrypoint.
 * Root generates private input on the fixture server, in RAM/private tmpfs.
 * This file is public code; no private fixture transfer or provider key needed.
 */
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { lstat, realpath, readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FIXTURE_CONTRACT = "cop-sim-clean-whole-fixture-v1";
export const READBACK_CONTRACT = "cop-clean-whole-readback-v1";
export const FIXTURE_OWNER = "cop-sim-clean-whole-20261017";
export const FIXTURE_ISSUER = "https://cop-erasure-keycloak.invalid/realms/cop";
export const FIXTURE_CLUSTER = "cop_clean_whole_fixture_v1";
export const FIXTURE_DATA = "/var/lib/postgresql/cop-clean-whole-v1";
export const SCOPE = "cop_sim_shared_identity_v1";
export const PORTS = Object.freeze({ driver: { api: 4311, readback: 4321 }, ai: { api: 4312, readback: 4322 } });
const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ADMIN = "owned_fixture_admin";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENV_KEYS = [
  "copServiceToken",
  "driverHashSecret",
  "driverActorSecret",
  "routerHashSecret",
  "routerActorSecret",
  "routerEncryptionKey",
  "routerSimToken",
  "routerAdminToken"
];
const LANES = {
  ai: { db: "sim_ai_router", owner: "ai_router_migrator", runtime: "ai_router_runtime" },
  driver: { db: "sim_driver_measurements", owner: "driver_measurements_migrator", runtime: "driver_measurements_runtime" }
};
export const SQL_PINS = Object.freeze({
  "deploy/ai-router/001_schema.sql": "b6e48ea50286f25a16262e4e8f7c2f57a9629ea09e163db473820618bcb1a92b",
  "deploy/ai-router/002_separate_billing.sql": "e016cfa95cf228c4781780d844e9bc0c784aade6c36a21fa9667923d9b0bfbcb",
  "deploy/driver-measurements/schema.sql": "6dd60a3acf28d63575198c8526c368df19bbd543f4063d4985fb55f308da02d0",
  "deploy/driver-measurements/008_eta_contributor_binding_database_v2.sql": "4a156baee81ded14d01b9ce261cca82a4f835905d32f91418fc8f67038b3f185",
  "deploy/clean-lifecycle/001_clean_lifecycle.sql": "2f104fa2f6cf59f4849f25beddcdee67e9bced03a7958cbe9d1ebd0ef1d9d535",
  "deploy/clean-lifecycle/002_ai_budget_views.sql": "e8db2223232e2857e8136bec9344d3db850c154343a0e62078fbc464e2ab7a2f",
  "deploy/clean-lifecycle/003_ai_runtime_grants.sql": "c61a6717402d00aebe6e2e9d8ee39b476d88d7ba999e9278be67337eeefd936a",
  "deploy/clean-lifecycle/004_driver_runtime_grants.sql": "1f06d4a24bbbb465e839c671e02d7ae9c4a5556df3d2b8d797afe7c6d33b5b23",
  "deploy/clean-lifecycle/005_ai_writer_fences.sql": "10dde0444aa079d6889665edf042f468816b965ebd3848a6a1d5abd2efba35f1",
  "deploy/clean-lifecycle/006_driver_writer_fences.sql": "e01525c7968921fbbc51f6643e394051f7464ce7ad072815d60bb77613c7b54b"
});
const sha = (x) => createHash("sha256").update(x).digest("hex");
const exact = (x, keys) =>
  assert.ok(
    x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length === keys.length && keys.every((k) => Object.hasOwn(x, k)),
    "CLEAN_FIXTURE_SHAPE"
  );
const lane = (x) => {
  assert.ok(Object.hasOwn(LANES, x), "CLEAN_FIXTURE_LANE");
  return LANES[x];
};
const listen = (server, port) =>
  new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(port, "127.0.0.1", () => res(server));
  });
const close = (s) => new Promise((res, rej) => s.close((e) => (e ? rej(e) : res())));

export function validateCleanWholeInput(x, now = Math.floor(Date.now() / 1000)) {
  exact(x, ["contractVersion", "fixtureOwner", "issuer", "environmentId", "resetEpoch", "tokensNotBefore", "actors", "environment"]);
  assert.equal(x.contractVersion, FIXTURE_CONTRACT);
  assert.equal(x.fixtureOwner, FIXTURE_OWNER);
  assert.equal(x.issuer, FIXTURE_ISSUER);
  assert.match(x.environmentId, UUID);
  assert.match(x.resetEpoch, UUID);
  assert.ok(Number.isSafeInteger(x.tokensNotBefore) && x.tokensNotBefore > 0 && x.tokensNotBefore < now);
  exact(x.actors, ["a", "b"]);
  for (const a of Object.values(x.actors)) {
    exact(a, ["subjectId", "routerUserId", "contributorIdDay", "oidcIat"]);
    assert.match(a.subjectId, UUID);
    assert.match(a.routerUserId, /^cop_[A-Za-z0-9_-]{43}$/);
    assert.match(a.contributorIdDay, /^[A-Za-z0-9_-]{32,128}$/);
    assert.ok(Number.isSafeInteger(a.oidcIat) && a.oidcIat > x.tokensNotBefore && a.oidcIat <= now);
  }
  for (const key of ["subjectId", "routerUserId", "contributorIdDay"]) assert.notEqual(x.actors.a[key], x.actors.b[key]);
  exact(x.environment, ENV_KEYS);
  for (const v of Object.values(x.environment)) assert.ok(typeof v === "string" && v.length >= 32 && !/[\u0000-\u0020\u007f]/.test(v));
  assert.equal(Buffer.from(x.environment.routerEncryptionKey, "base64").length, 32);
  assert.equal(new Set(Object.values(x.environment)).size, ENV_KEYS.length);
  return x;
}

/** Call ONLY on the owned fixture server. Supplied subjects/opaque IDs must be
 * the actual two synthetic Root/KC actors; this function never contacts KC. */
export function makeCleanWholeInput({
  actors,
  tokensNotBefore = Math.floor(Date.now() / 1000) - 120,
  environmentId = randomUUID(),
  resetEpoch = randomUUID()
} = {}) {
  const environment = Object.fromEntries(ENV_KEYS.map((k) => [k, randomBytes(32).toString(k === "routerEncryptionKey" ? "base64" : "base64url")]));
  return validateCleanWholeInput({
    contractVersion: FIXTURE_CONTRACT,
    fixtureOwner: FIXTURE_OWNER,
    issuer: FIXTURE_ISSUER,
    environmentId,
    resetEpoch,
    tokensNotBefore,
    actors,
    environment
  });
}

const databases = new WeakSet();
/** Fixed server tuple or a genuinely owned local UNIX fixture, never a URL. */
export async function createCleanWholeDatabase({ socket } = {}) {
  let host = "127.0.0.1",
    data = FIXTURE_DATA,
    runtimeRoot = "/app",
    sourceRoot = "/fixture-clean",
    workRoot = "/private/tmp/cop-clean-whole-sim";
  if (socket !== undefined) {
    assert.match(socket, /^\/private\/tmp\/sim-clean-whole-pg-[^/]+\/s$/);
    const root = dirname(socket),
      s = await lstat(root);
    assert.ok(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid() && (s.mode & 0o777) === 0o700);
    assert.equal(await realpath(root), root);
    assert.equal(await realpath(socket), socket);
    host = socket;
    data = join(root, "db");
    runtimeRoot = SOURCE;
    sourceRoot = SOURCE;
    workRoot = join(root, "data");
  } else {
    assert.equal(process.env.NODE_ENV, "test");
    assert.equal(process.env.SIM_CLEAN_WHOLE_FIXTURE_OWNER, FIXTURE_OWNER);
  }
  const packageName = existsSync(join(runtimeRoot, "apps/ai-router-api/package.json")) ? "ai-router-api" : "situation-data-api";
  const { Pool } = createRequire(join(runtimeRoot, "apps", packageName, "package.json"))("pg");
  const pools = [];
  const pool = (db, user) => {
    assert.ok(["postgres", ...Object.values(LANES).map((x) => x.db)].includes(db));
    assert.ok([ADMIN, ...Object.values(LANES).flatMap((x) => [x.owner, x.runtime])].includes(user));
    const p = new Pool({ host, port: 5432, database: db, user, max: 3, connectionTimeoutMillis: 1500, statement_timeout: 5000 });
    p.on("error", () => {});
    pools.push(p);
    return p;
  };
  const url = (db, user) => {
    lane(db === "sim_ai_router" ? "ai" : "driver");
    assert.ok(Object.values(LANES).some((x) => x.db === db && [x.owner, x.runtime].includes(user)));
    return `postgresql:///${db}?host=${encodeURIComponent(host)}&user=${user}&port=5432`;
  };
  const admin = pool("postgres", ADMIN);
  const identity = (
    await admin.query(
      "SELECT current_database() db,current_user AS role,current_setting('cluster_name') cluster,current_setting('data_directory') directory,inet_server_addr() address,current_setting('listen_addresses') listen,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) super,pg_is_in_recovery() recovery"
    )
  ).rows[0];
  try {
    assert.equal(identity.db, "postgres");
    assert.equal(identity.role, ADMIN);
    assert.equal(identity.cluster, FIXTURE_CLUSTER);
    assert.equal(identity.directory, data);
    assert.equal(identity.super, true);
    assert.equal(identity.recovery, false);
    if (socket) {
      assert.equal(identity.address, null);
      assert.equal(identity.listen, "");
    } else assert.equal(identity.address, "127.0.0.1");
  } catch (e) {
    await admin.end();
    throw e;
  }
  const db = {
    admin,
    pool,
    url,
    runtimeRoot,
    sourceRoot,
    workRoot,
    async close() {
      for (const p of pools) if (!p.ended) await p.end();
    }
  };
  databases.add(db);
  return db;
}

export async function provisionCleanWhole(db, input) {
  assert.ok(databases.has(db));
  validateCleanWholeInput(input);
  // Verify every source before creating even the first role/database.
  const texts = {};
  for (const [path, digest] of Object.entries(SQL_PINS)) {
    const file = join(db.sourceRoot, path);
    assert.equal(await realpath(file), file);
    texts[path] = await readFile(file, "utf8");
    assert.equal(sha(texts[path]), digest, "CLEAN_FIXTURE_SOURCE_DRIFT");
  }
  const roles = Object.values(LANES).flatMap((x) => [x.owner, x.runtime]),
    names = Object.values(LANES).map((x) => x.db);
  assert.equal((await db.admin.query("SELECT count(*) n FROM pg_roles WHERE rolname=ANY($1)", [roles])).rows[0].n, "0", "CLEAN_FIXTURE_ROLE_ALREADY_EXISTS");
  assert.equal(
    (await db.admin.query("SELECT count(*) n FROM pg_database WHERE datname=ANY($1)", [names])).rows[0].n,
    "0",
    "CLEAN_FIXTURE_DATABASE_ALREADY_EXISTS"
  );
  for (const role of roles) await db.admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  for (const [name, s] of Object.entries(LANES)) {
    await db.admin.query(`CREATE DATABASE ${s.db} OWNER ${s.owner}`);
    const p = db.pool(s.db, s.owner);
    await p.query(
      `REVOKE ALL ON DATABASE ${s.db} FROM PUBLIC;GRANT CONNECT ON DATABASE ${s.db} TO ${s.runtime};REVOKE ALL ON SCHEMA public FROM PUBLIC;GRANT USAGE ON SCHEMA public TO ${s.runtime}`
    );
    for (const f of name === "ai"
      ? ["deploy/ai-router/001_schema.sql", "deploy/ai-router/002_separate_billing.sql"]
      : ["deploy/driver-measurements/schema.sql", "deploy/driver-measurements/008_eta_contributor_binding_database_v2.sql"])
      await p.query(texts[f]);
    await p.query(texts["deploy/clean-lifecycle/001_clean_lifecycle.sql"]);
    await p.query("INSERT INTO sim_clean.config VALUES(true,'cop-sim-user-lifecycle-v1','isolated-clean-lifecycle-v1',$1,$2,$3,$4)", [
      input.environmentId,
      input.resetEpoch,
      name,
      input.tokensNotBefore
    ]);
    if (name === "ai") await p.query(texts["deploy/clean-lifecycle/002_ai_budget_views.sql"]);
    await p.query(texts[`deploy/clean-lifecycle/${name === "ai" ? "005_ai" : "006_driver"}_writer_fences.sql`]);
    await p.query(texts[`deploy/clean-lifecycle/${name === "ai" ? "003_ai" : "004_driver"}_runtime_grants.sql`]);
  }
  return { contractVersion: FIXTURE_CONTRACT, status: "fresh-isolated-databases-created", databases: 2, productionChanged: false, wholeCopAccepted: false };
}

export function cleanFixtureHeaders(input, name, component, { operationId = randomUUID(), requestedAt = new Date().toISOString(), oidcIat } = {}) {
  validateCleanWholeInput(input);
  lane(component);
  assert.ok(["a", "b"].includes(name));
  const a = input.actors[name],
    now = Math.floor(Date.now() / 1000),
    secret = input.environment[component === "ai" ? "routerActorSecret" : "driverActorSecret"];
  const actor = {
    iss: "cop",
    aud: "sim-clean-lifecycle-v1",
    sub: a.routerUserId,
    oidcIssuer: input.issuer,
    oidcSubject: a.subjectId,
    resetEpoch: input.resetEpoch,
    operationId,
    requestedAt,
    iat: now,
    exp: now + 60,
    jti: randomUUID(),
    resourceId: component === "ai" ? a.routerUserId : a.contributorIdDay,
    oidcIat: oidcIat ?? a.oidcIat
  };
  const payload = Buffer.from(JSON.stringify(actor)).toString("base64url");
  const legacy = Buffer.from(JSON.stringify({ sub: a.routerUserId, aud: "sim-ai-router", iat: now, exp: now + 60 })).toString("base64url");
  return {
    authorization: "Bearer " + input.environment.copServiceToken,
    "content-type": "application/json",
    "x-cop-clean-actor": payload,
    "x-cop-clean-actor-signature": createHmac("sha256", secret).update(payload).digest("hex"),
    "x-cop-actor": legacy,
    "x-cop-actor-signature": createHmac("sha256", secret).update(legacy).digest("hex")
  };
}

let fetchGuard;
export function forbidExternalFixtureFetch() {
  if (fetchGuard) {
    fetchGuard.refs++;
    return fetchGuard;
  }
  const previous = globalThis.fetch;
  const guard = {
    refs: 1,
    attempts: 0,
    restore() {
      if (--guard.refs === 0) {
        globalThis.fetch = previous;
        fetchGuard = undefined;
      }
    }
  };
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") {
      guard.attempts++;
      throw Error("CLEAN_FIXTURE_EXTERNAL_FORBIDDEN");
    }
    return previous(input, init);
  };
  fetchGuard = guard;
  return guard;
}

/** Actual application factories/bootstrap, not a replacement lifecycle API. */
export async function startCleanWholeComponent(db, input, component, { ephemeralPorts = false, simHistorySettings, syntheticModelResponse } = {}) {
  assert.ok(databases.has(db));
  validateCleanWholeInput(input);
  const s = lane(component);
  const load = (name) =>
    import(pathToFileURL(join(db.runtimeRoot, `apps/${component === "ai" ? "ai-router-api" : "situation-data-api"}/dist/${name}.js`)).href);
  const env = {
    SIM_CLEAN_LIFECYCLE_ENABLED: "true",
    SIM_CLEAN_LIFECYCLE_MODE: "isolated-clean-lifecycle-v1",
    SIM_CLEAN_LIFECYCLE_ENVIRONMENT_ID: input.environmentId,
    SIM_CLEAN_LIFECYCLE_RESET_EPOCH: input.resetEpoch,
    SIM_CLEAN_LIFECYCLE_TOKENS_NOT_BEFORE: String(input.tokensNotBefore)
  };
  const limits = { dailyMicrousd: 1000000, monthlyMicrousd: 10000000, perUserDailyRequests: 100 };
  const guard = forbidExternalFixtureFetch();
  let composition, app, store, separate, context, model, server, bridge, history;
  const runtime = db.pool(s.db, s.runtime),
    e = input.environment;
  try {
    if (component === "ai") {
      const express = createRequire(join(db.runtimeRoot, "apps/ai-router-api/package.json"))("express");
      const m = express();
      m.use(express.json());
      m.post("/api/generate", (_q, r) => r.json({ response: syntheticModelResponse ?? "Synthetic local whole fixture", prompt_eval_count: 7, eval_count: 3 }));
      model = await listen(createServer(m), 0);
      const { BudgetStore } = await load("budget"),
        { PgSeparateBilling } = await load("separate-billing"),
        { loadCleanRouterComposition } = await load("clean-bootstrap"),
        { createApp } = await load("app");
      store = new BudgetStore(db.url(s.db, s.runtime), e.routerHashSecret, limits);
      const config = {
        port: 0,
        databaseUrl: db.url(s.db, s.runtime),
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
        accountErasureIssuer: input.issuer,
        accountErasureEnabled: false,
        copByokEnabled: true
      };
      composition = await loadCleanRouterComposition(config, store, env);
      await store.init();
      if (simHistorySettings) {
        const { loadSimHistory } = await load("sim-user-history");
        history = await loadSimHistory(config, store, simHistorySettings);
      }
      separate = new PgSeparateBilling(store.pool, e.routerEncryptionKey, history?.combinedGate ?? composition.gate);
      separate.cleanLifecycleEnabled = true;
      await separate.checkSchema();
      app = createApp(config, store, separate, undefined, composition.options, history);
    } else {
      const { loadCleanDriverComposition } = await load("clean-bootstrap"),
        { loadConfig } = await load("config"),
        { createApp } = await load("app");
      const settings = {
        enabled: true,
        revocationEnabled: true,
        databaseUrl: db.url(s.db, s.runtime),
        token: e.copServiceToken,
        hashSecret: e.driverHashSecret,
        ratePerMinute: 120,
        driverAccountErasureEnabled: false,
        driverAccountErasureActorSecret: e.driverActorSecret,
        driverAccountErasureIssuer: input.issuer
      };
      composition = await loadCleanDriverComposition(settings, env);
      const dataDir = join(db.workRoot, "situation");
      await mkdir(dataDir, { mode: 0o700, recursive: true });
      const dataset = "sim-routing-2026-10-17-1792195200";
      const matcher = {
        dataset: async () => dataset,
        match: async (points) => ({
          dataset,
          points: points.map((_p, i) => ({ edgeId: "8", fraction: 0.1 + i * 0.1, distanceM: 2, matched: true, disconnected: false, edgeLengthM: 500 }))
        })
      };
      // The actual route registrar reads driverSettings from process.env, so bind
      // only these owned fixture settings during its synchronous configuration.
      const values = {
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
      for (const k of Object.keys(process.env)) if (!["PATH", "HOME", "TMPDIR", "LANG", "NODE_ENV"].includes(k)) delete process.env[k];
      Object.assign(process.env, values);
      try {
        const config = await loadConfig();
        config.enabledSources = ["mock"];
        config.valhallaBaseUrl = undefined;
        config.valhallaTrafficEnabled = false;
        const created = await createApp(config, { cleanLifecycle: composition.options, driverMeasurements: { ...composition.driverMeasurements, matcher } });
        app = created.app;
        context = created.context;
      } finally {
        for (const k of Object.keys(process.env)) if (!(k in prior)) delete process.env[k];
        Object.assign(process.env, prior);
      }
    }
    composition.start();
    server = await listen(createServer(app), ephemeralPorts ? 0 : PORTS[component].api);
    const instance = {
      component,
      input,
      runtime,
      composition,
      store,
      separate,
      history,
      guard,
      api: "http://127.0.0.1:" + server.address().port,
      async close() {
        if (bridge) await close(bridge);
        if (server) await close(server);
        if (model) await close(model);
        await history?.close();
        await composition?.close();
        await store?.close();
        if (context?.aggregation?.close) await context.aggregation.close();
        await runtime.end();
        guard.restore();
      }
    };
    bridge = await readbackServer(instance, ephemeralPorts ? 0 : PORTS[component].readback);
    instance.readback = "http://127.0.0.1:" + bridge.address().port;
    return instance;
  } catch (error) {
    if (server) await close(server);
    if (bridge) await close(bridge);
    if (model) await close(model);
    await history?.close();
    await composition?.close();
    await store?.close();
    if (context?.aggregation?.close) await context.aggregation.close();
    await runtime.end();
    guard.restore();
    throw error;
  }
}

export async function seedCleanWhole(instance) {
  const { component, input, runtime } = instance;
  assert.equal(Number((await runtime.query("SELECT count(*) n FROM sim_clean.account")).rows[0].n), 0, "CLEAN_FIXTURE_SEED_NOT_FRESH");
  for (const name of ["a", "b"]) {
    const headers = cleanFixtureHeaders(input, name, component);
    let body, path;
    if (component === "ai") {
      path = "/api/v1/ai-router/generate";
      body = {
        taskType: "cop_chat",
        dataClass: "internal",
        preference: "local",
        prompt: "Synthetic whole fixture only",
        userId: input.actors[name].routerUserId,
        allowExternal: false,
        allowPaidEscalation: false,
        copContext: { contractVersion: "cop-chat-context-v1", dataClass: "internal" }
      };
    } else {
      const now = Date.now(),
        dataset = "sim-routing-2026-10-17-1792195200";
      path = "/api/v1/internal/driver-measurements/v1/batches";
      body = {
        contractVersion: "sim-driver-measurements-v1",
        batchId: randomUUID(),
        contributorIdDay: input.actors[name].contributorIdDay,
        contributorDay: new Date(now).toISOString().slice(0, 10),
        vehicleClass: "passenger_car",
        consent: { version: "traffic-quality-v1", grantedAt: new Date(now - 3600000).toISOString(), attestation: "cop-driver-consent-v1" },
        points: [0, 1, 2].map((i) => ({
          sampleId: randomUUID(),
          observedAt: new Date(now - 20000 + i * 5000).toISOString(),
          lat: 50,
          lon: 14 + i * 0.0007,
          horizontalAccuracyM: 3,
          speedMps: 10,
          speedAccuracyMps: 0.5,
          headingDeg: 90,
          headingAccuracyDeg: 5,
          positionSource: "gps",
          motion: "driving",
          reducedAccuracy: false
        })),
        eta: {
          observationId: randomUUID(),
          routingDataset: dataset,
          predictedDurationSeconds: 100,
          actualDurationSeconds: 110,
          plannedDistanceM: 1000,
          actualDistanceM: 1000,
          personalStopSeconds: 0,
          estimatedSeconds: 0,
          offRoute: false,
          completedAt: new Date(now - 1000).toISOString()
        }
      };
    }
    const r = await fetch(instance.api + path, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(r.status, 200, "CLEAN_FIXTURE_ACTUAL_SEED_HANDLER");
    const result = await r.json();
    if (component === "driver") {
      assert.equal(result.applicationMode, "shadow_only");
      assert.equal(result.rawPositionsStored, false);
      assert.ok(result.acceptedIntervalCount > 0);
      assert.equal(result.etaAccepted, true);
    } else {
      const h = instance.store.hashUser("cop", input.actors[name].routerUserId);
      await instance.separate.putKey(h, "synthetic-not-an-openai-key-" + name);
      const id = await instance.separate.reserve("user_openai_key", h, h, "synthetic-whole", null, "cop_chat", "synthetic-local", 10, {
        dailyMicrousd: 1000000,
        monthlyMicrousd: 10000000,
        dailyRequests: 100
      });
      await instance.separate.finish(id, "success", 7, 3, 8);
    }
  }
  return {
    contractVersion: FIXTURE_CONTRACT,
    component,
    status: "seeded-via-actual-handler",
    syntheticActors: 2,
    rawPositionsStored: false,
    externalProviderAttempts: instance.guard.attempts,
    wholeCopAccepted: false
  };
}

export async function readCleanWhole(instance) {
  const { component, input, runtime } = instance,
    actors = {};
  await instance.composition.options.service.capability().then((x) => assert.equal(x, true));
  for (const name of ["a", "b"]) {
    const a = input.actors[name],
      secret = input.environment[component === "ai" ? "routerActorSecret" : "driverActorSecret"];
    const owner = createHmac("sha256", secret)
      .update("sim-clean-owner-v1\0" + input.issuer + "\0" + a.subjectId)
      .digest("hex");
    const hash =
      component === "ai"
        ? instance.store.hashUser("cop", a.routerUserId)
        : createHmac("sha256", input.environment.driverHashSecret)
            .update("cop:" + a.contributorIdDay)
            .digest("hex");
    const state = (await runtime.query("SELECT state FROM sim_clean.account WHERE owner_key=$1", [owner])).rows[0]?.state ?? "unused";
    // Row payloads never leave this process; only counts and an opaque digest do.
    const sql =
      component === "ai"
        ? "SELECT (SELECT jsonb_agg(to_jsonb(k) ORDER BY user_hash) FROM ai_router_user_key k WHERE user_hash=$1) keys,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM ai_router_user_key_audit a WHERE user_hash=$1) audit,(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM ai_router_request r WHERE client_id='cop' AND user_hash=$1) requests,(SELECT jsonb_agg(to_jsonb(b) ORDER BY id) FROM ai_router_billing_request b WHERE task_type='cop_chat' AND actor_hash=$1) billing"
        : "SELECT (SELECT jsonb_agg(to_jsonb(r) ORDER BY batch_id) FROM driver_measurement_receipts r WHERE contributor_hash=$1) receipts,(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.batch_id,i.measurement_key) FROM driver_measurement_intervals i JOIN driver_measurement_receipts r USING(owner,batch_id) WHERE r.contributor_hash=$1) intervals,(SELECT jsonb_agg(to_jsonb(e) ORDER BY batch_id) FROM driver_measurement_eta e WHERE contributor_hash=$1) eta,(SELECT jsonb_agg(to_jsonb(v) ORDER BY contributor_hash) FROM driver_measurement_revocations v WHERE contributor_hash=$1) revocations";
    const data = (await runtime.query(sql, [hash])).rows[0];
    actors[name] = {
      state,
      counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v?.length ?? 0])),
      storedRowsFingerprint: sha(JSON.stringify(data))
    };
  }
  const owner = component === "ai" ? "ai_router" : "sim_measurements",
    a = actors.a,
    b = actors.b;
  return {
    contractVersion: READBACK_CONTRACT,
    scope: SCOPE,
    resetEpoch: input.resetEpoch,
    mode: "isolated-clean-lifecycle-v1",
    component,
    owners: {
      [owner]: {
        removableA: Object.values(a.counts).reduce((x, y) => x + y, 0),
        removableB: Object.values(b.counts).reduce((x, y) => x + y, 0),
        stateA: a.state,
        stateB: b.state,
        countsA: a.counts,
        countsB: b.counts,
        preservedBFingerprint: b.storedRowsFingerprint
      }
    },
    applicationMode: component === "driver" ? "shadow_only" : undefined,
    externalProviderAttempts: instance.guard.attempts,
    productionChanged: false,
    wholeAccountComplete: false,
    wholeCopAccepted: false
  };
}

async function readbackServer(instance, port) {
  let busy = false;
  const wanted = Buffer.from("Bearer " + instance.input.environment.copServiceToken);
  return listen(
    createServer(async (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json");
      const deny = (status, error) => {
        res.writeHead(status);
        res.end(JSON.stringify({ error }));
      };
      if (req.method !== "GET" || req.url !== "/readback" || req.headers.origin) return deny(404, "NOT_FOUND");
      const got = Buffer.from(req.headers.authorization ?? "");
      if (got.length !== wanted.length || !timingSafeEqual(got, wanted)) return deny(401, "UNAUTHORIZED");
      if (busy) return deny(503, "CLEAN_FIXTURE_READBACK_UNAVAILABLE");
      busy = true;
      try {
        const result = await readCleanWhole(instance);
        res.writeHead(200);
        res.end(JSON.stringify(result));
      } catch {
        deny(503, "CLEAN_FIXTURE_READBACK_UNAVAILABLE");
      } finally {
        busy = false;
      }
    }),
    port
  );
}

async function main() {
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.SIM_CLEAN_WHOLE_FIXTURE_OWNER, FIXTURE_OWNER);
  const action = process.argv[2],
    component = process.argv[3];
  assert.ok(["provision", "serve"].includes(action));
  assert.equal(process.argv.length, action === "provision" ? 3 : 4);
  const directory = "/fixture-clean",
    file = join(directory, "private.json");
  for (const [path, mode] of [
    [directory, 0o700],
    [file, 0o600]
  ]) {
    const s = await lstat(path);
    assert.equal(await realpath(path), path);
    assert.equal(s.uid, process.getuid());
    assert.equal(s.mode & 0o777, mode);
    assert.ok(!s.isSymbolicLink());
    if (path === file) assert.ok(s.isFile() && s.nlink === 1 && s.size < 32768);
  }
  const input = validateCleanWholeInput(JSON.parse(await readFile(file, "utf8"))),
    db = await createCleanWholeDatabase();
  try {
    if (action === "provision") {
      console.log(JSON.stringify(await provisionCleanWhole(db, input)));
      return;
    }
    lane(component);
    const instance = await startCleanWholeComponent(db, input, component);
    try {
      await seedCleanWhole(instance);
      console.log(
        JSON.stringify({ contractVersion: FIXTURE_CONTRACT, status: "listening-and-seeded", component, ports: PORTS[component], wholeCopAccepted: false })
      );
      await new Promise((r) => {
        process.once("SIGTERM", r);
        process.once("SIGINT", r);
      });
    } finally {
      await instance.close();
    }
  } finally {
    await db.close();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(JSON.stringify({ error: "CLEAN_WHOLE_FIXTURE_FAILED", productionChanged: false }));
    process.exitCode = 1;
  });
