# ADR-0013: Stale Provider Gateway Cache

## Status
Accepted

## Context

SIM is consumed by COP as a server-to-server provider. During Docker Compose
deploys, a single backend API container can be recreated while COP is polling
the gateway. Even with dynamic Docker DNS, there is a short interval where the
service name resolves but the backend connection is refused. In that interval
nginx can return `502 Bad Gateway`.

The affected provider endpoints are GET-heavy and already backed by service
level caches. For COP map polling, returning a response that is a few seconds
old is operationally better than surfacing a transient gateway failure.

## Decision

`sim-web` enables a short nginx cache for internal GET provider API routes:

- `/flight-data/api/*`
- `/situation-data/api/*`
- `/safety-data/api/*`

The cache stores successful `200` responses for 10 seconds and can serve stale
responses on upstream errors, timeouts, invalid headers and `5xx` responses.
The cache is bypassed when an `Authorization` header or `nocache` query
argument is present. Gateway responses on these routes normalize cache headers
to `Cache-Control: private, max-age=10`, so longer upstream cache lifetimes do
not accidentally extend the server-to-server COP feed TTL.

The cache is not enabled for health endpoints, metrics, static assets, the
operator `/api/*` surface or TAK gateway API routes.

## Consequences

Short backend recreates should no longer surface as transient `502` responses
for repeated COP provider polling when a recent response exists in the gateway
cache. COP may receive data that is up to the nginx cache validity/stale window
old, which is acceptable for these provider map streams and shorter than the
provider source cache TTLs.

First requests for a never-seen query can still fail if they arrive exactly
while the backend is unavailable. Full zero-downtime with no first-request gap
would require running multiple backend replicas or a blue/green deployment
model. That remains a separate architectural step because several current
services use single-writer local volumes or stateful queues.

## Alternatives Considered

- Scale each API service to multiple replicas. This conflicts with current
  fixed container names and needs per-service state review before enabling.
- Use only dynamic Docker DNS. This fixes stale IPs but not the brief interval
  where the new backend process is not yet listening.
- Return a custom maintenance response for `502`. That improves message
  clarity but still gives COP a failed provider call.

## Follow-up Actions

- Track `X-SIM-Gateway-Cache` headers during deploy smoke tests when diagnosing
  provider latency or stale responses.
- Review each provider service for safe replica scaling before moving from
  Compose-style stale-cache mitigation to true multi-replica zero downtime.
