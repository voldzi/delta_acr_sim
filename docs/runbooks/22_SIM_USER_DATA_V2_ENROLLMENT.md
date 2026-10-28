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

## New TLS production-bootstrap fixture

`scripts/fixtures/whole12-tls-production-sim.mjs` adds a separate factory,
`createTlsProductionSimFixture({root,sourceRoot,runtimeRoot})`. It does not alter
the old isolated fixtures or application code. `runtimeRoot` may be a map keyed
by simulator-api, ai-router-api and situation-data-api, preserving each exact
candidate's relative imports and dependencies. The production-mode main/history
factories receive actual restricted PostgreSQL connections and independently
enrolled SQL authorities, not injected positive callbacks. The installer uses
its existing owned Unix-fixture profile to enroll fresh production-mode tables;
its synthetic admission is explicitly **not actual Root admission**.

The caller must create a new network-none namespace, no published ports, and a
fresh owned PG cluster `sim_whole12_tls_fixture_v1`, port5000, ssl=on, loopback
only, fixture_admin over the owned Unix socket. Test CA mounts read-only at
`/etc/csm-sim/postgresql-ca.pem`; private container hosts maps haproxy.home.cz
to127.0.0.1. The server certificate has that DNS SAN. The production bootstrap,
fixed URI and verify-full rules remain unchanged. Actual tests must confirm
pg_stat_ssl, restricted role, denied DDL, wrong CA and wrong SAN rejection.
This is test-server verification, **not production HAProxy certificate proof**.

`prepareWhole12Tls(root)` generates fresh test material using openssl. It accepts
owned `/private/tmp/sim-user-install-pg-*` or only the explicit server tmpfs
`/dev/shm/cop-clean-whole12-9aff26e65b74-pg`, bound inside the test containers as
`/private/tmp/sim-user-install-pg-9aff26e65b74`. It never edits host DNS, copies a
production CA/key or changes firewall/VPN. Six local actual certificate tests
pass; these do not prove PostgreSQL/bootstrap acceptance.

The factory `seed(A,B,issuer,jwksOrigin)` receives actual KC subjectId/oidcIat/jwt.
It generates private roots first, then derives router IDs using the exact COP
`cop-router-chat-v1` HMAC and daily contributor IDs using
`cop-driver-contributor-v1`. COP must use returned private
input.base.environment.routerHashSecret and driverHashSecret as the matching
derivation roots. Return values remain private RAM/tmpfs only. `read()` checks
both actual authority-backed ledgers and returns counts/fingerprints. Readback
ports4321/4322/4324 require the private COP bearer. `outage/recover` supports
main/ai/driver and guard; guard outage disables only the two synthetic guard
roles and terminates their test sessions. `quarantine` changes only the fresh
test checkpoint. Whole-account and Root acceptance stay explicitly false.

`scripts/build-whole12-tls-runtime.py` prepares a distinct offline TEST bundle
using only the three pinned a337 candidates, X5 and sim-x5. It exports the exact
main root filesystem and copies separate Router/situation roots, avoiding
dependency merges or package downloads. The scratch-based test image is not
claimed to be an original candidate image. Actual compiled/resource byte hashes
must match all three originals; production service identities must not change.
Its build and the complete PostgreSQL/KC run remain separate acceptance gates.

Actual namespace component run subsequently passed with source0ded266, PG18.6,
Node24.22 and test bundle08570327 (full identities in archived TLS evidence).
The unchanged production-mode main/history bootstrap used actual independent
SQL authorities over verify-full TLS. Both real isolated KC actors wrote through
main middleware. Wrong CA/SAN and runtime DDL were rejected. Readback returned
401 without bearer and404 with Origin; checkpoint quarantine and terminated
guard sessions/NOLOGIN returned503, then fresh admission recovered200. Both
actors' stored fingerprints remained unchanged; no account was deleted.
Private test values were absent from Docker metadata. The client is UID1000,
read-only root, no capabilities/new privileges or published ports, and shares
only the isolated network-none namespace. Actual Root admission and production
HAProxy verification are explicitly NOT claimed. COP owns the next coordinated
A-delete/B-preserve and full recovery acceptance; the synthetic fixture remains
available for that test and must not be mistaken for a production deployment.

The old component readback helper hardcodes its historical isolated mode label.
The new TLS wrapper now emits `cop-clean-whole-tls-component-readback-v1` and
reads the actual SQL mode, leaving the old contract unchanged. This source
correction does not hot-patch the already running source0ded266 process. The
shared test must use the correct source identity and/or independently verify
actual SQL mode, never infer it from the old nested label.

Generation-only certificate follow-up: future fresh test CAs explicitly contain
critical CA basicConstraints and keyCertSign/cRLSign usage plus SKID/AKID; leaves
contain critical CA:false, digitalSignature/keyEncipherment, DNS SAN, serverAuth
and SKID/AKID. Nine local tests now include actual Python VERIFY_X509_STRICT
success and wrong-CA/wrong-name refusal as well as Node handshakes. No existing
test root is regenerated (existing tls directory still refuses EEXIST), and the
running namespace's d56ffc test CA and archived evidence remain unchanged. This
does not change production TLS or claim a new PostgreSQL acceptance run.

## Read-only whole12 SIM harness adapter (public source only)

`scripts/fixtures/whole12-sim-readback-adapter.mjs` exports
`createWhole12SimReadbackAdapter(privateFile)`. Run it only in Root's planned
isolated harness network namespace, where existing loopback ports4321/4322/4324
are reachable. The default private file is
`/dev/shm/cop-clean-whole/sim-private.json`; custody requires owned, single-link
mode0600 in private tmpfs/temporary storage. No secrets in argv, Docker env,
logs or Git. The adapter creates no endpoint, process, namespace or service.

```javascript
const adapter = await createWhole12SimReadbackAdapter(privateFile);
const seed = await adapter.seed();       // GET-only baseline capture, no writes
// Root's actual shared harness performs its separately authorized A deletion.
const current = await adapter.readback();
const checked = await adapter.check(seed);
```

`seed()` does NOT seed applications. It requires actual already-seeded active
A/B content for sim_measurements, ai_router and sim_user_data, all four main
files and used SIM Router history. Root records that exact returned baseline
before deletion; do not fabricate/relabel it. `readback()` uses only GET on the
three fixed authenticated `/readback` endpoints, with timeout, no redirects,
no-store and128KiB limit. It checks shared epoch, separate and combined results,
nonnegative counts and fingerprints, and refuses inconsistent snapshots so the
harness can retry rather than accepting partial/mixed deletion state.

Output owners contain actual source countsA/countsB, removableA/removableB,
stateA/stateB and preservedBFingerprint. sim_user_data reports main app-file
count separately from SIM history request/billing counts and combines the two
actual B fingerprints. App/audit are one observed file scope here, not invented
independent row counts. A completion requires zero content and deleted states
for both main and history, as well as the other two owners. B preservation
requires unchanged counts/state/fingerprint for all three. Network/provider
errors are errors, not zero counts. Old baseline contracts and `simPreserved`
are rejected; historical nested component labels are explicitly identified,
never relabeled as a new user-data completion.

