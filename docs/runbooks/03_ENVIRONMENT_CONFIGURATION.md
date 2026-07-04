# Environment configuration

**Status:** Baseline dokumentace

## Proměnné

- `SIM_SOURCE_SYSTEM_ID`
- `SIM_ADAPTER_VERSION`
- `SIM_PUBLISHER_MODE`
- `MAIN_COP_BASE_URL`
- `MAIN_COP_BEARER_TOKEN`
- `COP_AUTH_MODE`
- `COP_TOKEN_SECRET_REF`
- `AI_PROVIDER_MODE`
- `EXTERNAL_AI_ALLOWED`
- `SIM_API_AUTH_REQUIRED`
- `SIM_API_ADMIN_TOKEN`
- `SIM_API_INTERNAL_TOKEN`
- `SIM_API_TOKENS`
- `SIM_API_CORS_ORIGINS`
- `SIM_API_RATE_LIMIT_WINDOW_MS`
- `SIM_API_RATE_LIMIT_MAX_REQUESTS`
- `SIM_OPERATIONS_PROVIDER_TIMEOUT_MS`
- `SIM_OPERATIONS_FLIGHT_DATA_BASE_URL`
- `SIM_OPERATIONS_SITUATION_DATA_BASE_URL`
- `SIM_OPERATIONS_SAFETY_DATA_BASE_URL`
- `SIM_OPERATIONS_TAK_GATEWAY_BASE_URL`
- `SIM_OPERATIONS_REPORT_FILE`
- `SIM_SCENARIO_MAX_BLOCKS`
- `SIM_SCENARIO_MAX_ACTIVE_OBJECTS`
- `SIM_SCENARIO_MAX_EVENTS_PER_SECOND`
- `MAX_OBJECTS`
- `MAX_DURATION_SECONDS`
- `FLIGHT_DATA_ENABLED_SOURCES`
- `FLIGHT_DATA_DEFAULT_LAT`
- `FLIGHT_DATA_DEFAULT_LON`
- `FLIGHT_DATA_DEFAULT_RADIUS_NM`
- `FLIGHT_DATA_CACHE_TTL_SECONDS`
- `FLIGHT_DATA_BBOX_CACHE_GRID_DEGREES`
- `FLIGHT_DATA_BBOX_CACHE_PADDING_DEGREES`
- `FLIGHT_DATA_STALE_IF_ERROR_SECONDS`
- `FLIGHT_DATA_CACHE_MAX_ENTRIES`
- `FLIGHT_DATA_STALE_AFTER_SECONDS`
- `ADSB_LOL_BASE_URL`
- `OPENSKY_BASE_URL`
- `OPENSKY_ACCESS_TOKEN`
- `OPENSKY_CLIENT_ID`
- `OPENSKY_CLIENT_SECRET`
- `LOCAL_ADSB_AIRCRAFT_JSON_URLS`
- `FLIGHT_ROUTE_ENRICHMENT_ENABLED`
- `FLIGHT_ROUTE_ROUTES_CSV_URL`
- `FLIGHT_ROUTE_AIRPORTS_CSV_URL`
- `FLIGHT_ROUTE_CACHE_TTL_SECONDS`
- `OURAIRPORTS_ENABLED`
- `OURAIRPORTS_AIRPORTS_CSV_URL`
- `OURAIRPORTS_COUNTRIES`
- `OURAIRPORTS_CACHE_TTL_SECONDS`
- `AIP_AIRSPACES_ENABLED`
- `AIP_AIRSPACES_SOURCE_URL`
- `AIP_AIRSPACES_CACHE_TTL_SECONDS`
- `UAS_GEOZONES_ENABLED`
- `UAS_GEOZONES_CATALOG_URL`
- `UAS_GEOZONES_LAYER_IDS`
- `UAS_GEOZONES_CACHE_TTL_SECONDS`
- `AIRSPACE_ACTIVATION_ENABLED`
- `AIRSPACE_ACTIVATION_BASE_URL`
- `AIRSPACE_ACTIVATION_CACHE_TTL_SECONDS`
- `FLIGHT_DATA_CORS_ORIGINS`
- `SITUATION_DATA_ENABLED_SOURCES`
- `SITUATION_DATA_DEFAULT_BBOX`
- `SITUATION_DATA_CACHE_TTL_SECONDS`
- `SITUATION_DATA_STALE_IF_ERROR_SECONDS`
- `SITUATION_DATA_CACHE_MAX_ENTRIES`
- `SITUATION_DATA_SHARED_CACHE_REDIS_URL`
- `SITUATION_DATA_SHARED_CACHE_KEY_PREFIX`
- `SITUATION_DATA_SHARED_CACHE_CONNECT_TIMEOUT_MS`
- `SITUATION_DATA_BBOX_CACHE_PADDING_DEGREES`
- `SITUATION_DATA_OPEN_METEO_CACHE_TTL_SECONDS`
- `SITUATION_DATA_OPEN_METEO_GRID_DEGREES`
- `SITUATION_DATA_OVERPASS_CACHE_TTL_SECONDS`
- `SITUATION_DATA_SAFETY_CACHE_TTL_SECONDS`
- `SITUATION_DATA_AVIATION_WEATHER_CACHE_TTL_SECONDS`
- `IDSJMK_VEHICLE_POSITIONS_URL`
- `SITUATION_DATA_IDSJMK_CACHE_TTL_SECONDS`
- `SPRAVAZELEZNIC_TRAIN_POSITIONS_URL`
- `SITUATION_DATA_SPRAVAZELEZNIC_TRAINS_CACHE_TTL_SECONDS`
- `ROAD_SRTI_LOD_SPARQL_URL`
- `SITUATION_DATA_ROAD_SRTI_CACHE_TTL_SECONDS`
- `SAFETY_DATA_ROAD_SRTI_CACHE_TTL_SECONDS`
- `ROAD_SRTI_LOD_MAX_RECORDS`
- `SITUATION_DATA_ARDOS_CACHE_TTL_SECONDS`
- `SITUATION_DATA_MOBILE_NETWORK_CACHE_TTL_SECONDS`
- `SITUATION_DATA_MOBILE_COVERAGE_CACHE_TTL_SECONDS`
- `SITUATION_DATA_RADIO_PLANNING_CACHE_TTL_SECONDS`
- `SITUATION_DATA_RADIO_PLANNING_CACHE_MAX_ENTRIES`
- `MOBILE_COVERAGE_RESOLUTION_M`
- `MOBILE_COVERAGE_MAX_CELLS`
- `MOBILE_COVERAGE_MODEL_VERSION`
- `MOBILE_COVERAGE_DEM_SOURCE`
- `MOBILE_COVERAGE_TERRAIN_AWARE`
- `MOBILE_COVERAGE_DEFAULT_ANTENNA_HEIGHT_M`
- `MOBILE_COVERAGE_READ_MODEL_ENABLED`
- `MOBILE_COVERAGE_READ_MODEL_TABLE`
- `MOBILE_COVERAGE_READ_MODEL_MAX_AGE_SECONDS`
- `DEM_ENABLED`
- `DEM_BBOX`
- `DEM_DATASET_ID`
- `DEM_POSTGIS_DATABASE_URL`
- `DEM_LOCAL_CACHE_HOST_DIR`
- `DEM_LOCAL_CACHE_DIR`
- `DEM_SEAWEEDFS_ENABLED`
- `DEM_SEAWEEDFS_S3_ENDPOINT`
- `DEM_SEAWEEDFS_BUCKET`
- `DEM_SEAWEEDFS_PREFIX`
- `DEM_SEAWEEDFS_ACCESS_KEY_ID`
- `DEM_SEAWEEDFS_SECRET_ACCESS_KEY`
- `SITUATION_DATA_STALE_AFTER_SECONDS`
- `SITUATION_DATA_REQUEST_TIMEOUT_MS`
- `OPEN_METEO_BASE_URL`
- `OVERPASS_BASE_URL`
- `OVERPASS_MAX_BBOX_DEGREES`
- `CTU_NETTEST_URL`
- `PID_GTFS_RT_VEHICLE_POSITIONS_URL`
- `PID_GTFS_STATIC_URL`
- `SITUATION_DATA_PID_GTFS_STATIC_CACHE_TTL_SECONDS`
- `PUBLIC_TRANSIT_STATIC_GTFS_FEEDS`
- `PUBLIC_TRANSIT_STATIC_GEOJSON_FEEDS`
- `SITUATION_DATA_PUBLIC_TRANSIT_STATIC_CACHE_TTL_SECONDS`
- `PUBLIC_TRANSIT_STATIC_MAX_STOPS`
- `SAFETY_DATA_BASE_URL`
- `AVIATION_WEATHER_BASE_URL`
- `SITUATION_DATA_CHMI_WEATHER_WEBCAMS_CACHE_TTL_SECONDS`
- `CHMI_WEATHER_WEBCAMS_MAP_URL`
- `CHMI_WEATHER_WEBCAMS_DATA_BASE_URL`
- `CHMI_WEATHER_WEBCAMS_PUBLIC_BASE_URL`
- `ARDOS_PARTNER_BASE_URL`
- `ARDOS_PARTNER_TOKEN`
- `SITUATION_DATA_CORS_ORIGINS`
- `SAFETY_DATA_ENABLED_SOURCES`
- `SAFETY_DATA_DEFAULT_BBOX`
- `SAFETY_DATA_CACHE_TTL_SECONDS`
- `SAFETY_DATA_STALE_IF_ERROR_SECONDS`
- `SAFETY_DATA_CACHE_MAX_ENTRIES`
- `SAFETY_DATA_STALE_AFTER_SECONDS`
- `SAFETY_DATA_REQUEST_TIMEOUT_MS`
- `CHMI_ALERTS_CAP_BASE_URL`
- `CHMI_ORP_CODELIST_URL`
- `CHMI_HYDRO_METADATA_URL`
- `CHMI_HYDRO_NOW_BASE_URL`
- `CHMI_HYDRO_RECENT_BASE_URL`
- `CHMI_HYDRO_MAX_STATIONS`
- `CHMI_HYDRO_STATION_CACHE_MAX_ENTRIES`
- `CHMI_HYDRO_CURRENT_SNAPSHOT_CACHE_TTL_SECONDS`
- `CHMI_HYDRO_DETAIL_DEFAULT_PAST_HOURS`
- `CHMI_HYDRO_DETAIL_FORECAST_HOURS`
- `CHMI_HYDRO_DETAIL_BACKFILL_DAYS`
- `SAFETY_DATA_CORS_ORIGINS`
- `TAK_GATEWAY_INGEST_TOKEN`
- `TAK_GATEWAY_READ_TOKEN`
- `TAK_GATEWAY_PUBLIC_READ`
- `TAK_GATEWAY_DEFAULT_BBOX`
- `TAK_GATEWAY_STALE_AFTER_SECONDS`
- `TAK_GATEWAY_RETENTION_SECONDS`
- `TAK_GATEWAY_MAX_EVENTS`
- `TAK_GATEWAY_EXPOSE_RAW`
- `TAK_GATEWAY_SOURCE_LABEL`
- `TAK_GATEWAY_CORS_ORIGINS`

