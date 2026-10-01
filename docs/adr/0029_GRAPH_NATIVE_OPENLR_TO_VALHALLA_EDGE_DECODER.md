# ADR 0029 Graph native OpenLR decoder for Valhalla traffic

Status: hierarchy-aware offline candidate decoder v2 implemented; live mapping and activation gated
Date: 2026-09-29
Updated: 2026-10-01
Owner: SIM / Valhalla

## Context and decision

The licensed Czech TMC v11.0 table proves that all 55,150 inspected TPEG2-TFP
static references use known `CID=11`, `TABCD=25` point locations. A TMC point
does not identify a directed Valhalla edge path. The live conservative
`openlr-trace-v2` map covers 35,639 references (64.62%). The read-only v7
GraphReader experiment produced 7,472 disjoint additional candidates, but
independent checks still found wrong or divergent paths. Candidate count is
not acceptance. No new v7 match may be applied live merely by enabling a flag.

On 29 September the narrower HTTP route-candidate v3 matcher was re-audited
against the newly active graph: 5,286 disjoint additions (74.21% potential
combined static coverage), with 14,225 explicit rejections. A stratified
62-route repeat agreed on directed-edge sequences for all 62, but it reused
Valhalla routing and is not independent geographic ground truth. The pilot's
time-bounded, automatically rolled-back canary compared route behavior but
did not authorize a live switch, an ETA-accuracy claim or national promotion
of v3/v7.

A subsequent independent TMC v11 road-geometry challenge found materially
more corridor divergence in the FRC-stratified v3 candidates than in a
historical-baseline-ID control (39/62 versus 3/64 paths diverged over 100 m
between TMC-aligned endpoints). The TMC geometry is not a directed-edge
oracle, but this disparity fails the v3 promotion gate. Do not repeat a v3
traffic canary as a substitute for fixing and geographically validating the
decoder. The graph-native work below is the next implementation path.
The exact candidate edge geometries, read directly from the active graph,
reproduced the sample result. A full shadow pass rejected 3,987 of 5,286
v3 candidates for corridor divergence and left only 322 automated geographic
passes. These 322 are not approved: the current search chose paths before
the TMC corridor was considered, so a post-filter cannot recover the correct
alternative or certify directional uniqueness. The native search must include
road/corridor evidence during path finding, not merely after it.

An initial separate C++/Python shadow probe now applies the TMC corridor
inside a bounded native directed-edge search. Its first 62-reference,
FRC-stratified v3 sample found 3 candidate paths, independently confirmed to
follow the TMC geometry in the correct LRP order and bearing. This narrow
feasibility result does not satisfy the ADR's uniqueness, precision,
turn-restriction or canary gates. No live traffic mapping changes follow from
it; ambiguous and unmatched references retain the established fallback.

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
- The inspected authorized snapshot has exactly two LRPs for all 55,150 records;
  52,058 have no offset, 1,368 positive only, 1,369 negative only and 355 both.
  The implemented v1 accepts 2–16 ordered LRPs and tests multi-LRP joining;
  it never truncates a reference. Counts outside that range are invalid.
- TMC v11.0 is a private plausibility check for country/table/location,
  anchor, road affiliation and offset direction. A TMC point record is not
  a directed road path. Separately linked road geometry can constrain search,
  but cannot itself prove the chosen carriageway or direction.
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
intervals remain candidate evidence and are ineligible for runtime speed
application until the encoding semantics are separately verified. Different flow references claiming the same edge
must be rejected or resolved by a separately documented, independently
tested ownership rule; no last-write-wins. The live updater remains bounded
by the existing lease, freshness, expiry and rollback rules in ADR 0020.

## Implemented offline v1 (1 October 2026)

The completed implementation is separate from the earlier exploratory probe:

- `deploy/valhalla/openlr-native-decoder.cc` and `openlr-native-core.h`:
  pinned Valhalla 3.8.3 native `loki::Search`, `GraphReader` and `AutoCost`
  access/turn checks, followed by bounded exhaustive simple directed-path
  search on native integer-meter edge lengths. This is not a fastest-route
  query and does not claim a full hierarchy-aware A* implementation.
- `deploy/valhalla/openlr-native-client.py`: strict private protocol,
  normalized TPEG byte-bearing conversion, graph/TMC cache identity,
  candidate ownership checks and mode-0600 audit output.
