# ADR 0048: SIM image-only maintenance — proposal, not production authority

Status: **Proposed / offline handler prepared; blocked pending independent review and exact Root GO**. 2026-10-28.

Update: Root reports separate human approval of the finite one-off protected
deployment/image-only reverse capability, and independent local-source review
of `c00929e`. Root also reports a successful single read-only live TLS/lineage
probe against the unchanged old container. These facts do not approve a yet
unbuilt candidate image or replace fresh Root capacity/build/admission gates.
The inert bundle and exact forward/reverse sequence are mapped in runbook 22.

## Observed boundary

SIM API runs the normal image entrypoint and `node apps/simulator-api/dist/index.js`,
without NODE_OPTIONS, with `/data` and PostgreSQL CA mounts. The baseline helper
pins the four actual Compose layers. This is not a full-host absence claim:
read-only lookup in `/usr/local/bin`, `/usr/local/sbin`, `/etc/systemd/system`
and SIM-named files under `/opt/vcode-infra` found no SIM maintenance interface.
The Stratos runtime and COP-only broker are not adopted. Root is separately
checking historical operator artifacts.

The startup guard is `loadSimUserAuthority` in `packages/sim-user-data/bootstrap.mjs`:
bundled authority SHA, runtime identity fingerprint, environment/epoch and DB
transport. The actual factory verifies runtime roles, target/guard witnesses,
incarnation, checkpoint, restore generation and independent tombstone projections.
The ledger retains every pre-commit/current-lease check. This protects the DB
contract, **not** an entire image, CID, host image pin or maintenance operation.
Per-account `.owner-scope.json` is a storage seal, not host release approval.

`scripts/coordinate-clean-release.py:236` loads sealed COP
`scripts/account-safety/clean-reset-controller.py`, then invokes
`RootResetAdmission.freeze_reviewed`, reset/enrollment phases and private workers.
This is a reset transaction, **not** a maintain interface. The runbook's original
image/CID-bound stopped-writer enrollment is not ongoing replacement permission.

## Binding, marker and writes

The observer fix requires **no application-level change** to authority SHA,
identity, environment, epoch, checkpoint or restore generation. Fresh readback
must still verify all existing bindings; no reset/re-enrollment to accommodate
the image is permitted. No host startup marker approval has been established.

Restart is **not a zero-DB-write guarantee**: unchanged factory `replay()` can
insert missing tombstone projections or fence active accounts; normal workers
retain their existing cleanup/replay behavior. This is existing safety behavior,
not new maintenance authority. The installer must execute **zero administrative
SQL/migration/binding/journal/marker writes**. Any newly required host release
record is a separately reviewed bookkeeping mutation, not a DB binding update.

## If no existing controller is found

The following is a proposal for **new host release authority**, implemented only
as an offline review candidate, NOT installed or implicitly approved. Only two
operational capabilities are proposed:

1. Replace only the `sim-api` image pin under existing exact Compose layering and
   recreate only `csm-sim-api`, under a genuine Root-held exact image/source/
   config/profile/current-lineage admission. Preserve all other services/fields.
2. Revert that pin/service only to the reviewed old image while the **current**
   controller admission permits it. No forced rollback across deletion/continuity
   drift, old marker restoration or database/data recovery.

New DB grants, identities, credentials, networks, endpoints and administrative DB
writes: **zero**. New host mutation authority: those two operations, plus only
minimal release receipt bookkeeping explicitly reviewed by Root. No arbitrary
command/path/image/env callback or boolean owner-acceptance substitute is allowed.
Root accepted preparation of the two-operation handler for offline source review
only. Root must explicitly approve the new authority before installation/use.
Reuse existing admission signatures only after identifying
their real contract; a successful test callback is never production admission.

## Current executable gate

`scripts/sim-pg-disconnect-baseline.py --baseline` is read-only and always denies
activation while controller/profile/journal evidence is missing. It emits only
digests/IDs/booleans, verifies fixed baseline image/modules, rechecks stable
identity, and flags capacity pressure without build/cleanup. Tests cover drift,
secret suppression and denial despite matching image bytes.

The new offline handler and fixed read-only lineage probe are described in
runbook 22. Their filesystem, TLS, deadline, strict pre-recreate parity and fresh
GO checks now have targeted local negative coverage. This is not an installed
Root controller nor production permission. Independent frozen-source review,
actual image-export compatibility, real current-container read-only probe and
fresh coordinated capacity/build-owner/Root GO remain gates. The three-file
Dockerfile remains unbuilt and activation blocked. Unsafe fusion is unrelated
and must never be included.

The subsequent build-only source candidate uses an explicitly acknowledged,
already-running pinned COP worker through direct buildctl exec, never implicit
buildx bootstrap. Its finite SIM binding, streaming OCI conversion, private Root
build GO, common lock, empty per-job auth, network-source denial, fixed 2/10 GiB
reserve floors and timeout/unknown-completion boundary are specified in runbook22.
This is a new review candidate, not permission to run it or substitute a worker.
No app/profile/DB/release operation is a build side effect; actual image and fresh
release admission remain gates. Sharing does not grant COP release authority to
SIM, and this SIM-only memory/disk model does not automatically fit COP's image.

## 2026-10-28 finite post-recreate DNS amendment

Root subsequently reported one actual build and one forward recreation, followed
by a stopped `POST_RUNTIME` check; prior proposal-state statements above describe
their original review stage, not current deployment acceptance. Root proved the
entire original runtime hash is recovered by only three explicit empty DNS list
serialization changes (`Dns`, `DnsOptions`, `DnsSearch`: null to `[]`). The new
source canonicalizes only those fields/types. This changes validation, never
runtime DNS configuration.

Original source/profile/GO/intent/failure remain immutable evidence. A separate
protected profile/amendment/fresh GO permits only read-only acceptance of the
fixed existing candidate and a distinct receipt, not replayed activation or
rewritten completion. The finite original-profile bridge for any separately
authorized image-only reverse requires that exact artifact chain, whole-runtime
hash, same candidate/process generation, unchanged real database lineage and
distinct acceptance receipt. No general lineage/profile migration or restore
permission is introduced. Exact contracts and source hash are in runbook22;
local synthetic tests do not replace Root's actual witness or execution gates.
