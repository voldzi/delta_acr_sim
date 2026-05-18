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
EXTERNAL_AI_ALLOWED=false
EOF

docker compose up -d --build
docker compose ps
curl -fsS http://localhost:5020/health/live
```

## URL

```text
http://docker.home.cz:5020
```

## Poznámky

- Výchozí režim je `DRY_RUN`.
- Perzistentní data jsou v Docker volume `sim-data`.
- Web kontejner přes nginx proxy předává `/api`, `/health`, `/metrics` a `/mock-cop` do API kontejneru.
