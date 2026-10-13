import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { projectDriverEvaluationSnapshot, type DriverEvaluationSnapshot } from "./driver-measurement-evaluation.js";

export interface DriverEvaluationReport extends DriverEvaluationSnapshot {
  intake: { enabled: boolean; revocationEnabled: boolean; accountScope: "cop_managed_with_consent" };
  comparisonMode: "disabled" | "comparison_only";
  liveAppliedGroupCount: 0;
}

const MAX_REPORT_BYTES = 64 * 1024;
const FAILURE = "DRIVER_EVALUATION_PUBLICATION_UNAVAILABLE";

function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length ||
      Reflect.ownKeys(value).some(key => typeof key !== "string" || !keys.includes(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(item => item.get || item.set)) throw new Error(FAILURE);
  return value as Record<string, unknown>;
}

/** Reconstruct every field before writing, even when the caller has a TypeScript type. */
export function projectDriverEvaluationReport(value: unknown): DriverEvaluationReport {
  const report = exact(value, ["contractVersion", "generatedAt", "asOf", "routingDataset", "evaluationWindow", "applicationMode",
    "etaEvidence", "consistency", "retentionDays", "livePromotionSupported", "revocationCoverage", "summary", "limits",
    "intake", "comparisonMode", "liveAppliedGroupCount"]);
  const intake = exact(report.intake, ["enabled", "revocationEnabled", "accountScope"]);
  const summary = exact(report.summary, ["retainedBatchCount", "lastAcceptedAt", "acceptedIntervalCount", "deduplicatedIntervalCount",
    "activeRevocationTombstoneCount", "rejectionCounts", "speed", "eta"]);
  exact(summary.speed, ["evaluatedGroupCount", "currentGroupCount", "historicalGroupCount", "futureGroupCount", "otherDatasetGroupCount",
    "subthresholdGroupCount", "qualityGroupCount", "closedWindowGroupCount", "currentQualityGroupCount", "currentQualityIntervalCount"]);
  if (!Array.isArray(summary.eta)) throw new Error(FAILURE);
  summary.eta.forEach(row => exact(row, ["routingDataset", "windowStart", "attestedContributorCount", "observationCount",
    "medianAbsoluteErrorSeconds", "medianAbsoluteErrorPercent"]));
  if (typeof intake.enabled !== "boolean" || typeof intake.revocationEnabled !== "boolean" || intake.accountScope !== "cop_managed_with_consent" ||
      !["disabled", "comparison_only"].includes(String(report.comparisonMode)) || report.liveAppliedGroupCount !== 0) throw new Error(FAILURE);
  const snapshot = projectDriverEvaluationSnapshot(report.routingDataset as string, report.asOf as string, summary, summary.speed, summary.eta);
  // Fixed literals and source bounds must agree; never silently upgrade a different contract.
  for (const key of ["contractVersion", "generatedAt", "asOf", "applicationMode", "etaEvidence", "consistency", "retentionDays",
    "livePromotionSupported", "revocationCoverage", "evaluationWindow", "limits"] as const) {
    if (JSON.stringify(report[key]) !== JSON.stringify(snapshot[key])) throw new Error(FAILURE);
  }
  return { ...snapshot, intake: { enabled: intake.enabled, revocationEnabled: intake.revocationEnabled, accountScope: "cop_managed_with_consent" },
    comparisonMode: report.comparisonMode as DriverEvaluationReport["comparisonMode"], liveAppliedGroupCount: 0 };
}

export function validateDriverEvaluationReportPath(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || basename(value) !== "latest.json" || value.includes("\0")) {
    throw new Error("Invalid driver evaluation publication configuration.");
  }
  return value;
}

/** Derived scalar report only. No provider payload, request identity or GPS belongs here. */
export async function writeDriverEvaluationReport(path: string, report: DriverEvaluationReport): Promise<void> {
  validateDriverEvaluationReportPath(path);
  const bytes = Buffer.from(JSON.stringify(projectDriverEvaluationReport(report)));
  if (bytes.length > MAX_REPORT_BYTES) throw new Error(FAILURE);
  const parent = dirname(path), before = await lstat(parent).catch(() => { throw new Error(FAILURE); });
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o022) !== 0) throw new Error(FAILURE);
  try {
    const target = await lstat(path);
    if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1 || (target.mode & 0o077) !== 0) throw new Error(FAILURE);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw new Error(FAILURE);
  }
  const temporary = join(parent, `.driver-evaluation-${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    const after = await lstat(parent);
    if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw new Error(FAILURE);
    await rename(temporary, path);
    created = false;
  } catch { throw new Error(FAILURE); }
  finally { if (created) await unlink(temporary).catch(() => undefined); }
}

/** Fail closed when deletion cannot refresh a report; never leave a fresh old projection. */
export async function removeDriverEvaluationReport(path: string): Promise<void> {
  validateDriverEvaluationReportPath(path);
  const parent = await lstat(dirname(path)).catch(() => { throw new Error(FAILURE); });
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0) throw new Error(FAILURE);
  try {
    const target = await lstat(path);
    if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 1 || (target.mode & 0o077) !== 0) throw new Error(FAILURE);
    await unlink(path);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw new Error(FAILURE);
  }
}

/** A coalesced background report, never a live-speed cache or an intake dependency. */
export class DriverEvaluationPublisher {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inflight: Promise<void> | undefined;
  private epoch = 0;
  private closed = false;

  constructor(private readonly path: string | undefined, private readonly load: () => Promise<DriverEvaluationReport>) {
    if (path) validateDriverEvaluationReportPath(path);
  }

  start(): void {
    if (!this.path || this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.refresh().catch(() => undefined); }, 60_000);
    this.timer.unref();
    void this.refresh().catch(() => undefined);
  }

  invalidate(): void { this.epoch += 1; }

  async afterRevocation(): Promise<void> {
    this.invalidate();
    // Joining a finishing refresh is insufficient: its last epoch check may
    // already have passed. Wait for it to settle, then start a post-delete read.
    await this.inflight?.catch(() => undefined);
    if (this.closed) {
      if (this.path) await removeDriverEvaluationReport(this.path);
      throw new Error(FAILURE);
    }
    try { await this.refresh(); }
    catch {
      if (this.path) await removeDriverEvaluationReport(this.path);
      throw new Error(FAILURE);
    }
  }

  refresh(): Promise<void> {
    if (!this.path || this.closed) return Promise.resolve();
    if (this.inflight) return this.inflight;
    const task = (async () => {
      // Revocation during a read discards that snapshot; a second read uses the new database state.
      for (let attempts = 0; attempts < 3; attempts += 1) {
        const epoch = this.epoch;
        const report = await this.load();
        if (this.closed) return;
        if (epoch !== this.epoch) continue;
        await writeDriverEvaluationReport(this.path!, report);
        if (epoch === this.epoch) return;
      }
      throw new Error(FAILURE);
    })();
    this.inflight = task.finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.inflight?.catch(() => undefined);
  }
}
