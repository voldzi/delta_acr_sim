# CODEX PROMPT — Projekt 02 SIM: Dokumentační a architektonický baseline samostatného simulačního systému

Jsi CODEX spuštěný samostatně nad projektem:

`/Users/voldzi/Documents/Development/18 2026/DELTA_ACR/02 SIM`

Toto je samostatný projekt pro simulační systém. Projekt COP je samostatný projekt a bude se vyvíjet paralelně v jiné složce. Tvým cílem v tomto kroku není implementovat produkční aplikaci, ale vytvořit profesionální dokumentační, architektonický a integrační baseline pro samostatný simulační systém.

Autoritativní vstupní zadání je zde:

`/Users/voldzi/Documents/Development/18 2026/DELTA_ACR/02 SIM/docs/zadani_codex_simulacni_system_ai_v1.md`

Nejprve tento soubor načti, analyzuj a použij jako hlavní zdroj požadavků. Pokud soubor není dostupný, práci nezastavuj; vytvoř baseline podle níže uvedených požadavků a do `docs/06_OPEN_QUESTIONS.md` zapiš, že vstupní zadání nebylo nalezeno.

---

## 1. Cíl tohoto úkolu

Vytvoř jednotnou a profesionální dokumentační strukturu pro samostatný simulační systém.

SIM systém má být samostatná aplikace pro:

- generování syntetických dat,
- vlastní UI pro ovládání scénářů,
- scenario builder,
- scenario control,
- AI Scenario Assistant,
- aircraft / UAV / missile track simulation,
- friendly force simulation,
- rescue/crisis simulation,
- manual report simulation,
- fault injection,
- publisher vůči hlavní COP aplikaci,
- dry-run režim,
- publisher monitor,
- health/metrics,
- OpenAI / Codex / lokální LLM provider abstraction.

Projekt COP se v tomto repozitáři neimplementuje. SIM projekt ale musí obsahovat přesně popsaný publisher kontrakt, aby se mohl později napojit na samostatně vyvíjený COP projekt.

---

## 2. Zásadní pravidla

Neimplementuj nyní produkční backend, frontend ani simulační engine.

V tomto kroku vytvoř pouze:

- dokumentaci,
- architektonické návrhy,
- ADR záznamy,
- OpenAPI skeleton,
- JSON Schema skeletony,
- simulační datový model jako návrh,
- publisher kontrakt jako návrh,
- bezpečnostní koncept,
- AI governance koncept,
- UI/design koncept,
- runbooky,
- quality gates,
- prompt pro další CODEX krok.

Vytvářej pouze placeholdery tam, kde to pomáhá budoucímu vývoji.

Vše piš profesionálně česky. Technické termíny používej běžně anglicky, pokud je to v oboru přirozené.

Všechny nejasnosti zapiš do `docs/06_OPEN_QUESTIONS.md`.

Simulační systém generuje výhradně syntetická data. Nepřidávej žádné targetingové, zbraňové, naváděcí nebo bojové workflow.

---

## 3. Požadovaná struktura dokumentace

Vytvoř nebo sjednoť tuto strukturu:

