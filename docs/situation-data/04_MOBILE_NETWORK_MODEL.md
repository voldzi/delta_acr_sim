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
- `ctu_nettest`: public ČTÚ NetTest measurements inside the polygon,
- OSM infrastructure hints through the coverage model,
- model metadata and disclaimers.

Future inputs can be added without changing the COM layer name:

- official ČTÚ coverage polygons, if ingested as a licensed/public dataset,
- OpenCellID after token/license validation,
- partner/operator status feed,
- anonymized aggregate measurements from COM/iOS clients,
- terrain-aware DEM and line-of-sight scoring.

## API

Layer registry:

```http
GET /situation-data/api/v1/layers
```

Provider map catalog:

```http
GET /situation-data/api/v1/catalog
```

COM should use the provider catalog through its server-side map catalog pipeline. In that catalog, `public.mobile.network` is the user-facing layer, while `mobile_coverage_model`, `ctu_nettest` and OSM communication towers are marked as diagnostic/reference inputs.

Features:

```http
GET /situation-data/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=mobile_network&source=mobile_network_model&limit=250
```

Optional filters:

- `technology` or `technologies`: `2G`, `4G`, `5G`, comma-separated,
- `operator` or `operators`: currently `aggregate` and `unknown`,
- `limit`: default COM should use 250 for normal map views.

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
  "generatedAt": "2026-05-21T00:00:00.000Z",
  "resolutionM": 1000,
  "demSource": "copernicus-glo30-cz available; not applied by coverage-v1",
  "stale": false,
  "disclaimer": "Mobile network assessment is inferred from public/modelled data; it is not a confirmed BTS outage or guaranteed service availability."
}
```

## Configuration

```env
SITUATION_DATA_ENABLED_SOURCES=open_meteo,aviation_weather,osm_postgis,mobile_coverage_model,mobile_network_model,ctu_nettest,pid_gtfs_rt,safety_data
SITUATION_DATA_MOBILE_NETWORK_CACHE_TTL_SECONDS=3600
SITUATION_DATA_MOBILE_COVERAGE_CACHE_TTL_SECONDS=21600
SITUATION_DATA_OSM_POSTGIS_CACHE_TTL_SECONDS=21600
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
- The source-level cache is keyed by canonical bbox, technology filter, aggregate operator filter, resolution, max cells and model version.
- Default source TTL is 3600 seconds.
- External inputs are not queried per COM user when a cached area assessment exists.
- Health reports `mobile_network_model` as degraded when dependent model/input sources cannot produce an assessment.
- Health also reports `ctu_nettest` freshness and measurement count when that source is enabled.
- Metrics include `situation_data_mobile_network_towers`, `situation_data_mobile_network_backend_info`,
  `situation_data_ctu_nettest_measurements`, `situation_data_ctu_nettest_latest_measurement_age_seconds`
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
