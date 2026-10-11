# COP–SIM: rotace měřicího přístupu a řízený pilot

## Schválení a rozsah

11. 10. 2026 uživatel výslovně schválil párovou rotaci službového tokenu
a zapnutí Jízdy pro ověření. Pilot zůstává `shadow_only`, se samostatným
dobrovolným souhlasem a omezením nového příjmu na ověřený účet v COP.
Fyzická akceptace na iPhonu se tím nepředpokládá za splněnou.

## Dokončená rotace

Čas dokončení: `2026-10-11T07:37:32.431Z`; proces skončil kódem 0 včetně
konečného úklidu vlastní syntetické fixture.

- SIM revize `20a0d961ba4cdb1f100998d7f8e07787dad03327`, obraz
  `sha256:60d66a8083e4df55ea5eb8d8713c1846556a96162cd4fce1b70600ffecf89fc4`.
- COP obraz během rotace
  `sha256:ed17360324c431e169c489cee888f49037582792214b45e0a94d9360144d29a5`.
- Jeden nový bearer vznikl na produkčním hostu. Změnily se pouze jeho dvě
  položky v chráněných produkčních `.env`; žádná hodnota není v tomto auditu.
- Obě HMAC identity, ostatní prostředí, obrazy, Compose, mounty, síť, porty
  a prostředky byly zachované. Recreate pouze SDA a COP API.
- COP storage preflight, lock FD9, chráněná záloha čtyř autoritativních
  Compose souborů a health baseline/verify prošly. X5 UUID ověřené.
- Oba intake flags ještě `false`; SIM revocation-only a COP cleanup `true`.

| Ověření | Výsledek |
| --- | --- |
| Původní bearer | 401 |
| Nový bearer, neplatný DELETE | 400 |
| Vypnutý příjem dávky | 503 |
| Příspěvek vytvořený před rotací, DELETE novým bearerem | 200, smazána jedna dávka |
| Zbylé vlastní receipt / odvozené intervaly | 0 / 0 |
| Sedmidenní tombstone | přítomen |
| Skutečné volání COP API → SIM novým přístupem | autorizované 400 při validačním probe |

Privátní provozní důkaz bez hodnot secrets:
`/srv/sim/.driver-token-rotation/2026-10-11T07-36-26.619Z/after.json`.
Zkontrolovaný jednorázový postup je
`scripts/rotate-driver-measurements-service-token-20261011.mjs`; je záměrně
připnutý ke konkrétním výchozím obrazům, ne obecný automatický rotátor.

První pokus skončil před změnou secrets/runtime: COP snapshot očekává
relativní Compose cesty. Formát byl opraven; ochrana nebyla vypnutá.
Výjimky procesů nepřipojují zachycené stdout/stderr ani environment.

## Aktivace SIM a připravenost COP

COP nasadil revizi `71784fdebc65056f62e67087532c4006f053088c`, obraz
`sha256:767009770661cb08748c932084730cefdecb4d3652bfc94922ab71e190b826ef`.
Před aktivací SIM: zdravý, intake `false`, pilot `true`, právě jeden
ověřený OIDC subject, cleanup `true`. CI `38122371303` úspěšné; COP uvádí
1597 testů passed, osm dedikovaných DB testů skipped. Skutečný compiled
COP adaptér → SIM potvrdil validovaný DELETE 400, nesprávné oprávnění
a nedostupný endpoint 503; tímto se netvrdí ověření mobilního přihlášení.

SIM receiver zapnut `2026-10-11T08:04:42.251Z`, exit 0 včetně konečného
úklidu a zápisu důkazu. Obraz SDA i token/HMAC zachované; pouze SDA recreate,
ostatních 109 běžících kontejnerů beze změny. Intake `true`, revocation `true`,
výhradně `shadow_only`, žádná aktivace živých rychlostí ani ETA.

| Patnáct ohraničených syntetických HTTP probes | Výsledek |
| --- | --- |
| Bez bearer / neplatná dávka / Origin | 401 / 400 / 403 |
| Simulované polohy | 200, nula měřených intervalů, rawPositionsStored=false |
| Idempotentní opakování / jiný obsah stejné dávky | 200 obsahově shodné / 409 |
| DELETE / pozdní dávka po smazání | 200, jedna dávka smazána / 403 |
| Třetí nová dávka jednoho pseudonymu za minutu | 429 |
| Souběžné odeslání a odvolání | 200 / 200, příspěvek po dokončení nepřetrval |
| Vlastní receipt / interval / ETA po smazání | 0 / 0 / 0, tři tombstones |
| Chráněný souhrn a metadata grafu | 200, sim-routing-2026-10-11-1791687606 |