`check(seed)` returns pending/completed/failed for these three component scopes,
always wholeAccountComplete:false and Root/wire identity proof:false. Root still
owns the full twelve-provider proof, operation identity, canary and acceptance.
The adapter binds private issuer/subjects, identity fingerprints, source/epoch
and opaque Router ID derivation without returning raw identities or secrets;
changes to the private file during use refuse.

Source identity audit: main verifies the COP service actor's configured issuer,
UUID subject and epoch, derives canonicalOwnerKey from issuer+subject, then
forwards that same persisted owner key plus source epoch, original oidcIat and
operation to Router history through signSimOwner. Raw issuer/sub are deliberately
not sent to history; the HMAC owner key represents the same identity. The fixed
situation relay forwards the original four auth/content headers and body, not a
new principal. The running TLS fixture uses direct main4314 and does not enable
that situation relay, so no on-wire relay A-delete proof is claimed. No A delete
or token refresh was performed for this source audit or adapter work.

`node scripts/test-whole12-sim-readback-adapter.mjs --run` uses local synthetic
HTTP servers, not the running namespace:16 checks cover baseline capture,
three-owner completion boundaries, B mutation, missing/expired-style source503,
no-store/size/epoch/mixed snapshots, old simPreserved and private-file changes.

## Root activation module after whole12 acceptance (source only)

This is the concrete handoff for COP's single human-run Root operator. It is
not a standalone activation command. `scripts/activate-clean-sim.py` is a library
without CLI. The existing common coordinator ends fenced and does not start
services. Root must integrate the library with its actual whole12 final owner;
source/CAS tests do not authorize production execution.

1. Call `run_common_reset(private_config)` only after the real protected whole12
   report matches all nine original candidate images. Its exact stopped-writer
   Root admission runs the reset and final SQL/provider readbacks, then stages
   SIM configuration with all new flags false. Keep COP's global deletion flag
   false. Do not change Jízda intake, external-model or analytics settings.
2. After that admission closes, acquire the existing deployment/storage lock
   for activation and compare the same proof/source hashes, reset epoch, all
   still-stopped original CIDs, current environment bytes and overlay digest.
   A concurrent change refuses; do not stop/adopt a foreign new container.
   Never call stopped-writer `assert_current()` after starting a new runtime.
   The coordinator now returns its existing `sim_config` receipt as
   `simConfiguration` (environmentSha256/overlaySha256), without private values.
3. While writers remain stopped, use the existing `runSimUserInstall` readback
   phase with the actual activation lock/stopped-state check. Verify both real
   restricted-role independent authorities, exact production configs, all nine
   binding fields, unused profiles, and base AI/driver enrollment. This step
   does not use a positive readiness callback or start a model/provider call.
4. Under the lock, CAS-update only these **composition/fence** flags to true:
   `SIM_CLEAN_AI_ENABLED`, `SIM_CLEAN_DRIVER_ENABLED`, `SIM_USER_DATA_ENABLED`,
   `SIM_USER_HISTORY_ENABLED`, `SIM_USER_DATA_RELAY_ENABLED`. Keep legacy
   AI_ROUTER_ACCOUNT_ERASURE_ENABLED/DRIVER_ACCOUNT_ERASURE_ENABLED false and
   COP's global user-deletion flag false. They are not the same switches.
   Starting main with SIM_USER_DATA_ENABLED=false selects its legacy global
   store (`apps/simulator-api/src/index.ts:8`), not the canonical-owner runtime.
   Likewise Router history cannot start without the clean composition.
5. `state.up_services()` preserves each service's actual recorded Compose chain,
   appends the pinned new overlay and runs only `up -d --no-build --no-deps
   --pull never <one-service>`, ordered Router/situation/main/web.
   Read-only inspection found real chains differ: main/web use base+x5+driver;
   Router uses base+x5+ai-router+the existing database-v2 prepare overlay;
   situation uses base+x5+driver+that prepare overlay. Do not collapse them to
   one guessed two-file command. The sole external legacy overlay allowed is
   `/home/voldzi/sim-erasure-apply-ca1fd6b-v2/deploy/account-safety/database-v2.prepare.compose.yml`;
   its real bytes are captured/CAS-checked and it must not be cleaned up while
   referenced. Unknown external paths, extra environment files or project
   changes refuse before activation.
   Verify actual resulting CIDs/images against the four exact candidate
   identities, unchanged networks/mounts, read-only CA mount and healthy state.
   No other SIM provider, Valhalla, daemon or project is restarted.
6. Use private stdin, not tokens in argv/logs, to check ordinary readiness AND
   actual authenticated guards: main `:4000/health/ready`;
   `:4000/api/v1/internal/sim-user-data/v1/capabilities` (dedicated COP token);
   Router `:4050/api/v1/ai-router/internal/user-lifecycle/v1/capabilities`
   (COP Router token); Router
   `:4050/api/v1/ai-router/internal/sim-user-history/v1/capabilities` (SIM token);
   situation `:4020/api/v1/internal/user-lifecycle/v1/capabilities` (driver COP
   token); and situation's fixed relay main-capabilities path (dedicated token).
   Require ready=true, matching contract/epoch/scope and fresh no-store answers;
   missing tokens must return401. Router `/health/ready` alone only tests target
   SELECT1/usage and is not independent guard evidence. Check public private
   paths remain404, and unauthenticated operator data remains denied.
7. COP's actual Root canary orchestrates the synthetic shared twelve-owner
   A-delete/B-preserve and required recovery/readbacks. Keep end-user global
   deletion off during private component acceptance; no mock Root, skipped
   owner, direct OpenAI fallback or live Jízda/ETA integration. The ordinary COP
   public deletion endpoint cannot itself be used with its global switch false;
   do not claim it was tested. Its final check belongs after the explicit next
   transition, or to an already reviewed private Root canary path. A missing
   actual canary path is a blocker, not grounds for an auth/guard bypass.
8. Only after that canary and all remaining COP/native/provider gates pass may
   the real Root activation owner enable the explicitly approved global COP
   flags, recreate only the affected COP runtime through its normal pinned
   profile and verify one final synthetic public workflow. Publish a receipt
   containing actual source/image/CID identities, epochs, readiness, observed
   test results and enabled flags. Failure keeps global deletion off; stop the
   newly admitted affected services under activation custody if required. Never
   restart old writers against the new schemas or restore erased snapshots.

The reset and activation phases must be explicit within the one human command;
the existing reset authority cannot be weakened to permit started/new writers.
Returning a fenced reset receipt is not activation success.

Concrete library calls for Root's sealed final driver:

```python
reset_receipt = coordinator.run_common_reset(private_config)
with activation.begin_sim_activation(reset_receipt, private_config) as state:
    state.offline_guard_readback()
    state.stage_composition()
    state.up_services()
    state.verify_capabilities()
    sim_receipt = state.receipt()
# Root's real shared canary/final COP activation follows under its own custody.
```

