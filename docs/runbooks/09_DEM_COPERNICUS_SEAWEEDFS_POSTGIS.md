# DEM Copernicus GLO-30 With SeaweedFS And PostGIS

## Purpose

SIM stores DEM data in three layers:

- SeaweedFS S3-compatible object storage for authoritative GeoTIFF/COG files,
- local filesystem cache for fast runtime reads,
- PostGIS metadata catalog for spatial discovery, health and future coverage cache.

The initial dataset is Copernicus DEM GLO-30 Public, 2021 release, distributed as Cloud Optimized GeoTIFFs in AWS Open Data.

## Data Source

Copernicus DEM GLO-30 Public is available from AWS Open Data bucket `copernicus-dem-30m`. Tiles are COG files named:

```text
Copernicus_DSM_COG_10_N49_00_E014_00_DEM/Copernicus_DSM_COG_10_N49_00_E014_00_DEM.tif
```

Official references:

- [AWS Open Data registry: Copernicus DEM](https://registry.opendata.aws/copernicus-dem/)
- [Copernicus DEM bucket readme](https://copernicus-dem-30m.s3.amazonaws.com/readme.html)

## PostGIS Schema

The import creates:

- `public.dem_datasets`
- `public.dem_tiles`
- `public.mobile_coverage_cells`

Schema file:

```bash
deploy/dem/dem-schema.sql
```

`dem_tiles.geom` is a generated PostGIS polygon for bbox queries. DEM rasters are not stored inside PostgreSQL.

## Required Env

```env
DEM_ENABLED=true
DEM_BBOX=11.8,48.5,19.2,51.2
DEM_DATASET_ID=copernicus-glo30-cz
DEM_POSTGIS_DATABASE_URL=postgresql://sim_osm:<strong-password>@haproxy.home.cz:5000/sim_osm
DEM_LOCAL_CACHE_HOST_DIR=./data/dem-cache/copernicus-glo30
DEM_LOCAL_CACHE_DIR=/dem-cache/copernicus-glo30
DEM_SEAWEEDFS_ENABLED=true
DEM_SEAWEEDFS_S3_ENDPOINT=http://127.0.0.1:8333
DEM_SEAWEEDFS_BUCKET=sim-dem
DEM_SEAWEEDFS_PREFIX=copernicus-glo30/2021
DEM_SEAWEEDFS_ACCESS_KEY_ID=<secret>
DEM_SEAWEEDFS_SECRET_ACCESS_KEY=<secret>
```

For containers, `docker-compose.yml` mounts:

```text
${DEM_LOCAL_CACHE_HOST_DIR}:${DEM_LOCAL_CACHE_DIR}:ro
```

## Import

From `/srv/sim` on `docker.home.cz`:

```bash
scripts/import-dem-copernicus-glo30-cz.sh
```

The script:

1. computes the 1-degree tile list for `DEM_BBOX`,
2. downloads missing COG files from AWS Open Data into local cache,
3. uploads the same files to SeaweedFS S3,
4. creates PostGIS schema,
5. registers tile metadata, checksum, bbox, local path and object key.

For a small smoke import:

```bash
DEM_IMPORT_LIMIT=1 scripts/import-dem-copernicus-glo30-cz.sh
```

## Runtime Endpoints

DEM metadata:

```http
GET /situation-data/api/v1/dem/metadata
```

Health:

```http
GET /situation-data/health/ready
```

Metrics:

```text
situation_data_dem_health{dataset="copernicus-glo30-cz",source="copernicus-dem-glo30"} 1
situation_data_dem_tiles{dataset="copernicus-glo30-cz",source="copernicus-dem-glo30"} <count>
situation_data_dem_local_tiles{dataset="copernicus-glo30-cz",source="copernicus-dem-glo30"} <count>
situation_data_dem_object_store_tiles{dataset="copernicus-glo30-cz",source="copernicus-dem-glo30"} <count>
```

## Activation Sequence

1. Configure SeaweedFS credentials in `/srv/sim/.env`.
2. Run `scripts/import-dem-copernicus-glo30-cz.sh`.
3. Set `DEM_ENABLED=true`.
4. Keep `MOBILE_COVERAGE_TERRAIN_AWARE=false` until terrain sampling is implemented and verified.
5. Restart `situation-data-api` and `sim-web`.

```bash
docker compose up -d --build situation-data-api sim-web
curl -fsS http://localhost:5020/situation-data/api/v1/dem/metadata
curl -fsS http://localhost:5020/situation-data/metrics | grep dem_
```

## Notes

- DEM files are large. Do not commit them.
- SeaweedFS is the authoritative object store; local cache is rebuildable.
- PostGIS stores metadata and future coverage cells, not the DEM raster binaries.
- Copernicus DEM GLO-30 is a digital surface model; buildings and vegetation can influence heights. Treat it as terrain input for estimates, not an authoritative RF survey.
