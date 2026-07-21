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

| Systém                              | Současný zdroj                                            | Stav                                                                                                                                                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PID / Praha a Středočeský kraj      | Golemio/PID GTFS-RT vehicle positions + PID statický GTFS | mapová vrstva vozidel a detail vozidla jsou implementované                                                                                                                                                                                               |
| Veřejné statické GTFS/GeoJSON feedy | `public_transit_static`                                   | statické zastávky jsou publikované jako samostatná referenční vrstva `public.traffic.transit_stops`; výchozí ověřená sada je PID, IDS JMK, DPMO Olomouc, PMDP Plzeň, DPMLJ Liberec/Jablonec a DPO Ostrava GeoJSON, další města se přidávají konfiguračně |
| IDS JMK / Brno a JMK                | IDS JMK vehicle positions JSON                            | existuje mapová vrstva vozidel a normalizovaný detail vozidla nad live feedem; úplná sekvence zastávek a tvar trasy vyžadují stabilní match na statický GTFS trip                                                                                        |
| Správa železnic / celá ČR           | Veřejná mapa provozu vlaků Správy železnic                | existuje mapová vrstva vlaků a normalizovaný detail vlaku nad live feedem; SIM dekóduje zdrojový formát, převádí S-JTSK do WGS84 a vynucuje minimální upstream interval 15 minut                                                                         |
| Další města ČR                      | GTFS static + GTFS-RT, nebo proprietární open-data API    | přidávat po ověření stabilní primární URL, licence a provozního limitu                                                                                                                                                                                   |

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

COP může nad jedním `recommendedCatalogLayerId=public.traffic.transit` vytvořit
jemnější UI submenu podle `providerLayerId` a `providerProperties.transit`:

- `traffic.spravazeleznic_trains` -> Vlaky,
- `traffic.pid_gtfs_rt` -> Praha/PID,
- `traffic.idsjmk_vehicle_positions` -> Brno/IDS JMK,
- budoucí města/regiony -> samostatná položka podle `systemId` a popisku
  provider vrstvy.

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

## Refresh a pohyb prvků

COP nesmí odvozovat pohyb prvku jen ze sdílené katalogové vrstvy
`public.traffic.transit`. Tuto vrstvu používá více providerů s různou
periodicitou. COP musí číst `providerLayerId`, `sourceId` a hlavně
`providerProperties.transit.positionKind`.

