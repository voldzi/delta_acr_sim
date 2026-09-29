# ADR 0027: Graph-native OpenLR decoder for Valhalla traffic

Status: proposed, implementation and production activation gated
Date: 2026-09-29
Owner: SIM / Valhalla

## Context and decision

The licensed Czech TMC v11.0 table proves that all 55,150 current TPEG2-TFP
static references use known `CID=11`, `TABCD=25` point locations. A TMC point
does not identify a directed Valhalla edge path. The live conservative
`openlr-trace-v2` map covers 35,639 references (64.62%). The read-only v7
GraphReader experiment produced 7,472 disjoint additional candidates, but
independent checks still found wrong or divergent paths. Candidate count is
not acceptance. No new v7 match may be applied live merely by enabling a flag.

Implement a **separate, version-pinned, graph-native decoder** using the same
Valhalla tiles as the serving instance. Decode once for each combination of
`routingDataset`, `staticRevision`, TMC table version/hash and decoder version;
apply fresh TFP speeds only through a subsequently approved directed-edge map.
The decoder is an offline/release-time sidecar, not work performed for every
user route. Keep the existing `openlr-trace-v2` live mapping unchanged until
the acceptance gate below passes. Do not replace Valhalla with a second
routing graph just to obtain OpenLR decoding.

