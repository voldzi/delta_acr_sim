# Valhalla production deployment

This directory owns the dedicated `valhalla.home.cz` runtime and weekly routing
dataset release workflow. The canonical operating procedure is
[`docs/runbooks/15_VALHALLA_PRODUCTION.md`](../../docs/runbooks/15_VALHALLA_PRODUCTION.md).

The updater downloads complete CZ, DE, PL, SK, AT and HU Geofabrik extracts,
records their timestamps and checksums, deduplicates overlapping OSM object
versions, builds the admin database from the full inputs, and clips the routing
graph to the Czech Republic plus 75 km. Elevation is completed for the buffered
bbox before graph construction. Each download is keyed by the checksum selected
before transfer and accepted only when its content matches that exact checksum.
A post-transfer checksum is diagnostic because Geofabrik load-balanced nodes
can temporarily advertise different valid generations.

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
