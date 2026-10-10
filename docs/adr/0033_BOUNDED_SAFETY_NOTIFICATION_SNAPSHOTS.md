# ADR 0033: bounded safety notification snapshots

Date: 2026-10-10. Status: accepted; deployment evidence belongs to contract 21.

## Context

From the running COP backend, a country-wide query without flood completed
in 1,960 ms, while an isolated hydro query for a small Prague box/limit 10
timed out after 15,006 ms before headers. The deployed hydro implementation
refreshes a shared country-wide snapshot in sequential batches of eight.
The aggregate waits for all requested sources. Provider timeouts previously
ended after response headers, leaving body consumption outside the deadline.

Freshness also cannot be inferred from a newly constructed aggregate wrapper
or the newest success across unrelated cache keys. Nested successful caches
can contain stale fallback data and must retain that evidence for later hits.

## Decision

- Bound only candidate snapshot loading to 8,000 ms; timeout/load failure is
  no-store HTTP 503 with `SAFETY_NOTIFICATION_INPUT_UNAVAILABLE` and correlationId.
- Allow existing shared refreshes to complete and coalesce after the caller's
  wait ends. Do not raise provider rates, parallelism, cache age or COP's budget.
- Persist nested stale and oldest current-payload retrieval evidence in each
  cache entry/load result. Replay it to every hot/coalesced reader; a different
  key's recovery cannot relabel old data.
- Use conservative original snapshot timestamps, including actual current
  payload retrieval times. Exclude reference metadata/geocoding/history from
  current-data tracking. Invalid/future retrieval timestamps fail closed.
- Cover headers and body with the same provider HTTP timeout.
- Preserve network-only internal read access, global bearer rules, no-store
  decision responses, and per-feature/whole-input eligibility checks.

## Consequences and rollback

Cold hydro refresh may legitimately return timely 503 until complete; this
does not mean no hazard exists. Old/failed/incomplete snapshots produce no
usable notification candidates. Data availability is not increased by lying
about timestamps or broadening the 300-second COP freshness boundary.

Deploy only Safety with the existing image-selection mechanism, retaining
the previous image/configuration for rollback. No token/network/database/AI
or map changes. Rollback may restore the former timeout behavior and must
not be accepted as proof of notification delivery readiness.