## Pravidla

Secrets se nastavují přes secret reference. `.env` soubory s tajnými hodnotami nesmí být commitované.

## SIM API security

Produkční běh musí mít zapnuté auth. Doporučený režim je `SIM_API_AUTH_MODE=hybrid`: Keycloak je primární přihlášení a `SIM_API_ADMIN_TOKEN` zůstává jen nouzový fallback. `SIM_API_AUTH_MODE=oidc` povolí pouze Keycloak JWT. `SIM_API_TOKENS` může v token/hybrid režimu přidat jemnější statické role ve formátu:

```bash
SIM_API_AUTH_REQUIRED=true
SIM_API_AUTH_MODE=hybrid
SIM_API_ADMIN_TOKEN=<high-entropy-token>
SIM_API_TOKENS='viewer:<token>:SIM_VIEWER,operator:<token>:SIM_OPERATOR|SIM_VIEWER,ai:<token>:SIM_AI_USER|SIM_VIEWER'
SIM_OIDC_ISSUER=https://login.zeleznalady.cz/realms/cop
SIM_OIDC_CLIENT_ID=csm-sim-web
SIM_OIDC_ALLOWED_CLIENTS=csm-sim-web
VITE_SIM_AUTH_MODE=hybrid
VITE_SIM_OIDC_ISSUER=https://login.zeleznalady.cz/realms/cop
VITE_SIM_OIDC_CLIENT_ID=csm-sim-web
SIM_API_CORS_ORIGINS=
SIM_API_RATE_LIMIT_WINDOW_MS=60000
SIM_API_RATE_LIMIT_MAX_REQUESTS=300
SIM_SCENARIO_MAX_BLOCKS=24
SIM_SCENARIO_MAX_ACTIVE_OBJECTS=1000
SIM_SCENARIO_MAX_EVENTS_PER_SECOND=1000
FLIGHT_DATA_CORS_ORIGINS=
SITUATION_DATA_CORS_ORIGINS=
SAFETY_DATA_CORS_ORIGINS=
TAK_GATEWAY_CORS_ORIGINS=
```

