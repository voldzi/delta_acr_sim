# Valhalla production deployment

This directory owns the dedicated `valhalla.home.cz` runtime and weekly routing
dataset release workflow. The canonical operating procedure is
[`docs/runbooks/15_VALHALLA_PRODUCTION.md`](../../docs/runbooks/15_VALHALLA_PRODUCTION.md).

The updater downloads complete CZ, DE, PL, SK, AT and HU Geofabrik extracts,
records their timestamps and checksums, deduplicates overlapping OSM object
versions, builds the admin database from the full inputs, and clips the routing
graph to the Czech Republic plus 75 km. Elevation is completed for the buffered
bbox before graph construction. Each download resolves one concrete Geofabrik
mirror, fetches both its PBF and checksum from that same mirror, and accepts the
content only when it matches that checksum. The resolved mirror is recorded in
the source manifest because load-balanced nodes can temporarily advertise
different valid generations.

Graph build acceptance checks the materialized `.gph` tile count, then builds
the tar archive and starts the isolated candidate. `tile_manifest.json` is not
an output contract because Valhalla may remove that intermediate manifest during
its cleanup stage. After the activated release passes the same validation
matrix, the updater removes the successful run's transient response files from
`update-work`.

Install or update the host-owned files:

```bash
cd deploy/valhalla
sudo ./install.sh
```

Set `START_INITIAL_UPDATE=true` on the installer invocation to enqueue the first
fully validated build and activation through `valhalla-weekly-update.service`.
The active baseline remains in service until the candidate passes the complete
matrix.

Safe first-release workflow:

```bash
sudo systemctl stop valhalla-weekly-update.timer
sudo /srv/valhalla/update-tools/weekly-update.sh build
sudo /srv/valhalla/update-tools/weekly-update.sh activate <release-id>
sudo systemctl start valhalla-weekly-update.timer
```

Normal weekly execution uses `weekly-update.sh run`. Candidate validation covers
route, locate, isochrone, expected ISO administrations, hard endpoint snap and
elevation for all six source countries. Production changes only through the
atomic `/srv/valhalla/current` symlink; failed or interrupted activation restores
and validates the previous release.

Operational state is stored under `/srv/valhalla/state`. The timer runs every
Sunday at 02:15 Europe/Prague with up to 30 minutes randomized delay. At least
35 GB free disk is required by default.

## Adaptive live traffic

Road routing can use the internal SIM TPEG2 feed without keeping a permanent
decoder workload running. A road request opens a sliding 15-minute activity
lease in SIM. The host-local `valhalla-traffic-update.timer` polls the
authenticated internal feed once per minute, applies at most one new source
revision every five minutes and stops doing data work when the lease expires.
Walking and bicycle requests do not activate the lease.

Every weekly graph build creates a matching `traffic-skeleton.tar`. The active
copy is materialized under `/run/valhalla-traffic/traffic.tar`, so frequent
speed writes use volatile storage rather than the server's system disk. The
graph-to-TPEG mapping cache is keyed by both the routing release and the TPEG
static revision and is stored under `/srv/valhalla/traffic-cache`; it is rebuilt
only when one of those inputs changes. Normalized source snapshots are retained
by SIM on the X5 cache disk at
`/srv/x5-production/cache/csm-sim/valhalla-traffic`.

Install the adaptive overlay after SIM has been deployed and has generated
`VALHALLA_TRAFFIC_CONTROL_TOKEN`:

```bash
./scripts/setup-valhalla-codex-access.sh
```

The helper transfers the updated weekly builder as well as the runtime updater,
installs the token through a protected temporary file, validates a time-aware
road route, and enables the minute timer. The token is never printed. Runtime
status is available through `ssh valhalla-codex status`; detailed updater logs
through `ssh valhalla-codex logs`.

Disabling `VALHALLA_TRAFFIC_ENABLED` in SIM immediately prevents new leases.
Stopping `valhalla-traffic-update.timer`, removing the runtime traffic archive,
and recreating the Valhalla container restores static-speed routing. Full
design, failure semantics, storage classification, and rollback are recorded in
[`ADR 0020`](../../docs/adr/0020_ADAPTIVE_VALHALLA_LIVE_TRAFFIC.md).
