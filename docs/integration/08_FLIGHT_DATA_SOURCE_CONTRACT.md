# COP kontrakt: Flight Data Source

## Účel

`flight-data-api` je samostatná služba poskytující COP aplikaci normalizované tracky veřejných nebo licencovaných letových zdrojů. COP nemá volat jednotlivé veřejné providery přímo. Volá pouze tento kontrakt a používá metadata `sources` pro atribuci, diagnostiku a audit.

Veřejná cesta přes SIM web:

```text
https://sim.zeleznalady.cz/flight-data/api/v1/cop/tracks
```

Pilotní veřejné nasazení je nakonfigurované na `adsb_lol`, takže endpoint bez query parametru `source` vrací reálné ADS-B/open data s licencí ODbL. Lokální nebo offline test může explicitně použít `source=mock`, pokud je mock zdroj v konfiguraci povolený.

Lokální interní cesta v Docker síti:

```text
http://flight-data-api:4010/api/v1/cop/tracks
```

## Základní endpointy

```http
GET /api/v1/cop/tracks
GET /api/v1/aircraft/positions
GET /api/v1/airports
GET /api/v1/airports/{ident}
GET /api/v1/aircraft-types
GET /api/v1/aircraft-types/{designator}
GET /api/v1/sources
GET /api/v1/config
GET /health/ready
```

## Query parametry pro tracky

| Parametr | Příklad | Popis |
| --- | --- | --- |
| `bbox` | `13.5,49.5,15.5,50.6` | `west,south,east,north` ve WGS84. |
| `source` | `mock` nebo `adsb_lol,opensky` | Požadované zdroje. Pokud není vyplněno, použije se serverová konfigurace. |
| `limit` | `500` | Maximum vrácených deduplikovaných tracků. Max 1000. |
| `includeStale` | `true` | Vrátí i stale tracky. Default `false`. |

## Odpověď pro COP

```json
{
  "contractVersion": "cop-flight-source-v1",
  "source": {
    "sourceId": "flight-data-api",
    "sourceType": "PUBLIC_FLIGHT_AGGREGATE",
    "generatedAt": "2026-05-20T10:00:00.000Z"
  },
  "summary": {
    "rawObservationCount": 4,
    "deduplicatedTrackCount": 3,
    "droppedWithoutPositionCount": 0,
    "staleTrackCount": 0
  },
  "tracks": [
    {
      "trackId": "flight:icao24:4d2216",
      "icao24": "4d2216",
      "callsign": "CSA42",
      "registration": "OK-TSR",
      "objectType": "AIRCRAFT",
      "domain": "AIR",
      "lat": 50.1174,
      "lon": 14.5121,
      "altitudeM": 2743,
      "speedMps": 138,
      "headingDeg": 268,
      "verticalRateMps": 2.1,
      "lastSeenAt": "2026-05-20T10:00:00.000Z",
      "originCountry": "Czech Republic",
      "aircraft": {
        "typeDesignator": "A320",
        "manufacturer": "Airbus",
        "model": "A320",
        "category": "LandPlane",
        "engineType": "Jet",
        "wakeTurbulenceCategory": "Medium"
      },
      "sources": [
        {
          "sourceId": "mock",
          "sourceRecordId": "mock:4d2216:adsb",
          "fetchedAt": "2026-05-20T10:00:00.000Z",
          "seenAt": "2026-05-20T10:00:00.000Z"
        }
      ],
      "deduplication": {
        "key": "icao24",
        "mergedRecordCount": 2,
        "primarySourceId": "mock"
      },
      "quality": {
        "confidence": 0.84,
        "stale": false,
        "positionAgeSeconds": 0
      },
      "metadata": {
        "squawk": "2741",
        "sourceLicenses": ["Synthetic internal test data"]
      }
    }
  ],
  "sources": [
    {
      "sourceId": "mock",
      "label": "Synthetic local flight feed",
      "enabled": true,
      "mode": "mock",
      "priority": 10,
      "license": {
        "name": "Synthetic internal test data",
        "attribution": "DELTA ACR SIM",
        "commercialUse": "allowed",
        "operationalUse": "allowed",
        "notes": ["Synthetic data only. No external aviation data is used by this source."]
      }
    }
  ],
  "warnings": []
}
```

## Deduplikace

Služba normalizuje `icao24` na lowercase hex a slučuje všechny observace se stejným klíčem:

- primární záznam vybírá podle priority zdroje a času `seenAt`,
- `mergedRecordCount` říká, kolik zdrojových observací bylo sloučeno,
- `sources` zachovává auditní stopu všech sloučených zdrojů,
- COP používá `trackId` jako stabilní identifikátor.

## Doporučení pro COP

- Tracky z této služby ukládat jako samostatný typ zdroje, ne jako SIM syntetiku.
- V mapě zobrazit badge zdroje a licenci.
- Pracovat s `quality.stale`; stale tracky nezobrazovat jako aktuální bez varování.
- Pokud `warnings` není prázdné, zobrazit stav zdroje jako degradovaný.
- Pro historii poloh používat `trackId` a `lastSeenAt`.

## Dohled v SIM

SIM web čte pro dohled a nastavení tyto endpointy:

- `/flight-data/health/ready` pro stav služby a enabled source list,
- `/flight-data/api/v1/sources` pro zdroje, licence a produkční omezení,
- `/flight-data/api/v1/config` pro aktuální non-secret env konfiguraci,
- `/flight-data/api/v1/cop/tracks?limit=8` pro rychlý náhled dat, deduplikace a stale tracků.
