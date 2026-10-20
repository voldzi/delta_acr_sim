# ADR 0038: Bounded accepted routing work and renewable coverage

Status: accepted, 2026-10-20.

## Decision

Do not enable legacy route caching for accepted closure-aware or strict trips.
Share only concurrent identical native known-closure calculations keyed by the
entire normalized request, exact graph/engine, full closure snapshot and traffic
revision. No completed result is retained. Each caller owns a clone and still
independently verifies final graph, closures, geometry and traffic validity.
Strict trip requests retain their independent no-cache path.

All expensive Valhalla HTTP work uses a process-wide FIFO budget of four active
requests and 32 waiting, with a five-second queue deadline. Verification status
requests have an independent four-active/64-waiting budget and two-second queue
deadline. Overload is explicit 503 ROUTING_BUSY; it must not cause unconstrained
road fallback. No new client header grants priority or impersonates an app.
These are per-process budgets, not a distributed per-application quota.

Mobile read-model tiles are prepared separately per technology at the exact
runtime resolution, validated before deletion, and replaced in one transaction
with an advisory lock. A daily systemd check rebuilds all three technologies
only when any technology is missing or within two days of expiry. The root
operator installs its timer; the installer must not be implied by a source
commit. X5 mount UUID is checked before running. Logs contain aggregates only.

## Acceptance

Test bounded queue saturation, timeout/recovery, eight concurrent clients,
result isolation, changed closures/graphs, stale and expired speeds, rejected
unroutable points, and transaction rollback. Provider intervals, permissions,
freshness/coverage thresholds, network and measurement shadow_only are unchanged.
Actual route ETA accuracy remains unproven until independently observed trips
are evaluated; successful routing or mapping coverage is not ETA accuracy.

## Rollout and rollback

Build from the exact running situation-data image and replace only the five
compiled changed modules using deploy/routing-performance.Dockerfile. Verify the
immutable parent and module hashes; retain the old image tag. Recreate only
situation-data-api with unchanged Compose/secret/volume/network configuration.
Verify normal and unroutable routes, real current overlay validity, shared
native work metrics, and ordinary mobile read-model queries. Rollback restores
the old image tag and recreates only that service; disable the new timer before
rolling back its CLI. No partner payloads or actual user trips enter reports.
