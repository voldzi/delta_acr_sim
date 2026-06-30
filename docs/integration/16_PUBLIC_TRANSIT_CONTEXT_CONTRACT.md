# Public Transit Context Contract

## Stav

Tento dokument definuje cílový kontrakt veřejné dopravy pro COP. Navazuje na
existující `situation-data` vrstvu `public.traffic.transit`, která dnes publikuje
živé polohy vozidel PID/Golemio GTFS-RT, IDS JMK a vlaků Správy železnic. Cílem je rozšířit
SIM tak, aby COP nemusel znát konkrétní městské API, GTFS strukturu ani logiku
spojování realtime a statických dat.

## Princip

SIM je autoritativní server-side normalizační vrstva pro veřejnou dopravu. COP
má pouze vykreslovat hotové mapové prvky, detail vozidla a detail spoje.

Pro každý dopravní systém SIM normalizuje:

- statické GTFS: dopravce, linky, trasy, směry, zastávky, stop times, kalendáře
  a tvary tras,
- GTFS-RT nebo ekvivalent: aktuální polohy vozidel, trip updates a service
  alerts,
- provozní kvalitu: stáří dat, dostupnost zdroje, důvěru, zpoždění, fallbacky,
- detail pro COP: hlavičku vozidla, aktuální/poslední/příští zastávku, tabulku
  zastávek a geometrii aktuálního spoje.

COP nesmí volat městská upstream API přímo a nemá parsovat `raw`/provider-native
payload. Všechna významová pole pro UI musí být v plochých `properties` nebo v
normalizovaném `providerProperties.transit`.

## Zdroje a adaptér

Každý městský nebo regionální systém se přidává jako adaptér nad společným
modelem.

| Systém | Současný zdroj | Stav |
| --- | --- | --- |
| PID / Praha a Středočeský kraj | Golemio/PID GTFS-RT vehicle positions + PID statický GTFS | mapová vrstva vozidel a detail vozidla jsou implementované |
| Veřejné statické GTFS/GeoJSON feedy | `public_transit_static` | statické zastávky jsou publikované jako samostatná referenční vrstva `public.traffic.transit_stops`; výchozí ověřená sada je PID, IDS JMK, DPMO Olomouc, PMDP Plzeň, DPMLJ Liberec/Jablonec a DPO Ostrava GeoJSON, další města se přidávají konfiguračně |
| IDS JMK / Brno a JMK | IDS JMK vehicle positions JSON | existuje volitelná mapová vrstva vozidel, detail je zatím označený jako nedostupný |
| Správa železnic / celá ČR | Veřejná mapa provozu vlaků Správy železnic | existuje volitelná mapová vrstva vlaků; SIM dekóduje zdrojový formát, převádí S-JTSK do WGS84 a vynucuje minimální upstream interval 15 minut |
| Další města ČR | GTFS static + GTFS-RT, nebo proprietární open-data API | přidávat po ověření stabilní primární URL, licence a provozního limitu |

Adaptér musí do SIM dodat jednotný objekt:

- `systemId`: stabilní kód systému, např. `pid`, `idsjmk`, `dpo`, `dpmlj`,
- `sourceId`: zdroj v SIM, např. `pid_gtfs_rt`,
- `operator`: dopravní systém nebo dopravce pro uživatele,
- `license`: atribuce a právní poznámky,
- `vehiclePositions`: realtime polohy,
- `tripUpdates`: odhady a zpoždění,
- `serviceAlerts`: výluky a mimořádnosti,
- `staticModel`: linky, zastávky, tvary tras a jízdní řády.

## Katalogová vrstva

SIM publikuje live vozidla veřejné dopravy do jedné katalogové vrstvy:

```text
recommendedCatalogLayerId: public.traffic.transit
providerLayerId: traffic.<source>
layers: traffic
kind: vector_features
role: reference
audience: public
styleProfile: transit-vehicle-position-v1
```

Současné zdroje:

- `traffic.pid_gtfs_rt`,
- `traffic.idsjmk_vehicle_positions`,
- `traffic.spravazeleznic_trains`.

Budoucí zdroje mají používat stejný `recommendedCatalogLayerId`, aby COP nemusel
přidávat novou vrstvu pro každé město. Rozlišení systému, linky a dopravce je v
properties.

Statické zastávky z veřejných GTFS ZIPů jsou oddělené od live vozidel:

```text
recommendedCatalogLayerId: public.traffic.transit_stops
providerLayerId: traffic.public_transit_static
layers: traffic
kind: vector_features
role: reference
audience: public
styleProfile: transit-stop-static-v1
```

COP je má zobrazovat až od lokálního zoomu podle katalogového `minZoom`, aby
nedošlo k zahlcení mapy při celostátním pohledu.

## Mapová feature vozidla

Endpoint:

```http
GET /situation-data/api/v1/features?bbox=...&layers=traffic&source=pid_gtfs_rt&limit=250
GET /situation-data/api/v1/features?bbox=...&layers=traffic&source=spravazeleznic_trains&limit=250
GET /situation-data/api/v1/features?bbox=...&layers=traffic&source=public_transit_static&limit=250
```

