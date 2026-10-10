# CSM notification input contract

**Status:** Autoritativni hranice SIM pro uzivatelske notifikace.

SIM je server-to-server datovy provider. SIM nikdy neposila push notifikace
uzivatelum, neuklada APNs tokeny, nezna zarizeni, skupiny ani uzivatelske
preference. Tyto informace patri do COP a CSM Messaging.

## Přístupová hranice a autentizace

`GET /safety-data/api/v1/notifications/candidates` a samostatný
`GET /safety-data/api/v1/context/news` volá COP backend z důvěryhodné interní
nebo VPN sítě. Současný runtime na této hranici nevyžaduje bearer token;
Safety Data API jej u těchto GET operací neověřuje. SIM gateway je chrání
`internal-provider-access.conf` s interním/VPN allowlistem a `deny all`.
Veřejný klient se k provideru nedostane zasláním bearer tokenu.

Závazný OpenAPI kontrakt proto u právě těchto dvou operací uvádí `security=[]`
a `x-access-policy=internal_network_readonly`. Prázdný security seznam zde
znamená síťově omezené server-to-server čtení, nikoli veřejný anonymní přístup.
Globální bearer default a ostatní operace se nemění. COP nadále autentizuje
uživatele, vyhodnocuje role, odvolatelný opt-in a AOI; browser/mobile nesmí
provider endpointy volat přímo. Runtime/gateway/auth konfigurace se touto
kontraktní opravou nemění.

## Odpovednosti

```text
SIM -> COP backend -> CSM Messaging -> APNs/Web Push -> CSM Messenger klient
```

- SIM publikuje bezpecnostni a situacni data s dostatecnou semantikou.
- COP rozhoduje, zda se feature tyka uzivatele, skupiny, sledovane oblasti
  nebo aktualni polohy.
- CSM Messaging provadi device registry, idempotenci, delivery audit a odeslani
  push notifikace.

## Notifikovatelne vrstvy SIM

Primarni notifikovatelny zdroj je Safety Data API:

```text
GET /safety-data/api/v1/catalog
GET /safety-data/api/v1/features
GET /safety-data/api/v1/notifications/candidates
```

Katalogove vrstvy vhodne pro uzivatelske vyhodnoceni:

- `public.safety.warnings`
- `public.safety.weather_alerts`
- `public.safety.fire`
- `public.safety.flood`

Referencni vrstvy, technicke vstupy a serverove warningy nejsou samy o sobe
notifikace pro obcana:

- `public.boundary.admin`
- vsechny diagnosticke/source-health warningy,
- stale/cache/upstream degradace bez civilni udalosti,
- obecne RSS aktuality, publikacni cas clanku a neoverene body autority,
- cely medialni endpoint `GET /safety-data/api/v1/context/news` s
  `notificationEligible=false`.

## Autoritativni kandidatni endpoint

COP ma pro push a in-app notifikace pouzivat kandidatni endpoint:

```http
GET /safety-data/api/v1/notifications/candidates?bbox=...&layers=warnings,weather_alerts,fire,flood&minSeverity=advisory&limit=100
```

Podporovane parametry:

- `bbox=west,south,east,north` omezuje prostor, pro ktery COP hleda udalosti.
- `layers=warnings,weather_alerts,fire,flood`; vychozi hodnota je tato sada.
- `source=chmi_alerts,chmi_hydro,nasa_firms,gdacs_alerts,hzs_incidents,municipal_alerts,road_srti_lod` nebo `source=mock` pro test.
- `minSeverity=info|advisory|warning|critical`; vychozi je `advisory`.
- `includeStale=true|false`; vychozi je `false`.
- `limit=1..1000`; vychozi je `100`.

Odpoved ma `contractVersion=sim-safety-notification-candidates-v1`. SIM v ni
vraci filtrované kandidatni vstupy a hotove lokalizovane texty. SIM tim stale
nerozhoduje o adresatech ani kanalech. Katalogová způsobilost vrstvy neznamená
způsobilost každého jejího prvku; závazné jsou níže uvedené per-feature a
input-readiness gates.

