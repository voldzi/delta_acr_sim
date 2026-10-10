# ADR 0034: Bounded search partial-feed recovery

Status: Accepted
Date: 2026-10-11

## Context

The SDA Safety bridge waited 8s against COP's 6s deadline. Timeout became a
partial HTTP200 feed cached as a complete success for 300s, hiding recovery.
Safety HTTP200 warnings were also discarded, producing false completeness.

## Decision

Bound the Safety bridge by 4500ms including body, retaining shorter configured
timeouts. Preserve warnings as sanitized static markers. Source-incomplete
cache lasts at most30s with no stale-on-error extension. Complete feeds preserve
TTL and source timestamps. Per-value cache policies can only shorten fresh/stale
windows, including shared reads. No network/auth/token/AI/provider cadence/
notification/live-traffic policy changes. Deploy only SDA from its exact current
routing revision plus the patch.

## Consequences

Cold Safety can remain incomplete while its coalesced load finishes; this is
not a total deadline guarantee for other providers. Nginx 10s background cache
remains visible through `X-SIM-Gateway-Cache`. Old data must not become current
or notification-eligible because of a new wrapper timestamp.

## Verification and rollback

Test header/body stalls, recovery, warning redaction, stale data, local/shared
cache and coalescing, then routing/contract regressions. Verify ordinary COP
traffic without cachebusting. Restore the previous SDA image using the existing
Compose override; all other services, secrets and databases remain untouched.
