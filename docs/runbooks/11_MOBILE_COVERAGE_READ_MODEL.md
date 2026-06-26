# Mobile Coverage Read Model

## Purpose

Production map rendering should not calculate terrain-aware mobile coverage for every user query. SIM therefore supports a PostGIS read-model table:

```sql
public.mobile_coverage_cells
```

The table stores prepared coverage polygons by model version, technology, operator, quality, confidence and metadata. Runtime API reads this table first and falls back to on-demand calculation only when a prepared cell is missing.

## Required Inputs

- `public.osm_poi` from the OSM/PostGIS import,
- `public.dem_tiles` and local Copernicus DEM GLO-30 files when terrain-aware mode is enabled,
- ČTÚ NetTest and ČTÚ stationary mobile measurements for the final `mobile_network` assessment,
- future authorized BTS/operator feed can update or invalidate affected cells.

## Environment

```env
MOBILE_COVERAGE_MODEL_VERSION=coverage-v2-terrain
MOBILE_COVERAGE_TERRAIN_AWARE=true
MOBILE_COVERAGE_DEM_SOURCE=copernicus-glo30-cz
MOBILE_COVERAGE_READ_MODEL_ENABLED=true
MOBILE_COVERAGE_READ_MODEL_TABLE=public.mobile_coverage_cells
MOBILE_COVERAGE_READ_MODEL_MAX_AGE_SECONDS=604800
MOBILE_COVERAGE_REBUILD_BBOX=11.8,48.5,19.2,51.2
MOBILE_COVERAGE_REBUILD_TECHNOLOGIES=4G
MOBILE_COVERAGE_REBUILD_TILE_DEGREES=0.25
```

## Rebuild

Run from `/srv/sim`:

```bash
scripts/rebuild-mobile-coverage-production.sh
```

The command creates or migrates the table, splits the bbox into smaller tiles,
writes prepared polygons, restarts `situation-data-api` and runs the production
data-plane smoke test with `--require-mobile-coverage-read-model`.

Prepared cells receive `expires_at` from `MOBILE_COVERAGE_READ_MODEL_MAX_AGE_SECONDS`
or the runtime coverage cache TTL, whichever is longer. This keeps the
read-model stable across normal provider cache expiry while still allowing
operators to enforce a maximum model age.

For a smaller pilot or recovery rebuild, override the bbox:

```bash
MOBILE_COVERAGE_REBUILD_BBOX=13.8,49.8,15.4,50.4 scripts/rebuild-mobile-coverage-production.sh
```

For manual low-level execution without restart or smoke:

```bash
docker compose run --rm situation-data-api pnpm --filter @csm-sim/situation-data-api rebuild:mobile-coverage
docker compose up -d --force-recreate situation-data-api
```

## Runtime Behavior

1. API receives `layers=mobile_coverage` or `mobile_network`.
2. `mobile_coverage_model` looks for fresh rows in `public.mobile_coverage_cells`.
3. If rows exist, features include `readModel=true` and `sourceRevision`.
4. If rows are missing, SIM uses the existing on-demand model and source-level cache.
5. `mobile_network_model` combines the coverage polygons with ČTÚ measurements and returns the single public layer `public.mobile.network`.

## BTS Status Future Hook

When a trusted BTS/NOC feed becomes available, do not expose raw BTS state directly as a public conclusion. Instead:

- update affected cells or rebuild affected tiles,
- set `btsStatus`, `btsStatusSource`, `operatorStatusAvailable`,
- adjust `quality`, `status`, `confidence` and `basis`,
- keep original model/source metadata in `sourceRevision` and `assumptions`.

## Checks

```bash
psql "$OSM_POSTGIS_DATABASE_URL" -c "select model_version, technology, count(*) from public.mobile_coverage_cells group by 1,2 order by 1,2;"
curl -fsS 'http://localhost:5020/situation-data/api/v1/features?bbox=13.95,50.55,14.08,50.65&layers=mobile_coverage&source=mobile_coverage_model&technology=4G&limit=3' | jq '.features[0].properties | {readModel, modelVersion, sourceRevision, quality, metrics}'
curl -fsS 'http://localhost:5020/situation-data/api/v1/features?bbox=13.95,50.55,14.08,50.65&layers=mobile_network&source=mobile_network_model&technology=4G&limit=3' | jq '.features[0].properties | {quality,status,dataQuality,basis,metrics}'
python3 scripts/smoke-production-data-plane.py --base-url http://localhost:5020 --require-mobile-coverage-read-model
```
