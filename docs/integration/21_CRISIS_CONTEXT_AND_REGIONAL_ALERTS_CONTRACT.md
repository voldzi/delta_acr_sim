# Krizový mediální kontext a regionální bezpečnostní vstupy

**Status:** SIM nasazen a interně ověřen na `docker.home.cz` 10.10.2026.
Společná uživatelská akceptace COP a skutečné background doručení zůstávají
samostatnými gates. Architektonické rozhodnutí: [ADR 0031](../adr/0031_CRISIS_CONTEXT_AND_NOTIFICATION_BOUNDARIES.md).

## Dvě oddělené datové cesty

SIM nabízí COP backendu oficiální bezpečnostní vstupy a oddělený informační
mediální kontext. COP frontend a mobilní klient volají COP, nikoli přímo SIM
nebo upstream RSS. Existující interní/VPN provider hranice se nemění.

- Bezpečnostní mapové prvky: `GET /safety-data/api/v1/features`.
- Ověřené kandidátní vstupy: `GET /safety-data/api/v1/notifications/candidates`.
- Nenotifikační mediální seznam: `GET /safety-data/api/v1/context/news`.

ČT24 konektor není `SafetyDataSource`, neposkytuje `SafetyFeature`, mapovou
geometrii nebo kandidáta na safety notifikaci. Nepřidává push scheduler.

## Přístupová hranice

COP backend čte `GET /safety-data/api/v1/notifications/candidates` a
`GET /safety-data/api/v1/context/news` z důvěryhodné interní/VPN sítě bez
bearer tokenu. U těchto dvou GET operací Safety Data API nepřidává aplikační
autentizaci; gateway používá `internal-provider-access.conf` s interním/VPN
allowlistem a `deny all`. Veřejný bearer token tuto síťovou hranici neobchází.
Uživatelé, browser a mobilní klienti nadále přistupují přes autentizované COP
API a vlastní uživatelské opt-in/AOI rozhodnutí COP.

Operation-level `security=[]` a
`x-access-policy=internal_network_readonly` v OpenAPI popisují tento konkrétní
síťově omezený read-only režim, **nikoli veřejný anonymní endpoint**. Globální
bearer default a jiné operace zůstávají beze změny. Tato oprava dokumentace a
kontraktu nemění runtime, Nginx, porty, VPN/firewall nebo deployment konfiguraci.

## ČT24 endpoint

```http
GET /safety-data/api/v1/context/news?feeds=ct24-main,ct24-ostrava,ct24-brno&limit=50
```

Samotná služba registruje `/api/v1/context/news`; prefix `/safety-data` přidává
SIM gateway. Kontrakt je `sim-crisis-media-context-v1`. Povolené parametry:

- `feeds`: volitelný čárkami oddělený seznam níže uvedených ID, bez libovolných
  URL; výchozí jsou všechny tři feedy. Opakovaná ID se deduplikují.
- `limit`: celé číslo `1..100`, výchozí `50` pro celkový výstup.
- Jiné parametry, pole/nested hodnoty, neznámý feed, prázdný seznam a neplatný
  limit vracejí `400` s `INVALID_MEDIA_NEWS_QUERY` a `correlationId`.

Pevný allowlist:

| ID | Oficiální RSS URL | `regionCode` – pouze rozsah feedu |
| --- | --- | --- |
| `ct24-main` | `https://ct24.ceskatelevize.cz/rss` | `CZ` |
| `ct24-ostrava` | `https://ct24.ceskatelevize.cz/rss/rubrika/regiony/moravskoslezsky-kraj-14` | `CZ080` |
| `ct24-brno` | `https://ct24.ceskatelevize.cz/rss/rubrika/regiony/jihomoravsky-kraj-26` | `CZ064` |

Regionální feed může psát o jiné lokalitě. `regionCode` proto není událostní
geokód a nesmí vstoupit do AOI/geofence. SIM nikdy nepřevezme ani RSS geometrii,
neodhaduje souřadnice z titulku a nedotazuje geokódovací službu.

Interní smoke 10.10.2026 ověřil hlavní `/rss` přímo s HTTP 200. Starý alias
`/rss/hlavni-zpravy` má řetězec 308/307, který striktní konektor nepřijímá.
Do allowlistu se proto zapisuje přímo ověřený feed; libovolná přesměrování
zůstávají zakázána.

Zkrácená ilustrační odpověď (ID a titulek nejsou záznam produkční události):

