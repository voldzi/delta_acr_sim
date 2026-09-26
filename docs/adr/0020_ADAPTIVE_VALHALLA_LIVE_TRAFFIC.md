# ADR 0020: Adaptive TPEG2 live-speed routing for Valhalla

## Status

Accepted and implemented in production. The Valhalla runbook records release
evidence and the remaining map-matching quality work.

## Context

SIM already normalizes authenticated NDIC/CEDA TPEG2 TFP traffic speeds, while
Valhalla 3.8.3 routes from OSM-derived base speeds. Valhalla can consume live
speeds from a fixed-size `traffic.tar` whose tile and directed-edge identifiers
must exactly match the active routing graph. Those edge identifiers are not
stable across weekly routing builds.

The desired pilot behavior is demand-driven: an isolated road request must not
wait for a provider download, but continued road-routing activity should keep
traffic no more than five minutes behind the upstream snapshot. Walking and
bicycle requests must not activate road traffic processing.

`/srv/x5-production` exists on `docker.home.cz`, not on the separate
`valhalla.home.cz` host. It must therefore not be treated as a shared filesystem
or as a runtime dependency of Valhalla.

## Decision

SIM owns a sliding road-activity lease and an authenticated internal normalized
feed:

- the first road route request activates a 15-minute lease;
- every further road request extends the lease by 15 minutes;
- the host-local Valhalla timer polls once per minute and receives HTTP 204 when
  the lease is inactive;
- while active, the existing TPEG2 source coalesces refreshes and refreshes
  dynamic TFP no more than once per 300 seconds;
- the internal traffic feed waits for any due TPEG2 refresh before returning a
  snapshot; ordinary map requests may still use the previous snapshot while
  refresh runs. Expired observations are never treated as current speeds;
- the route request never waits for the traffic updater; it uses the last live
  overlay if valid, otherwise Valhalla's normal speed fallback;
- road-route response cache keys include the last overlay update timestamp, so
  a new speed revision does not keep returning a route and traffic status from
  the preceding five-minute cache entry;
- road requests without an explicit departure time include
  `date_time.type=0`, which is required for Valhalla to use current traffic;
- walking and bicycle requests neither activate the lease nor enable current
  road speeds.

SIM exposes three bearer-authenticated server-to-server operations:

- `GET /api/v1/internal/valhalla-traffic/feed`;
- `POST /api/v1/internal/valhalla-traffic/report`;
- `GET /api/v1/internal/valhalla-traffic/status`.

The feed contains only normalized message identifiers, OpenLR reference
coordinates, speed observations and validity metadata. It never contains the
TPEG2 API token or source XML. A separate
`VALHALLA_TRAFFIC_CONTROL_TOKEN` authenticates this channel.

On `valhalla.home.cz`, `traffic-update.py` performs the following work:

1. obtains the active Valhalla `tileset_last_modified` identifier;
2. loads or builds a graph-specific OpenLR-reference-to-directed-edge map with
   local `/trace_attributes` calls;
3. rejects expired observations and speed values that are absent, non-finite or
   non-positive;
4. clears all edge values applied by the preceding snapshot;
5. writes validated fixed-size `TrafficSpeed` records and per-tile timestamps
   into the active memory-backed archive under `/run/valhalla-traffic`;
6. reports mapping coverage, applied flows, applied edges and freshness back to
   SIM.

When more than one TPEG segment maps to the same directed edge, the lowest
current speed is used. This is deliberately conservative and is observable via
the reported counts. A maximum observation age of 1,800 seconds prevents an old
snapshot from remaining a live-speed authority.

## Storage and wear policy

The storage split is intentional:

| Host | Path | Meaning | Backup requirement |
|---|---|---|---|
| `docker.home.cz` | `/srv/x5-production/cache/csm-sim/valhalla-traffic` | normalized static and last-valid dynamic TPEG2 snapshots | none; reproducible cache |
| `valhalla.home.cz` | `/run/valhalla-traffic/traffic.tar` | active memory-backed Valhalla overlay | none; recreated after boot |
| `valhalla.home.cz` | `/srv/valhalla/traffic-cache/openlr-edge-map-*.json.gz` | graph-specific mapping rebuilt after map releases | none; reproducible, written approximately weekly |
| routing release | `traffic-skeleton.tar` | empty graph-matched overlay generated with the release | retained with the reproducible release |

