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
```

Katalogove vrstvy vhodne pro uzivatelske vyhodnoceni:

- `public.safety.weather_alerts`
- `public.safety.fire`
- `public.safety.flood`

Referencni vrstvy, technicke vstupy a serverove warningy nejsou samy o sobe
notifikace pro obcana:

- `public.boundary.admin`
- vsechny diagnosticke/source-health warningy,
- stale/cache/upstream degradace bez civilni udalosti.

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

## Technicke warningy

SIM muze vracet `warnings`, `sourceHealth`, `stale`, `cache` nebo `upstream`
degradaci. Tyto informace jsou urcene pro provozni dohled a COP admin UI.
Nesmí byt posilane obcanum jako bezpecnostni push notifikace, pokud nejsou
soucasti realne safety feature.
