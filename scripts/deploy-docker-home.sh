#!/usr/bin/env bash
set -euo pipefail

cd /srv/sim

if [ ! -d .git ]; then
  git clone https://github.com/voldzi/delta_acr_sim.git .
else
  git pull --ff-only
fi

cat > .env <<'ENV'
SIM_WEB_PORT=5020
API_PORT=4000
SIM_PUBLISHER_MODE=DRY_RUN
SIM_SOURCE_SYSTEM_ID=sim-air-situation-001
SIM_ADAPTER_VERSION=0.1.0
SIM_DATA_DIR=/data
MAIN_COP_BASE_URL=http://sim-api:4000/mock-cop
EXTERNAL_AI_ALLOWED=false
ENV

docker compose up -d --build
docker compose ps
curl -fsS http://localhost:5020/health/live