```json
{
  "contractVersion": "sim-crisis-media-context-v1",
  "status": "ok",
  "generatedAt": "2026-10-10T12:00:00.000Z",
  "informationalOnly": true,
  "notificationEligible": false,
  "items": [
    {
      "id": "ct24-example",
      "title": "Požár, hasiči evakuují obyvatele",
      "link": "https://ct24.ceskatelevize.cz/clanek/domaci/example",
      "publishedAt": "2026-10-10T11:00:00.000Z",
      "fetchedAt": "2026-10-10T12:00:00.000Z",
      "eventAt": null,
      "regionCode": "CZ080",
      "regionScope": "feed",
      "location": null,
      "locationStatus": "unresolved",
      "informationalOnly": true,
      "notificationEligible": false,
      "stale": false,
      "source": {
        "id": "ct24",
        "name": "ČT24",
        "feedId": "ct24-ostrava",
        "attribution": "Česká televize / ČT24"
      }
    }
  ],
  "sources": [
    {
      "id": "ct24-ostrava",
      "label": "ČT24 – Moravskoslezský kraj",
      "feedUrl": "https://ct24.ceskatelevize.cz/rss/rubrika/regiony/moravskoslezsky-kraj-14",
      "regionCode": "CZ080",
      "regionScope": "feed",
      "attribution": "Česká televize / ČT24",
      "status": "ok",
      "fetchedAt": "2026-10-10T12:00:00.000Z",
      "stale": false,
      "errorCode": null,
      "retryAfterSeconds": null
    }
  ]
}
```

V reálné odpovědi má `sources` stav každého vybraného feedu. `items` se řadí
podle publikace, deduplikují podle bezpečného kanonického odkazu i napříč feedy
a mají stabilní ID odvozené od odkazu. Jedna deduplikovaná položka si ponechá
metadata vybraného zdrojového feedu; to není doplnění incidentní lokalizace.

### Časy, filtr a datová minimalizace

- `publishedAt` znamená čas publikace RSS položky, nikoli vznik incidentu.
  `fetchedAt` je čas úspěšného načtení feedu; `eventAt` zůstává `null`.
- Neplatná/chybějící publikace, čas bez timezone, budoucí publikace a položka
  starší než 24 hodin se vynechají. Stáří se přepočítává i při čtení cache.
- Deterministický konzervativní filtr titulku vybírá např. požár, povodeň,
  evakuaci, dopravní uzávěru, výpadek energie/vody nebo nebezpečný jev.
  Vynechává rozpoznané retrospektivy, cvičení, běžné aktuality a zahraniční
  kontext. Nejde o klasifikaci s garantovaným pokrytím nebo ověření události.
- Titulek se převádí na krátký sanitizovaný plain text, nejvýše 300 znaků.
  Ukládají se pouze titulek, bezpečný odkaz a uvedená metadata.
- Atribuce `Česká televize / ČT24` a odkaz na původní zdroj se zachovávají.
  Dostupnost RSS není blanket licencí k další publikaci plných článků.
- Žádné stahování cílových článků, obrázků, jejich obsahu, AI volání ani raw
  RSS persistence; ve službě zůstává pouze omezená metadata cache v paměti.

### Cache, limity a výpadky

- Akvizice je lazy, až při dotazu. Jedna instance služby sdílí cache a inflight
  request každého ze tří feedů napříč kombinacemi dotazů. Není disková cache ani
  nový background poller; více replik nesdílí tuto paměť mezi procesy.
- Fresh TTL je pevně `300 s`; nejvýše `100` normalizovaných položek na feed.
  Query vrátí maximálně `100` položek ze všech vybraných feedů dohromady.
- Výchozí negativní backoff chyby je `60 s`, stale-if-error dalších `600 s`
  po fresh TTL, tedy nejvýše 15 minut od úspěšného načtení. Položky starší než
  24 hodin se ani při stale fallbacku neobnovují do výstupu.
- Timeout pokrývá fetch i čtení body, výchozí `8000 ms`;
  `MEDIA_NEWS_REQUEST_TIMEOUT_MS` je ve službě omezen na `25..30000 ms`.
- Maximálně `1 MiB` dekódovaných bytes body, včetně streamu nebo nepravdivého
  `Content-Length`; XML nesmí obsahovat DTD/custom entities a má limit hloubky
  20 tagů. Upstream redirect je odmítnut.
