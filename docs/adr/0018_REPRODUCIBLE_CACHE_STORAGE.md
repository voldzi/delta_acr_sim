# ADR 0018: Reproducible Cache Storage

## Status

Accepted

## Context

The production host `docker.home.cz` has a dedicated filesystem mounted at
`/srv/x5-production` that is intentionally excluded from PBS backups. SIM has a
local Copernicus GLO-30 cache as well as persistent provider data whose recovery
properties differ.

## Decision

Only data with an independent authoritative copy or a deterministic rebuild
path may use `/srv/x5-production`. The Copernicus GLO-30 runtime cache is stored
at `/srv/x5-production/cache/csm-sim/copernicus-glo30`: its authoritative copy
is in the dedicated SIM SeaweedFS bucket, its source COG files are public, and
its metadata and checksums are registered in PostGIS.

The Nginx provider response cache is stored at
`/srv/x5-production/cache/csm-sim/nginx-provider`. It is bounded, disposable,
and repopulated from the SIM provider APIs. The production operational-check
log is stored at `/srv/x5-production/cache/csm-sim/operational-checks`; it is a
derived diagnostic stream. Alert state and the latest structured report retain
their normal backed-up locations. High-frequency `/health/live` requests are
excluded from the Nginx access log, and the remaining web container log is
rotated at 10 MiB with three files retained.

The `sim_safety-data` Docker volume remains on backed-up storage. It contains
append-only CHMI hydrology observations accumulated over time; the upstream
detail backfill is limited and is not a complete recovery source.

Production deployment verifies filesystem UUID
`2f93f595-b61b-4eea-9054-7afa9b275b5b` before starting the stack. The DEM bind
mount disables automatic source-directory creation, so an absent mount cannot
silently start `situation-data-api` against an empty directory.
The Nginx cache bind uses the same protection for `sim-web`. The operational
check installer also validates the UUID before placing its log on X5.

During migration, the prior cache copy is retained for at least seven days and
is removed only with separate operator approval.

## Consequences

The backed-up system disk no longer carries the active DEM cache. Loss of the
cache disk temporarily prevents the affected service from starting instead of
silently degrading against an unintended path. Recovery consists of restoring
the mount or rebuilding the cache from SeaweedFS/public Copernicus data. Safety
history retains its existing backup and recovery properties.
