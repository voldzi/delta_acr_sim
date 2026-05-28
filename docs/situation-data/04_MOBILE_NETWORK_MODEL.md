# Mobile Network Model

## Purpose

SIM publishes `mobile_network` as the single preferred mobile-network layer for COM. COM should use this layer for citizen-facing map display and alerts instead of independently combining `mobile_coverage`, ČTÚ NetTest points and OSM infrastructure.

The layer is an inferred area assessment. It is not a confirmed real-time BTS outage feed and it must not be presented as guaranteed operator service availability.

## Source And Layer

- source: `mobile_network_model`
- layer: `mobile_network`
- geometry: `Polygon`
- category: `mobile_network`
- operators: `aggregate`, `unknown`
- technologies: `2G`, `4G`, `5G`, `mixed`, `unknown`
- quality levels: `good`, `fair`, `weak`, `none`, `unknown`
- status values: `ok`, `weak_signal`, `degraded_possible`, `outage_reported`, `unknown`

## Inputs

The current implementation combines:

- `mobile_coverage_model`: modelled polygon coverage from imported OSM `communications_tower` references,
- prepared PostGIS read-model cells from `public.mobile_coverage_cells` when available,
- `ctu_nettest`: public ČTÚ NetTest measurements inside the polygon,
- `ctu_stationary_mobile`: official ČTÚ stationary 2G/4G mobile signal measurements by operator, used as historical reference evidence,
- OSM infrastructure hints through the coverage model,
- model metadata and disclaimers.

Future inputs can be added without changing the COM layer name:

- official ČTÚ coverage polygons, if ingested as a licensed/public dataset,
- OpenCellID after token/license validation,
- partner/operator status feed,
- anonymized aggregate measurements from COM/iOS clients,
- terrain-aware DEM and line-of-sight scoring.
- authorized BTS/NOC status feed. When available, SIM should update or regenerate affected read-model cells and set `btsStatus`, `btsStatusSource`, `operatorStatusAvailable` and adjusted `quality/status`.

## API

Layer registry:

```http
GET /situation-data/api/v1/layers
```

Provider map catalog:

```http
GET /situation-data/api/v1/catalog
```

COM should use the provider catalog through its server-side map catalog pipeline. In that catalog, `public.mobile.network` is the user-facing layer, while `mobile_coverage_model`, `ctu_nettest`, `ctu_stationary_mobile` and OSM communication towers are marked as diagnostic/reference inputs.

The `reference.infrastructure.communications` layer contains OSM communication towers only as reference infrastructure. Features from that layer carry `btsStatus: "unknown"` and `operatorStatusAvailable: false`; COM must not color them as confirmed healthy BTS sites.

Features:

```http
GET /situation-data/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=mobile_network&source=mobile_network_model&limit=250
```

Optional filters:

- `technology` or `technologies`: `2G`, `4G`, `5G`, comma-separated,
- `operator` or `operators`: currently `aggregate` and `unknown`,
- `limit`: default COM should use 250 for normal map views.

If no technology filter is supplied, SIM defaults the final `mobile_network` layer to `4G`. This prevents the public layer from silently selecting the best-looking `2G` estimate when `2G`, `4G` and `5G` are all available as technical inputs.

Feature properties include:

```json
{
  "featureId": "network:mobile:4g:coverage-cell-id",
  "layer": "mobile_network",
  "category": "mobile_network",
  "label": "4G mobile network assessment",
  "sourceId": "mobile_network_model",
  "operator": "aggregate",
  "technology": "4G",
  "quality": "fair",
  "status": "ok",
  "dataQuality": "mixed",
  "btsStatus": "operator_feed_unavailable",
  "btsStatusSource": "none",
  "operatorStatusAvailable": false,
  "basis": [
    "CTU_NETTEST_MEASUREMENT",
    "INFERRED_COVERAGE",
    "OSM_INFRASTRUCTURE_HINT",
    "NO_OPERATOR_BTS_STATUS"
  ],
  "summary": "Mobilni sit: pouzitelne s omezenim. Zaver kombinuje odhad pokryti a verejna mereni.",
  "notices": [
    "Aktualni stav konkretni BTS neni verejne overen; nejde o potvrzeny vypadek operatora."
  ],
  "estimatedSignalDbm": -98,
  "confidence": 0.62,
  "modelVersion": "mobile-network-v1",
  "sourceRevision": "model=coverage-v2-terrain|osmTable=public.osm_poi|dem=copernicus-glo30-cz|terrain=line-of-sight-v1|resolutionM=1000|antennaM=30",
  "readModel": true,
  "generatedAt": "2026-05-21T00:00:00.000Z",
  "resolutionM": 1000,
  "demSource": "copernicus-glo30-cz available; not applied by coverage-v1",
  "stale": false,
  "disclaimer": "Mobile network assessment is inferred from public/modelled data; it is not a confirmed BTS outage or guaranteed service availability."
}
```

## Configuration

```env
SITUATION_DATA_ENABLED_SOURCES=open_meteo,aviation_weather,osm_postgis,mobile_coverage_model,mobile_network_model,ctu_nettest,ctu_stationary_mobile,pid_gtfs_rt,road_srti_lod,safety_data
SITUATION_DATA_MOBILE_NETWORK_CACHE_TTL_SECONDS=3600
SITUATION_DATA_MOBILE_COVERAGE_CACHE_TTL_SECONDS=21600
SITUATION_DATA_OSM_POSTGIS_CACHE_TTL_SECONDS=21600
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
- The source-level cache is keyed by canonical bbox, technology filter, aggregate operator filter, resolution, max cells and model version.
- The canonical bbox is applied only once inside the chained `mobile_network_model -> mobile_coverage_model` path.
- The underlying coverage grid uses a deterministic resolution ladder so nearby zoom levels do not shift cell origins unnecessarily.
- If prepared `mobile_coverage_cells` exist for the requested area, `mobile_network_model` builds on those polygons instead of triggering on-demand DEM/path-loss calculation.
- Default source TTL is 3600 seconds.
- External inputs are not queried per COM user when a cached area assessment exists.
- Health reports `mobile_network_model` as degraded when dependent model/input sources cannot produce an assessment.
- Health also reports `ctu_nettest` and `ctu_stationary_mobile` freshness and measurement counts when those sources are enabled.
- Metrics include `situation_data_mobile_network_towers`, `situation_data_mobile_network_backend_info`,
  `situation_data_ctu_nettest_measurements`, `situation_data_ctu_stationary_mobile_measurements`
  and per-source cache counters for `mobile_network_model`.

## COM Interpretation

COM should use:

- `quality` for the map color,
- `status` for warnings and user-facing risk states,
- `confidence` for opacity/detail priority,
- `basis` and `notices` to explain why the assessment is limited,
- `summary` as the short detail text.
- `dataQuality` to distinguish `modelled`, `observed`, `mixed` and `unknown` conclusions.
- `btsStatus` and `operatorStatusAvailable` to avoid presenting inferred signal quality as confirmed BTS state.

COM should not infer BTS outages from `weak` or `none`. `outage_reported` should only be treated as confirmed after SIM receives an authorized operator/partner status feed.

## Acceptance Checks

```bash
curl -fsS 'http://localhost:5020/situation-data/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=mobile_network&source=mobile_network_model&limit=20'
curl -fsS http://localhost:5020/situation-data/api/v1/catalog
curl -fsS http://localhost:5020/situation-data/health/ready
curl -fsS http://localhost:5020/situation-data/metrics | grep -E 'mobile_network|mobile_network_model'
```