- Odkazy položek jsou pouze `https` na přesném hostu
  `ct24.ceskatelevize.cz`, bez credentials a nestandardních portů; tracking
  parametry a fragment se odstraňují.

Celkový `status` je `ok`, `degraded` nebo `disabled`. Stav každého feedu je
`ok`, `stale`, `unavailable` nebo `disabled`. Chyba jednoho feedu neblokuje
ostatní; nepoužitelná cache vrátí prázdný seznam daného feedu. Stale položka
nese `stale=true` a původní `fetchedAt`. Zdrojová diagnostika obsahuje pouze
`errorCode` a `retryAfterSeconds`, nikdy raw payload nebo text interní chyby.
Zdrojové chyby se vracejí jako kontraktní degradace v `200`; neočekávané
selhání endpointu může vrátit `503 MEDIA_NEWS_UNAVAILABLE`.

## Osm regionálních a obecních zdrojů

`municipal_alerts` musí být v `SAFETY_DATA_ENABLED_SOURCES`. Prázdné
`MUNICIPAL_ALERT_FEEDS` vybere tento vestavěný katalog; explicitní seznam jej
nahradí, nepřidává se k němu. Nejde o celostátní pokrytí IZS.

| Feed ID | Oficiální URL | Formát |
| --- | --- | --- |
| `pkr-ustecky-jpo` | `https://pkr.kr-ustecky.cz/pkr/zasahy-jednotek-pozarni-ochrany/?fmt=json` | PKR JSON |
| `pkr-liberecky-udalosti` | `https://pkr.kraj-lbc.cz/pkr/probihajici-udalosti/?fmt=json` | PKR JSON |
| `pkr-stredocesky-aktuality` | `https://pkr.kr-stredocesky.cz/pkr/aktuality/feed.xml` | RSS |
| `pkr-stredocesky-jpo` | `https://pkr.kr-stredocesky.cz/pkr/zasahy-jpo/feed.xml` | RSS |
| `olkraj-krizove-rizeni` | `https://www.olkraj.cz/rss/6` | RSS |
| `bruntal-uredni-rss` | `https://www.mubruntal.cz/rss` | RSS |
| `krnov-aktuality-rss` | `https://www.krnov.cz/rss` | RSS |
| `vrbno-aktuality-rss` | `https://www.vrbnopp.cz/rss.xml` | RSS |

Mapová prezentace těchto vstupů zůstává kompatibilní v
`public.safety.warnings`. Obecný RSS/Atom/GeoRSS/GeoJSON záznam není v aktuální
implementaci sám notifikačně způsobilý ani při vlastním zdrojovém bodu. U
fallback geometrie je `locationPrecision=authority_fallback_point`, nikoli
ověřená poloha incidentu. COP ji smí zobrazit pouze s označením nepřesnosti,
nikoli použít jako střed radius-push oblasti.

Normalizace dovolí pozitivní `providerProperties.notification.eligible` pouze
pro PKR JSON s `geometryBasis=source_pkr_json` a oběma explicitními časy
události. `publication.eventAt/eventValidUntil` nesmějí vzniknout z publikace
RSS nebo odvozené cache expirace. Kandidátní guard dále vyžaduje
`validityBasis=explicit_event_interval`, validní a uspořádaný interval,
`validFrom<=now<validUntil` a `status=active`. Informativní metadata nebo
explicitní `eligible=false` mají vždy přednost před závažností.

## Fail-closed připravenost notifikačního vstupu

Kandidátní HTTP odpověď obsahuje:

```json
{
  "inputReadiness": {
    "status": "ready",
    "snapshotGeneratedAt": "2026-10-10T12:00:00.000Z",
    "snapshotAgeSeconds": 2,
    "reasons": []
  },
  "summary": { "inputRejectedCount": 0 }
}
```

| Stav | Význam a povinné chování COP |
| --- | --- |
| `ready` | Známé snapshot/cache kontroly prošly a známý query limit nebyl dosažen. Teprve pak lze vyhodnotit opt-in, AOI a kandidáty. |
| `unavailable` | Chybný/expirovaný nebo nepřiměřeně budoucí čas, source warning, neobnovená cache chyba či stale úspěch; nové automatické doručení z této odpovědi nepovolit. |
| `incomplete` | Jinak připravený snapshot dosáhl známého query limitu; možná truncation, nové automatické doručení nepovolit. |