The module requires Root/Docker host, a real storage flock, protected actual
whole12 proof and self/source hash enrollment. It checks all still-fenced other
local Root writers and CAS-binds exact new service IDs/images/config/mounts and
networks after up. SQL readback uses the actual installer in readback-only mode
with private stdin and a live parent activation-custody RPC; unexpected reset
admission refuses. No production secret mount, new listener or positive SQL
callback is introduced. Partial/timeout up inventories exact candidate IDs;
failure cleanup stops only those captured IDs whose spec still matches and
continues cleaning other owned IDs even if one was replaced. It never stops a
foreign replacement, reverts composition to a legacy path or restores data.
Global COP flags remain byte-for-byte unchanged. The metadata receipt is
`sim-composition-activation-v1`, stage `guard-ready-awaiting-cop-canary`, not GO.

Seventeen isolated CAS/orchestration tests plus ten coordinator tests pass.
The two reproduced gaps are corrected: an existing feature key may not disappear
from the effective configuration, and custody is checked before each individual
up with immediate binding of only that attempted service's actual new CID before
the next transition. A failed/timed-out attempt does not claim unrelated,
unattempted services for cleanup. Regression tests cover omission, custody loss
after the first up (no subsequent up), and the complete per-step CID sequence.
Late Docker-daemon completion after a timed-out inventory and process-crash
resume remain unverified; this change does not claim to solve those other gates.
Production activation, actual Compose up and the module's host SQL bridge have
not been executed; the earlier TLS namespace evidence is separate component
evidence, not an activation test.

## COP remaining-provider source review

Reviewed exact COP commitf5b2414 (remaining wrapper, S3, native/metadata, media,
Edge, finite STORAGE_PROGRAM and media closure migration). One concrete profile
integrity defect was reproduced: moving server_keys_json from configuration to
data preserves the173-table count and declared digests, and `profile()` accepts
it without hashing the complete JSON. The remaining wrapper did not require
that JSON in its source hash map. COP accepted the minimal correction: require
the profile in the sealed map and pin its raw SHA
`6c3e89ea8ebd90c2f7f89b0fb30c8fdf795199a31b8504380769f42cef6919e6`.
Its corrected source must be pinned/reviewed before activation; this review does
not claim a fix was applied to production.
Five configuration and eight S3 boundary tests were rerun from an immutable
archive of that commit:13 passed, source/unit evidence only. Actual production
S3 rotation, the combined Root wrapper and whole12 completion were not rerun.

Verified in source: live admission before native/metadata SQL commits and
media unlink/Edge atomic replacement; exact single bucket with unversioned,
bounded complete inventory; provider stop, same-image restart, old credential
denial and no old-key fallback; credential payloads through private RAM/pipes;
fresh guard/target dataset binding plus immutable runtime-SELECT-only media
closure witness; partial failure does not automatically restart app writers.
Other actionable integration gaps are the activation ordering, actual guard
readiness and missing reset-to-activation configuration receipt listed above,
not an invented extra erasure framework.

## Rollback

Before activation: keep flags false and old running image unchanged. After an
enrolled reset, never start legacy writers against the new dataset or reuse an
old epoch/operation. On partial transition/quarantine/failure, keep affected
writers stopped until Root verifies exact new profiles. Do not restore erased
user snapshots, disable guard triggers, relax signatures or clear tombstones.
Preserve anonymous current-month financial totals. Reverting source/images
alone is not a safe database rollback; Root must explicitly select a compatible
enrolled image or repair/replay under the same authority.
## Source-only disconnect robustness candidate (2026-10-28)

Branch `codex/sim-pg-client-disconnect` is **not deployed**. The candidate adds
process-survival observers for idle-pool and checked-out `Client` errors on the
SIM app's target pool and its independent guard pool. Router guard behavior is
unchanged. No error object, query, connection string or values enter diagnostics:
only a fixed event, target/guard lane, fixed kind and allowlisted SQLSTATE.

The observer neither retries queries nor changes a rejected promise into success.
The authority factory and ledger are byte-identical to the audited production
sources. Pool ceilings, TTLs, lock/check ordering, roles, profiles, credentials,
continuity markers and billing behavior are not changed. A failed guard commit
can occur **after** target commit: the failed HTTP/worker operation must not be
blindly retried. Disconnect during target COMMIT is also an uncertain outcome;
attempted ROLLBACK does not prove the server did not commit.

`node --test scripts/test-sim-pg-disconnect.mjs` exercises actual authority/ledger
code with synthetic EventEmitter/query doubles for both pools: idle and borrowed
client errors, rejected busy queries, commit disconnect without replay, fresh
revalidation after recovery, quarantine/config refusal, private-error suppression
and unchanged controlled source hashes. This is **not** an actual PostgreSQL
socket-termination, pool-eviction or restore acceptance test.

Before release: peer review and exact image/config/continuity release review
remain required. The initial synthetic evidence is extended by actual PostgreSQL
socket tests and local scoped build/regression checks below. This candidate
does not authorize production restart, migration or a new outage. Wait for the
infrastructure owner's PG GREEN and separate application release approval.

Rollback proposal: retain the current pinned image/config; if this candidate is
later approved, revert only via the existing protected application release path.
No database, journal or continuity marker rollback is part of it. No migration or
data restoration is necessary; reverting also restores the old disconnect-crash
risk. This text is a source/test proposal, not a performed deployment or rollback.

### Real isolated PostgreSQL evidence and exact proposed rollout

`node scripts/test-sim-pg-disconnect-real.mjs --run` now passed **27 real PG18.3
checks**, in addition to the 10 synthetic tests. The script creates its own 0700
random temporary cluster; PostgreSQL and acknowledgement-loss proxies use private
Unix sockets only. Exact synthetic role names and two dedicated databases exist
only inside that fixture; versioned migrations 001/003/004 are applied there.
It executes the unchanged production-mode authority and ledger, not a substitute
admission callback. Quarantine, changed generation, missing tombstone projection,
actual restart replay, RLS refusal, pool eviction, busy-query termination and
both target/guard COMMIT acknowledgement-loss paths pass. The target row is
actually visible while the caller rejects, with work executed once. A guard
failure after target commit is explicitly not treated as rollback of the target.
The entire cluster is stopped and removed before success is reported. Production
TLS/bootstrap, deployed HTTP behavior and full application acceptance remain
separate gates. Bounded evidence: `docs/testing/sim-pg-disconnect-20261028.json`.
Local simulator API plus dependencies build, API typecheck, all 35 simulator API
regression tests, skeleton and OpenAPI validation passed. The entire monorepo
suite was not run; no candidate container image has been built or deployed.
One idle socket failure can emit both `client` and `idle_client` events because
the persistent client observer and the pool listener both see it. These are
observations, not independently countable incidents; do not sum them as outages.

Proposed release is **only `sim-api` / `csm-sim-api`**, not Router, situation API,
Docker daemon or other projects. `deploy/sim-pg-disconnect.Dockerfile` is unbuilt:
it derives from exact production image `4076069b...` (full digest in the file)
and replaces only compiled `user-data.js`, `bootstrap.mjs`, `pg-errors.mjs`.
No dependency install, new command/user/environment, port, mount or profile is
introduced. Build is a later reviewed step; do not invent a candidate image ID.

