/** Read-only closed plan printer. No --apply, DB URL, env read or SSH accepted. */
import { SCOPES, RESET_VERSION, BASE_SOURCE, RESET_MANIFEST_SHA, readResetManifest } from "./lib/clean-reset-ops.mjs";
import { FILE_PREFIXES, X5_UUID, X5_ROOT } from "./lib/clean-reset-files.mjs";
if (process.argv.length !== 3 || process.argv[2] !== "--plan") {
  console.error("Only --plan is available. Root performs the separately admitted common operation.");
  process.exitCode = 2;
} else {
  await readResetManifest();
  console.log(
    JSON.stringify(
      {
        contractVersion: RESET_VERSION,
        baseSourceRevision: BASE_SOURCE,
        manifestSha256: RESET_MANIFEST_SHA,
        mutates: false,
        realRootAdmissionProvided: false,
        writers: ["csm-sim-ai-router-api", "csm-sim-situation-data-api"],
        stopCommand: ["docker", "stop", "--time", "45", "csm-sim-ai-router-api", "csm-sim-situation-data-api"],
        databaseScopes: Object.fromEntries(
          Object.entries(SCOPES).map(([lane, s]) => [
            lane,
            {
              database: s.database,
              migrationOwner: s.owner,
              runtime: s.runtime,
              reset: s.deletes.map(([table, predicate]) => ({ schema: "public", table, predicate })),
              preserve: s.preserve.map(([table, predicate]) => ({ schema: "public", table, predicate })),
              legacyMustRemainZero: s.legacy,
              migrations: s.migrations
            }
          ])
        ),
        fileScopes: {
          root: X5_ROOT,
          mountUuid: X5_UUID,
          delete: [
            { prefix: FILE_PREFIXES.reports, names: ["aggregates.json", "quality.json", ".report-tmp-<UUID>"] },
            { prefix: FILE_PREFIXES.routes, actor: "cop", filePattern: "<64 lowercase hex>.json" }
          ],
          preserve: "all other route actors, sim-store, scenarios, drafts, queues, provider/cache/config/secrets/TAK"
        },
        gates: [
          "review exact plan and manifest digest",
          "Root global maintenance/admission",
          "fixed container IDs/images stopped before and after",
          "runtime/migration DB sessions absent except current owner",
          "report producers stopped/no publication lock",
          "X5 UUID/device/space valid before each file deletion",
          "known-old to known-new or exact new unused retry only",
          "nonzero legacy operation or unknown/shared guard blocks",
          "both DB readbacks + independent Root restore/replay acceptance before restart"
        ],
        rollback:
          "No user-data backup or restore. SQL failure rolls back its transaction; file caches are reproducible and not restored. Partial two-DB success keeps ALL writers stopped and retries only the exact unused new state.",
        wholeAccountComplete: false
      },
      null,
      2
    )
  );
}
