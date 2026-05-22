# Flight Data Source Compatibility Contract

**Status:** kompatibilní backend kontrakt pro aktuální COM/COP adapter. Nové veřejné integrace mají používat source-neutral provider model v [../provider/00_INDEX.md](../provider/00_INDEX.md).

## Účel

`flight-data-api` je samostatná služba poskytující COM aplikaci normalizované tracky veřejných nebo licencovaných letových zdrojů. COM nemá volat jednotlivé veřejné providery přímo. Volá pouze SIM provider API a používá metadata `sources` pro atribuci, diagnostiku a audit.

Veřejná cesta přes SIM web:

```text
https://sim.zeleznalady.cz/flight-data/api/v1/aircraft/positions
```

Pilotní veřejné nasazení je nakonfigurované na `adsb_lol`, takže endpoint bez query parametru `source` vrací reálné ADS-B/open data s licencí ODbL. Lokální nebo offline test může explicitně použít `source=mock`, pokud je mock zdroj v konfiguraci povolený. Vlastní přijímače lze připojit přes `local_adsb`, který čte readsb/dump1090 `aircraft.json`.

Lokální interní cesta v Docker síti:

```text
http://flight-data-api:4010/api/v1/aircraft/positions
```

## Základní endpointy

```http
GET /api/v1/catalog
GET /api/v1/aircraft/positions
GET /api/v1/cop/tracks
GET /api/v1/airports
GET /api/v1/airports/{ident}
GET /api/v1/airspaces
GET /api/v1/uas-geozones
GET /api/v1/airspace-activations
GET /api/v1/aircraft-types
GET /api/v1/aircraft-types/{designator}
GET /api/v1/sources
GET /api/v1/config
GET /health/ready
```

`GET /api/v1/catalog` vrací provider map catalog s hlavními vrstvami:

- `flight.public.tracks` z provider layer `flight.tracks`,
- `flight.reference.airports` z provider layer `flight.airports`,
- `flight.reference.airspaces` z provider layer `flight.airspaces`,
- `flight.reference.uas_geozones` z provider layer `flight.uas_geozones`,
- `flight.airspace.activation` z provider layer `flight.airspace_activation`.

COM má pro strom vrstev používat katalog. `sources` jsou pouze upstreamy a licenční/provenance metadata.

## Query parametry pro tracky

| Parametr | Příklad | Popis |
| --- | --- | --- |
| `bbox` | `13.5,49.5,15.5,50.6` | `west,south,east,north` ve WGS84. |
| `source` | `mock`, `adsb_lol`, `local_adsb`, `opensky` | Požadované zdroje. Pokud není vyplněno, použije se serverová konfigurace. |
| `limit` | `500` | Maximum vrácených deduplikovaných tracků. Max 1000. |
| `includeStale` | `true` | Vrátí i stale tracky. Default `false`. |

## Odpověď pro COM

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
      "position": {
        "lat": 50.1174,
        "lon": 14.5121
      },
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
        "wakeTurbulenceCategory": "Medium",
        "iconHint": "jet"
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
- COM používá `trackId` jako stabilní identifikátor.
- COM má pro zobrazený název preferovat `callsign`, potom `registration`, potom `icao24`. SIM nesmí při chybějícím callsignu posílat technický fallback typu `flight:icao24:*` do pole `callsign`.
- `position.lat/lon` je normalizovaná poloha pro nové integrace; kořenová pole `lat/lon` zůstávají kvůli zpětné kompatibilitě.
- `aircraft.iconHint` je volitelný prezentační hint pro civilní symboliku. Povolené hodnoty jsou `jet`, `turboprop`, `small_aircraft`, `helicopter`, `glider`, `uav`, `unknown`.

## Podporované zdroje

| Source | Stav | Poznámka |
| --- | --- | --- |
| `adsb_lol` | live open-data pilot | ODbL; vhodné pro veřejný pilot se správnou atribucí. |
| `local_adsb` | live vlastní/přátelská síť | Čte `aircraft.json` z readsb/dump1090 přes `LOCAL_ADSB_AIRCRAFT_JSON_URLS`; priorita je vyšší než veřejné agregátory. |
| `opensky` | licencované / omezené | Nezapínat pro komerční nebo operativní použití bez písemného oprávnění. |
| `mock` | syntetika | Pouze pro testy a fallback. |

## Referenční data

`GET /api/v1/airports` používá cacheovaný import OurAirports `airports.csv` pro státy v `OURAIRPORTS_COUNTRIES`. Výchozí sada je `CZ,SK,AT,DE,PL,HU`, aby COM dostal letiště v ČR a okolí bez ručního udržování seed seznamu. Při výpadku importu služba vrací seed fallback a `source.warnings`.

`GET /api/v1/airspaces` vrací GeoJSON `FeatureCollection` s referenčními leteckými prostory z AIP/eAIP ENR 5.1:

- provider layer `flight.airspaces`,
- katalogová vrstva `flight.reference.airspaces`,
- source `czech_aip_airspaces`,
- typy `prohibited`, `restricted`, `danger`, připraveno i pro `temporary_reserved`, `temporary_segregated`, `other`,
- každá feature má `properties.notForNavigation=true`.

Endpoint podporuje:

