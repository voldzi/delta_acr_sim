# Valhalla Production Runbook

## Scope and ownership

SIM owns `valhalla.home.cz`, its Docker runtime and its routing dataset. The
service is reachable only on the internal/VPN address
`http://valhalla.home.cz:8002`. `docker.home.cz` consumes it through
`situation-data-api`; COP clients call SIM routing endpoints, never Valhalla
directly.

The source set is CZ, DE, PL, SK, AT and HU. Full extracts are needed for a
complete administrative database. The routable graph is clipped to the Czech
Republic plus a 75 km buffer; it is not full-country coverage of all inputs.

## Host layout

```text
/srv/valhalla/
  current -> releases/<release-id>/custom_files
  releases/<release-id>/custom_files/
  state/{active,last-success,last-attempt,transaction}.env
  update-work/<release-id>/
  update-tools/
  traffic-cache/openlr-edge-map-*.json.gz
  docker-compose.yml
  .env
  .traffic.env
```

The active live-speed overlay is deliberately outside this persistent tree at
`/run/valhalla-traffic/traffic.tar`. It is memory-backed and restored from the
active release's `traffic-skeleton.tar` after boot. Normalized TPEG snapshots
are stored on the X5 cache disk of `docker.home.cz`; X5 is not mounted on this
host.

`current` is the only production pointer. Releases are immutable after their
`.complete` seal. A transaction file means activation was interrupted and must
be recovered before another build. The runtime bypasses the image's build
entrypoint and starts `valhalla_service` directly; this is required for the
read-only `current` mount. Successful runs remove their `update-work` directory
after activated-release validation; failed release artifacts follow
`PRESERVE_FAILED_BUILD`.

## Installation

From a checked-out SIM repository, review the diff and run:

```bash
cd deploy/valhalla
sudo ./install.sh
```

The installer adopts an existing `/srv/valhalla/custom_files` dataset as a
basic baseline using hard links, pins the Valhalla image, installs the updater
and systemd units, recreates the container from `current`, validates the Czech
baseline and enables recovery plus the weekly timer.

## Controlled first release

Build without touching production:

```bash
sudo systemctl stop valhalla-weekly-update.timer
sudo /srv/valhalla/update-tools/weekly-update.sh build
sudo /srv/valhalla/update-tools/weekly-update.sh status
```

The final log line prints the release ID. Activate it only after the candidate
matrix passes:

```bash
sudo /srv/valhalla/update-tools/weekly-update.sh activate <release-id>
sudo systemctl start valhalla-weekly-update.timer
```

The normal unattended path is:

```bash
sudo /srv/valhalla/update-tools/weekly-update.sh run
```

The Geofabrik `*-latest.osm.pbf` endpoint may return a dated generation in an
HTTP `Location` header. The updater accepts only the expected dated filename on
`download.geofabrik.de`, reconstructs its HTTPS URL, and downloads both the PBF
and its before/after MD5 over HTTPS. Never enable generic HTTP redirects to
work around a failed weekly build. For the 2026-09-27 failure, verify the
installed updater version, run `bash -n` on the replacement, install just
`weekly-update.sh`, then start the weekly service and monitor `last-attempt.env`
through download, build, activation and route health. A stale healthcheck does
not by itself mean the current routing process is unavailable.

## Adaptive TPEG2 live traffic

Deploy SIM first so `/srv/sim/.env` contains a generated
`VALHALLA_TRAFFIC_CONTROL_TOKEN` and the X5 cache directory has passed its UUID
guard. Then copy the current `deploy/valhalla` files to the Valhalla host and
run the traffic installer with the token supplied through a protected temporary
file or environment; never paste it into shell history:

```bash
sudo env SIM_TRAFFIC_CONTROL_TOKEN="$(sudo cat /run/secret-token-file)" \
  /home/voldzi/valhalla-owned-deploy/install-traffic.sh
```

The repository helper `scripts/setup-valhalla-codex-access.sh` automates the
protected transfer and installation when rerun after the SIM deployment.

The timer polls the authenticated SIM lease every minute. HTTP 204 is the normal
idle state. A road route activates a 15-minute sliding window; within that
window TPEG2 is refreshed no more than every 300 seconds. Initial graph mapping
can run for an extended period at low priority and is cached by routing dataset
and TPEG static revision.

Operational checks:

```bash
systemctl status valhalla-traffic-update.timer valhalla-traffic-update.service
journalctl -u valhalla-traffic-update.service -n 200 --no-pager
ls -lh /run/valhalla-traffic/traffic.tar
find /srv/valhalla/traffic-cache -maxdepth 1 -type f -name 'openlr-edge-map-*.json.gz' -ls
```

From `docker.home.cz`, use the protected internal status endpoint with the
server-side token. The response reports state, age, graph version, map coverage
and applied edge counts. Never expose this token or endpoint to COP browsers.

### TPEG2 map-matching quality gate

The updater's `openlr-trace-v2` mapping cache key includes the matcher version,
routing dataset and static TPEG2 revision. On the first active vehicle request
after installing this updater, expect one full graph mapping build; it may take
roughly 16 minutes. The previous cache remains untouched for rollback. Do not
interpret an idle traffic lease or the first build's delay as a base-routing
outage. After the build, inspect the `OpenLR mapping diagnostics` journal line:
`rejections` gives a disjoint count by first failed gate and `sourceByFrc` /
`matchedByFrc` give per-road-class coverage. The sum of matched and rejected
segments must equal the source segment count. No IDs, coordinates or raw feed
are logged. Compare accepted route samples and parallel-road negative cases
before changing any length, bearing or search-radius gate.

The production baseline observed on 25 September 2026 was 55,150 static
segments, 35,639 matched (64.62%), and 8,699 applied flows from 12,410
fresh/valid speed records. The static feed contained 3,092 segments with at
least one positive or negative offset and 13 with no usable reference
distance. These are not a complete explanation of the 19,511 unmatched
segments; reason-coded build diagnostics are required. The TMC table alone
does not supply a Valhalla edge path.

The first production `openlr-trace-v2` rebuild completed successfully on
26 September 2026 at 06:27 UTC. It preserved the 35,639 / 55,150 match count
(64.62%). The 19,511 disjoint rejections were: 14,567 Valhalla 4xx trace
responses, 1,306 first-bearing mismatches, 1,139 last-bearing mismatches,
1,197 length mismatches, and 1,302 unsupported offsets. After a fresh vehicle
request, the next timer run applied 9,939 current flows to 84,639 graph edges;
SIM reported `status=current` at 06:29 UTC. This proves the versioned rebuild
and adaptive speed path work, but does **not** raise the static match rate.
Investigate the 4xx trace responses with bounded, non-sensitive samples before
proposing an OpenLR resolver change; never weaken directional or length gates
solely to increase coverage.

On 26 September a read-only, deterministic 96-segment sample across all eight
OpenLR road classes returned 23 HTTP 400 responses, all with Valhalla internal
error code 444 (no matched path). In a larger 160-segment sample, all 42
`walk_or_snap` failures remained code 444 with `map_snap`; switching the trace
algorithm alone would not recover them. The updater now records the internal
Valhalla error code separately from HTTP status in aggregate diagnostics.
This change is diagnostic only and intentionally keeps the same matcher cache
version and acceptance gates. No new road speed is applied on this evidence.

A production OpenLR decoder must score candidate directed edges using LRP
position, bearing, functional road class (FRC) and form of way (FOW), then
reconstruct and validate a path against distance-to-next, lowest FRC and
offsets. TomTom's Apache-2.0 `openlr-dereferencer-python` demonstrates this
algorithm but requires a `MapReader` implementation for the target graph;
Valhalla does not supply that adapter. Build and evaluate such an adapter
offline against the current graph before enabling it in the live updater.
Acceptance must include manually reviewed parallel-road and wrong-direction
negative cases and no reduction in the currently accepted 35,639 segments.