Before a single rollout, the protected application release owner must capture
private consistent baseline evidence and assert:

1. Actual current CID/image and active protected release still match the intended
   baseline. Abort on drift; preserve current authoritative Compose layering.
2. Candidate base layers and effective image config equal baseline except the
   allowlisted final file layer and reviewed source labels. Compare complete
   resolved runtime configuration in memory; emit match booleans only. Especially
   preserve user, command, env, networks, mounts, readonly/security/resource and
   health settings. No diagnostic may dump interpolated secrets.
3. Immutable guard/target binding, source witness, reset/restore generation and
   existing active marker/journal lineage match. Authority and ledger hashes
   remain unchanged; no enrollment, reset, projection adoption or marker rewrite.
4. Data mounts and account ownership are unchanged. Installer performs no SQL,
   data copy/delete or journal mutation. Normal concurrent account/worker changes
   must be reconciled through the existing controller's consistent receipts, not
   falsely treated as arbitrary file-hash parity or rolled back to older data.
5. Independent review approves the candidate and continuity evidence, followed
   by explicit approval of the exact image/service operation. PG GREEN alone is
   not application release approval. Then replace only this service through the
   current protected release mechanism, draining it normally and preserving data.
6. Verify readiness, unauthenticated 401, exact image/config/binding/marker
   continuity, stable restart count, and the approved DB-dependent functionality.
   Do not induce another production outage for testing or retry uncertain writes.

Rollback is only the reviewed prior application image under the **same current**
configuration, data and journal lineage. Never restore old database/files/markers,
or bypass a controller refusal. If a current erasure or pending operation makes
reversion unsafe, stop for that controller's recovery instead of automatic reset.
No installer or privileged activation command is provided by this proposal.

### Executable read-only baseline (controller discovery pending)

`python3 scripts/sim-pg-disconnect-baseline.py --baseline` is a host-only,
read-only helper. It never builds, uploads, changes Compose, runs SQL or activates
anything. It captures CID/image, five runtime module hashes, full runtime/image
configuration digests (values stay in RAM), actual four Compose-layer digests,
configured binding digest, disk capacity and X5 mount UUID match. It rechecks
stable runtime/config identity across the read window. A configured binding is
explicitly **not** database/controller acceptance. Secret values and raw inspect
or file contents are never printed. Local negative/privacy tests are in
`scripts/test-sim-pg-disconnect-baseline.py`.

The helper deliberately exits 2 with `activationAllowed=false`: the existing
SIM-maintain controller/interface and protected profile/marker/journal checks
have not yet been identified and accepted. Names of old bootstrap/enrollment
tools do not confer maintain authority; the COP-only release broker must not be
repurposed for SIM. No generic shell/plugin/controller callback or raw Compose
activation is substituted for this missing proof. Read-only discovery observed
96% usage on both root and X5; this is a capacity-review flag, not permission to
prune or build. Build-owner activity remains unknown, not falsely idle.

The next executable activation/build stage can be finalized only after Root
provides the exact existing controller inspection/maintain/rollback contract,
approved capacity/activity gate and exact-image GO. Until then no production
helper upload, image build, service change or operational GO is performed.

### New offline maintenance handler — NOT INSTALLED / NOT GO

Root accepted ADR0048's two-operation boundary for **source review only**.
`scripts/sim-pg-disconnect-maintain.py` implements that new Root-only one-off
boundary; it is not an existing enrollment controller and must not be passed off
as one. There is no sudoers/account/key/port/daemon/service installation. Neither
the handler nor its probe has been installed or run on the production host.
The unrelated AKB recovery HOLD remains effective until an actual recovery
terminal and fresh Root GO, not merely a clock time.

The eventual fixed private custody layout would be `/var/lib/csm-sim-maintenance`
(Root 0700), with Root-only `profile.json`, fresh `go.json`, a single operation
lock, private attempt/completion receipts and pinned source files in `source/`.
No provisioning command or populated GO is supplied. Those are new host control
artifacts, **not** DB continuity markers. Root review/approval is still mandatory.

The profile binds the exact base/candidate image, handler SHA, read-only probe
SHA and exact X5 UUID/mount/source-filesystem identity plus X5 free-space floor.
The `/data` source must remain a non-symlink descendant on the separately mounted
X5 device (not the root filesystem). Mount ID, device and source inode/owner/mode
are bound; both filesystems' capacity floors are checked before pin/recreate and
after startup. GO binds action, one release ID, CID/image/process generation, full normalized
runtime digest, rendered Compose digest, exact four layer-file digests, exact DB
lineage digest, fixed parent-directory custody and disk margin. GO lifetime is at
most 15 minutes; capacity/build-owner reviews must be <=60 seconds old before
mutation. A known-process build scan supplements, but does **not replace or prove**,
Root's coordinated build-owner idle review; it cannot establish remote/daemon
builder inactivity. Unknown activity is not silently treated as idle.

`scripts/sim-maintenance-lineage-probe.mjs` uses the existing app's restricted
runtime credentials only inside that container. It executes two **READ ONLY**
transactions, verifies role/binding/config/checkpoint and exact tombstone
projections twice, and returns only digests. It never initializes the factory,
replays data, or runs administrative SQL. It uses the actual pure production
transport validator, fixed mounted CA, hostname-verified HAProxy TLS, and explicit
pg options without passing a URI that could replace SSL settings. A hard 12s
watchdog bounds connect/query/close and emits no preliminary success. The actual
unchanged app may perform its normal startup replay after recreation.
The disposable real-PG fixture uses an explicit **test-only Unix transport and
module-resolution adapter**; all lineage SQL/predicates and cleanup remain actual
source. This tests database lineage, not production TLS wire acceptance. Separate
offline tests verify the production validator/options and stalled-connect/close
watchdog. No runtime transport bypass or injectable callback is introduced.

Before the first pin mutation the handler requires the exact original base,
runtime module hashes (including unchanged authority/ledger), fresh identity and
lineage, consistent full Compose rendering and no existing environment/command/
entrypoint/user/working-dir drift. Pre-recreate checks additionally compare mount,
network, health, security, resource, label and engine-default fields against the
live container. Unknown Compose service or HostConfig fields fail closed. The
fixed supported engine defaults are conservative: compatibility with the actual
host is a remaining read-only gate, not inferred from the synthetic fixture.
The candidate must preserve base image config
and all base layers and append exactly **three COPY layers**, one per allowlisted
runtime file in Dockerfile order. Each tar digest, path, content, owner, mode,
duplicate/link/whiteout/extra-path condition is checked without extraction.
Image scanning streams locally; it does not stage all base layers onto disk.
The entire export has a 120s deadline and bounded byte/header budget, including
pipe reads and process exit. Timeout kills its process group. PAX/GNU extensions,
xattrs and sparse metadata are rejected, not silently stripped. The outer parser
rejects extension headers before reading potentially huge extension payloads.
Actual Docker image build/export interoperability remains untested: no image
exists yet. The inherited base OCI revision is not relabelled as the new source;
the exact digest plus three-file source manifest are required provenance.

