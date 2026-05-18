# ADR-0008: Persistent Publisher Queue

## Status
Proposed

## Context

Výpadek COP nebo sítě nesmí způsobit ztrátu syntetických eventů v laboratorním testu.

## Decision

Publisher bude používat persistent queue s retry/backoff, dead-letter queue a auditovanými stavy.

## Consequences

Zvyšuje spolehlivost a testovatelnost degraded režimů. Vyžaduje store a migrační strategii.

## Alternatives Considered

Pouze in-memory fronta; použitelná pro prototyp, ale nedostačuje pro požadavek restartu bez ztráty.

## Follow-up Actions

Vybrat store pro MVP a doplnit restart/recovery testy.
