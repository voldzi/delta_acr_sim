# 24 — Clean lifecycle source candidate

Status: source + owned synthetic PostgreSQL/HTTP tests only. No live production
permissions, secrets, reset or activation. Does not extend CF24/native-v1 or reuse
an old operation. Contract `cop-sim-user-lifecycle-v1`; two exact, non-interchangeable
server modes: `isolated-clean-lifecycle-v1` and `production-clean-lifecycle-v1`.

## Concrete component

`deploy/clean-lifecycle/001_clean_lifecycle.sql` creates a NEW `sim_clean` schema
with explicit config/environment/resetEpoch, account, resource binding, durable
job and anonymous financial totals. No epoch is generated on startup. It must
match the externally supplied expected epoch. Missing config/DB means refusal.
Configuration enrollment/reset is an offline owner action after stopped writers,
not a runtime update. Runtime has SELECT only on config and no DDL.

`packages/clean-lifecycle/store.mjs` implements transactional owner reservation,
durable deletion request/fence, idempotent operation and cleanup retry. Caller
must derive owner/resource hashes from authenticated issuer+subject server-side;
raw identity, browser-selected owner, credentials and GPS are not accepted by this
adapter. This library is not an authentication middleware or public API.

Use a separate instance/config in each AI and driver DB. Reserve owner/resources
BEFORE provisioning or user writes. Driver requires all retained daily contributor
hashes (up to 32 per reserve call); more can be reserved in subsequent calls while
active. Hashes cannot move between owners. Pending/deleted owner cannot add hashes.
Existing user hash/HMAC derivation must not change implicitly.

Database triggers hold account SHARE locks during actual AI/driver writes.
Deletion waits for those writes, commits a durable pending job and prevents late
writes. A pre-fence AI reservation may settle only its status/cost/token fields
with unchanged identity/model/payload. Unsettled reservations keep cleanup pending;
the stored user key is already removed. Worker exceptions roll back all cleanup.
Caller must periodically call `runOne()` with bounded backoff, including after
restart. The job remains queryable and no process-local receipt is required.

Concrete cleanup: AI `ai_router_request` COP lane, `ai_router_billing_request`
COP-chat actor lane, `ai_router_user_key`, `ai_router_user_key_audit`;
driver `driver_measurement_receipts` with cascade to intervals/ETA, plus ordinary
measurement revocations for bound contributors. Readback precedes completion.
Anonymous current-month totals are retained separately per accounting lane until
the next UTC month boundary, only after reservations have settled. They contain
no owner key. `purgeExpiredTotals()` removes expired totals transactionally.
The verified clean bootstrap explicitly selects `sim_clean.router_usage` in
BudgetStore and `sim_clean.billing_usage` in PgSeparateBilling. The old views and
selection remain unchanged when clean mode is absent. Both live rows and anonymous
totals remain in financial/count/token reporting; deleted identities do not remain.

## Actual isolated evidence

`node scripts/test-clean-lifecycle-postgres.mjs --run` creates its OWN PostgreSQL
18.3 cluster under a new mode-0700 temporary directory, Unix socket only; accepts
no external target, password or URL. Uses the actual base AI/driver schemas and a
restricted non-superuser runtime role, not mocked DB calls. No provider is called.

Owned isolated (158 checks) and production-mode (169 checks) test runs both cover two actual PostgreSQL
restarts: A/B isolation, true
concurrent writer/fence ordering, cascade cleanup/readback, refusal of late writes,
same-operation replay, immutable owner/epoch/operation, no resurrection, pending
AI reservation/key removal/settlement, actual DB outage, deliberate completion
failure with transaction rollback and successful retry, missing/wrong epoch,
exact-once financial totals and preservation of policy. This is component evidence,
NOT COP/Keycloak/Messaging whole-service acceptance or deployment evidence.

## Finite read-only live inventory (2026-10-17)

Only aggregate counts were read in READ ONLY transactions; no identities/values.

| Store                                                   |                      Count | Proposed reset classification                                         |
| ------------------------------------------------------- | -------------------------: | --------------------------------------------------------------------- |
| ai_router_request                                       |        23: 20 COP, 3 other | COP user history; other lane excluded from per-account COP cleanup    |
| ai_router_user_key / user_key_audit / billing_request   |                  0 / 0 / 0 | user data                                                             |
| ai_router_account_erasure / erased_cost_daily           |                      0 / 0 | old protocol state; do not enroll as new operations                   |
| ai_router_policy / policy_audit                         |                      1 / 6 | PRESERVE configuration                                                |
| driver receipts / intervals / ETA                       |                  0 / 0 / 0 | user measurement data                                                 |
| driver_measurement_revocations                          |                          6 | user measurement tombstones; reset only with epoch/writer gate        |
| driver_account_erasure_state / operations / revocations |                  1 / 0 / 0 | old protocol state; no new-scope migration by inference               |
| sim-store scenarios / drafts                            |                     11 / 4 | shared test scenario artifacts, no account ownership in existing JSON |
| publisher queue items                                   |                          0 | shared synthetic publisher state                                      |
| geo-routing precomputed                                 | 912 files, 8,485,677 bytes | generated routes; no reliable per-user link in existing store         |

