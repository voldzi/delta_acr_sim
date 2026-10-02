# Jízda → COP → SIM: měření dopravy a kvality ETA

Stav 1. 10. 2026: implementované rozhraní, výchozí vypnutý příjem,
výhradně `shadow_only`. Nejde o automaticky aktivovaný zdroj živých rychlostí.
Závazné schéma: `openapi/openapi.json`; zdroj fragmentu
`openapi/fragments/driver-measurements-v1.openapi.json`.
Rozhodnutí: [ADR 0030](../adr/0030_CONSENTED_DRIVER_MEASUREMENTS.md).

## Účel a skutečné využití

SIM přiřadí krátký úsek **naměřených** GPS bodů k aktuálním směrovým hranám
Valhally pomocí POST `trace_attributes`, `shape_match=map_snap`.
Ze vzdálenosti po stejné směrové hraně a skutečně uplynulého času odvodí rychlost;
nepřebírá rychlost vrácenou routingovým modelem jako skutečné měření.
Výsledky poskytuje v pětiminutových, příspěvkově vyvážených souhrnech pro
kontrolu pokrytí a budoucí porovnání s TPEG2. Volitelně poskytuje hodinové
souhrny rozdílu předpovězené a skutečné doby jízdy.

Tyto souhrny **nepřepisují** TPEG2, routingový graf ani `traffic.tar`.
Přesnost jízdního času nelze prohlásit za zlepšenou jen úspěšným příjmem dat.
K budoucímu využití v navigaci je nutná směrová kontrola, nezávislé měření,
zátěžová akceptace a oddělený canary s automatickým návratem.

## Hranice přístupu a souhlasu

```text
Jízda (dobrovolný souhlas, skutečné GPS)
  → autentizované COP API (ověření uživatele, minimalizace, outbox)
    → interní SIM Situation Data API (vyhrazený službový token)
      → Valhalla map matching → odvozená data v odděleném PostgreSQL
        → chráněné souhrny kvality; žádné automatické přepsání navigace
```

Jízda a veřejný browser nesmějí znát SIM token ani volat SIM/Valhallu přímo.
COP ověří přihlášeného uživatele, aktuální dobrovolný souhlas a režim osobního
automobilu. Souhlas není odvozen od používání navigace a musí jít odvolat.
COP vytvoří pro každého uživatele **stabilní pseudonym jen v rámci UTC dne**:
HMAC nad ověřeným interním uživatelem a UTC dnem, odděleným tajemstvím COP.
Klient nesmí zvolit cizí identitu. Pseudonym má 32–128 znaků `[A-Za-z0-9_-]`.
SIM jej znovu HMACuje svým tajemstvím; do databáze nepíše původní pseudonym.
DB rovněž HMACuje UUID dávky a ETA; původní UUID vrací pouze v odpovědi/replay.
HTTP tracing této interní cesty je vypnutý. Produkční retence, secrets a rollback
jsou v [runbooku 17](../runbooks/17_DRIVER_MEASUREMENTS_PRODUCTION.md).
Po půlnoci dávku rozdělte. Neukládejte identitu uživatele do `batchId` či UUID.

Atestace neprokazuje skutečný souhlas, nezávislou osobu, správný čas telefonu
ani skutečný původ GPS. Za jejich ověření, zamezení spoofingu/přispěvatelským
duplicitám a datovou minimalizaci odpovídá COP/Jízda. Pět pseudonymů samo o
sobě není důkaz pěti nezávislých řidičů ani anonymizace dat.

## Interní endpointy

Gateway prefix: `/situation-data/api/v1/internal/driver-measurements/v1`.
Při přímém interním volání situation-data-api prefix začíná `/api/v1/...`.
Všechny endpointy vyžadují `Authorization: Bearer <vyhrazený COP token>`;
`Origin` je zakázaný, odpovědi mají `Cache-Control: no-store`.