Simulované body se nepovažují za GPS. Test ověřuje metadata datasetu, nikoli
směrovou geografickou správnost map-matchingu. Nevypínal živou DB ani
provider a neprokazuje fyzickou akceptaci nebo přesnost ETA.

Privátní důkaz:
`/srv/sim/.driver-shadow-pilot/2026-10-11T08-04-08.535Z/after.json`.
Guard `scripts/enable-driver-measurement-shadow-pilot-20261011.mjs`, SHA-256
`f11415635ce8a9df8677b0530b2bff51cb447ce2ba4ae870c1564dcb0134417a`.

Dva dřívější pokusy byly bezpečně vrácené kvůli skončení externích
jednorázových FKC diagnostických kontejnerů zachycených v baseline; žádná
jiná trvalá služba se nezměnila. Přidána přísnější kontrola klidného okna,
nikoli vynechání kontejnerů z invariantu. Další pokus překročil původní
pevné 60s čekání; čekání nyní respektuje nezměněnou Docker politiku
(30s interval, 5s timeout, tři retries plus jeden úspěšný interval = 125s).
Healthcheck ani jeho podmínka zdraví nebyly oslabené. Každý neúspěch
potvrdil intake `false` a funkční revokaci před dalším pokusem.

### Konečné COP READY a párová kontrola

Následný COP audit našel obecný request logger s IP/portem a riziko
parse-error textu. Před příjmem telefonu byla nasazena cílená privacy
oprava measurement prefixu a striktní DELETE 200 acknowledgement:

- COP revize `e99401213efbf9d6a7685443adc318eeeb422c15`, obraz
  `sha256:8c61839a458ca82cfc79725b4763759c90d66ffcd31e1e24e2ff5defe9724741`.
- CI `38124211468` success, lokální regrese 1600 passed / osm izolovaných
  DB testů skipped; lint/build/OpenAPI a bezpečnostní audit passed.
- API-only rollout nejprve s intake `false`. Po kvalifikaci intake `true`,
  filtr `true`, jeden serverově ověřený subject, cleanup `true`. Zapnutí
  měnilo pouze intake flag, stejné obrazy a čtyři Compose overlays.
- COP guard porovnal hash každé položky prostředí proti postrotační
  baseline; kromě přesně vyjmenovaných pilot/intake flags vše identické.
  HMAC i nový token zůstaly byte-preserved, totéž chráněné secret lines
  proti host snapshotu. Mounty, sítě, porty, prostředky, Cmd/User a ostatní
  kontejnery beze změny. Produkční auth/JWKS se neměnily.
- Skutečný compiled COP transport odeslal vlastní simulovanou dávku:
  200, `shadow_only`, nula naměřených intervalů, rawPositionsStored=false;
  strict DELETE 200 dokončil její odstranění.
- Izolovaný compiled auth/route harness: bez auth 401, nepilotní grant
  403, parser 400, mimo pilot canGrant=false, nula identifikátorů v logu,
  nula skutečných consent rows. Syntetický issuer/JWKS byl pouze v jeho
  exec procesu; není to ověření veřejného native přihlášení ani GPS.
- První harness musel opravit zděděný produkční JWKS endpoint; transport
  a DELETE už tehdy prošly. Druhý pokus skončil kódem 0. Žádná ochrana
  produkční identity nebyla vypnuta či oslabena.

Root samostatně read-only ověřil DB `2026-10-11T08:32:09.501Z`: obě vlastní
fixture mají receipt/interval/ETA 0 a po jednom aktivním tombstone. Nula
osiřelých intervalů/ETA; dvě validované cascade FK. Žádný DB write.

Root párový read-only gate `2026-10-11T08:38:15.550Z`, exit 0: oba API healthy,
oba intake `true`, SIM revokace a COP cleanup `true`, fail-closed filtr a
jeden pilotní subject; nový bearer párově stejný a shodný s mode-600 files.
HMAC shodné s files; celé chráněné prostředí SIM proti activation baseline
beze změny. Schválený COP obraz připnutý, obraz SDA nezměněný. Privátní
síť má přesně dvě dotčená API a správný SIM alias. Chráněný GET souhrn 200,
`shadow_only`, dataset `sim-routing-2026-10-11-1791687606`; bez auth 401.
COP obraz nemá revision label; vazbu image → source dokládá jeho release
proof, nikoli odhad podle labelu.

Privátní COP důkazy v
`/srv/x5-production/staging/cop/job-8b685ebb7dd14d7e919bd5b2ff7dc696/`:
`compiled-acceptance-2.json`, `before.json`, `health-after-activation.json`.
Fixture soubory obsahují pouze vlastní syntetický pseudonym, nikoli GPS
nebo secrets; hodnoty se nepřenášejí do tohoto auditu.

