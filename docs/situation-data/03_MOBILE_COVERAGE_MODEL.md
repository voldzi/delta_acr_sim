# Mobile Coverage Model

## Purpose

SIM publishes `mobile_coverage` as a prepared diagnostic map layer for COM. COM displays and filters the layer only in technical/diagnostic contexts; it does not compute coverage, download DEM/terrain data, or query OSM directly.

The current implementation is phase 2+3 foundation: a terrain-aware estimate built from imported OpenStreetMap `communications_tower` references in `public.osm_poi`, local Copernicus DEM GLO-30 tiles and a line-of-sight obstruction penalty. Runtime API can also read prepared coverage cells from the PostGIS read-model table `public.mobile_coverage_cells`; if the table is not available or not populated for the requested area, SIM falls back to on-demand calculation.

`mobile_coverage` is a diagnostic layer, not the normal public mobile-network
assessment. It is nevertheless explicitly selectable for diagnostic COP views.
Every returned coverage cell carries `rendering.mode=feature`,
`rendering.geometryRole=grid_cell`, `styleHint=mobile-coverage-diagnostic-v1`,
`tags.renderAs=coverage_grid_cell` and `providerProperties.display.style` so COP
can render it without deriving colors or opacity from raw metrics.

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

Per-tower viewshed for an operator detail overlay:

```http
GET /situation-data/api/v1/mobile-coverage/towers/node:13743393126/viewshed?technology=4G&radiusM=12000&azimuthStepDeg=10&distanceStepM=500
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
  "sourceRevision": "model=coverage-v2-terrain|osmTable=public.osm_poi|dem=copernicus-glo30-cz|terrain=line-of-sight-v1|resolutionM=1000|antennaM=30",
  "readModel": true,
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

## Per-Tower Viewshed

The per-tower viewshed endpoint builds an on-demand GeoJSON overlay for a single
OSM `communications_tower` reference. It is intended for the COP detail workflow:
an operator clicks a BTS/tower point, COP requests one viewshed, then renders the
returned sectors as a temporary analysis overlay.

Response contract:

- `contractVersion=sim-mobile-coverage-tower-viewshed-v1`,
- `tower.towerId` is the OSM id in `node:<id>`, `way:<id>` or `relation:<id>` form,
- `query` echoes the normalized technology, radius, angular step and radial step,
- `query.includeNoSignal=false` by default; normal COP display receives only sectors with estimated reach (`good`, `fair`, `weak`),
- `includeNoSignal=true` returns the full diagnostic radial grid including `quality=none`,
- `summary.qualityCounts` counts returned sectors by `good`, `fair`, `weak`, `none`, `unknown`,
- `summary.computedQualityCounts`, `summary.computedSectorCount` and `summary.omittedNoSignalSectorCount`
  describe the complete calculation before default display filtering,
- each feature has `layer=mobile_coverage` and `category=mobile_coverage_viewshed`,
- each feature geometry is a radial sector polygon,
- each returned sector carries `providerProperties.display` with COP-ready style, opacity, label,
  line-of-sight status and render instructions,
- each feature carries `quality`, `estimatedSignalDbm`, `confidence`, `metrics.distanceM`, `metrics.bearingDeg`,
  `metrics.terrainPenaltyDb`, `metrics.terrainMaxObstructionM` and `metrics.lineOfSightClear` when DEM terrain sampling is available.

Default parameters:

- `technology=4G`,
- radius by technology: `2G=25000 m`, `4G=12000 m`, `5G=5000 m`,
- `azimuthStepDeg=10`,
- `distanceStepM=500`,
- `includeNoSignal=false`.

COP should render the returned sectors only. It must not draw omitted no-signal
sectors in normal operator mode; that would turn terrain-blocked viewsheds into
misleading circular targets. Diagnostic mode may call the same endpoint with
`includeNoSignal=true` and render `quality=none` using the low-opacity red style
from `providerProperties.display.style`.

SIM clamps unsafe parameters to keep the response bounded. The maximum returned
sector count is capped; if the cap is reached the response includes a warning.

The viewshed model is intentionally labelled as modelled data. It does not
represent confirmed BTS live status, an operator RF plan or a sector-aware
antenna model. Current assumptions are exposed in `properties.assumptions`:
`sectorAware=false`, `buildingAware=false`, `vegetationAware=false`,
`operatorRfPlanAvailable=false`, `btsRealtimeStatus=false`.

## Configuration

```env
SITUATION_DATA_ENABLED_SOURCES=open_meteo,aviation_weather,chmi_weather_stations,chmi_air_quality,osm_postgis,mobile_coverage_model,mobile_network_model,ctu_nettest,ctu_stationary_mobile,pid_gtfs_rt,road_srti_lod,safety_data
SITUATION_DATA_MOBILE_NETWORK_CACHE_TTL_SECONDS=3600
SITUATION_DATA_MOBILE_COVERAGE_CACHE_TTL_SECONDS=21600
MOBILE_COVERAGE_RESOLUTION_M=1000
MOBILE_COVERAGE_MAX_CELLS=1000
MOBILE_COVERAGE_MODEL_VERSION=coverage-v2-terrain
MOBILE_COVERAGE_DEM_SOURCE=copernicus-glo30-cz
MOBILE_COVERAGE_TERRAIN_AWARE=true
MOBILE_COVERAGE_DEFAULT_ANTENNA_HEIGHT_M=30
MOBILE_COVERAGE_READ_MODEL_ENABLED=true
MOBILE_COVERAGE_READ_MODEL_TABLE=public.mobile_coverage_cells
MOBILE_COVERAGE_READ_MODEL_MAX_AGE_SECONDS=604800
OSM_POSTGIS_BACKEND=patroni-postgis
OSM_POSTGIS_DATABASE_URL=postgresql://sim_osm:<strong-password>@haproxy.home.cz:5000/sim_osm
OSM_POSTGIS_TABLE=public.osm_poi
```

## Cache And Operations

- Aggregated responses use the standard `situation-data` cache and bbox canonicalization.
- The preferred production path is a prepared PostGIS read-model in `public.mobile_coverage_cells`. Runtime API first tries this table by bbox, technology, operator, model version and freshness.
- Read-model polygon responses are spatially distributed when the requested bbox contains more cells than the requested `limit`. SIM must not return the first N cells by internal id, because that produces misleading edge rectangles at low zoom. COP should treat limited grid responses as a viewport sample and request a tighter bbox or higher limit for detailed inspection.
- If the read-model misses, the coverage source falls back to source-level cached on-demand calculation keyed by canonical bbox, technology filter, operator filter, resolution and model version.
- When no technology filter is supplied, the provider defaults to `4G`, matching the public catalog default. Clients must explicitly request `2G` or `5G` when they want those diagnostics.
- Coverage cells are aligned to a deterministic resolution ladder (`250`, `500`, `1000`, `2000`, `5000`, `10000`, `25000`, `50000` m) instead of being generated from the current viewport origin.
- Default coverage TTL is 21600 seconds.
- Health reports `mobile_coverage_model` as degraded when PostGIS is not configured or no tower references exist.
- Health warns when the read-model table is unavailable or empty, but keeps the source usable through the on-demand fallback.
- If `MOBILE_COVERAGE_TERRAIN_AWARE=true`, the source samples Copernicus DEM GLO-30 from the local cache and applies a line-of-sight terrain obstruction penalty. If DEM tiles are unavailable for a requested area, the response warns and falls back to the distance model for that area.
- The per-tower viewshed endpoint is on-demand and should be requested only after a concrete BTS/tower click. It is not a replacement for the prepared `mobile_network` map layer.
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

Phase 3 foundation implemented:

- `public.mobile_coverage_cells` PostGIS read-model schema,
- API read path from prepared polygons,
- rebuild command `pnpm --filter @csm-sim/situation-data-api rebuild:mobile-coverage`,
- metadata columns for future BTS/operator status adjustment.

Phase 3 RF model:

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
curl -fsS 'http://localhost:5020/situation-data/api/v1/mobile-coverage/towers/node:13743393126/viewshed?technology=4G&radiusM=12000&azimuthStepDeg=10&distanceStepM=500'
curl -fsS http://localhost:5020/situation-data/health/ready
curl -fsS http://localhost:5020/situation-data/metrics | grep -E 'mobile_coverage|mobile_coverage_model'

docker compose run --rm situation-data-api pnpm --filter @csm-sim/situation-data-api rebuild:mobile-coverage
```