| Metoda a cesta za prefixem | Význam |
| --- | --- |
| `POST /batches` | Přijmout dávku; idempotentní `batchId`, oddělená deduplikace dvojic GPS a ETA událostí. |
| `GET /aggregates?since=<UTC ISO>` | Souhrny jen pro právě aktivní routing dataset; implicitně posledních 24 h, maximálně 7 dnů a 1000 řádků. |
| `GET /quality` | Počty přijatých/odmítnutých intervalů, poslední příjem, příspěvkově vyvážené ETA souhrny. |
| `DELETE /contributions` | Odvolání souhlasu pro jeden denní pseudonym; smazání příspěvků a zákaz pozdního doručení na 7 dnů. |

## Přesný vstup

Všude platí **odmítnutí neznámých polí**, žádná numerická konverze řetězců,
žádný volný text. Dávka do 1 MiB, 3–120 bodů, časový rozsah nejvýše 600 s.
Body chronologicky, jedinečná `sampleId`, stáří nejvýše 24 h, budoucnost
nejvýše 30 s. Čas je UTC ISO 8601 s `Z`, po okamžiku udělení souhlasu.

| Pole dávky | Obsah |
| --- | --- |
| `contractVersion` | Přesně `sim-driver-measurements-v1`. |
| `batchId` | Náhodné UUID v1–v5; beze změny při retry stejného obsahu. |
| `contributorIdDay`, `contributorDay` | Serverem COP vytvořený denní pseudonym a `YYYY-MM-DD` UTC. |
| `consent` | Přesně `{version:"traffic-quality-v1", grantedAt:<UTC>, attestation:"cop-driver-consent-v1"}`. |
| `vehicleClass` | Přesně `passenger_car`; ne kolo, pěší pohyb, autobus nebo nákladní auto. |
| `points` | Krátká sekvence bodů podle následující tabulky. |
| `eta` | Volitelná jednorázová událost dokončené jízdy, viz níže. |

| Povinné pole bodu | Jednotka / pravidlo |
| --- | --- |
| `sampleId` | Náhodné UUID v1–v5, zachované při opakování/překryvu dávek. |
| `observedAt` | Skutečný čas GPS vzorku, nikoli čas uploadu. |
| `lat`, `lon` | WGS84 stupně, rozsahy −90…90 a −180…180. |
| `horizontalAccuracyM` | Nezáporné metry; pro využití nejvýše 15 m. |
| `speedMps` | Skutečná GPS rychlost 0…70 m/s, nikoli odhad z plánu trasy. |
| `speedAccuracyMps` | Nezáporné m/s; pro využití nejvýše 2 m/s. |
| `headingDeg`, `headingAccuracyDeg` | Směr od severu 0≤směr<360°, přesnost 0…180°, pro využití nejvýše 20°. |
| `positionSource` | `gps`, `estimated`, `simulated`; poslední dvě nikdy netvoří měřenou rychlost. |
| `motion` | `driving`, `traffic_stop`, `personal_stop`, `paused`, `unknown`. |
| `reducedAccuracy` | Boolean; omezená/approximate poloha se nepoužije pro rychlosti. |

Počítejte s iOS hodnotami „neplatné měření“ (např. záporná přesnost/rychlost):
vzorek neposílejte, nenahrazujte chybějící číslo nulou. Osobní zastávku
nezaměňujte s kolonou. Při nejasném pohybu použijte `unknown`.

### Volitelná kontrola ETA

`eta` má přesně: `observationId` (jedinečné UUID dokončené jízdy),
`routingDataset` získaný s původní trasou, `predictedDurationSeconds`,
`actualDurationSeconds`, `plannedDistanceM`, `actualDistanceM`,
`personalStopSeconds`, `estimatedSeconds`, `offRoute`, `completedAt`.
Časy jsou v sekundách, délky v metrech. Durace 1…86400 s, délky
100…2000000 m; osobní a odhadovaná doba nesmí v součtu překročit skutečnou.