| Parametr | Příklad | Popis |
| --- | --- | --- |
| `bbox` | `14.2,49.9,14.6,50.2` | `west,south,east,north` ve WGS84. |
| `type` | `prohibited,restricted,danger` | Volitelný filtr typů prostorů. |
| `limit` | `500` | Maximum vrácených polygonů. Max 1000. |

Vrstva je určena pro situační přehled v COM, ne pro navigaci ani právně závazné letecké rozhodování. Pro produkční nebo komerční redistribuci je potřeba potvrdit oprávnění u AIS/ŘLP ČR nebo použít licencovaný AIXM/AIP feed. SIM výslovně nerepublikuje DroneMap UAS zóny, protože podmínky DroneMap omezují veřejné zobrazování a distribuci bez písemného souhlasu.

`GET /api/v1/uas-geozones` vrací GeoJSON `FeatureCollection` z oficiálních AIM/ŘLP datových sad UAS zeměpisných zón. Výchozí import je záměrně omezený na produkčně rozumné vrstvy:

```bash
UAS_GEOZONES_LAYER_IDS=LKR314A,LKR314B,LKR314C,LKR314D,LKR314E,LKR314F,LKR315A,LKR315B,LKR319,LKR320A
```

Velké vrstvy jako `LKR316`, silniční/železniční zóny nebo kompletní `geozones_geojson.zip` nemají být v produkci tahány jako live runtime odpověď pro tisíce uživatelů. Pro ně je správná cesta offline import do PostGIS a publikace přes tile/cache vrstvu.

`GET /api/v1/airspace-activations` vrací aktuální aktivace z AUP/UUP. SIM načte platný AUP a případný UUP z `https://aup.rlp.cz/`, vyparsuje sekci `C/ Prostory spravované AMC` a páruje TRA/TSA identifikátory na dostupnou geometrii z `LKR320A`. Endpoint podporuje `includeCancelled=true`, aby COM mohl zobrazit i zrušené položky z UUP diagnosticky.

Typy letadel zůstávají zatím seedované v SIM. Úplnější aircraft type store musí přijít z licencovaného nebo právně ověřeného zdroje.

## Konfigurace lokální ADS-B sítě

```bash
FLIGHT_DATA_ENABLED_SOURCES=local_adsb,adsb_lol
LOCAL_ADSB_AIRCRAFT_JSON_URLS=http://receiver-1.home.cz/tar1090/data/aircraft.json,http://receiver-2.home.cz/readsb/data/aircraft.json
FLIGHT_DATA_CACHE_TTL_SECONDS=5
FLIGHT_DATA_STALE_IF_ERROR_SECONDS=60
AIP_AIRSPACES_ENABLED=true
AIP_AIRSPACES_SOURCE_URL=https://aim.rlp.cz/eaip/html/eAIP/LK-ENR-5.1-en-GB.html
AIP_AIRSPACES_CACHE_TTL_SECONDS=86400
UAS_GEOZONES_ENABLED=true
UAS_GEOZONES_CATALOG_URL=https://aim.rlp.cz/?lang=cz&p=uas-gz
UAS_GEOZONES_LAYER_IDS=LKR314A,LKR314B,LKR314C,LKR314D,LKR314E,LKR314F,LKR315A,LKR315B,LKR319,LKR320A
UAS_GEOZONES_CACHE_TTL_SECONDS=86400
AIRSPACE_ACTIVATION_ENABLED=true
AIRSPACE_ACTIVATION_BASE_URL=https://aup.rlp.cz/
AIRSPACE_ACTIVATION_CACHE_TTL_SECONDS=300
```

Používej jen přijímače provozované projektem nebo partnery, kteří výslovně povolí redistribuci do COM. Nepřeposílej komerční ani komunitní feedy, jejichž podmínky to neumožňují.

## Doporučení pro COM

- Tracky z této služby ukládat jako samostatný typ zdroje, ne jako SIM syntetiku.
- V mapě zobrazit badge zdroje a licenci.
- Pracovat s `quality.stale`; stale tracky nezobrazovat jako aktuální bez varování.
- Pokud `warnings` není prázdné, zobrazit stav zdroje jako degradovaný.
- Pro historii poloh používat `trackId` a `lastSeenAt`.
- Pro krátkou historii/predikci polohy dál používat COM buffer. SIM poskytuje aktuální agregovaný stav a zdrojová metadata.

## Dohled v SIM

SIM web čte pro dohled a nastavení tyto endpointy:

- `/flight-data/health/ready` pro stav služby a enabled source list,
- `/flight-data/api/v1/sources` pro zdroje, licence a produkční omezení,
- `/flight-data/api/v1/config` pro aktuální non-secret env konfiguraci,
- `/flight-data/api/v1/aircraft/positions?limit=8` pro rychlý náhled dat, deduplikace a stale tracků.
- `/flight-data/api/v1/airspaces?bbox=12,48,19,52&type=prohibited,restricted,danger` pro kontrolu referenční vrstvy leteckých prostorů.
- `/flight-data/api/v1/uas-geozones?bbox=12,48,19,52&limit=1000` pro kontrolu UAS zeměpisných zón.
- `/flight-data/api/v1/airspace-activations?bbox=12,48,19,52&includeCancelled=true` pro kontrolu AUP/UUP aktivací.