The graph-directed single-edge audit is invoked with
`python3 /srv/valhalla/update-tools/traffic-update.py --audit-direct-matcher`
after installing the candidate updater. It reads only the active static feed
and validated baseline map, writes an isolated mode-0600
`openlr-direct-audit-*.json.gz` under the traffic cache, and does not touch
`traffic.tar` or SIM's traffic report. It covers only the maintainers' trivial
same-directed-edge path, not multi-edge OpenLR decoding. Review its disjoint
rejection counts and sampled parallel-road/direction cases before considering
live use. `TRAFFIC_OPENLR_ROUTE_FALLBACK=true` is refused by the live updater;
the HTTP route-candidate experiment is audit-only.
For an audit without production sudo or a feed token, use a temporary copy of
SIM's normalized `static-segments.json.gz` and the existing graph-matched
baseline map with `--static-cache-file`, `--baseline-file` and
`--audit-output-dir`. This mode still verifies the current routing dataset and
static revision, calls only Valhalla `/locate` and `/status`, and must run at a
bounded worker count. The temporary provider-data copy is removed afterward.

`deploy/valhalla/openlr-graph-probe.cc` and
`Dockerfile.openlr-graph-builder` are an isolated C++23 development probe
against Valhalla 3.8.3, not part of the production image or updater. The
`--audit-graph-matcher` command additionally requires `--graph-helper` and
`--graph-config` alongside offline static/baseline/output paths. It is
intentionally audit-only and runs in a disposable container with read-only
graph and traffic mounts. The early v1-v3 nationwide counts (5, 1, and 2
additions) are **invalid**: Valhalla's graph reader emitted a startup diagnostic
on the helper's stdout, causing the first JSON parse to fail and subsequent
responses to be paired with the wrong requests. The v4 protocol echoes a
monotonic request ID and rejects out-of-sequence answers; it passed two
consecutive identical-path checks and a 64-reference comparison before the
national audit. Never use a helper without correlated responses.

The corrected 26 September v4 audit evaluated all 19,511 baseline-unmatched
references and found 5,967 new disjoint mappings among 55,150 source segments:
potential combined static coverage 75.44%, versus the live baseline 64.62%.
It rejected 5,799 ambiguous paths, 3,419 with no traversable path, and 3,092
with unsupported offsets. Against the separate HTTP route-candidate audit,
3,753 segment identifiers occurred in both; 3,611 had identical directed-edge
sequences and the other 142 had a contiguous graph path contained in the HTTP
path after excluding partially covered endpoint edges. None of the shared
segments had divergent or disjoint edges. Another 2,214 v4 matches lack this
independent route-audit corroboration. These are **read-only audit results**,
not live traffic coverage or proof of ground-truth correctness.

The 26 September v5 audit added whole-edge OpenLR offset trimming. It kept
all 5,967 v4 mappings with identical directed-edge sequences and identified
1,316 additional offset-bearing references; potential combined static
coverage would be 77.83% (7,283 additions), but this is **not** a production
coverage figure. A deterministic, road-class-stratified independent recheck
of 47 new offset references against Valhalla's shortest route and edge walk
found 34 identical whole-edge sequences, eight different sequences sharing
some edges, four wholly disjoint sequences and one unavailable comparison.
Ten of the twelve disagreements have OpenLR form-of-way 3 and two have
form-of-way 4. Because a plausible graph path can put a live speed on the
wrong road, do not promote the v5 offset additions or enable the graph
matcher. Investigate endpoint/costing differences and require a reviewed
parallel-road/roundabout sample plus independent acceptance after each weekly
graph rebuild. The live `openlr-trace-v2` cache and timer are unchanged.

The v6 audit-only graph matcher fixes a further endpoint error: the last LRP
now uses its own FRC and FOW instead of the first LRP's classification. A full
read-only repeat over the same 55,150-segment source and active graph returned
7,275 disjoint additions (potential 77.81% combined static coverage), eight
fewer than v5. All 7,275 segments shared with v5 retained identical directed
edge sequences; no new segment was accepted. This is not independent
geographic acceptance. A fresh deterministic 47-offset sample compared with
Valhalla's shortest route had 31 identical whole-edge sequences, nine partial
overlaps, six disjoint results and one unavailable comparison. The sample
members changed when v6 rejected eight matches, so this is not a paired
before/after success rate. Fifteen disagreements remain: do not activate v6
or treat its potential coverage as real routing coverage. Production matching
remains v2.

The audit-only v7 additionally checks Valhalla's `round_about` and
`classification.link` flags when the OpenLR endpoint declares an ordinary
single carriageway, roundabout, motorway or slip road. The full 26 September
repeat on the same graph and 55,150 references found 7,472 additions beyond
the live baseline (potential 78.17% combined static coverage). Relative to v6,
7,234 shared references had identical directed-edge sequences, 238 appeared
only in v7, and 41 only in v6. Against the separate HTTP route audit, 3,656
shared references were identical and 144 were contiguous graph subpaths; this
is corroboration, not ground truth. A 47-reference offset recheck found 34
identical whole-edge sequences, nine partial overlaps and four disjoint
sequences. New matches can arise because endpoint filtering removes one of
several ambiguous paths; they are not verified traffic coverage. Keep v7
audit-only and the production v2 matcher unchanged until geographically
reviewed wrong-road, parallel-road, roundabout, direction and offset cases
pass. The authorized static feed has no full road polyline (see below); seek
an authoritative geometry/crosswalk from the provider or a separately
validated OpenLR decoder before activation.

#### Additional speed-data strategy (26 September 2026)