Only the unique quoted `sim-api.image` token is replaced; JSON semantics must
differ in that field alone and raw bytes are exactly reversible. Existing pin
owner/mode are preserved via a fixed anchored directory fd and CAS check, not
directory chmod. A durable Root-private intent receipt precedes mutation. Fresh
GO/build-owner review is re-evaluated after slow preflights, after receipt fsync,
immediately before pin mutation and immediately before recreate. The pin writer
also repeats the fixed protected profile/GO and capacity/activity gates **after
temporary-pin fsync**, repeats live-pin CAS after potentially slow protected
reads, and checks approval age immediately before the live rename. Tests for
both slow temp fsync and slow final CAS prove zero rename and unchanged live pin.
Tar/header/Unicode parser errors are emitted as a fixed bounded failure code,
never as a raw traceback. Only
the fixed `sim-api` service is recreated with no deps/build/pull; it is never
retried. Postchecks require new image/CID, healthy state, stable runtime config,
module bytes, readiness/auth and matching current lineage before completion.

Failure stops with a bounded stage/code; there is no automatic reset or rollback.
An intent without completion is not success and must be reviewed, not retried.
Fresh explicit `--rollback` approval must match the original Root profile,
current CID/process/config/lineage, unchanged other layers and exactly reversible
pin/Compose digest. It can restore the prior image only, or restore only the pin
if recreation never happened and the old service is still healthy. It does not
restore old data, credentials, epoch, checkpoint, journal or DB marker. If the
current container cannot supply verified lineage (including when it is dead),
rollback is deliberately blocked for separate Root recovery; no fallback observer
identity/container or re-enrollment is introduced.

Offline unit coverage: twenty-three handler groups, twelve probe checks, and three
baseline groups. Added negative cases cover latent Compose privilege/mount/network/
resource drift and unknown fields, filesystem identity/root fallback/symlink and
capacity, late GO freshness, hostile tar extensions/budgets, stalled reads and
whole-export process cleanup. The production-duration 12s connect watchdog and
a scaled 120ms close watchdog are tested in local children. These are not a full privileged activation/rollback
end-to-end test, not production permission, and not proof of a built image. Root
must review the new authority, exact source SHAs and remaining gaps before a
separate build/activation GO. No server action occurred during preparation.

Captured execution outputs (not just declared counts) are under
`docs/testing/receipts/sim-maintenance-20261028-*.json`. The real PostgreSQL
receipt includes `fixtureRemoved: true`, emitted only after cleanup verification.
These local receipts are not signed production admission or server acceptance.

