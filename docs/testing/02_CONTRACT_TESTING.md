# Contract testing

**Status:** Baseline dokumentace

## Rozsah

- OpenAPI endpoint existence
- JSON Schema validace scénáře
- canonical event envelope validace
- publisher config validace
- AI draft validace
- standard error model
- `geo-routing-v1`: walking/bicycle, ordered 2+ waypoints, GeoJSON/elevation,
  dataset metadata, invalid input, no optimization, service auth/browser
  rejection, Valhalla degradation and publication idempotency

## Mock COP

Mock COP endpoint musí vracet úspěch, validaci, auth chyby, rate limit, server error a idempotency konflikt pro deterministické testy.

## Gates

Contract test selhání blokuje změnu publisheru i změnu event schema.

## Road-trip-v1

`routing-safety.test.ts` ověřuje přesný sdílený schema kontrakt, neznámé klíče,
legacy konflikty, jednotky/auto/truck intent, stop/via, variant geometry hashes,
25m snap, obousměrné polygon exclusions i segment crossing bez vertexu uvnitř,
closure mimo straight OD koridor, expiry/revocation/direction/revision/graph
změny za běhu, chyby bez fallbacku a skutečné 26/27 roundabout metadata.
Mock engine není geographic/live restriction acceptance. Testovací fixtures
nejsou skutečné uzavírky a nesmějí se nahrát do běžného provideru.