Feature vozidla je `Point`. COP kreslí bod/ikonu a číslo linky.

Povinná a doporučená pole:

| Pole | Význam |
| --- | --- |
| `properties.layerId` | `public.traffic.transit` |
| `properties.providerLayerId` | např. `traffic.pid_gtfs_rt` |
| `properties.category` | `public_transport_bus`, `public_transport_tram`, `public_transport_metro`, `public_transport_train`, `public_transport_trolleybus` |
| `properties.label` | hotový krátký popisek, např. `PID tram 10` |
| `properties.transportMode` | `bus`, `tram`, `metro`, `train`, `trolleybus` |
| `properties.routeShortName` | číslo/linka, např. `10` |
| `properties.destination` | cílová stanice/směr, pokud je známý |
| `properties.vehicleId` | stabilní ID vozidla ve zdroji |
| `properties.tripId` | trip ID, pokud je známé |
| `properties.delaySeconds` | aktuální zpoždění; záporné číslo znamená náskok |
| `properties.observedAt` | čas poslední zprávy o poloze |
| `properties.validUntil` | kdy má COP považovat polohu za zastaralou |
| `properties.confidence` | důvěra v polohu/detail |
| `properties.headingDeg` | směr pohybu |
| `properties.speedMps` | rychlost |
| `properties.occupancyStatus` | normalizovaná obsazenost, pokud existuje |
| `properties.operator` | např. `PID`, `IDS JMK` |
| `properties.styleHint` | doporučený styl, např. `transit-vehicle-position-v1` |
| `properties.iconHint` | doporučená ikona podle módu |

`providerProperties.transit` doplňuje auditní a detailní hodnoty:

```json
{
  "systemId": "pid",
  "routeId": "10",
  "routeShortName": "10",
  "tripId": "trip-10-20260630",
  "directionId": "0",
  "vehicleLabel": "#9397",
  "currentStopSequence": 12,
  "currentStatus": "in_transit_to",
  "stopId": "U1234",
  "detailUrl": "/situation-data/api/v1/transit/vehicles/traffic%3Apid_gtfs_rt%3Avehicle-123?source=pid_gtfs_rt",
  "positionQuality": "realtime",
  "staticModelVersion": "2026-06-30",
  "realtimeSourceAgeSeconds": 22
}
```

Pro `spravazeleznic_trains` SIM poskytuje minimálně:

- `properties.transportMode=train`,
- `properties.category=public_transport_train`,
- `properties.routeShortName` ve tvaru typu a čísla vlaku, např. `R 654`,
- `properties.destination`, `properties.operator`, `properties.delaySeconds`,
- `providerProperties.transit.trainType`, `trainNumber`, `trainName`,
  `origin`, `destination`, `currentStationName`, `nextStationName`,
  `plannedTime`, `currentTime`, `nextScheduledTime`, `nextPredictedTime`,
  `delayMinutes`, `delayText`.

COP nemá parsovat zkrácené zdrojové klíče Správy železnic ani volat jejich mapový
backend přímo. SIM drží jednu zdrojovou cache pro celý vlakový feed s minimálním
TTL 900 s a bbox aplikuje lokálně.

## Detail vozidla

Pro COP detail poskytuje SIM rozšířený detail nad existující feature detail.
Implementovaný endpoint:

```http
GET /situation-data/api/v1/transit/vehicles/{featureId}?source=pid_gtfs_rt
```

Alternativně může být stejný dokument vložen do
`GET /situation-data/api/v1/features/{featureId}` v
`providerProperties.transitDetail`. Samostatný endpoint je preferovaný, protože
detail může obsahovat delší stop list a geometrii trasy.

Pro PID endpoint slučuje aktuální GTFS-RT polohu s cacheovaným statickým
`PID_GTFS.zip`. První dotaz po restartu může být pomalejší kvůli načtení ZIPu,
další dotazy používají SIM cache.

Odpověď:

```json
{
  "contractVersion": "sim-transit-vehicle-detail-v1",
  "providerId": "sim.situation-data",
  "featureId": "traffic:pid_gtfs_rt:vehicle-123",
  "generatedAt": "2026-06-30T12:00:00.000Z",
  "vehicle": {
    "systemId": "pid",
    "vehicleId": "vehicle-123",
    "label": "#9397",
    "operator": "PID",
    "mode": "tram",
    "routeShortName": "10",
    "destination": "Sídliště Řepy",
    "status": "on_time",
    "delaySeconds": 6,
    "observedAt": "2026-06-30T12:00:00.000Z",
    "dataAgeSeconds": 22,
    "confidence": 0.92
  },
  "trip": {
    "tripId": "trip-10-20260630",
    "routeId": "10",
    "directionId": "0",
    "serviceDate": "2026-06-30",
    "originStop": {
      "stopId": "U1000",
      "name": "Sídliště Ďáblice",
      "scheduledDeparture": "16:05:00",
      "realtimeDeparture": "16:05:10"
    },
    "previousStop": {
      "stopId": "U1100",
      "name": "Třebenická",
      "scheduledArrival": "16:06:00",
      "realtimeArrival": "16:06:07"
    },
    "nextStop": {
      "stopId": "U1200",
      "name": "Štěpničná",
      "scheduledArrival": "16:07:00",
      "realtimeArrival": "16:06:47"
    },
    "destinationStop": {
      "stopId": "U9999",
      "name": "Sídliště Řepy"
    }
  },
  "stopTimes": [
    {
      "sequence": 1,
      "stopId": "U1000",
      "name": "Sídliště Ďáblice",
      "scheduledArrival": "16:05:00",
      "realtimeArrival": "16:05:10",
      "scheduledDeparture": "16:05:00",
      "realtimeDeparture": "16:05:10",
      "delaySeconds": 10,
      "status": "departed"
    }
  ],
  "routeShape": {
    "type": "LineString",
    "coordinates": []
  },
  "alerts": [],
  "quality": {
    "staticModelAvailable": true,
    "tripUpdateAvailable": true,
    "vehiclePositionAvailable": true,
    "shapeAvailable": true,
    "stale": false,
    "warnings": []
  }
}
```

