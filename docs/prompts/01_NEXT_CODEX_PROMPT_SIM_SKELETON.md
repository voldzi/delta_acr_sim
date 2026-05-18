# Next CODEX prompt: SIM application skeleton

Vytvoř implementační skeleton samostatné aplikace COP Air & Situation Simulator podle dokumentace v `docs/`. Neimplementuj plný simulační engine; vytvoř monorepo skeleton s frontendem, backendem, sdílenými kontrakty, mock providerem a mock COP endpointem.

Požadavky:

- Použij dokumenty `docs/architecture/*`, `docs/application/*`, `docs/api/openapi-simulator.yaml` a JSON Schema v `docs/api/schemas/*`.
- Připrav základní aplikace `simulator-web` a `simulator-api`.
- Přidej validaci scénáře proti `scenario.schema.json`.
- Přidej health endpoints, runtime status placeholder a dry-run publisher placeholder.
- Přidej mock AI provider a AI draft endpoint placeholder.
- Neimplementuj targeting, navádění, zbraňové workflow ani bojové taktické doporučení.
- Přidej základní testy kontraktů a README pro lokální spuštění.