Read-only paths: `/srv/x5-production/data/csm-sim/sim-data` (sim-store.json,
publisher-queue.json, sim-audit.jsonl exists); situation path
`/srv/x5-production/data/csm-sim/situation-data/geo-routing-v1/precomputed`.
Radio profile file was not readable/present; absence not inferred from an error.

PRESERVE: config including aiConfig/runtime settings inside mixed sim-store.json,
policies, .env/secrets/certs, service identities, deployment/source/release paths,
all official/provider datasets (PostGIS/DEM/Copernicus, weather radar, safety,
flight data, Valhalla graphs/TMC/OpenLR/traffic/static caches and closure reviews).
TAK partner events and integration configuration are separately owned; do not
include the whole `sim_tak-gateway-data` volume in a user reset. Driver report
cache `/srv/x5-production/cache/csm-sim/driver-measurement-reports` is derived
measurement material; regenerate/invalidate after a coordinated reset, not an
official provider store. No broad directory/volume deletion is approved here.

## Remaining gates and rollback

## New HTTP and signed actor (source only)

AI prefix `/api/v1/ai-router/internal/user-lifecycle/v1`, driver prefix
`/api/v1/internal/user-lifecycle/v1` on its internal service. POST `/deletions`
and GET `/deletions/:operationId`. No public port is added. The composite OpenAPI
driver path includes its usual `/situation-data` gateway prefix; do not expose it
publicly. A component receipt never asserts whole-account completion.

Both actual index files call their dedicated clean bootstrap before serving
requests. Default `SIM_CLEAN_LIFECYCLE_ENABLED=false` leaves the entire legacy
composition unchanged. Explicit true requires mode, environment UUID, reset epoch
and token cutoff matching actual DB config; the migration refuses a populated
user-data baseline. Configuration is verified before AI policy initialization.
The production mode exists in source after independent readback of the human's
explicit COP reset approval, but has not been activated on a production host.

`SIM_CLEAN_LIFECYCLE_MODE` (one of the two exact modes),
`SIM_CLEAN_LIFECYCLE_ENVIRONMENT_ID`, `SIM_CLEAN_LIFECYCLE_RESET_EPOCH` and
`SIM_CLEAN_LIFECYCLE_TOKENS_NOT_BEFORE` are the common non-secret settings.
Existing COP service/signing credentials, hash derivations and pinned issuers are
passed by the owning app; no secret is copied or printed. The cutoff is also a
DB config field; a mismatch refuses startup/requests. Zero is only a synthetic
fixture cutoff, not a production reset recommendation.

### Production enrollment, never an isolated-mode promotion

`SIM_CLEAN_LIFECYCLE_USER_DATASET_ID` and
`SIM_CLEAN_LIFECYCLE_PRODUCTION_ENROLLMENT_ID` are additional mandatory UUIDs in
production mode. Cutoff must be nonzero and not in the future. Source loader and
each DB admission verify an exact immutable `production_enrollment` witness with
matching environment, reset epoch, dataset, enrollment ID, cutoff and the fixed
`root-clean-empty-baseline-v1` attestation. Isolated config cannot be updated to
production (nor production to isolated). A missing witness never creates one.

Only the migration owner may call
`sim_clean.enroll_production(environmentUUID,epochUUID,userDatasetUUID,enrollmentUUID,cutoffSeconds,lane)`.
The security-invoker function has no PUBLIC/runtime EXECUTE grant. It locks the
finite owned tables, refuses existing lifecycle config/resources/jobs, verifies
empty COP user scope, and atomically records the witness and production config.
It does not delete anything. Requests with `client_id<>'cop'` and billing with
`task_type<>'cop_chat'` are preserved and do not fail COP-scope emptiness; policies
and other provider/other-application data are never part of the check or cleanup.
Global COP BYOK keys/audits and driver tables must be empty before enrollment.

Runtime may only SELECT the witness. Mutation of it is blocked by an immutable
trigger; config updates are also blocked. Source grants remain fixed to the
existing, non-superuser AI/driver runtime roles, with no DDL or enrollment right.
The new config does not adopt an old CF24 operation, policy, identity receipt or
history. Root still must execute its approved finite reset and preserve plan;
this source contains no live reset command.

