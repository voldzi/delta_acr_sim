# Backend architektura

**Status:** Baseline dokumentace

## Odpovědnosti backendu

- Vystavit OpenAPI kompatibilní REST endpointy.
- Validovat vstupy proti JSON Schema.
- Řídit lifecycle scénářů a runtime stav.
- Zprostředkovat AI draft workflow bez přímého spuštění výsledku.
- Vést audit změn scénáře, konfigurace, publisheru a AI.
- Exponovat health, readiness, dependencies a metrics.

## Návrhové hranice

Backend může být v dalším kroku implementován například v NestJS. Tento baseline nestanovuje produkční implementaci, ale vyžaduje čisté oddělení API controllers, services, validators, stores a adapters.
