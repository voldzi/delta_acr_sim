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
   The actual `PublisherStoreData` shape has required `items` (array) and
   `publishingEnabled` (boolean), plus only optional `lastSuccessAt` and
   `lastFailureAt` canonical UTC timestamps (`YYYY-MM-DDTHH:mm:ss.SSSZ`). Both
   inspection and application use the same strict scanner; unknown keys or
   invalid timestamps fail closed. The original bytes, including timestamps,
   remain covered by the reviewed digest and stopped-writer CAS. Reset clears
   the queue and these old attempt timestamps, preserving only
   `publishingEnabled`; the candidate still requires the exact empty two-field
   legacy baseline. No input normalization is performed before admission.

   The actual current deploy script is not rewritten for the finite preservation
   profile SHA `822af06be95f9beca59a5ba485c9a165f741a78adcdec48416f179791dab4757`.
   That exact UID/GID 1000, mode `0700`, single-link file has a reviewed fixed
   DBv2 guard before any pull or environment rewrite. It is admitted only while
   the single raw authority-mode line matches that guard's `database_v2` pattern.
   The same line must survive environment rendering unchanged. File bytes and
   complete identity metadata must still match after configuration staging.
   No new prefix, chmod or older deploy body is installed for this profile;
   current municipal/media settings and safety-image preservation are untouched.
   Unknown hashes, modes, altered guard prefixes and conflicting mode lines
   remain errors. The previously admitted legacy profiles retain their original
   guarded replacement path.
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
