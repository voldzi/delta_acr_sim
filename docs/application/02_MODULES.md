# Moduly aplikace

**Status:** Baseline dokumentace

## Navržené moduly

- `simulator-web`: frontend UI.
- `simulator-api`: REST API, auth, validation, orchestration.
- `simulation-core`: runtime lifecycle, scheduler, seeds.
- `simulation-blocks`: aircraft, UAV, missile-track, friendly, rescue a report bloky.
- `event-contracts`: JSON Schema, canonical envelope typy a validátory.
- `publisher-client`: COP client, persistent queue, retry/backoff, dry-run.
- `ai-assistant`: draft workflow, provider abstraction, structured output.
- `ai-guardrails`: policy classifier, prohibited content checks a audit.
- `ui-components`: sdílené UI komponenty po vzniku frontend kódu.

## Závislosti

Moduly s kontrakty nesmí záviset na UI. Simulation blocks nesmí přímo volat COP ani AI providery.
