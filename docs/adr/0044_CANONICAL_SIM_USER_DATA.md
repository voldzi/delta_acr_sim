# ADR 0044 — Separate canonical SIM user-data adapter

Status: accepted for source and isolated verification; production activation
requires Root/COP joint acceptance.

The prior COP AI/measurement component did not own main SIM scenarios, drafts,
audit/publisher files or SIM-origin AI history. Treating them as non-user data
would make whole-account completion incorrect.

Add mandatory twelfth clean-v2 component `sim_user_data` with the new wire
contract `cop-sim-user-data-v1`; preserve CF24 and clean-v1 unchanged. Compose
existing application logic under verified issuer/UUID-subject owner namespaces,
with durable PG fences and strict filesystem seals. Do not infer old ownership
from mutable actors. Legacy test data uses an explicit finite reviewed reset;
official datasets/configuration and other service actors stay outside scope.

Use a new named independent SQL checkpoint/tombstone contract under SIM's guard
namespace, not COP's owner='cop' dataset_replays and not a positive callback.
Both application and history require exact incarnation/epoch/source binding.
Unknown restore state fails closed. No new public ports, networks or provider
calls; the existing driver API offers a bounded fixed relay and public Nginx
denies the new prefixes.

Consequences: a new dedicated app DB and two limited independent guard accounts;
component readback alone cannot complete global deletion. Production reset and
activation remain coordinated, and no rollback may restore data already erased
without replaying the independent tombstones. Details and tests are mapped in
[integration 25](../integration/25_SIM_USER_DATA_V1_CONTRACT.md).

## Root activation boundary (source and isolated CAS verification)

The stopped-writer reset admission ends before any new service is started. A
separate, narrow Root-only SIM activation state reacquires the existing storage
flock and revalidates the protected whole12 proof, source hashes, epoch, exact
fenced CIDs and reset environment/overlay receipt. It never treats a started
writer as satisfying the old reset authority. Actual SQL readback is bridged by
private stdin and live parent custody, not positive readiness callbacks.

Enable the five ownership/continuity composition flags before starting main,
Router, situation and web; otherwise main selects the legacy shared store.
Global COP deletion remains disabled and other feature/intake settings remain
unchanged. Preserve each service's observed Compose chain and existing mounts
and networks. After up, bind exact new candidate CIDs/specs and verify real
authenticated component capabilities, not liveness alone. Failure stops only
captured unchanged new CIDs; no old writer/data rollback is permitted.

The module returns only guard-ready metadata for Root's separate shared canary
and final COP slot. It neither enables global flags nor asserts whole-account
completion. Production execution and the actual activation bridge/up remain
separate gates; source/unit evidence does not satisfy them. See runbook22.
