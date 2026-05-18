# Security architecture

**Status:** Baseline dokumentace

## Cíle

- chránit secrets a konfiguraci
- zabránit publikaci nevalidních nebo nesyntetických dat
- auditovat změny scénářů, runtime a AI
- umožnit okamžité zastavení publikace
- oddělit role a oprávnění

## Hranice důvěry

Důležité hranice jsou browser/UI, backend API, store/queue, externí AI provider a COP ingest API. Každá hranice vyžaduje auth, validaci a audit podle rizika.

## Zákazy

Systém nesmí obsahovat reálná operační data, secrets v repozitáři, targeting, navádění nebo bojové workflow.