Kontrolují se původní `collection.generatedAt`, společná response cache a
cache požadovaných zdrojů; maximální stáří je `SAFETY_DATA_CACHE_TTL_SECONDS`.
Tolerance budoucího timestampu je 5 sekund. Chyba bez prokazatelně pozdějšího
úspěchu zůstává neobnovenou chybou. Chybný evaluation time nebo neplatný
konfigurovaný age limit také fail-closed odmítá vstup. Kontroluje se i `validUntil`
jednotlivých prvků; výchozí `includeStale=false` expirované prvky vynechává.
`includeStale=true` je diagnostická možnost, ne obcházení readiness nebo
způsobilosti a není určena pro automatický push.

Cache eviduje `unresolvedStaleEntries`: úspěch jiného cache klíče neobnoví
původní stale vstup. Request-scoped evidence přes `AsyncLocalStorage` přenáší
source stale fallback do sanitizovaného warningu agregovaného snapshotu;
warning přetrvá i při dalším cache čtení. Nový čas agregace nebo úspěch jiné
položky nesmí přeznačit stará zdrojová data jako připravená. Evidence neobsahuje
cache klíče nebo raw upstream payload.

### Odpověď není další snapshot cache

Oba přesné GET endpointy (`notifications/candidates`, `context/news`) vracejí
`Cache-Control: no-store, max-age=0` a `Pragma: no-cache`, včetně chyb validace.
Gateway používá samostatné exact locations se stejným interním allowlistem,
`proxy_cache off`, bez stale/background update a s
`X-SIM-Gateway-Cache: BYPASS`. Obecný provider cache include, který ignoruje
upstream cache headers a dovoluje stale odpovědi, se na ně nesmí použít.
To neodstraňuje sdílenou source/feed cache uvnitř Safety Data API.

`generatedAt` je čas aktuálního čtení; `snapshotGeneratedAt` zůstává původním
časem podkladu a `snapshotAgeSeconds` se přepočítává při každém čtení podle
serverových hodin. Hlavička `X-COP-Request-At` ani klientský timestamp se při
rozhodování nepoužívají. COP zachová vlastní přísnější maximum 300 sekund a
odmítne překročení i v případě jinak `ready` vstupu. Změna query pro cache-bust
není řešením čerstvosti. Výpadek upstreamu nesmí na gateway obnovit předchozí
HTTP 200/readiness jako aktuální odpověď.

Při `unavailable` nebo `incomplete` HTTP vrací `candidates=[]`,
`summary.candidateCount=0`, `summary.skippedCount=featureCount` a
`summary.inputRejectedCount` jako počet jinak způsobilých kandidátů, které
vstupní gate odmítla. Detailní skip počty popisují předchozí per-feature
filtraci, proto po input gate nejsou prostým rozkladem finálního skippedCount.
Původní warnings patří do provozního dohledu, nikdy do civilního push payloadu.

Výsledek pod známým limitem **není důkazem úplného upstreamu**, stránkování,
celostátního pokrytí ani bezporuchového doručování. COP musí současně ověřit
očekávané zdroje a vlastní aktuální rozhodovací politiku; chybějící
`inputReadiness` z dřívější verze pro nové automatické zpracování odmítne.

## Odpovědnost COP a akceptace

COP vlastní odvolatelný uživatelský opt-in, AOI/geofence, role/oprávnění,
uživatelské tiché režimy, finální rozhodnutí a deduplikaci. CSM Messaging
zajišťuje registry zařízení, kanály a audit doručení. SIM nesbírá zařízení,
uživatelskou GPS ani preference a neposílá APNs/Web Push. ČT24 seznam se
zobrazuje jen jako informační kontext s atribucí, nikdy jako safety push.

Před tvrzením produkčního dokončení doložit image/commit a konfiguraci,
aktuální interní kontraktní smoke, zdrojové stavy a rollback. Samostatně pak
ověřit COP uživatelský opt-in/AOI, duplikáty, degradaci a skutečné zařízení /
background doručení. Automatické testy SIM ani dostupnost RSS tyto poslední
gates nenahrazují. Testovací a konfigurační postupy jsou v
[test strategy](../testing/01_TEST_STRATEGY.md) a
[environment runbook](../runbooks/03_ENVIRONMENT_CONFIGURATION.md).

### Cílená aktivace na pilotu

