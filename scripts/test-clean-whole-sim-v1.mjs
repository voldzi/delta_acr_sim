/** Fresh owned PG + actual compiled SIM factories + real HTTP. No KC/native
 * or production acceptance is inferred. Private input generated locally in RAM
 * for this local test; no private data transferred to another host/path. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, chmod, rm, readFile } from "node:fs/promises";
import { statSync, realpathSync } from "node:fs";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FIXTURE_CONTRACT,
  READBACK_CONTRACT,
  FIXTURE_CLUSTER,
  SCOPE,
  makeCleanWholeInput,
  validateCleanWholeInput,
  createCleanWholeDatabase,
  provisionCleanWhole,
  startCleanWholeComponent,
  seedCleanWhole,
  cleanFixtureHeaders,
  readCleanWhole,
  forbidExternalFixtureFetch
} from "./fixtures/clean-whole-sim-v1.mjs";
assert.equal(process.argv.length, 3);
assert.equal(process.argv[2], "--run");
const execute = promisify(execFile),
  bin = "/opt/homebrew/opt/postgresql@18/bin",
  source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"].includes(k)));
assert.match((await execute(join(bin, "postgres"), ["--version"], { env })).stdout, /PostgreSQL\) 18\.3/);
const priorUmask = process.umask(0o077),
  root = await mkdtemp("/private/tmp/sim-clean-whole-pg-");
await chmod(root, 0o700);
await mkdir(join(root, "s"), { mode: 0o700 });
let started = false,
  db,
  passed = false,
  checks = 0;
const instances = [];
const check = (v, label) => {
  assert.ok(v, label);
  checks++;
};
const owned = () => {
  assert.equal(dirname(realpathSync(root)), "/private/tmp");
  assert.equal(statSync(root).uid, process.getuid());
  assert.equal(statSync(root).mode & 0o777, 0o700);
};
const hash = (x) => createHash("sha256").update(x).digest("hex");
const oldPaths = [
  "scripts/fixtures/whole-erasure-sim-fixture.mjs",
  "scripts/fixtures/whole-erasure-sim-fixture.py",
  "scripts/fixtures/whole-erasure-sim-fixture-profile-test.py"
];
const oldPins = await Promise.all(oldPaths.map(async (p) => hash(await readFile(join(source, p)))));
const now = Math.floor(Date.now() / 1000),
  actors = Object.fromEntries(
    ["a", "b"].map((n) => [
      n,
      {
        subjectId: randomUUID(),
        routerUserId: "cop_" + randomBytes(32).toString("base64url"),
        contributorIdDay: randomBytes(32).toString("base64url"),
        oidcIat: now
      }
    ])
  );
const input = makeCleanWholeInput({ actors });
const req = async (base, path, { method = "GET", headers, body } = {}) => {
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000) });
  return { status: r.status, body: await r.json(), cache: r.headers.get("cache-control") };
};
try {
  owned();
  for (const changed of [
    { ...input, contractVersion: "cop-sim-whole-erasure-fixture-v1" },
    { ...input, issuer: input.issuer.replace("/cop", "/other") },
    { ...input, environment: { ...input.environment, extra: "not-allowed" } },
    { ...input, actors: { ...input.actors, b: { ...input.actors.a } } }
  ]) {
    assert.throws(() => validateCleanWholeInput(changed));
    checks++;
  }
  const block = forbidExternalFixtureFetch();
  assert.throws(() => fetch("https://api.openai.com/v1/responses"));
  check(block.attempts === 1, "network guard denies before fetch");
  block.restore();
  await assert.rejects(createCleanWholeDatabase({ socket: "/tmp/not-owned/s" }));
  checks++;
  await execute(join(bin, "initdb"), ["-D", join(root, "db"), "-U", "owned_fixture_admin", "--auth-local=trust", "--auth-host=reject", "--no-locale"], { env });
  await execute(
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
  check(true, "owned actual cluster identity");
  check((await provisionCleanWhole(db, input)).databases === 2, "fresh two DB provision");
  await assert.rejects(provisionCleanWhole(db, input));
  checks++;
  const roleRows = (
    await db.admin.query("SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=ANY($1)", [
      ["ai_router_runtime", "driver_measurements_runtime"]
    ])
  ).rows;
  check(
    roleRows.length === 2 && roleRows.every((x) => !x.rolsuper && !x.rolcreatedb && !x.rolcreaterole && !x.rolreplication && !x.rolbypassrls),
    "actual restricted roles"
  );
  const baseline = {};
  for (const component of ["ai", "driver"]) {
    const instance = await startCleanWholeComponent(db, input, component, { ephemeralPorts: true });
    instances.push(instance);
    await assert.rejects(instance.runtime.query("CREATE TABLE public.forbidden(i int)"));
    checks++;
    await assert.rejects(instance.runtime.query("UPDATE sim_clean.config SET reset_epoch=$1", [randomUUID()]));
    checks++;
    check((await seedCleanWhole(instance)).status === "seeded-via-actual-handler", "actual bootstrap and ordinary seed");
    const lifecycle = component === "ai" ? "/api/v1/ai-router/internal/user-lifecycle/v1" : "/api/v1/internal/user-lifecycle/v1";
    check((await req(instance.api, lifecycle + "/capabilities")).status === 401, "capability requires token");
    check(
      (await req(instance.api, lifecycle + "/capabilities", { headers: { authorization: "Bearer " + input.environment.copServiceToken } })).body.ready === true,
      "actual ready capability"
    );
    const ordinary = component === "ai" ? "/api/v1/ai-router/generate" : "/api/v1/internal/driver-measurements/v1/batches";
    check(
      (
        await req(instance.api, ordinary, {
          method: "POST",
          headers: { authorization: "Bearer " + input.environment.copServiceToken, "content-type": "application/json" },
          body: component === "ai" ? { taskType: "cop_chat" } : {}
        })
      ).status === 401,
      "normal writes require clean actor"
    );
    check((await req(instance.readback, "/readback")).status === 401, "readback no token");
    check((await req(instance.readback, "/readback", { headers: { authorization: "Bearer bad" } })).status === 401, "readback wrong token");
    for (const [path, options] of [
      ["/readback?query=x", {}],
      ["/readback/other", {}],
      ["/readback", { method: "POST" }],
      ["/readback", { headers: { origin: "https://browser.invalid" } }]
    ]) {
      check(
        (await req(instance.readback, path, { ...options, headers: { authorization: "Bearer " + input.environment.copServiceToken, ...options.headers } }))
          .status === 404,
        "readback closed shape"
      );
    }
    const first = await req(instance.readback, "/readback", { headers: { authorization: "Bearer " + input.environment.copServiceToken } });
    check(first.status === 200 && first.cache === "no-store", "actual authenticated readback");
    check(
      first.body.contractVersion === READBACK_CONTRACT && first.body.resetEpoch === input.resetEpoch && first.body.scope === SCOPE,
      "new contract/epoch/scope"
    );
    check(!first.body.wholeAccountComplete && !first.body.wholeCopAccepted && !first.body.productionChanged, "component does not claim whole");
    const owner = component === "ai" ? "ai_router" : "sim_measurements",
      state = first.body.owners[owner];
    check(state.removableA === 4 && state.removableB === state.removableA, "actual A/B removable counts");
    check(state.stateA === "active" && state.stateB === "active" && /^[0-9a-f]{64}$/.test(state.preservedBFingerprint), "two active owners and B digest");
    if (component === "driver") check(first.body.applicationMode === "shadow_only", "driver never live speeds");
    for (const privateValue of [
      ...Object.values(input.environment),
      actors.a.subjectId,
      actors.b.subjectId,
      actors.a.routerUserId,
      actors.b.routerUserId,
      actors.a.contributorIdDay,
      actors.b.contributorIdDay
    ])
      check(!JSON.stringify(first.body).includes(privateValue), "no private identity/secret in readback");
    const rows = await instance.runtime.query(
      component === "driver" ? "SELECT receipt FROM driver_measurement_receipts" : "SELECT ciphertext,nonce,auth_tag FROM ai_router_user_key"
    );
    if (component === "driver") check(!/"lat"|"lon"|"points"/.test(JSON.stringify(rows.rows)), "no raw GPS in receipt");
    else
      check(
        rows.rows.every((x) => !x.ciphertext.toString().includes("synthetic-not-an-openai-key")),
        "synthetic stored key encrypted"
      );
    const op = { operationId: randomUUID(), requestedAt: new Date().toISOString() },
      body = { contractVersion: "cop-sim-user-lifecycle-v1", scope: SCOPE, resetEpoch: input.resetEpoch, ...op };
    const stale = cleanFixtureHeaders(input, "a", component, { ...op, oidcIat: input.tokensNotBefore });
    check((await req(instance.api, lifecycle + "/deletions", { method: "POST", headers: stale, body })).status === 401, "original oidc iat cutoff enforced");
    const invalid = cleanFixtureHeaders(input, "a", component, op);
    invalid["x-cop-clean-actor-signature"] = "0".repeat(64);
    check((await req(instance.api, lifecycle + "/deletions", { method: "POST", headers: invalid, body })).status === 401, "invalid HMAC");
    check(
      (
        await req(instance.api, lifecycle + "/deletions", {
          method: "POST",
          headers: cleanFixtureHeaders(input, "a", component, op),
          body: { ...body, scope: "cop_account_only" }
        })
      ).status === 400,
      "old scope cannot be relabelled"
    );
    baseline[component] = { owner, lifecycle, op, body, fingerprint: state.preservedBFingerprint };
  }
  // Both applications are alive concurrently. The real composition worker
  // interval must complete A's requests, not a test-only completion endpoint.
  for (const instance of instances) {
    const { lifecycle, op, body } = baseline[instance.component];
    check(
      (await req(instance.api, lifecycle + "/deletions", { method: "POST", headers: cleanFixtureHeaders(input, "a", instance.component, op), body })).status ===
        202,
      "actual durable request"
    );
    const again = await req(instance.api, lifecycle + "/deletions", { method: "POST", headers: cleanFixtureHeaders(input, "a", instance.component, op), body });
    check([200, 202].includes(again.status), "request idempotent");
    check(
      (await req(instance.api, lifecycle + "/deletions/" + op.operationId, { headers: cleanFixtureHeaders(input, "b", instance.component, op) })).status ===
        404,
      "B cannot inspect A operation"
    );
  }
  const deadline = Date.now() + 22000;
  while (Date.now() < deadline) {
    let complete = true;
    for (const instance of instances) {
      const p = baseline[instance.component],
        r = await req(instance.api, p.lifecycle + "/deletions/" + p.op.operationId, { headers: cleanFixtureHeaders(input, "a", instance.component, p.op) });
      complete &&= r.status === 200 && r.body.state === "deleted";
    }
    if (complete) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  for (const instance of instances) {
    const { component } = instance,
      { owner, lifecycle, op, body, fingerprint } = baseline[component];
    const status = await req(instance.api, lifecycle + "/deletions/" + op.operationId, { headers: cleanFixtureHeaders(input, "a", component, op) });
    check(status.status === 200 && status.body.state === "deleted", "real periodic cleanup completed");
    check(!status.body.wholeAccountComplete, "SIM receipt remains component only");
    const out = await readCleanWhole(instance),
      state = out.owners[owner];
    check(state.removableA === 0 && state.stateA === "deleted", "actual A data absent");
    check(state.removableB === 4 && state.stateB === "active" && state.preservedBFingerprint === fingerprint, "actual B rows unchanged");
    check(out.externalProviderAttempts === 0, "no external attempts in actual flow");
    const latePath = component === "ai" ? "/api/v1/ai-router/generate" : "/api/v1/internal/driver-measurements/v1/batches";
    const lateBody = component === "ai" ? { userId: actors.a.routerUserId, taskType: "cop_chat" } : { contributorIdDay: actors.a.contributorIdDay };
    check(
      (await req(instance.api, latePath, { method: "POST", headers: cleanFixtureHeaders(input, "a", component, op), body: lateBody })).status === 503,
      "deleted A cannot resume ordinary write"
    );
    check(
      (await req(instance.api, lifecycle + "/deletions", { method: "POST", headers: cleanFixtureHeaders(input, "a", component, op), body })).status === 200,
      "deleted request durable idempotence"
    );
    const pools = await instance.runtime.query("SELECT count(*) AS n FROM sim_clean.resource");
    check(Number(pools.rows[0].n) === 2, "original immutable owner resources stay fenced");
  }
  for (let i = 0; i < oldPaths.length; i++) check(hash(await readFile(join(source, oldPaths[i]))) === oldPins[i], "old CF24 fixtures unchanged");
  console.log(
    JSON.stringify({
      contractVersion: FIXTURE_CONTRACT,
      readbackContract: READBACK_CONTRACT,
      checks,
      actualCompiledBootstraps: 2,
      actualAutomaticWorkers: 2,
      actualPostgres: true,
      restrictedRuntimeRoles: 2,
      scope: SCOPE,
      mode: "isolated-clean-lifecycle-v1",
      externalProviderAttempts: 0,
      productionWrites: 0,
      rootIdentityDeletionTested: false,
      wholeCopAccepted: false,
      privateFixtureTransferred: false
    })
  );
  passed = true;
} finally {
  for (const instance of instances.reverse()) await instance.close().catch(() => {});
  await db?.close();
  if (started) {
    owned();
    await execute(join(bin, "pg_ctl"), ["-D", join(root, "db"), "-m", "fast", "-w", "stop"], { env });
  }
  if (passed) {
    owned();
    await rm(root, { recursive: true, force: true });
  }
  process.umask(priorUmask);
}
