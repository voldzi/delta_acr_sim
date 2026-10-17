/** New 12-component composition seam. Private input generated ONLY inside the
 * owned test environment. It does not relabel old CF24 or transfer secrets. */
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, mkdir, lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validateCleanWholeInput, FIXTURE_CLUSTER, FIXTURE_DATA } from "./clean-whole-sim-v1.mjs";
import { canonicalOwnerKey } from "../../packages/sim-user-data/claims.mjs";
export function makeCleanWholeAppInput(base) {
  validateCleanWholeInput(base);
  return {
    contractVersion: "cop-sim-clean-whole-fixture-v2",
    base,
    userDataEnvironment: Object.fromEntries(
      ["ownerSecret", "copToken", "copActorSecret", "routerActorSecret"].map((k) => [k, randomBytes(32).toString("base64url")])
    )
  };
}
function validate(input) {
  assert.equal(input.contractVersion, "cop-sim-clean-whole-fixture-v2");
  assert.deepEqual(Object.keys(input).sort(), ["base", "contractVersion", "userDataEnvironment"]);
  validateCleanWholeInput(input.base);
  assert.deepEqual(Object.keys(input.userDataEnvironment).sort(), ["copActorSecret", "copToken", "ownerSecret", "routerActorSecret"]);
  for (const v of Object.values(input.userDataEnvironment)) assert.ok(typeof v === "string" && v.length >= 32);
  return input;
}
export function historySettings(input) {
  validate(input);
  return {
    mode: "isolated-sim-user-data-v1",
    environmentId: input.base.environmentId,
    resetEpoch: input.base.resetEpoch,
    tokensNotBefore: input.base.tokensNotBefore,
    secret: input.userDataEnvironment.routerActorSecret
  };
}
function appUrl(db, user) {
  return db
    .url("sim_ai_router", "ai_router_migrator")
    .replace("/sim_ai_router?", "/sim_user_data?")
    .replace("user=ai_router_migrator", "user=" + user);
}
export async function provisionCleanWholeApp(db, input) {
  validate(input);
  const p = (await db.admin.query("SELECT current_user AS role,current_setting('cluster_name') cluster,current_setting('data_directory') directory")).rows[0];
  assert.equal(p.role, "owned_fixture_admin");
  assert.equal(p.cluster, FIXTURE_CLUSTER);
  assert.ok(p.directory === FIXTURE_DATA || /^\/private\/tmp\/sim-clean-whole-pg-[^/]+\/db$/.test(p.directory));
  assert.equal(Number((await db.admin.query("SELECT count(*) n FROM pg_database WHERE datname='sim_user_data'")).rows[0].n), 0);
  assert.equal(
    Number((await db.admin.query("SELECT count(*) n FROM pg_roles WHERE rolname IN('sim_user_data_migrator','sim_user_data_runtime')")).rows[0].n),
    0
  );
  await db.admin.query(
    "CREATE ROLE sim_user_data_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;CREATE ROLE sim_user_data_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"
  );
  await db.admin.query("CREATE DATABASE sim_user_data OWNER sim_user_data_migrator");
  const { Pool } = createRequire(join(db.runtimeRoot, "apps/simulator-api/package.json"))("pg");
  const owner = new Pool({ connectionString: appUrl(db, "sim_user_data_migrator") });
  try {
    await owner.query(
      "REVOKE ALL ON DATABASE sim_user_data FROM PUBLIC;GRANT CONNECT ON DATABASE sim_user_data TO sim_user_data_runtime;REVOKE ALL ON SCHEMA public FROM PUBLIC"
    );
    await owner.query(await readFile(join(db.sourceRoot, "deploy/sim-user-data/001_app_schema.sql"), "utf8"));
    await owner.query("INSERT INTO sim_user_data.config VALUES(true,'cop-sim-user-data-v1','isolated-sim-user-data-v1',$1,$2,$3)", [
      input.base.environmentId,
      input.base.resetEpoch,
      input.base.tokensNotBefore
    ]);
  } finally {
    await owner.end();
  }
  const ai = db.pool("sim_ai_router", "ai_router_migrator");
  try {
    await ai.query(await readFile(join(db.sourceRoot, "deploy/sim-user-data/002_ai_history.sql"), "utf8"));
    await ai.query("INSERT INTO sim_user_history.config VALUES(true,'cop-sim-user-data-v1','isolated-sim-user-data-v1',$1,$2,$3)", [
      input.base.environmentId,
      input.base.resetEpoch,
      input.base.tokensNotBefore
    ]);
  } finally {
    await ai.end();
  }
  return { contractVersion: input.contractVersion, databasesAdded: 1, privateFixtureTransferred: false, productionChanged: false };
}
export async function startCleanWholeApp(db, input, { jwksUri, routerUrl } = {}) {
  validate(input);
  const b = input.base,
    u = input.userDataEnvironment;
  const { createOwnedSimulatorApp } = await import(pathToFileURL(join(db.runtimeRoot, "apps/simulator-api/dist/user-data.js")).href);
  const dataDir = join(db.workRoot, "main-app");
  await mkdir(dataDir, { mode: 0o700, recursive: true });
  const root = join(dataDir, "sim-user-data-v1");
  await mkdir(root, { mode: 0o700, recursive: true });
  const settings = {
    mode: "isolated-sim-user-data-v1",
    databaseUrl: appUrl(db, "sim_user_data_runtime"),
    root,
    environmentId: b.environmentId,
    resetEpoch: b.resetEpoch,
    tokensNotBefore: b.tokensNotBefore,
    issuer: b.issuer,
    ownerSecret: u.ownerSecret,
    serviceToken: u.copToken,
    actorSecret: u.copActorSecret,
    routerActorSecret: u.routerActorSecret,
    routerUrl,
    routerToken: b.environment.routerSimToken
  };
  const config = {
    port: 4314,
    dataDir,
    schemaDir: join(db.runtimeRoot, "docs/api/schemas"),
    publisherMode: "DRY_RUN",
    sourceSystemId: "sim-owned-fixture",
    adapterVersion: "synthetic-v2",
    externalAiAllowed: false,
    aiRouterBaseUrl: routerUrl,
    aiRouterSimToken: b.environment.routerSimToken,
    apiAuthRequired: true,
    apiAuthMode: "oidc",
    apiOidcIssuer: b.issuer,
    apiOidcJwksUri: jwksUri,
    apiOidcAllowedClients: ["cop-web"],
    apiCorsOrigins: [],
    apiRateLimitMaxRequests: 1000,
    scenarioMaxBlocks: 6,
    scenarioMaxActiveObjects: 100,
    scenarioMaxEventsPerSecond: 100
  };
  const composition = await createOwnedSimulatorApp(config, settings);
  return {
    ...composition,
    settings,
    config,
    async read() {
      const out = {
        contractVersion: "cop-clean-whole-readback-v2",
        component: "sim_user_data",
        scope: "cop_sim_shared_identity_v1",
        resetEpoch: b.resetEpoch,
        actors: {},
        wholeAccountComplete: false,
        productionChanged: false
      };
      for (const name of ["a", "b"]) {
        const owner = canonicalOwnerKey(u.ownerSecret, { issuer: b.issuer, subject: b.actors[name].subjectId });
        const state = (await composition.pool.query("SELECT state FROM sim_user_data.account WHERE owner_key=$1", [owner])).rows[0]?.state ?? "unused";
        const directory = join(root, b.resetEpoch, owner);
        let counts = { scenarios: 0, drafts: 0, audit: 0, publisher: 0 };
        try {
          const names = await readdir(directory);
          for (const file of names) {
            const st = await lstat(join(directory, file));
            assert.ok(st.isFile() && !st.isSymbolicLink());
            if (file === "sim-store.json") {
              const x = JSON.parse(await readFile(join(directory, file), "utf8"));
              counts.scenarios = x.scenarios.length;
              counts.drafts = x.drafts.length;
            } else if (file === "publisher-queue.json") counts.publisher = JSON.parse(await readFile(join(directory, file), "utf8")).items.length;
            else if (file === "sim-audit.jsonl") counts.audit = (await readFile(join(directory, file), "utf8")).split("\n").filter(Boolean).length;
            else if (file === ".owner-scope.json") {
              const marker = JSON.parse(await readFile(join(directory, file), "utf8"));
              assert.equal(marker.contractVersion, "sim-user-owned-directory-v1");
              assert.equal(marker.ownerKey, owner);
              assert.equal(marker.resetEpoch, b.resetEpoch);
            } else throw Error("SIM_APP_FIXTURE_UNREVIEWED_FILE");
          }
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        out.actors[name] = { state, counts };
      }
      return out;
    }
  };
}
export function appDeletionHeaders(input, name, { operationId, requestedAt }) {
  validate(input);
  const b = input.base,
    a = b.actors[name],
    now = Math.floor(Date.now() / 1000);
  const actor = {
    iss: "cop",
    aud: "sim-clean-lifecycle-v1",
    sub: a.routerUserId,
    oidcIssuer: b.issuer,
    oidcSubject: a.subjectId,
    resetEpoch: b.resetEpoch,
    operationId,
    requestedAt,
    iat: now,
    exp: now + 60,
    jti: crypto.randomUUID(),
    resourceId: a.routerUserId,
    oidcIat: a.oidcIat
  };
  const value = Buffer.from(JSON.stringify(actor)).toString("base64url");
  return {
    authorization: "Bearer " + input.userDataEnvironment.copToken,
    "content-type": "application/json",
    "x-cop-clean-actor": value,
    "x-cop-clean-actor-signature": createHmac("sha256", input.userDataEnvironment.copActorSecret).update(value).digest("hex")
  };
}