Pro tuto změnu použít
[`scripts/deploy-crisis-context.mjs`](../../scripts/deploy-crisis-context.mjs),
ne kompletní `deploy-docker-home.sh`. Na `docker.home.cz` se spouští ze
samostatného checkoutu přesného otestovaného commitu, nikdy ze secrets-bearing
runtime `/srv/sim`:

```bash
node scripts/deploy-crisis-context.mjs --deploy --revision <full-tested-commit>
```

Skript odmítne jinou revizi nebo sledované změny build vstupů. Sestaví pouze
Safety Data API s revizním štítkem a image tagem
`sim-safety-data-api:crisis-<sha12>`. Divergentní runtime checkout nepřepíná na
lokální branch a nekopíruje celý Compose. Nesouvisející lokální změny
Valhalla/routingu se touto aktivací neslučují.

Před buildem i aktivací ověřuje mount `/srv/x5-production`, UUID
`2f93f595-b61b-4eea-9054-7afa9b275b5b`, ≥5 GiB volného místa na runtime/storage,
pravidelné nesymlinkové config soubory, `.env` mode 600 a původní healthy
Safety Data API bez publikovaných portů. Po buildu znovu ověří, že runtime
`.env`/Compose mezitím nikdo nezměnil.

Mění jen safety service Compose image/dva media environment odkazy a čtyři
`.env` klíče: `SAFETY_DATA_ENABLED_SOURCES` (přidá `municipal_alerts`, ostatní
zdroje zachová), `MEDIA_NEWS_ENABLED=true`, `MEDIA_NEWS_REQUEST_TIMEOUT_MS=8000`,
`SIM_SAFETY_DATA_IMAGE`. Ostatní secrets/nastavení zachová.
`MUNICIPAL_ALERT_FEEDS` nepřepisuje; pro vestavěných osm feedů předem ověřit,
že hodnota chybí/je prázdná a neobsahuje vlastní override. Porovnává
normalizované Compose konfigurace ostatních služeb a při změně odmítne
aktivaci. Recreate je jen Safety Data API, `--no-deps --no-build`.

Privátní rollback záloha je
`/srv/sim/.deploy-crisis-backups/<timestamp-sha12>/` (adresář 700, `.env` a
evidence 600). Secrets se nesmějí vypisovat, přidat do Git nebo zveřejnit.
Při selhání aktivace skript obnoví původní config/image; health rollbacku je
nutné samostatně ověřit. Úspěšný script smoke ověřuje health, zdroj
`municipal_alerts`, zapnutý media flag a news kontrakt/stavy/limity/informativní
položky. Není důkazem kompletního regionálního pokrytí ani COP doručení.
Produkční identita a ověřené výsledky jsou uvedeny níže.

Gateway freshness se nasazuje samostatně z téhož čistého otestovaného checkoutu:

```bash
node scripts/deploy-crisis-gateway-freshness.mjs --deploy --revision <full-tested-commit>
```

Skript vyžaduje již existující read-only bind z autoritativního
`/srv/sim/apps/simulator-web/nginx/default.conf`. Vloží jen dvě exact locations;
zachová ostatní konfiguraci včetně zákazu proxování driver measurements.
Před zápisem znovu ověří X5 mount/UUID/místo, aktuální healthy gateway a
nezměněný config. Zápis zachová inode mountu, následuje `nginx -t` a reload,
nikoli recreate kontejneru nebo změna obrazu, portů či sítí. Privátní záloha
je v `.deploy-crisis-backups/<timestamp>-gateway-<sha12>/`.
Při neúspěšné akceptaci obnoví původní obsah a reloadne jej. Ruční návrat
musí také zachovat inode: původní config přepsat do existujícího souboru,
ověřit syntax a reloadnout; nepoužívat atomic rename přes bind mount.
Zvlášť pak potvrdit health, interní 200, veřejnou zdrojovou 403 a admin 401.

### Evidence nasazení 10.10.2026

- Nasazený kód služby: `d894f0d8804414600a23f8dfa9a4bbf86fda559d`, větev
  `codex/crisis-sources-notifications`.
- Obraz: `sim-safety-data-api:crisis-d894f0d88044`, ID
  `sha256:a0ccd6979d2625ded9fb2aaf4823350a5cfcbe6d15f4ec59e16ae2f2ae9ab6bd`.
  Revizní štítek odpovídá uvedenému commitu; stav `healthy`, žádný publikovaný
  host port. Ostatních osm SIM kontejnerů zachovalo stejné ID; Valhalla,
  databáze, síť a secrets nebyly měněny.
