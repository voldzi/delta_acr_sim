# ADR 0037 Search feed read time freshness

Status: Proposed
Date: 2026-10-12

## Context

Application-cache reads preserve a normalized feed snapshot, but validity can
expire before its configured TTL ends. A Safety mapper that trusts an explicit
false stale flag can also lose expiry information. Using observability request
time as the last successful Safety result makes old data appear newer.

COP must distinguish reachable services from degraded source data. Existing
`dataQualityStatus`, `sources` and cache telemetry do not establish the current
validity of a returned page. A later successful response cannot reconstruct the
missing aggregates from an earlier failed deployment gate; the historical
provider, database and API cause remains undetermined.

## Decision

Project expiry onto returned `/entities` records on every read, including
application-cache hits. Preserve existing staleness and mark expired records
stale/expired. Invalid or missing dynamic expiry cannot certify freshness;
OSM records with `sourceSystem=osm_reference` and `sourceAuthority=reference`
without a deadline retain their reference status/staleness, not live-observation
authority or a fabricated expiry. Safety projection
combines provider staleness with expiry rather than replacing one with the
other.

Add optional `freshness` to the existing `sim-search-source-v1` feed. Its fixed
scope is `returned_entities`; it contains evaluation time, original feed
timestamp validity/age and counts of returned stale, expired, missing-expiry
and invalid-expiry records. It does not represent a complete collection or
country-wide count. Invalid-expiry counts inspect normalized returned fields,
not raw provider values; a value normalized to null is part of missing-expiry
counts. A valid expired deadline takes precedence over an invalid second
deadline. Invalid/future original feed times have unknown age (`null`), never
zero. `/query` projects expiry before its existing stale filter and uses the
same returned-result diagnostics at one evaluation time without introducing a
shared whole-feed cache.

Keep the original feed/source timestamps, source revisions, order, cursors,
pagination and stored snapshot unchanged. Existing summary scopes, complete
TTL and partial-feed recovery from ADR 0034 remain unchanged. Projection adds
no provider request. Safety source `lastSuccessAt` uses the actual
`lastResult.generatedAt` when available, not the status request time.

Gateway `HIT`/`STALE` can retain a serialized response without executing the
application projection again. Its original `evaluatedAt` remains authoritative
for that evaluation, not for the consumer request time. The gateway cache
policy is unchanged; consumers must still respect actual entity deadlines.

Consumers retain service availability separately from optional quality and
freshness. Missing quality/timestamps/counters mean unknown, not success or
zero. Cache telemetry remains an open object whose recognized numeric fields
are allowlisted by the consumer. No source-specific age threshold is guessed.

## Boundaries

There is no new endpoint, port, authentication flag, provider cadence, secret,
role, database or durable diagnostic store. A future purely cache-only status
endpoint is not implemented by this decision. Existing-retention diagnostic
snapshots may contain only static codes, enum states, ISO times and numeric
aggregates, never entities, queries, cursors, raw warnings, URLs or secrets.

The change is prepared source only until coordinated acceptance and release.
Use the exact deployed routing base plus the selected search diff; no unrelated
feature branch may enter the image. Routing guards, measurement pilot flags,
HMAC/token values, databases, mounts, networks and other services stay intact.

## Verification and rollback

Test expiry between cache reads, boundary times, preserved stale flags,
invalid/missing metadata, reference records, original snapshot immutability,
returned-page scope, unchanged ordering/cursors/revisions, query behavior,
Safety snapshot time and partial/full cache policy. Validate the binding
OpenAPI and run the Situation Data routing/measurement regressions.

Production deployment requires the coordinated build window, exact image
identity, health/contract checks and ordinary COP processing with sanitized
metadata. No test-only source refresh or weakened health gate is allowed.
Rollback selects the previous image and recreates only Situation Data API via
the existing Compose overlays. No data migration or network/secret change is
required. Accepting this ADR requires the source tests and joint SIM/COP
freshness acceptance; a historical cause is not implied by that acceptance.

The pinned image-only release uses `scripts/deploy-search-freshness.mjs` and
the exact procedure in the mapped performance runbook. Its operations commit
is reviewed separately from source revision `90e1d8d`; the historical routing
deploy guard is not repurposed. Production configuration is not copied or
reserialized: only the same-width image value may change under byte-level
compare-and-swap and FD flock. Rollback records contain private metadata and
hashes, not configuration contents. A partial write or foreign configuration
change requires coordinated attention without blind recreation or restore.

Runtime provenance is anchored to the complete immutable old image, not a
moving Node.js base tag. The narrow operations Dockerfile copies only the two
reviewed source/compiled search files into that exact runtime. Candidate checks
require its complete original RootFS prefix plus two new layers, unchanged
runtime configuration and a whole offline-filesystem comparison covering OS,
native libraries and dependencies. Only the reviewed files and explicit
Docker/virtual runtime mount paths are excluded. Development dependencies may
exist in the build stage but are never copied into the final runtime. These
provenance checks do not replace host resource, Linux file-write or joint live
acceptance gates.
