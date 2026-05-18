# Frontend UI architektura

**Status:** Baseline dokumentace

## UI principy

- UI je pracovní nástroj pro opakované spouštění a dohled, ne marketingová stránka.
- Dashboard a monitorovací panely preferují husté, čitelné a skenovatelné informace.
- Akce měnící runtime nebo publisher vyžadují jasný stav, potvrzení tam, kde hrozí ztráta práce, a audit.
- AI návrhy se zobrazují jako draft s validací, důvody odmítnutí a explicitním accept/reject workflow.

## Stavová správa

Frontend má oddělit server state scénářů, runtime telemetry a lokální edit state builderu. Spuštění scénáře musí používat uloženou validovanou verzi, nikoliv neuložený lokální draft.
