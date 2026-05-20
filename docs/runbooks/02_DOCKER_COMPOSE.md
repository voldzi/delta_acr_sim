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
- `/flight-data/metrics` na `flight-data-api:4010/metrics`

## Situation Data API routing

`simulator-web` proxy předává:

- `/situation-data/api/*` na `situation-data-api:4020/api/*`
- `/situation-data/health/*` na `situation-data-api:4020/health/*`
- `/situation-data/metrics` na `situation-data-api:4020/metrics`

## Safety Data API routing

`simulator-web` proxy předává:

- `/safety-data/api/*` na `safety-data-api:4030/api/*`
- `/safety-data/health/*` na `safety-data-api:4030/health/*`
- `/safety-data/metrics` na `safety-data-api:4030/metrics`