```text
docs/
  00_INDEX.md
  01_PROJECT_OVERVIEW.md
  02_DOCUMENTATION_STANDARD.md
  03_DEVELOPMENT_WORKFLOW.md
  04_QUALITY_GATES.md
  05_GLOSSARY.md
  06_OPEN_QUESTIONS.md

  product/
    00_INDEX.md
    01_VISION_AND_SCOPE.md
    02_STAKEHOLDERS.md
    03_SYSTEM_BOUNDARIES.md
    04_MVP_SCOPE.md
    05_OUT_OF_SCOPE.md

  architecture/
    00_INDEX.md
    01_ARCHITECTURE_PRINCIPLES.md
    02_SYSTEM_CONTEXT.md
    03_CONTAINER_VIEW.md
    04_COMPONENT_VIEW.md
    05_DEPLOYMENT_VIEW.md
    06_PUBLISHER_ARCHITECTURE.md
    07_SCENARIO_ENGINE_ARCHITECTURE.md
    08_FAULT_INJECTION_ARCHITECTURE.md
    09_AI_ASSISTED_SCENARIO_PLANNING.md

  application/
    00_INDEX.md
    01_APPLICATION_OVERVIEW.md
    02_MODULES.md
    03_BACKEND_ARCHITECTURE.md
    04_FRONTEND_UI_ARCHITECTURE.md
    05_SCENARIO_BUILDER.md
    06_SCENARIO_CONTROL.md
    07_PUBLISHER_MONITOR.md
    08_FAULT_INJECTION.md
    09_OBSERVABILITY.md

  simulation/
    00_INDEX.md
    01_SIMULATION_MODEL.md
    02_AIRCRAFT_SIMULATOR.md
    03_UAV_SIMULATOR.md
    04_MISSILE_TRACK_SIMULATOR.md
    05_FRIENDLY_FORCE_SIMULATOR.md
    06_RESCUE_SIMULATOR.md
    07_REPORT_SIMULATOR.md
    08_SCENARIO_TEMPLATES.md
    09_SYNTHETIC_DATA_RULES.md

  integration/
    00_INDEX.md
    01_SHARED_INTEGRATION_CONTRACT.md
    02_SIMULATOR_TO_COP_CONTRACT.md
    03_PUBLISHER_CONTRACT.md
    04_RETRY_AND_BACKOFF.md
    05_ERROR_MODEL.md
    06_VERSIONING_POLICY.md
    07_DRY_RUN_MODE.md

  api/
    openapi-simulator.yaml
    schemas/
      scenario.schema.json
      scenario-block.schema.json
      fault-injection.schema.json
      publisher-config.schema.json
      simulator-event.schema.json
      canonical-event-envelope.schema.json
      ai-scenario-draft.schema.json

  ai/
    00_INDEX.md
    01_AI_ARCHITECTURE.md
    02_PROVIDER_ABSTRACTION.md
    03_OPENAI_PROVIDER.md
    04_CODEX_USAGE.md
    05_LOCAL_LLM_PROVIDER.md
    06_AI_GUARDRAILS.md
    07_AI_AUDIT_AND_LOGGING.md
    08_PROMPT_TEMPLATES.md
    09_STRUCTURED_OUTPUTS.md

  security/
    00_INDEX.md
    01_SECURITY_ARCHITECTURE.md
    02_ROLES_AND_PERMISSIONS.md
    03_API_AUTHENTICATION.md
    04_SECRET_MANAGEMENT.md
    05_AUDIT.md
    06_SYNTHETIC_DATA_SAFETY.md
    07_THREAT_MODEL.md

  ui/
    00_INDEX.md
    01_UI_DESIGN_PRINCIPLES.md
    02_DASHBOARD.md
    03_SCENARIO_BUILDER.md
    04_SCENARIO_CONTROL.md
    05_AIR_SITUATION_PANEL.md
    06_FAULT_INJECTION_PANEL.md
    07_PUBLISHER_MONITOR.md
    08_AI_SCENARIO_ASSISTANT.md
    09_CONFIGURATION.md

  testing/
    00_INDEX.md
    01_TEST_STRATEGY.md
    02_CONTRACT_TESTING.md
    03_LOAD_TESTING.md
    04_PUBLISHER_TESTING.md
    05_AI_GUARDRAIL_TESTING.md
    06_ACCEPTANCE_CRITERIA.md

  runbooks/
    00_INDEX.md
    01_LOCAL_DEVELOPMENT.md
    02_DOCKER_COMPOSE.md
    03_ENVIRONMENT_CONFIGURATION.md
    04_RUNNING_SIMULATOR.md
    05_CONNECTING_TO_COP.md
    06_RUNNING_DEMO_SCENARIOS.md
    07_DRY_RUN_MODE.md

  adr/
    0000_ADR_TEMPLATE.md
    0001_DOCUMENTATION_FIRST_APPROACH.md
    0002_SEPARATE_SIM_AND_COP_PROJECTS.md
    0003_SIMULATOR_AS_EXTERNAL_DATA_SOURCE.md
    0004_SHARED_INTEGRATION_CONTRACT.md
    0005_SYNTHETIC_DATA_ONLY.md
    0006_AI_ASSISTED_SCENARIO_PLANNING.md
    0007_PROVIDER_ABSTRACTION_FOR_AI.md
    0008_PERSISTENT_PUBLISHER_QUEUE.md

  prompts/
    00_INDEX.md
    01_NEXT_CODEX_PROMPT_SIM_SKELETON.md
    02_NEXT_CODEX_PROMPT_SCENARIO_ENGINE.md
    03_NEXT_CODEX_PROMPT_PUBLISHER_CLIENT.md
    04_NEXT_CODEX_PROMPT_AI_ASSISTANT.md
```

