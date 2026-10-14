# Zdrojové ověření mazání COP/Jízdy — 14. 10. 2026

## Rozsah a stav

Větev `codex/sim-account-erasure-release`, základ SDA `03b842e`.
Přímo potvrzené omezené migrace, runtime DML a izolované syntetické testy.
Produkční nasazení je podmíněné společnou akceptací; neprovedeno.
Společná Keycloak identita, SIM přístup/relace a SIM/IZS se zachovají.
Žádný skutečný účet, `.env`, provider klíč, produkční DB nebo síť se
kvůli testům nezměnily. Žádné OpenAI volání.

## Výsledky

| Kontrola | Výsledek |
| --- | --- |
| SDA testy | 431 PASS; 6 starších opt-in PostgreSQL testů bez URL SKIP |
| AI Router testy | 52 PASS |
| Flight / Safety / TAK / Simulator | 24 / 35 / 9 / 35 PASS |
| Typecheck a build celého workspace | PASS, připnutý Node 24 |
| Závazný OpenAPI | 151 paths, 273 reachable schemas; validace PASS |
| Additivita API | Původních 143 paths a 253 schemas beze změny významu |
| Syntetické JSON Schema případy | 62 PASS, 8 nových binding paths |
| Skeleton a diff whitespace | PASS |
| Redocly lint | PASS s 18 varováními původních schémat mimo nový erasure fragment |
| Nativní izolovaný PostgreSQL 18.3 | 40 PASS nad konzistentními finálními SHA migrací |
| Chroma reindex worktree | Odmítnutá náhradní identita repository; žádné přeindexování hlavního dirty checkoutu |

Workspace placeholder zprávy nejsou prohlížečovým testem. V tomto běhu
se neprováděla vizuální, iPhone ani skutečná PBS restore akceptace.
Šest přeskočených legacy PG testů se nepřičítá k 40 novým nativním kontrolám.

## Skutečné PostgreSQL scénáře

`scripts/test-account-erasure-postgres.mts` vytvořil nový 0700 lokální
cluster bez TCP a porovnal skutečný `data_directory` a serverovou instanci.
Čtyři baseline, sedm SQL/RLS, dvanáct Driver a sedmnáct Router behavior
kontrol prošlo. Bez URL/host/secrets vstupu, s blokací provider fetch.

Ověřeno: přesný dosavadní COP alias; role bez DDL/superuser/bypass RLS;
chybějící jednotlivé INSERT/DELETE právo a vypnutý trigger blokují nový
start; preflight bez mutace; commit/revoke a key/reserve/erase závody;
trvalá fence a nemožnost pozdního obnovení; provider reserved/uncertain
zůstává pending; atomický den/lane převod spotřeby a tokenů; retry bez
dvojího převodu; legacy globální limity po smazání platí i pro zachovaný
SIM; BYOK anonymní součet nečerpá budget jiného plátce; SIM/IZS zachované;
expirace měsíčních součtů počká na settlement. Syntetický pozitivní
verifier není skutečnou infrastrukturní autoritou.

Finální migrace:

```text
AI003 921e19e1bae334bb3ae84dadfc9ab4b9cd333b4f515e77a3a286b68649426a56
Driver002 f13db2106a1fe1a02d0d1a26afa8ad7d7c045172ba4419749719ed0f166e16ad
```

## Pasivní produkční kontrola

Existující služby byly přes dosavadní ověřenou VPN cestu zdravé a nezměněné:

```text
SDA image sha256:2f3aa1659d03c5eaf014353071e38f6abc1d2da1419a9ac2205a05b5873a5965
SDA source 03b842e005f103bb02d622bb4fc95f27fbea9572
Router image sha256:2e21d0576a9cdc2626e3540da112211f7b425f76b3b51109f7cfcc5454bcef88
Router revision label absent — nebyla domyšlena
COP image sha256:a06c103764701e7debc6434e3dd98e9a6d5f218d30831cb62aad566265db392f
COP source b13fbdc71f3d9821f8b857c3f73255a75c46fa76
```

Nebyla spouštěna migrace, nový obraz, restart ani mazání produkčních dat.

## Otevřené gates

- Skutečná nezávislá Root restore/continuity autorita, dataset binding,
  fence replay bez mezer a serializovaná admission/drain brána nejsou zřízené.
- Platný návrhový podpis, TTL, checkpoint nebo boolean je nenahrazuje.
- Výchozí Router verifier vrací false; takový nový obraz by blokoval běžný
  COP chat. Proto nebyl přepnut do produkce ani s erasure flagem false.
- Zbývá inventura skutečných report kopií, identity/key-version pokrytí
  a společná COP–SIM akceptace nad konkrétním nasazeným rozsahem.
- Zálohy/WAL/provider retence nejsou fyzicky smazané ani tímto potvrzené.

Aktuální postup je v runbooku 19 a závazný kontrakt v `openapi/openapi.json`.
