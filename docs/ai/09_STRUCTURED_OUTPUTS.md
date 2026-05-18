# Structured outputs

**Status:** Baseline dokumentace

## Schema

AI draft musí odpovídat [ai-scenario-draft.schema.json](../api/schemas/ai-scenario-draft.schema.json). `scenarioPatch` se validuje proti [scenario.schema.json](../api/schemas/scenario.schema.json).

## Validace

- JSON parse
- JSON Schema validation
- policyCheck allowed
- prohibitedContentCheck false pro zakázané kategorie
- limity objektů a délky
- human accept před uložením

## Chyby

Nevalidní structured output se neukládá jako scénář. UI zobrazí chyby validace a audit uloží provider response metadata.
