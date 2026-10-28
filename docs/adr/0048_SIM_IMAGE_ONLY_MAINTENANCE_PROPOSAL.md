# ADR 0048: SIM image-only maintenance — proposal, not production authority

Status: **Proposed / blocked pending Root controller identification**. 2026-10-28.

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

The following is a proposal for **new host release authority**, NOT implemented,
installed or implicitly approved. Only two operational capabilities are proposed:

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
Root must explicitly approve any new authority before a mutating handler or its
installer exists. Reuse existing admission signatures only after identifying
their real contract; a successful test callback is never production admission.

## Current executable gate

`scripts/sim-pg-disconnect-baseline.py --baseline` is read-only and always denies
activation while controller/profile/journal evidence is missing. It emits only
digests/IDs/booleans, verifies fixed baseline image/modules, rechecks stable
identity, and flags capacity pressure without build/cleanup. Tests cover drift,
secret suppression and denial despite matching image bytes.

Only after Root supplies the real interface may a separate reviewed change bind
it to the fresh source/image/config snapshot, resolve build activity/capacity,
and implement the final image-layer and rollback gates in runbook 22. Until then
the three-file Dockerfile remains unbuilt and activation blocked. Unsafe fusion
is unrelated and must never be included.
