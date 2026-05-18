# ADR-0003: Simulator As External Data Source

## Status
Accepted

## Context

COP má přijímat data z více zdrojů. SIM je laboratorní syntetický zdroj.

## Decision

SIM vystupuje jako externí SourceSystem se `sourceSystemId`, adapter metadata a idempotency.

## Consequences

COP může simulátor revokovat nebo rate-limitovat stejně jako jiné zdroje. SIM nezná interní COP model.

## Alternatives Considered

Přímý zápis do COP databáze; odmítnuto kvůli porušení hranic a testovatelnosti.

## Follow-up Actions

Definovat registraci zdroje a auth režim s COP týmem.
