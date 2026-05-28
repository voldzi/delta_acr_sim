# Observability

**Status:** Implementováno pro SIM Overview

## Health endpoints

- `GET /health/live`
- `GET /health/ready`
- `GET /health/dependencies`
- `GET /metrics`

Syrové Prometheus endpointy `/metrics` jsou interní. Veřejný SIM web je přes Nginx nepublikuje, aby nebyly vystavené provozní detaily a tokenové/integrační signály.

## Overview observability API

SIM Overview používá sanitizované endpointy v jednotlivých provider službách:

- `GET /flight-data/api/v1/observability`
- `GET /situation-data/api/v1/observability`
- `GET /safety-data/api/v1/observability`
- `GET /tak-gateway/api/v1/observability`

Tyto endpointy vrací pouze provozně bezpečný souhrn:

- aggregate cache: počet entries, hits, misses, hit-rate, stale hits, refreshes, errors, evictions a pressure,
- source/reference cache: per-source cache hit-rate a stav,
- shared cache: dostupnost sdílené cache, hit-rate, stale hits, writes a errors,
- latency: měřená latence načtení jednotlivých observability endpointů v SIM webu,
- import age / freshness: nejnovější a nejstarší dostupný import age, počet degradovaných zdrojů a quality warningů,
- TAK store: počty current/stale/invalid/dropped/auth failures/parse errors bez raw payloadů.

## Metriky

- generated events/s
- published events/s
- failed events/s
- publisher queue size
- dead-letter queue size
- ingest API latency
- active tracks
- active runtime
- AI request count
- AI rejection count
- fault injection active count
- cache hit-rate, misses, stale hits, evictions
- source cache health
- shared cache state
- import age / source freshness
- Overview load latency

## Audit

Audit musí zachytit změny scénářů, runtime příkazy, publisher konfiguraci, AI prompty/odpovědi v redigované formě, guardrail rozhodnutí a operace s queue.
