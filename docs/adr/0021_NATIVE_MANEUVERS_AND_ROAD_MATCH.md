# ADR 0021 — Indexed maneuvers and directed-road evidence

Status: accepted, 2026-09-21.

SIM extends existing route and nearest-access contracts additively. Native
clients consume one geometry/step/ETA snapshot through COP. Maneuver indices
refer to full-route geometry, not independently snapped points on looping
routes. Unknown maneuver types are not guessed.

Road enrichment pairs Valhalla directed-edge ID with a verified routing dataset.
Missing direction, close parallel candidates or unverified tile status remain
explicitly uncertain. COP owns observations, durable retry, deduplication,
visibility and moderation. SIM does not create a second report store and does
not turn user observations into automatic closures.

Rollback recreates only situation-data-api with the previous image; Valhalla,
traffic archives and provider databases remain intact. Older SIM is compatible
with existing COP web routes but new Jizda turn guidance requires the new step
metadata and must not synthesize it.