- `deploy/valhalla/Dockerfile.openlr-native-builder`: a separate helper build
  definition pinned to the Valhalla 3.8.3 image digest, not the serving image.
- `scripts/test-valhalla-openlr-native.sh`: actual compilation and synthetic
  OSM PBF → Valhalla graph tests in a disposable container, with no network,
  read-only source mount, 2 CPUs, 2 GiB memory and 128-process limit.

The initial full native test run passed 63 checks/test cases; strict
corridor-entry, owned-process lifecycle and output-path regressions raise the suite to **69**:
20 C++ core checks, 17 Python client test methods, 30 real flat-graph cases and 2 real hierarchical
graph cases. The C++ helper was compiled and linked against Valhalla 3.8.3;
graph tests do not mock native correlation or routing data. Coverage includes
same-edge and both offsets, multi-LRP joining, junction snap, one-way reversal,
parallel-path ambiguity, LFRCNP, ramps/roundabouts, simple turn restrictions,
vehicle-node barriers, disconnected overpasses, unsupported complex
restrictions, TMC-like corridor selection during search, partial intervals,
cross-reference ownership, bounded protocol failures, child-process cleanup on
timeout, SIGKILL escalation after the one-second SIGTERM grace and bounded
Darwin group-exit permission races, actual TPEG-byte client
round-trip, blocked unhashed tile-directory fallback, final graph mutation and
input/runtime output-path protection, including symbolic and hard links.
All fixtures are invented; no licensed provider records are test fixtures.

This establishes the **offline implementation**, not a new nationwide mapping,
live deployment or ETA improvement. Every audit explicitly contains
`approvedForLive=false`. No updater flag, traffic archive, timer, routing
service or production network was changed by this implementation/test work.

### Private helper and audit contracts

The helper is invoked as `openlr-native-decoder CONFIG EXPECTED_ROUTING_DATASET
EXPECTED_GRAPH_SHA256`; stdin/stdout carry one correlated JSON line per
request/response. Requests have only `requestId`, `routingDataset`,
`graphSha256`, `staticRevision`, `lrps`, optional `positiveOffsetMeters`,
optional `negativeOffsetMeters`, and optional `corridor`. Each LRP has only
`lon`, `lat`, `bearingDegrees`, `frc`, `fow`, optional
`againstDrivingDirection`, and, for every nonfinal LRP, required
`distanceToNext` and `lowestFrcToNext`. Final LRPs must omit the last two
fields. Unknown/duplicate keys and non-finite/out-of-range values are rejected.
The client converts normalized TPEG bearings with `bearing * 360 / 256`;
the helper rotates the final LRP by 180°, exactly once.

The optional `corridor` is a strict object with `revision` (64 lowercase hex
characters), `toleranceMeters` (10–100), and `parts` (1–16 polylines of
`[longitude, latitude]`, at least two points each, at most 512 points total).
It is applied to clipped endpoint intervals and every traversed full interval
**inside path finding**, before an accepted/ambiguous decision. The check
samples each shape segment no more than 10 m apart with a conservative 6 m
margin inside the declared tolerance. A spatial corridor is evidence of road
proximity, not an independent certificate of direction, source truth or ETA.

Responses echo `requestId`, `decoderVersion=openlr-native-v2`,
`routingDataset`, `graphSha256` and `corridorRevision` (empty string when no
corridor was supplied), plus `status` and `expansions`. A `matched` response
also has `lengthMeters`, ordered `intervals` with exactly `edgeId`,
`beginFraction`, `endFraction`, `edgeLengthMeters`, and separate `fullEdgeIds`.
Uniqueness is compared using complete intervals; partial endpoint edges are
not discarded before deciding whether two paths differ.

The Python CLI requires `--helper`, `--graph-config`, `--routing-dataset`,
`--graph-sha256`, `--static-cache`, and `--output`; `--corridor-cache` is
optional for pure OpenLR candidate investigation, but required for a
TMC-constrained candidate audit intended to approach the promotion gates.
The private gzip static input is `{staticRevision, segments}`; segments use
the existing normalized TPEG `messageId`, `coordinates` and `openlr.points`
shape. Duplicate/missing reference IDs fail the batch.

