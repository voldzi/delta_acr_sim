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
SITUATION_DATA_ENABLED_SOURCES=open_meteo,osm_overpass,ctu_nettest,pid_gtfs_rt
SITUATION_DATA_DEFAULT_BBOX=13.85,49.65,15.35,50.45
SITUATION_DATA_CACHE_TTL_SECONDS=30
SITUATION_DATA_STALE_IF_ERROR_SECONDS=600
SITUATION_DATA_CACHE_MAX_ENTRIES=512
SITUATION_DATA_STALE_AFTER_SECONDS=900
SITUATION_DATA_REQUEST_TIMEOUT_MS=8000
OPEN_METEO_BASE_URL=https://api.open-meteo.com
OVERPASS_BASE_URL=https://overpass-api.de/api/interpreter
OVERPASS_MAX_BBOX_DEGREES=1.6
CTU_NETTEST_URL=https://nettest.ctu.gov.cz/RMBTStatisticServer/export/nettest-opendata_hours-048.zip
PID_GTFS_RT_VEHICLE_POSITIONS_URL=https://api.golemio.cz/v2/vehiclepositions/gtfsrt/vehicle_positions.pb
EOF

docker compose up -d --build
docker compose ps
curl -fsS http://localhost:5020/health/live
curl -fsS http://localhost:5020/flight-data/health/ready
curl -fsS http://localhost:5020/situation-data/health/ready
curl -fsS 'http://localhost:5020/situation-data/api/v1/cop/features?layers=weather,mobile,traffic&limit=20'
```

## URL

```text
http://docker.home.cz:5020
```

## Poznámky

- Výchozí režim je `DRY_RUN`.
- Pro LIVE publikování do COP nastav `SIM_PUBLISHER_MODE=LIVE`, `MAIN_COP_BASE_URL=http://172.17.0.1:4310` a `MAIN_COP_BEARER_TOKEN` na stejnou hodnotu jako `COP_LAB_TOKEN` v COP.
- Flight Data API pro integrační pilot COP běží proti ADSB.lol: `FLIGHT_DATA_ENABLED_SOURCES=adsb_lol`.
- Flight Data API používá server-side cache s in-flight deduplikací: `FLIGHT_DATA_CACHE_TTL_SECONDS=10`, `FLIGHT_DATA_STALE_IF_ERROR_SECONDS=60`, `FLIGHT_DATA_CACHE_MAX_ENTRIES=512`.
- Pro offline test nastav `FLIGHT_DATA_ENABLED_SOURCES=mock`.
- Situation Data API ve výchozím pilotu používá reálné open-data zdroje `open_meteo,osm_overpass,ctu_nettest,pid_gtfs_rt`.
- Situation Data API používá server-side cache a source-level cache pro velké feedy: `SITUATION_DATA_CACHE_TTL_SECONDS=30`, `SITUATION_DATA_STALE_IF_ERROR_SECONDS=600`, `SITUATION_DATA_CACHE_MAX_ENTRIES=512`.
- Pro offline test nastav `SITUATION_DATA_ENABLED_SOURCES=mock`.
- `osm_overpass` drž jen pro malé bbox dotazy a nízkou frekvenci; veřejné Overpass instance jsou sdílený zdroj.
- `ctu_nettest` stahuje poslední otevřený ZIP export ČTÚ NetTest a publikuje mobilní měření jako kontextovou vrstvu.
- `pid_gtfs_rt` stahuje GTFS-RT vozidla PID/Golemio a publikuje živý dopravní kontext ve vrstvě `traffic`.
- U komerčního použití musí být vyřešená ODbL atribuce a share-alike povinnosti.
- OpenSky nezapínej bez ověření oprávnění nebo písemné licence.
- Perzistentní data jsou v Docker volume `sim-data`, `flight-data` a `situation-data`.
- Web kontejner přes nginx proxy předává `/api`, `/health`, `/metrics`, `/mock-cop`, `/flight-data/*` a `/situation-data/*` do příslušných API kontejnerů.
