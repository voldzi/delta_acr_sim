# Next CODEX prompt: AI assistant

Implementuj AI Scenario Assistant podle `docs/ai/*`, `docs/ui/08_AI_SCENARIO_ASSISTANT.md` a `docs/api/schemas/ai-scenario-draft.schema.json`.

Požadavky:

- Implementuj provider abstraction pro mock, local, OpenAI a Codex provider placeholdery.
- Implementuj policy classifier pro povolené a zakázané use-cases.
- Implementuj structured output validaci a human accept/reject workflow.
- Přidej audit promptů a odpovědí v redigované podobě.
- Externí AI provider musí být vypnutelný a nesmí dostat reálná operační data ani secrets.
- Přidej guardrail testy pro targeting, navádění, použití síly, útok, vyhýbání detekci a povolené syntetické scénáře.
