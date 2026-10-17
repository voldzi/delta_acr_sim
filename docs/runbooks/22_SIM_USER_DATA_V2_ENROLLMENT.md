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

## Concrete private installer and build staging

`scripts/lib/sim-user-data-private-install.mjs` exports
`runSimUserInstall(config,{Pool,rootGate,assertWritersStopped})`. The Root Node24
host bundle injects its actual pg Pool and live gate; no container privilege,
host filesystem bind, environment credential or additional listener is needed.

RAM-only config is `contractVersion: sim-user-private-install-v1`,
`profile: production`, `phase: inspect|apply|readback`, the fixed manifest,
resetEpoch/tokensNotBefore, connections `{admin,ai,guard}` (postgres,
sim_ai_router, cop_account_safety_guard), credentials for the four named new
roles, identities for both components, and their nine-field bindings.
Production connections require postgres via haproxy.home.cz:5000 with a verified
CA. `inspect` returns only counts/digests. Root seals its `planDigest` as
`reviewedPlanDigests.sim_user_install`; `apply` additionally requires that exact
reviewedPlan. Its outer gate context is exactly phase sim_user_install,
planDigest, resetEpoch, tokensNotBefore. A single continuous Root lease encloses
role/DB creation, schema install, finite SIM history reset and both target/guard
enrollments; nested operations borrow it, never begin a second RPC lease.

`readback` is called inside Root's already-held global readback lease with its
live assertCurrent supplied as assertWritersStopped. It issues no nested begin.
Readback requires empty old COP account/job/resource and request/key/audit lanes,
the exact new AI/app catalogs, both actual restricted-role SQL authorities and
the common epoch/cutoff. Failure leaves writers stopped. It does not complete
global identity deletion or authorize reopening.

Passwords are RAM input, set with SCRAM-SHA-256 under statement/parameter logging
suppression on the same admin connection. No credential is returned. The
PRIVATE in-process `privateSimRuntimeConfiguration(config,simRouterServiceToken)`
returns only input for Root's secret-file writer (never RPC stdout or a log).
Add config.serviceToken for the new dedicated COP adapter. All intake flags are
false; migration credentials are excluded. The descriptor includes the exact
read-only existing CA mount. Only the actual Root activation phase may change
the flags after common acceptance.

`node scripts/test-sim-user-private-install.mjs --run`: 21 actual owned PG18.3
checks, including a SCRAM-authenticated runtime connection, denied DDL, one outer
lease, fresh readback, preserved anonymous finance and absence of passwords from
the actual PostgreSQL log. This is not actual Root/production acceptance.