- Runtime `MEDIA_NEWS_ENABLED=true`, timeout `8000 ms`, zdroje zachovány a
  rozšířeny o `municipal_alerts`; vestavěných osm regionálních feedů bylo
  jednotlivě ověřeno s HTTP 200 a platným RSS/JSON. X5 mount UUID byl ověřen
  před buildem i aktivací; news cache nemá diskové zápisy.
- Privátní záloha pro tuto aktivaci:
  `/srv/sim/.deploy-crisis-backups/2026-10-10T15-27-00-744Z-d894f0d88044/`.
  První pokus s předchozím RSS aliasem byl odmítnut akceptační kontrolou;
  automatický návrat obnovil původní obraz
  `sha256:3ceef2e719ae26ceba6019981cdae9623f48b91c8e7aa52b5de9d99f7f36e355`
  a jeho zdraví bylo samostatně potvrzeno před druhou aktivací.
- Živý smoke proběhl ze SIM i produkčního kontejneru `cop-cop-api-1` přes
  stávající `COP_SAFETY_DATA_BASE_URL`, bez nového tokenu nebo síťové změny.
  News: tři zdroje `ok`, jeden aktuálně filtrovaný titulek, žádná poloha/čas
  incidentu ani notifikační způsobilost, 400 pro neznámý feed. Z COP trvala
  dvě opakovaná čtení 125 a 3 ms, source `fetchedAt` zůstal stejný. První
  čtení již bylo po instalačním zahřátí, nejde o benchmark cold upstreamu.
- Municipal bbox ČR/limit 500: 192 mapových prvků, nula warnings. HZS zvolený
  regionální bbox/limit 100: čtyři prvky, dva kandidáti, dva odhadované body
  odmítnuty, `inputReadiness=ready`. Při limitu 1 se živě z COP vrátilo
  `inputReadiness=incomplete`, důvod `input_limit_reached`, nula kandidátů.
  Počty jsou snapshot, nikoli počet krizí, úplnost ČR nebo garance doručení.
- Automatické testy: 154/154 Safety Data API a 4/4 deployment patch/build-policy,
  Node 24.19.0/pnpm 10.33.0; service build/typecheck, skeleton, OpenAPI build
  consistency a validation prošly. Redocly lint prošel s pěti dřívějšími
  warningy mimo tuto změnu (traffic feed a AI Router). Celá workspace test
  suite nebyla pro cílenou API aktivaci spouštěna.
- Autoritativní runtime `scripts/deploy-docker-home.sh` byl aktualizován jen
  o zachování čtyř klíčů a ochranu připnutého Safety obrazu před přestavěním
  starým checkoutem; jeho původní další chování/source změny zachovány.
  SHA-256 `eb5c3cef64e4456a417c1e0690efd4625df5af1ee37541a3026dff6c7aeecbb1`
  odpovídá testované lokální verzi; shell syntax prošla. Celý deployment
  skript se při této aktivaci nespouštěl.
- Native retrieval reindex byl po zveřejnění změny vyžádán, ale nástroj
  skončil `Error executing tool reindex_repo`. Obnova vyhledávacího indexu
  není potvrzena; pro tuto změnu používat přímý Git/file context. Nemá vliv
  na ověřenou provozní datovou cestu ani nezpůsobila obnovu/rebuild Chroma.
- Neodeslán žádný testovací push. Opt-in/AOI, vyhodnocovací worker, mediální
  panel a fyzické doručení při zavřené aplikaci dokončuje COP v samostatném
  autorizovaném úkolu. SIM data se nesmějí zaměnit za hotovou push funkci.

Opakovatelný agregovaný smoke:
[`scripts/verify-crisis-context-runtime.mjs`](../../scripts/verify-crisis-context-runtime.mjs).
Uvnitř SIM používá localhost; uvnitř COP jeho existující base URL. Nevypisuje
obsah incidentů, souřadnice, secrets ani články. Při ručním pozdějším návratu
obnovit jen čtyři dotčené klíče a safety sekci Compose/původní image;
nepřepsat celé současné `.env`/Compose starou zálohou, pokud mezitím proběhly
jiné změny. Recreate pouze Safety Data API a samostatně potvrdit health,
disabled news odpověď, zachované další safety zdroje a dostupnost z COP.
