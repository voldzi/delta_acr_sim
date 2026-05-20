# Situation Data Source Contract

Tento kontrakt popisuje situační open-data vrstvy, které SIM poskytuje COPu jako doplňkový kontext mapy. Kontrakt je oddělený od syntetických COP tracků i od veřejných letových tracků.

## Base URL

Lokální Docker pilot:

```text
http://docker.home.cz:5020/situation-data/api/v1
```

Publikovaný pilot:

```text
https://sim.zeleznalady.cz/situation-data/api/v1
```

## Endpoints

```http
GET /layers
GET /sources
GET /config
GET /features?bbox=west,south,east,north&layers=weather,ground,mobile,traffic&limit=250
GET /cop/features?bbox=west,south,east,north&layers=weather,ground,mobile,traffic&limit=250
```

## COP projection

`GET /cop/features` vrací GeoJSON `FeatureCollection`:

```json
{
  "contractVersion": "cop-situation-source-v1",
  "type": "FeatureCollection",
  "generatedAt": "2026-05-20T10:15:00.000Z",
  "source": {
    "sourceId": "situation-data-api",
    "sourceType": "PUBLIC_SITUATION_AGGREGATE",
    "generatedAt": "2026-05-20T10:15:00.000Z"
  },
  "query": {
    "bbox": { "west": 13.85, "south": 49.65, "east": 15.35, "north": 50.45 },
    "layers": ["weather", "ground", "mobile", "traffic"],
    "limit": 250,
    "sources": ["open_meteo", "ctu_nettest", "pid_gtfs_rt"]
  },
  "summary": {
    "featureCount": 250,
    "sourceCount": 3,
    "staleFeatureCount": 0,
    "warningCount": 0
  },
  "features": [],
  "sources": [],
  "warnings": []
}
```

## Feature properties

Každá feature musí mít tyto normalizované vlastnosti:

| Pole | Typ | Popis |
| --- | --- | --- |
| `featureId` | string | stabilní identifikátor v rámci zdroje |
| `layer` | `weather`, `ground`, `mobile`, `traffic` | mapová vrstva |
| `category` | string | detailnější typ objektu |
| `label` | string | lidsky čitelný název |
| `sourceId` | string | poskytovatel v SIM registry |
| `observedAt` | ISO datetime | čas pozorování nebo publikace |
| `validUntil` | ISO datetime, optional | konec platnosti, pokud zdroj poskytuje |
| `confidence` | number 0-1 | kvalita / důvěra agregátu |
| `stale` | boolean | zda je objekt starší než prahová hodnota |
| `severity` | `info`, `advisory`, `warning`, `critical` | priorita pro vizualizaci |
| `license` | object | licence a atribuce zdroje |
| `metrics` | object | číselné metriky vrstvy |
| `raw` | object, optional | omezený původní payload pro ladění |

## Podporované zdroje

| Source | Vrstvy | Popis |
| --- | --- | --- |
| `open_meteo` | `weather` | Obecné počasí u středu bbox, silně cacheované podle weather gridu. |
| `aviation_weather` | `weather` | NOAA AWC METAR/TAF pro letiště v bbox. SIM dotazuje AWC cacheovaně; COP AWC nevolá přímo. |
| `ctu_nettest` | `mobile` | ČTÚ NetTest otevřený export mobilních měření. |
| `pid_gtfs_rt` | `traffic` | PID/Golemio GTFS-RT vozidla pro dopravní kontext. |
| `safety_data` | `warnings`, `flood` | Projekce Safety Data API do situačního kontraktu. |
| `ardos_partner` | `ground`, `mobile`, `traffic` | Neveřejný partnerský ARDOS zdroj. Vyžaduje `ARDOS_PARTNER_BASE_URL` a `ARDOS_PARTNER_TOKEN`. |
| `osm_overpass` | `ground`, `mobile` | Jen omezený vývoj/pilot; veřejný Overpass nesmí být runtime backend pro tisíce uživatelů. |

## Aviation Weather

`aviation_weather` vrací každou METAR stanici jako `weather` feature:

- `category=aviation_weather_station`,
- `tags.icaoId`, `tags.flightCategory`, `tags.tafAvailable`,
- `metrics.temperatureC`, `metrics.windSpeedMps`, `metrics.altimeterHpa`, `metrics.ceilingFt`,
- `severity` podle letové kategorie: `VFR=info`, `MVFR=advisory`, `IFR=warning`, `LIFR=critical`.

NOAA AWC uvádí limit 100 requestů/min a doporučuje omezit rozsah/frekvenci dotazů. SIM proto používá source cache a bbox kanonizaci.

## ARDOS partner source

`ardos_partner` není open-data. Aktivuje se jen po partnerské dohodě a tokenu. SIM očekává, že ARDOS vystaví již filtrovaný COP projection endpoint:

```http
GET /api/v1/cop/features?bbox=west,south,east,north&layers=ground,traffic,mobile&limit=250
Authorization: Bearer <token>
```

SIM z partner payloadu přebírá geometrii, kategorii, čas, závažnost a metriky, ale `sourceId` normalizuje na `ardos_partner`. Ve veřejném COP zobrazení se nesmí publikovat osobní identifikátory dobrovolníků, přesné citlivé mise ani interní komunikační údaje.

## Chování při chybách

- Nevalidní `bbox` nebo `layers` vrací `400 VALIDATION_ERROR`.
- Výpadek jednoho zdroje se promítne do `warnings`; agregát má vrátit dostupné features z ostatních zdrojů.
- Pokud selžou všechny zdroje, endpoint stále může vrátit prázdnou kolekci s warnings.

## COP doporučení

- Dotazovat podle bbox aktuální mapy, ne plošně celou ČR.
- Default `limit=250`.
- Weather, mobile a traffic vrstvy zobrazovat jako kontext. `pid_gtfs_rt` obsahuje pohybující se vozidla veřejné dopravy, ale nejsou to COP tracky ani letecké cíle.
- `aviation_weather` zobrazovat jako letištní počasí, ne jako tracky.
- `ardos_partner` zobrazovat jen ve views, kde uživatel má oprávnění pro partnerská data.
- U každého objektu zobrazovat zdroj a licenci.
