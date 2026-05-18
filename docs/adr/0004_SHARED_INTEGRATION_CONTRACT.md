# ADR-0004: Shared Integration Contract

## Status
Accepted

## Context

Paralelní vývoj SIM a COP vyžaduje stabilní, verzovaný kontrakt.

## Decision

Zavádí se Shared Integration Contract v1 s `cop-ingest-v1`, canonical envelope, error modelem, idempotency a retry pravidly.

## Consequences

Kontrakt je centrální integrační artefakt a změny vyžadují verzi a ADR.

## Alternatives Considered

Neformální domluva endpointů bez schémat; odmítnuto kvůli riziku driftu.

## Follow-up Actions

Implementovat contract testy a schema validaci v dalším kroku.
