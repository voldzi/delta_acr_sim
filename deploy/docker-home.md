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
FLIGHT_DATA_STALE_AFTER_SECONDS=120
FLIGHT_DATA_REQUEST_TIMEOUT_MS=8000
SITUATION_DATA_ENABLED_SOURCES=mock,open_meteo
SITUATION_DATA_DEFAULT_BBOX=13.85,49.65,15.35,50.45
SITUATION_DATA_CACHE_TTL_SECONDS=30
SITUATION_DATA_STALE_AFTER_SECONDS=900
SITUATION_DATA_REQUEST_TIMEOUT_MS=8000
EOF

docker compose up -d --build
docker compose ps
curl -fsS http://localhost:5020/health/live
curl -fsS http://localhost:5020/flight-data/health/ready
curl -fsS http://localhost:5020/situation-data/health/ready
curl -fsS 'http://localhost:5020/situation-data/api/v1/cop/features?layers=weather,mobile&limit=10'
```

## URL

```text
http://docker.home.cz:5020
```

## Poznámky

- Výchozí režim je `DRY_RUN`.
- Pro LIVE publikování do COP nastav `SIM_PUBLISHER_MODE=LIVE`, `MAIN_COP_BASE_URL=http://172.17.0.1:4310` a `MAIN_COP_BEARER_TOKEN` na stejnou hodnotu jako `COP_LAB_TOKEN` v COP.
- Flight Data API pro integrační pilot COP běží proti ADSB.lol: `FLIGHT_DATA_ENABLED_SOURCES=adsb_lol`.
- Pro offline test nastav `FLIGHT_DATA_ENABLED_SOURCES=mock`.
- Situation Data API ve výchozím pilotu používá `mock,open_meteo`: stabilní integrační features a živé počasí bez API klíče.
- `SITUATION_DATA_ENABLED_SOURCES=osm_overpass` zapínej jen pro malé bbox dotazy a nízkou frekvenci; veřejné Overpass instance jsou sdílený zdroj.
- U komerčního použití musí být vyřešená ODbL atribuce a share-alike povinnosti.
- OpenSky nezapínej bez ověření oprávnění nebo písemné licence.
- Perzistentní data jsou v Docker volume `sim-data`, `flight-data` a `situation-data`.
- Web kontejner přes nginx proxy předává `/api`, `/health`, `/metrics`, `/mock-cop`, `/flight-data/*` a `/situation-data/*` do příslušných API kontejnerů.