Root's later owner-only installation sequence, after its separately approved
finite reset/preserve plan and stopped writers: existing base AI 001/002 or driver
schema, clean 001, clean 002 views on AI only, fixed writer fences 005 (AI) / 006
(driver), restricted grants 003 / 004, then explicit production enrollment.
Do not apply any of these over CF24 control tables or remove historical triggers
to force admission. The migration role, not the runtime URL, performs DDL. No
function or startup path runs migrations automatically. Before release, Root must
verify both service capabilities and its independent restore/replay acceptance.

Run `node scripts/test-clean-lifecycle-postgres.mjs --run` and separately
`--run-production-mode` after building both services. BOTH commands create a new
owned, Unix-only local cluster and synthetic accounts; the latter does not target
a production DB. They test the same actual bootstraps and ordinary business routes,
plus missing/wrong enrollment, zero cutoff, mode mismatch, failed enrollment with
COP data, immutable metadata, limited roles, and preservation of other-lane history.
See ADR 0042 for the authority and restore boundary.

AI startup uses its existing BudgetStore pool and enables both clean accounting
selectors. Driver startup creates its own restricted driver-lane control pool
and explicitly selects the new clean storage composition. It does not instantiate
the historical erasure owner in that mode. Combining clean mode with legacy
erasure enabled, guarded operation port, database safety port or legacy retention
consumer is rejected. The legacy composition is not modified or replayed.

Normal COP AI writes and driver batches reserve signed owner/resource bindings
before persistence. Actual driver lookup/commit, revoke, retention and publication
reads verify the new DB config/epoch; intake locks the registered active owner in
the transaction and DB triggers reject late writes. Retention remains seven days.
The source initializes a bounded single-flight worker every 15 seconds; no timer
starts at constructor time. Shutdown stops scheduling, awaits in-flight work and
closes owned pools. Worker SQL has 5-second statement/1.5-second lock limits.
No new listening port or public route is created by the bootstrap.

Headers are deliberately separate from the legacy AI actor: `x-cop-clean-actor`
and `x-cop-clean-actor-signature`. Encode compact JSON UTF-8 as unpadded base64url;
signature is lowercase hex HMAC-SHA256 over the encoded string with the existing
authorized COP signing secret (not copied/rotated by this change). Bearer must be
the corresponding existing COP S2S service token. Exact actor claims:

`{iss,aud,sub,oidcIssuer,oidcSubject,resetEpoch,operationId,requestedAt,iat,exp,jti,resourceId,oidcIat}`.

`iss=cop`, `aud=sim-clean-lifecycle-v1`, pinned OIDC issuer, canonical UUID subject,
existing `cop_` opaque sub (43 base64url suffix chars), matching epoch, UUID
operationId/jti, canonical UTC requestedAt. iat/exp are integer epoch seconds;
maximum 60 seconds, no future iat or expired actor. All unknown keys are rejected.
There is no change to the legacy x-cop-actor assertion or opaque-ID derivation.
`oidcIat` is the ORIGINAL verified OIDC token issue time; it must be strictly
greater than the epoch-bound configured token cutoff. A newly signed HMAC does
not refresh an old OIDC token. Missing or stale original token time is refused.
The COP service attests it; SIM cannot verify the original JWT from this claim.

GET `/capabilities` requires only the service token, never a user actor. It checks
current DB config/epoch, actual trigger count and enabled state, read access and
AI budget views plus supplied worker readiness. It returns a strict typed
readiness receipt; a disabled/stopped/unavailable component is 503 with ready=false.
The actual clean driver bootstrap is tested with the actual app factory and
ordinary batch handler, not a substitute writer. The test accepts A/B batches in
shadow_only, fences A, deletes A with real DB readback and preserves B. The AI
test uses the actual factory and a loopback-only synthetic local model, encrypted
test keys and real BudgetStore accounting; external provider attempts are zero.

Signed `resourceId` is the existing opaque sub on AI, or COP-attested daily
contributor pseudonym on driver. It must match the actual write body; the AI BYOK
legacy actor sub must also match. It never selects the owner: owner comes only
from signed pinned issuer+UUID subject and the private owner HMAC. COP must attest
that the pseudonym belongs to that account; SIM cannot independently prove that
relationship merely from a pseudonym. Headers/identities must not be logged.

POST body has exactly `contractVersion=cop-sim-user-lifecycle-v1`,
`scope=cop_sim_shared_identity_v1`, matching resetEpoch/operationId/requestedAt.
202 follows durable pending commit; 200 means component deleted, not shared
identity deleted. Missing/invalid token or actor returns401, invalid body400,
immutable-operation conflict409; disabled mode/DB failure returns503. Status is
owner-bound and returns404 for an unrelated operation. Source HTTP tests exercise
these routes over loopback using the real isolated DB, not mocked persistence.

## Deployment gates

### New whole-composition fixture, not CF24