The algorithm follows the [Valhalla maintainer's OpenLR design](https://github.com/valhalla/valhalla/discussions/5391):
candidate search for each LRP, FRC/FOW/direction ranking, trivial same-edge
resolution, bounded distance-based path search for nontrivial pairs, offsets,
and an output of directed `EdgeSegment`-like intervals. TomTom's
[reference decoder](https://github.com/tomtom-international/openlr/) and
[Python dereferencer](https://github.com/tomtom-international/openlr-dereferencer-python)
are specification/test oracles, not drop-in Valhalla graph adapters. Their
map-interface requirements are distinct from our graph-specific edge IDs.

## Input and version boundary

- Input is SIM's authenticated, normalized **static** TPEG2 feed: message ID,
  ordered OpenLR LRPs with coordinates, bearing, FRC, FOW and distance-to-next,
  positive/negative offsets, and TMC country/table/location identifiers.
  Dynamic flow values never participate in deciding a path.
- The current authorized snapshot has exactly two LRPs for all 55,150 records;
  52,058 have no offset, 1,368 positive only, 1,369 negative only and 355 both.
  Version 1 targets this bounded two-LRP profile. Any other LRP count is an
  explicit unsupported result, not silently truncated.
- TMC v11.0 is a private plausibility check for country/table/location,
  anchor, road affiliation and offset direction. It is not a road geometry.
  A stale/different TMC revision or mismatched country/table fails the new
  candidate; licensed records never enter Git, public APIs or telemetry.
- Read the exact active candidate graph release under an immutable mount.
  Verify its identity before and after the batch. Graph edge IDs from another
  release are invalid even if the OSM road appears unchanged.

## Decoder contract

For each LRP, search a bounded radius in the **directed** graph and rank
candidate directed edges by bearing, FRC, FOW, one-way direction, link/ramp,
roundabout and car accessibility. Reject graph shortcuts, forbidden turns,
complex restrictions not safely handled, non-finite values and unsupported
road types. Reject candidates whose TMC anchor or chain contradicts the OpenLR
road/direction; a large anchor displacement requires review, not a wider snap.

For a pair on one edge, require a unique compatible directed edge and valid
fraction order. Otherwise find bounded paths between ranked endpoint
candidates using distance-based vehicular costing, preserving turn and graph
hierarchy semantics. Compare path length with OpenLR distance-to-next and
check both bearings, road attributes and connectivity. An ordinary fastest
route or generic GPS map snap is **not** an OpenLR decoder. If two plausible
paths have different directed-edge sequences, output `ambiguous`, not the
cheapest path. Apply positive/negative offsets along the chosen path and
produce ordered `(directedEdgeId, beginFraction, endFraction)` intervals.

The audit artifact contains only graph/version keys, aggregate rejection
reasons and a private message-to-edge map. On current Valhalla live traffic,
only fully covered directed edges may receive one current speed. Partial
edges remain explicitly unmatched until the runtime's encoding semantics
are separately verified. Different flow references claiming the same edge
must be rejected or resolved by a separately documented, independently
tested ownership rule; no last-write-wins. The live updater remains bounded
by the existing lease, freshness, expiry and rollback rules in ADR 0020.

## Implementation sequence

1. **Offline core:** replace the exploratory `openlr-graph-probe.cc` search
   with a version-pinned Valhalla C++ decoder using the project search/routing
   APIs and explicit correlated request IDs. Return edge intervals and
   machine-readable rejection reasons. No `traffic.tar` writes.
2. **Independent fixtures:** test two-way/one-way, parallel carriageways,
   ramps, roundabouts, overpasses, turn restrictions, same-edge and multi-edge
   paths, reversed TMC direction, both offset types, partial edges, missing
   TMC locations and release mismatch. Compare a bounded selection against
   the TomTom decoder concepts and independently reconstructed graph paths.
3. **National shadow batch:** run over all 55,150 references on an immutable
   graph, with bounded CPU/IO, no source-record logging, deterministic cache
   key and repeat run. Report baseline, newly unique, ambiguous, wrong-road,
   offset and collision counts by road class and direction. Compare with the
   existing v7 audit and investigate every divergent class before promotion.
4. **Geographic acceptance:** independently inspect a stratified sample of
   newly accepted paths on a map, including all known disjoint offset cases,
   parallel roads and junctions. Check continuity, direction, TMC road and
   both endpoint fractions. Any confirmed wrong carriageway blocks promotion
   of that failure class; do not average it away with a national percentage.
5. **Route-time shadow comparison:** compare vehicle routes across affected
   and unaffected corridors with the same graph, active-flow snapshot and
   controlled departure times. Evaluate against independent observed trip
   times where lawfully available; segment-coverage growth alone is not ETA
   accuracy evidence. Walking/bicycle and routes outside the traffic region
   must remain unchanged.
6. **Canary then rollout:** publish only the accepted graph-specific map as
   an opt-in canary. Require matching graph/static/TMC/decoder hashes, safe
   rollback map, clean healthcheck, fresh source and post-activation route
   tests. Observe wrong-road reports and ETA error before increasing use.

## Acceptance and failure behavior

- All synthetic wrong-direction/parallel/offset/conflict tests reject or map
  to the exact intended directed intervals. No silent fallback to an ordinary
  auto route, opposite edge or nearest point.
- National shadow output is deterministic for identical four-part cache key;
  it does not modify live speed tiles. A changed weekly graph invalidates it.
- The independent geographic review has no confirmed wrong-direction or
  disjoint-path candidate in the promoted class. Unreviewed classes remain
  disabled, even if their apparent coverage is high.
- Runtime reports separately: static reference coverage, unique edge
  coverage, fresh-flow coverage, source age, collisions and rejected reasons.
  Never report a TMC reference match as a speed/ETA success.
- On decoder failure, stale feed, changed graph, missing TMC table, bad cache
  or ambiguous path, retain the last approved mapping or static-speed
  fallback. No public route outage and no unverified live speed.

## Rollback

Disable the canary selection, restore the previous `openlr-trace-v2` mapping
and clear only the affected volatile live-speed archive. Keep the Valhalla
graph, SIM routing contract and weekly map release intact. Re-run one affected
and one unaffected vehicle route plus SIM/Valhalla healthchecks. Preserve
private audit artifacts for diagnosis under the licensed retention rules.

## Non-goals

No promise of 100% mapping or a fixed ETA-accuracy percentage; genuinely
ambiguous references are rejected. No change to provider credentials,
network segmentation, public COP API, walking/bicycle routing or production
speed selection in this ADR alone.
