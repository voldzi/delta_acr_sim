# MVP scope

**Status:** Baseline dokumentace

## MVP funkce

- Správa scénářů přes API a UI.
- Start, pause, resume, stop, reset a step runtime control.
- Aircraft, UAV a missile-track bloky; friendly, rescue a report bloky jako skeleton s jasným kontraktem.
- Fault injection pro delay, duplicate, source outage, conflict, degraded accuracy, reconnect burst a batch replay.
- Publisher queue s idempotency, retry/backoff, dry-run a batch sending.
- Health, readiness, dependencies a Prometheus-style metrics endpoints.
- AI Scenario Assistant s mock providerem a připravenou abstrakcí pro OpenAI, Codex a lokální LLM.

## MVP akceptace

MVP musí umožnit spustit syntetický scénář bez COP, validovat payloady proti schématům a demonstrovat publisher chování proti mock endpointu.
