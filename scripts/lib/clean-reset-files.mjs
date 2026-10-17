import { lstatSync, realpathSync, readdirSync, readFileSync, unlinkSync, statfsSync, openSync, fsyncSync, closeSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { withResetWork } from "./clean-reset-admission.mjs";
import { requireStoppedWriters } from "./clean-reset-ops.mjs";
export const X5_ROOT = "/srv/x5-production",
  X5_UUID = "2f93f595-b61b-4eea-9054-7afa9b275b5b";
export const FILE_PREFIXES = Object.freeze({
  reports: "cache/csm-sim/driver-measurement-reports",
  routes: "data/csm-sim/situation-data/geo-routing-v1/precomputed"
});
const sha = (x) => createHash("sha256").update(x).digest("hex");
const need = (x, code) => {
  if (!x) throw new Error(code);
};
function mount(base, synthetic) {
  if (synthetic) {
    need(
      /^\/private\/tmp\/sim-clean-reset-files-[^/]+$/.test(base) &&
        realpathSync(base) === base &&
        lstatSync(base).uid === process.getuid() &&
        (lstatSync(base).mode & 0o777) === 0o700,
      "RESET_OWNED_FILE_FIXTURE_REQUIRED"
    );
  } else {
    need(base === X5_ROOT && realpathSync(base) === base && lstatSync(base).dev !== lstatSync("/").dev, "RESET_X5_MOUNT_REQUIRED");
    need(execFileSync("/usr/bin/findmnt", ["-n", "-o", "UUID", "--mountpoint", base], { encoding: "utf8" }).trim() === X5_UUID, "RESET_X5_UUID_REQUIRED");
    const fs = statfsSync(base);
    need(fs.bavail * fs.bsize >= 100 * 1024 * 1024, "RESET_X5_SPACE_REQUIRED");
  }
}
function directory(base, rel, uid) {
  let path = base;
  for (const part of rel.split("/")) {
    path = join(path, part);
    const s = lstatSync(path);
    need(s.isDirectory() && !s.isSymbolicLink() && s.uid === uid && realpathSync(path) === path, "RESET_FILE_PARENT_UNSAFE");
  }
  return path;
}
function scan(base, synthetic) {
  mount(base, synthetic);
  const uid = synthetic ? process.getuid() : 0,
    entries = [],
    counts = { copRoutes: 0, preservedRoutes: 0, reports: 0, deleteBytes: 0 };
  for (const [kind, rel] of Object.entries(FILE_PREFIXES)) {
    const dir = directory(base, rel, uid);
    if (kind === "reports") need((lstatSync(dir).mode & 0o777) === 0o700, "RESET_REPORT_DIRECTORY_PRIVATE_REQUIRED");
    const names = readdirSync(dir).sort();
    need(names.length <= 10000, "RESET_FILE_LIMIT");
    for (const name of names) {
      const path = join(dir, name),
        s = lstatSync(path);
      need(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.uid === uid && s.size <= 16 * 1024 * 1024, "RESET_UNKNOWN_FILE_OR_PRODUCER_LOCK");
      let remove;
      if (kind === "reports") {
        need(/^(aggregates|quality)\.json$/.test(name) || /^\.report-tmp-[a-f0-9-]{36}$/.test(name), "RESET_UNKNOWN_REPORT_FILE");
        remove = true;
        counts.reports++;
      } else {
        need(/^[a-f0-9]{64}\.json$/.test(name), "RESET_UNKNOWN_ROUTE_FILE");
        const raw = readFileSync(path),
          text = raw.toString("utf8");
        need(Buffer.from(text).equals(raw), "RESET_ROUTE_ENCODING");
        let x;
        try {
          x = JSON.parse(text);
        } catch {
          throw new Error("RESET_ROUTE_FORMAT");
        }
        need(
          x &&
            Object.keys(x).length === 3 &&
            ["actor", "requestHash", "response"].every((k) => Object.hasOwn(x, k)) &&
            typeof x.actor === "string" &&
            /^[A-Za-z0-9_.:-]{1,128}$/.test(x.actor) &&
            /^[a-f0-9]{64}$/.test(x.requestHash) &&
            x.response &&
            typeof x.response === "object" &&
            JSON.stringify(x) + "\n" === text,
          "RESET_ROUTE_FORMAT"
        );
        remove = x.actor === "cop";
        if (remove) counts.copRoutes++;
        else counts.preservedRoutes++;
      }
      const bytes = readFileSync(path);
      entries.push({ path, rel: relative(base, path), remove, ino: s.ino, size: s.size, mtime: s.mtimeMs, mode: s.mode, digest: sha(bytes) });
      if (remove) counts.deleteBytes += s.size;
    }
  }
  return { entries, counts, digest: sha(JSON.stringify(entries.map(({ path, ...metadata }) => metadata))) };
}
export function inspectResetFiles({ syntheticRoot } = {}) {
  const base = syntheticRoot ?? X5_ROOT,
    s = scan(base, !!syntheticRoot);
  return { contractVersion: "sim-clean-reset-files-v1", root: base, counts: s.counts, planDigest: s.digest, wholeAccountComplete: false };
}
export async function purgeResetFiles({ syntheticRoot, reviewedPlan, rootGate, writerReceipt }) {
  requireStoppedWriters(writerReceipt);
  const base = syntheticRoot ?? X5_ROOT;
  need(
    typeof rootGate?.withResetAdmission === "function" && reviewedPlan?.contractVersion === "sim-clean-reset-files-v1" && reviewedPlan.root === base,
    "RESET_FILE_ROOT_GATE_REQUIRED"
  );
  return withResetWork(
    rootGate,
    { contractVersion: "sim-clean-reset-files-v1", planDigest: reviewedPlan.planDigest, writerReceipt },
    async (admission, assertOpen) => {
      need(
        typeof admission?.assertCurrent === "function" && typeof admission?.assertReportProducersStopped === "function",
        "RESET_FILE_PRODUCER_ADMISSION_REQUIRED"
      );
      await admission.assertCurrent();
      await admission.assertReportProducersStopped();
      assertOpen();
      const before = scan(base, !!syntheticRoot);
      need(before.digest === reviewedPlan.planDigest, "RESET_FILE_PLAN_DRIFT");
      for (const e of before.entries.filter((e) => e.remove)) {
        assertOpen();
        mount(base, !!syntheticRoot);
        const s = lstatSync(e.path);
        need(s.isFile() && !s.isSymbolicLink() && s.ino === e.ino && s.size === e.size && s.mtimeMs === e.mtime, "RESET_FILE_CHANGED");
        unlinkSync(e.path);
      }
      for (const rel of Object.values(FILE_PREFIXES)) {
        const fd = openSync(join(base, rel), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      await admission.assertCurrent();
      await admission.assertReportProducersStopped();
      const after = scan(base, !!syntheticRoot);
      assertOpen();
      need(after.counts.copRoutes === 0 && after.counts.reports === 0, "RESET_FILE_READBACK_FAILED");
      const keptBefore = before.entries.filter((e) => !e.remove).map(({ path, ...x }) => x),
        keptAfter = after.entries.map(({ path, ...x }) => x);
      need(JSON.stringify(keptBefore) === JSON.stringify(keptAfter), "RESET_OTHER_ROUTE_CHANGED");
      return { contractVersion: "sim-clean-reset-files-v1", deletedCounts: before.counts, remaining: after.counts, wholeAccountComplete: false };
    }
  );
}
