# COP display guide: SIM aviation and ARDOS data

## Účel

Tento dokument popisuje, jak má COP zobrazit nová data poskytovaná SIM:

- letecké tracky z `flight-data`, včetně budoucích lokálních ADS-B přijímačů,
- letiště z OurAirports reference,
- letištní počasí METAR/TAF ze `situation-data` source `aviation_weather`,
- neveřejná partnerská data ARDOS ze `situation-data` source `ardos_partner`.

COP nesmí volat NOAA AWC, ARDOS, ADS-B providery ani OurAirports přímo. Všechny dotazy jdou přes SIM, která řeší cache, licenci, fallback a normalizaci.

## Endpointy

Produkční pilot:

```text
https://sim.zeleznalady.cz/flight-data/api/v1/cop/tracks
https://sim.zeleznalady.cz/flight-data/api/v1/airports
https://sim.zeleznalady.cz/flight-data/api/v1/sources
https://sim.zeleznalady.cz/situation-data/api/v1/cop/features
https://sim.zeleznalady.cz/situation-data/api/v1/sources
https://sim.zeleznalady.cz/situation-data/health/ready
```

Příklad pro mapový výřez Prahy:

```http
GET /situation-data/api/v1/cop/features?bbox=13.85,49.65,15.35,50.45&layers=weather&source=aviation_weather&limit=50
GET /situation-data/api/v1/cop/features?bbox=13.85,49.65,15.35,50.45&layers=ground,mobile,traffic&source=ardos_partner&limit=250
GET /flight-data/api/v1/cop/tracks?bbox=13.85,49.65,15.35,50.45&limit=500
GET /flight-data/api/v1/airports?bbox=13.85,49.65,15.35,50.45&limit=200
```

## Flight Data zobrazení

Kontrakt zůstává `cop-flight-source-v1`. COP má dál používat:

- `trackId` jako stabilní klíč,
- `lastSeenAt` pro historii a predikci,
- `quality.stale` pro ztlumení nebo skrytí neaktuálních tracků,
- `sources[].sourceId` pro badge zdroje.

Source badge:

| `sourceId` | Doporučený text | Význam |
| --- | --- | --- |
| `local_adsb` | Local ADS-B | Vlastní nebo partnerský readsb/dump1090 přijímač. |
| `adsb_lol` | ADSB.lol | Veřejný ADS-B agregát s ODbL atribucí. |
| `opensky` | OpenSky | Pouze licencovaný/omezený zdroj. |
| `mock` | SIM mock | Testovací syntetika. |

Historii a krátkou predikci drží COP lokálně nad `trackId`. SIM neposílá plánovanou trasu letu.

## Airport Reference zobrazení

`GET /flight-data/api/v1/airports` vrací letiště jako referenční objekty, ne jako živé tracky.

Doporučené kategorie:

- `large_airport`, `medium_airport`: zobrazit při nižším zoomu,
- `small_airport`, `heliport`: zobrazit až při detailnějším zoomu,
- `closed_airport`: defaultně skrýt nebo zobrazit jen v debug/reference vrstvě.

V detailu letiště zobraz:

- `ident`, `iata`,
- `name`, `municipality`, `countryCode`,
- `elevationFt`,
- `dataSource`.

Pokud `source.warnings` v odpovědi není prázdné, zobraz zdroj jako degraded, ale data stále použij.

## Aviation Weather zobrazení

`aviation_weather` přichází jako `cop-situation-source-v1` GeoJSON features ve vrstvě `weather`.

Každá feature má:

```json
{
  "id": "weather:aviation_weather:LKPR",
  "properties": {
    "sourceId": "aviation_weather",
    "layer": "weather",
    "category": "aviation_weather_station",
    "label": "LKPR VFR",
    "severity": "info",
    "metrics": {
      "temperatureC": 17,
      "windSpeedMps": 7.2,
      "windDirectionDeg": 280,
      "altimeterHpa": 1023,
      "ceilingFt": 4000
    },
    "tags": {
      "icaoId": "LKPR",
      "flightCategory": "VFR",
      "tafAvailable": "true"
    }
  }
}
```

Stylování:

| Flight category | COP styl |
| --- | --- |
| `VFR` | zelený nebo neutrální badge |
| `MVFR` | žlutý/advisory badge |
| `IFR` | oranžový/warning badge |
| `LIFR` | červený/critical badge |

