# ADR 0037: Source-wide flight provider backoff

Status: accepted, 2026-10-20.

## Context and decision

Production ADSB.lol returned HTTP 429. Per-viewport caching and coalescing do
not prevent failed requests across different viewports. Immediate triple retries
amplify provider load. Keep caching and bounded stale handling; replace immediate
retries with a source-instance single-concurrency gate and exponential failure
cooldown. Respect Retry-After (seconds or HTTP date), even above the local cap.
Never bypass rate limits using another IP. Error state remains visible until
successful recovery. Public API, secrets and network are unchanged.

## Deployment and rollback

A narrow image may derive from the verified immutable current flight image,
replacing only compiled sources.js and provider-request-gate.js using
deploy/flight-provider-gate.Dockerfile. Preserve the prior image tag, recreate
only flight-data-api with its existing Compose settings and verify real data
and ages. Rollback restores the saved tag and recreates only that service.
A future full build must include the source change.

## Limitations

The gate is not a cross-replica/shared-IP quota. Real provider recovery is an
independent acceptance gate, not guaranteed by synthetic tests. IDS JMK needs
an authorized replacement endpoint; do not scrape its web map or label
historical records as live. Details are in the performance runbook.