`scripts/fixtures/clean-whole-sim-v1.mjs` is a NEW public source composition
with contract `cop-sim-clean-whole-fixture-v1`. It does not rename, import or
modify the historical `whole-erasure-sim-fixture.*` or their receipts.
It uses actual compiled AI/driver bootstraps and app factories, fresh restricted
runtime/migration roles, actual ordinary handlers, clean worker timers and
PostgreSQL. Only the model and road matcher are synthetic loopback fixtures.
Driver data remains `shadow_only`. No external OpenAI request is enabled.

The fixed issuer is `https://cop-erasure-keycloak.invalid/realms/cop`, belonging
to a NEW isolated Root-owned Keycloak namespace. Root must supply the two actual
synthetic subjects and stable opaque IDs; this composition does not create,
delete, inspect or recreate Keycloak identities and cannot prove global identity
erasure. It never seeds an A-linked `sim` identity/key and does not reuse the
old preserve-SIM-identity assertion as evidence for shared identity deletion.

Root calls `makeCleanWholeInput({actors,tokensNotBefore,environmentId,resetEpoch})`
on the fixture server. `actors` has exactly `a` and `b`, each with
`subjectId` (canonical UUID), `routerUserId` (`cop_` plus 43 base64url characters),
`contributorIdDay` (32–128 opaque characters) and original verified `oidcIat`.
Each original iat must be strictly after `tokensNotBefore`; the fixture never
substitutes its current time for the original authentication iat. Other
synthetic credentials are generated in process memory. No real API key is used.
Do not transfer a private input from the Mac or between old fixtures. The common
Root controller owns any necessary private server-side IPC and tmpfs custody.

The input has exact top-level keys `contractVersion`, `fixtureOwner`, `issuer`,
`environmentId`, `resetEpoch`, `tokensNotBefore`, `actors`, `environment`.
`fixtureOwner` is exactly `cop-sim-clean-whole-20261017`. `environment` has exactly
`copServiceToken`, `driverHashSecret`, `driverActorSecret`, `routerHashSecret`,
`routerActorSecret`, `routerEncryptionKey` (base64 32 bytes), `routerSimToken`,
`routerAdminToken`. All are distinct, synthetic, private and at least 32 chars.
Root must bind these same values to its real server-side adapters; do not patch
or override an adapter to bypass the normal clean actor headers or auth.

Server CLI requires `NODE_ENV=test` and
`SIM_CLEAN_WHOLE_FIXTURE_OWNER=cop-sim-clean-whole-20261017`, a UID-owned 0700
`/fixture-clean` and single-link 0600 `/fixture-clean/private.json`. Root
generates that file on the server's private tmpfs, not via a local private-file
courier. Copy only public source and the ten `SQL_PINS` files to `/fixture-clean`.
Use immutable reviewed SIM images containing compiled bootstrap/app and
`packages/clean-lifecycle`; the outer Root controller verifies image/source
identity, container ownership, network namespace and lack of public ports and
production mounts. This component is not that host/controller evidence.

The ONLY server DB tuple is loopback `127.0.0.1:5432`, administrator
`owned_fixture_admin`, `cluster_name=cop_clean_whole_fixture_v1`,
`data_directory=/var/lib/postgresql/cop-clean-whole-v1`. The provisioner refuses
existing SIM DBs/roles and any unpinned SQL before creating anything. It creates
only `sim_ai_router`/`sim_driver_measurements` and the four corresponding
migrator/runtime roles, no shared guard or Keycloak schema. Runtime has no DDL,
role privileges or table ownership; actual capability and negative DDL checks
are required. Source migrations are the fresh base schemas, clean001–006 and
the driver's exact ETA contributor-binding migration008. Historical guards or
operations are not removed to pass this fixture.

Public entrypoint (never run against production):

```text
node /fixture-clean/scripts/fixtures/clean-whole-sim-v1.mjs provision
node /fixture-clean/scripts/fixtures/clean-whole-sim-v1.mjs serve driver
node /fixture-clean/scripts/fixtures/clean-whole-sim-v1.mjs serve ai
```

`serve` starts the actual factory, seeds only the two synthetic users through
actual driver batch/local AI generate handlers and signals `listening-and-seeded`
after success. Fake encrypted keys and billing are seeded with the actual
SeparateBilling methods, not the external key-validation endpoint. Automatic
deletion uses the unchanged 15-second clean worker interval, with no extra
tick/complete HTTP endpoint. Exported `startCleanWholeComponent` also returns
`close()` for an in-process common controller. Failures are generic and do not
print private input or bodies. Partial setup is not auto-adopted or reset;
discard that owned test environment and make a new one.

