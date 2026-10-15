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

## Scoped COP/Jízda account erasure

Závazný fragment `account-erasure-v1.openapi.json` zahrnuje capability,
actor preflight, start a čistý status pro SDA a Router. Testy odmítají
neznámé/duplicitní actor klíče, jiný issuer/audience, podpis, cizí operaci,
konfliktní immutable tělo, browser Origin a přenos identity v query.
Pending je 202 s důvodem, nikoli úspěšné smazání. Vypnutý nebo chybějící
chráněný restore verifier nevytvoří novou fence. Pozitivní syntetický
ověřovatel není produkční autorizace.

Izolované PostgreSQL testy používají vlastní prázdný cluster bez TCP,
vyhrazené migrator/runtime role a přesný data-directory guard. Ověřují
commit/revoke a key/reserve/finish závody, restart, invoker/RLS omezení,
carry-forward denních/měsíčních součtů bez dvojího účtování, nejisté
provider rezervace a zachování SIM/IZS. Žádný skutečný účet ani OpenAI
není testovacím cílem. Produkční obnova PBS/WAL, nezávislá autoritativní
fence a společná COP akceptace jsou zvláštní gates, ne jednotkové testy.

DBv2 instalační test `scripts/test-sim-erasure-installer.mts --run` používá
stejnou implementaci jako produkční offline installer proti vlastněnému
loopback PostgreSQL18 clusteru. Ověřuje skutečné migrace, SCRAM přihlášení
omezených účtů, zachování cizího guard schématu, opakování bez rotace,
quarantine/ETA mismatch, false flags, skutečné produkční loadery a odmítnutí
změněných identity secrets. Jednotkové části navíc ověřují odmítnutí TLS
downgrade/hosta/duplicitních parametrů a zachování legacy deploy úprav.
Loopback fixture používá nešifrované izolované spojení; není vydávána za
produkční TLS login. Credential-free TLS handshake s již schválenou CA je
samostatný důkaz v [runbooku 20](../runbooks/20_DATABASE_ERASURE_ACCEPTANCE.md).
Root CLI permissions, skutečné zastavení Docker writerů a fyzická obnova
se ověřují až ve společném instalačním kroku. Předchozí archivovaný společný
HTTP report se nepřepíše a nepovažuje se automaticky za důkaz nové revize.