## SIM Operations Summary

SIM web Overview používá `GET /api/v1/operations/summary` jako lehký
server-side souhrn. Výchozí Docker Compose hodnoty míří na interní názvy
provider kontejnerů:

```bash
SIM_OPERATIONS_PROVIDER_TIMEOUT_MS=5000
SIM_OPERATIONS_FLIGHT_DATA_BASE_URL=http://flight-data-api:4010
SIM_OPERATIONS_SITUATION_DATA_BASE_URL=http://situation-data-api:4020
SIM_OPERATIONS_SAFETY_DATA_BASE_URL=http://safety-data-api:4030
SIM_OPERATIONS_TAK_GATEWAY_BASE_URL=http://tak-gateway-api:4040
SIM_OPERATIONS_REPORT_FILE=/data/operational-checks/latest.json
```

`SIM_OPERATIONS_REPORT_FILE` je volitelný. Když soubor existuje, Overview
zobrazí poslední periodický operational check; když neexistuje, endpoint zůstává
funkční a jen tento signál vynechá. Timeout drž krátký, protože Overview nesmí
čekat na dlouhé externí upstreamy jednotlivých providerů.
Lokální `pnpm dev` bez `.env` používá `127.0.0.1:4010-4040`; Docker Compose
tyto hodnoty explicitně přepisuje na interní DNS názvy kontejnerů.

Detailní provider karty v SIM Operations Center používají chráněný
`GET /api/v1/operations/provider-details`. Prohlížeč operátora proto nevolá
interní `/flight-data`, `/situation-data`, `/safety-data` ani `/tak-gateway`
endpointy přímo; ty zůstávají server-to-server rozhraním pro COP a interní
reverse proxy.

TAK Gateway je v produkčním rollupu aktuálně vedená jako future modul. Její
diagnostika zůstává viditelná, ale `operations/summary` ji vrací s
`productionReadiness=false`, takže nedegraduje celkovou readiness SIM.

## SIM Operational SLO Checks

Periodický syntetický test `scripts/production-operational-check.py` čte tyto
hodnoty z `.env`:

```bash
SIM_OPERATIONAL_ALERT_WEBHOOK_URL=
SIM_OPERATIONAL_ALERT_ENVIRONMENT=docker-home
SIM_OPERATIONAL_BASE_URL=http://127.0.0.1:5020
SIM_OPERATIONAL_CHECK_INTERVAL_SECONDS=300
SIM_OPERATIONAL_SLO_AVAILABILITY_TARGET=0.995
SIM_OPERATIONAL_SLO_MAX_LIVE_LATENCY_MS=1000
SIM_OPERATIONAL_SLO_MAX_SUMMARY_LATENCY_MS=3000
SIM_OPERATIONAL_SLO_MAX_TOTAL_DURATION_MS=180000
SIM_OPERATIONAL_SLO_REQUIRE_OPERATIONS_OK=true
```

SLO kontrola selže, pokud veřejný `/health/live`, `operations/summary`,
produkční readiness služby nebo celková délka syntetického testu překročí
nastavené limity. Selhání se zapíše do
`data/operational-checks/latest.json` a Overview ho zobrazí jako provozní
alert.

## Flight Data API

Výchozí bezpečná konfigurace:

```bash
FLIGHT_DATA_ENABLED_SOURCES=mock
```

Live ADSB.lol pilot:

```bash
FLIGHT_DATA_ENABLED_SOURCES=adsb_lol
FLIGHT_DATA_DEFAULT_LAT=50.1008
FLIGHT_DATA_DEFAULT_LON=14.2632
FLIGHT_DATA_DEFAULT_RADIUS_NM=120
FLIGHT_DATA_CACHE_TTL_SECONDS=10
FLIGHT_DATA_BBOX_CACHE_GRID_DEGREES=0.1
FLIGHT_DATA_BBOX_CACHE_PADDING_DEGREES=0.08
FLIGHT_DATA_STALE_IF_ERROR_SECONDS=60
FLIGHT_DATA_CACHE_MAX_ENTRIES=512
FLIGHT_ROUTE_ENRICHMENT_ENABLED=true
FLIGHT_ROUTE_ROUTES_CSV_URL=https://vrs-standing-data.adsb.lol/routes.csv
FLIGHT_ROUTE_AIRPORTS_CSV_URL=https://vrs-standing-data.adsb.lol/airports.csv
FLIGHT_ROUTE_CACHE_TTL_SECONDS=86400
OURAIRPORTS_ENABLED=true
OURAIRPORTS_COUNTRIES=CZ,SK,AT,DE,PL,HU
OURAIRPORTS_CACHE_TTL_SECONDS=86400
AIP_AIRSPACES_ENABLED=true
AIP_AIRSPACES_SOURCE_URL=https://aim.rlp.cz/eaip/html/eAIP/LK-ENR-5.1-en-GB.html
AIP_AIRSPACES_CACHE_TTL_SECONDS=86400
UAS_GEOZONES_ENABLED=true
UAS_GEOZONES_CATALOG_URL=https://aim.rlp.cz/?lang=cz&p=uas-gz
UAS_GEOZONES_LAYER_IDS=LKR314A,LKR314B,LKR314C,LKR314D,LKR314E,LKR314F,LKR315A,LKR315B,LKR319,LKR320A
UAS_GEOZONES_CACHE_TTL_SECONDS=86400
AIRSPACE_ACTIVATION_ENABLED=true
AIRSPACE_ACTIVATION_BASE_URL=https://aup.rlp.cz/
AIRSPACE_ACTIVATION_CACHE_TTL_SECONDS=300
```