| Component | Actual API (loopback only)                                                      | Readback (loopback only) |
| --------- | ------------------------------------------------------------------------------- | ------------------------ |
| Driver    | `4311`, `/api/v1/internal/user-lifecycle/v1/{capabilities,deletions}`           | `4321/readback`          |
| AI        | `4312`, `/api/v1/ai-router/internal/user-lifecycle/v1/{capabilities,deletions}` | `4322/readback`          |

Readback is exact GET `/readback` with the synthetic service bearer token;
missing/incorrect token is 401, any other path, query, method or Origin is 404,
and an unavailable/busy reader is 503. Replies are `Cache-Control: no-store`.
Contract is `cop-clean-whole-readback-v1`, with exact reset epoch, shared scope,
mode `isolated-clean-lifecycle-v1`, component and one `owners` entry:
`sim_measurements` or `ai_router`. Its `removableA`, `removableB`, `stateA`,
`stateB`, typed `countsA`/`countsB` and `preservedBFingerprint` come from real
runtime-role SQL readback. No request-supplied identity, SQL or target selects
the readback. Expected fresh totals are AI 4/4 (key, key audit, request, billing)
and driver 4/4 (receipt, two intervals, ETA); after A deletion, A is zero/deleted
and B remains four/active with the same byte-derived row fingerprint.
Only counts/digests/states leave the process; no subjects, pseudonyms, raw GPS,
keys, encrypted blobs or request content. `wholeAccountComplete`,
`wholeCopAccepted` and `productionChanged` are always false.

`node scripts/test-clean-whole-sim-v1.mjs --run` creates its own local 0700 Unix
PG fixture, not a server deployment. The socket and data directory must belong
to that exact generated path. It validates the actual two simultaneous
bootstraps, ordinary writes, auth/iat/scope rejection, strict readback, automatic
workers, A removal/B preservation and absence of raw positions/external calls.
This cannot replace the Root whole test of actual Keycloak deletion, immutable
original principal, native/Messaging erasure, independent journal/replay,
restore quarantine or the shared controller's real writer custody.

Root owns the finite combined reset plan, writer stop, identity/roles cleanup and
deployment approval. This fixture does not execute a live reset and must never
adopt existing stores or remove guards to obtain GO. Separately reviewed reset
operator source and its exact known-guard transition are described in
[runbook 21](../runbooks/21_CLEAN_COP_SIM_RESET_OPERATOR.md); neither this fixture
nor its successful component test constitutes permission to execute that step.
Fresh namespace must be enrolled explicitly; restoration of an old epoch must
remain quarantined.
Production acceptance must cover completion receipts for both stores,
report-cache invalidation, independent same-epoch restore/replay proof,
and bounded handling of shared scenario/routes not currently linked to accounts.
The binding OpenAPI includes these explicitly source-only isolated routes.

Rollback in this scope: stop the isolated fixture; no live state was modified.
Do not rollback a future deletion by restoring user data. Keep tombstone/epoch
authority separate from rollback images and test old-epoch refusal before rollout.

## Fixed TLS fixture resume (2026-10-17, not production)

The original whole12 TLS fixture omitted `composition.start()` for the driver.
Actual capability was 503/workerReady=false while the SQL-only readback was 200.
The fixture now starts the real composition before listening. Production service
bootstrap was not the cause and its image was not patched.

`resume-whole12-tls-production-sim.mjs --resume-owned-fixture` is restricted to
one exact existing synthetic cluster/epoch. It reopens actual compiled factories
and authority against existing enrollment/bindings. It never seeds, resets,
reenrolls, changes an identity or imports CF24 operations. After the original
runner stopped, only five named test runtime passwords were rotated. Private
configuration, credentials and the pre-delete snapshot remained in server tmpfs.
No production credentials, HBA, roles or endpoints changed.

Actual main/AI/driver capabilities returned 200; all A/B data counts, states,
row/file fingerprints and eight main files were preserved. Original component
readback labels from source 0ded266 were explicitly translated in exactly four
metadata fields only; this does not relabel historical evidence or ignore data
differences. The first comparison failures are retained in private test status
files. Sanitized evidence is in
`docs/archive/2026-10-17_SIM_TLS_RUNNER_RESUME_EVIDENCE.json`.

This is not completed-restore acceptance. The snapshot excludes both independent
guard and target control journals; no restoration or deletion was performed by
this helper. Its original runtime does not retry terminal jobs. The separately
tested source correction below does not modify that running fixture. CF24 and
the original reset manifests/authority fingerprints remain unchanged.

## Completed content replay source candidate

ADR 0045 defines exact opt-in `same-epoch-completed-content-replay-v1`, disabled
by default. `SIM_CLEAN_COMPLETED_REPLAY_MODE` controls AI/driver;
`SIM_USER_DATA_COMPLETED_REPLAY_MODE` controls main;
`SIM_USER_HISTORY_COMPLETED_REPLAY_MODE` controls SIM/IZS history. This is an
internal worker policy, not a new user-selected account, erase endpoint or Root
authority. Pending work remains first; terminal accounts are revisited in bounded
round-robin order. Original accepted job/identity/epoch/state stay immutable.
Terminal cleanup never adds anonymous finance again. Fresh deleted receipts
require actual zero residual data; restored content gives 503 until cleanup.

