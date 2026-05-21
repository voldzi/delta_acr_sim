# Mobile Coverage Model

## Purpose

SIM publishes `mobile_coverage` as a prepared map layer for COP. COP displays and filters the layer; it does not compute coverage, download DEM/terrain data, or query OSM directly.

The current implementation is phase 1: a conservative estimate built from imported OpenStreetMap `communications_tower` references in `public.osm_poi`. It is suitable for situational context and weak/no-coverage warnings, not for guaranteed operator service availability.

For production COP display, prefer the unified `mobile_network` layer from `mobile_network_model`. This document describes the lower-level coverage model that feeds that assessment and remains useful for diagnostics.

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
GET /situation-data/api/v1/cop/features?bbox=13.85,49.65,15.35,50.45&layers=mobile_coverage&source=mobile_coverage_model&technology=4G&limit=250
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
  "estimatedSignalDbm": -98,
  "confidence": 0.62,
  "modelVersion": "coverage-v1",
  "generatedAt": "2026-05-21T00:00:00.000Z",
  "resolutionM": 1000,
  "demSource": "not-used-phase-1",
  "assumptions": {
    "antennaHeightM": 30,
    "propagationModel": "distance-path-loss-lite",
    "terrainAware": false,
    "landCoverAware": false
  },
  "stale": false,
  "disclaimer": "Coverage is an estimate, not guaranteed service availability."
}
```

## Configuration

```env
SITUATION_DATA_ENABLED_SOURCES=open_meteo,aviation_weather,osm_postgis,mobile_coverage_model,mobile_network_model,ctu_nettest,pid_gtfs_rt,safety_data
SITUATION_DATA_MOBILE_NETWORK_CACHE_TTL_SECONDS=3600
SITUATION_DATA_MOBILE_COVERAGE_CACHE_TTL_SECONDS=21600
MOBILE_COVERAGE_RESOLUTION_M=1000
MOBILE_COVERAGE_MAX_CELLS=1000
MOBILE_COVERAGE_MODEL_VERSION=coverage-v1
MOBILE_COVERAGE_DEM_SOURCE=not-used-phase-1
MOBILE_COVERAGE_TERRAIN_AWARE=false
MOBILE_COVERAGE_DEFAULT_ANTENNA_HEIGHT_M=30
OSM_POSTGIS_BACKEND=patroni-postgis
OSM_POSTGIS_DATABASE_URL=postgresql://sim_osm:<strong-password>@haproxy.home.cz:5000/sim_osm
OSM_POSTGIS_TABLE=public.osm_poi
```

## Cache And Operations

- Aggregated responses use the standard `situation-data` cache and bbox canonicalization.
- The coverage source keeps a source-level cache keyed by canonical bbox, technology filter, operator filter, limit, resolution and model version.
- Default coverage TTL is 21600 seconds.
- Health reports `mobile_coverage_model` as degraded when PostGIS is not configured or no tower references exist.
- Metrics include `situation_data_mobile_coverage_towers` and per-source cache counters for `mobile_coverage_model`.

## Model Phases

Phase 1 implemented:

- OSM tower position,
- technology-specific default path-loss penalty,
- nearest-tower distance,
- grid polygons with normalized quality.

Phase 2:

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

- anonymized aggregate measurements from COP/iOS clients,
- calibration by area, technology and operator.

## Acceptance Checks

```bash
curl -fsS http://localhost:5020/situation-data/api/v1/mobile-coverage/metadata
curl -fsS 'http://localhost:5020/situation-data/api/v1/cop/features?bbox=13.85,49.65,15.35,50.45&layers=mobile_coverage&source=mobile_coverage_model&technology=4G&limit=20'
curl -fsS http://localhost:5020/situation-data/health/ready
curl -fsS http://localhost:5020/situation-data/metrics | grep -E 'mobile_coverage|mobile_coverage_model'
```
