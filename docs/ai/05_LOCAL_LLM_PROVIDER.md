# Local LLM provider

**Status:** Baseline dokumentace

## Účel

Local LLM provider umožňuje local-only režim bez odeslání promptu externí službě.

## Požadavky

- Stejné provider rozhraní jako externí provideři.
- Structured output validovaný proti JSON Schema.
- Konfigurovatelné model path/runtime.
- Resource limity a timeouty.
- Audit rozhodnutí a chyb.

## Rizika

Lokální model může mít slabší instrukční spolehlivost, proto guardrails a schema validation zůstávají povinné.