Build preparation is fixed to the already accepted runtime source a337cfc and
does not change that application's code. `scripts/prepare-sim-clean-build.py
--prepare` runs once as Root; `--build-only` then runs as voldzi. It creates only
the dedicated sim-x5 builder, state bind volume, public read-only checkout and
logs under `/srv/x5-production/cache/csm-sim/build/`. It checks UUID/device and
headroom, existing pinned BuildKit, volume binding, restart=no, exact source bytes
and unchanged running service CIDs/images. No prune, daemon/network change,
application restart, .env update or database mutation. The existing Docker image
store remains unchanged in location; loading candidate images still writes there.
Current public web authentication parameters are preserved exactly (hybrid,
the COP realm, csm-sim-web, public/token login disabled). Eight pure guard tests
and Python syntax passed. The operator completed Root preparation; its final
check exposed unsupported `buildx inspect --format` in the installed CLI.
The fixed checker uses supported `buildx ls --format '{{json .}}'`, requires
identical duplicate formatter rows, and confirms the actual container cache
device equals X5. Preparation must not be repeated: the fixed `--build-only`
continues without Root. All four candidate images were subsequently built and
probed without changing any running service. Exact immutable identities and
actual cache-device/web-image checks are recorded in
`deploy/sim-user-data/candidate-images-a337cfc.json`; this is a staging receipt,
not production activation or whole-account acceptance.

The installer/public build helper revision is frozen separately from runtime
revision a337cfc. Root must pin both, never label an older image with the newer
installer revision. Candidate image identities and actual cache-device proof
must be recorded before activation.

## Common coordinator (source only; activation remains gated)

`scripts/coordinate-clean-release.py` exports `run_common_reset(private_config)`;
it has no command-line entry point or automatic start. The coordinator imports
the hash-enrolled COP controller and its actual Root authority from the sealed
operator bundle. Before remote authentication or stopping any writer it requires
the real `cop-sim-whole-clean-acceptance-v2` report for all twelve owners and all
nine exact candidate images. Unit-test mocks are not an acceptance report.

After remote authentication, but before writer freeze, it enters COP's concrete
`prepare_remaining_reset(plan,private_config,remote)` context. The inventory,
SQL and storage transport preflight must succeed while services still run; its
custody remains held until the reset admission exits. Missing or failed preflight
cannot stop writers. Ten isolated coordinator tests cover this ordering.

Inside one held Root admission it runs the concrete identity, COP, AI, driver,
file, SIM application-file, SIM user install and COP safety-install phases. It
then requires COP's separately implemented `run_remaining_reset(admission,
private_config)` and a fresh provider readback. Missing closure, stale plan,
changed proof or lost admission refuses; there is no automatic service restart.

Only after those checks may it stage the four pinned SIM images and read-only
PostgreSQL CA mount in `/srv/sim/docker-compose.clean-user-data.json`, plus the
fixed clean-lifecycle keys in `/srv/sim/.env`. Existing provider, OpenAI and
service identity values are preserved. AI and driver have separate enrolled
dataset identifiers through `SIM_CLEAN_AI_*` and `SIM_CLEAN_DRIVER_*` aliases;
their service environments map these to `SIM_CLEAN_LIFECYCLE_*`. Both base-clean
flags, the new user/history/relay flags and legacy erasure flags remain false.
The helper returns metadata only; secrets remain in memory or the mode-0600
server environment file. No production invocation is part of this source work.

The legacy deployment helper refuses the new overlay or enrolled user-data
mode rather than rewriting its environment file. Its replacement is limited to
the sealed source and explicitly inventoried previous hashes. File replacement
preserves ownership, checks original bytes, uses atomic rename and fsync, and
checks the held admission before and after the write. Partial failure leaves
writers fenced; it does not authorize reopening.

`python3 scripts/test-coordinate-clean-release.py`: ten isolated tests cover
separate lane IDs, false flags, unchanged existing keys, changed hash refusal,
duplicate identity refusal, LIVE-mode refusal, owned-file custody/CAS, admission
loss and actual-gate call ordering before remote auth or freeze. These prove
local orchestration behavior only, not the actual whole-twelve-owner recovery
test or production completion. The runtime images remain revision a337cfc;
coordinator/installer source is versioned separately.

## Actual whole12 SIM companion (isolated only)

`scripts/fixtures/clean-whole12-sim-companion.mjs` exports
`createWhole12SimCompanion(db)`, where `db` must come from the existing owned
PostgreSQL factory, not an arbitrary connection URL. `seed(A,B,issuer,jwksOrigin)`
provisions the fresh restricted runtime roles and starts actual compiled main,
Router and driver HTTP handlers. It creates scenarios/drafts through actual
OIDC-authenticated requests, and driver/Router records through existing actual
fixture handlers. The model and road matcher remain explicitly synthetic;
external-provider access is forbidden. No production runtime code changed.

Each actor is `{subjectId,routerUserId,contributorIdDay,oidcIat,jwt}`. Root must
supply real isolated Keycloak `cop-web` JWTs with `SIM_ADMIN` and original iat;
the companion never mints JWTs. Fixed logical issuer:
`https://cop-erasure-keycloak.invalid/realms/cop`; JWKS is restricted to
`http://127.0.0.1:<isolated-kc-port>/realms/cop/protocol/openid-connect/certs`.
The shared network namespace has no published ports. Main/Router/driver use
4314/4312/4311; authenticated aggregate readbacks use 4324/4322/4321. The new
4324 endpoint requires the private base COP service token, accepts only GET
`/readback`, rejects Origin and returns 503 when a required service is stopped.

The returned seed configuration is **private RAM**, not a report. Root may
transport it only through owned mode-0600 private files/tmpfs; never Docker
environment, argv, logs or Git. `readPrivateCompanionInput` checks regular-file,
single-link, ownership, size and mode before reading. `read()` returns SQL/file
counts and fingerprints, including SIM Router history; no row payloads or
secrets leave it. `outage('main'|'ai'|'driver')` actually closes that service;
`recover(lane)` restarts it against the same stored data. `close()` stops all
companion listeners and pools, but does not stop the owned database.

Important evidence boundary: current compiled `createOwnedSimulatorApp` and
`loadSimHistory` expose no test injection for their production continuity
factory. Their isolated mode does not attach production independent authority;
production mode requires the unchanged fixed HAProxy/TLS transport. Companion
readbacks therefore explicitly state `productionContinuityAttached:false` and
`wholeAccountComplete:false`. Separate actual SQL authority tests do not turn
this into production-authority HTTP end-to-end evidence. Root must keep this
limitation visible and must not fabricate whole12 acceptance from it.

`node scripts/test-whole12-sim-companion.mjs --run` uses actual owned PG18.3,
actual compiled handlers and a synthetic RSA/JWKS issuer, not actual Keycloak.
It tests private input custody, issuer refusal, two account seeds, authenticated
readback, actual outage/503/restart and preserved B history. Real Keycloak and
the remaining whole12 providers are the separate shared acceptance step.

## Rollback

Before activation: keep flags false and old running image unchanged. After an
enrolled reset, never start legacy writers against the new dataset or reuse an
old epoch/operation. On partial transition/quarantine/failure, keep affected
writers stopped until Root verifies exact new profiles. Do not restore erased
user snapshots, disable guard triggers, relax signatures or clear tombstones.
Preserve anonymous current-month financial totals. Reverting source/images
alone is not a safe database rollback; Root must explicitly select a compatible
enrolled image or repair/replay under the same authority.
