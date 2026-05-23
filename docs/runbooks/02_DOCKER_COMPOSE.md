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

## Flight Data API routing

`simulator-web` proxy předává:

- `/flight-data/api/*` na `flight-data-api:4010/api/*`
- `/flight-data/health/*` na `flight-data-api:4010/health/*`
- `/flight-data/metrics` není veřejně proxyované přes web port

## Situation Data API routing

`simulator-web` proxy předává:

- `/situation-data/api/*` na `situation-data-api:4020/api/*`
- `/situation-data/health/*` na `situation-data-api:4020/health/*`
- `/situation-data/metrics` není veřejně proxyované přes web port

## Safety Data API routing

`simulator-web` proxy předává:

- `/safety-data/api/*` na `safety-data-api:4030/api/*`
- `/safety-data/health/*` na `safety-data-api:4030/health/*`
- `/safety-data/metrics` není veřejně proxyované přes web port

## TAK Gateway API routing

`simulator-web` proxy předává:

- `/tak-gateway/api/*` na `tak-gateway-api:4040/api/*`
- `/tak-gateway/health/*` na `tak-gateway-api:4040/health/*`
- `/tak-gateway/metrics` není veřejně proxyované přes web port
