import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { inspectSimAppReset, resetSimAppFiles } from "./lib/sim-user-data-reset-files.mjs";
const root = mkdtempSync("/private/tmp/sim-app-reset-"),
  image = "sha256:" + "a".repeat(64);
const gate = { withResetAdmission: async (_c, work) => work({ assertCurrent: async () => {} }) };
const inspectMain = async () => ({ Name: "/csm-sim-api", Image: image, State: { Running: false, Restarting: false, Status: "exited" } });
let checks = 0;
const check = (v) => {
  assert.ok(v);
  checks++;
};
try {
  const config = { providerMode: "mock", externalProviderAllowed: false };
  writeFileSync(
    join(root, "sim-store.json"),
    JSON.stringify({
      scenarios: [{ synthetic: true }],
      drafts: [{ synthetic: true }],
      runtime: { state: "RUNNING", scenarioId: "synthetic" },
      aiConfig: config
    })
  );
  const queue = {
    items: [{ synthetic: true }], publishingEnabled: false,
    lastSuccessAt: "2026-10-18T08:00:00.000Z", lastFailureAt: "2026-10-18T08:01:00.000Z"
  };
  const queuePath = join(root, "publisher-queue.json");
  writeFileSync(join(root, "sim-audit.jsonl"), "synthetic-only\n");
  for (const invalid of [
    { ...queue, unknown: "not permitted" },
    { ...queue, lastSuccessAt: null },
    { ...queue, lastFailureAt: "2026-02-30T08:00:00.000Z" },
    { ...queue, lastSuccessAt: "2026-10-18T08:00:00Z" }
  ]) {
    writeFileSync(queuePath, JSON.stringify(invalid));
    assert.throws(() => inspectSimAppReset({ syntheticRoot: root }));
    check(true);
  }
  writeFileSync(queuePath, JSON.stringify(queue));
  mkdirSync(join(root, "operational-checks"));
  writeFileSync(join(root, "operational-checks", "preserve"), "official configuration");
  const plan = inspectSimAppReset({ syntheticRoot: root }),
    opts = { syntheticRoot: root, reviewedPlan: plan, rootGate: gate, expectedMainImage: image, inspectMain };
  check(plan.counts.scenarios === 1 && plan.counts.drafts === 1 && plan.counts.publisher === 1);
  await assert.rejects(() => resetSimAppFiles({ ...opts, rootGate: {} }));
  check(true);
  await assert.rejects(() => resetSimAppFiles({ ...opts, inspectMain: async () => ({ ...(await inspectMain()), State: { Running: true } }) }));
  check(true);
  await assert.rejects(() => resetSimAppFiles({ ...opts, reviewedPlan: { ...plan, planDigest: "0".repeat(64) } }));
  check(true);
  const r = await resetSimAppFiles(opts);
  check(Object.values(r.remaining).every((n) => n === 0));
  check(JSON.stringify(JSON.parse(readFileSync(join(root, "sim-store.json"))).aiConfig) === JSON.stringify(config));
  check(JSON.parse(readFileSync(join(root, "publisher-queue.json"))).publishingEnabled === false);
  check(Object.keys(JSON.parse(readFileSync(queuePath))).sort().join(",") === "items,publishingEnabled");
  check(readFileSync(join(root, "operational-checks", "preserve"), "utf8") === "official configuration");
  unlinkSync(join(root, "sim-audit.jsonl"));
  symlinkSync(join(root, "operational-checks", "preserve"), join(root, "sim-audit.jsonl"));
  assert.throws(() => inspectSimAppReset({ syntheticRoot: root }));
  check(true);
  console.log(JSON.stringify({ contractVersion: "sim-app-test-reset-v2", checks, productionWrites: 0, realRootAdmission: false }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
