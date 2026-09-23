# ADR 0022 — Optional directed attributes on selected road routes

Status: accepted 2026-09-23.

SIM keeps its existing `/routing/route` and `/routing/alternatives` response shape and adds opt-in `includeRoadAttributes`. Valhalla `trace_attributes` with `shape_match=edge_walk` uses each already computed route variant geometry. SIM verifies the graph dataset before/after and exact forward geometry alignment; it never substitutes a newly calculated route or a nearby-road result. Failed enrichment leaves base route geometry, steps and ETA intact with a typed unavailable state.

Only `edge.speed_limit` supplies an explicit posted-limit candidate. Missing legal limits are unknown. Closure shape attributes are advisory, and static/conditional restrictions remain unassessed. Optional actual vehicle dimensions cause truck costing for road profiles and the response reports precisely which fields were applied; the result is not a guarantee of passability. The existing direct fallback remains in SIM for compatibility but COP suppresses it from public navigable routes and reports outside coverage.

This chooses bounded per-request work and a potentially larger response over a separate mobile map download or an independent Overpass road match. Long routes and multiple alternatives add one trace lookup per variant. Further restriction enrichment requires a source keyed to the same directed graph edge and dataset version. Rollback: omit the opt-in flag; retain the public direct-line suppression.
