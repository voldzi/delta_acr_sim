# Observability

**Status:** Implementováno pro SIM Overview; OpenTelemetry je připravené jako
volitelný opt-in tracing profil podle
[ADR 0011](../adr/0011_OPENTELEMETRY_OBSERVABILITY_ROLLOUT.md).

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

## OpenTelemetry stav

OpenTelemetry je implementované jako bezpečný opt-in skeleton:

- sdílený balíček `packages/observability` s lehkým OTLP HTTP exportem,
- volitelná inicializace přes `OTEL_SDK_DISABLED=false`,
- interní `otel-collector` v Docker Compose profilu `observability`,
- inbound Express tracing pro všech pět Node API služeb,
- W3C `traceparent` propagation a zachování `correlationId`,
- žádný OTLP, collector UI, raw traces ani interní metriky nejsou proxyované
  přes veřejný `sim-web`.

Výchozí stav zůstává vypnutý:

```bash
SIM_OTEL_SDK_DISABLED=true
```

Tracing se zapíná pouze explicitně:

```bash
SIM_OTEL_SDK_DISABLED=false
SIM_OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
docker compose --profile observability up -d --build
```

Aktuální první fáze pokrývá základní provozní dohled přes health/readiness,
interní Prometheus-style metriky, sanitizované Overview endpointy a inbound
HTTP traces. Další fáze ještě nepokrývá detailní span vazby napříč:

- SIM web -> simulator API,
- provider API -> externí open-data zdroje,
- situation/safety API -> PostGIS a Valkey,
- TAK ingest -> normalized COP feature projection,
- COP server-side adapter -> SIM provider endpointy.

## OpenTelemetry cílový postup

1. Zachovat stávající `/metrics` jako interní Prometheus kompatibilní kanál.
2. Instrumentovat outbound fetches, PostGIS, Valkey a publisher/COP volání.
3. Vyhodnotit, zda zůstat u lehkého OTLP exportu, nebo později přejít na plný
   OpenTelemetry Node SDK, až bude v lokálním/produkčním runtime stabilní.
4. Přidat export do finálního backendu: Grafana Tempo, Jaeger nebo jiný OTLP
   kompatibilní systém.
5. Doplnit dashboard pro trace latency, error rate, upstream latency a cache
   impact.
6. Do spanů ukládat pouze bezpečná metadata: název zdroje, cache status, HTTP
   status, latenci, počet prvků, stale/degraded stav. Neukládat raw payloady,
   tokeny, osobní data, TAK XML ani přesné citlivé partner informace.

## OpenTelemetry ověření

```bash
docker compose --profile observability up -d otel-collector
docker compose logs --tail=50 otel-collector
SIM_OTEL_SDK_DISABLED=false docker compose --profile observability up -d --build sim-api
curl -fsS http://localhost:5020/health/live
docker compose logs --tail=100 otel-collector | grep -E 'csm-sim-api|OpenTelemetry'
```

Rollback:

```bash
SIM_OTEL_SDK_DISABLED=true docker compose up -d --build
docker compose --profile observability stop otel-collector
```

## Audit

Audit musí zachytit změny scénářů, runtime příkazy, publisher konfiguraci, AI prompty/odpovědi v redigované formě, guardrail rozhodnutí a operace s queue.
