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

## Public operator boundary

SIM může být vystaven jako samostatné internetové operační centrum pouze přes
webový shell chráněný Keycloakem. Veřejně dostupné smějí být:

- statické webové UI,
- `GET /health/live`,
- `/api/v1/*` pouze jako browser API ověřené přes `Authorization: Bearer`
  Keycloak access token a SIM role.

Produkční internetový profil používá `SIM_API_AUTH_REQUIRED=true` a
`SIM_API_PUBLIC_READ=false`. Fallback statické tokeny mohou existovat jen jako
break-glass/server-side provozní nástroj a nesmí být nabízeny ve veřejném UI.

## Provider boundary

SIM dál běží jako server-to-server provider pro COP backend. Provider katalogy,
bbox query, detailní source endpointy, readiness, observability a partner/TAK
endpointy zůstávají interní/VPN-only. COP frontend a mobilní klienti mají volat
COP API, nikoli provider endpointy SIM přímo.

## Zákazy

Systém nesmí obsahovat reálná operační data, secrets v repozitáři, targeting, navádění nebo bojové workflow.
