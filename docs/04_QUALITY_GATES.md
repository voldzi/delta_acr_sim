# Quality gates

**Status:** Baseline dokumentace

## Dokumentační gates

- Všechny dokumenty musí být nalinkované z odpovídajících indexů.
- Každý adresář pod `docs/` musí mít `00_INDEX.md`.
- Každý zásadní TBD musí být zapsán v `docs/06_OPEN_QUESTIONS.md`.
- ADR musí být číslované a používat jednotnou šablonu.
- Mermaid diagramy musí být syntakticky kontrolované před vydáním dokumentace.

## Kontraktační gates

- OpenAPI musí být validní YAML a musí obsahovat všechny veřejné endpointy simulátoru.
- JSON Schema soubory musí být validní JSON Schema draft 2020-12.
- Každá změna publisher kontraktu musí mít verzi a ADR.
- Každý event publikovaný do COP musí projít schema validation a obsahovat `SYNTHETIC` handling caveat.
- Breaking changes jsou povolené pouze s novou verzí kontraktu.

## Bezpečnostní gates

- Každá AI změna musí popsat bezpečnostní dopad a aktualizovat guardrails dokumentaci.
- Každá bezpečnostní změna musí aktualizovat threat model.
- Externí AI nesmí dostat reálná operační data ani secrets.
- Publisher musí mít okamžité zastavení publikace a audit změn konfigurace.
- SIM nesmí obsahovat targeting, zbraňové workflow, navádění ani taktická doporučení.

## Testovací gates

- Contract testy musí pokrýt validní event, nevalidní schema, idempotency, rate limit, retry a dry-run.
- AI guardrail testy musí pokrýt povolené i zakázané požadavky.
- Load testy musí mít syntetická data a explicitní limity objektů a update rate.
- Publisher queue musí mít test restartu a obnovy po výpadku.
