# OSM/PostGIS Production Runbook

SIM source `osm_postgis` publishes OpenStreetMap reference features for COM through `situation-data`: civic/health/emergency points, communication towers, administrative boundaries, settlement boundaries, trail routes and trail POIs. The `mobile_coverage_model` source uses the same imported `communications_tower` references to publish estimated `mobile_coverage` polygons, and `mobile_network_model` combines that lower-level model with ČTÚ NetTest, ČTÚ stationary mobile measurements and infrastructure hints into the preferred citizen-facing `mobile_network` layer. Public Overpass must not be used as a production runtime backend.

## Preferred Backend: Patroni/PostGIS

Use the HA PostgreSQL/Patroni endpoint behind HAProxy:

```env
SITUATION_DATA_ENABLED_SOURCES=open_meteo,weather_forecast,aviation_weather,chmi_weather_stations,chmi_air_quality,osm_postgis,mobile_coverage_model,mobile_network_model,ctu_nettest,ctu_stationary_mobile,pid_gtfs_rt,public_transit_static,idsjmk_vehicle_positions,spravazeleznic_trains,road_srti_lod,safety_data
SITUATION_DATA_OSM_POSTGIS_CACHE_TTL_SECONDS=21600
SITUATION_DATA_MOBILE_NETWORK_CACHE_TTL_SECONDS=3600
SITUATION_DATA_MOBILE_COVERAGE_CACHE_TTL_SECONDS=21600
MOBILE_COVERAGE_RESOLUTION_M=1000
MOBILE_COVERAGE_MAX_CELLS=1000
MOBILE_COVERAGE_MODEL_VERSION=coverage-v1
MOBILE_COVERAGE_DEM_SOURCE=not-used-phase-1
MOBILE_COVERAGE_TERRAIN_AWARE=false
MOBILE_COVERAGE_DEFAULT_ANTENNA_HEIGHT_M=30
MOBILE_COVERAGE_READ_MODEL_ENABLED=true
MOBILE_COVERAGE_READ_MODEL_TABLE=public.mobile_coverage_cells
MOBILE_COVERAGE_READ_MODEL_MAX_AGE_SECONDS=604800
OSM_POSTGIS_BACKEND=patroni-postgis
OSM_POSTGIS_DATABASE_URL=postgresql://sim_osm:<strong-password>@haproxy.home.cz:5000/sim_osm
OSM_POSTGIS_TABLE=public.osm_poi
OSM_POSTGIS_ADMIN_BOUNDARY_TABLE=public.osm_admin_boundary
OSM_POSTGIS_TRAIL_ROUTES_TABLE=public.osm_trail_routes
OSM_POSTGIS_TRAIL_POI_TABLE=public.osm_trail_poi
SAFETY_DATA_ADMIN_BOUNDARY_DATABASE_URL=postgresql://sim_osm:<strong-password>@haproxy.home.cz:5000/sim_osm
SAFETY_DATA_ADMIN_BOUNDARY_TABLE=public.osm_admin_boundary
SAFETY_DATA_ADMIN_BOUNDARY_CACHE_TTL_SECONDS=86400
```

The `docker.home.cz` deployment script preserves existing `OSM_POSTGIS_*` and
`SAFETY_DATA_ADMIN_BOUNDARY_*` values from `/srv/sim/.env` unless the deploy
environment explicitly overrides them. This prevents a routine redeploy from
disconnecting SIM from the production OSM/PostGIS database.

Create a separate database and role. Do not store SIM OSM data in the COM/COP application database.

```sql
CREATE ROLE sim_osm LOGIN PASSWORD '<strong-password>';
CREATE DATABASE sim_osm OWNER sim_osm;
\connect sim_osm
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS hstore;
GRANT USAGE, CREATE ON SCHEMA public TO sim_osm;
```

Import or refresh the Czech OSM extract from `docker.home.cz`:

```bash
cd /srv/sim
export OSM_POSTGIS_DATABASE_URL='postgresql://sim_osm:<strong-password>@haproxy.home.cz:5000/sim_osm'
export OSM_POSTGIS_BACKEND=patroni-postgis
scripts/import-osm-cz-postgis.sh
docker compose up -d --build situation-data-api sim-web
```

The import script detects `haproxy.home.cz` as `patroni-postgis`, does not start the local `osm-postgis` container, runs `osm2pgsql` against the supplied URL, and builds these materialized read-model views in the same database:

- `public.osm_poi` for civic/health/emergency/mobile reference points,
- `public.osm_admin_boundary` for administrative and settlement boundaries,
- `public.osm_trail_routes` for hiking/walking/cycling/MTB route lines,
- `public.osm_trail_poi` for normalized outdoor/trail POIs.

## Acceptable Fallback: Local Rebuildable Cache

The local `osm-postgis` Docker service is acceptable only as a rebuildable OSM read-model/cache. It is not the production system of record.

Required conditions:

- strong `OSM_POSTGIS_PASSWORD` in `/srv/sim/.env`,
- explicit `OSM_POSTGIS_DATABASE_URL`,
- documented rebuild from Geofabrik PBF using `scripts/import-osm-cz-postgis.sh`,
- persistent volume backup, or clear declaration that the data is fully rebuildable,
- health/metrics monitored,
- no public Overpass in production runtime.

Example:

