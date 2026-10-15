# Skutečný průchod COP → SIM HTTP → PostgreSQL

Datum: 15. 10. 2026. Source revize SIM `8fd4b6b3b665babd4a9e8a5af08fce8a0567cbc1`.
[Záznam s přesnými piny a hranicemi](2026-10-15_DATABASE_ERASURE_HTTP_ACCEPTANCE.json).
Produkce se neměnila; nejde o dokončení celého COP účtu.

## Co skutečně prošlo

COP sada nad vlastněným lokálním PG18 clusterem prošla 9/9 testy: osm
ověřuje konkrétní databázový journal, identity/inventory a replay, jeden
obsahuje společný průchod přihlášeným COP HTTP handlerem přes skutečné
SIM HTTP služby do Driver/Router PostgreSQL. Nejde o devět samostatných
kompletních mazání účtu. SIM hlavní agent přečetl výsledný report i celý
společný případ a ověřil uvedené source piny.

Společný případ ověřil RS256 autentizaci s lokálním syntetickým JWKS,
preflight, potvrzení, durable COP fence a skutečné SIM ownery bez kladného
náhradního authority portu. V Driver DB držel necommitnutou přijatou dávku,
pomocí `pg_blocking_pids` prokázal čekání mazání na její konkrétní backend,
pak skutečně COMMITnul dávku. Následně byly receipt, intervaly a ETA
přispěvatele nulové. ETA cizího parentu se odmítla 23503, druhý receipt
i jeho správná ETA zůstaly. Router COP key byl odstraněn, SIM namespace
key zachován. Staré A JWT dostalo 403, B preferences 200 a cizí receipt 404.

Vybrané `sim_measurements` a `ai_router` receipts se dokončily. Ostatní
owner readiness/preflight byly v tomto **testu syntetické fixtures** a
jejich efekty zůstaly pending. Celý COP handler proto správně vrátil 202
a `accountDeleted=false`. To není důkaz připravenosti komunikace, Keycloak,
LiveKit nebo jiného vlastníka a neopravňuje k produkčnímu canConfirm.

## Co neprohlašujeme

Žádná reálná identita, GPS, provider požadavek ani dešifrovaný klíč se
nepoužil. OIDC autorita a ciphertext jsou syntetické. COP server je testově
složený se skutečným controllerem a PG stores, nikoli produkčně instalovaný.
Neproběhla fyzická obnova PBS ani reálný iPhone. Oba runtime obrazy nebyly
v této fázi sestaveny nebo nasazeny; ověřen byl zdrojový build a HTTP tok.

Předchozích deset SIM owner HTTP/PG případů bylo před ETA008 a k finální
devítce se nepřičítá. První COP seed omylem použil jinou Router hash
derivaci; tento neúspěch není označen jako produktová chyba ani úspěšný
důkaz. Opravený seed používá skutečnou `BudgetStore.hashUser` doménu.

## Kontroly a další konkrétní krok

SIM prošlo typecheck, 873 běžných testů (6 volitelných PG SKIP), build,
skeleton, OpenAPI (151 cest, 274 schémat), import zkompilovaných DB loaderů
a Compose config se syntetickým tokenem. Chroma identity/transport problém
nebyl obcházen reindexem cizího checkoutu; zdroje byly ověřeny přímo.

Postup nasazení a obnovy je v [runbooku20](../runbooks/20_DATABASE_ERASURE_ACCEPTANCE.md).
Před produkcí zůstává výslovný enrollment a secrets/granty, inventura
externích report writerů, skutečná restore/exposure kontrola a chybějící
povinní COP ownery. Nezbývá další Root podpis, A/B registr nebo native helper.
