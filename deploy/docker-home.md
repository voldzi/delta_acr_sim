# Deploy na docker.home.cz

Pilotní deployment běží ze složky `/srv/sim` a používá port `5020`.

## Jednorázové sudo kroky

Tyto kroky musí provést uživatel se sudo oprávněním:

```bash
sudo mkdir -p /srv/sim
sudo chown -R voldzi:voldzi /srv/sim
```

## Instalace nebo update

Po zpřístupnění `/srv/sim`:

```bash
cd /srv/sim
if [ ! -d .git ]; then
  git clone https://github.com/voldzi/delta_acr_sim.git .
else
  git pull --ff-only
fi

cat > .env <<'EOF'
SIM_WEB_PORT=5020
API_PORT=4000
SIM_PUBLISHER_MODE=DRY_RUN
SIM_SOURCE_SYSTEM_ID=sim-air-situation-001
SIM_ADAPTER_VERSION=0.1.0
SIM_DATA_DIR=/data
MAIN_COP_BASE_URL=http://sim-api:4000/mock-cop
MAIN_COP_BEARER_TOKEN=dev-lab-token
EXTERNAL_AI_ALLOWED=false
FLIGHT_DATA_ENABLED_SOURCES=adsb_lol
FLIGHT_DATA_DEFAULT_LAT=50.1008
FLIGHT_DATA_DEFAULT_LON=14.2632
FLIGHT_DATA_DEFAULT_RADIUS_NM=120
FLIGHT_DATA_CACHE_TTL_SECONDS=10
FLIGHT_DATA_STALE_IF_ERROR_SECONDS=60
FLIGHT_DATA_CACHE_MAX_ENTRIES=512
FLIGHT_DATA_STALE_AFTER_SECONDS=120
FLIGHT_DATA_REQUEST_TIMEOUT_MS=8000
LOCAL_ADSB_AIRCRAFT_JSON_URLS=
OURAIRPORTS_ENABLED=true
OURAIRPORTS_COUNTRIES=CZ,SK,AT,DE,PL,HU
OURAIRPORTS_CACHE_TTL_SECONDS=86400
SITUATION_DATA_ENABLED_SOURCES=open_meteo,aviation_weather,osm_postgis,mobile_coverage_model,mobile_network_model,ctu_nettest,pid_gtfs_rt,safety_data
SITUATION_DATA_DEFAULT_BBOX=13.85,49.65,15.35,50.45
SITUATION_DATA_CACHE_TTL_SECONDS=30
SITUATION_DATA_STALE_IF_ERROR_SECONDS=1800
SITUATION_DATA_CACHE_MAX_ENTRIES=10000
SITUATION_DATA_BBOX_CACHE_PADDING_DEGREES=0.18
SITUATION_DATA_OPEN_METEO_CACHE_TTL_SECONDS=600
SITUATION_DATA_OPEN_METEO_GRID_DEGREES=0.05
SITUATION_DATA_OSM_POSTGIS_CACHE_TTL_SECONDS=21600
SITUATION_DATA_OVERPASS_CACHE_TTL_SECONDS=21600
SITUATION_DATA_SAFETY_CACHE_TTL_SECONDS=300
SITUATION_DATA_AVIATION_WEATHER_CACHE_TTL_SECONDS=600
SITUATION_DATA_ARDOS_CACHE_TTL_SECONDS=15
SITUATION_DATA_MOBILE_NETWORK_CACHE_TTL_SECONDS=3600
SITUATION_DATA_MOBILE_COVERAGE_CACHE_TTL_SECONDS=21600
MOBILE_COVERAGE_RESOLUTION_M=1000
MOBILE_COVERAGE_MAX_CELLS=1000
MOBILE_COVERAGE_MODEL_VERSION=coverage-v1
MOBILE_COVERAGE_DEM_SOURCE=not-used-phase-1
MOBILE_COVERAGE_TERRAIN_AWARE=false
MOBILE_COVERAGE_DEFAULT_ANTENNA_HEIGHT_M=30
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
OSM_POSTGIS_DB=sim_osm
OSM_POSTGIS_USER=sim_osm
OSM_POSTGIS_PASSWORD=
OSM_POSTGIS_BACKEND=
OSM_POSTGIS_DATABASE_URL=
OSM_POSTGIS_TABLE=public.osm_poi
OVERPASS_BASE_URL=https://overpass-api.de/api/interpreter
OVERPASS_MAX_BBOX_DEGREES=1.6
CTU_NETTEST_URL=https://nettest.ctu.gov.cz/RMBTStatisticServer/export/nettest-opendata_hours-048.zip
PID_GTFS_RT_VEHICLE_POSITIONS_URL=https://api.golemio.cz/v2/vehiclepositions/gtfsrt/vehicle_positions.pb
SAFETY_DATA_BASE_URL=http://safety-data-api:4030
AVIATION_WEATHER_BASE_URL=https://aviationweather.gov
ARDOS_PARTNER_BASE_URL=
ARDOS_PARTNER_TOKEN=
TAK_GATEWAY_INGEST_TOKEN=dev-tak-ingest-token
TAK_GATEWAY_READ_TOKEN=
TAK_GATEWAY_PUBLIC_READ=false
TAK_GATEWAY_DEFAULT_BBOX=11.8,48.5,19.2,51.2
TAK_GATEWAY_STALE_AFTER_SECONDS=300
TAK_GATEWAY_RETENTION_SECONDS=3600
TAK_GATEWAY_MAX_EVENTS=5000
TAK_GATEWAY_EXPOSE_RAW=false
TAK_GATEWAY_SOURCE_LABEL=TAK/CoT gateway
EOF

docker compose up -d --build
docker compose ps
curl -fsS http://localhost:5020/health/live
curl -fsS http://localhost:5020/flight-data/health/ready
curl -fsS http://localhost:5020/situation-data/health/ready
curl -fsS http://localhost:5020/tak-gateway/health/ready
curl -fsS http://localhost:5020/situation-data/api/v1/catalog
curl -fsS 'http://localhost:5020/situation-data/api/v1/features?layers=weather,mobile_network,traffic,warnings,flood&limit=20'
```

