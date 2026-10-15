import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { composeArguments, nonErasureEnvironment, retireExactCleanup, verifyStopResume } from "./sim-erasure-runtime-step.mjs";
import { SOURCE_REVISION } from "./inspect-sim-root-inventory.mjs";
const line = "*/15 * * * * /synthetic/driver-measurements-cleanup.sh",
  hash = createHash("sha256").update(line).digest("hex");
test("retire exactly one reviewed cleanup and preserve every unrelated cron byte", () => {
  const original = "MAILTO=synthetic\n0 * * * * /synthetic/other-job\n" + line + "\n# last comment\n",
    p = retireExactCleanup(original, hash);
  assert.equal(p.text, original.replace(line + "\n", ""));
  assert.equal(p.changed, true);
  assert.equal(retireExactCleanup(p.text, hash).changed, false);
});
test("unknown or duplicate measurement cron refuses, never broadly filters", () => {
  assert.throws(() => retireExactCleanup(line + " --new", hash));
  assert.throws(() => retireExactCleanup(line + "\n" + line, hash));
});
test("runtime command starts one exact service without build, pull or dependencies", () => {
  const args = composeArguments(
    ["/srv/sim/docker-compose.yml", "/srv/sim/docker-compose.x5.yml", "/srv/sim/docker-compose.driver-measurements.yml"],
    "/synthetic/source",
    "situation-data-api",
    "start"
  );
  assert.deepEqual(args.slice(-7), ["up", "--detach", "--no-deps", "--no-build", "--pull", "never", "situation-data-api"]);
  assert.ok(args.includes("/srv/sim/docker-compose.driver-measurements.yml"));
  assert.ok(!args.includes("--force-recreate"));
});
test("each service retains its own file set; arbitrary project paths refuse", () => {
  const args = composeArguments(["/srv/sim/docker-compose.yml", "/srv/sim/docker-compose.ai-router.yml"], "/synthetic/source", "ai-router-api", "config");
  assert.ok(args.includes("/srv/sim/docker-compose.ai-router.yml"));
  assert.ok(!args.includes("/srv/sim/docker-compose.driver-measurements.yml"));
  for (const files of [["/srv/cop/docker-compose.yml"], ["/tmp/arbitrary.yml"], []])
    assert.throws(() => composeArguments(files, "/synthetic/source", "ai-router-api", "start"));
});
test("only reviewed erasure and TLS delta excluded; actor and namespace drift remains visible", () => {
  const base = {
    AI_ROUTER_COP_ACTOR_SECRET: "synthetic-preserved",
    AI_ROUTER_USER_HASH_SECRET: "synthetic-hash",
    OPENAI_API_KEY: "synthetic-key",
    AI_ROUTER_DATABASE_URL: "postgresql://synthetic@haproxy.home.cz:5000/sim_ai_router",
    NODE_VERSION: "24.1",
    AI_ROUTER_ACCOUNT_ERASURE_ENABLED: "false"
  };
  const next = {
    ...base,
    NODE_VERSION: "24.2",
    AI_ROUTER_ACCOUNT_ERASURE_ENABLED: "false",
    AI_ROUTER_DATABASE_URL: base.AI_ROUTER_DATABASE_URL + "?sslmode=verify-full&sslrootcert=%2Fapproved.pem",
    SIM_ACCOUNT_ERASURE_AUTHORITY_MODE: "database_v2"
  };
  assert.deepEqual(nonErasureEnvironment(base), nonErasureEnvironment(next));
  assert.notDeepEqual(nonErasureEnvironment(base), nonErasureEnvironment({ ...next, AI_ROUTER_COP_ACTOR_SECRET: "changed" }));
  assert.notDeepEqual(nonErasureEnvironment(base), nonErasureEnvironment({ ...next, AI_ROUTER_USER_HASH_SECRET: "changed" }));
});
test("a crash after exact cron retirement resumes only the same durable transition", () => {
  const sha = (v) => createHash("sha256").update(v).digest("hex"),
    plan = { synthetic: "fixed plan" },
    before = "OTHER=preserve\n" + line + "\n",
    after = retireExactCleanup(before, hash).text;
  const sources = { "/etc/crontab": "unchanged", "/var/spool/cron/crontabs/voldzi": sha(before) };
  const intent = {
    sourceRevision: SOURCE_REVISION,
    planDigest: sha(JSON.stringify(plan)),
    originalInventoryDigest: "a".repeat(64),
    beforeCronDigest: sha(before),
    afterCronDigest: sha(after),
    beforeSources: sources,
    fileCount: 0,
    bytes: 0
  };
  const receipt = { reportInventory: { inventoryDigest: "a".repeat(64), fileCount: 0, bytes: 0 } };
  verifyStopResume(intent, plan, receipt, before, sources);
  verifyStopResume(intent, plan, receipt, after, { ...sources, "/var/spool/cron/crontabs/voldzi": sha(after) });
  assert.throws(() => verifyStopResume(intent, { synthetic: "other plan" }, receipt, after, sources));
  assert.throws(() => verifyStopResume(intent, plan, receipt, after + "# unreviewed\n", sources));
  assert.throws(() => verifyStopResume(intent, plan, receipt, after, { ...sources, "/etc/crontab": "changed" }));
  assert.throws(() => verifyStopResume(intent, plan, { reportInventory: { ...receipt.reportInventory, bytes: 1 } }, after, sources));
});
