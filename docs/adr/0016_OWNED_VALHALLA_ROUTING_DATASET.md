# ADR 0016: Owned Valhalla Routing Dataset

## Status

Accepted

## Context

SIM uses Valhalla for server-side routes, isochrones, nearest-access lookup and
elevation-aware navigation. The pilot runs Valhalla on the dedicated internal
host `valhalla.home.cz`. A Czech-only bootstrap dataset does not cover routes
that cross the national border, while independently refreshed country extracts
can contain different versions of the same OSM objects.

## Decision

SIM owns the Valhalla runtime configuration, dataset build, release metadata,
validation, rollback and operating runbook.

The build downloads complete Geofabrik extracts for CZ, DE, PL, SK, AT and HU.
It builds `admins.sqlite` from the deduplicated full inputs, then publishes only
the Czech Republic plus a 75 km metric buffer. Overlapping objects are merged as
history and collapsed to their newest version before spatial extraction.

Build, candidate and production use the same pinned Valhalla 3.8.2 multi-arch
image digest. A release is built outside production, receives complete elevation
coverage, and must pass hard-snap `route`, `locate`, `isochrone`, admin and
elevation checks for all six countries. Activation changes one atomic `current`
symlink. An interrupted or failed activation restores and validates the previous
release. Runtime containers invoke `valhalla_service` directly so the sealed
release can remain read-only. The weekly timer runs Sunday at 02:15
Europe/Prague with a randomized delay of at most 30 minutes.

Valhalla stays internal/VPN-only. SIM and COP backend adapters may call it;
browser or public clients may not.

## Consequences

The build is disk- and network-intensive, but production continues serving the
previous immutable release during download and compilation. Mixed Geofabrik
snapshot times are recorded and no longer make extraction fail. Release state,
source timestamps and checksums are inspectable on the host. At least the active
and previous releases must be retained.

## Alternatives Considered

- Czech-only data: rejected because it produces incomplete or false-snapped
  cross-border routes.
- Full neighboring countries in production: rejected because SIM only needs a
  bounded regional graph and the disk/build cost is materially higher.
- Mutable in-place tile replacement: rejected because partial moves are not a
  recoverable activation primitive.
- Unpinned `latest` images: rejected because tile compatibility and rollback
  would not be reproducible.

## Follow-up Actions

Operate the subsystem through
[15_VALHALLA_PRODUCTION.md](../runbooks/15_VALHALLA_PRODUCTION.md), keep the
cross-border matrix in CI/manual acceptance, and alert on a failed timer or a
last successful release older than eight days.