OpenSky používej pouze při doloženém oprávnění:

```bash
FLIGHT_DATA_ENABLED_SOURCES=opensky
OPENSKY_CLIENT_ID=...
OPENSKY_CLIENT_SECRET=...
```

Vlastní ADS-B přijímače readsb/dump1090:

```bash
FLIGHT_DATA_ENABLED_SOURCES=local_adsb,adsb_lol
LOCAL_ADSB_AIRCRAFT_JSON_URLS=http://receiver-1.home.cz/tar1090/data/aircraft.json,http://receiver-2.home.cz/readsb/data/aircraft.json
FLIGHT_DATA_CACHE_TTL_SECONDS=5
FLIGHT_DATA_STALE_IF_ERROR_SECONDS=60
FLIGHT_ROUTE_ENRICHMENT_ENABLED=true
FLIGHT_ROUTE_CACHE_TTL_SECONDS=86400
```

Autorizovaný partner ingest pro Remote ID, U-space nebo lokální radarové stopy:

```bash
FLIGHT_DATA_ENABLED_SOURCES=partner_air_tracks,adsb_lol
FLIGHT_DATA_PARTNER_INGEST_TOKEN=<high-entropy-partner-token>
FLIGHT_DATA_PARTNER_TRACK_TTL_SECONDS=90
FLIGHT_DATA_PARTNER_TRACK_MAX_RECORDS=20000
FLIGHT_DATA_PARTNER_TRACK_PRIORITY=95
```

Endpoint je `POST /flight-data/api/v1/ingest/air-tracks` a vyžaduje
`Authorization: Bearer <token>`. Bez `FLIGHT_DATA_PARTNER_INGEST_TOKEN` zůstává
ingest vypnutý a zdroj pouze hlásí diagnostický warning.

COP Sensor Node edge ingest:

```bash
FLIGHT_DATA_ENABLED_SOURCES=partner_air_tracks,adsb_lol
FLIGHT_DATA_PARTNER_INGEST_TOKEN=<high-entropy-partner-token>
FLIGHT_DATA_SENSOR_NODE_INGEST_TOKEN=<high-entropy-sensor-token>
FLIGHT_DATA_SENSOR_NODE_STATUS_TTL_SECONDS=900
FLIGHT_DATA_SENSOR_NODE_MAX_NODES=1000
```

Endpoint je `POST /flight-data/api/v1/ingest/sensor-observations` a přijímá
dávky `cop.sensor.batch.v1` s observacemi `adsb`, `remote_id`, `weather` a
`health`. Pokud `FLIGHT_DATA_SENSOR_NODE_INGEST_TOKEN` není nastaven, použije se
jako fallback `FLIGHT_DATA_PARTNER_INGEST_TOKEN`. Detailní kontrakt je v
[../integration/17_COP_SENSOR_NODE_CONTRACT.md](../integration/17_COP_SENSOR_NODE_CONTRACT.md).

TAK CoT export letových stop pro budoucí vlastní TAK server:

```bash
FLIGHT_DATA_TAK_COT_EXPORT_TOKEN=<high-entropy-cot-export-token>
FLIGHT_DATA_TAK_COT_EXPORT_STALE_SECONDS=180
```

Endpoint je `GET /flight-data/api/v1/cot/tracks` a vyžaduje
`Authorization: Bearer <token>`. Inbound směr z TAK do SIM řeší samostatně
`tak-gateway-api` přes `POST /tak-gateway/api/v1/cot/events`.

## Situation Data API

Výchozí bezpečná konfigurace:

```bash
SITUATION_DATA_ENABLED_SOURCES=mock
```

Pilot s reálnými open-data zdroji:

```bash
SITUATION_DATA_ENABLED_SOURCES=open_meteo,weather_forecast,aviation_weather,chmi_weather_stations,chmi_weather_radar,chmi_weather_webcams,chmi_air_quality,osm_postgis,mobile_coverage_model,mobile_network_model,ctu_nettest,ctu_stationary_mobile,pid_gtfs_rt,public_transit_static,idsjmk_vehicle_positions,spravazeleznic_trains,road_srti_lod,safety_data
SITUATION_DATA_DEFAULT_BBOX=13.85,49.65,15.35,50.45
SITUATION_DATA_CACHE_TTL_SECONDS=30
SITUATION_DATA_STALE_IF_ERROR_SECONDS=1800
SITUATION_DATA_CACHE_MAX_ENTRIES=10000
SITUATION_DATA_SHARED_CACHE_REDIS_URL=redis://situation-data-cache:6379/0
SITUATION_DATA_SHARED_CACHE_KEY_PREFIX=csm-sim:situation-data
SITUATION_DATA_SHARED_CACHE_CONNECT_TIMEOUT_MS=1000
SITUATION_DATA_BBOX_CACHE_PADDING_DEGREES=0.18
SITUATION_DATA_OPEN_METEO_CACHE_TTL_SECONDS=600
SITUATION_DATA_OPEN_METEO_GRID_DEGREES=0.05
SITUATION_DATA_OSM_POSTGIS_CACHE_TTL_SECONDS=21600
SITUATION_DATA_OVERPASS_CACHE_TTL_SECONDS=21600
SITUATION_DATA_SAFETY_CACHE_TTL_SECONDS=300
SITUATION_DATA_AVIATION_WEATHER_CACHE_TTL_SECONDS=600
SITUATION_DATA_CHMI_WEATHER_CACHE_TTL_SECONDS=600
SITUATION_DATA_CHMI_WEATHER_RADAR_CACHE_TTL_SECONDS=300
SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_HISTORY_HOURS=6
SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_MAX_COUNT=72
SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_STORE_ENABLED=false
SITUATION_DATA_CHMI_WEATHER_RADAR_FRAME_STORE_DIR=/data/weather-radar-frames
SITUATION_DATA_CHMI_WEATHER_RADAR_CLEAN_CROP_INSET_PIXELS=2
SITUATION_DATA_CHMI_WEATHER_WEBCAMS_CACHE_TTL_SECONDS=300
SITUATION_DATA_CHMI_AIR_QUALITY_CACHE_TTL_SECONDS=900
SITUATION_DATA_CHMI_WEATHER_MAX_STATIONS=600
CHMI_WEATHER_METADATA_BASE_URL=https://opendata.chmi.cz/meteorology/climate/now/metadata/
CHMI_WEATHER_DATA_BASE_URL=https://opendata.chmi.cz/meteorology/climate/now/data/
CHMI_WEATHER_RADAR_BASE_URL=https://opendata.chmi.cz/meteorology/weather/radar/composite/
CHMI_WEATHER_WEBCAMS_MAP_URL=https://data-provider.chmi.cz/api/kamery/data/map
CHMI_WEATHER_WEBCAMS_DATA_BASE_URL=https://data-provider.chmi.cz
CHMI_WEATHER_WEBCAMS_PUBLIC_BASE_URL=https://www.chmi.cz
CHMI_AIR_QUALITY_METADATA_URL=https://opendata.chmi.cz/air_quality/now/metadata/metadata.json
CHMI_AIR_QUALITY_DATA_URL=https://opendata.chmi.cz/air_quality/now/data/airquality_1h_avg_CZ.csv
IDSJMK_VEHICLE_POSITIONS_URL=https://gis.brno.cz/ags1/rest/services/Hosted/Kordis_26_polohy/FeatureServer/0/query?where=IsInactive%3D%27false%27&outFields=*&orderByFields=TimeUpdated%20DESC&f=geojson&resultRecordCount=10000
SITUATION_DATA_IDSJMK_CACHE_TTL_SECONDS=20
SPRAVAZELEZNIC_TRAIN_POSITIONS_URL=https://mapy.spravazeleznic.cz/serverside/request2.php?module=Layers%5COsVlaky&action=load2
SITUATION_DATA_SPRAVAZELEZNIC_TRAINS_CACHE_TTL_SECONDS=900
ROAD_SRTI_LOD_SPARQL_URL=https://lod.tamtamresearch.com/sparql/
SITUATION_DATA_ROAD_SRTI_CACHE_TTL_SECONDS=300
SAFETY_DATA_ROAD_SRTI_CACHE_TTL_SECONDS=300
ROAD_SRTI_LOD_MAX_RECORDS=1500
SITUATION_DATA_ARDOS_CACHE_TTL_SECONDS=15
SITUATION_DATA_MOBILE_NETWORK_CACHE_TTL_SECONDS=3600
SITUATION_DATA_MOBILE_COVERAGE_CACHE_TTL_SECONDS=21600
SITUATION_DATA_RADIO_PLANNING_CACHE_TTL_SECONDS=900
SITUATION_DATA_RADIO_PLANNING_CACHE_MAX_ENTRIES=512
MOBILE_COVERAGE_RESOLUTION_M=1000
MOBILE_COVERAGE_MAX_CELLS=1000
MOBILE_COVERAGE_MODEL_VERSION=coverage-v1
MOBILE_COVERAGE_DEM_SOURCE=not-used-phase-1
MOBILE_COVERAGE_TERRAIN_AWARE=false
MOBILE_COVERAGE_DEFAULT_ANTENNA_HEIGHT_M=30
MOBILE_COVERAGE_READ_MODEL_ENABLED=true
MOBILE_COVERAGE_READ_MODEL_TABLE=public.mobile_coverage_cells
MOBILE_COVERAGE_READ_MODEL_MAX_AGE_SECONDS=604800
DEM_ENABLED=false
DEM_BBOX=11.8,48.5,19.2,51.2
DEM_DATASET_ID=copernicus-glo30-cz
DEM_POSTGIS_DATABASE_URL=
DEM_LOCAL_CACHE_HOST_DIR=./data/dem-cache/copernicus-glo30
DEM_LOCAL_CACHE_DIR=/dem-cache/copernicus-glo30
DEM_SEAWEEDFS_ENABLED=false
DEM_SEAWEEDFS_S3_ENDPOINT=
DEM_SEAWEEDFS_BUCKET=sim-dem
DEM_SEAWEEDFS_PREFIX=copernicus-glo30/2021
DEM_SEAWEEDFS_ACCESS_KEY_ID=
DEM_SEAWEEDFS_SECRET_ACCESS_KEY=
SITUATION_DATA_STALE_AFTER_SECONDS=900
SITUATION_DATA_REQUEST_TIMEOUT_MS=8000
OPEN_METEO_BASE_URL=https://api.open-meteo.com
MET_NORWAY_BASE_URL=https://api.met.no
SITUATION_DATA_MET_NORWAY_CACHE_TTL_SECONDS=600
MET_NORWAY_USER_AGENT=csm-sim/0.1 situation-data contact:ops@zeleznalady.cz
CTU_NETTEST_URL=https://nettest.ctu.gov.cz/RMBTStatisticServer/export/nettest-opendata_hours-048.zip
PID_GTFS_RT_VEHICLE_POSITIONS_URL=https://api.golemio.cz/v2/vehiclepositions/gtfsrt/vehicle_positions.pb
PID_GTFS_STATIC_URL=https://data.pid.cz/PID_GTFS.zip
SITUATION_DATA_PID_GTFS_STATIC_CACHE_TTL_SECONDS=21600
SAFETY_DATA_BASE_URL=http://safety-data-api:4030
AVIATION_WEATHER_BASE_URL=https://aviationweather.gov
```

`public.weather.current` zustava pro COP stejnou vrstvou
`layers=weather&source=open_meteo`. SIM ji server-side obohacuje zdrojem
MET Norway Locationforecast jako druhym modelem a fallbackem pri nedostupnosti
Open-Meteo. `MET_NORWAY_USER_AGENT` musi byt popisny a kontaktovatelny, protoze
MET Norway vyzaduje identifikujici User-Agent.

`docker-compose.yml` spouští pro pilot lokální neveřejný Valkey cache kontejner `situation-data-cache`. V HA produkci lze
`SITUATION_DATA_SHARED_CACHE_REDIS_URL` přepsat na externí Redis/KeyDB/Valkey endpoint; pokud není nastavená, `situation-data-api`
použije pouze lokální in-memory cache.

ARDOS partner pilot:

```bash
SITUATION_DATA_ENABLED_SOURCES=open_meteo,weather_forecast,aviation_weather,ctu_nettest,ctu_stationary_mobile,pid_gtfs_rt,public_transit_static,idsjmk_vehicle_positions,spravazeleznic_trains,road_srti_lod,safety_data,ardos_partner
ARDOS_PARTNER_BASE_URL=https://ardos-partner.example.cz
ARDOS_PARTNER_TOKEN=...
SITUATION_DATA_ARDOS_CACHE_TTL_SECONDS=15
```

