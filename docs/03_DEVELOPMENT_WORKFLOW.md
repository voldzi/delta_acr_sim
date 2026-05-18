# Vývojový workflow

**Status:** Baseline dokumentace

## Princip

Vývoj SIM systému probíhá documentation-first a API-first. Nejprve se aktualizují požadavky, kontrakty, OpenAPI, JSON Schema a ADR, potom se mění implementace.

## Doporučené kroky změny

- Zkontrolovat relevantní dokumenty v `docs/` a otevřené otázky.
- Upravit kontrakty nebo ADR, pokud změna mění integrační chování.
- Doplnit nebo upravit OpenAPI a JSON Schema skeleton.
- Implementovat změnu v aplikaci až po sjednocení kontraktu.
- Doplnit contract, unit, integration a guardrail testy podle dopadu.
- Ověřit quality gates a aktualizovat runbooky.

## Větvení budoucí implementace

Po vzniku kódu se doporučuje krátká feature větev pro každou změnu. Contract-breaking změny nesmí být slučovány bez nové verze kontraktu a migračního plánu.

## Revize

Code review má kromě kódu kontrolovat syntetické označení dat, absenci zakázaných workflow, validaci schémat, auditní stopu AI a chování publisheru při chybách.
