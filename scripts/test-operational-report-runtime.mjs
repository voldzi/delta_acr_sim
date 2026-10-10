// Execute offline in the exact candidate image, not against the live report.
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { readOperationalCheckSummary } from "/app/apps/simulator-api/dist/operations-summary.js";

const directory = await mkdtemp("/tmp/operational-report-guard-");
const file = join(directory, "latest.json");
const config = { operationsReportFile: file };
const PRIVATE = "SYNTHETIC_SECRET_MUST_NOT_BE_PUBLISHED";
let checks = 0;
try {
  const missing = await readOperationalCheckSummary(config);
  assert.equal(missing.status, "failed");
  assert.match(missing.summary, /^OPERATIONAL_MONITOR_UNAVAILABLE:/);
  checks++;
  const base = { schemaVersion: "sim-operational-check/v1", status: "ok", summary: "synthetic healthy fixture" };
  await writeFile(file, JSON.stringify({ ...base, finishedAt: new Date().toISOString() }));
  assert.equal((await readOperationalCheckSummary(config)).status, "ok");
  checks++;
  await writeFile(file, JSON.stringify({ ...base, finishedAt: new Date(Date.now() - 901_000).toISOString(), summary: PRIVATE }));
  const stale = await readOperationalCheckSummary(config);
  assert.equal(stale.status, "failed");
  assert.match(stale.summary, /^OPERATIONAL_MONITOR_STALE:/);
  assert.ok(!JSON.stringify(stale).includes(PRIVATE));
  checks++;
  await writeFile(file, JSON.stringify({ ...base, schemaVersion: "invalid", finishedAt: new Date().toISOString(), summary: PRIVATE }));
  const invalid = await readOperationalCheckSummary(config);
  assert.equal(invalid.status, "failed");
  assert.ok(!JSON.stringify(invalid).includes(PRIVATE));
  checks++;
  await writeFile(file, JSON.stringify({ ...base, finishedAt: new Date(Date.now() + 60_000).toISOString(), summary: PRIVATE }));
  assert.match((await readOperationalCheckSummary(config)).summary, /^OPERATIONAL_MONITOR_UNAVAILABLE:/);
  checks++;
  await writeFile(file, JSON.stringify({ ...base, finishedAt: new Date().toISOString(), padding: "x".repeat(128 * 1024) }));
  assert.match((await readOperationalCheckSummary(config)).summary, /^OPERATIONAL_MONITOR_UNAVAILABLE:/);
  checks++;
  console.log(JSON.stringify({ offlineRuntimeChecks: checks, passed: true }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