## Stav vozidla

SIM normalizuje stav do těchto hodnot:

| Hodnota | Význam pro COP |
| --- | --- |
| `on_time` | spoj jede včas; typicky tolerance do 60 s |
| `early` | spoj jede s náskokem |
| `delayed` | spoj je zpožděný |
| `stopped` | vozidlo stojí v zastávce nebo mimo trasu |
| `in_transit` | vozidlo jede, ale přesný vztah k zastávce není znám |
| `stale` | poloha je zastaralá |
| `unknown` | zdroj neposkytl dost dat |

COP nemá stav odvozovat z barvy ani z upstream polí; používá normalizované
`vehicle.status`, `delaySeconds`, `observedAt` a `quality`.

## Geometrie a výkon

Mapová vrstva vozidel má zůstat lehká:

- běžný bbox dotaz vrací jen body vozidel,
- detail trasy a stop list se tahá až po kliknutí,
- route shape má být zjednodušená podle zoomu nebo předpočítaná v read-modelu,
- SIM drží source cache pro realtime feed a persistent/static cache pro GTFS,
- COP používá clustering/decluttering podle zoomu, neplošné celostátní načtení.

Pro celoměstský provoz:

- `refreshSeconds`: 10-20 s podle zdroje,
- `validUntil`: obvykle `observedAt + 120 s`,
- `limit`: pro mapu doporučeně 250-1000 podle zoomu,
- detail vozidla má vlastní cache klíč podle `vehicleId/tripId/serviceDate`.

## Přidání dalšího města

Nový dopravní systém se přidá takto:

1. Založit adapter se stabilním `sourceId`.
2. Popsat licenci a atribuci.
3. Importovat nebo cacheovat statické GTFS, pokud je dostupné.
4. Napojit realtime vozidla, trip updates a alerts, pokud jsou dostupné.
5. Mapovat data do společných polí `transportMode`, `routeShortName`,
   `destination`, `vehicleId`, `tripId`, `delaySeconds`, `headingDeg`,
   `speedMps`, `operator`.
6. Doplnit `providerProperties.transit` pro audit.
7. Zpřístupnit zdroj pod `public.traffic.transit` v katalogu.
8. Přidat kontraktové testy na mapovou feature i detail.

Pokud město nemá GTFS-RT trip updates, SIM stále může publikovat vozidla, ale
detail označí:

```json
{
  "quality": {
    "staticModelAvailable": true,
    "tripUpdateAvailable": false,
    "vehiclePositionAvailable": true,
    "shapeAvailable": true,
    "warnings": ["Realtime trip updates are not available for this system."]
  }
}
```

## Pokyn pro COP

COP má pro veřejnou dopravu implementovat pouze prezentační logiku:

- vrstvy brát z katalogu `public.traffic.transit`,
- dotazovat `layers=traffic` podle bboxu mapy,
- kreslit bod vozidla podle `transportMode`, `routeShortName`, `headingDeg` a
  `delaySeconds`,
- po kliknutí otevřít detail z detailního transit endpointu,
- v detailu zobrazit hlavičku vozidla, stav, stáří dat, příští zastávku, tabulku
  zastávek a trasu,
- nikdy nevolat Golemio, IDS JMK ani jiné městské upstreamy přímo,
- nezobrazovat veřejnou dopravu jako bezpečnostní track nebo taktický objekt.

## Implementační pořadí v SIM

1. PID statický GTFS read-model pro `routes`, `trips`, `stops`, `stop_times`
   a `shapes` je implementovaný pro detail vozidla.
2. `providerProperties.transit` je implementované pro PID a IDS JMK mapové
   features.
3. `GET /situation-data/api/v1/transit/vehicles/{featureId}` je implementovaný
   pro PID.
4. Přidat PID trip updates a service alerts, pokud jsou dostupné v dané
   distribuci.
5. Přidat IDS JMK statický/realtime detail stejným modelem.
6. Připravit registry dalších měst a kontrolní testy pro každý adaptér.