The five-minute update path writes only to `/run`, avoiding recurring writes to
the non-replaceable internal disk. X5 is protected by the existing UUID check
`2f93f595-b61b-4eea-9054-7afa9b275b5b`. If X5 is absent, deployment refuses to
start `situation-data-api` against an accidental directory on the system disk.
The runtime archive is root-owned and mode `0644`: the unprivileged Valhalla
container can map it read-only, while only the root-owned host updater can
modify its speed records.
Host-side installation and update probes derive their URL from
`VALHALLA_BIND_ADDRESS` and `VALHALLA_PORT`; the deployment does not assume the
published port is also bound to loopback.
The installation smoke route explicitly requests administration metadata before
validating `CZ`, and the local transfer helper preserves the remote install exit
status after securely deleting its temporary token file.
TPEG validity filtering parses the ISO 8601 offset supplied by the provider
(normally `+02:00` in summer) before comparing timestamps in UTC; the offset is
never discarded.
Replacing the runtime archive invalidates both `applied-edges.json` and
`last-applied.json`. Revision-based no-op optimization is allowed only when the
archive, revision marker, and applied-edge state all exist together.

## Release coupling and availability

Every weekly Valhalla build creates a fresh traffic skeleton with
`valhalla_build_extract --with-traffic`. Activation stops Valhalla, switches the
routing release, copies the corresponding skeleton to `/run`, clears the old
applied-edge list and restarts validation. Rollback performs the symmetric copy.
Mappings are keyed by matcher version, routing dataset and TPEG static revision.
The matcher version changes whenever matching semantics change, so a new
algorithm cannot silently reuse a cache built by its predecessor. The previous
mapping stays intact for rollback.

Traffic is an optional enhancement. A missing feed, missing X5 cache, failed
map-match or expired observation may degrade `liveSpeeds`, but must not make the
base Valhalla route service unavailable. The first request after idle can use a
previous valid overlay or static speeds; subsequent requests use refreshed data
once the asynchronous update completes.

## Observability

SIM readiness, observability and route traffic summaries expose the traffic
state (`disabled`, `idle`, `warming`, `current`, `stale`, `degraded`), update
time, source observation time, age, routing dataset, mapping coverage and
applied record counts. Tokens, raw TPEG payloads and individual internal edge
maps are not exposed.

The host-side mapping build logs aggregate rejection counts and source/matched
counts by OpenLR functional road class. It does not log coordinates, message
identifiers, provider payloads or tokens. This distinguishes unsupported
offsets, missing reference properties, failed Valhalla traces, length and
bearing mismatches before any quality threshold is reconsidered. A 50% mapping
coverage threshold is an operational freshness gate, not proof that every
accepted edge is geometrically correct; reviewed samples and negative tests on
parallel roads remain release criteria.

An experimental OpenLR route-candidate resolver is available behind
`TRAFFIC_OPENLR_ROUTE_FALLBACK=false` (the default). It is considered only after
Valhalla trace error 444. It constrains both LRP endpoint searches to 20 m and
34 degrees, then requires full first/last edges, one uniquely qualified
directed edge at each endpoint, matching route edge IDs, a path length within
10% or 35 m, both bearings within 35 degrees, road classes compatible with
the OpenLR FRC, and limited FOW checks. Nonzero offsets are rejected. The
candidate matcher has its own versioned cache key and cannot silently replace
the validated trace-only mapping. `--audit-route-fallback` compares only
previously unmatched segments, saves a separate mode-0600 candidate artifact,
and never updates `traffic.tar` or reports a new state to SIM. Enabling the
fallback for live traffic requires full-dataset acceptance and reviewed
parallel-road, direction and partial-edge counterexamples; a positive sample
alone is insufficient.

## Rollback

1. Set `VALHALLA_TRAFFIC_ENABLED=false` and recreate `situation-data-api`.
2. Disable `valhalla-traffic-update.timer` on `valhalla.home.cz`.
3. Restore `valhalla.json.pre-live-traffic` for the active legacy release if a
   complete application rollback is required.
4. Recreate Valhalla. Base OSM routing remains valid throughout; do not roll
   back the routing dataset solely because the traffic overlay is degraded.