Root's subsequent bounded live metadata showed Compose `command:null` and
`entrypoint:null` both equal their inherited image/live values, and an absent
Compose+image User serialized as live empty string. The model now implements
only those justified semantics: null/missing command/entrypoint inherits, explicit
`[]`/`''` clears, and non-null entrypoint removes the image CMD unless Compose
supplies command. No truthiness fallback is used. Only the doubly-absent User
canonicalizes to empty string; explicit user null, different user and working-dir
null are not relaxed. The three added test groups reject real exec drift,
inheritance in place of explicit clears, and unrelated null/default waivers.
This is not a change to the live config or the observer app payload.
Source: [Compose services command/entrypoint specification](https://docs.docker.com/reference/compose-file/services/#command).
The corrected current-host model still requires Root's fresh read-only check;
new unknown defaults must stop, not automatically trigger another waiver.

Root then established two exact generated-label values: environment file equals
`/srv/sim/.env`, replace equals `csm-sim-api`; current container Compose label is
5.6.0 and actual CLI is 5.6.1. The controller is now a **finite 5.6.0 → 5.6.1
metadata model**, not any-version compatibility. Every mutation preflight checks
the actual CLI short version equals 5.6.1 (optional serialized `v` prefix only).
Forward requires old container label 5.6.0. Actual recreation, including reverse
to the old APP image, requires new container label 5.6.1; pin-only reverse must
retain the existing exact label. Unknown/missing versions stop. Before the
runtime hash canonicalizes just this validated version pair to one fixed marker,
the exact env-file path and replace name must match. Both complete values remain
in the runtime hash. No other label/prefix is removed, and unknown generated or
private labels still change the hash and fail strict service parity.

The baseline digest uses the same finite canonicalization. Old runtime digests
or protected GO artifacts must not be reused; Root must produce fresh facts and
review the new source hashes. This changes no app/DB binding or production CLI.
Primary sources verified at **both exact tags**, not merely an older release:

- [5.6.0 label generation](https://github.com/docker/compose/blob/v5.6.0/pkg/compose/loader.go)
  and [5.6.1 label generation](https://github.com/docker/compose/blob/v5.6.1/pkg/compose/loader.go):
  `postProcessProject` records the CLI core version and supplied env-file paths.
- [5.6.0 recreate metadata](https://github.com/docker/compose/blob/v5.6.0/pkg/compose/executor_ops.go)
  and [5.6.1 recreate metadata](https://github.com/docker/compose/blob/v5.6.1/pkg/compose/executor_ops.go):
  `execCreateContainer` uses the explicit service container name for replace.
- [5.6.0 version derivation](https://github.com/docker/compose/blob/v5.6.0/pkg/api/labels.go)
  and [5.6.1 version derivation](https://github.com/docker/compose/blob/v5.6.1/pkg/api/labels.go):
  `ComposeVersion` is derived from the tool's core version.

Two added local test groups prove finite version transition, strict new-label
acceptance, wrong/missing-version rejection, retained env/name, unknown-label
hash sensitivity and wrong-CLI refusal before mutation admission. This is not
actual new-container acceptance; the current-host check remains Root's gate.

### Finite release preparation after separate human authority

The human has separately approved the narrow one-off protected deployment and
image-only reverse boundary. That approval does not manufacture an exact image,
fresh Root GO, capacity/build-owner clearance or successful release. Root orders
storage/COP/SIM mutations serially. No owner-side upload/build/activation is
implied by preparing the following bundle.

`python3 scripts/prepare-sim-pg-maintenance-bundle.py` is **local and inert**.
It accepts only a clean committed descendant of `c00929e`, verifies exact reviewed
handler/probe/baseline, three runtime bytes, Dockerfile and captured receipts,
then creates a private 0700 random directory under `/private/tmp` with one 0600
tar. Its manifest binds the actual source revision and all payload hashes, but
has `candidateImage:null` and `deploymentAuthority:false`. It contains no GO,
profile, credentials, env or production configuration. The `build/` subtree has
exactly Dockerfile plus the three COPY inputs; the repository `.dockerignore`
must not be substituted (it excludes dist). Three local bundle tests cover the
exact context/inert deterministic manifest, changed bytes and dirty checkout.

The finite Root-reviewed sequence is:

1. **Fresh Root build gates:** verify host identity, capacity on root/X5, actual
   X5 device, existing API identity/health, unchanged approved source hashes and
   coordinated absence of competing storage/recovery/build work. Root issues a
   new exact build GO. Preserve base image and original pin/config/receipts.
   No pruning, dependency installation, package upgrades or network changes.
   The bundle carries a capacity formula, not a forged live clearance. Let `B`
   be the actual existing base image `Size` from fresh Docker inspect, `C` the
   bundle byte length, and `Rroot`/`Rx5` the greater of 2 GiB and Root's existing
   reservations for other projects. Conservatively require root free space
   `>= 2*B + 1 GiB + 6 MiB + C + Rroot`, and X5 free `>= C + Rx5`. The base
   image stays retained; shared layers normally make the image delta far smaller,
   but the budget allows two full-base-sized transient allocations plus 1 GiB
   scratch/metadata and at most three 2 MiB COPY tar layers. Runtime inputs total
   exactly 28,467 bytes. Export streams without disk staging (up to the existing
   4 GiB byte budget), not a second full image tar. Root must confirm the chosen
   local builder/storage cannot exceed this model; otherwise stop and revise
   the reviewed budget. The observed 12:25 UTC capacities are not fresh build
   admission. `B` is currently unknown to this package; do not claim capacity PASS
   or consume other projects' reserves from those observations alone.
2. **Custody and build only after that GO:** verify the externally reviewed bundle
   digest and exact tar allowlist before placing its files in Root-controlled
   non-symlink staging. No extraction of unchecked paths as Root. The base image
   must already exist locally under exact `407606…` ID. Use only the four-file
   build subtree and its pinned Dockerfile, without added args/labels/steps.
   Root must verify the chosen builder consumes that local image without a
   registry fetch; `--network none` alone does not prevent registry resolution.
   `--pull=false` is not permission to fetch a missing base or change builder.
   If the local builder cannot do this, stop for Root review; no silent fallback.
   Capture actual new image ID from the builder. Do not start any container.
3. **Actual image evidence:** inspect exact new ID, platform and full Config;
   require unchanged base Config, original base layers plus exactly three COPY
   diffIDs, expected order and three byte hashes. Run the reviewed bounded
   `image_gate` against the actual export, not a fabricated tar. Preserve its
   receipt and reject unsupported export format rather than weakening checks.
   No new image digest is predeclared by this source package.
4. **Fresh profile/forward GO:** only after image evidence and current protected
   facts pass, Root assembles its private profile and GO. The profile contains
   exact handler/probe/base/new-image IDs and actual `/data` filesystem identity
   plus reviewed X5 free-space floor. The GO uses a new 32-hex release ID, exact
   current CID/image/start/restart/runtime hash, four layer-file and rendered
   Compose hashes, current read-only DB lineage, actual parent custody, capacity
   floor and fresh owner/build timestamps. No supplied sample/static values
   confer authority. The schema and checks are the reviewed controller source;
   the old live-probe receipt is evidence, not a replacement for fresh admission.
5. **Single forward:** invoke the fixed Root-owned handler once with `--activate`.
   It durably records intent, changes only the unique `sim-api.image` token and
   recreates only `sim-api` without dependencies, build or pull. Preserve every
   other field/service. A timeout, expiry, drift or missing completion means stop
   and review, never repeat automatically. Cold start may briefly interrupt API.
6. **Acceptance:** require actual new CID/image/module hashes, restart0, healthy,
   stable normalized runtime and all four layers except the single pin delta,
   readiness200, unauthenticated internal request401, actual TLS/DB lineage,
   X5/root margins and a completion receipt. Verify authenticated application
   behavior using separately approved synthetic requests; do not erase an account
   or force a production PostgreSQL outage for this release test.
7. **Separate finite reverse if required:** preserve the base image and activation
   intent evidence. Obtain a new Root `rollback` GO for the same release, current
   CID/process/config and **current** matching lineage. Invoke once with
   `--rollback`; only the exact reviewed prior image/pin may return. If forward
   never recreated and the original service is still healthy, reverse may repair
   the pin only. If lineage cannot be verified, the container is dead or continuity
   changed, stop for separate Root recovery. Never restore old DB/data/credentials/
   epochs/checkpoints/journals, reset/enroll, bypass auth or retry business work.

No one may copy the forward GO into reverse, treat a receipt as perpetual GO, or
claim that source/unit acceptance proves actual image/export/start acceptance.

#### Named local OCI base variant — source preparation, not build GO

`python3 scripts/prepare-sim-pg-maintenance-bundle.py --oci` preserves the earlier
bare-base bundles and emits a separate review bundle plus `build-context.tar`.
Both files are private 0600 in a new 0700 directory. The context is exactly four
regular files in USTAR format, uid/gid/mtime zero, mode 0644, no extensions or
`.dockerignore`. The only build-input difference is the separately pinned
`deploy/sim-pg-disconnect-oci.Dockerfile`: `FROM sim_reviewed_base`, followed by the
identical three COPY instructions. No remote syntax directive, RUN, dependency
step, environment, label or alternate application source is added.

The manifest binds context SHA/length and the named `oci-layout` base context.
Its actual path/digest and worker acceptance remain null/false: they must come
from Root's actual evidence, not from this local package. Before any build:

- Verify the existing **sim-x5** node/worker identity, builder/plugin versions,
  definition custody/hash and current running state without bootstrap. Verify
  its actual state/cache storage is on the independently mounted expected X5
  UUID. A builder definition alone is not worker/storage/idle evidence. Never
  initialize another builder or switch global defaults. The original sim-x5
  definition did not prove a live worker. The explicit shared-worker variant
  below is separately scoped to the already-running cop-x50 and COP owner ack;
  it is not an automatic fallback.
- Root must separately review the precise finite Docker-save-to-OCI converter
  (including any COP utility proposed for reuse), its complete source/hash,
  bounded export/paths/link handling and zero registry resolution. No converter
  is implicitly trusted or installed by this package. Build-only conversion
  must use the exact existing base ID, with OCI config blob digest equal to
  `sha256:407606…`, original 14 ordered uncompressed rootfs diffIDs, original
  platform and full Config. Verify every blob/manifest/index digest, order,
  media type and allowed path under private non-symlink custody.
- Bind the fixed name `sim_reviewed_base` explicitly to the local OCI layout by
  its actual manifest digest (`oci-layout:///RootReviewedPath@sha256:…`). The
  reviewed build invocation must use that binding, the exact context tar/hash,
  existing explicitly selected sim-x5 builder, bundled Dockerfile, no cache
  import/export to a registry, no frontend pull, no provenance/SBOM additions,
  no dependency installation and no bootstrap/fallback. `--network none` and
  `--pull=false` remain insufficient evidence on their own. If support, worker
  state or local context resolution is unknown, stop before build.

The original file/archive budget is superseded for the implemented streaming
variant below. It does not stage a full Docker-save archive or a full candidate
export archive. Its explicit floors are root **2 GiB**, X5 **10 GiB**, plus before
preparation `4*B + 256 MiB` working allowance on each filesystem. Before solve,
after the OCI copy exists, it requires a further `2*B + 256 MiB` above each floor.
The OCI-copy parser itself caps input/unpacked bytes at `2*B + 16 MiB`, with
`B=203231596` freshly verified against the exact SIM base. Space floors are
checked again while streaming and after validation. Existing usage is never
pruned to pass. This conservative SIM-only model is not a proven 2B-peak budget
for the much larger COP image. Root must separately accept actual worker/cache
behavior and any higher existing reservations; otherwise no build GO.

The existing **full Config equality, original layers plus exactly three COPY
layers, ordered runtime bytes and strict bounded image-export gates remain
unchanged**. A named OCI base is not permission to rewrite Config/defaults,
flatten layers, skip blobs, accept PAX/xattrs/sparse data, or waive a failed
image-format check. The actual resulting image ID and all fresh profile/GO and
forward/reverse gates remain required. Five local bundle tests prove only the
inert context/variant byte scope, not Docker/worker/OCI conversion acceptance.

#### Implemented finite direct-client build-only candidate

`scripts/build-sim-pg-maintenance-oci.py` and `scripts/sim-pg-base-oci.py` are
**source-only, not installed/run on the host**. The fixed operation is a Root
invocation of the reviewed helper at
`python3 -I -B /var/lib/csm-sim-maintenance/build-source/build-sim-pg-maintenance-oci.py --build-only`.
It cannot create/start/bootstrap/update a worker and never invokes buildx.
It also cannot call app up, change Compose pins or app profiles, read `.env`, run
application DB operations, prune or retry. Existing application Config is compared
only in memory to prove no process/config change; it is not written/exported.

The one shared-worker variant is explicitly `buildx_buildkit_cop-x50`, with the
observed pinned BuildKit image ID `27933730…`, its cached registry digest, fixed
buildctl v0.33.1 revision `8c91502…` and actual binary SHA `7809f0f3…`. A private
Root GO must bind the exact current CID, start/restart generation and full worker
Config/HostConfig/Mounts digest. It verifies both registry-image binding and
binary bytes, denies client-covering mounts or writable client/ancestor changes,
and verifies the existing local volume's exact physical X5 bind. The observed
builder definition is only a provenance hash, not execution authority. A missing,
stopped or changed worker stops; no alternate builder is selected.

The GO is **build-only**, separate from release profile/GO. Its exact schema is
the helper's `admission()` function: contract/release/time fields, current worker
identity/digest, three exact source hashes, Docker binary hash and hashes of two
private Root-held evidence files (`cop-worker-owner-ack.json` and
`storage-closeout.json`). Files and ancestors require Root custody, no links and
0600 files. Root must populate these from genuine reviewed source/current facts
and owner/window evidence, not samples or copied prior approval. The helper
does not generate this GO, elevate rights or make its own acknowledgement.
GO lifetime is at most 15 minutes; capacity/build-owner reviews must be <=60s old
before each mutating phase. A shared Root `cop-sim-build.lock` serializes the
operation; it is not proof that unrelated builders are globally idle. Root's
coordinated owner/window review remains necessary in addition to actual recorded
history checks.

Only a new private job is created under the approved **existing** worker bind
`/srv/x5-production/cache/cop/buildkit/sim-pg-maintenance-<releaseId>`; its exact
container view is `/var/lib/buildkit/sim-pg-maintenance-<releaseId>`. This is a
temporary, explicitly shared build job, not relocation of SIM runtime data into
COP storage. Existing daemon cache databases/Docker internals, mounts, networking,
permissions and other services are not directly edited. Enclosing job is 0700;
its exact four context files are uid/gid0, 0644 and mtime0, with exact required
parent directories uid/gid0, 0755, mtime0. All context/policy/auth bytes and OCI
blobs/index hashes are rechecked before and after solve.

The implemented converter consumes a bounded `docker image save` pipe directly
into one digest-addressed OCI layout. It never extracts archive paths. Every
outer header, including unreferenced members, is checked before payload parsing:
PAX/GNU extensions, links, devices, duplicate/traversal paths and oversized input
are rejected. Only actual pinned config bytes and verified raw/gzip layer blobs
are retained. Config digest must equal SIM base ID, full Config/platform and
14 ordered uncompressed diffIDs must match actual image inspect, and inherited
OnBuild must be empty. Unknown/corrupt format is a stop, not a PAX waiver. The
owned-file adapter exists for local fixtures only; production uses the streaming
function. No complete archive is persisted by the driver.

The solve directly execs the exact worker **CID**, with fixed socket
`unix:///run/buildkit/buildkitd.sock`, builtin `dockerfile.v0`, the four-file
context and one named OCI store. Each job provides its own empty Docker auth
directory (`config.json` is exactly `{}`), supplied via explicit HOME and
DOCKER_CONFIG. No existing Docker auth, SSH/secret/session forwarding or remote
cache flags are supplied. A **per-solve**, not global, source policy denies
docker-image/http/https/git sources. Named source syntax is source-backed:

- [v0.33.1 OCI provider parser](https://github.com/moby/buildkit/blob/v0.33.1/cmd/buildctl/build/ocilayout.go):
  `--oci-layout simbase=<container-job>/base-oci`;
- [v0.33.1 named context resolver](https://github.com/moby/buildkit/blob/v0.33.1/frontend/dockerui/namedcontext.go):
  `--opt context:sim_reviewed_base=oci-layout://simbase@sha256:<actual-manifest>`;
- [v0.33.1 build client](https://github.com/moby/buildkit/blob/v0.33.1/cmd/buildctl/build.go)
  and [policy schema](https://github.com/moby/buildkit/blob/v0.33.1/sourcepolicy/pb/policy.proto)
  establish provider, builtin frontend and per-solve policy options.

Root observed `/usr/bin/timeout` as cached BusyBox1.37.0, binary SHA `f3547b3d…`.
The driver verifies it and wraps the single buildctl process with TERM at 300s,
KILL grace15s; host stream deadline is 330s. Buildctl `--timeout5` is only a
connection timeout. **Neither killing the host exec client nor timing out proves
backend completion.** A failure after solve starts reports remote completion
unknown, preserves its job and requires actual Root history/PID review. No retry,
worker restart, prune or automatic cleanup follows. Actual recorded solves must
be COMPLETE with valid CreatedAt/CompletedAt pairs; unknown/missing rows fail.

Docker output streams only to the existing Docker image store, under a new
non-preexisting `csm-sim-pg-observer:root-<releaseId>` candidate tag. No app starts.
An image is not declared ready until the original reviewed controller's actual
image-export gate confirms exact full Config, base layers plus exactly three
allowlisted COPY layers and content hashes. Unsupported export format fails
closed. The immutable image ID, exact sources/GO/context/OCI digests and unchanged
app identity enter a durable private completion receipt; `releaseAuthorized`
remains false. A failed/partial image is not release acceptance and is not pruned
automatically. Forward/reverse admission and real application acceptance are
still distinct subsequent stages.

Local evidence: `test-sim-pg-base-oci.py` has eleven synthetic fixture groups,
including the actual-observed style of hybrid OCI Docker-save with 35 outer
headers and 30 blobs plus index/layout/manifest metadata; Config/Layers paths
need not be legacy filenames. This is a synthetic format fixture, not acceptance
of Root's actual exported bytes.
`test-build-sim-pg-maintenance-oci.py` has eleven groups including actual local
pipe streaming/deadline cleanup, wrong idle schema/CLI context, no-bootstrap and
no-app-operation paths. Captured outputs are in `docs/testing/receipts/`.
These are not privileged host E2E, actual worker/OCI-export compatibility,
per-solve policy runtime acceptance or production deployment evidence.

#### Existing candidate adoption after actual inherited-directory evidence

Root reports one actual solve/export/load produced immutable candidate
`sha256:0e6b989a135cf618cd02903a54b76a272f4ed574b73005a2c502c7ce304f15cd`.
Its original 9af-controller build result is **failed at LAYER_DIR**, not a success
receipt. Full Config equality and 14 base-prefix + 3 new layers matched; actual
file bytes require the separately corrected gate's complete check. No app up
occurred and no rebuild is authorized by the correction.

Root then proved current old runtime is exact BASE4076, directory
`/app/packages/sim-user-data` is root:root 0775 and Docker diff changes neither
that directory nor ancestors. This binds the inherited metadata to the immutable
base, rather than treating 0775 as a general acceptable permission. The narrow
validator now requires exactly 0775 for `app/packages/sim-user-data` **only** in
the single-file bootstrap.mjs or pg-errors.mjs COPY layer with its pinned content
hash. All other known directory cases still require 0755; unknown modes, paths,
UIDs/GIDs and even 0755 instead of that exact inherited 0775 are rejected. All
other image/config/content/export/freshness/lineage gates are unchanged.

The new controller SHA is
`46af72cd310c509d64a1d68ab8a422caf43629c1bee4b88a98f65738840d1598`.
The new local receipt is `sim-maintenance-20261028-handler24.json`. Root must run
a **distinct read-only actual acceptance** of the same existing candidate under
this exact new source; preserve the original failed build/GO/source evidence.
Do not fabricate or rewrite its missing completion file as PASS. Deployment
profile changes only its handler source hash (probe and app bytes unchanged),
then freshly derives all normal GO fields/lineage from actual current state.

The build-only source, input bundles and build GO remain frozen at their
historical versions. Their pinned 9af controller is deliberately not rewritten
or rerun. The old build-bundle generator must be used only from its frozen build
checkout/artifact for forensic reproduction; current source no longer matches
that historical build-input pin, and its refusal is not permission to substitute
the corrected deploy controller into the original build operation. This stage
adopts an existing image; it does not prepare a second build.

#### Finite empty-DNS serialization amendment (Root acceptance still required)

Root's single actual forward invocation `78a7cc8faa074cb284d6c3523f03ee38`
recreated the API with candidate `0e6b989a...`, then stopped at `POST_RUNTIME`.
The new process was reported healthy, restart count zero; strict rendered model,
compiled modules, readiness/auth and actual TLS/database lineage passed. This
was **not** original forward completion. Root's bounded private preimage search
then uniquely reproduced the original full sealed runtime SHA
`ac363097ca5a677189897d62560e534854e1f068ba1c5d9c7b2713eff6fa03cd` by
changing only `HostConfig.Dns`, `DnsOptions`, `DnsSearch` from explicit null to
empty arrays. No other field, order or value changed. These are Root-reported
actual observations, not a substitute for its protected witness/receipts.

The amended source normalizes only those three explicitly present fields:
null becomes `[]`; string lists remain unchanged, including nonempty lists;
other types fail. Missing fields remain missing. All other runtime fields keep
their original hash semantics. The strict rendered model still rejects DNS
configuration drift. No DNS/network configuration is changed.

New controller SHA:
`87a822a98e7bdac5548d34dc893102786d6ab8c7bc0921e6683495202f509c56`.
Root must preserve the original 46af source under protected
`source/sim-pg-disconnect-maintain.46af.py`; original `profile.json`, `go.json`,
forward intent, invocation failure and missing forward completion stay intact.
Do not replace them, rerun activate or manufacture `*-activate-complete.json`.
The new CLI refuses `--activate`.

Root creates fresh protected O_EXCL files with file/directory fsync:

- `profile-dns-v1.json`: original profile exact schema and values, changing
  **only** `handlerSha256` to the new source above. Probe, candidate, base and
  filesystem identity/floors remain unchanged.
- `go-dns-v1.json`: original 18-key GO schema, action `accept-existing-dns`,
  fixed original release ID above, expected candidate image/current CID/start/
  restart zero, new profile SHA, original canonical runtime SHA above. Derive
  compose/layer hashes, lineage, custody, capacity and build-owner times from
  actual current state. Original GO expiry is historical evidence, never reused
  as current authority; new GO must pass the existing freshness checks.
- `dns-serialization-amendment.json`, exact contract
  `sim-empty-dns-profile-amendment-v1`, exact keys:
  `contract`, `originalProfileSha256`, `originalGoSha256`,
  `originalIntentSha256`, `originalFailedResultSha256`, `newProfileSha256`,
  `releaseId`, `candidateImage`, `runtimeSha256`, `observedRawRuntimeSha256`,
  `acceptedCid`, `acceptedStartedAt`, `acceptedRestartCount`, `changedFields`.
  SHA fields bind raw protected original/new files. `observedRawRuntimeSha256`
  is the actual `digest(raw_normalized_runtime(current))`, not the canonical
  hash. `changedFields` is exactly `["HostConfig.Dns", "HostConfig.DnsOptions",
  "HostConfig.DnsSearch"]`; current fields must all be null. Candidate,
  generation, original 46af source/profile, original POST_RUNTIME failure,
  original intent/GO and unchanged lineage are checked, not merely attested.

Root reviews/stages the source, then may invoke the fixed sealed controller
with `--accept-existing-dns`. It checks the actual full image, current runtime,
strict model, readiness/auth, modules, TLS lineage, filesystem, inverse Compose
and pin bytes, non-pin layers and fresh final approval. It executes **no app up,
pin write, build, database mutation or rollback**. Only a new distinct
`78a7cc8faa074cb284d6c3523f03ee38-dns-post-acceptance.json` receipt is created.
This receipt records amendment/profile hashes, same generation/runtime/lineage
and `appUpExecuted:false`; it cannot rewrite the failed original attempt.
GO age is checked again after the final exact protected profile/GO readback,
immediately before receipt creation; a slow read cannot authorize stale acceptance.

Future explicit Root reverse uses a **separate** fresh protected
`go-dns-rollback-v1.json`, action `rollback`, same release/new profile/candidate
generation and all normal runtime, data, capacity and owner gates. The original
profile hash is bridged only by the exact artifact chain above and the distinct
post-acceptance receipt; both are rechecked at fresh mutation admission. No
general profile or lineage waiver exists. Reverse remains image-only, one fixed
Compose service up, no data restore and no automatic retry. A different process
generation, restart, lineage, original artifact or unknown residual state stops
this finite lane and requires a separate Root-reviewed recovery decision.

`sim-maintenance-20261028-dns29-final.json` captures 29 local synthetic test groups,
including expiry after that final protected readback (the earlier receipt remains
historical evidence for its prior source hash);
baseline three groups also pass. The unit fixture mocks the fixed actual
preimage hash; therefore it is **not** independent actual production preimage
or Root E2E proof. Production acceptance remains the Root operation above.
