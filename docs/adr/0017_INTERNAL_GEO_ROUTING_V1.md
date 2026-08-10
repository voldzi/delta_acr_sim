# ADR 0017: Internal ordered geo-routing-v1

## Status

Accepted

## Context

Multiple public products need deterministic walking and bicycle route snapshots
without exposing SIM or Valhalla to browsers. Existing SIM routing endpoints
can return compatibility fallbacks and did not provide ordered multi-waypoint,
dataset provenance, scoped service authentication, or publication-time
idempotency as one neutral contract.

## Decision

SIM provides one consumer-neutral `geo-routing-v1` operation in
`situation-data-api`. It accepts only `walking` and `bicycle`, sends every point
to Valhalla `/route` as an ordered `break`, validates the returned leg count and
snap distance for every waypoint, and rejects fallback, missing geometry,
missing elevation, or missing dataset timestamp.

The operation uses distinct opaque bearer tokens per backend identity with the
fixed audience `csm-sim-geo-routing-v1` and scope `geo-routing:route`. Browser
origin requests are rejected. Rate limiting is keyed by service identity.

An optional `Idempotency-Key` persists an atomic technical response snapshot
keyed by actor and request hash. SIM stores no consumer content/domain model.
The response reports the Valhalla tileset timestamp as a stable dataset version
and build date. Public clients consume only snapshots served by their own
backend.

## Consequences

Published routes remain deterministic across dataset refreshes. Consumers can
retry publication safely and audit which dataset produced the route. The
operation fails closed when Valhalla or elevation/dataset metadata is missing;
it does not inherit the compatibility fallback behavior of older routing APIs.
Operators must provision and rotate one token per consumer and retain/clean the
technical idempotency store according to operational policy.

## Alternatives considered

- Browser-to-Valhalla or browser-to-SIM: rejected because it exposes internal
  infrastructure and service credentials.
- Valhalla `optimized_route`: rejected because the contract guarantees input
  order.
- Reusing the older route response: rejected because its fallback behavior and
  service-neutral provenance do not satisfy publication determinism.
- Storing consumer stories/games in SIM: rejected because ownership remains in
  the publishing backend.

## Rollback

Disable all geo-routing service tokens, roll back `situation-data-api`, and
leave the independent Valhalla release unchanged unless its own canaries fail.
The detailed procedure is in
[19_GEO_ROUTING_V1_CONTRACT.md](../integration/19_GEO_ROUTING_V1_CONTRACT.md).
