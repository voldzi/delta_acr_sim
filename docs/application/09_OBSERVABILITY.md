# Observability

**Status:** Baseline dokumentace

## Health endpoints

- `GET /health/live`
- `GET /health/ready`
- `GET /health/dependencies`
- `GET /metrics`

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

## Audit

Audit musí zachytit změny scénářů, runtime příkazy, publisher konfiguraci, AI prompty/odpovědi v redigované formě, guardrail rozhodnutí a operace s queue.