### Jízda a fyzická instalace

Jízda byla přímo předána jejímu projektu pro oddělené diagnostické
sestavení 1.2 (31): 583 běžných a 40 pilotních testů passed, simulator
build prošel. Oddělený podepsaný Debug arm64 1.2 (31), bundle
`cz.voldzi.jizda`, deep/strict signing PASS, byl zmrazen jako ZIP SHA-256
`b8067809483aab7376c8cbb89525999d2313419b6053cdaf0cf913a09da286a7`.
Soukromý manifest dokládá osm měněných zdrojů nad base `964f197`; nejde
o tvrzení, že toto přesné sestavení pochází z publikovaného čistého commitu.
Podpis zachovává tým, device entitlement a stávající iCloud kontejner.
Pilotní build používá explicitní diagnostický příznak; serverové ON
nemění dosavadní vydanou aplikaci s `productionPilotEnabled=false`.
Uživatel potvrdil volný iPhone a schválil over-install se zachováním dat;
po párové serverové kontrole byl projektu Jízda předán GO k instalaci.

Instalace dokončena `2026-10-11T08:41:08Z`, bez odinstalace/resetu. Samostatné
čtení apps potvrzuje bundle `cz.voldzi.jizda`, verzi 1.2 a build 31. Dvě
nezávislé inventury procesů potvrzují stejný běžící proces nového bundle.
Root přečetl tyto receipts a ověřil shodu zařízení/verze/procesu i SHA-256
zmrazeného ZIP. Druhý telefon se neměnil; App Store 1.2 (30) artefakt zůstal
nezměněný a nic se do App Store neodesílalo. Jde o ověřenou instalaci a
spuštění, nikoli akceptaci souhlasu nebo měření.

Soukromé lokální receipts jsou `/private/tmp/jizda-pilot31-owner-installed.json`,
`jizda-pilot31-owner-processes.json` a `jizda-pilot31-owner-processes-final.json`.
Sanitizovaný záznam je v projektu Jízda
`.build/driver-measurement-pilot-device-31/device-readiness.json`;
trvalý audit `docs/archive/2026-10-11-driver-measurement-pilot-device-acceptance.md`.
Do SIM dokumentace nepřenášíme device ID, účet ani obsah telefonu.

Schválení instalace není dobrovolný souhlas se sběrem měření v aplikaci.
Agent neudělil souhlas, nespustil jízdu/GPS měření a nemazal reálná
uživatelská data. Pilot je dostupný přes **Více → Nastavení → Dobrovolné
dopravní údaje**; **Zastavit měření a smazat mé příspěvky** se vztahuje na
dopravní příspěvky, nikoli uložené jízdy, vozidla, chat nebo COP účet.

Publikované COP předání k této etapě:
[revize 94e0918](https://github.com/voldzi/delta_acr_cop/blob/94e0918/docs/integration/22_JIZDA_DRIVER_MEASUREMENTS_COP_HANDOFF.md).
Tato dokumentační revize neměnila nasazený COP obraz e994012.

## Místní ověření

- Syntax obou provozních skriptů a vložených Node probes prošla.
- Mock patnácti probes prošel včetně opačného pořadí klíčů v JSONB a obou
  pořadí souběhu batch/revoke; změna obsahu replay byla odmítnuta.
- Přesná SDA revize: 26 cílených testů passed, šest izolovaných DB testů
  skipped; tato sada se nespouštěla proti produkční DB.
- Skeleton, OpenAPI (144 paths / 239 schemas) a diff whitespace prošly.
- Změna SIM obsahuje provozní guards a dokumentaci; žádná změna nasazeného
  SDA aplikačního obrazu. Celý SIM typecheck/build/test se v této etapě
  neopakoval; uvedená cílená sada není celorepozitářová regrese.
- Chroma reindex nebylo možné dokončit: server nedostupný. Index ani
  síťová konfigurace se kvůli tomu neměnily.

## Zbylé hranice

- Reálný iPhone: souhlas, minimalizace/start–end zóny, retry/UTC/outbox,
  idempotence, souběh odvolání a konečné smazání čekají na společný test.
- Žádná data Jízdy se nezapojují do živých rychlostí/ETA.
- SQL DELETE není důkaz vymazání PBS/WAL/PITR; obnovovací karanténa a
  samostatná správcovská politika záloh zůstávají závazné.
- Tato cílená rotace neuzavírá posouzení ostatních přístupů z předchozího
  diagnostického výpisu; HMAC se bez migračního plánu nerotuje.
