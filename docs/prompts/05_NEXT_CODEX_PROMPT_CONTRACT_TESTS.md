# Next CODEX prompt: Contract tests against COP

Vytvoř contract testy pro SIM publisher a mock COP ingest podle `docs/integration/01_SHARED_INTEGRATION_CONTRACT.md`, `docs/integration/03_PUBLISHER_CONTRACT.md`, `docs/api/openapi-simulator.yaml` a JSON Schema v `docs/api/schemas/*`.

Požadavky:

- Ověř validní single event a validní batch proti `canonical-event-envelope.schema.json`.
- Ověř povinné hlavičky `Authorization`, `X-Source-System-Id`, `X-Idempotency-Key`, `X-Contract-Version` a `X-Correlation-Id`.
- Ověř odmítnutí eventu bez `SYNTHETIC` handling caveat nebo bez `simulation.synthetic: true`.
- Ověř standardní error model pro `400`, `401`, `403`, `409`, `422`, `429` a `503`.
- Ověř retry/backoff, respektování `Retry-After`, idempotency retry a přesun do dead-letter queue.
- Ověř dry-run režim bez HTTP volání na COP a mock mode s deterministickými odpověďmi.
- Nepřidávej žádné reálné operační payloady, targeting, navádění ani zbraňové workflow.