The private gzip corridor input has exactly `contractVersion=sim-tmc-corridors-v1`,
`revision`, `tmcVersion`, `tmcSha256`, and `corridors`. `corridors` maps a
normalized reference ID to exactly `{toleranceMeters, parts}`. Its `revision`
must equal SHA256 of UTF-8 JSON for `{tmcVersion,tmcSha256,corridors}` using
sorted keys and separators `(',', ':')`; the client verifies it before use.
`tmcSha256` is the hash of the authorized table supplied by the verified
extraction pipeline: the client does not reopen that ZIP or prove licensing,
country/table membership or provenance. Those upstream checks remain required.
A missing corridor in this mode gives `missing_corridor`, not an unguarded
OpenLR fallback. Output/cache identity includes decoder version, dataset label,
exact graph SHA256, static revision and verified corridor revision; the latter
binds TMC version/hash and normalized geometry/tolerance.

The mode-0600 gzip audit has `contractVersion=sim-openlr-native-audit-v1`,
identities, disjoint `resultCounts`, `matchedIntervalReferenceCount`,
`wholeEdgeCandidateReferenceCount`, `collisionReferenceCount`, and
`approvedForLive=false`. `intervalCandidates` and `mapping` are private;
stdout omits both and never prints reference IDs or geometry. A `matched`
reference may have no whole-edge candidate. A partial claim from another
reference blocks a full-edge claim too; disjoint partial claims are also
conservatively rejected for runtime ownership. No last-write-wins or partial
live-speed semantics are introduced.

Before reading inputs or starting the helper, the client requires a separate
`*.json.gz` output outside `/run` and `/var/run`, including their resolved
symbolic-link variants. Resolved paths and existing filesystem identities
are checked against the static/corridor inputs, helper and graph configuration,
so direct, symbolic-link and hard-link aliases cannot replace them. Saving
the accepted private output still uses an atomic mode-0600 replacement.
This path preflight complements, rather than replaces, the required isolated
container and read-only graph/input mounts.

### Fail-closed v2 boundary

- Explicit road-hierarchy transitions on levels 0–2 are expanded. Reciprocal
  transition IDs, direction, bounds, unique level copies and coordinates within
  1 m are required; geographical proximity never invents an intersection.
  Their minimum graph ID is canonical only for node/cycle/merge checks. Actual
  directed edge IDs and fractions remain unchanged. All copies' node access
  is respected; native incoming local-edge indices/turn masks are retained
  across transitions, as in pinned Valhalla 3.8.3 native expansion. Shortcuts
  are excluded; missing/inconsistent transitions return `unsupported_hierarchy`.
  At most three copies and a bounded 32,768-entry cache limit memory. The
  complete directed/corridor test fixture now also runs with hierarchy enabled,
  and explicitly asserts a matched path spans at least two road levels.
  Complex/conditional access restrictions remain `unsupported_restriction`.
- FOW 0/5/7 and `againstDrivingDirection=true` have explicit unsupported
  results. Cyclic references and unsupported joins are not silently routed.
  The fixed adjacent-class FRC/LFRCNP interpretation is versioned candidate
  policy, still requiring calibration/acceptance on the real graph.
- Search uses 20 m candidate cutoff, 2 m node snap, 34° heading tolerance,
  at most 8 candidates per LRP, 64 pairs, 64 path edges and 50,000 expansions
  per LRP pair. Distance-to-next is 1–20,000 m with fixed tolerance
  `max(35 m, 10%)`. Exhaustion returns `search_limit`, never a unique guess.
  No geodesic pruning is used against quantized edge lengths: the tested
  rounding-boundary counterexample otherwise creates false uniqueness.
- The reader is extract-only: unhashed `tile_dir`, remote tile URLs and live
  traffic archives cannot supplement it. The operator-supplied dataset label
  is checked in the protocol; actual graph bytes are bound by SHA256 before
  and after the batch, plus size/mtime checks before each request. Client
  shutdown must confirm the final full-hash verification before audit save.
- Identity/version mismatch, malformed responses, protocol size
  limits, EOF and timeout abort safely. The client default request deadline is
  30 seconds and also bounds partial-line reads. Each helper starts in its own
  POSIX session/process group; protocol failure sends TERM only to that owned
  group, allows one second, then uses KILL if needed and reaps the direct child.
  A wrapper must keep subprocesses in this group and separately clean up only
  its own Docker container; detached sessions/containers are not implicitly
  owned by the client. There is no HTTP route,
  nearest-road or live-map fallback in this helper/client.

