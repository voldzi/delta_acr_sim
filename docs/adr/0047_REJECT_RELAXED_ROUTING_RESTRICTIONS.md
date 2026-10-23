# ADR 0047: typed rejection of relaxed routing restrictions

Status: source candidate, not deployed.

The reviewed known-closure road route rejects Valhalla numeric warning 401
with HTTP 422 `ROUTING_RESTRICTIONS_RELAXATION_REQUIRED`. It never accepts the
relaxed route or infers which location caused the relaxation. All returned
variants must first pass structural geometry and closure checks. Unknown,
malformed or mixed warnings retain the protective 502; strict-road-trip and
legacy routing behavior is unchanged. Endpoint tolerance stays 25 m.

Reason: the reproduced public Penny address returns trip warning 401 whereas
the nearby control access does not. Valhalla 3.8.3 src/exceptions.cc distinguishes
warning 401 (first pass failed, retry with relaxed restrictions) from error 401.
It does not prove legal access or a snap-distance failure.

The future opt-in arrival contract is a separate proposal in integration/21.
SIM accepts COP's user-selected `to` plus `arrival.target` proposal, version
sim-user-selected-arrival-v1, 250 m unverified target separation, 25 m unchanged
snap, plain car only and no cache. It is not implemented or activated here.

Deployment gate: COP/SDK typed-error acceptance, public Penny/control regression
on the candidate, preservation of current runtime configuration and existing
guarded rollback. No production rollout is performed by this source change.
Rollback is the previous immutable situation-data image; do not modify reviews,
vehicle permissions, tolerance, secrets or provider update policy.
