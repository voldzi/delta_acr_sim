# Docker Compose runbook

**Status:** Baseline dokumentace

## Cíl

Budoucí Docker Compose má spustit web, API, store, queue a mock COP endpoint pro integrační testy.

## Služby

- simulator-web
- simulator-api
- flight-data-api
- situation-data-api
- safety-data-api
- tak-gateway-api
- postgres nebo sqlite volume
- redis nebo queue store
- mock-cop-ingest
- metrics endpoint

## Výchozí režim

Výchozí compose režim má být dry-run/mock a nesmí obsahovat produkční secrets.

## Gateway DNS

Gateway používá Docker DNS resolver `127.0.0.11` a proměnné v `proxy_pass`,
aby po recreate backend kontejnerů nepoužívala staré IP adresy. Po běžném
`docker compose up -d --build` nemá být potřeba ruční restart `simulator-web`.
`sim-web` má compose healthcheck na `/health/live`; deploy skript před smoke
kontrolami čeká na Docker health stav `healthy` a funkční HTTP odpověď gateway.

Gateway zároveň drží krátkou stale cache pro GET provider API
`/flight-data/api/*`, `/situation-data/api/*` a `/safety-data/api/*`. Během
krátkého backend recreatu tak může vrátit poslední platnou odpověď místo
transientního `502`. Cache se obchází hlavičkou `Authorization` nebo query
parametrem `nocache`. Odpovědi z těchto gateway rout mají normalizované
`Cache-Control: private, max-age=10`.

## Flight Data API routing

`simulator-web` proxy předává:

- `/flight-data/api/*` na `flight-data-api:4010/api/*`
- `/flight-data/health/*` na `flight-data-api:4010/health/*`
- `/flight-data/metrics` není veřejně proxyované přes web port
- provider route jsou dostupné pouze z interních sítí/VPN/COP backendu; veřejný internet má dostat `403`

## Situation Data API routing

`simulator-web` proxy předává:

- `/situation-data/api/*` na `situation-data-api:4020/api/*`
- `/situation-data/health/*` na `situation-data-api:4020/health/*`
- `/situation-data/metrics` není veřejně proxyované přes web port
- provider route jsou dostupné pouze z interních sítí/VPN/COP backendu; veřejný internet má dostat `403`

## Safety Data API routing

`simulator-web` proxy předává:

- `/safety-data/api/*` na `safety-data-api:4030/api/*`
- `/safety-data/health/*` na `safety-data-api:4030/health/*`
- `/safety-data/metrics` není veřejně proxyované přes web port
- provider route jsou dostupné pouze z interních sítí/VPN/COP backendu; veřejný internet má dostat `403`

## TAK Gateway API routing

`simulator-web` proxy předává:

- `/tak-gateway/api/*` na `tak-gateway-api:4040/api/*`
- `/tak-gateway/health/*` na `tak-gateway-api:4040/health/*`
- `/tak-gateway/metrics` není veřejně proxyované přes web port
- provider route jsou dostupné pouze z interních sítí/VPN/COP backendu; veřejný internet má dostat `403`

## Public routing

Veřejná adresa `sim.zeleznalady.cz` není frontend pro koncové uživatele. COP je jediný frontend.

Veřejně smějí zůstat pouze:

- `/health/live`
- `/docs/`
- statické manifest/icon soubory potřebné pro dokumentační stránku

Podrobný postup je v [12_PROVIDER_ACCESS_CONTROL.md](12_PROVIDER_ACCESS_CONTROL.md).
