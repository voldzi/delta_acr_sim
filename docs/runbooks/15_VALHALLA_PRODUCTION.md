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
Acceptance requires a reviewed match sample across road classes and directions,
explicit rejection of ambiguous parallel roads and detours, matched-flow as
well as static-segment coverage, route-time comparisons on affected and
unaffected corridors, and a rollback to the current traffic cache. Until then
`degraded` is an accurate signal; the normal Valhalla speed hierarchy still
serves unmatched roads.

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
