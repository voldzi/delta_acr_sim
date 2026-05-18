# OpenAI provider

**Status:** Baseline dokumentace

## Účel

OpenAI provider je volitelný externí provider pro generování strukturovaných návrhů syntetických scénářů a jejich vysvětlení.

## Konfigurace

- API key přes secret store nebo environment.
- Model a timeout přes konfiguraci.
- Externí provider lze zakázat globálně nebo per request limitem.
- Žádné secrets ani reálná operační data se nesmí posílat do promptu.

## Poznámka k implementaci

Před implementací je nutné ověřit aktuální oficiální dokumentaci OpenAI pro Responses API, structured outputs, tool use a guardrails. Tento baseline neprovádí API integraci.
