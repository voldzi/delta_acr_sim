# 24 — Clean lifecycle source candidate

Status: source + isolated PostgreSQL/HTTP only. No production activation,
permissions, secrets, reset or activation. Does not extend CF24/native-v1 or
reuse an old operation. Contract `cop-sim-user-lifecycle-v1`, sole accepted mode
`isolated-clean-lifecycle-v1`.

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
Root must integrate these totals into the corresponding budget queries before
production; this source-only adapter does not switch the billing implementation.

## Actual isolated evidence

`node scripts/test-clean-lifecycle-postgres.mjs --run` creates its OWN PostgreSQL
18.3 cluster under a new mode-0700 temporary directory, Unix socket only; accepts
no external target, password or URL. Uses the actual base AI/driver schemas and a
restricted non-superuser runtime role, not mocked DB calls. No provider is called.

Observed 118 checks passed, two actual PostgreSQL restarts: A/B isolation, true
concurrent writer/fence ordering, cascade cleanup/readback, refusal of late writes,
same-operation replay, immutable owner/epoch/operation, no resurrection, pending
AI reservation/key removal/settlement, actual DB outage, deliberate completion
failure with transaction rollback and successful retry, missing/wrong epoch,
exact-once financial totals and preservation of policy. This is component evidence,
NOT COP/Keycloak/Messaging whole-service acceptance or deployment evidence.

## Finite read-only live inventory (2026-10-17)

Only aggregate counts were read in READ ONLY transactions; no identities/values.

| Store | Count | Proposed reset classification |
| --- | ---: | --- |
| ai_router_request | 23: 20 COP, 3 other | COP user history; other lane excluded from per-account COP cleanup |
| ai_router_user_key / user_key_audit / billing_request | 0 / 0 / 0 | user data |
| ai_router_account_erasure / erased_cost_daily | 0 / 0 | old protocol state; do not enroll as new operations |
| ai_router_policy / policy_audit | 1 / 6 | PRESERVE configuration |
| driver receipts / intervals / ETA | 0 / 0 / 0 | user measurement data |
| driver_measurement_revocations | 6 | user measurement tombstones; reset only with epoch/writer gate |
| driver_account_erasure_state / operations / revocations | 1 / 0 / 0 | old protocol state; no new-scope migration by inference |
| sim-store scenarios / drafts | 11 / 4 | shared test scenario artifacts, no account ownership in existing JSON |
| publisher queue items | 0 | shared synthetic publisher state |
| geo-routing precomputed | 912 files, 8,485,677 bytes | generated routes; no reliable per-user link in existing store |

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

Both createApp factories import the new registration and accept an explicit
optional dependency. Existing index/startup does NOT instantiate it. When supplied,
normal COP AI writes and driver batch writes reserve verified owner/resource
bindings before persistent side effects. Existing authentication, validation and
historical guards still run; no old guard is bypassed. Root must construct the
dependency with the exact own DB pool, hash derivation and explicit expected
environment/epoch. `tick()` provides bounded single-job processing and expired
total purge; Root must schedule retries and close resources on shutdown.

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
The driver capability does not validate legacy driver-store composition; that
is a separate integration gate, not inferred from this new schema's readiness.

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

Root owns the finite combined reset plan, writer stop, identity/roles cleanup and
deployment approval. No live reset SQL is supplied by this candidate. Do not use
it on existing stores or remove old guard state to obtain GO. Fresh namespace must
be enrolled explicitly; restoration of an old epoch must remain quarantined.
Production wiring must cover completion receipts for both stores, background
failure/backoff, report-cache invalidation, restore proof, actual budgets,
and bounded handling of shared scenario/routes not currently linked to accounts.
The binding OpenAPI includes these explicitly source-only isolated routes.

Rollback in this scope: stop the isolated fixture; no live state was modified.
Do not rollback a future deletion by restoring user data. Keep tombstone/epoch
authority separate from rollback images and test old-epoch refusal before rollout.
