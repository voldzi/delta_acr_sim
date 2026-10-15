/** Read-only Root inventory, scoped to SIM measurement report producers.
 * It is evidence for an explicit operator review, not proof about arbitrary
 * privileged programs. Never print cron contents, arguments or report names. */
import { readFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { DriverReportFiles } from "../deploy/account-safety/driver-report-files.mjs";
export const REPORT_DIRECTORY = "/srv/x5-production/cache/csm-sim/driver-measurement-reports";
const sha = (v) => createHash("sha256").update(v).digest("hex");
export function reportInventory({ syntheticRoot } = {}) {
  const synthetic = typeof syntheticRoot === "string";
  if (synthetic && (!realpathSync(syntheticRoot).startsWith("/private/tmp/sim-erasure-installer-") || realpathSync(syntheticRoot) !== syntheticRoot))
    throw Error("OWNED_REPORT_FIXTURE_REQUIRED");
  const directory = synthetic ? syntheticRoot + "/driver-report-files" : REPORT_DIRECTORY;
  if (!synthetic) {
    if (
      execFileSync("findmnt", ["-n", "-o", "UUID", "--mountpoint", "/srv/x5-production"], { encoding: "utf8" }).trim() !==
        "2f93f595-b61b-4eea-9054-7afa9b275b5b" ||
      lstatSync("/srv/x5-production").dev === lstatSync("/").dev
    )
      throw Error("EXPECTED_X5_MOUNT_REQUIRED");
  }
  const reports = new DriverReportFiles(directory, { production: !synthetic });
  const entries = reports.inventory().entries.map((x) => {
    const s = lstatSync(x.file);
    return { path: x.file.slice(directory.length), directory: x.directory, bytes: x.bytes, ino: s.ino, mode: s.mode, mtime: s.mtimeMs };
  });
  const pattern = /driver[-_]measurement|driver-measurement-reports|\/internal\/driver-measurements\/v1\/(?:aggregates|quality)/i;
  const scanned = [],
    matches = [];
  let activeProducerCount = 0;
  const scan = (path, depth = 0) => {
    if (depth > 8 || scanned.length > 10000) throw Error("REPORT_INVENTORY_LIMIT");
    let s;
    try {
      s = lstatSync(path);
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    if (s.isSymbolicLink()) return;
    if (s.isDirectory()) {
      for (const name of readdirSync(path).sort()) scan(path + "/" + name, depth + 1);
      return;
    }
    if (!s.isFile() || s.size > 1024 * 1024) throw Error("REPORT_PRODUCER_REVIEW_REQUIRED");
    const bytes = readFileSync(path),
      match = pattern.test(bytes.toString("utf8"));
    scanned.push({ path, sha256: sha(bytes) });
    if (match) matches.push({ path, sha256: sha(bytes) });
  };
  const sources = synthetic
    ? [syntheticRoot + "/producer-fixtures"]
    : ["/etc/crontab", "/etc/cron.d", "/var/spool/cron/crontabs", "/etc/systemd/system", "/usr/lib/systemd/system"];
  for (const path of sources) scan(path);
  if (!synthetic)
    for (const pid of readdirSync("/proc").filter((x) => /^\d+$/.test(x))) {
      if (Number(pid) === process.pid) continue;
      try {
        if (pattern.test(readFileSync("/proc/" + pid + "/cmdline").toString("utf8"))) activeProducerCount++;
      } catch (e) {
        if (!["ENOENT", "ESRCH"].includes(e.code)) throw Error("REPORT_PROCESS_INVENTORY_UNAVAILABLE");
      }
    }
  const reportSummary = reports.assertProtected();
  const digest = sha(JSON.stringify({ directory, entries, scanned, matches, activeProducerCount, lockPresent: reportSummary.lockPresent }));
  return {
    contractVersion: "sim-driver-report-inventory-v1",
    directory,
    ...reportSummary,
    producerMatches: matches,
    activeProducerCount,
    inventoryDigest: digest,
    requiresOperatorReview: true
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.getuid() !== 0 || process.argv.length !== 2) throw Error("ROOT_READ_ONLY_INVENTORY_REQUIRED");
    console.log(JSON.stringify(reportInventory(), null, 2));
  } catch {
    console.error("SIM_DRIVER_REPORT_INVENTORY_UNAVAILABLE");
    process.exitCode = 1;
  }
}