`ARDOS_PARTNER_TOKEN` je secret; necommitovat do repozitáře.

TAK Gateway pilot:

```bash
TAK_GATEWAY_INGEST_TOKEN=...
TAK_GATEWAY_READ_TOKEN=...
TAK_GATEWAY_PUBLIC_READ=false
TAK_GATEWAY_DEFAULT_BBOX=11.8,48.5,19.2,51.2
TAK_GATEWAY_STALE_AFTER_SECONDS=300
TAK_GATEWAY_RETENTION_SECONDS=3600
TAK_GATEWAY_MAX_EVENTS=5000
TAK_GATEWAY_EXPOSE_RAW=false
TAK_GATEWAY_SOURCE_LABEL=TAK/CoT gateway
```

`TAK_GATEWAY_INGEST_TOKEN` je secret pro TAK/ARDOS bridge klienta; `TAK_GATEWAY_READ_TOKEN` je secret pro server-side COM klienta. Necommitovat do repozitáře. Raw CoT drž vypnutý, pokud není schválený auditní a oprávňovací režim v COM.

OpenStreetMap/Overpass nezapínej jako produkční runtime backend pro tisíce uživatelů. Veřejný Overpass lze použít jen pro lokální vývoj nebo omezený pilot s malými bbox dotazy:

```bash
SITUATION_DATA_ENABLED_SOURCES=open_meteo,osm_overpass
SITUATION_DATA_OVERPASS_CACHE_TTL_SECONDS=21600
OVERPASS_MAX_BBOX_DEGREES=1.6
```

Preferovaná produkční varianta pro OSM používá samostatnou databázi `sim_osm` v HA PostgreSQL/Patroni přes `haproxy.home.cz:5000`:

```bash
SITUATION_DATA_ENABLED_SOURCES=open_meteo,weather_forecast,aviation_weather,chmi_weather_stations,chmi_weather_webcams,chmi_air_quality,osm_postgis,mobile_coverage_model,mobile_network_model,ctu_nettest,ctu_stationary_mobile,pid_gtfs_rt,public_transit_static,idsjmk_vehicle_positions,spravazeleznic_trains,road_srti_lod,safety_data
OSM_POSTGIS_BACKEND=patroni-postgis
OSM_POSTGIS_DATABASE_URL=postgresql://sim_osm:<strong-password>@haproxy.home.cz:5000/sim_osm
OSM_POSTGIS_TABLE=public.osm_poi
OSM_POSTGIS_ADMIN_BOUNDARY_TABLE=public.osm_admin_boundary
OSM_POSTGIS_TRAIL_ROUTES_TABLE=public.osm_trail_routes
OSM_POSTGIS_TRAIL_POI_TABLE=public.osm_trail_poi
SAFETY_DATA_ADMIN_BOUNDARY_DATABASE_URL=postgresql://sim_osm:<strong-password>@haproxy.home.cz:5000/sim_osm
SAFETY_DATA_ADMIN_BOUNDARY_TABLE=public.osm_admin_boundary
SAFETY_DATA_ADMIN_BOUNDARY_CACHE_TTL_SECONDS=86400
SITUATION_DATA_OSM_POSTGIS_CACHE_TTL_SECONDS=21600
SITUATION_DATA_MOBILE_NETWORK_CACHE_TTL_SECONDS=3600
SITUATION_DATA_MOBILE_COVERAGE_CACHE_TTL_SECONDS=21600
MOBILE_COVERAGE_RESOLUTION_M=1000
MOBILE_COVERAGE_MODEL_VERSION=coverage-v2-terrain
MOBILE_COVERAGE_DEM_SOURCE=copernicus-glo30-cz
MOBILE_COVERAGE_TERRAIN_AWARE=true
MOBILE_COVERAGE_READ_MODEL_ENABLED=true
MOBILE_COVERAGE_READ_MODEL_TABLE=public.mobile_coverage_cells
MOBILE_COVERAGE_READ_MODEL_MAX_AGE_SECONDS=604800
scripts/import-osm-cz-postgis.sh
```

Lokální Docker PostGIS může zůstat jen jako rebuildovatelný read-model/cache s explicitním silným heslem a URL:

```bash
SITUATION_DATA_ENABLED_SOURCES=open_meteo,weather_forecast,aviation_weather,chmi_weather_stations,chmi_weather_webcams,chmi_air_quality,osm_postgis,mobile_coverage_model,mobile_network_model,ctu_nettest,ctu_stationary_mobile,pid_gtfs_rt,public_transit_static,idsjmk_vehicle_positions,spravazeleznic_trains,road_srti_lod,safety_data
OSM_POSTGIS_BACKEND=local-postgis
OSM_POSTGIS_DB=sim_osm
OSM_POSTGIS_USER=sim_osm
OSM_POSTGIS_PASSWORD=<strong-password>
OSM_POSTGIS_DATABASE_URL=postgresql://sim_osm:<password>@osm-postgis:5432/sim_osm
OSM_POSTGIS_TABLE=public.osm_poi
OSM_POSTGIS_ADMIN_BOUNDARY_TABLE=public.osm_admin_boundary
OSM_POSTGIS_TRAIL_ROUTES_TABLE=public.osm_trail_routes
OSM_POSTGIS_TRAIL_POI_TABLE=public.osm_trail_poi
SITUATION_DATA_OSM_POSTGIS_CACHE_TTL_SECONDS=21600
SITUATION_DATA_MOBILE_NETWORK_CACHE_TTL_SECONDS=3600
SITUATION_DATA_MOBILE_COVERAGE_CACHE_TTL_SECONDS=21600
```

Importní skript stahuje `https://download.geofabrik.de/europe/czech-republic-latest.osm.pbf`, naplní PostGIS přes `osm2pgsql` a vytvoří materializované pohledy `public.osm_poi`, `public.osm_admin_boundary`, `public.osm_trail_routes` a `public.osm_trail_poi` pro COM provider features. Podrobný postup je v `docs/runbooks/08_OSM_POSTGIS_PRODUCTION.md`.

