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

## Public provider boundary

COP je jediný veřejný frontend pro uživatele. SIM běží jako server-to-server provider pro COP backend a nemá být veřejným browser API. Produkční publikace musí na hraně povolit pouze `GET /health/live` a dokumentační stránku; provider katalogy, bbox query, scénáře, readiness, observability a partner endpointy jsou interní/VPN-only.

## Zákazy

Systém nesmí obsahovat reálná operační data, secrets v repozitáři, targeting, navádění nebo bojové workflow.
