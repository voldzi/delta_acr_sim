/** Actual new owner composition: RSA/OIDC verification, actual app/router,
 * owned PG, files and HTTP relay. Never a production or actual KC proof. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, chmod, readFile, rm, readdir, lstat, writeFile } from "node:fs/promises";
import { statSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { createSign, generateKeyPairSync, randomUUID, randomBytes, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeCleanWholeInput,
  createCleanWholeDatabase,
  provisionCleanWhole,
  startCleanWholeComponent,
  FIXTURE_CLUSTER
} from "./fixtures/clean-whole-sim-v1.mjs";
import {
  makeCleanWholeAppInput,
  provisionCleanWholeApp,
  startCleanWholeApp,
  historySettings,
  appDeletionHeaders
} from "./fixtures/clean-whole-sim-user-data-v2.mjs";
import { canonicalOwnerKey, simOwnerAlias, signSimOwner } from "../packages/sim-user-data/claims.mjs";
import { testUserContinuity } from "./fixtures/sim-user-continuity-test.mjs";
import { UserLedger } from "../packages/sim-user-data/ledger.mjs";
assert.equal(process.argv.length, 3);
assert.ok(["--run", "--run-completed-replay"].includes(process.argv[2]));
const testCompletedReplay = process.argv[2] === "--run-completed-replay";
const originalReplayMode = process.env.SIM_USER_DATA_COMPLETED_REPLAY_MODE;
const exec = promisify(execFile),
  bin = "/opt/homebrew/opt/postgresql@18/bin",
  source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"].includes(k)));
assert.match((await exec(join(bin, "postgres"), ["--version"], { env })).stdout, /PostgreSQL\) 18\.3/);
const previousUmask = process.umask(0o077),
  root = await mkdtemp("/private/tmp/sim-clean-whole-pg-");
await chmod(root, 0o700);
await mkdir(join(root, "s"), { mode: 0o700 });
const owned = () => {
  assert.equal(dirname(realpathSync(root)), "/private/tmp");
  assert.equal(statSync(root).uid, process.getuid());
  assert.equal(statSync(root).mode & 0o777, 0o700);
};
let started = false,
  db,
  ai,
  main,
  jwks,
  http,
  relay,
  passed = false,
  checks = 0;
const check = (v, label) => {
  assert.ok(v, label);
  checks++;
};
const serve = (app, port = 0) =>
  new Promise((resolve, reject) => {
    const s = createServer(app);
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
const close = (s) => new Promise((r) => s.close(r));
const now = Math.floor(Date.now() / 1000),
  actors = Object.fromEntries(
    ["a", "b"].map((k) => [
      k,
      {
        subjectId: randomUUID(),
        routerUserId: "cop_" + randomBytes(32).toString("base64url"),
        contributorIdDay: randomBytes(32).toString("base64url"),
        oidcIat: now
      }
    ])
  );
const input = makeCleanWholeAppInput(makeCleanWholeInput({ actors })),
  b = input.base,
  u = input.userDataEnvironment;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }),
  jwk = { ...publicKey.export({ format: "jwk" }), kid: "owned-synthetic-key", alg: "RS256", use: "sig" };
function token(
  name,
  { subject = actors[name].subjectId, issuer = b.issuer, iat = actors[name].oidcIat, user = "same-display-user", roles = ["SIM_ADMIN"] } = {}
) {
  const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid, typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      iss: issuer,
      sub: subject,
      aud: "cop-web",
      azp: "cop-web",
      iat,
      exp: Math.floor(Date.now() / 1000) + 300,
      preferred_username: user,
      realm_access: { roles }
    })
  ).toString("base64url");
  const value = head + "." + body;
  return value + "." + createSign("RSA-SHA256").update(value).end().sign(privateKey).toString("base64url");
}
const request = async (base, path, { method = "GET", headers, body } = {}) => {
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(7000) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, cache: r.headers.get("cache-control") };
};
const userHeaders = (name, options) => ({ authorization: "Bearer " + token(name, options), "content-type": "application/json" });
const prefix = "/api/v1/internal/sim-user-data/v1";
try {
  owned();
  await exec(join(bin, "initdb"), ["-D", join(root, "db"), "-U", "owned_fixture_admin", "--auth-local=trust", "--auth-host=reject", "--no-locale"], { env });
  await exec(
    join(bin, "pg_ctl"),
    [
      "-D",
      join(root, "db"),
      "-l",
      join(root, "pg.log"),
      "-o",
      `-k ${join(root, "s")} -c listen_addresses='' -c cluster_name=${FIXTURE_CLUSTER}`,
      "-w",
      "start"
    ],
    { env }
  );
  started = true;
  db = await createCleanWholeDatabase({ socket: join(root, "s") });
  await provisionCleanWhole(db, b);
  await provisionCleanWholeApp(db, input);
  ai = await startCleanWholeComponent(db, b, "ai", {
    ephemeralPorts: true,
    simHistorySettings: historySettings(input),
    syntheticModelResponse: JSON.stringify({
      name: "Synthetic flood fixture",
      description: "Purely fictional civil synthetic exercise for two accounts.",
      durationSeconds: 60,
      objectCount: 1
    })
  });
  jwks = await serve((_q, r) => {
    r.setHeader("content-type", "application/json");
    r.end(JSON.stringify({ keys: [jwk] }));
  });
  main = await startCleanWholeApp(db, input, { jwksUri: "http://127.0.0.1:" + jwks.address().port + "/certs", routerUrl: ai.api });
  {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { createOwnedSimulatorApp } = await import("../apps/simulator-api/dist/user-data.js");
      const { loadSimHistory } = await import("../apps/ai-router-api/dist/sim-user-history.js");
      await assert.rejects(() => createOwnedSimulatorApp(main.config, main.settings), /ISOLATION_MODE_REQUIRED/);
      check(true, "isolated app mode cannot run as production");
      await assert.rejects(() => loadSimHistory({}, {}, historySettings(input)), /ISOLATION_MODE_REQUIRED/);
      check(true, "isolated history mode cannot run as production");
      assert.throws(() => new UserLedger(main.pool, { ...main.settings, mode: "production-sim-user-data-v1" }), /REAL_AUTHORITY_REQUIRED/);
      check(true, "production mode without actual SQL authority refused");
    } finally {
      if (saved === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = saved;
    }
  }
  http = await serve(main.app, 4314);
  const base = "http://127.0.0.1:4314";
  const express = createRequire(join(source, "apps/situation-data-api/package.json"))("express");
  const relayApp = express();
  const { registerSimUserDataRelay } = await import("../apps/situation-data-api/dist/sim-user-data-relay.js");
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  registerSimUserDataRelay(relayApp, { owner: "cop-sim-clean-whole-20261017", target: "http://127.0.0.1:4314" });
  if (saved === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = saved;
  relay = await serve(relayApp);
  const via = "http://127.0.0.1:" + relay.address().port;
  check((await request(via, prefix + "/capabilities")).status === 401, "relay does not add service authority");
  check(
    (await request(via, prefix + "/capabilities", { headers: { authorization: "Bearer " + u.copToken } })).body.ready === true,
    "actual relay capability main+AI"
  );
  check((await request(via, prefix + "/capabilities?x=1", { headers: { authorization: "Bearer " + u.copToken } })).status === 404, "no query proxy");
  check((await request(via, prefix + "/other", { headers: { authorization: "Bearer " + u.copToken } })).status === 404, "no other proxy path");
  check(
    (await request(via, prefix + "/capabilities", { headers: { authorization: "Bearer " + u.copToken, origin: "https://browser.invalid" } })).status === 404,
    "no browser relay"
  );
  check((await request(base, "/api/v1/scenarios")).status === 401, "actual UI requires OIDC");
  check(
    (await request(base, "/api/v1/scenarios", { headers: userHeaders("a", { subject: "display-only" }) })).status === 503,
    "noncanonical OIDC subject cannot acquire an owner"
  );
  check(
    (await request(base, "/api/v1/scenarios", { headers: userHeaders("a", { issuer: "https://wrong.invalid" }) })).status === 401,
    "actual issuer verification"
  );
  check((await request(base, "/api/v1/scenarios", { headers: userHeaders("a", { iat: b.tokensNotBefore }) })).status === 503, "original OIDC cutoff");
  const payload = {
    name: "Synthetic private test",
    description: "Fictional civil data owned by the verified actor.",
    area: { type: "BBOX", bbox: [14, 49.8, 15, 50.3] },
    durationSeconds: 60,
    seed: 17,
    blocks: [{ blockId: "rescue-sim", enabled: true, objectCount: 1, updateRateHz: 1 }],
    faults: [],
    metadata: { owner: "untrusted-browser-owner" }
  };
  const ids = {};
  for (const name of ["a", "b"]) {
    const created = await request(base, "/api/v1/scenarios", { method: "POST", headers: userHeaders(name), body: payload });
    check(created.status === 201, "actual owner-scoped scenario write");
    ids[name] = created.body.scenarioId;
    const draft = await request(base, "/api/v1/ai/router-scenario-drafts", {
      method: "POST",
      headers: userHeaders(name),
      body: { prompt: "Fictional civil flood exercise only", syntheticOnly: true }
    });
    check(draft.status === 201, "actual model-derived user draft");
    const list = await request(base, "/api/v1/scenarios", { headers: userHeaders(name) });
    check(list.body.items.length === 1 && list.body.items[0].scenarioId === ids[name], "same display name does not merge owner namespace");
  }
  const changed = await request(base, "/api/v1/scenarios", { headers: userHeaders("a", { user: "renamed-display-user" }) });
  check(changed.body.items[0].scenarioId === ids.a, "changed display name preserves canonical ownership");
  check((await request(base, "/api/v1/scenarios/" + ids.a, { headers: userHeaders("b") })).status === 404, "B cannot read A namespaced scenario");
  check(
    (await request(base, "/api/v1/scenarios/" + ids.a + "/start", { method: "POST", headers: userHeaders("a"), body: {} })).status === 200,
    "actual runtime and publisher start under owner lock"
  );
  await new Promise((r) => setTimeout(r, 1200));
  const first = await main.read();
  check(first.actors.a.counts.scenarios === 1 && first.actors.b.counts.scenarios === 1, "actual stored A/B scenario counts");
  check(first.actors.a.counts.drafts === 1 && first.actors.b.counts.drafts === 1, "actual stored A/B drafts");
  check(first.actors.a.counts.publisher > 0, "actual derived publisher rows owned");
  const key = (name) => canonicalOwnerKey(u.ownerSecret, { issuer: b.issuer, subject: actors[name].subjectId });
  const fileSnapshot = testCompletedReplay ? await main.ledger.withOwner(key("a"), async () => {
    const directory = join(main.settings.root, b.resetEpoch, key("a"));
    const data = {};
    for (const name of ["sim-store.json", "publisher-queue.json", "sim-audit.jsonl", ".owner-scope.json"]) data[name] = await readFile(join(directory, name));
    return data;
  }) : undefined;
  const fileB = join(main.settings.root, b.resetEpoch, key("b"), "sim-store.json");
  const beforeB = createHash("sha256")
    .update(await readFile(fileB))
    .digest("hex");
  const hA = ai.store.hashUser("sim", simOwnerAlias(key("a"))),
    hB = ai.store.hashUser("sim", simOwnerAlias(key("b")));
  check(
    Number((await ai.runtime.query("SELECT count(*) n FROM ai_router_request WHERE client_id='sim' AND user_hash=$1", [hA])).rows[0].n) === 1,
    "actual SIM history belongs to canonical A alias"
  );
  check(
    Number((await ai.runtime.query("SELECT count(*) n FROM ai_router_request WHERE client_id='sim' AND user_hash=$1", [hB])).rows[0].n) === 1,
    "actual SIM history belongs to canonical B alias"
  );
  const beforeBudget = await ai.store.usage();
  const op = { operationId: randomUUID(), requestedAt: new Date().toISOString() },
    body = { contractVersion: "cop-sim-user-data-v1", scope: "cop_sim_shared_identity_v1", resetEpoch: b.resetEpoch, ...op };
  const bad = appDeletionHeaders(input, "a", op);
  bad["x-cop-clean-actor-signature"] = "0".repeat(64);
  check((await request(via, prefix + "/deletions", { method: "POST", headers: bad, body })).status === 401, "new component rejects forged service actor");
  check(
    (await request(via, prefix + "/deletions", { method: "POST", headers: appDeletionHeaders(input, "a", op), body: { ...body, scope: "cop_account_only" } }))
      .status === 400,
    "old scope is not promoted"
  );
  const result = await request(via, prefix + "/deletions", { method: "POST", headers: appDeletionHeaders(input, "a", op), body });
  check(result.status === 202 && result.body.state === "deletion_pending", "actual durable fence before 202");
  check((await request(base, "/api/v1/scenarios", { headers: userHeaders("a") })).status === 503, "deleted/pending A cannot restart actual app");
  check((await request(via, prefix + "/deletions/" + op.operationId, { headers: appDeletionHeaders(input, "b", op) })).status === 404, "status owner-bound");
  const until = Date.now() + 14000;
  let status;
  do {
    status = await request(via, prefix + "/deletions/" + op.operationId, { headers: appDeletionHeaders(input, "a", op) });
    if (status.body?.state === "deleted") break;
    await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < until);
  check(status.status === 200 && status.body.state === "deleted", "actual combined worker/readback complete");
  {
    const req = createRequire(join(source, "apps/simulator-api/package.json"));
    const Ajv = req("ajv/dist/2020.js").default,
      ajv = new Ajv({ strict: false });
    req("ajv-formats")(ajv);
    const schemas = JSON.parse(await readFile(join(source, "openapi/fragments/sim-user-data-v1.openapi.json"), "utf8")).components.schemas;
    const valid = ajv.compile(schemas.Receipt);
    check(valid(result.body) === true, "actual pending response matches binding schema");
    check(valid(status.body) === true, "actual deleted response matches binding schema");
    check(valid({ ...status.body, wholeAccountComplete: true }) === false, "contract rejects invented whole-account acceptance");
    check(
      valid({ ...status.body, subcomponents: { app_store: "deleted", audit_and_publisher: "deleted" } }) === false,
      "contract requires all three explicit subcomponents"
    );
  }
  check(status.cache === "no-store", "fresh no-store receipt");
  check(
    Object.keys(status.body.subcomponents).length === 3 &&
      Object.values(status.body.subcomponents).every((x) => x === "deleted") &&
      status.body.wholeAccountComplete === false,
    "three actual subcomponents, not global whole claim"
  );
  const after = await main.read();
  check(Object.values(after.actors.a.counts).every((n) => n === 0) && after.actors.a.state === "deleted", "A app/audit/publisher files absent");
  check(
    createHash("sha256")
      .update(await readFile(fileB))
      .digest("hex") === beforeB,
    "B actual app bytes preserved"
  );
  check(
    Number((await ai.runtime.query("SELECT count(*) n FROM ai_router_request WHERE client_id='sim' AND user_hash=$1", [hA])).rows[0].n) === 0,
    "A SIM history absent"
  );
  check(
    Number((await ai.runtime.query("SELECT count(*) n FROM ai_router_request WHERE client_id='sim' AND user_hash=$1", [hB])).rows[0].n) === 1,
    "B SIM history preserved"
  );
  const afterBudget = await ai.store.usage();
  check(
    beforeBudget.dailyRequests === afterBudget.dailyRequests &&
      beforeBudget.dailyInputTokens === afterBudget.dailyInputTokens &&
      beforeBudget.dailyOutputTokens === afterBudget.dailyOutputTokens,
    "anonymous finance/token totals preserved exactly"
  );
  check(
    (await request(via, prefix + "/deletions", { method: "POST", headers: appDeletionHeaders(input, "a", op), body })).status === 200,
    "idempotent combined completion remains readback checked"
  );
  const lateHeaders = {
    authorization: "Bearer " + b.environment.routerSimToken,
    "content-type": "application/json",
    ...signSimOwner(u.routerActorSecret, { ownerKey: key("a"), resetEpoch: b.resetEpoch, oidcIat: actors.a.oidcIat })
  };
  check(
    (
      await request(ai.api, "/api/v1/ai-router/generate", {
        method: "POST",
        headers: lateHeaders,
        body: { taskType: "sim_scenario", userId: simOwnerAlias(key("a")) }
      })
    ).status === 503,
    "late canonical AI writer fenced"
  );
  check((await request(base, "/api/v1/scenarios", { method: "POST", headers: userHeaders("a"), body: payload })).status === 503, "late main writer fenced");
  check((await request(base, "/api/v1/scenarios", { headers: userHeaders("b") })).status === 200, "B actual normal UI remains usable");
  if (testCompletedReplay) {
    const originalJob = JSON.stringify((await main.pool.query("SELECT to_jsonb(j) row FROM sim_user_data.job j WHERE owner_key=$1", [key("a")])).rows);
    await close(http); http = undefined;
    const directory = join(main.settings.root, b.resetEpoch, key("a"));
    await main.close(); main = undefined;
    await mkdir(directory, { mode: 0o700 });
    for (const [name, bytes] of Object.entries(fileSnapshot)) await writeFile(join(directory, name), bytes, { mode: 0o600, flag: "wx" });
    check((await readdir(directory)).length === 4, "four actual nonzero restored main files");
    process.env.SIM_USER_DATA_COMPLETED_REPLAY_MODE = "same-epoch-completed-content-replay-v1";
    main = await startCleanWholeApp(db, input, { jwksUri: "http://127.0.0.1:" + jwks.address().port + "/certs", routerUrl: ai.api });
    http = await serve(main.app, 4314);
    check((await request(via, prefix + "/deletions/" + op.operationId, { headers: appDeletionHeaders(input, "a", op) })).status === 503, "restored main content cannot reuse old completion receipt");
    await main.tick();
    check((await request(via, prefix + "/deletions/" + op.operationId, { headers: appDeletionHeaders(input, "a", op) })).body.state === "deleted", "actual main worker removes restored content with original operation");
    await assert.rejects(readdir(directory), { code: "ENOENT" }); checks++;
    check(JSON.stringify((await main.pool.query("SELECT to_jsonb(j) row FROM sim_user_data.job j WHERE owner_key=$1", [key("a")])).rows) === originalJob, "main original journal unchanged");
    check(createHash("sha256").update(await readFile(fileB)).digest("hex") === beforeB, "main replay preserves actual B bytes");
    const replayBudget = await ai.store.usage();
    check(replayBudget.dailyRequests === afterBudget.dailyRequests && replayBudget.dailyInputTokens === afterBudget.dailyInputTokens, "main replay does not repeat history finance rollup");
  }
  check(ai.guard.attempts === 0, "external provider attempts zero");
  check(
    (
      await main.pool.query(
        "SELECT count(*) n FROM information_schema.columns WHERE table_schema='sim_user_data' AND column_name IN('subject','email','username','prompt','content')"
      )
    ).rows[0].n === "0",
    "registry does not retain raw account/text columns"
  );
  // Known empty partial initialization, as after a process loss between the
  // durable owner nonce and first files. Never adopt an unknown nonempty dir.
  const partialSubject = randomUUID(),
    unknownSubject = randomUUID();
  for (const subject of [partialSubject, unknownSubject]) {
    const owner = canonicalOwnerKey(u.ownerSecret, { issuer: b.issuer, subject });
    const a = (
      await main.pool.query("INSERT INTO sim_user_data.account(owner_key,reset_epoch) VALUES($1,$2) RETURNING initialization_id", [owner, b.resetEpoch])
    ).rows[0];
    const dir = join(main.settings.root, b.resetEpoch, owner);
    await mkdir(dir, { mode: 0o700 });
    await writeFile(
      join(dir, ".owner-scope.json"),
      JSON.stringify({
        contractVersion: "sim-user-owned-directory-v1",
        environmentId: b.environmentId,
        resetEpoch: b.resetEpoch,
        ownerKey: owner,
        initializationId: a.initialization_id
      }),
      { mode: 0o600 }
    );
    if (subject === unknownSubject) await writeFile(join(dir, "unreviewed.bin"), "synthetic unknown content", { mode: 0o600 });
  }
  await close(http);
  http = undefined;
  await main.close();
  main = await startCleanWholeApp(db, input, { jwksUri: "http://127.0.0.1:" + jwks.address().port + "/certs", routerUrl: ai.api });
  http = await serve(main.app, 4314);
  check(
    (await request(base, "/api/v1/scenarios", { headers: userHeaders("a", { subject: partialSubject }) })).status === 200,
    "actual app restart recovers only proven empty initialization"
  );
  check(
    (await request(base, "/api/v1/scenarios", { headers: userHeaders("a", { subject: unknownSubject }) })).status === 503,
    "actual restart refuses unknown partially initialized content"
  );
  check(
    (await request(base, "/api/v1/scenarios", { headers: userHeaders("a") })).status === 503,
    "deleted canonical owner remains fenced after actual app restart"
  );
  check((await request(base, "/api/v1/scenarios", { headers: userHeaders("b") })).status === 200, "other account remains usable after actual app restart");
  check(
    (await request(via, prefix + "/deletions/" + op.operationId, { headers: appDeletionHeaders(input, "a", op) })).body.state === "deleted",
    "restart completion requires fresh main and Router readback"
  );
  await testUserContinuity({ db, main, ai, input, Pool: createRequire(join(source, "apps/simulator-api/package.json"))("pg").Pool, check });
  console.log(
    JSON.stringify({
      contractVersion: "cop-sim-user-data-component-proof-v1",
      checks,
      actualOidcSignatureVerification: true,
      actualPostgres: true,
      actualMainRouterAndRelayHttp: true,
      allThreeSubcomponentsReadback: true,
      completedMainContentReplay: testCompletedReplay,
      restoredMainFiles: testCompletedReplay ? 4 : 0,
      completedHistoryContentReplay: false,
      externalProviderAttempts: 0,
      productionWrites: 0,
      actualKeycloakDeletionTested: false,
      realRootAdmission: false,
      wholeCopAccepted: false
    })
  );
  passed = true;
} finally {
  if (relay) await close(relay);
  if (http) await close(http);
  await main?.close();
  if (jwks) await close(jwks);
  await ai?.close();
  await db?.close();
  if (started) {
    owned();
    await exec(join(bin, "pg_ctl"), ["-D", join(root, "db"), "-m", "fast", "-w", "stop"], { env });
  }
  if (passed) {
    owned();
    await rm(root, { recursive: true, force: true });
  }
  process.umask(previousUmask);
  if (originalReplayMode === undefined) delete process.env.SIM_USER_DATA_COMPLETED_REPLAY_MODE;
  else process.env.SIM_USER_DATA_COMPLETED_REPLAY_MODE = originalReplayMode;
}
