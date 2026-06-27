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

SIM Overview načítá první obrazovku přes jeden lehký agregovaný endpoint:

- `GET /api/v1/operations/summary`

Endpoint běží v `simulator-api`, paralelně čte sanitizované health a
observability signály provider služeb a vrací bounded souhrn pro řídicí UI:

- celkový stav `ok` / `degraded` / `critical` / `unknown`,
- stav runtime, scénářů a publisher queue bez raw eventů,
- stav provider služeb, latence sondy, počet objektů, zapnuté zdroje,
- cache hit-rate/errors, shared cache stav a freshness/import age,
- provozní alerty odvozené z publisheru, providerů, stale importů a posledního
  periodického operational checku.

Endpoint nevrací raw mapové prvky, TAK XML, partner payloady, tokeny ani
interní metriky. SIM web ho používá pro Overview, aby první načtení
nevyvolávalo těžká `features` preview volání. Detailní sekce webu po odemčení
operátorského přístupu dál používají provider endpointy níže.

SIM Overview používá sanitizované endpointy v jednotlivých provider službách:

- `GET /flight-data/api/v1/observability`
- `GET /situation-data/api/v1/observability`
- `GET /safety-data/api/v1/observability`
- `GET /tak-gateway/api/v1/observability`

Overview zůstává lehký: pro první operační obrazovku načítá `operations/summary`
a provider `observability` endpointy, ale nenačítá těžké feature preview payloady.
Operátor tak v přehledu vidí detail cache/source cache, `lastSuccessAt`,
`lastErrorAt`, pressure a datová upozornění bez zbytečného zatížení mapových
providerů.

Tyto endpointy vrací pouze provozně bezpečný souhrn:

- aggregate cache: počet entries, hits, misses, hit-rate, stale hits, refreshes, errors, evictions, pressure, `lastSuccessAt` a `lastErrorAt`,
- source/reference cache: per-source cache hit-rate a stav; `degraded` znamená aktuální selhání, kdy poslední chyba nastala po posledním úspěšném refresh,
- shared cache: dostupnost sdílené cache, hit-rate, stale hits, writes a errors,
- latency: měřená latence načtení jednotlivých observability endpointů v SIM webu,
- import age / freshness: nejnovější a nejstarší dostupný import age, počet degradovaných zdrojů a quality warningů,
- TAK store: počty current/stale/invalid/dropped/auth failures/parse errors bez raw payloadů.

`GET /api/v1/operations/summary` odděluje technický stav služby od
interpretační kvality dat. Technické problémy mají `category=technical` a
`severity=warning|critical`; ty ovlivňují souhrnný status `degraded` nebo
`critical`. Datová omezení zdrojů, například historická měření ČTÚ nebo
odhadovaný stav mobilní sítě bez live BTS/NOC feedu, jsou vrácena jako
`category=data_quality` a `severity=info`. Tato upozornění zůstávají viditelná
operátorovi, ale sama o sobě nesnižují technický status služby.

Provider služby v `services[]` nesou `productionReadiness` a `lifecycle`.
Služby s `productionReadiness=false` jsou viditelné v diagnostice, ale
nevstupují do produkčního readiness/SLO rollupu ani negenerují technické alerty.
Aktuálně je takto vedená `tak-gateway-api`, protože jde o future modul bez
zapnutého reálného partnerského TAK/ARDOS feedu.

Všechny operační alerty nesou anglický text v `title/detail/impact/action` a
lokalizované texty v `localized.{title,detail,impact,action}.{cs,en}`. SIM web
zobrazuje text podle zvoleného jazyka operátora.

Globální hlášení SIM webu jsou interně uložená jako překladový zdroj a
parametry, ne jako jednorázově přeložený řetězec. Při přepnutí jazyka se proto
aktuální notice, role warningy a výsledky operátorských akcí vykreslí znovu v
češtině nebo angličtině bez ztráty kontextu.

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

## Provozní alerting

Produkční pilot na `docker.home.cz` používá host-level periodickou kontrolu:

```bash
python3 scripts/production-operational-check.py --env-file .env
```

Kontrola kombinuje provider smoke testy, data-plane smoke testy, DEM health,
terrain-aware mobile read-model ověření a kontrolu, že veřejné `/metrics`
zůstává skryté přes nginx. Výsledek zapisuje do
`data/operational-checks/latest.json`, stav pro deduplikaci alertů do
`data/operational-checks/state.json` a při změně stavu posílá syslog zprávu.
Volitelný `SIM_OPERATIONAL_ALERT_WEBHOOK_URL` odešle stejný bounded report jako
JSON webhook.

Součástí kontroly je SLO check nad veřejnou bránou:

- `/health/live` musí vrátit HTTP 200 do `SIM_OPERATIONAL_SLO_MAX_LIVE_LATENCY_MS`,
- `/api/v1/operations/summary` musí přes autentizovaný probe vrátit HTTP 200 do
  `SIM_OPERATIONAL_SLO_MAX_SUMMARY_LATENCY_MS`,
- produkční rollup musí být `ok`, pokud
  `SIM_OPERATIONAL_SLO_REQUIRE_OPERATIONS_OK=true`,
- všechny služby s `productionReadiness=true` musí mít `status=ok`,
- celý syntetický test se musí vejít do
  `SIM_OPERATIONAL_SLO_MAX_TOTAL_DURATION_MS`.

Periodické spouštění nastavuje:

```bash
scripts/install-production-operational-check-cron.sh
```

Detailní postup je v
[`docs/runbooks/14_OPERATIONAL_ALERTING.md`](../runbooks/14_OPERATIONAL_ALERTING.md).

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
