# Docker Compose runbook

**Status:** Baseline dokumentace

## Cíl

Budoucí Docker Compose má spustit web, API, store, queue a mock COP endpoint pro integrační testy.

## Služby

- simulator-web
- simulator-api
- postgres nebo sqlite volume
- redis nebo queue store
- mock-cop-ingest
- metrics endpoint

## Výchozí režim

Výchozí compose režim má být dry-run/mock a nesmí obsahovat produkční secrets.