| `positionKind`        | Význam                                                                                 | Doporučené chování COP                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vehicle_live`        | skutečná živá poloha vozidla, např. PID nebo IDS JMK                                   | obnovovat daný provider podle `providerProperties.transit.refreshSeconds`, pro PID typicky 15 s; polohu po `validUntil` označit jako zastaralou nebo skrýt |
| `vehicle_live_cached` | poloha vozidla z live veřejného feedu s provozním limitem cache, např. Správa železnic | obnovovat krokově podle `refreshSeconds`, pro Správu železnic 900 s; nečekat plynulý pohyb mezi každými dotazy                                             |
| `static_stop`         | statická zastávka, terminál nebo referenční dopravní bod                               | nikdy neanimovat a nezobrazovat jako vozidlo; dotazovat až od lokálního zoomu podle katalogu                                                               |

Normalizovaná pole:

- `providerProperties.transit.livePosition`: `true` jen pro vozidla,
- `providerProperties.transit.motionExpected`: zda se má prvek mezi obnovami
  posouvat,
- `providerProperties.transit.refreshSeconds`: doporučený interval obnovy
  konkrétního provideru,
- `providerProperties.transit.cacheTtlSeconds`: zdrojový TTL v SIM,
- `properties.observedAt` a `properties.validUntil`: časová platnost konkrétní
  polohy.

Pokud COP sloučí provider vrstvy pod jednu UI položku, musí uvnitř držet
samostatné refresh cykly. Pomalý zdroj `spravazeleznic_trains` s limitem 900 s
nesmí zpomalit `pid_gtfs_rt`. Statické zastávky `public_transit_static` patří do
`public.traffic.transit_stops`, ne do animace vozidel.

Výchozí kadence `pid_gtfs_rt` je 15 s a `idsjmk_vehicle_positions` 20 s. SIM
publikuje tyto hodnoty v katalogu i ve feature `providerProperties`; klient je
nemá přepisovat pomalejším společným intervalem celé dopravní vrstvy.

## Mapová feature vozidla

Endpoint:

```http
GET /situation-data/api/v1/features?bbox=...&layers=traffic&source=pid_gtfs_rt&limit=250
GET /situation-data/api/v1/features?bbox=...&layers=traffic&source=spravazeleznic_trains&limit=250
GET /situation-data/api/v1/features?bbox=...&layers=traffic&source=public_transit_static&limit=250
```

Feature vozidla je `Point`. COP kreslí bod/ikonu a číslo linky.

Povinná a doporučená pole:

| Pole                                        | Význam                                                                                                                             |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `properties.layerId`                        | `public.traffic.transit`                                                                                                           |
| `properties.providerLayerId`                | např. `traffic.pid_gtfs_rt`                                                                                                        |
| `properties.category`                       | `public_transport_bus`, `public_transport_tram`, `public_transport_metro`, `public_transport_train`, `public_transport_trolleybus` |
| `properties.label`                          | hotový krátký popisek, např. `PID tram 10`                                                                                         |
| `properties.transportMode`                  | `bus`, `tram`, `metro`, `train`, `trolleybus`                                                                                      |
| `properties.routeShortName`                 | číslo/linka, např. `10`                                                                                                            |
| `properties.destination`                    | cílová stanice/směr, pokud je známý                                                                                                |
| `properties.vehicleId`                      | stabilní ID vozidla ve zdroji                                                                                                      |
| `properties.tripId`                         | trip ID, pokud je známé                                                                                                            |
| `properties.delaySeconds`                   | aktuální zpoždění; záporné číslo znamená náskok                                                                                    |
| `properties.observedAt`                     | čas poslední zprávy o poloze                                                                                                       |
| `properties.validUntil`                     | kdy má COP považovat polohu za zastaralou                                                                                          |
| `properties.confidence`                     | důvěra v polohu/detail                                                                                                             |
| `properties.headingDeg`                     | směr pohybu                                                                                                                        |
| `properties.speedMps`                       | rychlost                                                                                                                           |
| `properties.occupancyStatus`                | normalizovaná obsazenost, pokud existuje                                                                                           |
| `properties.operator`                       | např. `PID`, `IDS JMK`                                                                                                             |
| `properties.styleHint`                      | doporučený styl, např. `transit-vehicle-position-v1`                                                                               |
| `properties.iconHint`                       | doporučená ikona podle módu                                                                                                        |
| `providerProperties.transit.positionKind`   | `vehicle_live`, `vehicle_live_cached`, nebo `static_stop`                                                                          |
| `providerProperties.transit.refreshSeconds` | interval obnovy pro konkrétní provider                                                                                             |

`providerProperties.transit` doplňuje auditní a detailní hodnoty:

```json
{
  "systemId": "pid",
  "sourceId": "pid_gtfs_rt",
  "positionKind": "vehicle_live",
  "livePosition": true,
  "motionExpected": true,
  "refreshSeconds": 20,
  "cacheTtlSeconds": 20,
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
  `delayMinutes`, `delayText`,
- `providerProperties.transit.detailAvailable=true`,
- `providerProperties.transit.detailUrl` pro jednotný detailní endpoint.

COP nemá parsovat zkrácené zdrojové klíče Správy železnic ani volat jejich mapový
backend přímo. SIM drží jednu zdrojovou cache pro celý vlakový feed s minimálním
TTL 900 s a bbox aplikuje lokálně.

## Detail statické zastávky, linky a spoje

SIM drží dlouhodobý read-model pro `public_transit_static`. Model vzniká ze
všech nakonfigurovaných statických GTFS a GeoJSON feedů a ukládá zastávky,
linky, spoje, jízdní řády, kalendáře a dostupné tvary tras. COP dál používá
stejnou mapovou vrstvu `public.traffic.transit_stops`; po kliknutí na zastávku
má použít `providerProperties.transit.detailUrl`.

Mapová feature statické zastávky obsahuje:

```json
{
  "providerProperties": {
    "transit": {
      "systemId": "pid",
      "sourceId": "public_transit_static",
      "positionKind": "static_stop",
      "livePosition": false,
      "motionExpected": false,
      "refreshSeconds": 21600,
      "stopId": "U1234",
      "stopName": "Florenc",
      "staticOnly": true,
      "detailAvailable": true,
      "detailUrl": "/situation-data/api/v1/transit/stops/pid/U1234?source=public_transit_static"
    }
  }
}
```

Detailní endpointy:

```http
GET /situation-data/api/v1/transit/stops/{systemId}/{stopId}
GET /situation-data/api/v1/transit/stops/{systemId}/{stopId}/departures
GET /situation-data/api/v1/transit/routes/{systemId}/{routeId}
GET /situation-data/api/v1/transit/trips/{systemId}/{tripId}
```

Volitelné parametry:

- `date=YYYY-MM-DD` nebo `YYYYMMDD` a `time=HH:MM[:SS]` pro výpočet odjezdů,
- `maxDepartures`, `maxRoutes`, `maxTrips`, `maxStopTimes`, `maxShapePoints`,
- `includeShape=true|false` u detailu linky a spoje.

COP má zobrazit hlavně:

- u zastávky: název, systém, kód zastávky, dostupné linky a nejbližší odjezdy,
- u linky/spoje: číslo linky, směr, seznam zastávek a `routeShape`, pokud je
  k dispozici,
- `quality.warnings`, pokud SIM hlásí částečně dostupný feed.

GeoJSON zdroje bez GTFS jízdního řádu vracejí detail zastávky bez odjezdů.
To je očekávaný stav, ne chyba COP.

## Detail vozidla

Pro COP detail poskytuje SIM rozšířený detail nad existující feature detail.
Implementovaný endpoint:

```http
GET /situation-data/api/v1/transit/vehicles/{featureId}?source=pid_gtfs_rt
GET /situation-data/api/v1/transit/vehicles/{featureId}?source=idsjmk_vehicle_positions
GET /situation-data/api/v1/transit/vehicles/{featureId}?source=spravazeleznic_trains
```

Alternativně může být stejný dokument vložen do
`GET /situation-data/api/v1/features/{featureId}` v
`providerProperties.transitDetail`. Samostatný endpoint je preferovaný, protože
detail může obsahovat delší stop list a geometrii trasy.

Pro PID endpoint slučuje SIM aktuální GTFS-RT polohu vozidla, GTFS-RT
TripUpdates a cacheovaný statický `PID_GTFS.zip`. První dotaz po restartu může
být pomalejší kvůli načtení ZIPu, další dotazy používají SIM cache. Pokud je
pro konkrétní vozidlo nalezen odpovídající TripUpdate, odpověď má
`quality.tripUpdateAvailable=true` a `prediction.delaySource=official_trip_update`.
Když TripUpdate chybí nebo upstream dočasně selže, SIM zachová stejný kontrakt a
použije dosavadní odhad ze statického jízdního řádu a polohy vozidla.

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

| Hodnota      | Význam pro COP                                      |
| ------------ | --------------------------------------------------- |
| `on_time`    | spoj jede včas; typicky tolerance do 60 s           |
| `early`      | spoj jede s náskokem                                |
| `delayed`    | spoj je zpožděný                                    |
| `stopped`    | vozidlo stojí v zastávce nebo mimo trasu            |
| `in_transit` | vozidlo jede, ale přesný vztah k zastávce není znám |
| `stale`      | poloha je zastaralá                                 |
| `unknown`    | zdroj neposkytl dost dat                            |

COP nemá stav odvozovat z barvy ani z upstream polí; používá normalizované
`vehicle.status`, `delaySeconds`, `observedAt` a `quality`.

## Geometrie a výkon

Mapová vrstva vozidel má zůstat lehká:

- běžný bbox dotaz vrací jen body vozidel,
- detail trasy a stop list se tahá až po kliknutí,
- route shape má být zjednodušená podle zoomu nebo předpočítaná v read-modelu,
- SIM drží source cache pro realtime feed a persistent/static cache pro GTFS,
- PID detail vozidla drží samostatnou krátkou cache pro `vehicle_positions.pb`
  a `trip_updates.pb`, aby více COP dotazů nezatěžovalo Golemio,
- COP používá clustering/decluttering podle zoomu, neplošné celostátní načtení.

Pro celoměstský provoz:

- `refreshSeconds`: 10-20 s podle zdroje,
- `validUntil`: obvykle `observedAt + 120 s`,
- `limit`: pro mapu doporučeně 250-1000 podle zoomu, pro velké městské nebo
  celostátní přehledy lze požádat až o 5000 prvků,
- detail vozidla má vlastní cache klíč podle `vehicleId/tripId/serviceDate`,
- detail vozidla vrací `history` a `prediction`; pro PID má SIM napojený
  GTFS-RT TripUpdates feed a při nalezené shodě vrací
  `quality.tripUpdateAvailable=true` a `delaySource=official_trip_update`;
  pokud shoda pro konkrétní vozidlo chybí, predikce je označená jako
  `delaySource=estimated_from_schedule` nebo `unavailable`.

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

Pro IDS JMK a Správu železnic endpoint zatím vrací detail nad live feedem:

- aktuální polohu, linku/vlak, směr/cíl, dopravce, zpoždění a pohybové údaje,
- krátkou in-memory historii bodů od posledního běhu služby,
- u vlaků aktuální a následující stanici, pokud je zdroj posílá,
- `quality.staticModelAvailable=false` a `quality.routeShapeAvailable=false`,
  dokud SIM nedoplní stabilní statický rail/regionální trip model.

COP má tyto detaily zobrazit jako platný detail vozidla, ne jako chybu. Pokud
`routeShapeAvailable=false`, nezobrazovat trasovou geometrii a v detailu uvést
omezení z `quality.warnings`.

## Pokyn pro COP

COP má pro veřejnou dopravu implementovat pouze prezentační logiku:

- vrstvy brát z katalogu `public.traffic.transit`,
- dotazovat `layers=traffic` podle bboxu mapy,
- obnovovat každou provider vrstvu podle jejího vlastního `refreshSeconds`,
  ne podle nejpomalejšího zdroje v celé sdílené dopravní vrstvě,
- kreslit bod vozidla podle `transportMode`, `routeShortName`, `headingDeg` a
  `delaySeconds`,
- veřejnou dopravu v UI dělit minimálně podle provider vrstvy: Vlaky
  (`spravazeleznic_trains`), Praha/PID (`pid_gtfs_rt`), Brno/IDS JMK
  (`idsjmk_vehicle_positions`) a Statické zastávky (`public_transit_static`);
  další města dělit podle `providerProperties.transit.systemId`,
- statické zastávky PID/Praha číst z `public.traffic.transit_stops`
  přes `source=public_transit_static`; SIM je publikuje jako body s
  `providerLayerId=traffic.public_transit_static`,
- animovat nebo interpolovat jen prvky s
  `providerProperties.transit.positionKind=vehicle_live`; prvky
  `vehicle_live_cached` obnovovat krokově a `static_stop` nikdy neanimovat,
- po kliknutí na vozidlo otevřít detail z detailního transit endpointu a pro
  volby Historie/Predikce používat pouze `history` a `prediction` z odpovědi
  SIM; COP nemá dopočítávat trip schedule ani delay z raw GTFS,
- v detailu rozlišit `prediction.delaySource=official_trip_update` jako
  oficiální GTFS-RT predikci; hodnoty `estimated_from_schedule` a `unavailable`
  zobrazit jako odhad nebo chybějící predikci,
- po kliknutí na statickou zastávku použít `providerProperties.transit.detailUrl`
  a zobrazit odjezdy/linky ze SIM read-modelu,
- v detailu zobrazit hlavičku vozidla, stav, stáří dat, příští zastávku, tabulku
  zastávek a trasu,
- nikdy nevolat Golemio, IDS JMK ani jiné městské upstreamy přímo,
- nezobrazovat veřejnou dopravu jako bezpečnostní track nebo taktický objekt.

## Implementační pořadí v SIM

1. PID statický GTFS read-model pro `routes`, `trips`, `stops`, `stop_times`
   a `shapes` je implementovaný pro detail vozidla.
2. Obecný statický read-model pro `public_transit_static` je implementovaný pro
   detail zastávky, odjezdy, linky, spoje a dostupné tvary tras.
3. `providerProperties.transit` včetně `positionKind`, `livePosition`,
   `motionExpected` a `refreshSeconds` je implementované pro PID, IDS JMK,
   Správu železnic a statické zastávky.
4. `GET /situation-data/api/v1/transit/vehicles/{featureId}` je implementovaný
   pro PID, IDS JMK a Správu železnic. PID má plný GTFS-RT/static detail; IDS
   JMK a Správa železnic mají normalizovaný live detail s explicitními quality
   omezeními.
5. PID TripUpdates jsou implementované pro detail vozidla; service alerts
   zůstávají navazující rozšíření.
6. Doplnit stabilní statický trip/shape match pro IDS JMK a železnici, aby šlo
   kreslit celé trasy i mimo PID.
7. Připravit registry dalších měst a kontrolní testy pro každý adaptér.
