# ADR-0012: Dynamic Docker DNS for Nginx Gateway

## Status
Accepted

## Context

`sim-web` is the nginx gateway for SIM static assets and server-to-server
provider APIs. During a production deploy on `docker.home.cz`, backend services
such as `sim-api` and `safety-data-api` were recreated successfully and became
healthy, but nginx kept proxying to the old Docker network IP addresses. The
result was transient `502 Bad Gateway` responses until `sim-web` was restarted.

Static `proxy_pass http://service:port/...` resolves Docker service names when
nginx starts. That is not robust enough for a Compose deployment where backend
containers are recreated independently.

## Decision

`sim-web` uses the Docker embedded DNS resolver `127.0.0.11` and variable-based
`proxy_pass` targets for backend services. Prefix routing that changes the
upstream path uses explicit `rewrite ... break` rules before proxying to the
runtime-resolved service target.

The deployment smoke test must exercise gateway routes for health, catalogs,
taxonomy and feature summary endpoints after every build.

## Consequences

Backend containers can be recreated without requiring a manual `sim-web`
restart only to refresh upstream IP addresses. A stale Docker DNS record can
remain for at most the configured resolver validity window.

The nginx configuration is slightly more explicit because prefixed provider
routes need rewrite rules before variable-based proxying. Gateway smoke tests
become more important because URI rewriting mistakes would otherwise surface as
runtime 404 or 502 errors.

## Alternatives Considered

- Always restart `sim-web` after backend deploys. This is operationally simple
  but fragile because an omitted restart reintroduces `502` risk.
- Use static upstream blocks. Open-source nginx does not reliably re-resolve
  Docker service names for existing upstream definitions in the way this Compose
  deployment needs.
- Publish each backend port directly. This would weaken the single-gateway
  access-control model and expose more surface area.

## Follow-up Actions

- Keep deploy smoke tests aligned with provider contracts consumed by COP.
- If SIM moves behind an external ingress controller, preserve the same
  requirement: backend service discovery must survive backend recreation without
  manual gateway restart.
