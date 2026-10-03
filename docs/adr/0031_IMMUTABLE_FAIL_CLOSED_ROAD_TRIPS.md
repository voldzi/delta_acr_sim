# ADR 0031: immutable fail-closed road trips

Status: accepted for implementation; strict path disabled pending joint acceptance.
Date: 2026-10-03.

## Decision

Add optional `trip` to existing routing endpoints and `capabilities` to GET
profiles. Preserve legacy contract versions; reject unknown safety fields and
conflicting legacy inputs. COP authenticates users and forwards the exact typed
snapshot. Every returned variant acknowledges the full snapshot and its own
geometry through canonical SHA-256 hashes.

Strict routing uses Valhalla only: ordinary car→auto, commercial truck→truck.
No emergency access, no optimized stops, no fallback or stale route cache.
Apply all four supplied vehicle dimensions/loaded weight with explicit units.
Provider costing attests only mapped restrictions, never complete legal access.
Trailer/axle/planned departure/approved entrance stay explicit unsupported.

Mandatory closures require a server-owned reviewed source bound to the exact
graph and a bounded region/time. A representative SRTI point, route proximity,
OpenLR speed match or a user screenshot is not authoritative closure mapping.
Initial accepted mechanism is both-direction physical closure polygons applied
to the actual engine request and independently checked against every returned
geometry. One-direction exclusions require another accepted mechanism; reject
instead of broadening or ignoring them. Changes/revocations/expiry/graph updates
in flight invalidate all variants. No silent truncation of the closure set.

## Consequences

Current provider data does not satisfy this reviewed source contract; strict
routes may return 422/503 until the source and engine are accepted. Returning no
unsafe route is intentional, not a reason to fall back to unconstrained routing.
The snapshot publisher must ensure provenance and complete declared-area
coverage; a string asserting `authoritative_reviewed_snapshot` cannot prove it.
Polygons can over-exclude a crossing/parallel road; review exact geography before
pilot. Graph freshness uses tile build time, not independent OSM survey age.

Structured roundabout metadata uses provider type 26/27 and actual exit counts;
no screenshot-derived bearings or count adjustment. Immutable identity persists
through alternatives and reroutes, but this does not certify signage or surface.

No new production network, closure, data, mobile activation, measurement flag,
GPS intake or live traffic writer is introduced. Rollback disables strict trips,
keeping callers fail-closed, and preserves the existing provider APIs.
See [wire contract](../integration/21_JIZDA_ROUTING_SAFETY_CONTRACT.md) and
[runbook](../runbooks/18_STRICT_ROAD_TRIP_ROUTING.md).