Doporučené UI:

- mapa: malá ikona letiště nebo METAR stanice s badge `VFR/MVFR/IFR/LIFR`,
- tooltip: `icaoId`, vítr, teplota, tlak,
- detail panel: raw METAR/TAF pouze v technickém/detail režimu,
- nezobrazovat jako pohybující se objekt.

## ARDOS Partner zobrazení

`ardos_partner` je neveřejný zdroj. COP ho smí zobrazit pouze v interním/autorizovaném režimu.

Vrstvy:

| Layer | Příklad kategorií | Zobrazení |
| --- | --- | --- |
| `mobile` | `field_team`, `emcomm_relay`, `mobile_gateway`, `drone_operator` | Pohyblivý partnerský bod, ale ne jako veřejný osobní tracking. |
| `traffic` | `uas_operation`, `drone_observation`, `patrol_route` | Kontext operace/trasy/pozorování. |
| `ground` | `command_post`, `temporary_repeater`, `field_report` | Pevné body a hlášení. |

COP musí respektovat:

- `properties.validUntil`: po expiraci ztlumit nebo skrýt,
- `properties.stale`: zobrazit degraded/stale stav,
- `properties.confidence`: nízkou důvěru vizuálně ztlumit,
- `properties.severity`: použít stejnou barevnou prioritu jako u ostatních situation features.

Ve veřejném režimu nezobrazovat:

- osobní jména, volací znaky jednotlivců, telefonní čísla,
- registrační značky soukromých vozidel,
- interní stream URL, neveřejné frekvence, taktické poznámky,
- přesné citlivé polohy, pokud nejsou schválené pro danou roli uživatele.

Pokud COP dostane `ardos_partner` features bez oprávnění uživatele, má je zahodit ještě před renderem.

## Health a degraded stav

COP má pro dependency stav používat:

```http
GET https://sim.zeleznalady.cz/situation-data/health/ready
GET https://sim.zeleznalady.cz/situation-data/api/v1/sources
GET https://sim.zeleznalady.cz/flight-data/api/v1/sources
```

Degraded stav nastane, když:

- odpověď `warnings[]` není prázdná,
- `summary.staleFeatureCount > 0`,
- `ardos_partner` není nakonfigurovaný, ale COP ho očekává,
- `quality.stale=true` u flight tracků,
- zdroj není v `/sources` označen jako `enabled=true`.

Degraded stav nemá shodit celou mapu. COP má vykreslit dostupné zdroje a u problematické vrstvy ukázat stav zdroje.

## Cache pravidla pro COP

SIM už cacheuje upstream zdroje. COP proto:

- dotazuje podle aktuálního bbox, ne celou ČR,
- nevytváří polling rychlejší než UI potřebuje,
- pro `aviation_weather` stačí 60-120 s UI refresh,
- pro `ardos_partner` interně 5-15 s podle dohody,
- nevolá source endpoint opakovaně pro každý komponent; sdílí odpověď v aplikačním store.

## Akceptační testy v COP

1. COP zobrazí letištní počasí:

```text
https://sim.zeleznalady.cz/situation-data/api/v1/cop/features?bbox=13.85,49.65,15.35,50.45&layers=weather&source=aviation_weather&limit=5
```

Očekávání: features `weather:aviation_weather:LKPR` nebo blízké stanice, badge flight category, žádný pohybový trail.

2. COP zobrazí flight source badge:

```text
https://sim.zeleznalady.cz/flight-data/api/v1/cop/tracks?bbox=11.8,48.5,19.2,51.2&limit=50
```

Očekávání: tracky mají `sources[].sourceId`; badge podle zdroje.

3. COP načte letiště:

```text
https://sim.zeleznalady.cz/flight-data/api/v1/airports?query=LKPR&limit=1
```

Očekávání: `dataSource=ourairports:airports.csv`.

4. COP nezobrazí ARDOS bez oprávnění:

```text
https://sim.zeleznalady.cz/situation-data/api/v1/cop/features?bbox=13.85,49.65,15.35,50.45&layers=ground,mobile,traffic&source=ardos_partner&limit=20
```

Očekávání: pokud zdroj není nakonfigurovaný, COP ukáže dependency degraded, ale mapa běží dál. Pokud nakonfigurovaný je, features se renderují jen interním uživatelům.