## OpenStreetMap/PostGIS import

Veřejný Overpass nepoužívej pro produkční runtime.

Preferovaná produkční varianta je HA PostgreSQL/Patroni přes `haproxy.home.cz:5000` se samostatnou databází `sim_osm`:

```bash
cd /srv/sim
export OSM_POSTGIS_DATABASE_URL='postgresql://sim_osm:<strong-password>@haproxy.home.cz:5000/sim_osm'
export OSM_POSTGIS_BACKEND=patroni-postgis
scripts/import-osm-cz-postgis.sh
```

Lokální Docker PostGIS je přípustný jen jako rebuildovatelný read-model/cache pro OSM extract. Nepoužívej default credential; nastav silné heslo a explicitní URL:

```bash
cd /srv/sim
python3 - <<'PY'
from pathlib import Path
import secrets

p = Path(".env")
lines = p.read_text().splitlines()

def set_key(key: str, value: str) -> None:
    prefix = key + "="
    for i, line in enumerate(lines):
        if line.startswith(prefix):
            lines[i] = prefix + value
            return
    lines.append(prefix + value)

password = secrets.token_hex(32)
set_key("OSM_POSTGIS_BACKEND", "local-postgis")
set_key("OSM_POSTGIS_PASSWORD", password)
set_key("OSM_POSTGIS_DATABASE_URL", f"postgresql://sim_osm:{password}@osm-postgis:5432/sim_osm")
set_key("OSM_POSTGIS_TABLE", "public.osm_poi")
p.write_text("\n".join(lines) + "\n")
PY
docker compose --profile osm up -d osm-postgis
scripts/import-osm-cz-postgis.sh
```

Poté uprav `.env`. Pokud chceš zároveň publikovat sjednocenou mobilní vrstvu nad importovanými OSM věžemi, zapni `mobile_coverage_model` i `mobile_network_model`:

