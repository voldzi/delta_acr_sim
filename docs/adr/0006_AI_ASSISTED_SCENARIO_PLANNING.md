# ADR-0006: AI Assisted Scenario Planning

## Status
Proposed

## Context

AI může urychlit tvorbu syntetických scénářů, ale má bezpečnostní omezení.

## Decision

AI bude vytvářet pouze drafty syntetických scénářů s policy kontrolou, schema validací a human review.

## Consequences

Zlepšuje produktivitu, ale vyžaduje guardrails, audit a možnost vypnout externí AI.

## Alternatives Considered

Přímé AI spouštění scénářů; odmítnuto kvůli riziku nevalidního nebo nevhodného výstupu.

## Follow-up Actions

Implementovat AI guardrail testy a structured output validaci.
