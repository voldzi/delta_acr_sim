# 25 — Canonical SIM user data (new clean-v2 component)

Status: separate source candidate and owned synthetic tests, not production
activation or whole-account acceptance. Original CF24 files/checksums and the
eleven-component clean-v1 contract remain unchanged. New clean-v2 requires the
twelfth adapter `sim_user_data`; missing readiness/readback must block completion.

## Ownership and data

Main SIM previously stored unbound scenarios, drafts, runtime, publisher queue
and audit, and sent mutable display identities to the SIM AI lane. These are
user data, not proven official templates. The bounded historical audit is in
`docs/archive/2026-10-17_SIM_USER_DATA_OWNERSHIP_AUDIT.json`; its audit sample is
not a count or classification of the entire file.

The new composition uses the existing real OIDC signature, issuer, client and
role verification. Only its canonical issuer + UUID subject and original `iat`
may select an owner. Username/email/name, browser metadata and arbitrary actor
headers cannot select an account. The HMAC owner key selects an epoch-scoped
private directory, a real app/store/runtime instance, and signed Router aliases.
Two equal display names remain separate; renaming a display name retains data.

Fixed owned files: `sim-store.json`, `sim-audit.jsonl`,
`publisher-queue.json`, `.owner-scope.json`; directories 0700, files 0600,
no symlinks/hardlinks, bounded file listing. No new database stores raw subject,
email, prompt, scenario or message text. Owner/job/tombstone hashes are still
pseudonymous security records, not anonymous data. They remain to prevent late
writes and restored data from becoming available again. Cost totals alone are
anonymous and expire at the next UTC month boundary after settled reservations.

An immutable, committed initialization nonce precedes filesystem creation.
Restart may finish only a matching empty initialization with known initial
bytes. Unknown files/content, missing initialized storage or corrupt private
stores fail closed; they are not silently replaced by empty data.

Provider datasets, official configuration, operational checks and unrelated
applications are outside this adapter. Other backend-service route-cache actors
are not automatically assigned to a human or declared public.

## Binding wire contract

Authoritative fragment: `openapi/fragments/sim-user-data-v1.openapi.json`, merged
into `openapi/openapi.json`. Prefix `/api/v1/internal/sim-user-data/v1`:

- `GET /capabilities`: dedicated COP service bearer; main + Router readiness.
- `POST /deletions`: exact five-field body `contractVersion`, `scope`,
  `resetEpoch`, `operationId`, `requestedAt`.
- `GET /deletions/{operationId}`: same signed canonical owner/operation binding.

Version `cop-sim-user-data-v1`, scope `cop_sim_shared_identity_v1`.
Service token and distinct HMAC actor secret are mandatory. `x-cop-clean-actor`
has exactly the existing thirteen claims, audience `sim-clean-lifecycle-v1`.
The new secret separates this adapter from earlier operations. Epoch/cutoff,
issuer, UUID subject, original OIDC `iat`, operation and requested time all match.
No browser Origin, query transport, redirect or arbitrary proxy target.

Receipt always has `wholeAccountComplete:false`. All three subcomponents are
mandatory: `app_store`, `audit_and_publisher`, `router_sim_history`.
POST 202 is pending, never successful whole deletion. Completion requires fresh
filesystem absence and fresh owner-bound Router SQL readback. GET may return
200 with a pending state; callers must inspect the state/subcomponents, not just
HTTP success. Other owners get no operation. DB/guard/partner failure means 503
or durable pending, not fabricated success.

Existing driver API relays only this fixed prefix to `http://sim-api:4000` over
its existing network. Only authorization, content-type and the two signed actor
headers are forwarded; request/response 16 KiB, timeout 3.5 s, no redirect.
No new public port/network. The web proxy explicitly returns 404 for direct main,
relay and Router-history prefixes, with access logging disabled.

## Concurrency and independent continuity

Per-owner PG row locks drain HTTP, runtime ticks, audit writes and publisher
work before deletion. Nested guarded work shares the locked connection and is
drained before commit. Pending/deleted owners cannot write. In-flight unsettled
or uncertain model reservations keep history pending. Settlement retains the
previous restricted identity/model binding. Deleted history is replaced only
by the same financial amounts/counts/tokens, including conservative reserved
amounts when no settled charge exists; limits therefore do not reset.

New `sim-user-continuity-v1` uses concrete PostgreSQL pools, not a success
callback: `packages/sim-user-data/authority.mjs`. It creates no schema or
enrollment. Independent tables are `sim_erasure_guard_v2.user_data_checkpoint`
and `user_data_tombstone` in `cop_account_safety_guard`; target witnesses live
in `sim_user_data.continuity` / `sim_user_history.continuity`.

Exact bindings: guard store, target store, incarnation, environment, reset epoch,
checkpoint, restore generation, bundled authority source SHA-256 and runtime
identity SHA-256. The latter is derived privately from actual owner/hash/actor
secrets and issuer; a configuration change cannot silently orphan old data. Dedicated
least-privilege guard roles cannot read the other component or update readiness.
An independent tombstone commits before target projection. Missing projections
block admissions; startup replays only the same immutable operation as pending.
Unknown generation, quarantine, source mismatch or unavailable guard refuses.
Shared guard leases and fresh checks surround target work and pre-commit.
The Root restore controller must take the corresponding exclusive guard lock
and quarantine/enroll a restored incarnation; changing a copied target witness
alone does not grant admission. The bounded implementation refuses more than
10,000 tombstones per component; indexed/cursor scalability needs a separately
verified design before exceeding that bound.

Production source mode requires this concrete authority and hostname-verified
HAProxy TLS transport, never an injected runtime module or boolean. It remains
off until Root/COP joint acceptance. Factory/isolation evidence is not proof of
actual Root policy, Keycloak deletion or restored production backups.

## Verification and handoff

Run `node scripts/test-sim-user-data-v1.mjs --run` under Node 24 / owned PG18.3.
It uses real RSA JWT/JWKS, main HTTP 4314, Router, fixed relay, restricted PG roles,
two synthetic accounts, actual background cleanup and fresh readback. No OpenAI
or production writes. It also tests actual app restart, proven partial init,
unknown files, separate guard roles, replay and changed restore generation.

`scripts/test-sim-user-data-reset-files.mjs` verifies the finite three-file legacy
test reset and preserved configuration/operational files. The exact new AI
catalog is compiled by `scripts/test-clean-reset-postgres.mjs
--compile-user-data-profile`; unknown triggers are rejected, not ignored.
`bash scripts/test-sim-user-data-nginx.sh` uses a pinned local image with network
`none` and checks four actual public 404 paths.

Root COP independently tested its actual twelve-component adapter against the
new HTTP composition (14 assertions). This is component evidence only; after
freezing source pins it must be rerun and followed by whole Root acceptance.
Deployment/rollback sequence: [runbook 22](../runbooks/22_SIM_USER_DATA_V2_ENROLLMENT.md).
