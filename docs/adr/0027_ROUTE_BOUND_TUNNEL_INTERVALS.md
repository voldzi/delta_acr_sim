# ADR 0027 — Route-bound directed tunnel intervals

Status: accepted 2026-09-28 for the prepared SIM routing contract; production activation requires end-to-end and device acceptance.

Jízda needs graph-confirmed tunnel sections for a bounded GPS-outage prediction. SIM already enriches each Valhalla route alternative with `trace_attributes` over its returned shape. We add the normalized directed `edge.tunnel` flag to that lookup and expose only complete, monotonic, version-checked intervals in the selected variant's geometry. An incomplete flag set, edge gap, shape mismatch, or dataset change yields `tunnels.state=unknown` and no intervals. A known empty interval list describes only the graph's fully matched path, not surveyed reality.

The nested object repeats `routeId` and routing dataset identity to prevent accidental reuse across alternatives. Valhalla `routeId` now includes the geometry in its stable hash, so a reroute between unchanged endpoints receives a new ID when its shape changes. Invalid maneuver indexes and vertices are rejected rather than silently clamped to the route endpoint; the route is marked unavailable for navigation if maneuvers cannot be verified. The existing request opt-in and base route geometry/ETA remain unchanged.

The graph flag is not proof that the vehicle entered a tunnel. Jízda must combine it with a recent reliable location and degrade prediction confidence through an outage, particularly at tunnel branches. Rollback is to omit `includeRoadAttributes` at the client; existing clients ignore the new optional object. Before production release, test the SIM and COP contract plus GPS behavior on a physical iPhone.