### Outstanding promotion work

The October 1 v2 batch and identical full replay are complete: 40,684
eligible references processed, 14,466 explicitly rejected during independent
corridor preparation, no sampling omissions from the 55,150-reference source.
Independent exact directed geometry review and conservative current-baseline
ownership review are also implemented as separate Python tools. Every baseline
edge ID is treated as an entire owned edge; any candidate interval touching it
is denied. Already active reference IDs are never replaced. Cross-candidate
claims are recomputed, including partial claims by rejected references.
The separately hashed direction verdict snapshot is bound to the native audit;
all generated artifacts are private and still `approvedForLive=false`.

The result is 427 disjoint canary candidates (2,870 whole directed edges),
not an accepted live-map selector. Independent review rejected 146 native
paths for bearing/order mismatch and deferred 70 nonzero-offset paths. These
rejections do not independently establish defects in the existing baseline:
the tested geometries were native candidate paths, not baseline paths.
See the [national v2 and timing evidence](../archive/audits/2026-10-01_VALHALLA_NATIVE_V2_AND_ADAPTIVE_TIMING.md)
for complete accounting and reproducibility.

Human geographic/carriageway adjudication of a stratified sample, unsupported
class calibration, same-flow route comparison and an explicitly approved
isolated canary remain outstanding. Missing baseline interval provenance that
could affect an addition remains a gate, never permission to assume it is free.
A successful native build, automated corridor/bearing check or fresh flow does
not establish ETA accuracy. Do not enable `TRAFFIC_OPENLR_ROUTE_FALLBACK`, copy
the private candidate map over a live cache or publish these counts as accuracy.

### October 1 same-flow pilot and first-wave selector

The isolated Python Actor pilot is now implemented and its 20:52 CEST run
passed: 13 forward routes across FRC 1–7 use new edges with unchanged route
shapes and changed durations; walking/bicycle and unaffected-route controls
are unchanged. Reverse paths can legitimately use added edges (for example
via a detour), so this experiment is not independent geographic adjudication.
The entire 427-reference cohort remains unapproved. A stronger 21:27 CEST
comparison binds each route to its own reference's directed edges: all 10
forward routes use their own target edges with identical shapes and changed
durations; all 10 reverse routes have zero target-edge use and unchanged times.
Walking/bicycle and unaffected controls remain unchanged. Only this second
proof is eligible for the first-wave selector, not the earlier neighbouring-edge
intersection evidence.

A separate opt-in live selector is implemented but **not yet installed or
enabled**. Operator geographic acceptance of the 10 target-evidenced references is a
mandatory prerequisite; an automated pilot cannot create that attestation.
Root creates a private acceptance manifest bound to the exact canary,
candidate, graph, static revision and immutable baseline. Only those tested
same-shape forward references can enter this first wave. All existing baseline
references and edge ownership remain untouched. Runtime reuse is keyed by the
selection fingerprint; graph/static rotation selects the ordinary baseline,
and same-graph corruption clears live speeds and fails closed. Explicit
rollback clears the archive and removes the selection pointer without serving
container restart. See the production runbook for the operator installation
and post-install live acceptance. Subsequent October 1 operator installation
and bounded live acceptance are now recorded in the production runbook/audit:
10 references / 67 edges selected, 28 new edges received actual fresh speeds,
SIM current-generation route passed, and physical speeds/ledger cleared after
natural expiration. The above pending state describes preparation before that
operator installation, not the current first-wave deployment. Remaining
candidates and independent ETA accuracy remain unapproved/unmeasured.

## Implementation sequence

1. **Offline core (v1 complete, bounded scope above):** keep the exploratory
   `openlr-graph-probe.cc` separate from the version-pinned decoder using native
   candidate search, graph access and vehicular turn validation
   APIs and explicit correlated request IDs. Return edge intervals and
   machine-readable rejection reasons. No `traffic.tar` writes.
2. **Independent fixtures (synthetic suite complete; real acceptance pending):** test two-way/one-way, parallel carriageways,
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