Srovnatelná ETA vyžaduje alespoň jeden přijatý měřený interval, stejný dataset,
žádné odbočení, osobní zastávku či odhadovanou dobu a odchylku délek ≤5 %.
Použijte **původní** předpověď při odjezdu, ne naposledy přepočítanou ETA.
`observationId` zachovejte při retry; stejné pozorování téhož denního pseudonymu
se započítá nejvýše jednou. `etaAccepted=false` může znamenat i duplicitu.
Není zde přijímána ani uložena úplná trasa, adresa cíle nebo historie průjezdu.

SIM hodnoty označuje `client_reported_not_ground_truth`: původní předpověď není
serverem podepsaná a skutečný průjezd není nezávisle ověřený. Souhrn uvádí
medián absolutní odchylky v sekundách a procentní odchylky
`100 × abs(actual-predicted) / predicted`, nejprve medián na přispěvatele,
potom medián přes přispěvatele. Nejde o prokázanou přesnost navigace ani MAPE
s jmenovatelem skutečné doby.

## Doporučení pro Jízdu: maximum užitečných, ne osobních dat

1. Měřte při dobrovolně zapnuté funkci a aktivní jízdě, typicky každé 2–5 s.
   Dávku odešlete každých 30–60 s přes COP; spojte nejvýše 120 bodů, nikdy
   ne kompletní denní stopu. COP může pilot omezit kapacitou příjmu.
2. Zachovejte skutečné přesnosti, rychlost a směr. Tunnel prediction,
   interpolaci a simulaci **neoznačujte** `gps`. Po ztrátě GPS ukončete měřenou
   sekvenci a po spolehlivém návratu začněte novou; nepropojujte tunel uměle.
3. Vynechte citlivé začátky/konce jízd a místa zvolená uživatelem; neposílejte
   domov, cíl, jméno, účet, stabilní identifikátor telefonu, SPZ, soukromé
   zprávy, přílohy ani neupravená komunitní hlášení. Toto API je odmítne.
4. Offline outbox má limit velikosti a stáří 24 h, bezpečné místní úložiště,
   stejná UUID a řízený retry. Odvolání souhlasu jej ihned vyprázdní.
5. Při dokončení srovnatelné jízdy odešlete jeden ETA souhrn. Odlište osobní
   přestávky, odhadovaný pohyb a odbočení; špatný souhrn raději vynechte.
6. Uživateli otevřeně vysvětlete účel, rozsah, krátké uchování a možnost
   odvolání. Přenos není podmínkou používání navigace.

## Zpracování a souhrny

### Syntetický příklad požadavku

Následující body jsou pouze fixture, nikoli měření řidiče. Při použití
nahraďte časy aktuálním měřením; stáří >24 h je odmítnuto. Token je pouze
serverová hlavička COP, nikoli pole JSON. `eta` je volitelná.

```json
{
  "contractVersion": "sim-driver-measurements-v1",
  "batchId": "00000000-0000-4000-8000-000000000001",
  "contributorIdDay": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "contributorDay": "2026-10-01",
  "consent": {
    "version": "traffic-quality-v1",
    "grantedAt": "2026-10-01T10:00:00.000Z",
    "attestation": "cop-driver-consent-v1"
  },
  "vehicleClass": "passenger_car",
  "points": [
    {"sampleId":"00000000-0000-4000-8000-000000000010","observedAt":"2026-10-01T12:04:40.000Z","lat":50,"lon":14,"horizontalAccuracyM":3,"speedMps":10,"speedAccuracyMps":0.5,"headingDeg":90,"headingAccuracyDeg":5,"positionSource":"gps","motion":"driving","reducedAccuracy":false},
    {"sampleId":"00000000-0000-4000-8000-000000000011","observedAt":"2026-10-01T12:04:45.000Z","lat":50,"lon":14.0007,"horizontalAccuracyM":3,"speedMps":10,"speedAccuracyMps":0.5,"headingDeg":90,"headingAccuracyDeg":5,"positionSource":"gps","motion":"driving","reducedAccuracy":false},
    {"sampleId":"00000000-0000-4000-8000-000000000012","observedAt":"2026-10-01T12:04:50.000Z","lat":50,"lon":14.0014,"horizontalAccuracyM":3,"speedMps":10,"speedAccuracyMps":0.5,"headingDeg":90,"headingAccuracyDeg":5,"positionSource":"gps","motion":"driving","reducedAccuracy":false}
  ]
}
```

