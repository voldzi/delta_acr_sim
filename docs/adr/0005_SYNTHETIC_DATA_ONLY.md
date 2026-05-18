# ADR-0005: Synthetic Data Only

## Status
Accepted

## Context

SIM má sloužit výhradně pro laboratorní a vývojové testy.

## Decision

Každý event musí obsahovat `SYNTHETIC` handling caveat a `simulation.synthetic: true`. Reálná operační data jsou mimo rozsah.

## Consequences

Snižuje bezpečnostní riziko a jasně odděluje simulátor od operačních zdrojů.

## Alternatives Considered

Volitelný import reálných dat; odmítnuto pro tento projektový baseline.

## Follow-up Actions

Publisher a schema validátory musí odmítnout event bez syntetického označení.