Actual isolated evidence:

- 43 PostgreSQL/HTTP checks using real pg_dump/restore pre-data/data/post-data:
  nonzero restored AI/driver/SIM-history payload, actual restricted-role cleanup,
  compiled history HTTP 503 then 200/remainingRecords=0, B preservation, unchanged
  original jobs/finance and idempotent repeated cleanup. No trigger was disabled.
- 84 actual compiled main/Router/relay checks including four restored main files,
  stale receipt 503, actual main.tick cleanup, unchanged B and original job.
- Original 158 isolated-mode and 169 production-mode PostgreSQL component checks
  continue passing, with two real PG restarts in each run; AI 66 and SIM 35 unit
  tests passed. Builds/typechecks for the changed two services and OpenAPI passed.

These component restores do not restore the independent guard and do not prove
the live whole12 operation or Root admission. Before the running common test can
use this correction, build/pin new immutable images, agree on a stopped-writer
transition with COP, apply only additive
`deploy/clean-lifecycle/009_completed_content_replay.sql` and
`deploy/sim-user-data/006_completed_content_replay.sql` in the AI database, and
set the exact worker modes. Do not re-enroll, refresh identity, reset an epoch,
edit old manifests, or replace a running accepted operation. Driver/main require
no broader SQL rights. Root's profile/catalog evidence must reflect the reviewed
additional policies instead of silently treating the old catalog pin as current.

Rollback leaves the immutable guard and jobs intact. Disable the three replay
modes and quarantine restored content; do not roll user data back into service.

The bounded installer and disabled staging now implement this path, not just
the tests. Set only the new fresh-install private field
`simUserInstall.completedReplayMode` to the exact replay mode. Absence selects
disabled. The existing plan then includes the separate profile SHA
`51d197e30097efc07798a692de1939d46aee3a203ab446d1e67ff901cc2e7352`.
Under its already-held Root admission, private-install verifies the original
catalog, installs the two SHA-pinned additive SQL files in one transaction, and
verifies the new complete AI/history catalog against
`deploy/sim-user-data/completed-replay-profile-v1.json`. Original manifests are
not rewritten or treated as matching the new catalog. The readback phase remains
read-only, and a used account/job namespace is refused by this fresh installer.
It cannot be used to mutate the accepted running whole12 A operation.

`disabled_runtime`/`stage_sim_configuration` and private runtime output explicitly
map all three replay modes into their actual services while leaving intake,
legacy erasure and global activation flags disabled. Eleven pure configuration
tests and 26 actual isolated PG/SCRAM installer checks passed, including rejection
of an unreviewed extra DELETE policy. Root source sealing must include the new
helper, profile and SQL bytes before execution. These tests do not grant real
Root admission or authorize a live install.

### Prepared owned-fixture cutover, not executed

`scripts/fixtures/cutover-whole12-completed-replay.py` is restricted to exact
synthetic TLSv3 container `6251368d...`, namespace, loopback cluster, epoch and
already-accepted operation `b6fe7a68-d7a2-49e0-a9da-6dd7bcb01a4e`. It is not a
production installer and exposes no server endpoint. Root must agree on the
stopped-writer window before invoking `--apply-agreed-owned-cutover`; no timer,
application startup or this source change invokes it. `--inspect` changes nothing
and does not claim actual SQL/job verification.

It requires exact source checkout 175c731a3fbe78ce23e7303ff5df13eceaaf7f45 under
the fixed owned X5 staging path, validates every tracked blob and two critical
fixture-file SHA pins, and uses only the new compiled test bundle listed in
`docs/archive/2026-10-17_SIM_COMPLETED_REPLAY_IMAGE_PINS.json`. It copies the
existing private input, original snapshot and existing runtime credentials only
between private server-RAM files. No identity, credential or epoch is rotated.

Before stop it requires actual SIM A zero and unchanged original B fingerprints.
After exact old-process termination it checks all six listeners closed and all
five previous runtime roles without PG sessions. Fixture SQL verifies the exact
owned cluster, four original terminal jobs, ready independent guard bindings and
the original full catalog. In one locked transaction it adds only the five
reviewed DELETE policies from the two pinned SQL files, compares all affected
target data/job/resource/finance hashes, and verifies the separate new full
catalog. It does not reenroll, modify guard state or edit immutable jobs.