Celá dávka obsahující odhadovanou/simulovanou či nepřesnou polohu se neposílá
do map matcheru; obdrží nulové využité intervaly. Rozdělte dobré a špatné
sekvence již na klientovi. SIM přijme pouze dvojice s odstupem 1–10 s,
typem `matched`, na stejné směrové hraně, bez discontinuity, snap odchylkou
0–10 m, rostoucí polohou po hraně a průjezdem ≥10 m. Směr musí při rychlosti
≥2 m/s odpovídat pohybu mezi GPS body v toleranci 35°; časová/GPS rychlost
se musí shodovat v toleranci max(4 m/s, 30 % odvozené rychlosti).
Rychlost se odvodí i z částečně pokryté hrany, ne z celé její délky.

Nevyužívají se dvojice přecházející hranici hran ani čistě stacionární prodleva;
proto tato verze ještě plně nezachycuje čekání v koloně. Sběr jízd není
automatickým důkazem správného jízdního pásu: paralelní vozovky a složité uzly
vyžadují samostatnou geografickou akceptaci před živým použitím.
Valhalla status se ověří před i po map matchingu; změna grafu vrátí 503.
Všechny výsledky nesou dataset; po změně mapy se staré hrany nepromíchají.

Jedna osoba přispívá do každého 5min okna jedním mediánem bez ohledu na počet
bodů. Výstup obsahuje medián, p10/p90, počet intervalů a atestovaných
přispěvatelů, nejméně **5 přispěvatelů a 10 intervalů**. Souhrn ETA má svůj
nezávislý stejný práh. `usableUntil` je konec 5min okna; později je záznam
výslovně `historical`, nikoli živá rychlost.

## Odpovědi, limity a revokace

200 vrací `batchId`, čas přijetí, počty využitých/duplicitních intervalů,
`rejectionCounts`, `etaAccepted`, `applicationMode:"shadow_only"`,
`rawPositionsStored:false`. Opakovaná shodná dávka vrací původní odpověď a
`X-Idempotent-Replay:true`; změněný obsah téhož ID vrací 409.
Odmítnutý interval v přijaté dávce není totéž jako neúspěšný upload.

| Stav | Postup COP/Jízdy |
| --- | --- |
| 400 | Chyba kontraktu; neopakovat beze změny, bezpečně zaznamenat pouze kód. |
| 401 | Službové přihlášení; opravit backend, token nikdy neposílat do telefonu. |
| 403 | Chybějící/odvolaný souhlas nebo browser; zastavit odesílání. |
| 409 | UUID již označuje jiný obsah; neobejít novým ID pro tentýž spor. |
| 413 | Dávka přesahuje 1 MiB; opravit velikost před dalším odesláním. |
| 429 | Respektovat `Retry-After`, ponechat stejnou dávku, exponenciální backoff+jitter. |
| 503 | Vypnutý zdroj, databáze, matcher či rotace grafu; bounded retry, žádný přímý fallback. |

Výchozí strop je 120 požadavků/min na jednu SIM instanci (konfigurovatelně
1–600), 2 nové dávky/min na denní pseudonym a 4 souběžné map matching operace.
Souhrny/mazání rovněž spotřebují službový strop. Volání Valhally má dohromady
8 s timeout a maximálně 2 MiB odpověď. Databázový pool 4 spojení,
SQL timeout 5 s. Strop není důkaz kapacity pro 1000 aktivních řidičů; před
rozšířením pilotu je nutný zátěžový test a koordinace COP fronty.
Rate limiter je lokální instanci, databázová idempotence a revokace jsou
transakční napříč replikami. Replikace mění souhrnný rate budget.

