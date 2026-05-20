# COP Air & Situation Simulator

Samostatný pilotní SIM systém pro generování syntetických dat, řízení scénářů, dry-run/mock publisher workflow, AI Scenario Assistant draft workflow a samostatné Flight Data API pro agregaci veřejných nebo licencovaných letových zdrojů.

## Lokální spuštění

```bash
pnpm install
pnpm dev
```

- API: `http://localhost:4000`
- Flight Data API: `http://localhost:4010`
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
```

## Pilot na docker.home.cz

Deployment poznámky jsou v [deploy/docker-home.md](deploy/docker-home.md). Cílový port je `5020` a výchozí publisher režim je `DRY_RUN`.

## Flight Data API

Dokumentace nové služby je v [docs/flight-data/00_INDEX.md](docs/flight-data/00_INDEX.md), COP kontrakt v [docs/integration/08_FLIGHT_DATA_SOURCE_CONTRACT.md](docs/integration/08_FLIGHT_DATA_SOURCE_CONTRACT.md) a OpenAPI v [docs/api/openapi-flight-data.yaml](docs/api/openapi-flight-data.yaml).

Lokální výchozí zdroj je bezpečný `mock`. Pilotní nasazení na `sim.zeleznalady.cz` je připravené pro COP jako reálný ADSB.lol feed přes `FLIGHT_DATA_ENABLED_SOURCES=adsb_lol`. OpenSky se zapíná pouze po ověření oprávnění nebo licence.

## Bezpečnostní hranice

- Všechna generovaná data jsou syntetická.
- Publisher odmítá event bez `SYNTHETIC` handling caveat a `simulation.synthetic: true`.
- Flight Data API odděluje veřejná/licencovaná letová data od SIM syntetického publisheru.
- AI vrstva vytváří pouze draft, nikdy přímo nespouští scénář.
- Targeting, navádění, zbraňové workflow a taktické bojové doporučení jsou mimo rozsah.

## Ověření

```bash
pnpm typecheck
pnpm test
pnpm build
```
