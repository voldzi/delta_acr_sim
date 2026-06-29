# CSM notification input contract

**Status:** Autoritativni hranice SIM pro uzivatelske notifikace.

SIM je server-to-server datovy provider. SIM nikdy neposila push notifikace
uzivatelum, neuklada APNs tokeny, nezna zarizeni, skupiny ani uzivatelske
preference. Tyto informace patri do COP a CSM Messaging.

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
- stale/cache/upstream degradace bez civilni udalosti.

## Autoritativni kandidatni endpoint

COP ma pro push a in-app notifikace pouzivat kandidatni endpoint:

```http
GET /safety-data/api/v1/notifications/candidates?bbox=...&layers=warnings,weather_alerts,fire,flood&minSeverity=advisory&limit=100
```

Podporovane parametry:

- `bbox=west,south,east,north` omezuje prostor, pro ktery COP hleda udalosti.
- `layers=warnings,weather_alerts,fire,flood`; vychozi hodnota je tato sada.
- `source=chmi_alerts,chmi_hydro,nasa_firms,gdacs_alerts,hzs_incidents,road_srti_lod` nebo `source=mock` pro test.
- `minSeverity=info|advisory|warning|critical`; vychozi je `advisory`.
- `includeStale=true|false`; vychozi je `false`.
- `limit=1..1000`; vychozi je `100`.

Odpoved ma `contractVersion=sim-safety-notification-candidates-v1`. SIM v ni
vraci pouze kandidatni udalosti a hotove lokalizovane texty. SIM tim stale
nerozhoduje o adresatech ani kanalech.

Zkraceny tvar odpovedi:

```json
{
  "contractVersion": "sim-safety-notification-candidates-v1",
  "providerId": "sim.safety-data",
  "policy": {
    "audienceDecisionOwner": "cop",
    "deliveryOwner": "csm-messaging",
    "notificationType": "safety.alert",
    "technicalWarningsPolicy": "never_push_to_public_users"
  },
  "summary": {
    "candidateCount": 1,
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
payloady nejsou soucasti kandidatniho kontraktu.

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
2. COP filtruje kandidaty podle role, opravneni, sledovane oblasti, aktualni
   polohy, ticheho rezimu a uzivatelskych preferenci.
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

## Technicke warningy

SIM muze vracet `warnings`, `sourceHealth`, `stale`, `cache` nebo `upstream`
degradaci. Tyto informace jsou urcene pro provozni dohled a COP admin UI.
Nesmí byt posilane obcanum jako bezpecnostni push notifikace, pokud nejsou
soucasti realne safety feature.