```bash
SITUATION_DATA_ENABLED_SOURCES=open_meteo,aviation_weather,osm_postgis,mobile_coverage_model,mobile_network_model,ctu_nettest,pid_gtfs_rt,safety_data
SITUATION_DATA_OSM_POSTGIS_CACHE_TTL_SECONDS=21600
SITUATION_DATA_MOBILE_NETWORK_CACHE_TTL_SECONDS=3600
SITUATION_DATA_MOBILE_COVERAGE_CACHE_TTL_SECONDS=21600
MOBILE_COVERAGE_RESOLUTION_M=1000
MOBILE_COVERAGE_MAX_CELLS=1000
MOBILE_COVERAGE_MODEL_VERSION=coverage-v1
MOBILE_COVERAGE_DEM_SOURCE=not-used-phase-1
MOBILE_COVERAGE_TERRAIN_AWARE=false
MOBILE_COVERAGE_DEFAULT_ANTENNA_HEIGHT_M=30
OSM_POSTGIS_BACKEND=local-postgis
OSM_POSTGIS_DATABASE_URL=postgresql://sim_osm:<password>@osm-postgis:5432/sim_osm
OSM_POSTGIS_TABLE=public.osm_poi
```

A restartuj pouze situační API a web proxy:

```bash
docker compose up -d --build situation-data-api sim-web
curl -fsS 'http://localhost:5020/situation-data/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=ground,mobile&source=osm_postgis&limit=20'
curl -fsS 'http://localhost:5020/situation-data/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=mobile_coverage&source=mobile_coverage_model&technology=4G&limit=20'
curl -fsS 'http://localhost:5020/situation-data/api/v1/features?bbox=13.85,49.65,15.35,50.45&layers=mobile_network&source=mobile_network_model&limit=20'
curl -fsS http://localhost:5020/situation-data/api/v1/mobile-coverage/metadata
curl -fsS http://localhost:5020/situation-data/health/ready
curl -fsS http://localhost:5020/situation-data/metrics | grep -E 'osm_postgis|osm_poi|mobile_coverage|mobile_network'
```

## DEM Copernicus GLO-30 import

SIM ukládá DEM binární soubory do dedikovaného SIM SeaweedFS S3 gateway, rychlou runtime kopii do lokálního filesystemu a prostorový katalog do PostGIS. Rastry neukládej přímo do PostgreSQL. Nepoužívej endpointy, buckety ani přístupové údaje patřící jiné aplikaci.

Po nastavení `OSM_POSTGIS_DATABASE_URL` na Patroni/PostGIS doplň v `/srv/sim/.env`:

```bash
DEM_ENABLED=true
DEM_BBOX=11.8,48.5,19.2,51.2
DEM_DATASET_ID=copernicus-glo30-cz
DEM_POSTGIS_DATABASE_URL=postgresql://sim_osm:<strong-password>@haproxy.home.cz:5000/sim_osm
DEM_LOCAL_CACHE_HOST_DIR=./data/dem-cache/copernicus-glo30
DEM_LOCAL_CACHE_DIR=/dem-cache/copernicus-glo30
DEM_SEAWEEDFS_ENABLED=true
DEM_SEAWEEDFS_S3_ENDPOINT=http://docker.home.cz:8335
DEM_SEAWEEDFS_BUCKET=sim-dem
DEM_SEAWEEDFS_PREFIX=copernicus-glo30/2021
DEM_SEAWEEDFS_ACCESS_KEY_ID=<secret>
DEM_SEAWEEDFS_SECRET_ACCESS_KEY=<secret>
```

Import:

```bash
scripts/import-dem-copernicus-glo30-cz.sh
docker compose up -d --build situation-data-api sim-web
curl -fsS http://localhost:5020/situation-data/api/v1/dem/metadata
curl -fsS http://localhost:5020/situation-data/metrics | grep dem_
```

`MOBILE_COVERAGE_TERRAIN_AWARE` zatím nech `false`, dokud nebude ověřené čtení výšek a line-of-sight model.

## URL

```text
http://docker.home.cz:5020
```

## Poznámky

