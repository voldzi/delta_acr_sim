# Provider abstraction

**Status:** Baseline dokumentace

## Provideři

- OpenAI provider
- Codex provider
- local LLM provider
- mock provider

## Společné rozhraní

- `listCapabilities()`
- `generateScenarioDraft(request)`
- `validateConfiguration()`
- `healthCheck()`
- `estimateCostOrLimits()` tam, kde dává smysl
- `cancel(requestId)`

## Pravidla

- Provider dostává pouze policy-approved a redigovaný vstup.
- Provider vrací structured output, ne volný text jako autoritativní scénář.
- Provider nesmí zapisovat scénář bez human review.
- Mock provider je povinný pro testy a offline vývoj.
