# COP Air & Situation Simulator

Samostatný pilotní SIM systém pro generování syntetických dat, řízení scénářů, dry-run/mock publisher workflow, AI Scenario Assistant draft workflow, Flight Data API pro agregaci veřejných nebo licencovaných letových zdrojů, Situation Data API pro mapové open-data vrstvy a Safety Data API pro veřejné bezpečnostní výstrahy.

## Lokální spuštění

```bash
pnpm install
pnpm dev
```

- API: `http://localhost:4000`
- Flight Data API: `http://localhost:4010`
- Situation Data API: `http://localhost:4020`
- Safety Data API: `http://localhost:4030`
- Web: `http://localhost:5173`
- Health: `http://localhost:4000/health/live`

## Docker Compose

```bash
cp .env.example .env
docker compose up -d --build
```

Výchozí port web/API gateway je `5020`:

```text
http://localhost:5020
http://localhost:5020/flight-data/health/ready
http://localhost:5020/flight-data/api/v1/cop/tracks
http://localhost:5020/situation-data/health/ready
http://localhost:5020/situation-data/api/v1/cop/features
http://localhost:5020/safety-data/health/ready
http://localhost:5020/safety-data/api/v1/cop/features
http://localhost:5020/tak-gateway/health/ready
http://localhost:5020/tak-gateway/api/v1/cop/features
```

## Pilot na docker.home.cz

Deployment poznámky jsou v [deploy/docker-home.md](deploy/docker-home.md). Cílový port je `5020` a výchozí publisher režim je `DRY_RUN`.

## Flight Data API

Dokumentace nové služby je v [docs/flight-data/00_INDEX.md](docs/flight-data/00_INDEX.md), COP kontrakt v [docs/integration/08_FLIGHT_DATA_SOURCE_CONTRACT.md](docs/integration/08_FLIGHT_DATA_SOURCE_CONTRACT.md) a OpenAPI v [docs/api/openapi-flight-data.yaml](docs/api/openapi-flight-data.yaml).

Lokální výchozí zdroj je bezpečný `mock`. Pilotní nasazení na `sim.zeleznalady.cz` je připravené pro COP jako reálný ADSB.lol feed přes `FLIGHT_DATA_ENABLED_SOURCES=adsb_lol`. OpenSky se zapíná pouze po ověření oprávnění nebo licence.

## Situation Data API

Dokumentace služby je v [docs/situation-data/00_INDEX.md](docs/situation-data/00_INDEX.md), COP kontrakt v [docs/integration/09_SITUATION_DATA_SOURCE_CONTRACT.md](docs/integration/09_SITUATION_DATA_SOURCE_CONTRACT.md) a OpenAPI v [docs/api/openapi-situation-data.yaml](docs/api/openapi-situation-data.yaml).

Docker pilot ve výchozím nastavení zapíná reálné open-data zdroje `open_meteo,aviation_weather,ctu_nettest,pid_gtfs_rt,safety_data`. Pozemní referenční objekty z OpenStreetMap se v produkci zapínají přes `osm_postgis` až po importu do Patroni/PostGIS nebo lokálního rebuildovatelného PostGIS read-modelu. Veřejný `osm_overpass` je pouze vývojová záloha pro malé bbox dotazy.

## Safety Data API

COP kontrakt je v [docs/integration/10_SAFETY_DATA_SOURCE_CONTRACT.md](docs/integration/10_SAFETY_DATA_SOURCE_CONTRACT.md) a OpenAPI v [docs/api/openapi-safety-data.yaml](docs/api/openapi-safety-data.yaml).

Docker pilot zapíná reálné zdroje `chmi_alerts,chmi_hydro`, tedy ČHMÚ CAP výstrahy a hydrologické stanice. Stejná data jsou dostupná také jako kompatibilní projekce přes `situation-data` pomocí `layers=warnings,flood&source=safety_data`.

## TAK Gateway API

TAK Gateway přijímá Cursor-on-Target XML z TAK/ARDOS kompatibilních systémů a poskytuje COP normalizovanou GeoJSON projekci přes `/tak-gateway/api/v1/cop/features`. Ingest endpoint `/tak-gateway/api/v1/cot/events` je chráněný `TAK_GATEWAY_INGEST_TOKEN`; pro reálná partnerská data je read endpoint chráněný `TAK_GATEWAY_READ_TOKEN` a `TAK_GATEWAY_PUBLIC_READ=false`.

Dokumentace je v [docs/tak-gateway/00_INDEX.md](docs/tak-gateway/00_INDEX.md), COP kontrakt v [docs/integration/13_TAK_GATEWAY_CONTRACT.md](docs/integration/13_TAK_GATEWAY_CONTRACT.md) a OpenAPI v [docs/api/openapi-tak-gateway.yaml](docs/api/openapi-tak-gateway.yaml).

## Bezpečnostní hranice

- Všechna generovaná data jsou syntetická.
- Publisher odmítá event bez `SYNTHETIC` handling caveat a `simulation.synthetic: true`.
- Flight Data API odděluje veřejná/licencovaná letová data od SIM syntetického publisheru.
- Situation Data API odděluje veřejné kontextové vrstvy od COP tracků a u každé feature nese licenci a atribuci.
- Safety Data API odděluje bezpečnostní výstrahy od obecného mapového kontextu a zachovává závažnost, platnost a atribuci původních open-data zdrojů.
- AI vrstva vytváří pouze draft, nikdy přímo nespouští scénář.
- Targeting, navádění, zbraňové workflow a taktické bojové doporučení jsou mimo rozsah.

## Ověření

```bash
pnpm typecheck
pnpm test
pnpm build
```
