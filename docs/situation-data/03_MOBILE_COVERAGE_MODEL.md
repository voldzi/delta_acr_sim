# Mobile Coverage Model

## Purpose

SIM publishes `mobile_coverage` as a prepared diagnostic map layer for COM. COM displays and filters the layer only in technical/diagnostic contexts; it does not compute coverage, download DEM/terrain data, or query OSM directly.

The current implementation is phase 2: a terrain-aware estimate built from imported OpenStreetMap `communications_tower` references in `public.osm_poi`, local Copernicus DEM GLO-30 tiles and a line-of-sight obstruction penalty. It is suitable for situational context and weak/no-coverage warnings, not for guaranteed operator service availability.

For production COM display, prefer the unified `mobile_network` layer from `mobile_network_model`. This document describes the lower-level coverage model that feeds that assessment and remains useful for diagnostics.

## Source And Layer

- source: `mobile_coverage_model`
- layer: `mobile_coverage`
- geometry: `Polygon`
- categories: `mobile_coverage`
- technologies: `2G`, `4G`, `5G`
- operators: `unknown`
- quality levels: `good`, `fair`, `weak`, `none`, `unknown`

The source requires `OSM_POSTGIS_DATABASE_URL` and the imported OSM materialized view `public.osm_poi`.

## API

Layer registry:

```http
GET /situation-data/api/v1/layers
```

Features:

```http
GET /situation-data/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=mobile_coverage&source=mobile_coverage_model&technology=4G&limit=250
```

Metadata:

```http
GET /situation-data/api/v1/mobile-coverage/metadata
```

DEM catalog metadata:

```http
GET /situation-data/api/v1/dem/metadata
```

Feature properties include:

```json
{
  "featureId": "coverage:mobile:4g:0-0",
  "layer": "mobile_coverage",
  "category": "mobile_coverage",
  "label": "4G coverage estimate",
  "sourceId": "mobile_coverage_model",
  "operator": "unknown",
  "technology": "4G",
  "quality": "fair",
  "estimatedSignalDbm": -106,
  "confidence": 0.58,
  "modelVersion": "coverage-v2-terrain",
  "generatedAt": "2026-05-21T00:00:00.000Z",
  "resolutionM": 1000,
  "demSource": "copernicus-glo30-cz",
  "assumptions": {
    "antennaHeightM": 30,
    "receiverHeightM": 1.5,
    "propagationModel": "distance-path-loss-lite+terrain-los-v1",
    "terrainAware": true,
    "terrainDataAvailable": true,
    "terrainApplied": true,
    "demDatasetId": "copernicus-glo30-cz",
    "landCoverAware": false
  },
  "dataQuality": "modelled",
  "btsStatus": "operator_feed_unavailable",
  "operatorStatusAvailable": false,
  "stale": false,
  "disclaimer": "Coverage is an estimate, not guaranteed service availability."
}
```

## Configuration

```env
SITUATION_DATA_ENABLED_SOURCES=open_meteo,aviation_weather,osm_postgis,mobile_coverage_model,mobile_network_model,ctu_nettest,ctu_stationary_mobile,pid_gtfs_rt,safety_data
SITUATION_DATA_MOBILE_NETWORK_CACHE_TTL_SECONDS=3600
SITUATION_DATA_MOBILE_COVERAGE_CACHE_TTL_SECONDS=21600
MOBILE_COVERAGE_RESOLUTION_M=1000
MOBILE_COVERAGE_MAX_CELLS=1000
MOBILE_COVERAGE_MODEL_VERSION=coverage-v2-terrain
MOBILE_COVERAGE_DEM_SOURCE=copernicus-glo30-cz
MOBILE_COVERAGE_TERRAIN_AWARE=true
MOBILE_COVERAGE_DEFAULT_ANTENNA_HEIGHT_M=30
OSM_POSTGIS_BACKEND=patroni-postgis
OSM_POSTGIS_DATABASE_URL=postgresql://sim_osm:<strong-password>@haproxy.home.cz:5000/sim_osm
OSM_POSTGIS_TABLE=public.osm_poi
```

## Cache And Operations

- Aggregated responses use the standard `situation-data` cache and bbox canonicalization.
- The coverage source keeps a source-level cache keyed by canonical bbox, technology filter, operator filter, limit, resolution and model version.
- When no technology filter is supplied, the provider defaults to `4G`, matching the public catalog default. Clients must explicitly request `2G` or `5G` when they want those diagnostics.
- Coverage cells are aligned to a deterministic resolution ladder (`250`, `500`, `1000`, `2000`, `5000`, `10000`, `25000`, `50000` m) instead of being generated from the current viewport origin.
- Default coverage TTL is 21600 seconds.
- Health reports `mobile_coverage_model` as degraded when PostGIS is not configured or no tower references exist.
- If `MOBILE_COVERAGE_TERRAIN_AWARE=true`, the source samples Copernicus DEM GLO-30 from the local cache and applies a line-of-sight terrain obstruction penalty. If DEM tiles are unavailable for a requested area, the response warns and falls back to the distance model for that area.
- Metrics include `situation_data_mobile_coverage_towers` and per-source cache counters for `mobile_coverage_model`.

## Model Phases

Phase 1:

- OSM tower position,
- technology-specific default path-loss penalty,
- nearest-tower distance,
- grid polygons with normalized quality.

Phase 2 implemented:

- local DEM,
- Copernicus DEM GLO-30 imported through `scripts/import-dem-copernicus-glo30-cz.sh`,
- DEM COG files in SeaweedFS and local cache,
- DEM tile metadata in PostGIS,
- line-of-sight/viewshed,
- terrain obstruction confidence.

Phase 3:

- frequency band,
- sector azimuth,
- downtilt,
- EIRP,
- Hata/COST231/Longley-Rice style propagation model where inputs exist.

Phase 4:

- anonymized aggregate measurements from COM/iOS clients,
- calibration by area, technology and operator.

## Acceptance Checks

```bash
curl -fsS http://localhost:5020/situation-data/api/v1/mobile-coverage/metadata
curl -fsS 'http://localhost:5020/situation-data/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=mobile_coverage&source=mobile_coverage_model&technology=4G&limit=20'
curl -fsS http://localhost:5020/situation-data/health/ready
curl -fsS http://localhost:5020/situation-data/metrics | grep -E 'mobile_coverage|mobile_coverage_model'
```