---

## 4. Klíčový obsah

### 4.1 `docs/architecture/01_ARCHITECTURE_PRINCIPLES.md`

Definuj principy:

- documentation-first,
- simulator as external data source,
- synthetic-data-only,
- API-first,
- explicit contracts,
- independent deployability,
- reproducible scenarios,
- deterministic seeds,
- observable simulation runtime,
- persistent publisher queue,
- dry-run support,
- provider abstraction for AI,
- no targeting / no weapon workflow.

### 4.2 `docs/integration/01_SHARED_INTEGRATION_CONTRACT.md`

Tento dokument je kritický. Musí být kompatibilní s COP projektem.

Popiš:

- odpovědnosti SIM systému,
- odpovědnosti COP systému,
- hranici mezi projekty,
- pravidla verzování kontraktu,
- autentizaci,
- sourceSystemId,
- adapterVersion,
- eventId,
- correlationId,
- idempotency,
- producerTimestamp,
- ingestTimestamp,
- klasifikaci,
- povinné označení `SYNTHETIC`,
- error model,
- retry/backoff,
- schema validation,
- breaking changes policy.

Vytvoř verzi kontraktu jako `Shared Integration Contract v1`.

Důležité: Nepředpokládej, že COP projekt existuje nebo běží. SIM projekt musí mít dry-run režim a mock COP endpoint pro testy.

### 4.3 `docs/api/openapi-simulator.yaml`

Vytvoř validní OpenAPI 3.1 skeleton s endpointy:

- `POST /api/v1/scenarios`
- `GET /api/v1/scenarios`
- `GET /api/v1/scenarios/{scenarioId}`
- `PATCH /api/v1/scenarios/{scenarioId}`
- `DELETE /api/v1/scenarios/{scenarioId}`
- `POST /api/v1/scenarios/{scenarioId}/start`
- `POST /api/v1/scenarios/{scenarioId}/pause`
- `POST /api/v1/scenarios/{scenarioId}/resume`
- `POST /api/v1/scenarios/{scenarioId}/stop`
- `POST /api/v1/scenarios/{scenarioId}/reset`
- `POST /api/v1/scenarios/{scenarioId}/step`
- `POST /api/v1/scenarios/{scenarioId}/faults`
- `GET /api/v1/scenarios/{scenarioId}/faults`
- `DELETE /api/v1/scenarios/{scenarioId}/faults/{faultId}`
- `GET /api/v1/runtime/status`
- `GET /api/v1/runtime/metrics`
- `GET /api/v1/runtime/blocks`
- `GET /api/v1/runtime/publisher`
- `POST /api/v1/publisher/test-connection`
- `POST /api/v1/publisher/send-sample`
- `GET /api/v1/publisher/queue`
- `POST /api/v1/publisher/queue/retry`
- `POST /api/v1/publisher/queue/clear`
- `POST /api/v1/ai/scenario-drafts`
- `GET /api/v1/ai/scenario-drafts/{draftId}`
- `POST /api/v1/ai/scenario-drafts/{draftId}/validate`
- `POST /api/v1/ai/scenario-drafts/{draftId}/accept`
- `POST /api/v1/ai/scenario-drafts/{draftId}/reject`
- `GET /api/v1/ai/providers`
- `PATCH /api/v1/ai/config`
- `GET /health/live`
- `GET /health/ready`
- `GET /health/dependencies`
- `GET /metrics`

Použij odkazy na JSON Schema soubory v `docs/api/schemas`.

### 4.4 JSON Schema skeletony

Vytvoř validní JSON Schema skeletony pro:

- `scenario.schema.json`
- `scenario-block.schema.json`
- `fault-injection.schema.json`
- `publisher-config.schema.json`
- `simulator-event.schema.json`
- `canonical-event-envelope.schema.json`
- `ai-scenario-draft.schema.json`

### 4.5 `docs/simulation/01_SIMULATION_MODEL.md`

Popiš simulační model.

Musí obsahovat:

- scenario,
- scenario block,
- seed,
- area,
- duration,
- update rate,
- object count,
- aircraft tracks,
- UAV tracks,
- missile tracks,
- friendly force tracks,
- rescue incidents,
- manual reports,
- fault injection,
- reproducibility,
- synthetic data marking.

### 4.6 `docs/ai/01_AI_ARCHITECTURE.md`

Navrhni AI vrstvu pro SIM systém.

Podporovaní provideři:

- OpenAI,
- Codex,
- lokální LLM,
- mock provider.

AI v SIM smí pomáhat s:

- návrhem syntetického scénáře,
- převodem slovního zadání na JSON scénář,
- návrhem fault injection,
- návrhem load testu,
- vysvětlením scénáře,
- tvorbou demo scénáře,
- validací konzistence scénáře,
- generováním dokumentace scénáře.

AI v SIM nesmí:

- plánovat reálnou bojovou misi,
- vybírat cíle,
- prioritizovat cíle pro zásah,
- doporučovat použití síly,
- navádět prostředky,
- optimalizovat útok,
- poskytovat taktické bojové doporučení.

Popiš:

- provider abstraction,
- AI Scenario Assistant,
- structured output,
- JSON Schema validation,
- guardrails,
- audit,
- redaction/anonymization,
- human-in-the-loop,
- možnost vypnout externí AI,
- local-only režim,
- mock provider pro testy.

### 4.7 `docs/ui/08_AI_SCENARIO_ASSISTANT.md`

Popiš UI panel AI asistenta.

Musí obsahovat:

- textové zadání,
- výběr účelu scénáře,
- výběr povolených simulačních bloků,
- limit objektů,
- limit délky scénáře,
- generate draft,
- validate draft,
- accept draft,
- reject draft,
- zobrazení důvodů odmítnutí,
- auditní stopu.

### 4.8 `docs/integration/03_PUBLISHER_CONTRACT.md`

Popiš publisher vůči hlavní COP aplikaci.

Musí obsahovat:

- cílové COP endpointy,
- API konfiguraci,
- autentizaci,
- idempotency,
- retry/backoff,
- persistent queue,
- dead-letter queue,
- dry-run,
- mock mode,
- batch sending,
- error handling,
- observability,
- okamžité zastavení publikace.

### 4.9 ADR

Vytvoř všechny ADR podle struktury.

Každý ADR musí mít:

```md
# ADR-XXXX: Název

## Status
Proposed / Accepted / Deprecated

## Context

## Decision

## Consequences

## Alternatives Considered

## Follow-up Actions
```

---

## 5. Diagramy

Použij Mermaid.

Vytvoř minimálně:

- system context diagram,
- container diagram SIM systému,
- simulator component diagram,
- scenario engine flow,
- publisher flow to COP,
- dry-run flow,
- AI provider abstraction diagram,
- AI scenario draft workflow,
- fault injection flow,
- runtime state diagram.

---

## 6. Quality gates

V `docs/04_QUALITY_GATES.md` definuj:

- všechny dokumenty musí být nalinkované z indexů,
- každý adresář musí mít `00_INDEX.md`,
- OpenAPI musí být validní YAML,
- JSON Schema musí být validní JSON,
- Mermaid diagramy musí být syntakticky validní,
- ADR musí být číslované,
- každá změna publisher kontraktu musí mít verzi a ADR,
- každá AI změna musí popsat bezpečnostní dopad,
- každá bezpečnostní změna musí aktualizovat threat model,
- žádné zásadní TBD bez zápisu do `docs/06_OPEN_QUESTIONS.md`.

---

## 7. Po dokončení vypiš

Na konci práce vypiš:

1. seznam vytvořených souborů,
2. stručné shrnutí architektury,
3. klíčová rozhodnutí,
4. otevřené otázky,
5. doporučený další prompt pro implementaci skeletonu SIM aplikace,
6. doporučený další prompt pro vytvoření publisher clientu,
7. doporučený další prompt pro contract testy proti COP projektu.

---

## 8. Pracovní postup

1. Zkontroluj aktuální složku projektu.
2. Načti `docs/zadani_codex_simulacni_system_ai_v1.md`.
3. Vytvoř dokumentační strom.
4. Vytvoř indexy.
5. Vytvoř architekturu.
6. Vytvoř shared integration contract v1.
7. Vytvoř publisher contract.
8. Vytvoř OpenAPI skeleton.
9. Vytvoř JSON Schema skeletony.
10. Vytvoř AI dokumentaci.
11. Vytvoř UI dokumentaci.
12. Vytvoř simulation model dokumentaci.
13. Vytvoř security dokumentaci.
14. Vytvoř ADR.
15. Zkontroluj konzistenci a cross-linky.
16. Vypiš závěrečné shrnutí.

Začni tímto dokumentačním a architektonickým baseline úkolem pro projekt 02 SIM.