### Přesnost, původ a aktivní interval

`policy.eligibilityPolicy=verified_alert_and_non_fallback_location_required`.
Informativní metadata a explicitní `providerProperties.notification.eligible=false`
se odmítají i při vysoké severity. Point s
`locationPrecision=authority_fallback_point|region_centroid|municipality_centroid|admin_boundary_centroid`,
`geometryMode=representative_point` nebo basis
`chmi_cap_representative_point` nesmí být radius-push kandidátem. Autoritativní
polygon se neposuzuje jako takový centroid.

U `municipal_alerts` je navíc povinné `notification.eligible=true`,
`validityBasis=explicit_event_interval`, validní uspořádané časy
`validFrom<=now<validUntil` a `status=active`. Aktuální normalizátor nastavuje
pozitivní způsobilost jen pro PKR JSON s vlastním zdrojovým bodem a explicitním
intervalem. Obecný RSS/Atom/GeoRSS/GeoJSON, datum publikace ani syntetická
expirace snapshotu tuto způsobilost nevytvářejí. Pole
`providerProperties.publication` rozlišuje publikaci od
`eventAt/eventValidUntil`. Výchozí `includeStale=false` znovu odmítá stale nebo
expirované `validUntil` i u cachovaných feature.

`summary.eligibilitySkippedCount` a `eligibilitySkippedReasons` rozlišují
`informational_only`, `provider_not_eligible`, `approximate_location`,
`unverified_municipal_alert`, `unknown_municipal_event_validity` a
`inactive_municipal_alert`. `includeStale=true` tyto gates neobchází a je
určeno pro diagnostiku, ne automatický push.

### Fail-closed input readiness

HTTP odpověď vždy přidává `inputReadiness` s poli `status`,
`snapshotGeneratedAt`, `snapshotAgeSeconds` (nebo `null`) a `reasons`.
COP musí pro nové automatické zpracování výslovně vyžadovat `status=ready`;
chybějící metadata ze staré verze nejsou implicitním souhlasem.

- `ready`: známá kontrola snapshotu/cache prošla a známý query limit není
  dosažen. Nejde o důkaz kompletního upstreamu nebo celostátního pokrytí.
- `unavailable`: neplatný, starý nebo více než 5 s budoucí timestamp,
  `response.warnings`, neobnovená cache chyba nebo starý úspěch response /
  požadované source cache. Max stáří je `SAFETY_DATA_CACHE_TTL_SECONDS`.
- `incomplete`: jinak připravený vstup má `features.length>=query.limit`, tedy
  známé riziko truncation. Výsledek pod limitem úplnost negarantuje.

Při ne-ready vstupu je `candidates=[]`, `candidateCount=0` a
`skippedCount=featureCount`. `summary.inputRejectedCount` počítá jinak
způsobilé kandidáty odmítnuté vstupní gate; per-feature skip počty po této gate
nejsou prostým součtem finálního `skippedCount`. Technické reasons/warnings
nepatří do civilních zpráv. `unresolvedStaleEntries` a request-scoped evidence
source fallbacku uchovají degradaci i při úspěchu jiné cache položky nebo
dalším čtení agregovaného snapshotu. Podrobnosti v
[krizovém kontraktu 21](21_CRISIS_CONTEXT_AND_REGIONAL_ALERTS_CONTRACT.md).

Zkraceny tvar odpovedi:

```json
{
  "contractVersion": "sim-safety-notification-candidates-v1",
  "providerId": "sim.safety-data",
  "inputReadiness": {
    "status": "ready",
    "snapshotGeneratedAt": "2026-06-29T08:00:00Z",
    "snapshotAgeSeconds": 0,
    "reasons": []
  },
  "policy": {
    "audienceDecisionOwner": "cop",
    "deliveryOwner": "csm-messaging",
    "notificationType": "safety.alert",
    "technicalWarningsPolicy": "never_push_to_public_users",
    "eligibilityPolicy": "verified_alert_and_non_fallback_location_required"
  },
  "summary": {
    "candidateCount": 1,
    "duplicateSkippedCount": 0,
    "eligibilitySkippedCount": 0,
    "eligibilitySkippedReasons": {},
    "inputRejectedCount": 0,
    "minSeverity": "advisory",
    "includeStale": false
  },
  "candidates": [
    {
      "candidateId": "sim.safety-data:safety.weather_alerts:feature-id:2026-06-29T08:00:00Z:2026-06-29T18:00:00Z",
      "idempotencyKey": "sim.safety-data:safety.weather_alerts:feature-id:2026-06-29T08:00:00Z:2026-06-29T18:00:00Z",
      "notificationType": "safety.alert",
      "audienceDecisionOwner": "cop",
      "deliveryOwner": "csm-messaging",
      "feature": {
        "featureId": "feature-id",
        "layerId": "public.safety.weather_alerts",
        "providerLayerId": "safety.weather_alerts",
        "severity": "warning",
        "geometry": { "type": "Polygon", "coordinates": [] },
        "geometrySummary": { "type": "Polygon" }
      },
      "message": {
        "title": { "cs": "Vystraha", "en": "Warning" },
        "body": { "cs": "Strucny popis.", "en": "Short description." },
        "recommendedAction": { "cs": "Sledujte pokyny.", "en": "Follow instructions." },
        "localeFallback": "cs",
        "suggestedAlertId": "sim.safety-data:safety.weather_alerts:feature-id:2026-06-29T08:00:00Z:2026-06-29T18:00:00Z",
        "suggestedDeepLink": "csm://map/alert/..."
      },
      "messaging": {
        "suggestedHeaders": {
          "X-Source-System-Id": "sim.safety-data",
          "X-Contract-Version": "csm-notification-request-v1",
          "X-Idempotency-Key": "sim.safety-data:safety.weather_alerts:feature-id:2026-06-29T08:00:00Z:2026-06-29T18:00:00Z"
        },
        "requiredAudienceDecisionOwner": "cop",
        "recommendedChannels": ["push", "in_app"]
      }
    }
  ]
}
```

`feature.geometry` je urcena pro geofence rozhodnuti COP. COP muze misto ni
pouzivat jen `geometrySummary`, pokud dela jen list nebo pocitadla. Raw upstream
payloady nejsou soucasti kandidatniho kontraktu. SIM kandidatni odpoved
deduplikuje podle `candidateId`; pocet zahozenych duplicit je v
`summary.duplicateSkippedCount`.

## Povinna pole pro COP

Kazda notifikovatelna feature ma poskytovat:

```json
{
  "properties": {
    "featureId": "stable-provider-feature-id",
    "layerId": "public.safety.weather_alerts",
    "providerId": "sim.safety-data",
    "providerLayerId": "safety.weather_alerts",
    "severity": "warning",
    "urgency": "expected",
    "certainty": "likely",
    "confidence": 0.82,
    "validFrom": "2026-05-29T08:00:00Z",
    "validUntil": "2026-05-29T18:00:00Z",
    "updatedAt": "2026-05-29T07:40:00Z",
    "source": "chmi_alerts",
    "sourceName": "CHMI CAP weather warnings",
    "headline": "Silne bourky",
    "description": "Normalizovany popis jevu.",
    "recommendedAction": "Sledujte oficialni pokyny.",
    "stale": false
  }
}
```

COP smi pouzit tato pole pro rozhodnuti, zda vytvorit pozadavek do CSM
Messaging. SIM ale nedodava audience.

## Notification policy v katalogu

Safety katalog u uzivatelskych vrstev obsahuje `notificationPolicy`:

```json
{
  "eligible": true,
  "audienceDecisionOwner": "cop",
  "deliveryOwner": "csm-messaging",
  "deduplicationKeyFields": [
    "providerId",
    "providerLayerId",
    "featureId",
    "validFrom",
    "validUntil"
  ],
  "recommendedNotificationTypes": ["safety.alert"],
  "minimumSeverityForUserPush": "advisory",
  "technicalWarningsPolicy": "never_push_to_public_users"
}
```

`minimumSeverityForUserPush` je doporuceni pro bezne uzivatele, ne absolutni
bezpecnostni pravidlo. COP muze pouzit prisnejsi politiku podle uzivatele,
role, lokality nebo rezimu aplikace.

## Deduplikace

COP ma pro CSM Messaging vytvorit stabilni `Idempotency-Key`, napr.:

```text
sim.safety-data:safety.weather_alerts:<featureId>:<validFrom>:<validUntil>
```

CSM Messaging musi stejny klic deduplikovat, aby opakovane dotazy COP na SIM
nevytvarely duplicitni push.

Pokud COP pouzije kandidatni endpoint, ma prednost
`candidate.messaging.suggestedHeaders["X-Idempotency-Key"]`. COP smi pridat
vlastni suffix pouze tehdy, kdyz stejnou udalost zamerne rozdeluje na vice
nezavislych kampani nebo audience segmentu.

## Pokyn pro COP

1. COP vola `GET /safety-data/api/v1/notifications/candidates` server-to-server.
2. COP vyžaduje `inputReadiness.status=ready`, vlastní očekávané zdroje a
   odvolatelný uživatelský opt-in. Filtruje kandidaty podle role, opravneni,
   sledovane oblasti / AOI, aktualni polohy, ticheho rezimu a preferenci.
3. COP nevytvari push z `response.warnings`, health/readiness, cache/stale
   degradace ani z diagnostickych vrstev.
4. COP vytvori finalni pozadavek do CSM Messaging az po audience rozhodnuti.
5. COP prevezme `candidate.message.title/body/recommendedAction` podle jazyka
   uzivatele a pouzije `localeFallback=cs`, pokud cilovy jazyk chybi.
6. COP pouzije `candidate.message.suggestedDeepLink` pro otevreni detailu v
   Messengeru nebo COP mape.
7. COP posle do CSM Messaging `X-Idempotency-Key`, `X-Source-System-Id` a
   `X-Contract-Version` podle `candidate.messaging.suggestedHeaders`.

## Pokyn pro CSM Messaging a Messenger

CSM Messaging neprijima kandidatni odpoved primo od SIM. Prijima pouze finalni
pozadavek od COP, ktery uz obsahuje adresaty nebo audience segment, kanal a
politiku doruceni.

CSM Messaging musi:

- deduplikovat podle `X-Idempotency-Key`,
- ulozit delivery audit pro kandidatni `candidateId`/`suggestedAlertId`,
- respektovat kanal vybrany COP (`push`, `in_app`, pripadne dalsi kanal),
- ulozit lokalizovane `title`, `body` a `recommendedAction`,
- predat klientovi deeplink na detail udalosti,
- neposilat raw provider payloady ani interni SIM diagnostiku do push payloadu.

CSM Messenger klient ma zobrazit text pripraveny COP/Messagingem, otevrit
deeplink do detailu a neziskavat si sam kandidatni endpoint SIM. SIM zustava
server-to-server provider.

SIM neimplementuje nový background push scheduler a tato kandidátní změna
nedokládá skutečné doručení na zařízení. Způsob průběžného vyhodnocování,
uživatelský opt-in, AOI a objednání doručení zůstávají v COP; registry/kanály
a audit v CSM Messaging. Osm regionálních feedů není blanket pokrytí IZS.

## Technicke warningy

SIM muze vracet `warnings`, `sourceHealth`, `stale`, `cache` nebo `upstream`
degradaci. Tyto informace jsou urcene pro provozni dohled a COP admin UI.
Technická metadata nikdy nejsou samostatnou občanskou push notifikací;
samostatný způsobilý safety kandidát musí projít výše uvedenými gates.
