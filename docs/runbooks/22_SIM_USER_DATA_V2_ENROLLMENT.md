# 22 — Source procedure: twelve-component SIM enrollment

Not an operator authorization or current production success receipt. Original
runbook 21 / manifest v1 remains the exact eleven-component pre-transition stage.
Do not use its known-new digest as post-twelve-component acceptance.

1. Root freezes exact COP/SIM source/image pins, real policy/admission, independent
   guard identity and epoch. Verify X5 UUID and actual existing mount. Record
   counts/digests only; never export raw user/partner rows or secrets.
2. Stop and verify only `csm-sim-api`, `csm-sim-ai-router-api`,
   `csm-sim-situation-data-api` writers plus the already reviewed Root writer set.
   No daemon/network change. Partial failure leaves all relevant writers stopped.
3. Complete the existing exact v1 reset/enrollment under Root admission. Confirm
   its unused known-new catalog, no prior account/job/resource and no unsettled
   requests. This is a precondition, not the final receipt.
4. New AI transition uses SQL `002_ai_history.sql`, then
   `005_history_continuity.sql`. It removes **only** legacy client_id='sim'
   requests and fixed SIM-project `sim_izs_summary` billing after preserving
   current-month financial/count/token totals. Uncertain/reserved or foreign
   payer blocks. No old identity or operation is adopted. Verify the **new**
   `reset-manifest-v2.json` post catalog with `inspectUserDataProfile`; generic
   extra-trigger allowances are forbidden. `transitionSimHistory` in
   `scripts/lib/sim-user-data-enroll.mjs` is the bounded Root composition port.
5. New DB `sim_user_data`: owner/migrator `sim_user_data_migrator`, runtime
   `sim_user_data_runtime`, all NOSUPERUSER/NOCREATEDB/NOCREATEROLE/
   NOREPLICATION/NOBYPASSRLS. Runtime CONNECT only; revoke PUBLIC database/schema
   CREATE. Apply `001_app_schema.sql`, `004_app_continuity.sql` as migrator.
   No passwords in SQL source/logs. Existing Router DB/role are retained.
6. In existing independent DB `cop_account_safety_guard`, create limited
   `sim_user_data_guard_runtime`, `sim_user_history_guard_runtime`; CONNECT only,
   no DDL. Apply new SQL003 **after** these roles exist. It creates only new
   named tables/policies, preserving old `sim_erasure_guard_v2` rows/contracts.
   Enroll two exact checkpoint rows first quarantined. Target witnesses/config
   must start empty; `enrollSimUserTarget` requires concrete Root reset admission,
   stopped writers, source pins and writes new production config + witness.
   Guard readiness is a separate Root-owned update after matching readback.
7. Legacy main files: `scripts/lib/sim-user-data-reset-files.mjs` inspects only
   `/srv/x5-production/data/csm-sim/sim-data/{sim-store.json,publisher-queue.json,
sim-audit.jsonl}`. Review counts+digest, then reset under actual Root admission
   and exact stopped main image. Preserve aiConfig and publishingEnabled,
   operational-checks, provider caches and all other paths. No old content is
   moved into an owner namespace. A missing/unknown shape or ownership blocks.
8. Production bootstrap is bundled `createSimUserDataAuthority` — not an external
   callback module. The image/source SHA must equal `authoritySourceSha256` in
   manifest and both immutable witnesses. Parameters are exact `guardPool`,
   `targetPool`, `component`, `binding`; no runtime auto-enrollment. Target DB
   and guard DB use `haproxy.home.cz:5000`, sslmode=verify-full and readonly CA
   `/etc/csm-sim/postgresql-ca.pem`. New CA mount for main is readonly; it is not
   an additional secret transfer or permission to alter production here.
9. Runtime configs (all flags default false) are listed in `.env.example`.
   Main: SIM_USER_DATA__, Router: SIM_USER_HISTORY__, both share only reviewed
   epoch/owner-actor composition. Guard URLs use their separate runtime accounts.
   `*_CONTINUITY_BINDING` contains the exact nine non-secret witness fields,
   including `identity_sha256`. Compute it privately with the bundled
   `runtimeIdentityFingerprint(component, identity)` from bootstrap.mjs:
   main identity keys are ownerSecret, actorSecret, routerActorSecret, issuer;
   history keys are hashSecret, actorSecret, issuer. Never output these inputs.
   No static external authority-file mount is required: bundled source is pinned
   inside the immutable image. Root must pin the bootstrap and SQL as well.
10. Start internal candidates only after whole Root admission. Require twelve
    adapters, fresh main+Router capability, both independent checkpoint factories,
    public proxy 404, ordinary A/B business writes, delete/restart/late-writer
    tests and real global identity proof. Existing provider/config data must be
    unchanged. Root/COP common acceptance must cover actual backup restore,
    pending in-flight model work, loss of independent DB and both components.
    Isolated component evidence or build-only staging is **not GO**.

## Exact Root worker calls

Import `scripts/lib/sim-user-data-enroll.mjs` from the frozen public source.
The controller provides actual PG clients and its existing live `rootGate`,
not success callbacks. `assertWritersStopped` is its current image/CID-bound
check of the three SIM writers within that admission.

1. `verifiedUserMigrations(manifest)` verifies the fixed manifest hash, five SQL
   hashes and bundled authority hash before any new operation.
2. `transitionSimHistory({client:aiMigrator,manifest,rootGate,
reviewedCatalogDigest:manifest.aiBaseCatalogDigest,assertWritersStopped})`.
   This includes the finite SIM legacy rollup/reset and SQL002+005.
3. Root's existing privileged installer creates only the named new app DB/roles
   above and applies returned SQL001+004 there; creates the two named limited
   guard roles and applies SQL003 in the independent guard DB. No new daemon.
4. For each of `sim_user_data`, `sim_user_history`, call
   `enrollSimUserTarget({client:targetMigrator,component,binding,tokensNotBefore,
rootGate,manifest,assertWritersStopped})`. It refuses existing config/jobs.
5. For each component call `enrollSimGuardCheckpoint({guardClient:guardInstaller,
targetClient:targetMigrator,component,binding,rootGate,manifest,
assertWritersStopped})`. It checks the exact target schema/witness/config and
   empty account/job set, inserts only a new quarantined checkpoint, verifies
   any exact retry and changes it to ready. It cannot replace an incarnation.
6. The separate main-file reset is
   `resetSimAppFiles({reviewedPlan,rootGate,expectedMainImage,inspectMain})` from
   `scripts/lib/sim-user-data-reset-files.mjs`. Preserve the original verified
   uid/gid/mode on the temp fd before fsync/rename, even when Root runs as uid0.
7. Only then select the default-off candidate overlay plus the existing readonly
   CA mounts and secrets, start internal candidates and perform whole Root/COP
   acceptance before public activation. The bootstrap receives concrete Pool,
   targetPool, targetDatabaseUrl, component, settings and actual runtime identity.

The missing production step is **the Root-controlled stopped-writer reset,
new DB/guard enrollment and common twelve-component whole acceptance**, not
another grant of general SIM access. None of these calls has been executed on
production by the source preparation task.

## Rollback

Before activation: keep flags false and old running image unchanged. After an
enrolled reset, never start legacy writers against the new dataset or reuse an
old epoch/operation. On partial transition/quarantine/failure, keep affected
writers stopped until Root verifies exact new profiles. Do not restore erased
user snapshots, disable guard triggers, relax signatures or clear tombstones.
Preserve anonymous current-month financial totals. Reverting source/images
alone is not a safe database rollback; Root must explicitly select a compatible
enrolled image or repair/replay under the same authority.