Odvolání: DELETE JSON `{contractVersion:"sim-driver-measurements-v1",
contributorIdDay:"<denní pseudonym>"}`. COP odvodí pseudonymy všech dosud
uchovaných dnů (a případného pozdního outboxu), požádá o jejich smazání,
zastaví budoucí odesílání. SIM zachová 7denní HMAC tombstone bez GPS.

## Úložiště, nasazení a návrat

Raw GPS existuje pouze přechodně v paměti SIM a Valhally při zpracování;
není zapisováno do SQL, cache/X5, logů ani response. Na COP straně musí být
také zakázány body logy, analytické exporty GPS a dlouhá outbox archivace.
Derivované pseudonymní intervaly, omezené ETA hodnoty a receipt jsou
uchovány 7 dnů od přijetí. Nejde o anonymní data ani obnovitelnou provider cache.
Použijte **oddělenou PostgreSQL databázi přes spravovaný HAProxy**, ne OSM
read-only DB ani AI Router DB; persistentní DB se nepřesouvá na X5.

Migrační administrátor aplikuje `deploy/driver-measurements/schema.sql`
v této vyhrazené DB. Runtime účet má pouze CONNECT, USAGE na schema a
SELECT/INSERT/UPDATE/DELETE na čtyři tabulky, nikoli CREATE/superuser.
Runtime neprovádí DDL. Tajemství a URL jen v chráněném serverovém `.env`.
V nové vyhrazené DB ověřte i zděděná oprávnění PUBLIC a odeberte CREATE na
`public` schématu; pouhé nezadání GRANT CREATE nemusí ve starším clusteru stačit.
Samostatná tajemství `DRIVER_MEASUREMENTS_COP_TOKEN` a
`DRIVER_MEASUREMENTS_HASH_SECRET` mají nejméně 32 náhodných znaků.
Nerecyklujte veřejný/routovací/AI token.

Průběžný runtime úklid každou minutu maže expirované receipt a tombstones;
FK maže intervaly/ETA. Čtení vždy vylučuje expiraci. Při vypnutém runtime
zajistěte stejný denní SQL cleanup správcovským DB jobem; pokud DB neběží,
fyzické smazání proběhne až po obnovení. Zálohy a revokace v zálohách mají
oddělenou správcovskou retenční/deletion politiku, nejsou pokryty pouhým TTL.

1. Založit vyhrazenou DB a runtime účet přes HAProxy, aplikovat migraci.
2. Doplnit bezpečně `DRIVER_MEASUREMENTS_*` proměnné podle `.env.example`.
3. Nasadit pouze situation-data-api, příjem ještě ponechat `false`.
4. Společně COP/Jízda/SIM ověřit souhlas, minimalizaci, outbox/retry, skutečný
   payload a odvolání. Teprve potom `DRIVER_MEASUREMENTS_ENABLED=true` pro pilot.
5. Ověřit syntetické dávky a GPS pilot, chráněné agregáty, health a běžné
   mapy/routing; neslibovat živou optimalizaci ETA.
6. Návrat: `DRIVER_MEASUREMENTS_ENABLED=false`,
   `DRIVER_MEASUREMENTS_REVOCATION_ENABLED=true`, restart pouze situation-data-api;
   zastavit COP odesílání, zachovat DB/token/HMAC pro mazání a retenční úklid.
   Režim revokace povoluje pouze autentizovaný DELETE, nikoli čtení souhrnů
   nebo nové dávky a nepotřebuje Valhalla matcher. Při výpadku DB COP ponechá
   trvalou frontu mazání; nesmí oznámit dokončené smazání. Žádná změna traffic mapy.

