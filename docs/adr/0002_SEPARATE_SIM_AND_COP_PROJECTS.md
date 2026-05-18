# ADR-0002: Separate SIM And COP Projects

## Status
Accepted

## Context

SIM a COP se mají vyvíjet paralelně v samostatných složkách/projektech.

## Decision

SIM nebude obsahovat COP implementaci a COP nebude runtime závislostí pro lokální vývoj SIM.

## Consequences

Vyžaduje pevný integrační kontrakt a mock/dry-run režim, ale umožňuje nezávislé nasazení a testování.

## Alternatives Considered

Monolit s COP a SIM v jednom projektu; odmítnuto kvůli těsné vazbě a vyššímu riziku regresí.

## Follow-up Actions

Udržovat Shared Integration Contract v1 a contract testy proti mock COP.
