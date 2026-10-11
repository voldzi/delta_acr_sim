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

## Neroutovatelné body

Known-closure a strict testy ověřují plain/mapped/strict route i alternatives:
jen přímé HTTP 400 `/route` + číselné 171 => neutrální LOCATION422; domnělý
upstream index se ignoruje. Bez dalšího route/locate/fallbacku. Ověřené snaps
za 25m mají TARGET/WAYPOINT422, také surplus varianty. Transport, 5xx s 171,
string kód, vadný JSON, warnings, chybějící geometrie a closure crossing zůstávají
ochranné. Status/trace nedostávají tuto klasifikaci; legacy se nemění. HTTP
test zachová correlation ID a nevrací raw provider text, trasu ani proof.
Živý syntetický COP test nenahrazuje fyzickou iPhone akceptaci.
