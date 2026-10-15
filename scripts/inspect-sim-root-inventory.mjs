/** Read-only preparation around the existing ca1fd6b inventory entrypoint.
 * No SQL, chmod/chown, cron edits, service changes or report deletion. */
import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const SOURCE_REVISION = "ca1fd6b6046745e91cca6648e1e5bd3f93fc8422";
export const EXPECTED_CLEANUP_HASH = "c46a03b13ee8d39860fb7bd72df740006f8762fd421ded44e1b2cac990d15d78";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const PINS = {
  "scripts/provision-sim-erasure-production.sh": "7fa8ea541ab14b799cc490f0fccd09cf74666da93ca7779709e124c505523531",
  "scripts/driver-report-inventory.mjs": "b868b72fcd3148a79a9f8caa222402a1203e60598f2af5e72bcd9289b30aae12",
  "deploy/account-safety/driver-report-files.mjs": "7c749eb4cfe8748ed7c84671c825e3c3f691fa4a455375694d220fe85ff9416c"
};
export function verifyInventorySource(root) {
  for (const [name, hash] of Object.entries(PINS)) {
    const path = resolve(root, name),
      s = lstatSync(path);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || (s.mode & 0o022) !== 0 || sha(readFileSync(path)) !== hash)
      throw Error("SIM_PINNED_INVENTORY_SOURCE_CHANGED");
  }
  return Object.keys(PINS).length;
}
export function reviewCleanupCron(text, expected = EXPECTED_CLEANUP_HASH) {
  const active = text
    .split("\n")
    .flatMap((line, i) =>
      line.trim() && !line.trim().startsWith("#") && /driver[-_]measurement/i.test(line) ? [{ lineNumber: i + 1, sha256: sha(line) }] : []
    );
  if (active.length > 1 || active.some((x) => x.sha256 !== expected)) throw Error("SIM_LEGACY_CLEANUP_CRON_REVIEW_REQUIRED");
  return {
    owner: "voldzi",
    expectedSha256: expected,
    state: active.length ? "exact_expected_line_still_active" : "no_active_measurement_line",
    activeMeasurementLineCount: active.length,
    ...(active.length ? { lineNumber: active[0].lineNumber } : {}),
    mutated: false
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let stage = "root_and_host";
  try {
    if (process.argv.length !== 2 || process.getuid() !== 0 || hostname() !== "docker") throw Error("SIM_READ_ONLY_ROOT_HOST_REQUIRED");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      s = lstatSync(root);
    if (!root.startsWith("/home/voldzi/sim-erasure-readonly-") || realpathSync(root) !== root || !s.isDirectory() || s.uid !== 1000 || (s.mode & 0o077) !== 0)
      throw Error("SIM_FRESH_PRIVATE_STAGE_REQUIRED");
    stage = "pinned_source";
    const verifiedSourceFiles = verifyInventorySource(root);
    const env = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
    stage = "legacy_cleanup_cron";
    let cron;
    try {
      cron = execFileSync("/usr/bin/crontab", ["-u", "voldzi", "-l"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, timeout: 5000 });
    } catch (e) {
      if (e.status === 1 && /no crontab for voldzi/i.test(String(e.stderr))) cron = "";
      else throw Error("SIM_LEGACY_CLEANUP_CRON_UNAVAILABLE");
    }
    const legacyCleanupCron = reviewCleanupCron(cron);
    stage = "existing_report_inventory";
    const raw = execFileSync("/bin/bash", [root + "/scripts/provision-sim-erasure-production.sh", "--inventory-reports"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
    const reportInventory = JSON.parse(raw);
    if (
      reportInventory.contractVersion !== "sim-driver-report-inventory-v1" ||
      !/^[a-f0-9]{64}$/.test(reportInventory.inventoryDigest) ||
      reportInventory.requiresOperatorReview !== true
    )
      throw Error("SIM_REPORT_INVENTORY_INVALID");
    console.log(
      JSON.stringify(
        {
          sourceRevision: SOURCE_REVISION,
          verifiedSourceFiles,
          legacyCleanupCron,
          reportInventory,
          readOnly: true,
          cronChanged: false,
          servicesChanged: false,
          databaseContacted: false,
          productionEnrollmentAccepted: false
        },
        null,
        2
      )
    );
  } catch (e) {
    console.error(JSON.stringify({ stage, code: /^SIM_[A-Z0-9_]+$/.test(e.message) ? e.message : "SIM_READ_ONLY_ROOT_INVENTORY_FAILED", readOnly: true }));
    process.exitCode = 2;
  }
}
