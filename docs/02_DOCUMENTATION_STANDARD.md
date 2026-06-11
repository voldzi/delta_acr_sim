# Dokumentační standard

**Status:** Baseline dokumentace

## Jazyk a styl

- Dokumentace je psaná česky; běžné technické termíny jako API, publisher, schema, queue nebo guardrails zůstávají anglicky.
- Každý dokument musí jasně oddělit kontext, rozhodnutí, odpovědnosti a otevřené otázky.
- Placeholdery jsou povolené pouze tam, kde dokumentují budoucí implementační práci.

## Struktura

- Každý adresář v `docs/` musí mít `00_INDEX.md`.
- Kritické integrační a bezpečnostní dokumenty musí být linkované z kořenového indexu.
- `openapi/openapi.json` je autoritativní machine-readable OpenAPI kontrakt. JSON Schema soubory v `docs/api/schemas/` zůstávají kontrakty pro dílčí payloady.
- ADR se ukládají do `docs/adr/` a používají jednotnou šablonu.

## Diagramy

Diagramy se zapisují v Mermaid syntaxi. Každý diagram musí mít jasný účel a nesmí naznačovat targeting, navádění nebo zbraňové workflow.

## Změnový režim

Změna publisher kontraktu vyžaduje novou verzi kontraktu a ADR. Změna API musí aktualizovat `openapi/openapi.json`. Změna AI chování musí popsat bezpečnostní dopad a dopad na audit.
