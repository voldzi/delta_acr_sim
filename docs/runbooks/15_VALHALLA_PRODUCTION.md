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
