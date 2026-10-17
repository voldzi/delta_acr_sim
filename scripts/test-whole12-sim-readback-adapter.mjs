/** Local synthetic HTTP/contract tests only; no actual namespace/DB deletion. */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { join } from "node:path";
import { makeCleanWholeInput } from "./fixtures/clean-whole-sim-v1.mjs";
import { makeCleanWholeAppInput } from "./fixtures/clean-whole-sim-user-data-v2.mjs";
import { runtimeIdentityFingerprint } from "../packages/sim-user-data/bootstrap.mjs";
import { createWhole12SimReadbackAdapter } from "./fixtures/whole12-sim-readback-adapter.mjs";
assert.deepEqual(process.argv.slice(2), ["--run"]);
const secret = () => randomBytes(32).toString("base64url");
const actors = Object.fromEntries(
  ["a", "b"].map((n) => [n, { subjectId: randomUUID(), routerUserId: "cop_" + secret(), contributorIdDay: secret(), oidcIat: Math.floor(Date.now() / 1000) }])
);
const input = makeCleanWholeAppInput(makeCleanWholeInput({ actors })),
  b = input.base,
  u = input.userDataEnvironment;
for (const a of Object.values(b.actors))
  a.routerUserId = "cop_" + createHmac("sha256", b.environment.routerHashSecret).update("cop-router-chat-v1\0").update(a.subjectId).digest("base64url");
const identities = {
  sim_user_data: { ownerSecret: u.ownerSecret, actorSecret: u.copActorSecret, routerActorSecret: u.routerActorSecret, issuer: b.issuer },
  sim_user_history: { hashSecret: b.environment.routerHashSecret, actorSecret: u.routerActorSecret, issuer: b.issuer }
};
const cfg = {
  input,
  bindings: Object.fromEntries(
    Object.entries(identities).map(([name, identity]) => [
      name,
      {
        reset_epoch: b.resetEpoch,
        environment_id: b.environmentId,
        guard_store_id: "shared-synthetic",
        identity_sha256: runtimeIdentityFingerprint(name, identity),
        source_sha256: "a".repeat(64)
      }
    ])
  ),
  endpoints: { main: "http://127.0.0.1:4314", ai: "http://127.0.0.1:4312", driver: "http://127.0.0.1:4311" }
};
const umask = process.umask(0o077),
  root = await mkdtemp("/private/tmp/sim-readback-test-"),
  file = join(root, "sim-private.json");
await writeFile(file, JSON.stringify(cfg), { mode: 0o600 });
function raw(owner, lane) {
  const counts = lane === "ai" ? { keys: 1, audit: 1, requests: 1, billing: 1 } : { receipts: 1, intervals: 2, eta: 1, revocations: 0 };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return {
    contractVersion: "cop-clean-whole-readback-v1",
    scope: "cop_sim_shared_identity_v1",
    resetEpoch: b.resetEpoch,
    mode: "isolated-clean-lifecycle-v1",
    component: lane,
    owners: {
      [owner]: {
        removableA: total,
        removableB: total,
        stateA: "active",
        stateB: "active",
        countsA: { ...counts },
        countsB: { ...counts },
        preservedBFingerprint: "b".repeat(64)
      }
    },
    applicationMode: lane === "driver" ? "shadow_only" : undefined,
    externalProviderAttempts: 0,
    productionChanged: false,
    wholeAccountComplete: false,
    wholeCopAccepted: false
  };
}
let driver = raw("sim_measurements", "driver"),
  ai = raw("ai_router", "ai");
let all = {
  sameCompiledProductionBootstrap: true,
  actualRootAdmission: false,
  wholeAccountComplete: false,
  externalProviderAttempts: 0,
  driver,
  ai,
  appOwners: { a: { state: "active", fileCount: 4, fingerprint: "c".repeat(64) }, b: { state: "active", fileCount: 4, fingerprint: "d".repeat(64) } },
  simHistory: {
    a: { state: "active", requests: 1, billing: 0, fingerprint: "e".repeat(64) },
    b: { state: "active", requests: 1, billing: 0, fingerprint: "f".repeat(64) }
  }
};
let status = 200,
  noStore = true,
  oversize = false,
  requests = 0,
  checks = 0;
