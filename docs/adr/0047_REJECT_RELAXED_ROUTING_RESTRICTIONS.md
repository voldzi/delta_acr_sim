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

The opt-in arrival contract is a separate candidate in integration/21.
SIM accepts COP's user-selected `to` plus `arrival.target` proposal, version
sim-user-selected-arrival-v1, 250 m unverified target separation, 25 m unchanged
snap, plain car only and no cache. It is implemented in the isolated candidate,
using the byte-identical schema confirmed by COP (SHA-256 210b06c0cd3f093d91529721b21b7ffed26e28be5d625a15a6d62a67c7f36e8c),
not activated in production. No automatic arrival selection or legal access
assertion exists. Repeated schema generation must preserve existing routing
safety descriptions; candidate runtime proofs remain separate from production.

Deployment gate: COP/SDK typed-error acceptance, public Penny/control regression
on the candidate, preservation of current runtime configuration and existing
guarded rollback. No production rollout is performed by this source change.
Rollback is the previous immutable situation-data image; do not modify reviews,
vehicle permissions, tolerance, secrets or provider update policy.