Tento implementační krok neprovisionuje produkční DB, nepředává službové
tokeny, nemění síť a neaktivuje odesílání skutečných jízd.

### Operátorské založení databáze

Na Macu s `psql`, VPN a přístupem správce použijte připravený skript:

```bash
PGUSER=postgres bash scripts/provision-driver-measurements-postgres.sh --check
PGUSER=postgres bash scripts/provision-driver-measurements-postgres.sh --apply
```

Skript používá výhradně `haproxy.home.cz:5000`, databázi
`sim_driver_measurements` a oddělené účty `driver_measurements_migrator`
a `driver_measurements_runtime`. Heslo správce zadáte skrytě; potvrzení je
`sim_driver_measurements`. Nevytváří token, nenastavuje serverový `.env`,
nespouští služby a neaktivuje sběr. Privátní přihlašovací soubor s právy 600
je `~/.config/csm-sim/driver-measurements-db-credentials.env`; nevkládejte jej
do chatu ani Gitu. Do SIM patří pouze runtime URL, nikoli migration URL.

Před změnou clusteru uloží vygenerované přístupy pro případ selhání migrace.
Existující soubor nikdy nepřepisuje. Při částečném selhání jej zachovejte
a dokončete migraci s jeho migration účtem; automaticky nemažte DB/role.
`--recover` je pouze pro ztracený přihlašovací soubor a ověřený úplný stav
obou izolovaných rolí a vlastnictví databáze; resetuje jejich hesla.
Při jiné částečné konfiguraci skončí bez změny. Jeho použití na provozované
DB vyžaduje koordinovanou rotaci runtime přístupu.

Provisioning nezajišťuje denní cleanup při vypnuté službě ani politiku
mazání v zálohách. Tyto provozní podmínky zůstávají před aktivací povinné.

Ověření 2. 10. 2026: 33 testů měření prošlo, včetně 5 skutečných DB testů
nad izolovaným dočasným PostgreSQL 18 a 5 mockovaných testů provisioning
preflightu. Mockované testy neprokazují založení produkční DB; kontrolují
read-only režim, zákaz jiného endpointu, požadavek administrátora, detekci
existujících objektů a nevypisování hesla. Typecheck služby, OpenAPI sanity
a skeleton prošly. Testovací DB byla odstraněna bez persistentního volume.

## Ověření a společná akceptace

### Integrační větev pro nasazení 2. 10. 2026

`codex/driver-measurements-integration` vychází z přesného serverového
commitu `d7fc650bd27fc6dff36db166f80e11f623ab1415`. Obsahuje pouze příjem
měření a jeho provisioning; nejde o nasazení celé vývojové větve Valhally.
Stávající routing implementace a testy zůstaly zachované. Strukturální
porovnání OpenAPI potvrdilo beze změn všechny dosavadní paths a schemas;
přibyly čtyři interní measurement endpointy.

Úplný typecheck, build, OpenAPI a skeleton prošly; regresní běh má
335 úspěšných testů a 5 explicitně přeskočených DB testů bez test URL.
Stejných 5 DB testů bylo v tomto kontrolním kroku samostatně úspěšně
provedeno v izolované dočasné PostgreSQL nad původním measurement commitem.
To není produkční DB akceptace ani důkaz skutečného GPS provozu.

Serverový checkout obsahuje lokální observability změnu a privátní
deployment overlay konfigurace. Při nasazení je zachovejte, nepoužívejte
reset, celkové Compose restartování ani přepis `.env`. Nové parametry mají
zůstat vypnuté do společné akceptace. Před nasazením zopakujte kontrolu
serverového HEAD a provozního image; při změně základu znovu integrujte.

