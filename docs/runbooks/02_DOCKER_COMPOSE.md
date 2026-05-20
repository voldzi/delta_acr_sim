# Docker Compose runbook

**Status:** Baseline dokumentace

## Cíl

Budoucí Docker Compose má spustit web, API, store, queue a mock COP endpoint pro integrační testy.

## Služby

- simulator-web
- simulator-api
- flight-data-api
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