- Výchozí režim je `DRY_RUN`.
- Pro LIVE publikování syntetických eventů do aktuálního COP nastav `SIM_PUBLISHER_MODE=LIVE`, `MAIN_COP_BASE_URL=http://172.17.0.1:4310` a `MAIN_COP_BEARER_TOKEN` na stejnou hodnotu jako `COP_LAB_TOKEN` v COP.
- Flight Data API pro integrační pilot COM/COP běží proti ADSB.lol: `FLIGHT_DATA_ENABLED_SOURCES=adsb_lol`.
- Vlastní readsb/dump1090 přijímače přidej přes `FLIGHT_DATA_ENABLED_SOURCES=local_adsb,adsb_lol` a `LOCAL_ADSB_AIRCRAFT_JSON_URLS=http://.../aircraft.json`.
- OurAirports import je zapnutý pro letiště v ČR a okolí: `OURAIRPORTS_COUNTRIES=CZ,SK,AT,DE,PL,HU`.
- Flight Data API používá server-side cache s in-flight deduplikací: `FLIGHT_DATA_CACHE_TTL_SECONDS=10`, `FLIGHT_DATA_STALE_IF_ERROR_SECONDS=60`, `FLIGHT_DATA_CACHE_MAX_ENTRIES=512`.
- Pro offline test nastav `FLIGHT_DATA_ENABLED_SOURCES=mock`.
- Situation Data API ve výchozím pilotu používá reálné zdroje `open_meteo,aviation_weather,osm_postgis,mobile_coverage_model,mobile_network_model,ctu_nettest,pid_gtfs_rt,safety_data`.
- Situation Data API používá server-side cache a source-level cache pro velké feedy: `SITUATION_DATA_CACHE_TTL_SECONDS=30`, `SITUATION_DATA_STALE_IF_ERROR_SECONDS=1800`, `SITUATION_DATA_CACHE_MAX_ENTRIES=10000`.
- Pro offline test nastav `SITUATION_DATA_ENABLED_SOURCES=mock`.
- `osm_postgis` je produkční OSM zdroj nad Patroni/PostGIS nebo lokálním rebuildovatelným PostGIS read-modelem; `osm_overpass` drž jen pro malé bbox dotazy a nízkou frekvenci.
- `mobile_network_model` publikuje hlavní občanskou mobilní vrstvu `mobile_network`; kombinuje modelované coverage, ČTÚ NetTest měření a dostupné infrastrukturní indicie do jednoho závěru.
- `mobile_coverage_model` publikuje nižší modelovou polygonovou vrstvu `mobile_coverage` nad OSM `communications_tower` referencemi. Zapínej ji jen s nakonfigurovaným `OSM_POSTGIS_DATABASE_URL`; výstup je modelový odhad, ne garantované pokrytí operátora.
- `ctu_nettest` stahuje poslední otevřený ZIP export ČTÚ NetTest a publikuje mobilní měření jako kontextovou vrstvu.
- `pid_gtfs_rt` stahuje GTFS-RT vozidla PID/Golemio a publikuje živý dopravní kontext ve vrstvě `traffic`.
- `aviation_weather` stahuje NOAA AWC METAR/TAF přes SIM cache a publikuje letištní počasí ve vrstvě `weather`.
- `ardos_partner` zapínej až po partnerské dohodě, nastavení `ARDOS_PARTNER_BASE_URL` a secretu `ARDOS_PARTNER_TOKEN`.
- `tak-gateway-api` přijímá TAK/CoT XML přes chráněný ingest endpoint `/tak-gateway/api/v1/cot/events`; COM backend čte normalizovaný GeoJSON endpoint `/tak-gateway/api/v1/features`. Starý `/cop/features` zůstává jen jako kompatibilní alias.
- `TAK_GATEWAY_INGEST_TOKEN` je secret; pro pilot ho změň mimo repozitář a předej jen ARDOS/TAK bridge klientovi.
- `TAK_GATEWAY_PUBLIC_READ=false` je bezpečný výchozí režim; nastav `TAK_GATEWAY_READ_TOKEN` a předávej jej jen server-side klientovi COM.
- U komerčního použití musí být vyřešená ODbL atribuce a share-alike povinnosti.
- OpenSky nezapínej bez ověření oprávnění nebo písemné licence.
- Perzistentní data jsou v Docker volume `sim-data`, `flight-data`, `situation-data`, `safety-data` a `tak-gateway-data`.
- Web kontejner přes nginx proxy předává `/api`, `/health`, `/metrics`, `/mock-cop`, `/flight-data/*`, `/situation-data/*`, `/safety-data/*` a `/tak-gateway/*` do příslušných API kontejnerů.
