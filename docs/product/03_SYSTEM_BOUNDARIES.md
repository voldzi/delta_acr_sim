# Hranice systému

**Status:** Baseline dokumentace

## Uvnitř SIM

- UI pro tvorbu a řízení scénářů.
- Backend API pro scénáře, runtime, publisher, fault injection a AI.
- Scenario engine a simulation blocks.
- Persistent publisher queue, retry/backoff, dry-run a mock mode.
- AI provider abstraction, guardrails, audit a structured outputs.

## Vně SIM

- COM/COP ingest API, canonical fusion, state management a distribuce.
- NATO symbol renderer hlavní COM/COP aplikace.
- Reálné senzory, operační zdroje, zbraňové systémy nebo targeting systémy.
- Externí AI služby mimo explicitně nakonfigurované provider režimy.

## Integrační hranice

Závazné hranice jsou Shared Integration Contract v1 pro syntetický publisher a Provider Map Catalog pro mapová provider data. SIM nesmí předpokládat, že COM/COP běží; musí podporovat dry-run a mock endpoint.
