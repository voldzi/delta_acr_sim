# Next CODEX prompt: Scenario engine

Rozšiř SIM skeleton o deterministický scenario engine podle `docs/simulation/01_SIMULATION_MODEL.md` a `docs/architecture/07_SCENARIO_ENGINE_ARCHITECTURE.md`.

Požadavky:

- Implementuj lifecycle `DRAFT`, `READY`, `RUNNING`, `PAUSED`, `STOPPED`, `ERROR`.
- Implementuj deterministic seed handling a scheduler tick.
- Přidej skeleton bloky `air-sim-aircraft`, `air-sim-uav`, `air-sim-missile`, `ground-sim-friendly`, `rescue-sim`, `report-sim`.
- Všechny eventy označ jako syntetické a validuj před předáním publisheru.
- Missile-track blok drž jako zjednodušený syntetický track bez navádění, účinnosti nebo taktického doporučení.
- Přidej unit testy reprodukovatelnosti pro stejný seed.
