# ADR-0001: Documentation First Approach

## Status
Accepted

## Context

SIM projekt začíná jako samostatný systém s významnou integrační a bezpečnostní hranicí vůči COP.

## Decision

Nejprve se vytváří dokumentační, architektonický a kontraktační baseline. Produkční implementace bude následovat až po sjednocení kontraktů.

## Consequences

Snižuje riziko nekonzistentní implementace a usnadňuje paralelní vývoj COP. Vyžaduje disciplínu při aktualizaci dokumentace.

## Alternatives Considered

Začít rovnou implementací API a UI; tato varianta zvyšuje riziko chyb v kontraktu.

## Follow-up Actions

Při každé další implementační změně aktualizovat relevantní dokumenty a quality gates.