The new runner must then return three actual 200 capabilities and equal complete
A/B readback with replay modes explicitly selected. It does not restore content
or claim whole acceptance. Any failure retains old/new test containers and RAM
evidence for coordinated recovery; it never resumes production or auto-grants GO.
Nine pure negative/pin/syntax tests passed. The owned accepted-A cutover and
actual content restore/replay subsequently ran: nine A rows and four main files
were restored and removed again; B, control jobs, financial totals and independent
guard were preserved. See `docs/archive/2026-10-17_SIM_ACCEPTED_A_ACTUAL_REPLAY.json`.
This is component evidence, not whole-account acceptance or production activation.

### Separate fresh fixture and Root preparation

The fresh `956262c6abdb` fixture uses a new epoch and independent TLS cluster;
it does not inherit an old operation. The owner-empty launcher and one-shot
admitted seed are deliberately fixture-specific. After common enrollment, actual
signed synthetic users A/B each have four AI rows, four driver rows, one history
row and four main files. A private success receipt prevents blind repeat seeding.
No external provider is called and no production service is changed.

`scripts/lib/prepare-sim-root-private.mjs` provides an in-process, RAM-only
constructor for a future sealed Root CLI. `prepareSimRootPrivatePart(options,
{Pool})` reads only the fixed production identity environment and CA, accepts the
administrator password in-process, and performs read-only private-install
inspection. It refuses existing objects rather than inventing an empty inventory.
`mergeSimRootPrivatePart(rootConfig, part)` requires the same epoch/cutoff and an
inspection plan; it preserves COP configuration. Returned objects contain secrets
and must never be logged, passed in argv, committed, or written to ordinary disk.
Existing identity/hash/token links are retained. Missing canonical identities may
be generated only while both canonical components are disabled. This constructor
does not reset, enroll, grant rights, activate services or authorize production use.
Its 27 synthetic configuration checks do not constitute actual production
inspection. Production preparation and execution remain separate approved gates.

Two separate actual cases are recorded in
`docs/archive/2026-10-17_SIM_TWO_SEPARATE_ACCEPTANCE_CASES.json`: historical
9aff recovery and fresh956 first deletion. Actual Docker inspection confirms
the same immutable runtime bundle in both. No application/package code or SQL
migration changed between the pinned runtime and these probes. Fixture TLS,
preparation and verification differ; fresh956 has no original SIM content
snapshot, so recovery under its identities/TLS is explicitly not proven. The
historical recovery must not be relabeled as a fresh956 restore or whole COP GO.

### Concrete pre-freeze common Root factory (source only)

`scripts/lib/prepare-common-root-private.mjs` exports
`prepareCommonRootPrivateConfig({postgresPassword,resetEpoch,tokensNotBefore,
environmentId,guardStoreId})`. The sealed parent Root Node24 process calls it
before freeze and before publishing the final PLAN. The COP source is fixed to
`/srv/x5-production/staging/cop/clean-operator-2e61857/app`; the caller verifies
enrolled source hashes before import, and the factory additionally requires
root-owned nonwritable canonical source paths. It reads the Keycloak worker
identity only from the protected `/srv/cop/.env`; provisioning is not performed.

The returned object has **private** `privateConfig` (RAM/parent private pipe only)
and a safe `publicSummary` containing seven plan digests, not secrets or rows.
The six actual inspectors cover COP SQL, AI SQL, driver SQL, reset files, SIM app
files and Keycloak. SIM private-install inspection supplies the seventh plan.
AI/driver use exact SET ROLE and read-only sessions; Keycloak performs its actual
inventory via the existing inspector. All pools close on failure. There is no
apply/stop/freeze dispatcher, public endpoint, automatic CLI or secret file output.

COP must still add its actual `cop_safety_install` and Python `messaging`, `media`,
`edge` plans. `completeForFreeze` remains false: no placeholder is supplied. Parent
must not print the private return value or raw errors, must preserve credentials
only in RAM, and must review all actual digests before sealing the final PLAN.
Existing apply modules revalidate drift under the actual held Root admission;
these preparation results never authorize mutation by themselves. The production
factory has not been executed. Twenty-four synthetic adapter checks cover plan
composition, secret-free public output, missing/invalid plans, failure propagation,
epoch mismatch and rejection of apply mode; they are not real provider evidence.

`scripts/lib/prepare-common-remaining.py` completes the source-only RAM join:

1. The sealed parent calls the Node factory and keeps `privateConfig` in its
   private pipe/RAM. No private JSON is sent to a terminal or ordinary file.
2. COP's actual `prepareCleanCopManifest` receives the explicit approved human
   decision and real identity/binding/CA inputs. Preserve its exact JSON+newline
   bytes and plan digest. Its `factsInspected=false` is not changed to true.