Produkční deploy skript pro `docker.home.cz` zachovává existující hodnoty
`OSM_POSTGIS_*` a `SAFETY_DATA_ADMIN_BOUNDARY_*` z `/srv/sim/.env`, pokud nejsou
při deployi explicitně přepsané proměnnými prostředí. Běžný GitHub deploy tedy
nesmí vynulovat napojení na produkční OSM/PostGIS.

`mobile_network_model` je hlavní COM vrstva pro občanské zobrazení mobilní sítě. Kombinuje připravené read-model buňky `mobile_coverage_model`, aktuální ČTÚ NetTest měření, oficiální historická stacionární měření ČTÚ `ctu_stationary_mobile` a infrastrukturní indicie do jednoho závěru `mobile_network`. Pokud připravený coverage read-model pro oblast neexistuje, API vrací `0` features + warning; nesmí vytvářet plošný fallback z dotazovaného bboxu.

`mobile_coverage_model` používá stejný `public.osm_poi` zdroj věží jako `osm_postgis`, ale publikuje nižší polygonovou vrstvu `mobile_coverage` jako modelový odhad. Ve fázi 2 při `MOBILE_COVERAGE_TERRAIN_AWARE=true` používá lokální Copernicus DEM GLO-30 cache a line-of-sight penalizaci terénem bez změny COM kontraktu. V produkci má runtime API primárně číst připravený read-model `public.mobile_coverage_cells` a on-demand výpočet používat jen jako fallback.

DEM katalog pro terrain-aware model používá Copernicus DEM GLO-30, SeaweedFS a PostGIS:

```bash
DEM_ENABLED=true
DEM_BBOX=11.8,48.5,19.2,51.2
DEM_DATASET_ID=copernicus-glo30-cz
DEM_POSTGIS_DATABASE_URL=postgresql://sim_osm:<strong-password>@haproxy.home.cz:5000/sim_osm
DEM_LOCAL_CACHE_HOST_DIR=./data/dem-cache/copernicus-glo30
DEM_LOCAL_CACHE_DIR=/dem-cache/copernicus-glo30
DEM_SEAWEEDFS_S3_ENDPOINT=http://docker.home.cz:8335
DEM_SEAWEEDFS_BUCKET=sim-dem
DEM_SEAWEEDFS_PREFIX=copernicus-glo30/2021
DEM_SEAWEEDFS_ACCESS_KEY_ID=<secret>
DEM_SEAWEEDFS_SECRET_ACCESS_KEY=<secret>
scripts/import-dem-copernicus-glo30-cz.sh
```

Podrobný postup je v `docs/runbooks/09_DEM_COPERNICUS_SEAWEEDFS_POSTGIS.md`.

## Operational Alerting

Produkční periodické kontroly běží na hostu proti internímu gateway portu a
nevyžadují nové veřejné endpointy:

```bash
SIM_OPERATIONAL_ALERT_WEBHOOK_URL=
SIM_OPERATIONAL_ALERT_ENVIRONMENT=docker-home
SIM_OPERATIONAL_BASE_URL=http://127.0.0.1:5020
SIM_OPERATIONAL_API_TOKEN=
SIM_OPERATIONAL_CHECK_BBOX=11.8,48.5,19.2,51.2
SIM_OPERATIONAL_BOUNDARY_BBOX=12,48,19,51
SIM_OPERATIONAL_TERRAIN_BBOX=13.95,50.55,14.08,50.65
SIM_OPERATIONAL_EXPECTED_DEM_SOURCE=copernicus-glo30-cz
SIM_OPERATIONAL_EXPECTED_MOBILE_MODEL_VERSION=coverage-v2-terrain
SIM_OPERATIONAL_REQUIRE_DEM=true
SIM_OPERATIONAL_REQUIRE_TERRAIN_AWARE=true
SIM_OPERATIONAL_ALERT_ON_RECOVERY=true
SIM_OPERATIONAL_ALERT_EVERY_FAILURE=false
```

`SIM_OPERATIONAL_ALERT_WEBHOOK_URL` je volitelný generic JSON webhook. Bez něj
kontrola stále zapisuje stav do `data/operational-checks/` a posílá failure /
recovery zprávy do syslogu. Podrobný postup je v
`docs/runbooks/14_OPERATIONAL_ALERTING.md`.

## Safety Data API

Výchozí bezpečná konfigurace:

```bash
SAFETY_DATA_ENABLED_SOURCES=mock
```

Pilot s reálnými ČHMÚ/GDACS/HZS/SRTI veřejnými zdroji:

```bash
SAFETY_DATA_ENABLED_SOURCES=chmi_alerts,chmi_hydro,gdacs_alerts,hzs_incidents,municipal_alerts,road_srti_lod,admin_boundaries
SAFETY_DATA_DEFAULT_BBOX=11.8,48.5,19.2,51.2
SAFETY_DATA_CACHE_TTL_SECONDS=300
SAFETY_DATA_STALE_IF_ERROR_SECONDS=3600
SAFETY_DATA_CACHE_MAX_ENTRIES=512
SAFETY_DATA_STALE_AFTER_SECONDS=3600
SAFETY_DATA_REQUEST_TIMEOUT_MS=8000
CHMI_ALERTS_CAP_BASE_URL=https://opendata.chmi.cz/meteorology/weather/alerts/cap/
CHMI_ORP_CODELIST_URL=https://apl2.czso.cz/iSMS/do_cis_export?cisjaz=203&cisvaz=61_88&format=2&kodcis=65&separator=,&typdat=1
CHMI_HYDRO_METADATA_URL=https://opendata.chmi.cz/hydrology/now/metadata/meta1.json
CHMI_HYDRO_NOW_BASE_URL=https://opendata.chmi.cz/hydrology/now/data
CHMI_HYDRO_RECENT_BASE_URL=https://opendata.chmi.cz/hydrology/recent/data
CHMI_HYDRO_MAX_STATIONS=600
CHMI_HYDRO_STATION_CACHE_MAX_ENTRIES=728
CHMI_HYDRO_CURRENT_SNAPSHOT_CACHE_TTL_SECONDS=300
CHMI_HYDRO_DETAIL_DEFAULT_PAST_HOURS=168
CHMI_HYDRO_DETAIL_FORECAST_HOURS=72
CHMI_HYDRO_DETAIL_BACKFILL_DAYS=7
# Volitelně pro požáry. Bez klíče neaktivovat nasa_firms ve zdrojích.
NASA_FIRMS_MAP_KEY=
NASA_FIRMS_AREA_BASE_URL=https://firms.modaps.eosdis.nasa.gov/api/area/csv
NASA_FIRMS_SOURCE=VIIRS_SNPP_NRT
NASA_FIRMS_DAY_RANGE=1
GDACS_RSS_URL=https://www.gdacs.org/xml/rss.xml
GDACS_CACHE_TTL_SECONDS=900
HZS_INCIDENTS_FEEDS=https://www.hzspa.cz/vyjezdy/aktualni-vyjezdy.php|HZS Pardubického kraje - aktuální výjezdy|Pardubický kraj|15.78|49.94|15.3,49.45,16.95,50.35|hzs-pardubice|html;http://udalostikhk.hzscr.cz/api/|HZS Královéhradeckého kraje - veřejné události|Královéhradecký kraj|15.83|50.21|15.05,49.9,16.75,50.85|hzs-kralovehradecky|khk-json
HZS_INCIDENTS_CACHE_TTL_SECONDS=180
HZS_INCIDENTS_DETAIL_CACHE_TTL_SECONDS=1800
HZS_INCIDENTS_MAX_ACTIVE_DETAILS=50
MUNICIPAL_ALERT_FEEDS=
MUNICIPAL_ALERTS_CACHE_TTL_SECONDS=300
SAFETY_DATA_ADMIN_BOUNDARY_DATABASE_URL=
SAFETY_DATA_ADMIN_BOUNDARY_TABLE=public.osm_admin_boundary
SAFETY_DATA_ADMIN_BOUNDARY_CACHE_TTL_SECONDS=86400
```

