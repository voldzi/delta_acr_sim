import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { inspectResetFiles, purgeResetFiles as purgeFileOperation, FILE_PREFIXES } from "./lib/clean-reset-files.mjs";
import { stoppedWriters } from "./lib/clean-reset-ops.mjs";
const images = { "csm-sim-ai-router-api": "sha256:" + "a".repeat(64), "csm-sim-situation-data-api": "sha256:" + "b".repeat(64) };
const writerReceipt = await stoppedWriters(
  async (name) => ({ Name: "/" + name, Id: "c".repeat(64), Image: images[name], State: { Running: false, Restarting: false, Status: "exited" } }),
  images
);
const purgeResetFiles = (options) => purgeFileOperation({ ...options, writerReceipt });
const root = mkdtempSync("/private/tmp/sim-clean-reset-files-");
const gate = { withResetAdmission: async (_c, work) => work({ assertCurrent: async () => {}, assertReportProducersStopped: async () => {} }) };
let checks = 0;
try {
  for (const p of Object.values(FILE_PREFIXES)) mkdirSync(join(root, p), { recursive: true, mode: 0o700 });
  const routes = join(root, FILE_PREFIXES.routes),
    reports = join(root, FILE_PREFIXES.reports);
  const cop = join(routes, "a".repeat(64) + ".json"),
    other = join(routes, "b".repeat(64) + ".json");
  const value = (actor) => JSON.stringify({ actor, requestHash: "c".repeat(64), response: { synthetic: true } }) + "\n";
  writeFileSync(cop, value("cop"));
  writeFileSync(other, value("sim"));
  writeFileSync(join(reports, "quality.json"), "{}");
  let plan = inspectResetFiles({ syntheticRoot: root });
  assert.equal(plan.counts.copRoutes, 1);
  checks++;
  await assert.rejects(purgeFileOperation({ syntheticRoot: root, reviewedPlan: plan, rootGate: gate }), /RESET_WRITERS_RECEIPT_REQUIRED/);
  checks++;
  await assert.rejects(purgeResetFiles({ syntheticRoot: root, reviewedPlan: plan, rootGate: {} }));
  checks++;
  await assert.rejects(
    purgeResetFiles({ syntheticRoot: root, reviewedPlan: plan, rootGate: { withResetAdmission: async () => ({ fake: true }) } }),
    /RESET_ADMISSION_DID_NOT_COMPLETE_WORK/
  );
  checks++;
  const early = {
    withResetAdmission: async (_c, work) => {
      void work({ assertCurrent: async () => {}, assertReportProducersStopped: async () => {} }).catch(() => {});
      return { fake: true };
    }
  };
  await assert.rejects(purgeResetFiles({ syntheticRoot: root, reviewedPlan: plan, rootGate: early }), /RESET_ADMISSION_CLOSED/);
  checks++;
  assert.equal(readFileSync(cop, "utf8"), value("cop"));
  checks++;
  symlinkSync(other, join(reports, "aggregates.json"));
  assert.throws(() => inspectResetFiles({ syntheticRoot: root }), /RESET_UNKNOWN_FILE/);
  checks++;
  unlinkSync(join(reports, "aggregates.json"));
  mkdirSync(join(reports, ".publication-lock"));
  assert.throws(() => inspectResetFiles({ syntheticRoot: root }), /RESET_UNKNOWN_FILE/);
  checks++;
  rmSync(join(reports, ".publication-lock"), { recursive: true });
  writeFileSync(join(reports, "do-not-delete.env"), "synthetic");
  assert.throws(() => inspectResetFiles({ syntheticRoot: root }), /RESET_UNKNOWN_REPORT_FILE/);
  checks++;
  unlinkSync(join(reports, "do-not-delete.env"));
  plan = inspectResetFiles({ syntheticRoot: root });
  const result = await purgeResetFiles({ syntheticRoot: root, reviewedPlan: plan, rootGate: gate });
  assert.equal(result.remaining.copRoutes, 0);
  checks++;
  assert.equal(result.remaining.reports, 0);
  checks++;
  assert.equal(readFileSync(other, "utf8"), value("sim"));
  checks++;
  const again = await purgeResetFiles({ syntheticRoot: root, reviewedPlan: inspectResetFiles({ syntheticRoot: root }), rootGate: gate });
  assert.equal(again.deletedCounts.deleteBytes, 0);
  checks++;
  console.log(JSON.stringify({ contractVersion: "sim-clean-reset-files-v1", checks, productionFilesChanged: 0, realRootAdmission: false }));
} finally {
  rmSync(root, { recursive: true });
}