3. With source descriptors already pinned and actual COMM/storage custody open,
   call `inspect_remaining_private(plan, private_config, postgres_password,
   native_admin_token, remote, storage)`. This runs actual metadata/native SQL
   read-only inspectors, native-media/edge inspect helpers and S3 inventory.
   It does not open SSH authentication, stop writers or manufacture transports.
4. Call `finalize_private_preparation(private_config, remaining,
   cop_safety_prepared, manifest_bytes, postgres_password)`. It checks the exact
   manifest bytes/digest/epoch/cutoff and produces private configuration with
   eight worker digests plus three remaining digests in the public summary.
5. Parent reviews all eleven actual digests and separately publishes/seals the
   exact Root PLAN and COP manifest at their required protected paths. Only then
   may the existing held-admission `run_common_reset` execute. Source preparation
   alone is neither authorization nor a provider/production acceptance receipt.

The parent must supply a genuinely held concrete provider transport. In
particular, the existing `ProductionStorage.open` requires reviewed container
identity and its own authentication custody; this module does not bypass that
requirement. Missing custody or provider failure aborts preparation. Fifteen
synthetic Python tests cover composition and negative gates; no production
inspector or reset was run for them.

**Additional install gate:** eleven reset plans do not install Messaging's
production guard/metadata/native full profile or its initial usage baseline.
`clean-remaining-reset` only resets those stores. Its isolated baseline fixture
must not be used as a production enrollment. A separately reviewed real Messaging
installer must run under held writer custody, verify the installed profile and
least-privilege roles, enroll the actual production binding and empty baseline,
then verify runtime flags/readiness before activation. This remains an explicit
missing gate; the preparation summary reports it as not included.

### Fresh956 completed-operation outage finding

The original immutable bundle's Router outage probe did **not** obtain HTTP503.
After baseline200, the exact isolated `ai_router_runtime` NOLOGIN and termination
of only its `sim_ai_router` sessions caused an unhandled idle PostgreSQL pool
error and ended the composed Node process. LOGIN was restored in finally. The
same runtime was resumed with the original RAM credentials/epoch/operation;
actual four signed deletion GETs returned200/deleted with A0 and B unchanged.
No seed, password rotation or production change occurred. OOM counters were zero;
the earlier unrelated disappearance of the original runner lacks exit evidence
and is not conclusively attributed to this error.

`BudgetStore` now handles idle pool errors without logging raw error/query/URI
content. Requests still reject database failures; there is no success or external
fallback. Two targeted synthetic tests and Router typecheck pass. A new compiled
immutable test image and actual repeat503/recovery200 remain required: this source
fix is not acceptance evidence for the old bundle. The operation was already
completed, so this is not a retroactive pending-deletion outage test.

The subsequent actual build and repeat are recorded in
`docs/archive/2026-10-17_SIM_FRESH956_CORRECTED_ROUTER_OUTAGE.json`.
Official Router image b6c56985 and immutable test bundle739582de were built.
Full file/symlink hashes prove unchanged main/driver and situation trees against
the old bundle, and exact new Router tree equality to the official image. The
same accepted fresh956 operation then actually returned200,503,200 while only
its two exact Router database sessions were terminated and LOGIN was restored in
finally. Node survived; all four signed deletion readbacks returned200/deleted,
A remained absent and B matched the private pre-deletion receipt. All68 Router
synthetic tests passed. This closes the completed-operation outage finding for
the new image only; it does not prove pending-deletion behavior, fresh956 content
restore, whole COP acceptance or production activation.

### Messaging baseline Root phase adapter (not a schema installer)

`scripts/lib/messaging-usage-root-phase.py` implements the actual
`PreparedEnrollment` commit under the same concrete `RootResetAdmission`.
`run_messaging_usage_phase(root_module, admission, reviewed_install, connections,
root_base64)` accepts existing administrator connections in guard, metadata,
native order and the existing private owner-key material in RAM. It verifies the
sealed Messaging module pin, a separate `messaging_install` reviewed digest,
production issuer, initial empty lineage and the Root writer-inventory digest.
The real constructor reads actual installed catalogs/bindings and inventories;
its prepared nonce is bound to the exact private commit packet. Fresh actual
Root custody checks surround prepare/commit; initial knownOwners/unresolved must
both be zero. The component's `writerClosureVerified=false` remains unchanged;
host verification is reported separately. Seven synthetic adapter tests pass.

This source adapter does not execute SQL migrations, create roles or install
bindings. COP must add a separate reviewed install manifest and register a
twelfth digest/phase in its Root validator/controller before it can be called.
The schema/binding installer must precede it under held custody. Runtime-disabled
restart and actual native/metadata/guard capabilities are subsequent explicit
gates; no existing frozen-writer assertion may silently be relaxed to allow a
restart. Guard connection failure is an error, never evidence of absent schema.
No fixture baseline or real account deletion is performed by this source change.