```env
SITUATION_DATA_ENABLED_SOURCES=open_meteo,weather_forecast,aviation_weather,chmi_weather_stations,chmi_air_quality,osm_postgis,mobile_coverage_model,mobile_network_model,ctu_nettest,ctu_stationary_mobile,pid_gtfs_rt,public_transit_static,idsjmk_vehicle_positions,spravazeleznic_trains,road_srti_lod,safety_data
SITUATION_DATA_OSM_POSTGIS_CACHE_TTL_SECONDS=21600
SITUATION_DATA_MOBILE_NETWORK_CACHE_TTL_SECONDS=3600
SITUATION_DATA_MOBILE_COVERAGE_CACHE_TTL_SECONDS=21600
OSM_POSTGIS_BACKEND=local-postgis
OSM_POSTGIS_DB=sim_osm
OSM_POSTGIS_USER=sim_osm
OSM_POSTGIS_PASSWORD=<strong-password>
OSM_POSTGIS_DATABASE_URL=postgresql://sim_osm:<strong-password>@osm-postgis:5432/sim_osm
OSM_POSTGIS_TABLE=public.osm_poi
OSM_POSTGIS_ADMIN_BOUNDARY_TABLE=public.osm_admin_boundary
OSM_POSTGIS_TRAIL_ROUTES_TABLE=public.osm_trail_routes
OSM_POSTGIS_TRAIL_POI_TABLE=public.osm_trail_poi
```

Rebuild:

```bash
cd /srv/sim
docker compose --profile osm up -d osm-postgis
scripts/import-osm-cz-postgis.sh
docker compose up -d --build situation-data-api sim-web
```

## Health And Metrics

Runtime health:

```bash
curl -fsS http://localhost:5020/situation-data/health/ready
```

Relevant fields:

- `sourceHealth[].sourceId=osm_postgis`
- `sourceHealth[].backend`
- `sourceHealth[].objectCount`
- `sourceHealth[].lastImportAt`
- `sourceHealth[].lastImportAgeSeconds`
- `sourceHealth[].boundaryFeatureCount`
- `sourceHealth[].trailRouteFeatureCount`
- `sourceHealth[].trailPoiFeatureCount`
- `sourceHealth[].trailLastImportAgeSeconds`
- `sourceHealth[].sourceId=mobile_coverage_model`
- `sourceHealth[].objectCount` for usable `communications_tower` references

Metrics:

```text
situation_data_osm_postgis_backend_info{backend="local-postgis|patroni-postgis"} 1
situation_data_osm_postgis_objects{backend="..."} <count>
situation_data_boundary_read_model_features{backend="..."} <count>
situation_data_osm_trail_route_features{backend="..."} <count>
situation_data_osm_trail_poi_features{backend="..."} <count>
situation_data_osm_postgis_last_import_timestamp_seconds{backend="..."} <unix_ts>
situation_data_osm_postgis_import_age_seconds{backend="..."} <seconds>
situation_data_osm_trail_last_import_timestamp_seconds{backend="..."} <unix_ts>
situation_data_osm_trail_import_age_seconds{backend="..."} <seconds>
situation_data_source_cache_hits{source="osm_postgis"} <count>
situation_data_source_cache_misses{source="osm_postgis"} <count>
situation_data_mobile_coverage_backend_info{backend="..."} 1
situation_data_mobile_coverage_towers{backend="..."} <count>
situation_data_source_cache_hits{source="mobile_coverage_model"} <count>
situation_data_source_cache_misses{source="mobile_coverage_model"} <count>
```

Production readiness check:

```bash
python3 scripts/smoke-production-data-plane.py --base-url http://localhost:5020 --cop-base-url http://localhost:4310
curl -fsS 'http://localhost:5020/situation-data/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=ground,mobile&source=osm_postgis&limit=20'
curl -fsS 'http://localhost:5020/situation-data/api/v1/features?bbox=12.0,48.5,19.0,51.2&layers=boundary_country,boundary_region,boundary_district&source=osm_postgis&limit=20'
curl -fsS 'http://localhost:5020/situation-data/api/v1/features?bbox=14.0,49.7,15.0,50.4&layers=trail_routes,trail_poi&source=osm_postgis&limit=20'
curl -fsS 'http://localhost:5020/situation-data/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=mobile_coverage&source=mobile_coverage_model&technology=4G&limit=20'
curl -fsS http://localhost:5020/situation-data/api/v1/mobile-coverage/metadata
curl -fsS 'http://localhost:5020/situation-data/api/v1/mobile-coverage/towers/node:13743393126/viewshed?technology=4G&radiusM=12000&azimuthStepDeg=10&distanceStepM=500'
curl -fsS http://localhost:5020/situation-data/metrics | grep -E 'osm_postgis|mobile_coverage|OSM'
```

`scripts/smoke-production-data-plane.py` is the deploy-safe gate for the
production OSM/PostGIS data plane. It checks SIM readiness, local OSM features,
OSM administrative boundaries, Safety Data administrative boundaries, mobile
coverage, and optionally the COP map catalog. Until the prepared mobile coverage
read-model is populated, it reports `mobile_network_model` absence as a warning;
use `--require-mobile-coverage-read-model` after the read-model rebuild is in
regular operation.

The mobile coverage read-model table includes compatibility columns parsed from
feature ids: `grid_resolution_m`, `grid_row` and `grid_column`, plus cached cell
bounds in `bbox_west`, `bbox_south`, `bbox_east` and `bbox_north`. SIM maintains
them automatically through `ensureReadModelSchema()` and uses
`mobile_coverage_cells_candidate_idx` and `mobile_coverage_cells_lookup_idx` for
low-zoom spatial sampling before it joins back to full polygon payloads. If an
older table is already populated, the first schema ensure backfills these columns
from ids like
`coverage:mobile:4g:m1000-r5399-c975` and from existing geometries; no full OSM
reimport is required. After this one-time backfill, run `vacuum analyze
public.mobile_coverage_cells;` on the PostGIS database so production queries can
use index-only scans instead of reading the wide geometry table.
