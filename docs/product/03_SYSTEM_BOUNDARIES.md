# Hranice systému

**Status:** Baseline dokumentace

## Uvnitř SIM

- UI pro tvorbu a řízení scénářů.
- Backend API pro scénáře, runtime, publisher, fault injection a AI.
- Scenario engine a simulation blocks.
- Persistent publisher queue, retry/backoff, dry-run a mock mode.
- AI provider abstraction, guardrails, audit a structured outputs.

## Vně SIM

- COP ingest API, canonical fusion, COP state management a distribuce.
- NATO symbol renderer hlavní COP aplikace.
- Reálné senzory, operační zdroje, zbraňové systémy nebo targeting systémy.
- Externí AI služby mimo explicitně nakonfigurované provider režimy.

## Integrační hranice

Jedinou závaznou hranicí mezi SIM a COP je Shared Integration Contract v1 a jeho JSON Schema/OpenAPI dokumentace. SIM nesmí předpokládat, že COP běží; musí podporovat dry-run a mock endpoint.
