# ADR-0007: Provider Abstraction For AI

## Status
Proposed

## Context

SIM má podporovat OpenAI, Codex, lokální LLM a mock provider.

## Decision

AI vrstva použije provider abstraction se společným rozhraním, policy vstupem a structured output výstupem.

## Consequences

Umožní local-only režim a testy přes mock provider. Zvyšuje počáteční návrhovou komplexitu.

## Alternatives Considered

Pevné napojení na jednoho providera; odmítnuto kvůli provozním a bezpečnostním požadavkům.

## Follow-up Actions

Před implementací ověřit aktuální oficiální dokumentaci providerů.
