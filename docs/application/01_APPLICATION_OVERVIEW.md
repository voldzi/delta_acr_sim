# Application overview

**Status:** Baseline dokumentace

## Aplikační vrstvy

- Web UI pro operátory, vývojáře a QA.
- Backend API pro scénáře, runtime, publisher, AI a konfiguraci.
- Simulation core a bloky oddělené od publisheru.
- Publisher client oddělený od engine kvůli idempotency, queue a retry.
- AI assistant oddělený od runtime kvůli guardrails a human-in-the-loop.

## Základní pravidlo

Aplikace nesmí umožnit spuštění scénáře, který neprošel schema validation, synthetic-data safety check a bezpečnostními guardrails.