const servers = [];
const check = (x) => {
  assert.ok(x);
  checks++;
};
try {
  for (const port of [4321, 4322, 4324]) {
    const s = createServer((q, r) => {
      assert.equal(q.method, "GET");
      assert.equal(q.url, "/readback");
      assert.equal(q.headers.authorization, "Bearer " + b.environment.copServiceToken);
      requests++;
      r.statusCode = status;
      if (noStore) r.setHeader("cache-control", "no-store");
      r.end(oversize ? "x".repeat(131073) : JSON.stringify(port === 4321 ? driver : port === 4322 ? ai : all));
    });
    await new Promise((resolve, reject) => {
      s.once("error", reject);
      s.listen(port, "127.0.0.1", resolve);
    });
    servers.push(s);
  }
  const adapter = await createWhole12SimReadbackAdapter(file),
    seed = await adapter.seed();
  check(seed.seedWritesPerformed === false && Object.keys(seed.owners).length === 3);
  check(seed.owners.sim_user_data.removableA === 5 && seed.owners.sim_user_data.preservedBFingerprint.length === 64);
  check((await adapter.check(seed)).status === "pending");
  const beforeRequests = requests;
  await assert.rejects(() => adapter.check({ contractVersion: "cop-clean-whole-readback-v1", simPreserved: true }));
  check(requests === beforeRequests);
  for (const [value, owner] of [
    [driver, "sim_measurements"],
    [ai, "ai_router"]
  ]) {
    const x = value.owners[owner];
    x.removableA = 0;
    x.stateA = "deleted";
    for (const k of Object.keys(x.countsA)) x.countsA[k] = 0;
  }
  check((await adapter.check(seed)).status === "pending");
  all.appOwners.a = { state: "deletion_pending", fileCount: 0, fingerprint: "0".repeat(64) };
  check((await adapter.check(seed)).status === "pending");
  all.appOwners.a.state = "deleted";
  all.simHistory.a = { state: "deleted", requests: 0, billing: 0, fingerprint: "1".repeat(64) };
  const completed = await adapter.check(seed);
  check(completed.status === "completed" && completed.aDeleted && completed.bPreserved && completed.wholeAccountComplete === false);
  all.simHistory.b.fingerprint = "2".repeat(64);
  check((await adapter.check(seed)).status === "failed");
  all.simHistory.b.fingerprint = "f".repeat(64);
  status = 503;
  await assert.rejects(() => adapter.readback(), /SOURCE_UNAVAILABLE/);
  checks++;
  status = 200;
  noStore = false;
  await assert.rejects(() => adapter.readback(), /SOURCE_UNAVAILABLE/);
  checks++;
  noStore = true;
  oversize = true;
  await assert.rejects(() => adapter.readback(), /RESPONSE_LIMIT/);
  checks++;
  oversize = false;
  const oldEpoch = driver.resetEpoch;
  driver.resetEpoch = randomUUID();
  await assert.rejects(() => adapter.readback());
  checks++;
  driver.resetEpoch = oldEpoch;
  const original = all.driver;
  all.driver = structuredClone(driver);
  all.driver.owners.sim_measurements.preservedBFingerprint = "3".repeat(64);
  await assert.rejects(() => adapter.readback(), /UNSTABLE/);
  checks++;
  all.driver = original;
  all.simPreserved = true;
  await assert.rejects(() => adapter.readback());
  checks++;
  delete all.simPreserved;
  const savedApp = all.appOwners.a,
    savedHistory = all.simHistory.a;
  all.appOwners.a = { state: "unused", fileCount: 0, fingerprint: "4".repeat(64) };
  all.simHistory.a = { state: "unused", requests: 0, billing: 0, fingerprint: "5".repeat(64) };
  await assert.rejects(() => adapter.seed(), /BASELINE_NOT_SEEDED/);
  checks++;
  all.appOwners.a = savedApp;
  all.simHistory.a = savedHistory;
  await writeFile(file, JSON.stringify({ ...cfg, unexpectedChange: true }), { mode: 0o600 });
  await assert.rejects(() => adapter.readback(), /PRIVATE_CHANGED/);
  checks++;
  console.log(
    JSON.stringify({ checks, localSyntheticHttp: true, methods: ["GET"], actualNamespaceRead: false, deletionsPerformed: 0, wholeAccountComplete: false })
  );
} finally {
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  await rm(root, { recursive: true, force: true });
  process.umask(umask);
}