Krajské nebo městské krizové portály lze připojit, pokud poskytují veřejný nebo
partnerem povolený RSS/Atom/GeoRSS/GeoJSON feed nebo stabilní PKR JSON výstup.
Pokud je `municipal_alerts` zapnutý a `MUNICIPAL_ALERT_FEEDS` je prázdné, SIM
použije vestavěný ověřený katalog veřejných regionálních zdrojů:

- `pkr-ustecky-jpo`: Ústecký kraj, veřejný PKR JSON zásahů JPO s přesnou
  geometrií převáděnou ze S-JTSK/Křováka do WGS84.
- `pkr-liberecky-udalosti`: Liberecký kraj, veřejný PKR JSON probíhajících
  událostí s přesnou geometrií převáděnou ze S-JTSK/Křováka do WGS84.
- `pkr-stredocesky-aktuality`: Středočeský kraj, veřejný PKR RSS aktualit;
  položky bez souřadnic jsou publikované jako autoritativní krajský fallback bod
  s nižší důvěrou a implicitní sedmidenní platností.
- `pkr-stredocesky-jpo`: Středočeský kraj, veřejný PKR RSS zásahů JPO;
  feed nedodává souřadnice, proto se publikuje jako autoritativní krajský
  fallback bod s nižší důvěrou.
- `olkraj-krizove-rizeni`: Olomoucký kraj, veřejný RSS kanál kategorie krizové
  řízení; položky bez souřadnic jsou publikované jako autoritativní krajský
  fallback bod s nižší důvěrou.
- `bruntal-uredni-rss`, `krnov-aktuality-rss`, `vrbno-aktuality-rss`: obecní
  oficiální RSS feedy pro Bruntál, Krnov a Vrbno pod Pradědem. Protože nejde o
  dedikované krizové feedy, SIM z nich publikuje pouze přísně filtrované
  krizově relevantní položky a vždy je označí jako fallback polohu autority.

```bash
SAFETY_DATA_ENABLED_SOURCES=chmi_alerts,chmi_hydro,gdacs_alerts,hzs_incidents,municipal_alerts,road_srti_lod,admin_boundaries
MUNICIPAL_ALERT_FEEDS='https://example.gov/krize/rss.xml|Krizové výstrahy města|Statutární město Example|14.4200|50.0870|14.2,49.9,14.7,50.2|example-city|georss'
MUNICIPAL_ALERTS_CACHE_TTL_SECONDS=300
```

Více feedů se odděluje středníkem. Formát položky je
`url|label|authority|fallbackLon|fallbackLat|bbox|id|format`, kde `format` je
`auto`, `rss`, `atom`, `georss`, `geojson` nebo `pkr-json`.

`gdacs_alerts` je bezklicovy verejny GeoRSS/RSS zdroj GDACS pro globalni
katastroficke alerty s potencialnim humanitarnim dopadem. SIM ho normalizuje
do `warnings`, `fire` a `flood`; pro lokalni opatreni zustava zdrojem autority
IZS/CHMI/prislusny organ. `hzs_incidents` je bezklicovy verejny feed
probihajicich vyjezdu; vychozi konfigurace pokryva pilotne HZS Pardubickeho
kraje a HZS Kralovehradeckeho kraje. Dalsi krajsky feed se prida do
`HZS_INCIDENTS_FEEDS` jako dalsi polozka oddelena strednikem ve tvaru
`url|label|region|lon|lat|west,south,east,north|id|format`, kde `format` je
`html` pro stranku se sekci `Probihajici vyjezdy` nebo `khk-json` pro verejne
JSON API HZS Kralovehradeckeho kraje. Pokud `format` chybi, pouzije se `html`.
KHK feed je ve vychozi konfiguraci veden pres HTTP, protoze verejny HTTPS
endpoint aktualne neposkytuje kompletni certifikacni retezec pro Node/Alpine;
feed neobsahuje autentizaci ani tajne udaje. Po oprave TLS retezce upstreamem
staci zmenit URL na `https://udalostikhk.hzscr.cz/api/`.
`nasa_firms` zustava volitelny zdroj pro satelitni pozarni detekce a nezapina se
bez `NASA_FIRMS_MAP_KEY`.

Projekce do `situation-data`:

```bash
SITUATION_DATA_ENABLED_SOURCES=open_meteo,weather_forecast,aviation_weather,ctu_nettest,ctu_stationary_mobile,pid_gtfs_rt,public_transit_static,idsjmk_vehicle_positions,spravazeleznic_trains,road_srti_lod,safety_data
SAFETY_DATA_BASE_URL=http://safety-data-api:4030
SITUATION_DATA_SAFETY_CACHE_TTL_SECONDS=300
```