The [current TPEG2-TFP pilot](https://tpeg.dopravniinfo.cz/pilot/) is itself
republished from the ŘSD/NDIC DATEX II FCD predefined-location and live-flow
feeds. Taking the direct DATEX II copy
does not, by itself, create independent speed observations or resolve its
location references. The [pilot's public static XML sample](https://github.com/tamtamresearch/x-format_cz-ndic_tpeg2-tfp-v0.1/blob/main/samples/tpeg-tfp-pls.xml) carries TMC and
two-point OpenLR references; it does not demonstrate a full road polyline.
Before changing the parser, inspect an authorized full static feed for any
additional geometry and ask the operator whether an authoritative segment
polyline, direction, or map-edge crosswalk is available. Do not infer a road
path from the sample's two endpoints. A one-time, aggregate-only check of the
authorized full static feed on 26 September 2026 found 55,150 OpenLR methods,
55,150 TMC methods, **zero GLR methods and zero geometric line points** in
153,548,454 decompressed XML bytes. The feed and token were not logged or
stored by the audit. Thus this TPEG2 feed cannot itself provide a more detailed
road polyline; ask the operator about a separately authorized crosswalk or
geometry product. `scripts/audit-tpeg-static-geometry.py` checks a supplied
XML/XML.gz file offline, while `scripts/audit-tpeg-live-static-geometry.mjs`
requires `--one-shot` for an explicit authenticated check inside the SIM service and
prints only aggregate counts. The latter is not a scheduled poller.

Valhalla [supports a speed hierarchy](https://valhalla.github.io/valhalla/concepts/speeds/): live `traffic.tar`, predicted weekly
five-minute profiles, constrained/free-flow speeds, then base OSM speeds.
Therefore two complementary improvements are possible:

1. Complete a graph-aware OpenLR resolver with ranked FRC/FOW candidates,
   distance-only vehicular costing, turn/hierarchy handling, exact offset
   fractions, conflict resolution, and geographically reviewed acceptance.
   Map once per routing dataset and static revision; keep the current matched
   baseline and reject ambiguous roads.
2. Evaluate a licensed predicted-speed dataset for uncovered/time-future
   edges. Historical profiles are **not** live observations. If deriving them
   from collected TPEG snapshots, first verify the provider's rights for
   retention and derivative use, require enough observations by road class,
   day and five-minute interval, and report coverage/confidence separately.
   Never fill a missing current measurement with a stale value labelled live.

Commercial flow providers may offer wider or differently referenced coverage,
but their API access, cache rights, attribution, price, geographic coverage,
and whether derived speeds may be loaded into a self-hosted routing engine
must be verified before procurement or integration. A point-query API is not
automatically a lawful or economical nationwide feed. Do not mix providers on
one edge without a documented priority, freshness, direction and confidence
policy. Evaluate ETA against independent measured trips and compare route
changes, not merely the count of matched segments.

Full promotion still requires hierarchy-aware traversal, independent
wrong-road/parallel-road acceptance and the baseline ownership gate. The
earlier graph probe approximates some of these checks,
including conservative whole-edge offset trimming, but does not implement
them all. The separate bounded offline native v1 is implemented and tested
below; it is not a released nationwide mapping. Do not install or activate the
exploratory probe. Keep the approved live baseline `openlr-trace-v2` until those gates
pass and a fresh graph-specific audit is repeated after each weekly map build.
The implementation and acceptance contract for the graph-native decoder is
[ADR 0029](../adr/0029_GRAPH_NATIVE_OPENLR_TO_VALHALLA_EDGE_DECODER.md).

An isolated route-candidate prototype is now included in the updater, but is
**disabled by default** with `TRAFFIC_OPENLR_ROUTE_FALLBACK=false`. A bounded
240-segment read-only sample found 62 trace error-444 segments. Only nine
candidate routes survived strict length, both bearings, road-class, full-edge
and unique endpoint checks. This is evidence that the method can recover some
segments, not a national accuracy estimate. Do not enable the production flag
on this sample alone. After staging a tested updater and activating a vehicle
lease, run `sudo python3 /srv/valhalla/update-tools/traffic-update.py
--audit-route-fallback` on `valhalla.home.cz`. This reads the authenticated SIM
static feed and active graph, rechecks only baseline-unmatched segments, and
writes a separate `openlr-route-candidate-audit-*.json.gz` under
`/srv/valhalla/traffic-cache`. It does not alter the active mapping,
`traffic.tar`, SIM report or route service. Audit output reports additional
matches and rejection reasons without message IDs or coordinates. Review a
stratified set of candidate paths and counterexamples before any activation.
On 26 September 2026, the isolated full-dataset audit completed against
`sim-routing-2026-09-20-1789879440`: 5,917 candidate matches beyond the
35,639 trace-only matches among 55,150 source segments (potential coverage
75.35% versus 64.62%). The separate candidate artifact was 727 KiB; the
live flag remained off. An independent read-only recheck of 64 deterministic
stratified candidates found identical directed edge sequences and passed the
length, bearing and full-edge checks. Run the reusable checker with
`python3 deploy/valhalla/recheck-route-audit.py --audit-path <readable-audit.gz>`.
This establishes reproducibility, not ground-truth correctness on ambiguous
parallel roads. Check overlap with the baseline edge map and manually review
high-risk examples before considering activation.
The initial audit found 374 directed edges shared with the baseline. Excluding
all candidate segments that touch a baseline edge or another candidate leaves
5,614 conflict-free additions, or 74.80% combined coverage. The v2 candidate
matcher enforces this disjointness in code and uses a separate cache version.
The isolated v2 production audit completed on 26 September 2026 and confirmed
exactly 5,614 additions, rejecting 233 baseline-overlap and 70
candidate-overlap segments. In a valid TPEG snapshot generated at 15:35 UTC,
748 fresh flow records belonged to those conflict-free additions, compared
with 10,436 fresh flows matched by the baseline (a 7.17% relative flow gain
for that snapshot). This is mapping and availability evidence, not proof that
every alternative path is geographically correct. Review road geometry before
setting the feature flag; leave the flag off until that quality gate passes.
A subsequent 62-candidate stratified recheck found one case where Valhalla's
ordinary and shortest-distance auto routes chose different edge sequences,
even though the alternative length was plausible. The v3 candidate matcher
rejects such costing disagreements and has its own cache version. The v2
coverage figure must not be presented as v3 coverage until a v3 national audit
has completed.

On the 29 September pilot graph, run the v3 candidate audit without switching
the active updater or setting `TRAFFIC_OPENLR_ROUTE_FALLBACK=true`. The tested
v3 script is staged separately at
`/home/voldzi/valhalla-owned-deploy/traffic-update-shadow-v3-20260929.py`.
From the SIM checkout on the operator Mac, run
`bash scripts/start-valhalla-shadow-audit-20260929.sh --check` first and then
`bash scripts/start-valhalla-shadow-audit-20260929.sh --start`. The latter
opens a synthetic SIM vehicle lease, installs a root-owned shadow copy, and
starts a low-priority systemd audit; it requires the operator's server sudo
authentication. It does not modify the live timer, updater, traffic archive or
SIM traffic report. Inspect
`journalctl -u valhalla-openlr-route-audit-v3-20260929.service --no-pager`
and the resulting mode-0600
`/srv/valhalla/traffic-cache/openlr-route-candidate-audit-*.json.gz`.
Check dataset/static revision, candidate overlap rejection, deterministic
independent route rechecks and geographically reviewed wrong-road cases before
any isolated canary. A higher candidate count is not an ETA-accuracy result.

The 29 September v3 shadow audit completed on the new graph with 5,286
additional disjoint candidate references beyond 35,639 baseline matches,
or 74.21% **potential** static coverage. It rejected 14,225 of the 19,511
baseline-unmatched references. A deterministic FRC-stratified recheck of 62
candidate routes repeated the same directed-edge sequence for all 62. This
does not independently prove correct road identity or ETA accuracy.

An additional read-only geographic challenge on 29 September compared
FRC-stratified routes with the independently licensed TMC v11 WGS84 road
shapes. Run `python3 deploy/valhalla/audit-tmc-candidate-geography.py --zip
data/valhalla/tmc/LT_v11.zip --per-frc 8` from the SIM checkout. The script
reads the protected SIM static and candidate audits only into memory, checks
the exact graph/static revision and emits aggregate results only. A separate
historical-baseline-ID comparison cohort uses the same current graph and TMC shapes:
add `--audit-path
/home/voldzi/valhalla-owned-deploy/baseline-edge-map-20260926.json.gz
--historical-control`. Old edge IDs are never compared across graph releases.
In the candidate cohort, 39 of 62 paths diverged over 100 m from the TMC
road despite both ends aligning within 100 m; 3 stayed within 100 m, 18 had
no comparable TMC road and 2 had misaligned ends. In the historical baseline
ID control, the corresponding counts were 3 of 64 divergent, 37 within,
22 without comparable road and 2 misaligned ends. The maximum-distance
median was 322 m for comparable candidate paths versus 18 m for the control.
This is strong evidence of a systematic candidate-corridor problem, not a
manual adjudication of individual road direction; TMC road shapes may be
generalized and the two cohorts are not pair-matched. **Do not promote the
v3 candidate map or infer ETA improvement from its added coverage.** Investigate
the divergent FRC/road classes with independent graph geometry and manual
review before any further canary or live flag change. No private TMC geometry,
message ID or coordinate belongs in Git or logs.

The audit now also supports `--graph-shapes`, which reads the exact directed
edge shapes from the serving graph with Valhalla's `GraphUtils`, then checks
continuity, LRP ordering/bearings, endpoint snapping and TMC road proximity.
On the same 62-route sample it reproduced the 39/62 corridor divergences
without rerouting. A full read-only pass with `--graph-shapes --all-candidates
--private-output data/valhalla/tmc/graph-corridor-shadow-20260929.json.gz`
rechecked all 5,286 v3 candidates on the 29 September graph: 3,987 diverged
from their linked TMC road between aligned endpoints, 847 had no comparable
TMC road, 121 had misaligned TMC endpoints, 9 failed endpoint bearing, and
only 322 passed the automated geographic gate. The private mode-0600 output
is Git-ignored and **shadow-only**; it is neither independently adjudicated
nor approved for live traffic. The result rules out bulk promotion of v3.
The next implementation is a TMC-corridor-aware graph-native search that
finds the correct directed path rather than merely filtering incorrect
fastest-route candidates, followed by independent fixtures and map review.

An isolated first graph-native corridor probe now exists in
`deploy/valhalla/openlr-graph-probe.cc` (`--corridor-stream`) and
`decode-openlr-tmc-corridor.py`. It constrains every traversed directed edge
to the licensed TMC road geometry during search, reuses the existing bounded
OpenLR endpoint/offset checks, and independently reads the returned graph-edge
shapes. On a deterministic FRC-stratified 62-reference v3 sample from graph
`sim-routing-2026-09-29-1790679143`, it found **3 paths**, all 3 passing the
independent geometric check; 37 had no corridor path, 18 no comparable TMC
road, 3 a reference outside that road and 1 no valid endpoint. This is a
feasibility probe, **not** a released mapping or ETA improvement: it sampled
only previously proposed v3 references, does not prove uniqueness among
alternative directed paths or turn-cost equivalence, and lacks independent
manual road-direction adjudication. The ordinary traffic updater, timer and
Valhalla runtime were not changed; the test binary was placed only in the
container's temporary directory. Do not enable the route-fallback flag or
promote even these 3 paths. Next gate: deterministic ambiguity detection,
cross-version fixtures, adjudicated stratified precision and an isolated
same-flow route-time canary with rollback.

### Offline native candidate decoder v1 (1 October 2026)

The separate implementation now exists in
`deploy/valhalla/openlr-native-decoder.cc`, `openlr-native-core.h` and
`openlr-native-client.py`, with a pinned Valhalla 3.8.3 helper build definition
`Dockerfile.openlr-native-builder`. It uses native Loki correlation and
AutoCost access/turn checks plus bounded exhaustive directed-path search;
it is not an ordinary fastest-route query, the previous experimental probe,
or a complete hierarchy-aware A* decoder. This work did not install a new
mapping, restart the serving Valhalla, or change live traffic selection.

From the SIM checkout, with the prepared 3.8.3 builder image available:

```bash
bash scripts/test-valhalla-openlr-native.sh
```

An optional first argument selects another prepared builder image; the script
still verifies Valhalla 3.8.3. It mounts only source read-only, disables network,
limits the disposable container to 2 CPUs/2 GiB/128 processes and removes it
after testing. The initial full run passed 63 checks/test cases; strict
corridor-entry, owned-process lifecycle and output-path regressions raise the suite to **69**:
20 C++ core, 17 client test methods, 30 actual flat-graph cases and 2 actual hierarchy cases.
Synthetic OSM PBFs were really built into native Valhalla graphs. Tested cases
include wrong-way one-way roads, competing paths, same-edge/multiple LRPs,
offsets, LFRCNP, ramps/roundabouts, forbidden turns, node barriers, disconnected
overpasses, partial/full ownership, native byte-bearing round-trip, TMC-like
search corridors, blocked unhashed tile fallback, final graph mutation,
timeout child cleanup, owned-group SIGKILL escalation after SIGTERM grace and
bounded Darwin group-exit permission races.
Output-path regressions also protect inputs/helper/configuration against direct,
symbolic-link and hard-link aliases and reject resolved runtime paths.
No real licensed records are used by the fixture suite. Successful tests are
offline evidence, not real-road directional acceptance or ETA accuracy.

#### Private audit invocation

Run only in an isolated, resource-limited offline container with the chosen
immutable graph and private inputs mounted read-only and a separate protected
output directory. Do not mount a root filesystem or give the container live
traffic write access. For example, **inside that container**:

```bash
python3 /tools/openlr-native-client.py \
  --helper /usr/local/bin/openlr-native-decoder \
  --graph-config /graph/valhalla.json \
  --routing-dataset "$ROUTING_DATASET" \
  --graph-sha256 "$GRAPH_SHA256" \
  --static-cache /inputs/static-segments.json.gz \
  --corridor-cache /inputs/tmc-corridors.json.gz \
  --output /audit/native-candidate-audit.json.gz
```

The operator must supply the actual dataset label and SHA256 of the immutable
`mjolnir.tile_extract`, not copy a hash from an earlier graph. The decoder
disables unhashed tile-directory, remote-tile and live-traffic fallbacks,
checks graph identity before/after the batch and size/mtime before each request.
The client's successful close confirms final full-hash verification before
writing an audit. No provider token, API call or production sudo is needed by
this offline CLI once private authorized snapshots have been prepared.

The static gzip JSON is `{staticRevision, segments}` in SIM's normalized TPEG
shape, with ordered `coordinates`/`openlr.points` and unique `messageId`.
The strict native per-request protocol is specified in
[ADR 0029](../adr/0029_GRAPH_NATIVE_OPENLR_TO_VALHALLA_EDGE_DECODER.md#private-helper-and-audit-contracts).
It echoes a request ID, exact graph identity and corridor revision; byte
bearings are converted by the client, and the final 180° reversal occurs only
in the native decoder. Do not send a licensed ZIP or raw provider XML directly.

The corridor gzip JSON has exactly:

```json
{
  "contractVersion": "sim-tmc-corridors-v1",
  "revision": "<canonical payload SHA256>",
  "tmcVersion": "11.0",
  "tmcSha256": "<authorized TMC table SHA256>",
  "corridors": {
    "<normalized reference ID>": {
      "toleranceMeters": 30,
      "parts": [[[14.0, 50.0], [14.003, 50.0]]]
    }
  }
}
```

The coordinates/ID above are illustrative synthetic values. `revision` is
SHA256 of UTF-8 JSON `{tmcVersion,tmcSha256,corridors}` with sorted keys and
separators `(',', ':')`; the client verifies the hash. Each corridor allows
1–16 parts, at least two points per part, at most 512 points total, tolerance
10–100 m. The native search checks clipped/full edge intervals before path
selection, sampling at most every 10 m with a conservative 6 m inward margin.
Without a comparable corridor in this mode, the reference is rejected as
`missing_corridor`. Omitting `--corridor-cache` is permitted only for pure
OpenLR candidate investigation, never as a promotion fallback.

The extraction pipeline remains responsible for the table's real hash,
authorization, country/table/location membership, road linkage and provenance;
the client does not reopen the licensed ZIP or prove those facts. No automatic
licensed-table-to-corridor extraction/deployment is implied by this CLI.
Spatial agreement cannot certify road direction. TMC version/hash and derived
geometry/tolerance enter the verified cache identity.

#### Fail-closed output and remaining gates

The audit is mode-0600 gzip JSON, with aggregate counts/identities and private
`intervalCandidates`/`mapping`; stdout excludes both maps, IDs and geometry.
The client checks `--output` before reading inputs or starting its helper:
it must be a separate `*.json.gz`, outside `/run` and `/var/run` including
resolved symbolic-link variants, and must not alias the static/corridor inputs,
helper or graph configuration (resolved path or existing hard-link identity).
The accepted output is still saved atomically with mode 0600. Retain the
isolated container and read-only graph/input mounts; path checks are not a
replacement for that isolation.
Every artifact explicitly has **`approvedForLive=false`**. `matched` means a
candidate interval path, not a fresh flow or usable ETA. Full-edge candidates
are separate; a foreign partial claim blocks a full-edge claim too. Native v1
does not implement approved partial live-speed encoding or cross-baseline
ownership/selection.

V1 supports 2–16 LRPs and same-edge intervals on hierarchy levels 0–2.
Required hierarchy transitions, complex/conditional restrictions, FOW 0/5/7
and `againstDrivingDirection=true` fail explicitly rather than being guessed.
Search bounds are 20 m cutoff, 2 m node snap, 34° heading tolerance, 8
candidates per LRP, 64 pairs, 64 path edges and 50,000 expansions per pair;
DNP is 1–20,000 m with fixed `max(35 m, 10%)` tolerance. Exhaustion is
`search_limit`, not a unique result. The client rejects malformed/uncorrelated
responses and uses a 30-second deadline, including partial-line timeouts.
Each helper owns a new POSIX process group. Protocol failure sends TERM to that
group only, permits one second before KILL, and reaps the direct child. Wrappers
must not detach subprocesses into different sessions; a GNU `timeout` wrapper
should use `--foreground`. Docker cleanup remains the wrapper's responsibility
and must identify only its own container, not other services.
No HTTP route or nearest-road fallback is present.

Before any live selection, obtain a deterministic real immutable-graph shadow
batch, compare every candidate claim against the current graph-specific
approved baseline (including relevant partial provenance), and resolve missing
ownership evidence without assuming it is free. The existing accepted baseline
must not be reduced or overwritten. Then complete independent stratified map
and direction adjudication, same-flow route tests and separately approved canary
with rollback. The offline client does not perform these remaining steps.
Do not enable `TRAFFIC_OPENLR_ROUTE_FALLBACK`, replace a live cache with this
artifact or report its candidate count as traffic coverage/ETA accuracy.

#### Historical canary procedure (not native v1 activation)

The following canary procedure is retained for historical recovery and a
future independently validated decoder. **Do not run it for v3 while the
geographic promotion gate above fails.** For an explicitly approved
**pilot-only** route-time A/B check, the host has
insufficient free memory for a second simultaneous Valhalla instance. Use
`bash scripts/start-valhalla-traffic-canary-ab.sh --check`, then `--diagnose`
before `--start`
from the SIM checkout on the operator Mac. The start helper uploads a tested
one-shot unit and prompts for server sudo. The unit requires the exact audited
graph and matching SIM/live traffic revisions. It stops only the traffic timer
and ordinary Valhalla container, measures baseline routes, runs a temporary
network-isolated Valhalla container with a separate traffic archive and no
published port, measures the same routes, then restores the ordinary container
and timer. `ExecStopPost` repeats the rollback after interruption or timeout.
The ordinary `/run/valhalla-traffic/traffic.tar` is never rewritten by the
test. Its aggregate report is
`/srv/valhalla/state/traffic-canary-ab-20260929.json` (mode 0600); inspect
`journalctl -u valhalla-traffic-canary-ab.service --no-pager` and verify
ordinary Valhalla `/status` plus a SIM car route afterward. If recovery fails,
do not start another canary: inspect the unit and run the idempotent
`sudo /srv/valhalla/update-tools/traffic-canary-rollback.sh` before diagnosis.
This controlled pilot outage is not a production rollout and route-time
differences are not measured ETA accuracy against observed journeys.

The first two pilot attempts on 29 September stopped safely before the
service swap: no fresh flow matched the 5,286 candidate references, even
though the ordinary mapper applied 17,458 flows to its baseline map in one
snapshot. The `--diagnose` mode is read-only with respect to the serving
traffic archive, timer and Valhalla container. It prints aggregate counts
only: total live flow records, candidate-ID intersections, valid speeds and
fresh observations, plus invalid-speed, timestamp, future, stale and expired
reasons. Expired records are bucketed by elapsed time (up to five minutes,
up to 30 minutes, older) and counted separately if expiry predates the
observation. It never prints message IDs, coordinates, provider payloads or
credentials. If `candidateIdRecords=0`, another immediate live A/B run cannot
evaluate the new map; investigate whether the provider supplies dynamic
flows for those references. If IDs intersect but `candidateFreshRecords=0`,
investigate source timestamps, expiry or speed availability. No diagnostic
count is evidence of ETA accuracy, and this mode does not enable candidate
edges in the ordinary updater.

The first aggregate diagnosis after those attempts saw 22,220 dynamic flow
records. Exactly 1,135 matched candidate IDs and all 1,135 had valid speed
and observation timestamps, but all 1,135 had already passed `validUntil`;
none could be applied. This rules out an ID mismatch or missing speed as the
immediate reason for the aborted A/B check. Do not ignore `validUntil` to
force a comparison. Next determine, using aggregate-only expiry/observation
age statistics and a fresh provider snapshot, whether these are superseded
messages or a source timestamp/contract problem. Until that is resolved,
potential static coverage (74.21%) must not be represented as live-flow or
ETA coverage.

A second diagnosis saw 21,359 dynamic records, 1,049 candidate-ID matches,
1,049 valid speeds and observations, but again zero fresh candidates. All
1,049 had expired within the preceding five minutes, none before its own
observation. The serving baseline still applied 15,215 fresh flows in a
nearby snapshot and continued routing normally. The remaining question is
whether the candidate cohort has a systematically shorter validity window,
or SIM's permitted five-minute refresh phase repeatedly observes it just
after expiry. Do not shorten provider polling below the subscriber-agreed
cadence or extend expiry without independent source-contract evidence.

For a bounded temporal comparison run
`bash scripts/start-valhalla-traffic-cohort-monitor.sh --check` and then
`--start` from the SIM checkout. The second command requires operator sudo on
the Valhalla host. It opens one ordinary SIM vehicle-traffic lease and starts
a low-priority, 13-minute systemd job; it does **not** stop the traffic timer,
restart Valhalla, edit `traffic.tar`, alter provider polling configuration or
enable candidate edges. The job requests the authenticated internal SIM feed
every 30 seconds. SIM's existing five-minute dynamic cache continues to
govern upstream TPEG2 polls; do not shorten it without checking subscriber
terms. The job verifies the immutable graph, static revision and disjoint
candidate/baseline map before sampling. It stores only aggregate counts and
timestamp-age medians for each cohort at
`/srv/valhalla/state/traffic-cohort-monitor-20260929.json` (mode 0600).
It never stores or logs provider records, message IDs, coordinates or tokens.
Inspect `journalctl -u valhalla-traffic-cohort-monitor-20260929.service -n 30
--no-pager`; the protected report is read by the operator after completion.
`newDynamicRevision` distinguishes a changed data snapshot from repeated
reads of one cached snapshot. If candidate `freshCount` becomes positive only
just after a revision change, investigate the refresh phase and remaining
validity window; if it stays zero across at least two revision transitions,
investigate source validity semantics before any live A/B attempt. Even a
positive count does not establish correct road direction or ETA accuracy.

The 29 September monitor finished successfully after 13 minutes: 27 samples,
three dynamic-revision transitions, 20 samples with fresh candidate flows and
seven samples where **both** baseline and candidate cohorts had zero fresh
flows. The three observed zero windows lasted approximately 61, 64 and 101
seconds between sampled endpoints; their exact start/end are bounded by the
30-second sampling interval. Fresh candidate counts after refresh were 959,
1,007, 1,031 and 994. The ordinary Valhalla remained healthy, its timer
active and a car route returned HTTP 200. This proves a live-flow window for
some candidates, not accurate matching or better ETA. One ordinary updater
request received HTTP 502 during the third gap, then recovered at the next
revision. The active updater's revision-only fast path can retain old edge
values across an expiry boundary (a code-and-journal inference; no route-level
stale-speed usage was measured). An expiry-deadline correction is prepared in
the repository but is not installed until a controlled operator deployment.

For that controlled deployment, run
`bash scripts/install-valhalla-traffic-expiry-guard.sh --check` followed by
`--install` from the operator checkout. The latter requires server sudo,
stops only the updater timer while the current updater finishes, preserves
`traffic-update.py.before-expiry-20260929`, installs the reviewed script,
starts one active-lease update and restores the timer in an exit trap. It does
not restart the Valhalla container, alter the graph or enable candidate edge
mapping. If the first update fails, the helper restores the prior script and
starts the timer. Afterward inspect `last-applied.json` for a finite
`nextRecomputeAtEpoch`, verify an unchanged revision is re-evaluated at that
deadline, observe `appliedFlowCount=0` during a fully expired gap, and confirm
the following revision restores current speeds. Also verify `/status`, an
actual car route, SIM traffic status and the weekly/traffic timers. To roll
back manually, stop the traffic timer, reinstall that preserved backup over
`/srv/valhalla/update-tools/traffic-update.py`, and restart only the traffic
timer/service. Do not remove the backup during observation.

The [TFP static feed](https://tpeg.dopravniinfo.cz/technical/sources/tpeg2-pls-tfp)
uses [OpenLR and TMC location references](https://tpeg.dopravniinfo.cz/technical/formats/tpeg2-tfp),
not an already matched Valhalla edge path. The current mapper deliberately applies speeds only where
`trace_attributes` identifies graph edges. Do **not** lower the 50% coverage
quality gate or assign a shortest route between the reference points merely to
clear a `degraded` status: with sparse two-point references this can place a
speed on a parallel road or a long detour.

Production diagnosis on 25 September 2026: all but 13 of 55,150 parsed static
segments had both reference points inside the broad Czech operating bounding
box, so the low match rate is not explained by foreign segments. The active
report mapped 22,549 static segments (40.89%) and applied 10,511 of 21,902
available flow records to 138,717 graph edges. In a deterministic 51-segment
sample, 27 mapped directly; 24 failed predominantly with Valhalla error 444.
A candidate route fallback with strict length, lateral-distance and endpoint
checks mapped only 28/51. Relaxing those checks found routes ending more than
170 m from the source point or taking more than four times the direct distance.
That candidate was **not** deployed; the production mapper and cache remain
unchanged. Valhalla routing and weekly builds remain independent of this
traffic-quality issue.

The safe next input is an authoritative road path for each TFP location:
either a compatible OpenLR resolver using the full road-class, bearing and
offset reference against the active graph, or detailed predefined-location
geometry/road-based references from the upstream
[DATEX II FCD predefined-location catalogue](https://registr.dopravniinfo.cz/en/sources/cz-ndic_d2-pls-fcd-v1.1/).
The TPEG pilot documents the latter as a separate ŘSD/NDIC source with its own
subscription process. Obtain the source and usage rights before adding it.
On 29 September 2026, the ŘSD subscriber portal confirmed active subscription
`2C713396` to `TMC lokační tabulka v11.0`. The licensed ZIP was downloaded and
verified locally: SHA-256
`820b66b27f941e95aaa7817a12fbe5e643cbe3305987e312124e448bd2e2926d`.
Keep it out of Git and public artifacts; the local private copy belongs under
`data/valhalla/tmc/LT_v11.zip` (ignored by Git, mode 600). The table's own
metadata identifies `CID=11`, `TABCD=25`, version `11.0`. It contains 35,861
point, 252 segment and 8,778 road locations. The included technical document
defines positive and negative offset links and WGS84 point centres, but the
KML line geometries do not provide an authoritative directed Valhalla edge
sequence. No TMC-derived live-speed mapping is enabled.

Read-only comparison of the private ZIP with SIM's 29 September normalized
TPEG2 static cache (`staticRevision=10b52da1cef6b14e56c112ce1b78770cccaf6fd77ae96e2e1a01d719e1e01a08`)
found that all 55,150 source references resolve to a TMC **point** with the
expected country/table number. The distance from each point to the nearer
OpenLR endpoint had p50=7 m, p90=93 m, p99=1,564 m. This validates reference
identity, not full path or carriageway direction. Reproduce only aggregate
results, without saving or printing source records:

Against the revision-matched conservative baseline of 35,639 mapped segments,
the TMC-point-to-nearest-endpoint separation was p50/p90/p99 = 6/66/290 m
for mapped references, but 8/174/2,565 m for the remaining references. This
supports treating the table as an independent plausibility signal. It also
shows why merely snapping unmatched points to roads would be unsafe.

```bash
ssh -o BatchMode=yes docker.home.cz \
  'docker exec csm-sim-situation-data-api cat /valhalla-traffic-cache/static-segments.json.gz' | \
  python3 deploy/valhalla/audit-tmc-location-table.py \
    --zip data/valhalla/tmc/LT_v11.zip --static-cache -
```

For baseline comparison, add `--baseline-cache /path/to/a/private,
revision-matched/openlr-edge-map.json.gz`. The audit rejects a mismatched
static revision and emits counts and quantiles only.

The licensed table must never be embedded in the public API, repository,
container image or a traffic mapping cache exported to COP. Before any
TMC-assisted mapper is activated, demonstrate a unique directed graph path
for each new location using road identity, OpenLR bearings/length and TMC
direction/offset links; reject missing, ambiguous, parallel-carriageway and
large-displacement cases. Repeat independent graph and route-time audits on
both directions and varied road classes. Preserve the current conservative
OpenLR mapping as rollback and do not convert the 100% reference-identity
result into a claimed 100% speed coverage.
Acceptance requires a reviewed match sample across road classes and directions,
explicit rejection of ambiguous parallel roads and detours, matched-flow as
well as static-segment coverage, route-time comparisons on affected and
unaffected corridors, and a rollback to the current traffic cache. Until then
`degraded` is an accurate signal; the normal Valhalla speed hierarchy still
serves unmatched roads.

On 30 September 2026 the approved ŘSD DATEX II FCD predefined-location archive
was checked privately as `data/valhalla/fcd/PLSFCD.zip` (ignored by Git, mode
0600; SHA-256
`69c49522102d62cf9b32f1de79fd35d9159c3ec3f372f9038e68e34f12ff2b49`).
Its `pls_FCD_260601.xml` contains 55,141 linear locations with OpenLR and
Global Network 26.06 section references. Against SIM's active 55,150-segment
TPEG2 static revision, 54,788 PLS locations had a candidate sharing a primary
or secondary TMC point whose two OpenLR endpoints were both within 50 m;
the best candidate's maximum endpoint separation had p50=0.8 m and p99=20.5 m.
Only 12,292 had a unique candidate under that 50 m test. These are
identity/geometry checks, not a unique directed Valhalla edge path. The
[TPEG pilot source mapping](https://tpeg.dopravniinfo.cz/pilot/) confirms that
this DATEX II PLS source is republished as the TPEG2 static catalogue already
consumed by SIM. Its additional GN section IDs require the corresponding
versioned Global Network geometry and rights, or an independently validated
OpenLR decoder for the active Valhalla graph. Do not enable candidate speeds
from endpoint proximity alone.

The same live check exposed a separate availability limit. A road request
opened the normal 15-minute lease. At 08:33 UTC the updater applied 20,663
flows to 178,943 edges, but its next run at 08:34 found zero still-valid
mapped flows. A later 29,715-record snapshot had a median of only 178 seconds
until `validUntil` although SIM's configured provider refresh interval is
300 seconds. Preserve the provider expiry and subscriber polling cadence;
expired speeds must be cleared. The [pilot protocol](https://tpeg.dopravniinfo.cz/technical/protocol)
requires conditional requests and says the recommended cadence is provided at
onboarding. Check timestamp/cadence behavior with the source operator before
changing the interval. Between 08:19 and 08:24 UTC the SIM web gateway also
returned intermittent HTTP 502 because Docker DNS timed out resolving
`situation-data-api`; it recovered at 08:25. Check that gateway's DNS and logs
separately from provider freshness. Without an active vehicle lease and a
recently applied speed the public traffic state is `idle`; a newly activated
lease with only an old report is `warming`, while report counts and timestamps
remain historical diagnostics.

The SIM static-feed parser now retains OpenLR FRC, FOW, bearing, lowest FRC to
next point, distance-to-next and driving-direction metadata alongside the
reference coordinates for the internal traffic feed. A 25 September 2026
all-segment audit identified the main mismatch: the first OpenLR point uses
the absolute 24-bit coordinate scale; subsequent points use signed relative
1e-5-degree deltas. The previous parser used the absolute scale for both.
For 55,137 segments with a stated distance, median straight-line distance
divided by OpenLR distance was 2.086 before correction and 0.972 after it;
54,448 versus 957 segments respectively exceeded 120% of the stated road
distance. A deterministic 221-segment read-only Valhalla comparison matched
88 before and 160 after the coordinate correction, with no previously matched
segment lost; 139 also passed the new strict distance, bearing and offset
checks. This sample is diagnostic, not a national acceptance result.

The graph-specific matcher additionally checks traced length against OpenLR
distance-to-next and both encoded bearings against directed graph headings.
OpenLR bearing values are scaled by 360/256; the last bearing points back
toward the first LRP. Segments with nonzero positive or negative offsets are
rejected until exact sub-path trimming is implemented. The corrected
coordinates change `staticRevision`, so the graph mapping must be rebuilt in
a new cache file. Do not reuse the old cache. After deployment verify static
and active-flow coverage, inspect varied road classes and parallel roads,
compare car route times, and retain the previous mapping for rollback.

Production observation, 25 September 2026: the corrected SIM feed and matcher
were deployed together. The first full graph mapping covered 35,639 of 55,150
static segments (64.62%, versus 22,549 / 40.89% with the previous mapping),
and a subsequent active lease applied 9,817 fresh flows to 82,314 directed
edges. SIM readiness reported routing `ok` and traffic `current`; a Prague
vehicle route returned from Valhalla with `trafficAware=true` and live speeds
`current`. The mapping build took about 16 minutes, longer than the 15-minute
activity lease, so its first run only populated the mapping cache. A new
vehicle request and the next timer run applied the speeds in about 4.5 seconds.
The systemd timer remains enabled, and the updater exited successfully.
These checks establish initial production operation, not a proof of accuracy
on every corridor; ambiguous/unmatched roads retain normal Valhalla speeds.
The previous updater is retained as
`/srv/valhalla/update-tools/traffic-update.py.before-openlr-20260925` and the
previous cache is retained for rollback. Do not delete either during the
post-deployment observation period.

Traffic failure is not a base-routing failure. If the overlay is stale beyond
1,800 seconds, current speeds are cleared and Valhalla falls back to its normal
speed hierarchy. Disable only the enhancement with:

```bash
sudo systemctl disable --now valhalla-traffic-update.timer
```

Then set `VALHALLA_TRAFFIC_ENABLED=false` in SIM and recreate
`situation-data-api`. See
[ADR 0020](../adr/0020_ADAPTIVE_VALHALLA_LIVE_TRAFFIC.md) for the full design and
rollback rationale.

## Acceptance matrix

Every candidate and activated release must pass within the configured 8 second
request timeout:

| Coverage | Probe                                                    |
| -------- | -------------------------------------------------------- |
| CZ       | Prague route, locate, isochrone and elevation            |
| DE       | Cheb–Waldsassen route and Waldsassen locate/isochrone    |
| PL       | Ostrava–Katowice route and Katowice locate/isochrone     |
| SK       | Břeclav–Bratislava route and Bratislava locate/isochrone |
| AT       | Brno–Vienna route and Vienna locate/isochrone            |
| HU       | Břeclav–Rajka route and Rajka locate/isochrone           |

Locations use both `radius` and `search_cutoff=2500`. A response is rejected if
the decoded route endpoint or correlated locate edge exceeds that hard limit.
Routes must contain the expected ISO country administrations and finite graph
elevation samples. `admins.sqlite` must contain CZ, DE, PL, SK, AT and HU.

## Operations

```bash
systemctl status valhalla-weekly-update.timer
systemctl list-timers valhalla-weekly-update.timer
systemctl status valhalla-weekly-update.service
journalctl -u valhalla-weekly-update.service -n 200 --no-pager
/srv/valhalla/update-tools/weekly-update.sh status
docker compose -f /srv/valhalla/docker-compose.yml ps
curl -fsS http://valhalla.home.cz:8002/status
df -h /srv/valhalla
```

Alert when the timer/service fails, the API or canary route fails twice, disk
falls below the configured minimum, or `state/last-success.env` is older than
eight days. `tileset_last_modified` is diagnostic only; source timestamps and
checksums in `sources.manifest` are the release provenance.

## Failure and recovery

- A download/build/candidate failure leaves `current` unchanged.
- Activation failure atomically restores the previous pointer, recreates the
  container and validates the rollback target.
- On boot, `valhalla-update-recovery.service` resolves a surviving
  `state/transaction.env` before the next update.
- To recover manually, run `weekly-update.sh recover` and inspect the journal.
- If automatic recovery itself fails, stop the timer, point `current` at a
  known `.complete` release with an atomic symlink rename, recreate `valhalla`,
  and run its stored validation profile.

Do not delete the current or immediately previous release. Do not copy secrets,
raw partner data or public credentials into the repository. Geofabrik/OSM data
remains subject to ODbL attribution requirements.

## geo-routing-v1 dependency and rollback

`situation-data-api` reads `version` and `tileset_last_modified` from Valhalla
`/status`. The latter is returned as the geo-routing dataset version/build date
and appears in SIM readiness. Missing dataset metadata makes exact geo routing
fail closed with 503; the older compatibility route API is unchanged.

To contain only the new operation, remove `GEO_ROUTING_SERVICE_TOKENS` from the
SIM deployment and recreate `situation-data-api`. To roll back the operation,
restore the previous SIM image/commit; do not change the active Valhalla release
unless Valhalla canaries themselves fail. Technical idempotency snapshots under
the SIM data volume can remain in place during rollback.

## Traffic freshness release

The implementation in [ADR 0028](../adr/0028_TRAFFIC_FRESHNESS_AND_EXPIRY_BOUNDARY.md)
adds start-based independent TFP refresh, a local expiry guard, monotonic report
generations and absolute route-cache deadlines. Local verification is not live
acceptance. The established conservative map stays active; native decoder
candidate counts must not be reported as ETA accuracy.

Deploy the additive SIM situation-data-api contract first. Preserve unrelated
host changes and the current deployment branch. Verify the separately mounted
X5 UUID `2f93f595-b61b-4eea-9054-7afa9b275b5b` before recreating only that
service; do not use a stack-wide deployment or change `.env`, provider token,
API URLs, network or database. Keep the preceding image for rollback.

For the first deployment from a version without persisted provider quota,
build and test the image before stopping the old service. Verify the X5 mount
and UUID again, stop only `situation-data-api`, and confirm its container has
`State.Running=false`. Then, on `docker.home.cz` in `/srv/sim`:

```bash
docker compose run -T --rm --no-deps --entrypoint node situation-data-api \
  --input-type=module - < deploy/valhalla/seed-provider-request-timing.mjs
docker compose up -d --no-deps situation-data-api
```

Start the new service only after `gateSeeded=true`, UID matching the runtime
and mode `600` are verified. The helper rejects invalid/symlink metadata,
requires the existing separate `/valhalla-traffic-cache` mount, and reserves
at least 300 seconds for static, TFP and TEC without shortening longer gates.
Initial warming is expected. Do not delete the file to accelerate loading.
An old-version rollback must also wait until the reserved request deadline;
the old process cannot enforce this new metadata itself.

Then, from the SIM checkout on the Mac, run:

```bash
bash scripts/install-valhalla-traffic-reliability.sh --check
bash scripts/install-valhalla-traffic-reliability.sh --install
```

The installer uses the existing SSH identity and asks for the operator's sudo
authentication. It refuses a changed graph, active weekly build or canary.
It verifies Python and unit syntax, pauses only the traffic timer, waits for
an ongoing traffic update without killing it, and backs up maintenance files
under a root-only `update-tools/reliability-backup-*` directory. It patches
`traffic-update.py`, `weekly-update.sh` archive locking, the calendar timer and
`valhalla-traffic-expiry.service`. Valhalla is not restarted. Install failure
restores the previous maintenance files and timer state.

The final updater also rejects legacy/unbounded deadline metadata, marks
archive writes in progress before mutation, and clears all `.gph` speed records
in 64 KiB blocks without replacing the mmap inode. A reused degraded generation
requires an exact empty ledger and no usable positive flow in the entire feed;
mixed-expiry cohorts must be recalculated. With missing dataset identities,
only an exact local completed-clear proof is retained, never an invented SIM
acknowledgement. See ADR 0028 for its invalidation rules. The minute timer and
the provider's minimum cadence are unchanged by these optimizations.

Before a positive write, the updater sends a degraded zero generation to SIM
and verifies it through the existing internal status operation. HTTP 204 by
itself is not proof that SIM accepted the generation. Exact identity and zero
counts must match before the archive is touched; all network calls are outside
its lock. A timeout, mismatch or concurrent guard clear aborts the positive
update safely. The next ordinary minute timer may retry. Do not bypass the
gate by forcing a current report or writing the traffic archive manually.

### Live acceptance

The bounded verifier runs inside the situation service without copying its
control token or printing source records:

```bash
docker exec -i csm-sim-situation-data-api node --input-type=module - \
  < scripts/verify-valhalla-traffic-reliability.mjs
```

It checks localhost health, unauthenticated denial, a fixed synthetic Prague
car route, acknowledged generation/deadline/dataset and aggregate feed timing.
Exit 0 is one technical sample, exit 2 is an explicit transition (including
warming), and exit 1 is a failure. Every output has `fullAcceptance=false`:
three-cycle and expiry/idle evidence below remain separate requirements.

Use the finite aggregate observer to record consecutive active request starts
and natural idle without issuing further car routes:

```bash
docker exec -i csm-sim-situation-data-api node --input-type=module - \
  < scripts/observe-valhalla-traffic-reliability.mjs
```

It reads only localhost status/feed and the initialized timing-only quota
file. Active feed GET can invoke the normal gated provider/cache path; it
does not create a road lease or bypass the provider request floor. Idle feed
returns 204 before that path. The observer uses 30-second samples, a monotonic
20-minute budget, bounded HTTP/body/quota reads and a CLI watchdog. Three
captured starts at least 300 seconds apart and two idle checkpoints at least
60 seconds apart with unchanged quota are required. Missing quota entries,
invalid counts or provider failures cannot become successful evidence.
Other vehicle requests may extend the shared lease; the result then remains
explicitly incomplete rather than forcing idle. Exit 0 is this bounded
observation only, exit 2 is incomplete and exit 1 is failure. It does not
certify physical clearing, geographic matches or ETA accuracy.

Once the lease is naturally idle, verify non-road routing separately:

```bash
docker exec -i csm-sim-situation-data-api node --input-type=module - \
  < scripts/verify-valhalla-traffic-idle.mjs
```

This helper refuses a non-idle preflight without sending a route. It sends
only fixed synthetic walking/bicycle requests, never a car request, and
requires Valhalla responses, unchanged lease/user-request timestamps,
an empty idle feed and unchanged quota. Its monotonic whole-run budget and
CLI watchdog are 60 seconds, with at most 15 seconds per operation. Both
helpers sanitize output and need the already configured control token only
inside the container; do not copy or print it. Their synthetic tests include
clock regressions, time-budget failures and private-error redaction.

For an aggregate-only physical scan, run the inspector inside Valhalla:

```bash
docker exec -i valhalla python3 - < deploy/valhalla/inspect-traffic-archive.py
```

It uses the shared archive lock and counts only `.gph` speed records, excluding
TAR index metadata. No reference IDs, coordinates, raw provider records or
credentials are printed. A scan can briefly delay a write; use it for bounded
acceptance, not continuous polling. After expiry, require both zero nonzero
speed records and an empty ledger, plus a non-current SIM route/status sample.

1. Verify the updater hash and `true healthy` Valhalla state against the checked
   release. Run the established healthcheck and a finite car route. Record the
   active symlink and dataset before and after; they must not change.
2. Trigger one ordinary SIM road route to retain the vehicle lease. Observe
   three or more TFP cycles through authenticated internal feed/status and
   journals. Record request starts, response duration, last check, actual
   content change, HTTP status, source observation and usable-flow counts.
   Starts must remain at least 300 seconds apart, without accumulated download
   duration or one-minute poll drift. A TEC error must not discard fresh TFP.
3. Observe a generation with positive fresh flow/edge counts and an absolute
   `usableUntil`. After that deadline, the archive must contain no expired
   applied records, SIM status must not be current and cached live-derived
   travel times must not be returned. The one-second guard plus bounded local
   write/report latency is measured, not assumed to be a hard real-time SLA.
4. Let the lease expire; provider refresh stops, basic routing continues and
   traffic becomes idle/stale without fabricated timestamps. Confirm walking
   and bicycle requests do not extend it.
5. Inspect guard memory/CPU, disk and X5 timing-file permissions. The guard
   writes only memory-backed runtime state; cadence metadata and normalized SIM
   cache stay on X5. No licensed content, edge maps or tokens go in public logs.

`SITUATION_DATA_TPEG2_ALIGN_TO_LAST_MODIFIED` is opt-in, default false. The
revised policy re-anchors each valid generation and learns a bounded median
cadence from two or more consecutive unskipped Last-Modified changes, with a
15-second margin. It never shortens the configured/monotonic request floor,
changes expiry, or uses fetch time as measurement time. Bad/regressing/old
hints revert to start-based scheduling. The October 1 trace observed 303–304
second generations and stale responses after 300-second start drift. This
supports a monitored opt-in trial, not a continuous freshness guarantee.
Confirm three consecutive distinct generations, source observation/expiry,
request starts at least 300 seconds apart, positive application and local
expiry after enabling. Synthetic two-hour drift tests alone are not live
provider evidence. Roll back timing by setting the flag false and recreating
only situation-data-api, retaining its persisted quota gate on X5.
The [1 October acceptance record](../archive/audits/2026-10-01_VALHALLA_TRAFFIC_RELIABILITY_ACCEPTANCE.md)
separates installed-release, expiry, cadence and idle checks from observed
source freshness gaps. HTTP 200/304 does not guarantee usable flow records.

### Traffic rollback

Run the installed root-only
`/srv/valhalla/update-tools/rollback-traffic-reliability.sh` with the exact
backup path printed by the installer. It stops only traffic units, clears the
archive in place under the shared lock, and requires SIM acknowledgement of
the degraded generation before restoring the maintenance files. If that
acknowledgement fails, it retains the new expiry protection for retry. It
restores the previous timer/guard state recorded in the backup. Keep SIM's
deadline checks active. Do not recreate the Valhalla container, switch the
graph or delete map releases.

If the SIM service itself must be rolled back, first disable live traffic use
and clear the archive, then restore only the previous situation-data-api image.
Rolling SIM back while old current speeds are retained would reintroduce the
deadline gap. Retain the backup until joint freshness acceptance is complete.
