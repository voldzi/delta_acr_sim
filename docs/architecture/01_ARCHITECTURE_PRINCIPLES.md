# Architektonické principy

**Status:** Baseline dokumentace

## Závazné principy

- **Documentation-first:** zásadní rozhodnutí, kontrakty a bezpečnostní pravidla vznikají před implementací.
- **Simulator as external data source:** SIM vystupuje vůči COP pouze jako externí SourceSystem.
- **Synthetic-data-only:** každá událost je syntetická a musí obsahovat explicitní `SYNTHETIC` označení.
- **API-first:** veřejné chování je definované v OpenAPI a JSON Schema.
- **Explicit contracts:** integrace se mění pouze verzovaným kontraktem a ADR.
- **Independent deployability:** SIM lze vyvíjet, spustit a testovat bez běžící COP aplikace.
- **Reproducible scenarios:** scénáře musí být opakovatelné podle seed, konfigurace bloků a verze generátorů.
- **Deterministic seeds:** generátory používají deterministický seed a ukládají jeho hodnotu do auditovatelných metadat.
- **Observable simulation runtime:** runtime, publisher, AI a queue vystavují health, metrics a auditní logy.
- **Persistent publisher queue:** krátkodobý výpadek COP nesmí znamenat ztrátu eventů.
- **Dry-run support:** generování a validace musí fungovat bez odesílání do COP.
- **Provider abstraction for AI:** OpenAI, Codex, local LLM a mock provider sdílí jednotné rozhraní.
- **No targeting / no weapon workflow:** systém nesmí implementovat targeting, navádění ani bojová doporučení.

## Důsledek pro návrh

Komponenty musí být oddělené podle odpovědností: UI nesmí obsahovat simulační logiku, engine nesmí obcházet schema validation, publisher nesmí publikovat nevalidní nebo neoznačená data a AI nesmí přímo spouštět scénář bez lidského potvrzení.
