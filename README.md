# CSM SIM

SIM je samostatný datový a simulační provider pro centrální zobrazovací aplikaci COP. Generuje syntetické scénáře, provozuje dry-run/mock publisher workflow a poskytuje cacheované provider API pro mapové vrstvy: lety, počasí, bezpečnostní výstrahy, mobilní síť, OSM/PostGIS kontext a partnerské TAK/CoT streamy.

Veřejný klient COP má používat pouze COP endpointy `GET /api/v1/map/catalog` a `POST /api/v1/map/query`; SIM endpointy jsou server-side provider API.

## Lokální spuštění

```bash
# Node 24.x is required; .node-version and .nvmrc pin the local runtime.
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
http://localhost:5020/health/live
http://localhost:5020/flight-data/health/ready
http://localhost:5020/flight-data/api/v1/aircraft/positions
http://localhost:5020/situation-data/health/ready
http://localhost:5020/situation-data/api/v1/catalog
http://localhost:5020/situation-data/api/v1/features
http://localhost:5020/safety-data/health/ready
http://localhost:5020/safety-data/api/v1/features
http://localhost:5020/tak-gateway/health/ready
http://localhost:5020/tak-gateway/api/v1/features
```

Historické `/api/v1/cop/*` endpointy zůstávají pouze jako kompatibilní backend aliasy pro současné server-side adaptéry.

## Dokumentace

Aktivní dokumentační sada začíná v [docs/README.md](docs/README.md).
Kanonický machine-readable API kontrakt pro všechny REST plochy je
[openapi/openapi.json](openapi/openapi.json). Historické service-local YAML
snapshoty jsou archivované v [docs/archive/openapi-yaml/](docs/archive/openapi-yaml/).

## Provider kontrakt

Veřejná dokumentace pro další poskytovatele dat začíná v [docs/provider/00_INDEX.md](docs/provider/00_INDEX.md). Kanonický discovery endpoint SIM providera je:

```http
GET /situation-data/api/v1/catalog
```

Katalog odděluje uživatelské vrstvy od technických zdrojů. Například běžná občanská vrstva mobilní sítě je `public.mobile.network` / `mobile_network`; diagnostické vstupy `mobile_coverage_model`, `ctu_nettest` a OSM komunikační infrastruktura se nemají zobrazovat jako samostatné běžné vrstvy.

## Služby

- Flight Data API: agregované veřejné nebo licencované letové tracky, letiště a referenční data. Dokumentace je v [docs/flight-data/00_INDEX.md](docs/flight-data/00_INDEX.md).
- Situation Data API: cacheované mapové vrstvy pro počasí, OSM/PostGIS, mobilní síť, dopravu a kompatibilní safety projekce. Dokumentace je v [docs/situation-data/00_INDEX.md](docs/situation-data/00_INDEX.md).
- Safety Data API: veřejné bezpečnostní výstrahy a hydrologická data. Dokumentace je v [docs/integration/10_SAFETY_DATA_SOURCE_CONTRACT.md](docs/integration/10_SAFETY_DATA_SOURCE_CONTRACT.md).
- TAK Gateway API: chráněný partner ingest Cursor-on-Target XML a normalizovaná GeoJSON projekce pro COP backend. Dokumentace je v [docs/tak-gateway/00_INDEX.md](docs/tak-gateway/00_INDEX.md).

## Produkční poznámky

Deployment na `docker.home.cz` je v [deploy/docker-home.md](deploy/docker-home.md). Cílový port je `5020` a výchozí publisher režim je `DRY_RUN`.

Pozemní referenční objekty z OpenStreetMap se v produkci čtou přes `osm_postgis` nad Patroni/PostGIS nebo lokálním rebuildovatelným PostGIS read-modelem. Veřejný Overpass je pouze vývojová záloha pro malé bbox dotazy.

DEM katalog pro budoucí terrain-aware coverage model používá Copernicus DEM GLO-30: GeoTIFF/COG soubory v dedikovaném SIM SeaweedFS, lokální runtime cache a metadata v PostGIS. Postup je v [docs/runbooks/09_DEM_COPERNICUS_SEAWEEDFS_POSTGIS.md](docs/runbooks/09_DEM_COPERNICUS_SEAWEEDFS_POSTGIS.md).

## Bezpečnostní hranice

- Publisher odmítá syntetický event bez `SYNTHETIC` handling caveat a `simulation.synthetic: true`.
- Provider endpointy nejsou veřejný klientský kontrakt; tokeny a partner data drží server-side COP.
- TAK/CoT read endpoint má mít pro reálná data `TAK_GATEWAY_PUBLIC_READ=false` a nastavený `TAK_GATEWAY_READ_TOKEN`.
- Flight, Situation a Safety API oddělují licenci, atribuci, stale stav a varování zdrojů.
- AI vrstva vytváří pouze draft, nikdy přímo nespouští scénář.
- Targeting, navádění, zbraňové workflow a taktické bojové doporučení jsou mimo rozsah.

## Ověření

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm openapi:validate
bash scripts/validate-skeleton.sh
```
