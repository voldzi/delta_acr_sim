# Next CODEX prompt: Publisher client

Implementuj publisher client podle `docs/integration/01_SHARED_INTEGRATION_CONTRACT.md`, `docs/integration/03_PUBLISHER_CONTRACT.md` a `docs/architecture/06_PUBLISHER_ARCHITECTURE.md`.

Požadavky:

- Implementuj canonical envelope builder a validaci proti `canonical-event-envelope.schema.json`.
- Implementuj idempotency key, persistent queue interface, retry/backoff a dead-letter queue.
- Implementuj dry-run, mock mode a live mode konfiguraci.
- Přidej endpointy publisher monitoru podle OpenAPI.
- Přidej okamžité zastavení publikace bez smazání queue.
- Přidej testy pro 401, 403, 409, 422, 429, 503, síťový timeout, retry a DLQ.
