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

### Live acceptance

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