Společná lokální kontrola 2. 10. 2026 propojila skutečný COP
`HttpDriverMeasurementSource` s HTTP hranicí SIM a izolovanou PostgreSQL 18.
Použila syntetické body a stub matcher, nikoli skutečný mobilní OIDC token
nebo GPS. Prošly: mobilní validace a serverové scoped UUID, příjem a receipt,
idempotentní replay, oddělení dvou uživatelů se stejným klientským UUID,
kaskádové smazání a odmítnutí opakovaného příspěvku po odvolání.
Odhalená chyba COP původně převáděla i `DRIVER_CONSENT_REVOKED` na 503;
po rozlišení tohoto konkrétního kódu vrací 403 a společný test prošel.
Ostatní chyby službové autorizace zůstávají serverovým výpadkem, nikoli
pokynem k resetování identity klienta.

Oddělený test skutečného COP PostgreSQL consent store ověřil restart,
izolaci dvou uživatelů, trvalou revokaci, blokaci regrant ve stejný UTC den,
trvalou frontu dnů k mazání, další den po smazání, souběh send/revoke a
fail-closed změnu HMAC tajemství. Dočasné databáze bez volumes byly odstraněny.
Nejde o ověření oprávnění produkčního DB účtu, provozního propojení,
privacy guardů na iPhonu ani přesnosti ETA; tyto gates nadále zůstávají.

Lokální fixture/HTTP testy: přísný kontrakt, souhlas, Origin/auth, čas/UUID,
estimated GPS, směr/přesnosti/rychlost, grafová rotace a částečná hrana,
idempotence, 429, výpadek DB/matcheru, revokace a izolace ostatních endpointů.
Integrační PostgreSQL testy: opakovatelná migrace, omezený runtime účet,
transakční souběh, deduplikace intervalů/ETA, prahy souhrnů, oddělení datasetů,
expirace, kaskádové smazání a absence GPS polí v uloženém receipt.

Před aktivací chybí reálná akceptace COP/Jízdy, produkční DB/klíče a zátěžový
test. Před využitím do navigace navíc nezávislé vzorky souběžných vozovek,
opakovaného průjezdu, kolon, měst a dálnic a kontrolovaný experiment ETA.

Dodatečný integrační test nad izolovaným PostgreSQL 18 dne 2. 10. 2026
ověřil i agregaci po odvolání při současně odesílané dávce: příspěvek po
revokaci v souhrnu nezůstane a pozdní zápis denního pseudonymu je odmítnut.
Šest DB testů prošlo; opravena byla pouze testovací autentizace omezené role.
Test neprokazuje chování produkční databáze, skutečné Valhally ani iPhonu.
Zdroj algoritmického rozhraní:
[oficiální Valhalla Map Matching](https://valhalla.github.io/valhalla/api/map-matching/).

### Implementační ověření 1. 10. 2026

- 28 nových testů úspěšně provedeno, z toho 5 nad skutečným dočasným
  PostgreSQL 18 s omezeným runtime účtem; databáze neobsahovala produkční data.
- Celková regresní sada: 328 testů; typecheck, build, skeleton a OpenAPI sanity
  validation prošly. Redocly prošel s 5 existujícími varováními mimo nový kontrakt.
  Při dvou opakováních paralelní sady došlo k odlišným přechodným selháním
  již existujících AI Router testů (`app.test.ts`, `separate-routes.test.ts`);
  samostatný sériový běh všech 40 AI testů a následný celý běh 328 testů prošly.
  Příčina nestability není tímto úkolem prokázána; AI Router nebyl upravován.
- Kompatibilita s běžící Valhallou ověřena na 4 syntetických bodech: 2 byly
  `matched` a měly délku hrany; dataset `sim-routing-2026-09-29-1790679143`.
  Jde o kompatibilitu parseru, ne o nezávislé měření přesnosti přiřazení.
- Chroma retrieval/reindex nebyl dostupný; byla použita přímá kontrola zdrojů.
- Nenastalo nasazení příjmu, vytvoření produkční DB, přenos tokenů ani sběr GPS.
