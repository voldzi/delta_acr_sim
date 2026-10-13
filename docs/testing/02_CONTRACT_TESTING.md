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

## Dobrovolná měření Jízdy

`driver-measurements.test.ts` ověřuje službovou identitu, individuální atestaci,
striktní strukturu, idempotenci, směr, verzi grafu, kvalitu, 429/503 a pozdní
upload po dokončeném odvolání. `driver-measurement-store.test.ts` lze spustit
bez produkční DB přes `bash scripts/test-driver-measurements-postgres.sh`:
vytvoří loopback-only dočasný PostgreSQL a po testu jej odstraní. Prokazuje
omezená runtime práva, retenční úklid, vyvážení přispěvatelů, skutečný
commit/revoke race a vyloučení příspěvku z nového read snapshotu.

Evaluation/projector/publication testy odmítají raw pole, neznámé důvody,
vadné počty, chybějící data, symlinky a prošlá okna. Revokace během čtení
zahodí starý report; chyba obnovy nesmí ponechat čerstvý starý report a vydat
potvrzení dokončení. Repeatable-read izolace sama není trvalá revokační ochrana.

`driver-speed-pilot.test.ts` je pouze porovnávací selector: testuje prahy 5/10,
graph-bound směrovou review, rozptyl a strop, původní konec okna, přednost
čerstvých oficiálních dat a fail-closed neznámé pokrytí. `liveAppliedEdgeCount`
je vždy nula. Syntetické testy neprokazují přesnost ETA, souhlas skutečného
uživatele nebo správný směr konkrétní silnice.

SIM API/UI testy ověřují chráněný endpoint, přesný DTO, 90s zastarání,
pětiminutový deadline, oddělené 7d/24h rozsahy, omezené obnovování a zrušení
po odhlášení. Závěrečná akceptace musí přidat dva skutečné běžné účty,
fyzický iPhone, odvolání se zpožděnou dávkou a kontrolu viditelného přehledu.

## Mock COP behavior

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
